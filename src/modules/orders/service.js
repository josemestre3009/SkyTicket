import crypto from 'node:crypto';
import { AuthError, ConflictError, ForbiddenError } from '../../auth/errors.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import * as repo from './repository.js';
import { createCatalogService } from '../catalog/service.js';
import { createResellerService } from '../resellers/service.js';

export class ValidationError extends AuthError {
  constructor(message, code = 'validation_error') {
    super(message, { statusCode: 400, code });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AuthError {
  constructor(message, code = 'not_found') {
    super(message, { statusCode: 404, code });
    this.name = 'NotFoundError';
  }
}

export const ORDER_STATES = Object.freeze({
  DRAFT: 'draft',
  RESERVED: 'reserved',
  ISSUING: 'issuing',
  ISSUED: 'issued',
  PARTIALLY_ISSUED: 'partially_issued',
  NEEDS_RECONCILIATION: 'needs_reconciliation',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

/** Explicit order state machine. `issued`, `failed` and `canceled` are terminal. */
export const ORDER_TRANSITIONS = Object.freeze({
  draft: ['reserved', 'canceled'],
  reserved: ['issuing', 'canceled', 'failed', 'needs_reconciliation'],
  issuing: ['issued', 'partially_issued', 'needs_reconciliation', 'failed'],
  issued: [],
  partially_issued: ['needs_reconciliation'],
  needs_reconciliation: ['issued', 'partially_issued', 'failed', 'canceled'],
  failed: [],
  canceled: [],
});

export function assertOrderTransition(from, to) {
  if (from === to) {
    throw new ConflictError(`order already in state ${to}`, 'invalid_transition');
  }
  const allowed = ORDER_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ConflictError(`invalid order transition ${from} -> ${to}`, 'invalid_transition');
  }
}

export function requestFingerprint({ siteId, packageId, quantity, clientReference = null }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ siteId, packageId, quantity, clientReference: clientReference ?? null }))
    .digest('hex');
}

export function createOrderService(options = {}) {
  const runner = options.runner;
  const now = options.now ?? (() => Date.now());
  const auditFn = options.audit ?? recordAudit;
  const catalog = options.catalog ?? createCatalogService({ runner });
  const resellerService = options.resellerService ?? createResellerService({ runner });

  async function createOrder(params, opts = {}) {
    const {
      auth,
      siteId,
      packageId,
      quantity,
      localReference,
      clientReference = null,
      clientIdentifiers = {},
      correlationId = null,
    } = params;

    resellerService.assertNoIdentityOverride(auth, clientIdentifiers);
    const resellerId = resellerService.resolveTenant(auth, params.resellerId);
    if (!auth?.user) throw new ForbiddenError('Authentication required', 'unauthorized');

    if (!localReference || !String(localReference).trim()) {
      throw new ValidationError('localReference is required', 'local_reference_required');
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new ValidationError('quantity must be an integer between 1 and 100', 'quantity_out_of_range');
    }

    const fingerprint = requestFingerprint({ siteId, packageId, quantity, clientReference });
    const client = opts.runner ?? runner;

    return repo.transaction(client, async (tx) => {
      const site = await resellerService.authorizeSiteAccess(
        { auth, siteId, clientIdentifiers },
        { runner: tx },
      );

      await catalog.assertPackageAuthorized({ resellerId, siteId, packageId }, { runner: tx });
      const price = await catalog.resolvePrice(
        { packageId, resellerId, siteId, at: new Date(now()) },
        { runner: tx },
      );

      const order = await repo.insertOrder(
        {
          resellerId,
          siteId,
          packageId,
          createdBy: auth.user.id,
          clientReference,
          quantity,
          currency: price.currency,
          unitPriceMinor: price.amountMinor,
          totalMinor: price.amountMinor * quantity,
          priceRuleId: price.priceRuleId,
          status: ORDER_STATES.DRAFT,
          localReference,
          requestFingerprint: fingerprint,
          correlationId,
        },
        tx,
      );

      if (order) {
        // A brand-new order is the entry to emission, so only an `active`
        // reseller may create it. A compatible replay above never reaches here.
        await resellerService.assertCanEmit(resellerId, { runner: tx });
        return {
          order,
          replayed: false,
          snapshot: { unitPriceMinor: price.amountMinor, quantity, currency: price.currency, totalMinor: price.amountMinor * quantity },
          site: site.site,
        };
      }

      const existing = await repo.findOrderByLocalReference(resellerId, localReference, {}, tx);
      if (!existing) throw new ConflictError('Order reference conflict', 'reference_conflict');
      if (existing.request_fingerprint !== fingerprint) {
        throw new ConflictError('Reference reused with different data', 'reference_conflict');
      }
      return {
        order: existing,
        replayed: true,
        snapshot: {
          unitPriceMinor: Number(existing.unit_price_minor),
          quantity: existing.quantity,
          currency: existing.currency,
          totalMinor: Number(existing.total_minor),
        },
        site: site.site,
      };
    });
  }

  async function transition({ orderId, to, eventType = 'status_change', actorId = null, idempotencyKey = null, detail = null, fields = {} }, opts = {}) {
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const order = await repo.findOrderById(orderId, { forUpdate: true }, tx);
      if (!order) throw new NotFoundError('Order not found', 'order_not_found');

      if (idempotencyKey) {
        const existingEvent = await repo.findOrderEventByIdempotency(idempotencyKey, tx);
        if (existingEvent) {
          return { order, replayed: true, event: existingEvent };
        }
      }

      assertOrderTransition(order.status, to);
      const updated = await repo.updateOrderStatus(orderId, { to, fields }, tx);
      const event = await repo.insertOrderEvent(
        {
          orderId,
          fromStatus: order.status,
          toStatus: to,
          eventType,
          actorId,
          idempotencyKey,
          detail,
        },
        tx,
      );
      return { order: updated, replayed: false, event };
    });
  }

  async function getOrder(orderId, opts = {}) {
    const order = await repo.findOrderById(orderId, {}, opts.runner ?? runner);
    if (!order) throw new NotFoundError('Order not found', 'order_not_found');
    return order;
  }

  /**
   * Tenant guard for reading an order. A reseller may only see its own orders;
   * any cross-tenant attempt is audited before the denial is raised.
   */
  async function assertOrderAccess(
    { auth, order, ip = null, sessionId = null, correlationId = null } = {},
    opts = {},
  ) {
    if (!auth?.user) throw new ForbiddenError('Authentication required', 'unauthorized');
    if (auth.user.role === 'admin') return order;
    if (auth.user.role === 'reseller' && order.reseller_id === auth.user.reseller_id) return order;
    await auditFn(
      {
        actorUserId: auth.user.id,
        actorRole: auth.user.role,
        resellerId: order.reseller_id,
        action: AUDIT_ACTIONS.AUTH_CROSS_TENANT_DENIED,
        entityType: 'voucher_order',
        entityId: order.id,
        reason: 'order_not_authorized',
        ip,
        sessionId,
        correlationId,
        result: 'denied',
      },
      opts.runner ?? runner,
    );
    throw new ForbiddenError('Order not authorized for this tenant', 'cross_tenant');
  }

  function listOrders(params = {}, opts = {}) {
    return repo.listOrders(params, opts.runner ?? runner);
  }

  function listOrderEvents(orderId, opts = {}) {
    return repo.listOrderEvents(orderId, opts.runner ?? runner);
  }

  return { createOrder, transition, getOrder, assertOrderAccess, listOrders, listOrderEvents };
}
