import { getPool } from '../../db/index.js';

function db(runner) {
  return runner || getPool();
}

const num = (value) => Number(value ?? 0);

/**
 * Operational, commercial and risk metrics. Aggregates only: never returns
 * voucher codes, tokens or other secrets. `from`/`to` are optional ISO bounds;
 * `resellerId` optionally scopes the aggregation to a single tenant.
 */
export async function collectMetrics(runner, { from = null, to = null, resellerId = null } = {}) {
  const client = db(runner);
  const params = [from, to, resellerId];

  const orders = await client.query(
    `SELECT
       count(*) FILTER (WHERE status = 'issued') AS orders_issued,
       count(*) FILTER (WHERE status = 'failed') AS orders_failed,
       count(*) FILTER (WHERE status = 'needs_reconciliation') AS orders_uncertain,
       count(*) FILTER (WHERE status IN ('issued','failed','needs_reconciliation')) AS orders_terminal,
       COALESCE(sum(total_minor) FILTER (WHERE status = 'issued'), 0) AS revenue_minor,
       COALESCE(avg(EXTRACT(EPOCH FROM (issued_at - issuing_at)) * 1000)
         FILTER (WHERE status = 'issued' AND issuing_at IS NOT NULL AND issued_at IS NOT NULL), 0) AS avg_latency_ms
     FROM voucher_orders
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at < $2)
       AND ($3::uuid IS NULL OR reseller_id = $3)`,
    params,
  );

  const vouchers = await client.query(
    `SELECT count(*) AS emissions_total
     FROM vouchers
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at < $2)
       AND ($3::uuid IS NULL OR reseller_id = $3)`,
    params,
  );

  const wallets = await client.query(
    `SELECT COALESCE(sum(available_minor + reserved_minor), 0) AS circulating_minor
     FROM wallets
     WHERE ($1::uuid IS NULL OR reseller_id = $1)`,
    [resellerId],
  );

  const denials = await client.query(
    `SELECT count(*) AS cross_tenant_denials
     FROM audit_events
     WHERE action = 'auth.cross_tenant.denied' AND result = 'denied'
       AND ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at < $2)
       AND ($3::uuid IS NULL OR reseller_id = $3)`,
    params,
  );

  const cases = await client.query(
    `SELECT
       count(*) FILTER (WHERE status <> 'resolved') AS open_cases,
       count(*) FILTER (WHERE status <> 'resolved' AND case_type LIKE 'voucher_%') AS voucher_differences,
       count(*) FILTER (WHERE status <> 'resolved' AND case_type IN ('order_stuck','partial_issue')) AS order_differences,
       count(*) FILTER (WHERE status <> 'resolved' AND case_type = 'wallet_projection_mismatch') AS ledger_differences
     FROM reconciliation_cases
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at < $2)
       AND ($3::uuid IS NULL OR reseller_id = $3)`,
    params,
  );

  const o = orders.rows[0];
  const ordersIssued = num(o.orders_issued);
  const ordersTerminal = num(o.orders_terminal);
  const c = cases.rows[0];

  return {
    window: { from, to, resellerId },
    ordersIssued,
    ordersFailed: num(o.orders_failed),
    ordersUncertain: num(o.orders_uncertain),
    successRate: ordersTerminal === 0 ? 0 : Math.round((ordersIssued / ordersTerminal) * 10000) / 10000,
    emissionsTotal: num(vouchers.rows[0].emissions_total),
    avgIssueLatencyMs: Math.round(num(o.avg_latency_ms)),
    revenueMinor: num(o.revenue_minor),
    salesCount: ordersIssued,
    circulatingBalanceMinor: num(wallets.rows[0].circulating_minor),
    crossTenantDenials: num(denials.rows[0].cross_tenant_denials),
    reconciliation: {
      openCases: num(c.open_cases),
      voucherDifferences: num(c.voucher_differences),
      orderDifferences: num(c.order_differences),
      ledgerDifferences: num(c.ledger_differences),
    },
    generatedAt: new Date().toISOString(),
  };
}
