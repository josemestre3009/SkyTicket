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

/**
 * Wrap an already-checked-out client so nested service calls reuse the same
 * transaction instead of opening their own. The wrapper deliberately has no
 * `connect` method, so `repo.transaction` runs queries inline.
 */
export function reuseClient(client) {
  return { query: (text, params) => client.query(text, params) };
}

export async function patchOrderDispatched(orderId, dispatchedAt, runner) {
  const { rows } = await db(runner).query(
    `UPDATE voucher_orders
     SET create_dispatched_at = COALESCE(create_dispatched_at, COALESCE($2::timestamptz, now()))
     WHERE id = $1
     RETURNING *`,
    [orderId, dispatchedAt ?? null],
  );
  return rows[0] ?? null;
}

export async function patchOrderReconciliation(orderId, reason, runner) {
  const { rows } = await db(runner).query(
    `UPDATE voucher_orders
     SET reconciliation_reason = COALESCE($2, reconciliation_reason)
     WHERE id = $1
     RETURNING *`,
    [orderId, reason ?? null],
  );
  return rows[0] ?? null;
}

export async function insertVoucher(voucher, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO vouchers
       (order_id, reseller_id, site_id, ruijie_uuid, code_encrypted, code_masked,
        code_fingerprint, alias, raw_status, normalized_status, raw_json, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (ruijie_uuid) DO NOTHING
     RETURNING *`,
    [
      voucher.orderId,
      voucher.resellerId,
      voucher.siteId,
      voucher.uuid,
      voucher.codeEncrypted,
      voucher.codeMasked,
      voucher.codeFingerprint ?? null,
      voucher.alias ?? null,
      voucher.rawStatus ?? null,
      voucher.normalizedStatus ?? 'issued',
      voucher.rawJson != null ? JSON.stringify(voucher.rawJson) : null,
    ],
  );
  return rows[0] ?? null;
}

const MASKED_COLUMNS = `id, order_id, reseller_id, site_id, ruijie_uuid, code_masked,
  code_fingerprint, alias, raw_status, normalized_status, last_synced_at, created_at`;

export async function listVouchersByOrder(orderId, runner) {
  const { rows } = await db(runner).query(
    `SELECT ${MASKED_COLUMNS} FROM vouchers WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  return rows;
}

export async function findVoucherById(voucherId, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM vouchers WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [voucherId],
  );
  return rows[0] ?? null;
}

export async function findVoucherByUuid(uuid, runner) {
  const { rows } = await db(runner).query('SELECT * FROM vouchers WHERE ruijie_uuid = $1', [uuid]);
  return rows[0] ?? null;
}

export async function listVouchersBySite(siteId, runner) {
  const { rows } = await db(runner).query(
    `SELECT ${MASKED_COLUMNS} FROM vouchers WHERE site_id = $1 ORDER BY created_at, id`,
    [siteId],
  );
  return rows;
}
