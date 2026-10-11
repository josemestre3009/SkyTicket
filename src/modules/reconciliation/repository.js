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

export function reuseClient(client) {
  return { query: (text, params) => client.query(text, params) };
}

export async function insertCase(caseData, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO reconciliation_cases
       (case_type, severity, status, reseller_id, site_id, order_id, voucher_id, wallet_id,
        summary, local_evidence, ruijie_evidence)
     VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      caseData.caseType,
      caseData.severity ?? 'medium',
      caseData.resellerId ?? null,
      caseData.siteId ?? null,
      caseData.orderId ?? null,
      caseData.voucherId ?? null,
      caseData.walletId ?? null,
      caseData.summary,
      caseData.localEvidence != null ? JSON.stringify(caseData.localEvidence) : null,
      caseData.ruijieEvidence != null ? JSON.stringify(caseData.ruijieEvidence) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function findOpenCase({ caseType, orderId = null, voucherId = null, walletId = null }, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM reconciliation_cases
     WHERE case_type = $1 AND status <> 'resolved'
       AND ($2::uuid IS NULL OR order_id = $2)
       AND ($3::uuid IS NULL OR voucher_id = $3)
       AND ($4::uuid IS NULL OR wallet_id = $4)
     ORDER BY created_at DESC
     LIMIT 1`,
    [caseType, orderId, voucherId, walletId],
  );
  return rows[0] ?? null;
}

export async function findOpenExternalCase(ruijieUuid, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM reconciliation_cases
     WHERE case_type = 'voucher_ruijie_only' AND status <> 'resolved'
       AND voucher_id IS NULL AND ruijie_evidence ->> 'uuid' = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(ruijieUuid)],
  );
  return rows[0] ?? null;
}

export async function findCaseById(caseId, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM reconciliation_cases WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [caseId],
  );
  return rows[0] ?? null;
}

export async function markCaseResolved(caseId, { resolution, actorId, ruijieEvidence = null }, runner) {
  const { rows } = await db(runner).query(
    `UPDATE reconciliation_cases
     SET status = 'resolved',
         resolution = $2,
         resolved_by = $3,
         resolved_at = now(),
         ruijie_evidence = COALESCE($4::jsonb, ruijie_evidence)
     WHERE id = $1
     RETURNING *`,
    [caseId, resolution, actorId, ruijieEvidence != null ? JSON.stringify(ruijieEvidence) : null],
  );
  return rows[0] ?? null;
}

export async function listCases({ status = null, caseType = null, limit = 100 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM reconciliation_cases
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR case_type = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [status, caseType, limit],
  );
  return rows;
}

export async function listExpiredHolds(runner) {
  const { rows } = await db(runner).query(
    `SELECT h.*, o.status AS order_status
     FROM holds h
     JOIN voucher_orders o ON o.id = h.order_id
     WHERE h.status = 'active' AND h.expires_at IS NOT NULL AND h.expires_at < now()
     ORDER BY h.expires_at`,
  );
  return rows;
}

export async function listStuckOrders({ statuses = ['issuing'], olderThan }, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM voucher_orders
     WHERE status = ANY($1::text[]) AND updated_at < $2
     ORDER BY updated_at`,
    [statuses, olderThan],
  );
  return rows;
}
