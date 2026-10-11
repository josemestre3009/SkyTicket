import crypto from 'node:crypto';
import { AuthError, ForbiddenError } from '../../auth/errors.js';
import { Cipher } from '../../lib/crypto.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import { maskCode } from '../../lib/redact.js';
import { RUIJIE_KIND } from '../../ruijie/errors.js';
import { normalizeStatus } from '../../ruijie/normalize.js';
import { assertRateLimit as defaultRateLimit } from '../../auth/rate-limit.js';
import { NOTIFICATION_TYPES } from '../notifications/matrix.js';
import { createOrderService } from '../orders/service.js';
import { createWalletService } from '../wallet/service.js';
import { createResellerService } from '../resellers/service.js';
import { createRuijieAdapter } from './adapter.js';
import * as repo from './repository.js';

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

export class UnavailableError extends AuthError {
  constructor(message = 'Ruijie emission unavailable', code = 'ruijie_unavailable') {
    super(message, { statusCode: 503, code });
    this.name = 'UnavailableError';
  }
}

export const ISSUE_OUTCOME = Object.freeze({
  ISSUED: 'issued',
  NEEDS_RECONCILIATION: 'needs_reconciliation',
  FAILED: 'failed',
  IN_PROGRESS: 'in_progress',
  REPLAYED: 'replayed',
});

const TERMINAL_ORDER_STATES = Object.freeze([
  'issuing',
  'issued',
  'partially_issued',
  'needs_reconciliation',
  'failed',
  'canceled',
]);

/** Ruijie codes that mean "creation may or may not have happened". */
const UNCERTAIN_CODES = new Set([3, 4, 7, 25]);

export function isTerminalOrderState(status) {
  return TERMINAL_ORDER_STATES.includes(status);
}

/**
 * Map a create failure to a safe outcome. Anything that cannot be confirmed as
 * "no emission happened" must go to reconciliation; the code is never retried.
 */
export function classifyCreateError(err) {
  if (!err) return { outcome: 'needs_reconciliation', reason: 'unknown_error' };
  if (err.code === 'ruijie_live_disabled') {
    return { outcome: 'failed', reason: 'emission_disabled' };
  }
  const code = Number(err.code);
  if (Number.isFinite(code) && UNCERTAIN_CODES.has(code)) {
    return { outcome: 'needs_reconciliation', reason: `ruijie_code_${code}` };
  }
  if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
    return { outcome: 'needs_reconciliation', reason: 'timeout' };
  }
  if (err.needsReconciliation === true) {
    return { outcome: 'needs_reconciliation', reason: 'ruijie_ambiguous' };
  }
  if (err.kind === RUIJIE_KIND.CIRCUIT_OPEN) return { outcome: 'failed', reason: 'circuit_open' };
  if (err.kind === RUIJIE_KIND.NON_RECOVERABLE) return { outcome: 'failed', reason: 'ruijie_rejected' };
  if (err.kind === RUIJIE_KIND.NETWORK) return { outcome: 'needs_reconciliation', reason: 'network' };
  if (
    err.kind === RUIJIE_KIND.RECOVERABLE ||
    err.kind === RUIJIE_KIND.RATE_LIMITED ||
    err.kind === RUIJIE_KIND.AUTH
  ) {
    return { outcome: 'needs_reconciliation', reason: 'ruijie_ambiguous' };
  }
  return { outcome: 'needs_reconciliation', reason: 'unknown_error' };
}

export function toVoucherDto(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    ruijieUuid: row.ruijie_uuid,
    codeMasked: row.code_masked,
    alias: row.alias,
    status: row.normalized_status,
    rawStatus: row.raw_status,
    lastSyncedAt: row.last_synced_at ?? null,
    createdAt: row.created_at,
  };
}

const STORED_STATUSES = new Set(['issued', 'unused', 'in_use', 'expired', 'delivered', 'orphan', 'unknown']);

function normalizedStatusOf(voucher) {
  if (voucher.status && STORED_STATUSES.has(voucher.status) && voucher.status !== 'unknown') {
    return voucher.status;
  }
  const mapped = normalizeStatus(voucher.rawStatus ?? voucher.status);
  return mapped === 'unknown' ? 'issued' : mapped;
}

export function createIssuanceService(options = {}) {
  const runner = options.runner;
  const auditFn = options.audit ?? recordAudit;
  const rateLimitFn = options.rateLimit ?? defaultRateLimit;
  const notifications = options.notifications ?? null;
  const orders = options.orders ?? createOrderService({ runner });
  const wallet = options.wallet ?? createWalletService({ runner });
  const resellerService = options.resellerService ?? createResellerService({ runner });
  const adapter = options.adapter ?? createRuijieAdapter({ cipher: options.cipher });

  let cipher = options.cipher ?? null;
  function getCipher() {
    if (!cipher) cipher = Cipher.fromConfig();
    return cipher;
  }

  function buildVoucher(order, voucher) {
    if (!voucher || voucher.uuid == null) return null;
    const code = voucher.code == null ? null : String(voucher.code);
    if (!code) return null;
    const fingerprint = crypto.createHash('sha256').update(code).digest('hex');
    return {
      orderId: order.id,
      resellerId: order.reseller_id,
      siteId: order.site_id,
      uuid: String(voucher.uuid),
      codeEncrypted: getCipher().encrypt(code),
      codeMasked: maskCode(code),
      codeFingerprint: fingerprint,
      alias: voucher.alias ?? null,
      rawStatus: voucher.rawStatus ?? null,
      normalizedStatus: normalizedStatusOf(voucher),
      rawJson: voucher.raw ?? null,
    };
  }

  /**
   * Persist vouchers and return how many rows were actually stored. A duplicate
   * or already-owned `ruijie_uuid` is skipped by the unique index, so the count
   * is below the received list and the caller must not capture for it.
   */
  async function persistVouchers(order, list, tx) {
    let persisted = 0;
    for (const voucher of list) {
      const record = buildVoucher(order, voucher);
      if (!record) throw new Error('Ruijie returned a voucher without a usable uuid/code');
      const inserted = await repo.insertVoucher(record, tx);
      if (inserted) persisted += 1;
    }
    return persisted;
  }

  async function listMasked(orderId, client) {
    const rows = await repo.listVouchersByOrder(orderId, client);
    return rows.map(toVoucherDto);
  }

  async function auditIssue(order, { result, reason, issuedQuantity }, client) {
    await auditFn(
      {
        actorRole: null,
        resellerId: order.reseller_id,
        action: AUDIT_ACTIONS.ORDER_ISSUE,
        entityType: 'voucher_order',
        entityId: order.id,
        after: { outcome: result, issuedQuantity },
        reason: reason ?? null,
        correlationId: order.correlation_id ?? null,
        result,
      },
      client,
    );
  }

  async function markReconciliation(order, { reason, raw = null, list = null }, client) {
    await repo.transaction(client, async (rawTx) => {
      const tx = repo.reuseClient(rawTx);
      if (list && list.length) {
        try {
          await persistVouchers(order, list, tx);
        } catch {
          // Evidence is best-effort here; the reservation stays intact.
        }
      }
      await orders.transition(
        {
          orderId: order.id,
          to: 'needs_reconciliation',
          eventType: 'needs_reconciliation',
          idempotencyKey: `order:${order.id}:reconciliation`,
          fields: { failureReason: reason, ruijieRawResponse: raw },
          detail: { reason, received: list ? list.length : 0 },
        },
        { runner: tx },
      );
      await repo.patchOrderReconciliation(order.id, reason, tx);
      if (notifications?.emit) {
        await notifications.emit(
          {
            type: NOTIFICATION_TYPES.ISSUE_UNCERTAIN,
            resourceType: 'voucher_order',
            resourceId: order.id,
            resellerId: order.reseller_id,
            title: 'Estamos verificando el resultado',
            body: 'No vuelvas a intentarlo.',
          },
          { runner: tx },
        );
      }
    });
    await auditIssue(order, { result: 'failure', reason, issuedQuantity: null }, client);
    return {
      order: await orders.getOrder(order.id, { runner: client }),
      replayed: false,
      outcome: ISSUE_OUTCOME.NEEDS_RECONCILIATION,
      reason,
      vouchers: await listMasked(order.id, client),
    };
  }

  async function markFailed(order, { reason, raw = null }, client) {
    const result = await repo.transaction(client, async (rawTx) => {
      const tx = repo.reuseClient(rawTx);
      if (order.hold_id) {
        await wallet.release(
          {
            holdId: order.hold_id,
            releaseKey: `order:${order.id}:release`,
            reason,
            correlationId: order.correlation_id ?? null,
          },
          { runner: tx },
        );
      }
      return orders.transition(
        {
          orderId: order.id,
          to: 'failed',
          eventType: 'failed',
          idempotencyKey: `order:${order.id}:failed`,
          fields: { failureReason: reason, ruijieRawResponse: raw },
          detail: { reason },
        },
        { runner: tx },
      );
    });
    await auditIssue(order, { result: 'failure', reason, issuedQuantity: null }, client);
    return {
      order: result.order,
      replayed: false,
      outcome: ISSUE_OUTCOME.FAILED,
      reason,
      vouchers: await listMasked(order.id, client),
    };
  }

  /**
   * Full issuance flow: create order, reserve, persist intent, call Ruijie once,
   * store vouchers, capture. Any ambiguity preserves the hold and never retries.
   */
  async function issue(params, opts = {}) {
    const {
      auth,
      siteId,
      packageId,
      quantity,
      localReference,
      clientReference = null,
      clientIdentifiers = {},
      correlationId = null,
      ip = null,
    } = params;
    const client = opts.runner ?? runner;

    if (!auth?.user) throw new ForbiddenError('Authentication required', 'unauthorized');
    // Persisted fixed-window limit so emission abuse is throttled across restarts.
    await rateLimitFn('issue', `user:${auth.user.id}`, client);

    const created = await orders.createOrder({
      auth,
      siteId,
      packageId,
      quantity,
      localReference,
      clientReference,
      clientIdentifiers,
      correlationId,
    });
    let order = created.order;

    if (created.replayed && isTerminalOrderState(order.status)) {
      return {
        order,
        replayed: true,
        outcome: ISSUE_OUTCOME.REPLAYED,
        vouchers: await listMasked(order.id, client),
      };
    }

    const context = await resellerService.authorizeSiteAccess(
      { auth, siteId, clientIdentifiers, adapter: adapter?.resolveConnection ? adapter : null, ip },
      { runner: client },
    );

    if (adapter?.isCircuitOpen) {
      const open = await adapter.isCircuitOpen({ connection: context.connection, site: context.site });
      if (open) throw new UnavailableError('Ruijie circuit open; emission unavailable', 'ruijie_unavailable');
    }

    const reserved = await wallet.reserve(
      {
        resellerId: order.reseller_id,
        amountMinor: Number(order.total_minor),
        reserveKey: `order:${order.id}`,
        orderId: order.id,
        expiresAt: opts.holdExpiresAt ?? null,
        correlationId,
      },
      { runner: client },
    );
    const hold = reserved.hold;

    if (order.status === 'draft') {
      const transition = await orders.transition(
        {
          orderId: order.id,
          to: 'reserved',
          eventType: 'reserved',
          idempotencyKey: `order:${order.id}:reserved`,
          fields: { holdId: hold.id },
          detail: { holdId: hold.id },
        },
        { runner: client },
      );
      order = transition.order;
    } else {
      order = await orders.getOrder(order.id, { runner: client });
    }

    const dispatch = await orders.transition(
      {
        orderId: order.id,
        to: 'issuing',
        eventType: 'issuing',
        idempotencyKey: `order:${order.id}:issuing`,
        detail: { reserveKey: `order:${order.id}` },
      },
      { runner: client },
    );
    if (dispatch.replayed) {
      return {
        order: dispatch.order,
        replayed: true,
        outcome: ISSUE_OUTCOME.IN_PROGRESS,
        vouchers: await listMasked(order.id, client),
      };
    }
    order = dispatch.order;
    await repo.patchOrderDispatched(order.id, null, client);

    let result;
    try {
      result = await adapter.createVouchers({
        connection: context.connection,
        site: context.site,
        order,
        quantity: order.quantity,
      });
    } catch (err) {
      const classified = classifyCreateError(err);
      if (classified.outcome === 'failed') return markFailed(order, { reason: classified.reason }, client);
      return markReconciliation(order, { reason: classified.reason }, client);
    }

    const list = Array.isArray(result?.list) ? result.list : [];
    const raw = result?.raw ?? null;
    const requested = order.quantity;

    if (requested > 0 && list.length === requested) {
      try {
        const issued = await repo.transaction(client, async (rawTx) => {
          const tx = repo.reuseClient(rawTx);
          const persisted = await persistVouchers(order, list, tx);
          // Capture only when every requested voucher was newly persisted;
          // duplicates or foreign UUIDs must be reconciled, not charged.
          if (persisted !== requested) {
            const mismatch = new Error('persisted voucher count does not match requested quantity');
            mismatch.code = 'voucher_persistence_mismatch';
            throw mismatch;
          }
          const transition = await orders.transition(
            {
              orderId: order.id,
              to: 'issued',
              eventType: 'issued',
              idempotencyKey: `order:${order.id}:issued`,
              fields: { issuedQuantity: list.length, ruijieRawResponse: raw },
              detail: { issuedQuantity: list.length },
            },
            { runner: tx },
          );
          await wallet.capture(
            {
              holdId: hold.id,
              captureKey: `order:${order.id}:capture`,
              actor: auth.user,
              correlationId,
            },
            { runner: tx },
          );
          if (notifications?.emit) {
            await notifications.emit(
              {
                type: NOTIFICATION_TYPES.ISSUE_COMPLETED,
                resourceType: 'voucher_order',
                resourceId: order.id,
                resellerId: order.reseller_id,
                title: 'Emision completada',
                body: `Se emitieron ${list.length} bonos para la orden ${order.id}.`,
              },
              { runner: tx },
            );
          }
          return transition.order;
        });
        await auditIssue(order, { result: 'success', issuedQuantity: list.length }, client);
        return {
          order: issued,
          replayed: false,
          outcome: ISSUE_OUTCOME.ISSUED,
          vouchers: await listMasked(order.id, client),
        };
      } catch (err) {
        const reason =
          err?.code === 'voucher_persistence_mismatch'
            ? 'voucher_persistence_mismatch'
            : 'persistence_failure_after_create';
        return markReconciliation(order, { reason, raw, list }, client);
      }
    }

    return markReconciliation(order, { reason: 'partial_response', raw, list }, client);
  }

  async function assertOrderAccess(auth, order, explicitResellerId, client) {
    if (!auth?.user) throw new ForbiddenError('Authentication required', 'unauthorized');
    if (auth.user.role === 'admin') return;
    if (auth.user.role === 'reseller' && !explicitResellerId && order.reseller_id === auth.user.reseller_id) return;
    await auditFn(
      {
        actorUserId: auth.user.id,
        actorRole: auth.user.role,
        resellerId: order.reseller_id,
        action: AUDIT_ACTIONS.AUTH_CROSS_TENANT_DENIED,
        entityType: 'voucher_order',
        entityId: order.id,
        reason: 'order_not_authorized',
        result: 'denied',
      },
      client,
    );
    throw new ForbiddenError('Order not authorized for this tenant', 'cross_tenant');
  }

  function assertVoucherAccess(auth, voucher, explicitResellerId, client) {
    if (auth?.user?.role === 'admin') return Promise.resolve();
    if (auth?.user?.role === 'reseller' && !explicitResellerId && voucher.reseller_id === auth.user.reseller_id) {
      return Promise.resolve();
    }
    return auditFn(
      {
        actorUserId: auth?.user?.id ?? null,
        actorRole: auth?.user?.role ?? null,
        resellerId: voucher.reseller_id,
        action: AUDIT_ACTIONS.AUTH_CROSS_TENANT_DENIED,
        entityType: 'voucher',
        entityId: voucher.id,
        reason: 'voucher_not_authorized',
        result: 'denied',
      },
      client,
    ).then(() => {
      throw new ForbiddenError('Voucher not authorized for this tenant', 'cross_tenant');
    });
  }

  async function listOrderVouchers({ orderId, auth, resellerId = null }, opts = {}) {
    const client = opts.runner ?? runner;
    const order = await orders.getOrder(orderId, { runner: client });
    await assertOrderAccess(auth, order, resellerId, client);
    return listMasked(order.id, client);
  }

  /** Route-compatible listing (snake_case rows) used by the web panel. */
  async function listByOrder({ orderId, auth, resellerId = null }, opts = {}) {
    const client = opts.runner ?? runner;
    const order = await orders.getOrder(orderId, { runner: client });
    await assertOrderAccess(auth, order, resellerId, client);
    return repo.listVouchersByOrder(order.id, client);
  }

  async function revealVoucher(
    { voucherId, auth, orderId = null, channel = 'view', ip = null, sessionId = null, reason = null, resellerId = null },
    opts = {},
  ) {
    const client = opts.runner ?? runner;
    if (!auth?.user) throw new ForbiddenError('Authentication required', 'unauthorized');
    await rateLimitFn('reveal', `user:${auth.user.id}`, client);

    const voucher = await repo.findVoucherById(voucherId, {}, client);
    if (!voucher) throw new NotFoundError('Voucher not found', 'voucher_not_found');
    if (orderId && voucher.order_id !== orderId) {
      throw new ForbiddenError('Voucher does not belong to the order', 'cross_tenant');
    }
    await assertVoucherAccess(auth, voucher, resellerId, client);

    const code = getCipher().decrypt(voucher.code_encrypted);
    await auditFn(
      {
        actorUserId: auth.user.id,
        actorRole: auth.user.role,
        resellerId: voucher.reseller_id,
        action: AUDIT_ACTIONS.VOUCHER_REVEAL,
        entityType: 'voucher',
        entityId: voucher.id,
        after: { channel },
        reason,
        ip,
        sessionId,
        result: 'success',
      },
      client,
    );
    return { voucherId: voucher.id, orderId: voucher.order_id, code, alias: voucher.alias, channel };
  }

  function copyVoucher(params, opts = {}) {
    return revealVoucher({ ...params, channel: 'copy' }, opts);
  }

  return {
    issue,
    listOrderVouchers,
    listByOrder,
    revealVoucher,
    reveal: revealVoucher,
    copyVoucher,
    classifyCreateError,
  };
}
