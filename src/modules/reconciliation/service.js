import crypto from 'node:crypto';
import { AuthError, ConflictError, ForbiddenError } from '../../auth/errors.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import { syncPaginated } from '../../ruijie/sync.js';
import { createWalletService } from '../wallet/service.js';
import { createOrderService } from '../orders/service.js';
import * as issuanceRepo from '../issuance/repository.js';
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

export const DEFAULT_THRESHOLDS = Object.freeze({
  holdGraceMs: 15 * 60_000,
  stuckOrderMs: 30 * 60_000,
});

/** Case types a manual administrative resolution may close (never partial). */
export const RESOLVABLE_CASE_TYPES = Object.freeze([
  'order_stuck',
  'voucher_local_only',
  'voucher_ruijie_only',
  'voucher_mismatch',
  'wallet_projection_mismatch',
]);

function fingerprintOf(code) {
  if (code === null || code === undefined || code === '') return null;
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function createReconciliationService(options = {}) {
  const runner = options.runner;
  const now = options.now ?? (() => Date.now());
  const auditFn = options.audit ?? recordAudit;
  const wallet = options.wallet ?? createWalletService({ runner });
  const orders = options.orders ?? createOrderService({ runner });
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };

  async function ensureCase(data, client) {
    const inserted = await repo.insertCase(data, client);
    if (inserted) return inserted;
    if (data.voucherId) return repo.findOpenCase({ caseType: data.caseType, voucherId: data.voucherId }, client);
    if (data.orderId) return repo.findOpenCase({ caseType: data.caseType, orderId: data.orderId }, client);
    if (data.ruijieEvidence?.uuid) return repo.findOpenExternalCase(data.ruijieEvidence.uuid, client);
    return null;
  }

  /**
   * Detect expired reservations and stuck orders. Only confirmed "no emission"
   * releases balance; anything uncertain stays reserved and opens a case.
   */
  async function recover(opts = {}) {
    const client = opts.runner ?? runner;
    const nowMs = (opts.now ?? now)();
    const summary = { expiredHolds: 0, released: 0, reconciled: 0, stuckOrders: 0 };

    const expired = await repo.listExpiredHolds(client);
    for (const hold of expired) {
      summary.expiredHolds += 1;
      const order = await orders.getOrder(hold.order_id, { runner: client });
      const noEmission = !order.create_dispatched_at && ['draft', 'reserved', 'failed', 'canceled'].includes(order.status);
      if (noEmission) {
        await wallet.release(
          { holdId: hold.id, releaseKey: `recovery:hold:${hold.id}`, reason: 'hold_expired_no_emission' },
          { runner: client },
        );
        if (order.status !== 'failed' && order.status !== 'canceled') {
          await orders.transition(
            {
              orderId: order.id,
              to: 'failed',
              eventType: 'recovery_release',
              idempotencyKey: `order:${order.id}:recovery-failed`,
              fields: { failureReason: 'hold_expired_no_emission' },
              detail: { reason: 'hold_expired' },
            },
            { runner: client },
          );
        }
        summary.released += 1;
      } else {
        await ensureCase(
          {
            caseType: 'order_stuck',
            severity: 'high',
            resellerId: order.reseller_id,
            siteId: order.site_id,
            orderId: order.id,
            summary: 'Expired hold on an order that may have emitted',
          },
          client,
        );
        summary.reconciled += 1;
      }
    }

    const olderThan = new Date(nowMs - thresholds.stuckOrderMs);
    const stuck = await repo.listStuckOrders({ statuses: ['issuing'], olderThan }, client);
    for (const order of stuck) {
      summary.stuckOrders += 1;
      await orders.transition(
        {
          orderId: order.id,
          to: 'needs_reconciliation',
          eventType: 'needs_reconciliation',
          idempotencyKey: `order:${order.id}:reconciliation`,
          fields: { failureReason: 'stuck_issuing' },
          detail: { reason: 'stuck_issuing' },
        },
        { runner: client },
      );
      await issuanceRepo.patchOrderReconciliation(order.id, 'stuck_issuing', client);
      await ensureCase(
        {
          caseType: 'order_stuck',
          severity: 'high',
          resellerId: order.reseller_id,
          siteId: order.site_id,
          orderId: order.id,
          summary: 'Order stuck in issuing beyond threshold',
        },
        client,
      );
      summary.reconciled += 1;
    }

    return summary;
  }

  /**
   * Compare local vouchers for a site against Ruijie by UUID (and code
   * fingerprint). Missing/changed create local cases; unknown UUIDs are
   * classified as external and never attributed to a reseller.
   */
  async function reconcileVouchers({ siteId, fetchPage, pageSize = 200 }, opts = {}) {
    const client = opts.runner ?? runner;
    if (!siteId) throw new ValidationError('siteId is required', 'site_required');
    if (typeof fetchPage !== 'function') throw new ValidationError('fetchPage is required', 'fetch_page_required');

    const remote = new Map();
    const remoteByFingerprint = new Map();
    await syncPaginated({
      fetchPage,
      pageSize,
      persist: async (list) => {
        for (const voucher of list) {
          if (voucher?.uuid != null) remote.set(String(voucher.uuid), voucher);
          const fp = fingerprintOf(voucher?.code);
          if (fp) remoteByFingerprint.set(fp, voucher);
        }
      },
    });

    const local = await issuanceRepo.listVouchersBySite(siteId, client);
    const findings = { missing: [], external: [], changed: [] };

    for (const lv of local) {
      const rem = remote.get(lv.ruijie_uuid) ?? (lv.code_fingerprint ? remoteByFingerprint.get(lv.code_fingerprint) : null);
      if (!rem) {
        findings.missing.push(lv.ruijie_uuid);
        await ensureCase(
          {
            caseType: 'voucher_local_only',
            severity: 'medium',
            resellerId: lv.reseller_id,
            siteId: lv.site_id,
            voucherId: lv.id,
            summary: 'Local voucher not found in Ruijie within retention',
            localEvidence: { uuid: lv.ruijie_uuid, status: lv.normalized_status },
          },
          client,
        );
        continue;
      }
      const remoteStatus = rem.status;
      if (remoteStatus && remoteStatus !== 'unknown' && remoteStatus !== lv.normalized_status) {
        findings.changed.push(lv.ruijie_uuid);
        await ensureCase(
          {
            caseType: 'voucher_mismatch',
            severity: 'medium',
            resellerId: lv.reseller_id,
            siteId: lv.site_id,
            voucherId: lv.id,
            summary: 'Local voucher status differs from Ruijie',
            localEvidence: { uuid: lv.ruijie_uuid, status: lv.normalized_status },
            ruijieEvidence: { uuid: rem.uuid, status: remoteStatus, fingerprint: fingerprintOf(rem.code) },
          },
          client,
        );
      }
    }

    for (const [uuid, rem] of remote) {
      const knownLocal =
        local.some((lv) => lv.ruijie_uuid === uuid) ||
        (fingerprintOf(rem.code) && local.some((lv) => lv.code_fingerprint === fingerprintOf(rem.code)));
      if (knownLocal) continue;
      findings.external.push(uuid);
      await ensureCase(
        {
          caseType: 'voucher_ruijie_only',
          severity: 'low',
          resellerId: null,
          siteId,
          voucherId: null,
          summary: 'Ruijie voucher not created by SkyTicket',
          ruijieEvidence: { uuid: rem.uuid, status: rem.status, fingerprint: fingerprintOf(rem.code) },
        },
        client,
      );
    }

    return { ...findings, scanned: local.length, remote: remote.size };
  }

  function listCases(params = {}, opts = {}) {
    return repo.listCases(params, opts.runner ?? runner);
  }

  async function getCase(caseId, opts = {}) {
    const theCase = await repo.findCaseById(caseId, {}, opts.runner ?? runner);
    if (!theCase) throw new NotFoundError('Reconciliation case not found', 'case_not_found');
    return theCase;
  }

  async function resolveStuckOrder(theCase, { disposition, actor, reason }, tx) {
    if (disposition == null) return;
    const order = await orders.getOrder(theCase.order_id, { runner: tx });
    const hold = order.hold_id ? await wallet.getHold(order.hold_id, { runner: tx }) : null;

    if (disposition === 'confirmed_no_emission') {
      if (!['failed', 'canceled'].includes(order.status)) {
        if (hold && hold.remainingMinor > 0) {
          await wallet.release(
            { holdId: hold.id, releaseKey: `case:${theCase.id}:release`, reason, actor },
            { runner: tx },
          );
        }
        await orders.transition(
          {
            orderId: order.id,
            to: 'failed',
            eventType: 'resolution',
            idempotencyKey: `case:${theCase.id}:failed`,
            fields: { failureReason: reason },
            detail: { caseId: theCase.id, disposition },
          },
          { runner: tx },
        );
      }
      return;
    }

    if (disposition === 'confirmed_emitted') {
      if (order.status !== 'issued') {
        if (hold && hold.remainingMinor > 0) {
          await wallet.capture(
            { holdId: hold.id, captureKey: `case:${theCase.id}:capture`, actor },
            { runner: tx },
          );
        }
        await orders.transition(
          {
            orderId: order.id,
            to: 'issued',
            eventType: 'resolution',
            idempotencyKey: `case:${theCase.id}:issued`,
            detail: { caseId: theCase.id, disposition },
          },
          { runner: tx },
        );
      }
      return;
    }

    throw new ValidationError(
      "disposition must be 'confirmed_no_emission' or 'confirmed_emitted'",
      'invalid_disposition',
    );
  }

  /**
   * Audited, idempotent manual resolution. Only permitted case types; partial
   * issuance resolution stays disabled until sandbox semantics are validated.
   */
  async function resolveCase({ caseId, actor, reason, evidence = null, disposition = null }, opts = {}) {
    const client = opts.runner ?? runner;
    if (actor?.role !== 'admin') throw new ForbiddenError('Administrator role required', 'forbidden');
    if (!reason || !String(reason).trim()) throw new ValidationError('reason is required', 'reason_required');
    if (evidence == null) throw new ValidationError('evidence is required', 'evidence_required');

    return repo.transaction(client, async (rawTx) => {
      const tx = repo.reuseClient(rawTx);
      const theCase = await repo.findCaseById(caseId, { forUpdate: true }, tx);
      if (!theCase) throw new NotFoundError('Reconciliation case not found', 'case_not_found');
      if (theCase.status === 'resolved') return { case: theCase, replayed: true };
      if (theCase.case_type === 'partial_issue') {
        throw new ConflictError('Partial issuance resolution is not enabled', 'partial_resolution_disabled');
      }
      if (!RESOLVABLE_CASE_TYPES.includes(theCase.case_type)) {
        throw new ValidationError('Case type cannot be resolved manually', 'case_not_resolvable');
      }

      if (theCase.case_type === 'order_stuck' && theCase.order_id) {
        await resolveStuckOrder(theCase, { disposition, actor, reason }, tx);
      }

      const resolved = await repo.markCaseResolved(
        caseId,
        {
          resolution: disposition ? `${disposition}: ${reason}` : reason,
          actorId: actor.id,
          ruijieEvidence: evidence,
        },
        tx,
      );
      await auditFn(
        {
          actorUserId: actor.id,
          actorRole: actor.role,
          resellerId: theCase.reseller_id,
          action: AUDIT_ACTIONS.RECONCILIATION_RESOLVE,
          entityType: 'reconciliation_case',
          entityId: caseId,
          before: { status: theCase.status, caseType: theCase.case_type },
          after: { status: 'resolved', disposition },
          reason,
          result: 'success',
        },
        tx,
      );
      return { case: resolved, replayed: false };
    });
  }

  return { recover, reconcileVouchers, listCases, list: listCases, getCase, resolveCase, resolve, thresholds };

  /** Route-compatible alias: maps the panel's `resolution` text to a reason. */
  function resolve({ caseId, resolution, reason, evidence = null, disposition = null, actor }, opts = {}) {
    return resolveCase({ caseId, actor, reason: reason ?? resolution, evidence, disposition }, opts);
  }
}
