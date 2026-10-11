import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import {
  createReseller,
  createConnection,
  createSite,
  assignSite,
  createPackage,
  grantPackage,
  createUser,
  authFor,
  teardownReseller,
  teardownConnection,
} from './reseller-fixtures.js';
import { createCatalogService } from '../../src/modules/catalog/service.js';
import { createResellerService } from '../../src/modules/resellers/service.js';
import { createOrderService } from '../../src/modules/orders/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('idempotent order creation with snapshot and quantity bounds', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const catalog = createCatalogService({ runner: pool });
  const resellerService = createResellerService({ runner: pool });
  const orders = createOrderService({ runner: pool, catalog, resellerService });

  const connection = await createConnection(pool);
  const site = await createSite(pool, connection.id);
  const reseller = await createReseller(pool);
  await assignSite(pool, reseller.id, site.id);
  const user = await createUser(pool, { role: 'reseller', resellerId: reseller.id });
  const pkg = await createPackage(pool, site.id);
  await grantPackage(pool, reseller.id, pkg.id);
  await catalog.setPrice({ packageId: pkg.id, scope: 'base', amountMinor: 1200 });

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('creates a draft order with a price snapshot', async () => {
    const out = await orders.createOrder({
      auth: authFor(user),
      siteId: site.id,
      packageId: pkg.id,
      quantity: 4,
      localReference: 'ord-1',
      clientReference: 'cash-1',
    });
    assert.equal(out.replayed, false);
    assert.equal(out.order.status, 'draft');
    assert.equal(Number(out.order.unit_price_minor), 1200);
    assert.equal(Number(out.order.total_minor), 4800);
    assert.equal(out.order.quantity, 4);
    assert.ok(out.order.price_rule_id);
    assert.equal(out.snapshot.totalMinor, 4800);
  });

  await t.test('rejects quantities outside 1-100 before reserving', async () => {
    for (const quantity of [0, 101, 1.5]) {
      await assert.rejects(
        () => orders.createOrder({ auth: authFor(user), siteId: site.id, packageId: pkg.id, quantity, localReference: `ord-q-${quantity}` }),
        (err) => err.code === 'quantity_out_of_range',
      );
    }
  });

  await t.test('requires a local reference', async () => {
    await assert.rejects(
      () => orders.createOrder({ auth: authFor(user), siteId: site.id, packageId: pkg.id, quantity: 1 }),
      (err) => err.code === 'local_reference_required',
    );
  });

  await t.test('compatible replay returns the same order without duplicating', async () => {
    const params = { auth: authFor(user), siteId: site.id, packageId: pkg.id, quantity: 2, localReference: 'ord-replay' };
    const first = await orders.createOrder(params);
    const second = await orders.createOrder(params);
    assert.equal(second.replayed, true);
    assert.equal(second.order.id, first.order.id);
    const count = await pool.query('SELECT count(*)::int AS c FROM voucher_orders WHERE local_reference = $1', ['ord-replay']);
    assert.equal(count.rows[0].c, 1);
  });

  await t.test('incompatible replay fails', async () => {
    await orders.createOrder({ auth: authFor(user), siteId: site.id, packageId: pkg.id, quantity: 2, localReference: 'ord-conflict' });
    await assert.rejects(
      () => orders.createOrder({ auth: authFor(user), siteId: site.id, packageId: pkg.id, quantity: 3, localReference: 'ord-conflict' }),
      (err) => err.code === 'reference_conflict',
    );
  });
});
