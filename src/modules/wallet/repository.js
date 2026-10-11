import { getPool } from '../../db/index.js';

function db(runner) {
  return runner || getPool();
}

export async function transaction(runner, fn) {
  if (runner && typeof runner.connect === 'function') {
    const client = await runner.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return fn(db(runner));
}

export async function ensureWallet(resellerId, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO wallets (reseller_id, low_balance_threshold_minor)
     SELECT $1, COALESCE(r.low_balance_threshold_minor, 0)
     FROM resellers r WHERE r.id = $1
     ON CONFLICT (reseller_id) DO UPDATE SET reseller_id = EXCLUDED.reseller_id
     RETURNING *`,
    [resellerId],
  );
  return rows[0];
}

export async function listWalletResellerIds(runner) {
  const { rows } = await db(runner).query('SELECT reseller_id FROM wallets ORDER BY created_at');
  return rows.map((row) => row.reseller_id);
}

export async function getWalletByReseller(resellerId, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM wallets WHERE reseller_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [resellerId],
  );
  return rows[0] ?? null;
}

export async function getWalletById(walletId, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM wallets WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [walletId],
  );
  return rows[0] ?? null;
}

export async function sumLedger(walletId, runner) {
  const { rows } = await db(runner).query(
    `SELECT COALESCE(SUM(available_delta), 0)::bigint AS available,
            COALESCE(SUM(reserved_delta), 0)::bigint AS reserved
     FROM ledger_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return { available: Number(rows[0].available), reserved: Number(rows[0].reserved) };
}

export async function insertLedgerEntry(entry, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO ledger_entries
       (reseller_id, wallet_id, entry_type, currency, amount_minor, available_delta,
        reserved_delta, idempotency_key, reference, reason, actor_id, effective_at,
        reversal_of_id, correlation_id, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, now()),$13,$14,$15)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      entry.resellerId,
      entry.walletId,
      entry.entryType,
      entry.currency ?? 'COP',
      entry.amountMinor,
      entry.availableDelta ?? 0,
      entry.reservedDelta ?? 0,
      entry.idempotencyKey,
      entry.reference ?? null,
      entry.reason ?? null,
      entry.actorId ?? null,
      entry.effectiveAt ?? null,
      entry.reversalOfId ?? null,
      entry.correlationId ?? null,
      entry.evidence != null ? JSON.stringify(entry.evidence) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function findLedgerByIdempotencyKey(idempotencyKey, runner) {
  const { rows } = await db(runner).query(
    'SELECT * FROM ledger_entries WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function findLedgerEntryById(id, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM ledger_entries WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function findReversalOf(entryId, runner) {
  const { rows } = await db(runner).query(
    'SELECT * FROM ledger_entries WHERE reversal_of_id = $1',
    [entryId],
  );
  return rows[0] ?? null;
}

export async function applyWalletDeltas(walletId, { availableDelta = 0, reservedDelta = 0 }, runner) {
  const { rows } = await db(runner).query(
    `UPDATE wallets
     SET available_minor = available_minor + $2,
         reserved_minor = reserved_minor + $3,
         version = version + 1
     WHERE id = $1
     RETURNING *`,
    [walletId, availableDelta, reservedDelta],
  );
  return rows[0] ?? null;
}

export async function setWalletIntegrityBlocked(walletId, blocked, runner) {
  const { rows } = await db(runner).query(
    'UPDATE wallets SET integrity_blocked = $2 WHERE id = $1 RETURNING *',
    [walletId, blocked],
  );
  return rows[0] ?? null;
}

export async function insertHold(hold, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO holds
       (reseller_id, wallet_id, order_id, currency, amount_minor, reserve_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (reserve_key) DO NOTHING
     RETURNING *`,
    [
      hold.resellerId,
      hold.walletId,
      hold.orderId ?? null,
      hold.currency ?? 'COP',
      hold.amountMinor,
      hold.reserveKey,
      hold.expiresAt ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function findHoldByReserveKey(reserveKey, runner) {
  const { rows } = await db(runner).query('SELECT * FROM holds WHERE reserve_key = $1', [reserveKey]);
  return rows[0] ?? null;
}

export async function findHoldById(holdId, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM holds WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [holdId],
  );
  return rows[0] ?? null;
}

export async function listHolds({ resellerId = null, orderId = null, status = null, limit = 100 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM holds
     WHERE ($1::uuid IS NULL OR reseller_id = $1)
       AND ($2::uuid IS NULL OR order_id = $2)
       AND ($3::text IS NULL OR status = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [resellerId, orderId, status, limit],
  );
  return rows;
}

export async function updateHoldSettlement(
  holdId,
  { capturedMinor, releasedMinor, status, capturedAt, releasedAt, captureKey, releaseKey },
  runner,
) {
  const { rows } = await db(runner).query(
    `UPDATE holds
     SET captured_minor = $2,
         released_minor = $3,
         status = $4,
         captured_at = COALESCE($5, captured_at),
         released_at = COALESCE($6, released_at),
         capture_key = COALESCE($7, capture_key),
         release_key = COALESCE($8, release_key)
     WHERE id = $1
     RETURNING *`,
    [holdId, capturedMinor, releasedMinor, status, capturedAt ?? null, releasedAt ?? null, captureKey ?? null, releaseKey ?? null],
  );
  return rows[0] ?? null;
}

export async function listLedgerEntries(
  { resellerId = null, walletId = null, entryType = null, limit = 100, offset = 0 } = {},
  runner,
) {
  const { rows } = await db(runner).query(
    `SELECT * FROM ledger_entries
     WHERE ($1::uuid IS NULL OR reseller_id = $1)
       AND ($2::uuid IS NULL OR wallet_id = $2)
       AND ($3::text IS NULL OR entry_type = $3)
     ORDER BY created_at DESC
     LIMIT $4 OFFSET $5`,
    [resellerId, walletId, entryType, limit, offset],
  );
  return rows;
}

export async function insertReconciliationCase(caseData, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO reconciliation_cases
       (case_type, severity, reseller_id, wallet_id, summary, local_evidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (case_type, wallet_id) WHERE status <> 'resolved' AND wallet_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      caseData.caseType,
      caseData.severity ?? 'high',
      caseData.resellerId ?? null,
      caseData.walletId ?? null,
      caseData.summary,
      caseData.localEvidence != null ? JSON.stringify(caseData.localEvidence) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function findOpenWalletCase(walletId, caseType, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM reconciliation_cases
     WHERE wallet_id = $1 AND case_type = $2 AND status <> 'resolved'
     ORDER BY created_at DESC LIMIT 1`,
    [walletId, caseType],
  );
  return rows[0] ?? null;
}

export async function listReconciliationCases({ walletId = null, status = null, limit = 100 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM reconciliation_cases
     WHERE ($1::uuid IS NULL OR wallet_id = $1)
       AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC LIMIT $3`,
    [walletId, status, limit],
  );
  return rows;
}
