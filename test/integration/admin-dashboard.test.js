import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createAdminDashboardService } from '../../src/modules/admin-dashboard/service.js';
import {
  createReseller,
  createConnection,
  createSite,
  assignSite,
  createPackage,
  createWallet,
  createUser,
  teardownReseller,
  teardownConnection,
} from './reseller-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);

async function insertOrder(pool, order) {
  const { rows } = await pool.query(
    `INSERT INTO voucher_orders
       (reseller_id, site_id, package_id, quantity, unit_price_minor, total_minor,
        status, issued_quantity, local_reference, issued_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      order.resellerId,
      order.siteId,
      order.packageId,
      order.quantity ?? 1,
      order.unitPriceMinor ?? order.totalMinor,
      order.totalMinor,
      order.status,
      order.issuedQuantity ?? 0,
      order.localReference,
      order.issuedAt ?? null,
      order.createdAt ?? new Date(),
    ],
  );
  return rows[0];
}

async function insertLedger(pool, entry) {
  const { rows } = await pool.query(
    `INSERT INTO ledger_entries
       (reseller_id, wallet_id, entry_type, amount_minor, available_delta, reserved_delta,
        idempotency_key, effective_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      entry.resellerId,
      entry.walletId,
      entry.entryType,
      entry.amountMinor,
      entry.availableDelta ?? entry.amountMinor,
      entry.reservedDelta ?? 0,
      entry.idempotencyKey,
      entry.effectiveAt,
    ],
  );
  return rows[0];
}

test('admin dashboard summary definitions over real Postgres', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createAdminDashboardService({ runner: pool });

  const connection = await createConnection(pool);
  const site = await createSite(pool, connection.id);
  const pkg = await createPackage(pool, site.id);

  const r1 = await createReseller(pool, { name: 'Reseller Uno', status: 'active' });
  const r2 = await createReseller(pool, { name: 'Reseller Dos', status: 'active' });
  const r3 = await createReseller(pool, { name: 'Reseller Archivado', status: 'closed' });
  await pool.query('UPDATE resellers SET archived_at = now() WHERE id = $1', [r3.id]);

  await assignSite(pool, r1.id, site.id);
  await assignSite(pool, r2.id, site.id);

  const u1 = await createUser(pool, { role: 'reseller', resellerId: r1.id, email: `u1-${r1.id.slice(0, 6)}@test.dev` });
  const u2 = await createUser(pool, { role: 'reseller', resellerId: r2.id, email: `u2-${r2.id.slice(0, 6)}@test.dev` });
  await createUser(pool, { role: 'reseller', resellerId: r3.id, email: `u3-${r3.id.slice(0, 6)}@test.dev` });

  const w1 = await createWallet(pool, r1.id, { availableMinor: 7000, reservedMinor: 0 });
  const w2 = await createWallet(pool, r2.id, { availableMinor: 5000, reservedMinor: 1000 });
  await createWallet(pool, r3.id, { availableMinor: 99999, reservedMinor: 0 });

  t.after(async () => {
    await teardownReseller(pool, r1.id);
    await teardownReseller(pool, r2.id);
    await teardownReseller(pool, r3.id);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await insertOrder(pool, {
    resellerId: r1.id, siteId: site.id, packageId: pkg.id,
    status: 'issued', totalMinor: 10000, issuedQuantity: 2,
    localReference: `r1-issued-${r1.id.slice(0, 6)}`, issuedAt: ago(1), createdAt: ago(2),
  });
  await insertOrder(pool, {
    resellerId: r1.id, siteId: site.id, packageId: pkg.id,
    status: 'failed', totalMinor: 5000, localReference: `r1-failed-${r1.id.slice(0, 6)}`, createdAt: ago(3),
  });
  await insertOrder(pool, {
    resellerId: r1.id, siteId: site.id, packageId: pkg.id,
    status: 'needs_reconciliation', totalMinor: 7000,
    localReference: `r1-rec-${r1.id.slice(0, 6)}`, createdAt: ago(4),
  });
  // Outside the 30-day window: must be ignored for revenue/sales/vouchers.
  await insertOrder(pool, {
    resellerId: r1.id, siteId: site.id, packageId: pkg.id,
    status: 'issued', totalMinor: 9999, issuedQuantity: 1,
    localReference: `r1-old-${r1.id.slice(0, 6)}`, issuedAt: ago(45), createdAt: ago(45),
  });
  await insertOrder(pool, {
    resellerId: r2.id, siteId: site.id, packageId: pkg.id,
    status: 'issued', totalMinor: 30000, issuedQuantity: 3,
    localReference: `r2-issued-${r2.id.slice(0, 6)}`, issuedAt: ago(1), createdAt: ago(1),
  });
  await insertOrder(pool, {
    resellerId: r2.id, siteId: site.id, packageId: pkg.id,
    status: 'failed', totalMinor: 1, localReference: `r2-failed-${r2.id.slice(0, 6)}`, createdAt: ago(2),
  });

  await insertLedger(pool, {
    resellerId: r1.id, walletId: w1.id, entryType: 'recharge', amountMinor: 20000,
    idempotencyKey: `dhb-r1-recharge-${r1.id.slice(0, 6)}`, effectiveAt: ago(5),
  });
  await insertLedger(pool, {
    resellerId: r2.id, walletId: w2.id, entryType: 'recharge', amountMinor: 30000,
    idempotencyKey: `dhb-r2-recharge-${r2.id.slice(0, 6)}`, effectiveAt: ago(6),
  });
  // Outside the window and a non-recharge movement: neither counts.
  await insertLedger(pool, {
    resellerId: r1.id, walletId: w1.id, entryType: 'recharge', amountMinor: 5000,
    idempotencyKey: `dhb-r1-old-${r1.id.slice(0, 6)}`, effectiveAt: ago(40),
  });
  await insertLedger(pool, {
    resellerId: r1.id, walletId: w1.id, entryType: 'adjustment_credit', amountMinor: 40000,
    idempotencyKey: `dhb-r1-adj-${r1.id.slice(0, 6)}`, effectiveAt: ago(3),
  });

  const summary = await service.getSummary();
  const ranking = summary.ranking;

  await t.test('window defaults to the last 30 days with an explicit label', () => {
    assert.equal(summary.period.label, 'Últimos 30 días');
    const span = new Date(summary.period.to) - new Date(summary.period.from);
    assert.equal(Math.round(span / DAY), 30);
  });

  await t.test('revenue, sales, vouchers and success rate follow the definitions', () => {
    assert.equal(summary.revenueMinor, 40000);
    assert.equal(summary.salesCount, 2);
    assert.equal(summary.vouchersIssued, 5);
    assert.equal(summary.resolvedOrders, 5);
    assert.equal(summary.successRate, 0.4);
  });

  await t.test('recharge aggregates use ledger recharge by effective_at', () => {
    assert.equal(summary.rechargeMinor, 50000);
    assert.equal(summary.rechargeCount, 2);
  });

  await t.test('circulating balance and active resellers exclude archived tenants', () => {
    assert.equal(summary.circulatingBalanceMinor, 13000);
    assert.equal(summary.activeResellers, 2);
  });

  await t.test('ranking is ordered by revenue and hides archived resellers', () => {
    assert.equal(ranking.length, 2);
    assert.deepEqual(ranking.map((r) => r.name), ['Reseller Dos', 'Reseller Uno']);
    const [first, second] = ranking;
    assert.equal(first.id, r2.id);
    assert.equal(first.status, 'active');
    assert.equal(first.primaryEmail, u2.email);
    assert.equal(first.revenueMinor, 30000);
    assert.equal(first.salesCount, 1);
    assert.equal(first.vouchersIssued, 3);
    assert.equal(first.currentBalanceMinor, 6000);
    assert.equal(first.rechargeMinor, 30000);
    assert.ok(first.lastRechargeAt);
    assert.equal(second.id, r1.id);
    assert.equal(second.primaryEmail, u1.email);
    assert.equal(second.revenueMinor, 10000);
    assert.equal(second.currentBalanceMinor, 7000);
    assert.equal(second.rechargeMinor, 20000);
  });

  await t.test('no secret or ciphertext leaks into the payload', () => {
    const serialized = JSON.stringify(summary);
    for (const needle of ['password', 'code_encrypted', 'app_secret', 'token']) {
      assert.equal(serialized.includes(needle), false, `unexpected ${needle}`);
    }
  });
});
