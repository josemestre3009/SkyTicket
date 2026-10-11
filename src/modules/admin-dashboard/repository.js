import { getPool } from '../../db/index.js';

function db(runner) {
  return runner || getPool();
}

const num = (value) => Number(value ?? 0);

/**
 * Read-only aggregates for the admin financial dashboard. Every value is a
 * projection: no voucher codes, tokens, secrets or raw payloads are selected.
 * `from`/`to` are inclusive-lower / exclusive-upper ISO bounds applied to
 * issued_at with a created_at fallback for orders, and effective_at for ledger.
 */
export async function collectSummary({ from, to }, runner) {
  const client = db(runner);
  const params = [from, to];

  const [orders, recharges, wallets, resellers] = await Promise.all([
    client.query(
      `SELECT
         count(*) FILTER (WHERE status = 'issued') AS issued,
         count(*) FILTER (WHERE status = 'failed') AS failed,
         count(*) FILTER (WHERE status = 'needs_reconciliation') AS needs_reconciliation,
         count(*) FILTER (WHERE status = 'canceled') AS canceled,
         COALESCE(sum(total_minor) FILTER (WHERE status = 'issued'), 0) AS revenue_minor,
         COALESCE(sum(issued_quantity) FILTER (WHERE status IN ('issued','partially_issued')), 0) AS vouchers_issued
       FROM voucher_orders
       WHERE COALESCE(issued_at, created_at) >= $1
         AND COALESCE(issued_at, created_at) < $2`,
      params,
    ),
    client.query(
      `SELECT COALESCE(sum(amount_minor), 0) AS recharge_minor,
              count(*) AS recharge_count
       FROM ledger_entries
       WHERE entry_type = 'recharge'
         AND effective_at >= $1 AND effective_at < $2`,
      params,
    ),
    client.query(
      `SELECT COALESCE(sum(w.available_minor + w.reserved_minor), 0) AS circulating_balance_minor
       FROM wallets w
       JOIN resellers r ON r.id = w.reseller_id
       WHERE r.archived_at IS NULL`,
    ),
    client.query(
      `SELECT count(*) AS active_resellers
       FROM resellers
       WHERE status = 'active' AND archived_at IS NULL`,
    ),
  ]);

  const o = orders.rows[0];
  const issued = num(o.issued);
  const failed = num(o.failed);
  const needsReconciliation = num(o.needs_reconciliation);
  const canceled = num(o.canceled);
  const terminal = issued + failed + needsReconciliation + canceled;

  return {
    revenueMinor: num(o.revenue_minor),
    salesCount: issued,
    vouchersIssued: num(o.vouchers_issued),
    rechargeMinor: num(recharges.rows[0].recharge_minor),
    rechargeCount: num(recharges.rows[0].recharge_count),
    circulatingBalanceMinor: num(wallets.rows[0].circulating_balance_minor),
    activeResellers: num(resellers.rows[0].active_resellers),
    resolvedOrders: terminal,
    successRate: terminal === 0 ? 0 : Math.round((issued / terminal) * 10000) / 10000,
  };
}

/**
 * Per-reseller ranking within the window. Archived resellers are excluded so
 * the panel never counts a hidden tenant. Revenue is the reseller's spend
 * (issued orders), recharge is windowed, and lastRechargeAt is all-time.
 */
export async function listResellerRanking({ from, to }, runner) {
  const { rows } = await db(runner).query(
    `SELECT
       r.id,
       r.name,
       r.status,
       u.email AS primary_email,
       COALESCE(o.revenue_minor, 0) AS revenue_minor,
       COALESCE(o.sales_count, 0) AS sales_count,
       COALESCE(o.vouchers_issued, 0) AS vouchers_issued,
       COALESCE(w.available_minor + w.reserved_minor, 0) AS current_balance_minor,
       COALESCE(l.recharge_minor, 0) AS recharge_minor,
       l.last_recharge_at
     FROM resellers r
     LEFT JOIN LATERAL (
       SELECT email FROM users WHERE reseller_id = r.id ORDER BY created_at LIMIT 1
     ) u ON true
     LEFT JOIN wallets w ON w.reseller_id = r.id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(sum(vo.total_minor) FILTER (WHERE vo.status = 'issued'), 0) AS revenue_minor,
         count(*) FILTER (WHERE vo.status = 'issued') AS sales_count,
          COALESCE(sum(vo.issued_quantity) FILTER (WHERE vo.status IN ('issued','partially_issued')), 0) AS vouchers_issued
       FROM voucher_orders vo
       WHERE vo.reseller_id = r.id
         AND COALESCE(vo.issued_at, vo.created_at) >= $1
         AND COALESCE(vo.issued_at, vo.created_at) < $2
     ) o ON true
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(sum(le.amount_minor) FILTER (WHERE le.effective_at >= $1 AND le.effective_at < $2), 0) AS recharge_minor,
         max(le.effective_at) AS last_recharge_at
       FROM ledger_entries le
       WHERE le.reseller_id = r.id AND le.entry_type = 'recharge'
     ) l ON true
     WHERE r.archived_at IS NULL
     ORDER BY revenue_minor DESC, r.name ASC`,
    [from, to],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    primaryEmail: row.primary_email ?? null,
    revenueMinor: num(row.revenue_minor),
    salesCount: num(row.sales_count),
    vouchersIssued: num(row.vouchers_issued),
    currentBalanceMinor: num(row.current_balance_minor),
    rechargeMinor: num(row.recharge_minor),
    lastRechargeAt: row.last_recharge_at ?? null,
  }));
}
