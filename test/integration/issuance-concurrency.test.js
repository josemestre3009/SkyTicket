import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createWalletService } from '../../src/modules/wallet/service.js';
import { seedTenant, teardownTenant, createSimulatedAdapter, authFor } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('issuance concurrency: competing requests never double-create or double-capture', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const svc = createIssuanceService({ runner: pool, adapter, cipher, rateLimit: async () => {} });
  const wallet = createWalletService({ runner: pool });

  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  await t.test('same reference concurrently yields one order, one create and one capture', async () => {
    const params = {
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 3,
      localReference: 'ord-race',
    };
    const results = await Promise.all([svc.issue(params), svc.issue(params)]);
    const issued = results.filter((r) => r.outcome === 'issued');
    assert.equal(issued.length, 1, 'exactly one request performs the emission');
    assert.equal(results[0].order.id, results[1].order.id, 'both share one order');
    assert.equal(adapter.calls.length, 1, 'Ruijie create called exactly once');

    const orders = await pool.query('SELECT count(*)::int AS c FROM voucher_orders WHERE local_reference = $1', ['ord-race']);
    assert.equal(orders.rows[0].c, 1);
    const vouchers = await pool.query('SELECT count(*)::int AS c FROM vouchers WHERE order_id = $1', [results[0].order.id]);
    assert.equal(vouchers.rows[0].c, 3, 'no duplicated vouchers');

    const bal = await wallet.getBalance(fx.reseller.id);
    assert.equal(bal.availableMinor, 97000, 'charged once');
    assert.equal(bal.reservedMinor, 0, 'no dangling reservation');
  });

  await t.test('concurrent distinct orders keep the ledger consistent', async () => {
    const make = (n) => ({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 1,
      localReference: `ord-par-${n}`,
    });
    const results = await Promise.all([make('a'), make('b'), make('c')].map((p) => svc.issue(p)));
    assert.ok(results.every((r) => r.outcome === 'issued'));
    const sum = await pool.query(
      `SELECT w.available_minor, w.reserved_minor,
              COALESCE(SUM(l.available_delta), 0)::bigint AS ledger_available
       FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
       WHERE w.reseller_id = $1 GROUP BY w.id`,
      [fx.reseller.id],
    );
    const row = sum.rows[0];
    assert.equal(Number(row.available_minor), Number(row.ledger_available), 'projection equals ledger');
    assert.ok(Number(row.available_minor) >= 0, 'never negative');
    assert.equal(Number(row.reserved_minor), 0);
  });
});
