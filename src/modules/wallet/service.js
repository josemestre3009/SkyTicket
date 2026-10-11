import { AuthError, ConflictError } from '../../auth/errors.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import { NOTIFICATION_TYPES } from '../notifications/matrix.js';
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

export class IntegrityBlockedError extends AuthError {
  constructor(message = 'Wallet blocked pending reconciliation', code = 'integrity_blocked') {
    super(message, { statusCode: 409, code });
    this.name = 'IntegrityBlockedError';
  }
}

export const ENTRY_TYPES = Object.freeze({
  RECHARGE: 'recharge',
  ADJUSTMENT_CREDIT: 'adjustment_credit',
  ADJUSTMENT_DEBIT: 'adjustment_debit',
  RESERVE: 'reserve',
  CAPTURE: 'capture',
  RELEASE: 'release',
  REVERSAL: 'reversal',
});

export const HOLD_STATUS = Object.freeze({
  ACTIVE: 'active',
  CAPTURED: 'captured',
  RELEASED: 'released',
  EXPIRED: 'expired',
});

const REVERSIBLE_TYPES = new Set([
  ENTRY_TYPES.RECHARGE,
  ENTRY_TYPES.ADJUSTMENT_CREDIT,
  ENTRY_TYPES.ADJUSTMENT_DEBIT,
]);

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer (COP)`, 'invalid_amount');
  }
}

function assertIdempotencyKey(value) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('idempotencyKey is required', 'idempotency_key_required');
  }
}

export function toBalance(wallet) {
  const available = Number(wallet.available_minor);
  const reserved = Number(wallet.reserved_minor);
  return {
    walletId: wallet.id,
    resellerId: wallet.reseller_id,
    currency: wallet.currency,
    availableMinor: available,
    reservedMinor: reserved,
    totalMinor: available + reserved,
    blocked: Boolean(wallet.integrity_blocked),
    version: wallet.version,
  };
}

export function createWalletService(options = {}) {
  const runner = options.runner;
  const now = options.now ?? (() => new Date());
  const auditFn = options.audit ?? recordAudit;
  const notifications = options.notifications ?? null;
  const requireEvidenceFor = options.requireEvidenceFor ?? [ENTRY_TYPES.ADJUSTMENT_DEBIT];

  function assertOperable(wallet) {
    if (wallet.integrity_blocked) throw new IntegrityBlockedError();
  }

  function thresholdOf(wallet) {
    return Number(wallet.low_balance_threshold_minor ?? 0);
  }

  /**
   * Emit a low-balance alert exactly when available funds cross the configured
   * threshold downward. Committed in the caller's transaction; deduped per
   * 24h window by the notifications matrix.
   */
  async function notifyLowBalance({ before, after, resellerId }, tx) {
    if (!notifications?.emit) return;
    const threshold = thresholdOf(before);
    const prev = Number(before.available_minor);
    const next = Number(after.available_minor);
    if (!(prev > threshold && next <= threshold)) return;
    await notifications.emit(
      {
        type: NOTIFICATION_TYPES.LOW_BALANCE,
        resourceType: 'reseller',
        resourceId: resellerId,
        resellerId,
        title: 'Saldo bajo',
        body: `El saldo disponible (${next} COP) alcanzo el umbral configurado (${threshold} COP).`,
      },
      { runner: tx },
    );
  }

  /**
   * Settlement locks the wallet before the hold. Inserting the ledger row first
   * takes a KEY SHARE lock on the wallet (FK), and two concurrent settlements
   * holding that share while requesting the wallet's exclusive lock deadlock.
   * Reserving already locks the wallet first, so this keeps one wallet->hold
   * order everywhere.
   */
  async function lockHoldForSettlement(holdId, tx) {
    const preview = await repo.findHoldById(holdId, {}, tx);
    if (!preview) return null;
    await repo.getWalletById(preview.wallet_id, { forUpdate: true }, tx);
    return repo.findHoldById(holdId, { forUpdate: true }, tx);
  }

  async function auditMoney(action, entry, extra, actor, correlationId, tx) {
    await auditFn(
      {
        actorUserId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        resellerId: entry.reseller_id,
        action,
        entityType: 'ledger_entry',
        entityId: entry.id,
        after: extra,
        correlationId,
        result: 'success',
      },
      tx,
    );
  }

  async function ensureWallet(resellerId, opts = {}) {
    return repo.ensureWallet(resellerId, opts.runner ?? runner);
  }

  async function getBalance(resellerId, opts = {}) {
    const wallet = await repo.getWalletByReseller(resellerId, {}, opts.runner ?? runner);
    if (!wallet) throw new NotFoundError('Wallet not found', 'wallet_not_found');
    return toBalance(wallet);
  }

  function listMovements(params = {}, opts = {}) {
    return repo.listLedgerEntries(params, opts.runner ?? runner);
  }

  function listHolds(params = {}, opts = {}) {
    return repo.listHolds(params, opts.runner ?? runner);
  }

  async function recharge(params, opts = {}) {
    const { resellerId, amountMinor, reference = null, idempotencyKey, reason = null, effectiveAt = null, evidence = null, actor = null, correlationId = null } = params;
    assertPositiveInteger(amountMinor, 'amountMinor');
    assertIdempotencyKey(idempotencyKey);
    if (!reason || !String(reason).trim()) {
      throw new ValidationError('reason is required', 'reason_required');
    }

    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const wallet = await repo.getWalletByReseller(resellerId, { forUpdate: true }, tx);
      if (!wallet) throw new NotFoundError('Wallet not found', 'wallet_not_found');
      assertOperable(wallet);

      const inserted = await repo.insertLedgerEntry(
        {
          resellerId,
          walletId: wallet.id,
          entryType: ENTRY_TYPES.RECHARGE,
          amountMinor,
          availableDelta: amountMinor,
          reservedDelta: 0,
          idempotencyKey,
          reference,
          reason,
          effectiveAt,
          evidence,
          actorId: actor?.id ?? null,
          correlationId,
        },
        tx,
      );

      if (!inserted) {
        const existing = await repo.findLedgerByIdempotencyKey(idempotencyKey, tx);
        return { entry: existing, balance: toBalance(wallet), replayed: true };
      }

      const updated = await repo.applyWalletDeltas(wallet.id, { availableDelta: amountMinor }, tx);
      await auditMoney(
        AUDIT_ACTIONS.WALLET_RECHARGE,
        inserted,
        { amountMinor, reference, reason, effectiveAt },
        actor,
        correlationId,
        tx,
      );
      if (notifications?.emit) {
        await notifications.emit(
          {
            type: NOTIFICATION_TYPES.TOPUP,
            resourceType: 'reseller',
            resourceId: resellerId,
            resellerId,
            title: 'Recarga registrada',
            body: `Se acreditaron ${amountMinor} COP a tu saldo.`,
          },
          { runner: tx },
        );
      }
      await notifyLowBalance({ before: wallet, after: updated, resellerId }, tx);
      return { entry: inserted, balance: toBalance(updated), replayed: false };
    });
  }

  async function adjustment(params, opts = {}) {
    const { resellerId, direction, amountMinor, reference = null, idempotencyKey, reason, effectiveAt = null, evidence = null, actor = null, correlationId = null } = params;
    assertPositiveInteger(amountMinor, 'amountMinor');
    assertIdempotencyKey(idempotencyKey);
    if (!reason || !String(reason).trim()) {
      throw new ValidationError('reason is required', 'reason_required');
    }
    if (direction !== 'credit' && direction !== 'debit') {
      throw new ValidationError("direction must be 'credit' or 'debit'", 'invalid_direction');
    }

    const entryType = direction === 'credit' ? ENTRY_TYPES.ADJUSTMENT_CREDIT : ENTRY_TYPES.ADJUSTMENT_DEBIT;
    if (requireEvidenceFor.includes(entryType) && evidence == null) {
      throw new ValidationError('evidence is required for this adjustment type', 'evidence_required');
    }
    const availableDelta = direction === 'credit' ? amountMinor : -amountMinor;

    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const wallet = await repo.getWalletByReseller(resellerId, { forUpdate: true }, tx);
      if (!wallet) throw new NotFoundError('Wallet not found', 'wallet_not_found');
      assertOperable(wallet);
      if (Number(wallet.available_minor) + availableDelta < 0) {
        throw new ValidationError('insufficient available balance', 'insufficient_funds');
      }

      const inserted = await repo.insertLedgerEntry(
        {
          resellerId,
          walletId: wallet.id,
          entryType,
          amountMinor,
          availableDelta,
          reservedDelta: 0,
          idempotencyKey,
          reference,
          reason,
          effectiveAt,
          evidence,
          actorId: actor?.id ?? null,
          correlationId,
        },
        tx,
      );

      if (!inserted) {
        const existing = await repo.findLedgerByIdempotencyKey(idempotencyKey, tx);
        return { entry: existing, balance: toBalance(wallet), replayed: true };
      }

      const updated = await repo.applyWalletDeltas(wallet.id, { availableDelta }, tx);
      await auditMoney(
        AUDIT_ACTIONS.WALLET_ADJUSTMENT,
        inserted,
        { direction, amountMinor, reference, reason, evidence, effectiveAt },
        actor,
        correlationId,
        tx,
      );
      await notifyLowBalance({ before: wallet, after: updated, resellerId }, tx);
      return { entry: inserted, balance: toBalance(updated), replayed: false };
    });
  }

  async function reverse(params, opts = {}) {
    const { entryId, reason = null, idempotencyKey = null, reference = null, actor = null, correlationId = null } = params;
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const original = await repo.findLedgerEntryById(entryId, { forUpdate: true }, tx);
      if (!original) throw new NotFoundError('Ledger entry not found', 'entry_not_found');
      if (!REVERSIBLE_TYPES.has(original.entry_type)) {
        throw new ConflictError('This movement cannot be reversed', 'not_reversible');
      }

      const wallet = await repo.getWalletById(original.wallet_id, { forUpdate: true }, tx);
      assertOperable(wallet);

      const existing = await repo.findReversalOf(entryId, tx);
      if (existing) return { entry: existing, balance: toBalance(wallet), replayed: true };

      const availableDelta = -Number(original.available_delta);
      const reservedDelta = -Number(original.reserved_delta);
      if (Number(wallet.available_minor) + availableDelta < 0 || Number(wallet.reserved_minor) + reservedDelta < 0) {
        throw new ValidationError('reversal would make balance negative', 'reverse_would_go_negative');
      }

      const key = idempotencyKey || `reversal:${entryId}`;
      const inserted = await repo.insertLedgerEntry(
        {
          resellerId: original.reseller_id,
          walletId: original.wallet_id,
          entryType: ENTRY_TYPES.REVERSAL,
          amountMinor: Number(original.amount_minor),
          availableDelta,
          reservedDelta,
          idempotencyKey: key,
          reference: reference ?? original.reference,
          reason,
          reversalOfId: entryId,
          actorId: actor?.id ?? null,
          correlationId,
        },
        tx,
      );

      if (!inserted) {
        const raced = await repo.findLedgerByIdempotencyKey(key, tx);
        return { entry: raced, balance: toBalance(wallet), replayed: true };
      }

      const updated = await repo.applyWalletDeltas(wallet.id, { availableDelta, reservedDelta }, tx);
      await auditMoney(
        AUDIT_ACTIONS.WALLET_REVERSAL,
        inserted,
        { reversalOf: entryId, reason, reference },
        actor,
        correlationId,
        tx,
      );
      await notifyLowBalance({ before: wallet, after: updated, resellerId: original.reseller_id }, tx);
      return { entry: inserted, balance: toBalance(updated), replayed: false };
    });
  }

  async function reserve(params, opts = {}) {
    const { resellerId, amountMinor, reserveKey, orderId = null, expiresAt = null, reference = null, correlationId = null } = params;
    assertPositiveInteger(amountMinor, 'amountMinor');
    if (!reserveKey) throw new ValidationError('reserveKey is required', 'reserve_key_required');

    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const wallet = await repo.getWalletByReseller(resellerId, { forUpdate: true }, tx);
      if (!wallet) throw new NotFoundError('Wallet not found', 'wallet_not_found');
      assertOperable(wallet);

      const existing = await repo.findHoldByReserveKey(reserveKey, tx);
      if (existing) return { hold: existing, balance: toBalance(wallet), replayed: true };

      if (Number(wallet.available_minor) < amountMinor) {
        throw new ValidationError('insufficient available balance', 'insufficient_funds');
      }

      const hold = await repo.insertHold(
        { resellerId, walletId: wallet.id, orderId, amountMinor, reserveKey, expiresAt },
        tx,
      );
      if (!hold) {
        const raced = await repo.findHoldByReserveKey(reserveKey, tx);
        return { hold: raced, balance: toBalance(wallet), replayed: true };
      }

      await repo.insertLedgerEntry(
        {
          resellerId,
          walletId: wallet.id,
          entryType: ENTRY_TYPES.RESERVE,
          amountMinor,
          availableDelta: -amountMinor,
          reservedDelta: amountMinor,
          idempotencyKey: `hold:reserve:${reserveKey}`,
          reference: reference ?? reserveKey,
          correlationId,
        },
        tx,
      );

      const updated = await repo.applyWalletDeltas(
        wallet.id,
        { availableDelta: -amountMinor, reservedDelta: amountMinor },
        tx,
      );
      await notifyLowBalance({ before: wallet, after: updated, resellerId }, tx);
      return { hold, balance: toBalance(updated), replayed: false };
    });
  }

  async function capture(params, opts = {}) {
    const { holdId, captureKey = null, amountMinor = null, actor = null, correlationId = null } = params;
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const hold = await lockHoldForSettlement(holdId, tx);
      if (!hold) throw new NotFoundError('Hold not found', 'hold_not_found');

      const key = captureKey ? `hold:capture:${captureKey}` : null;
      if (key) {
        const existing = await repo.findLedgerByIdempotencyKey(key, tx);
        if (existing) {
          const wallet = await repo.getWalletById(hold.wallet_id, {}, tx);
          return { entry: existing, hold, balance: toBalance(wallet), replayed: true };
        }
      }

      if (hold.status === HOLD_STATUS.RELEASED || hold.status === HOLD_STATUS.EXPIRED) {
        throw new ConflictError('Hold is not capturable', 'hold_not_active');
      }

      const remaining = Number(hold.amount_minor) - Number(hold.captured_minor) - Number(hold.released_minor);
      const cap = amountMinor == null ? remaining : Math.min(amountMinor, remaining);
      if (cap <= 0) throw new ValidationError('Nothing left to capture', 'nothing_to_capture');
      assertPositiveInteger(cap, 'amountMinor');

      const finalKey = key ?? `hold:capture:${holdId}:${hold.captured_minor}`;
      const inserted = await repo.insertLedgerEntry(
        {
          resellerId: hold.reseller_id,
          walletId: hold.wallet_id,
          entryType: ENTRY_TYPES.CAPTURE,
          amountMinor: cap,
          availableDelta: 0,
          reservedDelta: -cap,
          idempotencyKey: finalKey,
          reference: hold.reserve_key,
          actorId: actor?.id ?? null,
          correlationId,
        },
        tx,
      );

      if (!inserted) {
        const existing = await repo.findLedgerByIdempotencyKey(finalKey, tx);
        const wallet = await repo.getWalletById(hold.wallet_id, {}, tx);
        return { entry: existing, hold, balance: toBalance(wallet), replayed: true };
      }

      const wallet = await repo.getWalletById(hold.wallet_id, { forUpdate: true }, tx);
      assertOperable(wallet);
      const updated = await repo.applyWalletDeltas(wallet.id, { reservedDelta: -cap }, tx);

      const capturedMinor = Number(hold.captured_minor) + cap;
      const releasedMinor = Number(hold.released_minor);
      const status = capturedMinor + releasedMinor >= Number(hold.amount_minor) ? HOLD_STATUS.CAPTURED : hold.status;
      const updatedHold = await repo.updateHoldSettlement(
        holdId,
        { capturedMinor, releasedMinor, status, capturedAt: now(), captureKey },
        tx,
      );
      return { hold: updatedHold, balance: toBalance(updated), replayed: false };
    });
  }

  async function release(params, opts = {}) {
    const { holdId, releaseKey = null, amountMinor = null, reason = null, actor = null, correlationId = null } = params;
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const hold = await lockHoldForSettlement(holdId, tx);
      if (!hold) throw new NotFoundError('Hold not found', 'hold_not_found');

      const key = releaseKey ? `hold:release:${releaseKey}` : null;
      if (key) {
        const existing = await repo.findLedgerByIdempotencyKey(key, tx);
        if (existing) {
          const wallet = await repo.getWalletById(hold.wallet_id, {}, tx);
          return { entry: existing, hold, balance: toBalance(wallet), replayed: true };
        }
      }

      if (hold.status === HOLD_STATUS.RELEASED || hold.status === HOLD_STATUS.EXPIRED) {
        throw new ConflictError('Hold already released', 'hold_already_released');
      }

      const remaining = Number(hold.amount_minor) - Number(hold.captured_minor) - Number(hold.released_minor);
      const rel = amountMinor == null ? remaining : Math.min(amountMinor, remaining);
      if (rel <= 0) throw new ValidationError('Nothing left to release', 'nothing_to_release');
      assertPositiveInteger(rel, 'amountMinor');

      const finalKey = key ?? `hold:release:${holdId}:${hold.released_minor}`;
      const inserted = await repo.insertLedgerEntry(
        {
          resellerId: hold.reseller_id,
          walletId: hold.wallet_id,
          entryType: ENTRY_TYPES.RELEASE,
          amountMinor: rel,
          availableDelta: rel,
          reservedDelta: -rel,
          idempotencyKey: finalKey,
          reference: hold.reserve_key,
          reason,
          actorId: actor?.id ?? null,
          correlationId,
        },
        tx,
      );

      if (!inserted) {
        const existing = await repo.findLedgerByIdempotencyKey(finalKey, tx);
        const wallet = await repo.getWalletById(hold.wallet_id, {}, tx);
        return { entry: existing, hold, balance: toBalance(wallet), replayed: true };
      }

      const wallet = await repo.getWalletById(hold.wallet_id, { forUpdate: true }, tx);
      const updated = await repo.applyWalletDeltas(wallet.id, { availableDelta: rel, reservedDelta: -rel }, tx);

      const releasedMinor = Number(hold.released_minor) + rel;
      const capturedMinor = Number(hold.captured_minor);
      const status =
        capturedMinor + releasedMinor >= Number(hold.amount_minor)
          ? capturedMinor > 0
            ? HOLD_STATUS.CAPTURED
            : HOLD_STATUS.RELEASED
          : hold.status;
      const updatedHold = await repo.updateHoldSettlement(
        holdId,
        { capturedMinor, releasedMinor, status, releasedAt: now(), releaseKey },
        tx,
      );
      await notifyLowBalance({ before: wallet, after: updated, resellerId: hold.reseller_id }, tx);
      return { hold: updatedHold, balance: toBalance(updated), replayed: false };
    });
  }

  async function getHold(holdId, opts = {}) {
    const hold = await repo.findHoldById(holdId, {}, opts.runner ?? runner);
    if (!hold) throw new NotFoundError('Hold not found', 'hold_not_found');
    return { ...hold, remainingMinor: Number(hold.amount_minor) - Number(hold.captured_minor) - Number(hold.released_minor) };
  }

  /**
   * Verify the wallet projection against the ledger sum. Never auto-corrects:
   * a mismatch blocks the wallet and opens a reconciliation case.
   */
  async function reconcile(params = {}, opts = {}) {
    const { walletId = null, resellerId = null, caseType = 'wallet_projection_mismatch' } = params;
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const wallet = walletId
        ? await repo.getWalletById(walletId, { forUpdate: true }, tx)
        : await repo.getWalletByReseller(resellerId, { forUpdate: true }, tx);
      if (!wallet) throw new NotFoundError('Wallet not found', 'wallet_not_found');

      const expected = await repo.sumLedger(wallet.id, tx);
      const actual = { available: Number(wallet.available_minor), reserved: Number(wallet.reserved_minor) };
      const consistent =
        expected.available === actual.available &&
        expected.reserved === actual.reserved &&
        actual.available >= 0 &&
        actual.reserved >= 0;

      if (consistent) return { consistent: true, expected, actual, case: null };

      await repo.setWalletIntegrityBlocked(wallet.id, true, tx);
      const inserted = await repo.insertReconciliationCase(
        {
          caseType,
          severity: 'critical',
          resellerId: wallet.reseller_id,
          walletId: wallet.id,
          summary: 'Wallet projection differs from ledger sum',
          localEvidence: { expected, actual },
        },
        tx,
      );
      const theCase = inserted ?? (await repo.findOpenWalletCase(wallet.id, caseType, tx));
      return { consistent: false, expected, actual, case: theCase };
    });
  }

  /** Maintenance sweep: verify every wallet projection against its ledger. */
  async function reconcileAll(opts = {}) {
    const resellerIds = await repo.listWalletResellerIds(opts.runner ?? runner);
    let mismatches = 0;
    for (const resellerId of resellerIds) {
      const result = await reconcile({ resellerId }, opts);
      if (!result.consistent) mismatches += 1;
    }
    return { checked: resellerIds.length, mismatches };
  }

  async function assertOperableByReseller(resellerId, opts = {}) {
    const wallet = await repo.getWalletByReseller(resellerId, {}, opts.runner ?? runner);
    if (!wallet) throw new NotFoundError('Wallet not found', 'wallet_not_found');
    assertOperable(wallet);
    return toBalance(wallet);
  }

  return {
    ensureWallet,
    getBalance,
    listMovements,
    listHolds,
    recharge,
    adjustment,
    reverse,
    reserve,
    capture,
    release,
    getHold,
    reconcile,
    reconcileAll,
    assertOperable: assertOperableByReseller,
  };
}
