import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createOrderService } from '../../src/modules/orders/service.js';
import { createWalletService } from '../../src/modules/wallet/service.js';
import { seedTenant, teardownTenant, createSimulatedAdapter, authFor } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('issuance flow: reserve, persist intent, single create, store and capture', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const svc = createIssuanceService({ runner: pool, adapter, cipher, rateLimit: async () => {} });

  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });
  const wallet = createWalletService({ runner: pool });
  const orders = createOrderService({ runner: pool });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  const balance = () => wallet.getBalance(fx.reseller.id);

  await t.test('successful emission stores encrypted vouchers, captures once and records raw', async () => {
    adapter.setBehavior('success');
    const callsBefore = adapter.calls.length;
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 3,
      localReference: 'ord-ok',
    });
    assert.equal(out.outcome, 'issued');
    assert.equal(out.order.status, 'issued');
    assert.equal(Number(out.order.issued_quantity), 3);
    assert.equal(adapter.calls.length, callsBefore + 1, 'create called exactly once');
    assert.equal(out.vouchers.length, 3);
    assert.ok(out.vouchers.every((v) => v.codeMasked && !('code' in v)));

    const bal = await balance();
    assert.equal(bal.availableMinor, 97000);
    assert.equal(bal.reservedMinor, 0);

    const stored = await pool.query('SELECT code_encrypted, code_masked, raw_json FROM vouchers WHERE order_id = $1', [out.order.id]);
    assert.equal(stored.rowCount, 3);
    for (const row of stored.rows) {
      assert.ok(row.code_encrypted.startsWith('v1.'));
      const plain = cipher.decrypt(row.code_encrypted);
      assert.ok(row.code_masked.includes('*'));
      assert.notEqual(row.code_masked, plain);
    }
    const raw = await pool.query('SELECT ruijie_raw_response FROM voucher_orders WHERE id = $1', [out.order.id]);
    assert.ok(raw.rows[0].ruijie_raw_response);
  });

  await t.test('compatible replay does not create again', async () => {
    const callsBefore = adapter.calls.length;
    const first = await orders.listOrders({ resellerId: fx.reseller.id, status: 'issued' });
    const replay = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 3,
      localReference: 'ord-ok',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.order.id, first[0].id);
    assert.equal(adapter.calls.length, callsBefore, 'no new create on replay');
  });

  await t.test('confirmed rejection releases the hold and fails the order', async () => {
    adapter.setBehavior('rejected');
    const before = await balance();
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 2,
      localReference: 'ord-rejected',
    });
    assert.equal(out.outcome, 'failed');
    assert.equal(out.order.status, 'failed');
    const after = await balance();
    assert.equal(after.availableMinor, before.availableMinor, 'released back to available');
    assert.equal(after.reservedMinor, before.reservedMinor, 'no residual reservation');
  });

  await t.test('timeout keeps the reservation and never retries create', async () => {
    adapter.setBehavior('timeout');
    const before = await balance();
    const callsBefore = adapter.calls.length;
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 2,
      localReference: 'ord-timeout',
    });
    assert.equal(out.outcome, 'needs_reconciliation');
    assert.equal(out.order.status, 'needs_reconciliation');
    assert.equal(adapter.calls.length, callsBefore + 1, 'no create retry');
    const after = await balance();
    assert.equal(after.reservedMinor, before.reservedMinor + 2000, 'reservation intact');
    assert.equal(after.availableMinor, before.availableMinor - 2000);
  });

  await t.test('Ruijie code 25 is uncertain and keeps the reservation', async () => {
    adapter.setBehavior('code25');
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 1,
      localReference: 'ord-code25',
    });
    assert.equal(out.outcome, 'needs_reconciliation');
    assert.equal(out.reason, 'ruijie_code_25');
  });

  await t.test('partial response preserves received vouchers without capture', async () => {
    adapter.setBehavior('partial');
    const before = await balance();
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 3,
      localReference: 'ord-partial',
    });
    assert.equal(out.outcome, 'needs_reconciliation');
    const after = await balance();
    assert.equal(after.reservedMinor, before.reservedMinor + 3000, 'reservation intact');
    const stored = await pool.query('SELECT count(*)::int AS c FROM vouchers WHERE order_id = $1', [out.order.id]);
    assert.equal(stored.rows[0].c, 2, 'received vouchers persisted as evidence');
  });

  await t.test('local persistence failure after create blocks for reconciliation', async () => {
    adapter.setBehavior('success');
    const throwingWallet = {
      ...wallet,
      capture: async () => {
        throw new Error('simulated capture failure');
      },
    };
    const failing = createIssuanceService({
      runner: pool,
      adapter,
      cipher,
      wallet: throwingWallet,
      rateLimit: async () => {},
    });
    const before = await balance();
    const out = await failing.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 2,
      localReference: 'ord-persist-fail',
    });
    assert.equal(out.outcome, 'needs_reconciliation');
    assert.equal(out.reason, 'persistence_failure_after_create');
    const after = await balance();
    assert.equal(after.reservedMinor, before.reservedMinor + 2000, 'hold intact; capture rolled back');
    assert.equal(after.availableMinor, before.availableMinor - 2000);
  });
});

test('issuance rejects before reserving when balance is insufficient', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const svc = createIssuanceService({ runner: pool, adapter, cipher, rateLimit: async () => {} });

  const fx = await seedTenant(pool, { availableMinor: 0, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  await assert.rejects(
    () => svc.issue({ auth: authFor(fx.user), siteId: fx.site.id, packageId: fx.pkg.id, quantity: 1, localReference: 'ord-broke' }),
    (err) => err.code === 'insufficient_funds',
  );
  assert.equal(adapter.calls.length, 0, 'Ruijie never contacted');
});
