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
import { createOrderService, ORDER_TRANSITIONS } from '../../src/modules/orders/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('order state machine and idempotent events', { skip }, async (t) => {
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
  await catalog.setPrice({ packageId: pkg.id, scope: 'base', amountMinor: 1000 });

  const makeOrder = (ref) => orders.createOrder({ auth: authFor(user), siteId: site.id, packageId: pkg.id, quantity: 1, localReference: ref });

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('walks the happy path and records timestamps/events', async () => {
    const { order } = await makeOrder('state-1');
    let step = await orders.transition({ orderId: order.id, to: 'reserved', eventType: 'reserve' });
    assert.equal(step.order.status, 'reserved');
    assert.ok(step.order.reserved_at);
    step = await orders.transition({ orderId: order.id, to: 'issuing', eventType: 'issue_start' });
    assert.equal(step.order.status, 'issuing');
    step = await orders.transition({ orderId: order.id, to: 'issued', eventType: 'issue_done' });
    assert.equal(step.order.status, 'issued');
    assert.ok(step.order.issued_at);

    const events = await orders.listOrderEvents(order.id);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.to_status), ['reserved', 'issuing', 'issued']);
  });

  await t.test('rejects invalid jumps and repetitions', async () => {
    const { order } = await makeOrder('state-2');
    await assert.rejects(
      () => orders.transition({ orderId: order.id, to: 'issued' }),
      (err) => err.code === 'invalid_transition',
    );
    await orders.transition({ orderId: order.id, to: 'reserved' });
    await assert.rejects(
      () => orders.transition({ orderId: order.id, to: 'reserved' }),
      (err) => err.code === 'invalid_transition',
    );
  });

  await t.test('terminal states accept no transitions', () => {
    assert.deepEqual(ORDER_TRANSITIONS.issued, []);
    assert.deepEqual(ORDER_TRANSITIONS.failed, []);
    assert.deepEqual(ORDER_TRANSITIONS.canceled, []);
  });

  await t.test('idempotent transition with a key is applied once', async () => {
    const { order } = await makeOrder('state-3');
    await orders.transition({ orderId: order.id, to: 'reserved' });
    const key = 'evt-idem-1';
    const first = await orders.transition({ orderId: order.id, to: 'issuing', idempotencyKey: key });
    assert.equal(first.replayed, false);
    const second = await orders.transition({ orderId: order.id, to: 'issuing', idempotencyKey: key });
    assert.equal(second.replayed, true);
    const events = await orders.listOrderEvents(order.id);
    assert.equal(events.filter((e) => e.idempotency_key === key).length, 1);
  });
});
