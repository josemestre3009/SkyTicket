import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { collectMetrics } from '../../src/modules/reconciliation/metrics.js';
import { seedTenant, teardownTenant, createSimulatedAdapter, authFor } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('operational metrics aggregate without exposing codes', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const issuance = createIssuanceService({ runner: pool, adapter, cipher, rateLimit: async () => {} });

  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  const base = {
    auth: authFor(fx.user),
    siteId: fx.site.id,
    packageId: fx.pkg.id,
    quantity: 1,
  };

  await issuance.issue({ ...base, localReference: 'metrics-1' });
  await issuance.issue({ ...base, localReference: 'metrics-2' });
  adapter.setBehavior('rejected');
  await issuance.issue({ ...base, localReference: 'metrics-failed' });
  adapter.setBehavior('timeout');
  await issuance.issue({ ...base, localReference: 'metrics-uncertain' });

  await pool.query(
    "INSERT INTO audit_events (reseller_id, action, entity_type, result) VALUES ($1,'auth.cross_tenant.denied','site','denied')",
    [fx.reseller.id],
  );
  const openCase = await pool.query(
    "INSERT INTO reconciliation_cases (case_type, severity, status, reseller_id, summary) VALUES ('wallet_projection_mismatch','high','open',$1,'metrics') RETURNING *",
    [fx.reseller.id],
  );
  assert.ok(openCase.rows[0].id);

  const metrics = await collectMetrics(pool, { resellerId: fx.reseller.id });

  await t.test('emissions, success, revenue and sales are aggregated', () => {
    assert.equal(metrics.ordersIssued, 2);
    assert.equal(metrics.ordersFailed, 1);
    assert.equal(metrics.ordersUncertain, 1);
    assert.equal(metrics.emissionsTotal, 2);
    assert.equal(metrics.revenueMinor, 2000);
    assert.equal(metrics.salesCount, 2);
    assert.equal(metrics.successRate, 0.5);
    assert.ok(metrics.avgIssueLatencyMs >= 0);
  });

  await t.test('circulating balance, cross-tenant access and differences are reported', () => {
    assert.equal(metrics.circulatingBalanceMinor, 98000);
    assert.equal(metrics.crossTenantDenials, 1);
    assert.equal(metrics.reconciliation.openCases, 1);
    assert.equal(metrics.reconciliation.ledgerDifferences, 1);
  });

  await t.test('no voucher code or ciphertext leaks into the payload', async () => {
    const row = await pool.query('SELECT code_encrypted FROM vouchers WHERE reseller_id = $1 LIMIT 1', [fx.reseller.id]);
    const plain = cipher.decrypt(row.rows[0].code_encrypted);
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes(plain), false);
    assert.equal(serialized.includes('code_encrypted'), false);
    assert.equal(serialized.includes('v1.'), false);
  });
});
