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
import { createResellerService } from '../../src/modules/resellers/service.js';
import { createCatalogService } from '../../src/modules/catalog/service.js';
import { createOrderService } from '../../src/modules/orders/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('shared site assignment and tenant isolation', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const resellerService = createResellerService({ runner: pool });
  const catalog = createCatalogService({ runner: pool });
  const orders = createOrderService({ runner: pool, catalog, resellerService });

  const connection = await createConnection(pool);
  const site = await createSite(pool, connection.id);
  const resellerA = await createReseller(pool);
  const resellerB = await createReseller(pool);
  const userA = await createUser(pool, { role: 'reseller', resellerId: resellerA.id });
  const pkg = await createPackage(pool, site.id);
  const basePayload = { packageId: pkg.id, scope: 'base', amountMinor: 1500 };

  t.after(async () => {
    await teardownReseller(pool, resellerA.id);
    await teardownReseller(pool, resellerB.id);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('assigns the same site to two resellers independently', async () => {
    await assignSite(pool, resellerA.id, site.id);
    await assignSite(pool, resellerB.id, site.id);
    const listA = await resellerService.listResellerSites(resellerA.id);
    const listB = await resellerService.listResellerSites(resellerB.id);
    assert.equal(listA.length, 1);
    assert.equal(listB.length, 1);
    const siteResellers = await resellerService.listSiteResellers(site.id);
    assert.equal(siteResellers.length, 2);
  });

  await t.test('commercial data is isolated per reseller', async () => {
    await grantPackage(pool, resellerA.id, pkg.id);
    await catalog.setPrice(basePayload);

    const created = await orders.createOrder({
      auth: authFor(userA),
      siteId: site.id,
      packageId: pkg.id,
      quantity: 2,
      localReference: 'iso-a-1',
    });
    assert.equal(created.order.reseller_id, resellerA.id);

    const ordersA = await orders.listOrders({ resellerId: resellerA.id });
    const ordersB = await orders.listOrders({ resellerId: resellerB.id });
    assert.equal(ordersA.length, 1);
    assert.equal(ordersB.length, 0);
  });
});
