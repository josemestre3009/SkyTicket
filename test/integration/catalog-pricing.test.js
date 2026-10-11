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

test('versioned pricing precedence and order snapshot', { skip }, async (t) => {
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

  const pBase = await createPackage(pool, site.id, { name: 'Base' });
  const pSite = await createPackage(pool, site.id, { name: 'Site' });
  const pReseller = await createPackage(pool, site.id, { name: 'Reseller' });
  const pBoth = await createPackage(pool, site.id, { name: 'Both' });
  const pMissing = await createPackage(pool, site.id, { name: 'Missing' });

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('base price resolves', async () => {
    await catalog.setPrice({ packageId: pBase.id, scope: 'base', amountMinor: 1000 });
    const price = await catalog.resolvePrice({ packageId: pBase.id, resellerId: reseller.id, siteId: site.id });
    assert.equal(price.amountMinor, 1000);
    assert.equal(price.scope, 'base');
  });

  await t.test('site overrides base', async () => {
    await catalog.setPrice({ packageId: pSite.id, scope: 'base', amountMinor: 1000 });
    await catalog.setPrice({ packageId: pSite.id, scope: 'site', siteId: site.id, amountMinor: 900 });
    const price = await catalog.resolvePrice({ packageId: pSite.id, resellerId: reseller.id, siteId: site.id });
    assert.equal(price.amountMinor, 900);
    assert.equal(price.scope, 'site');
  });

  await t.test('reseller overrides site and base', async () => {
    await catalog.setPrice({ packageId: pReseller.id, scope: 'base', amountMinor: 1000 });
    await catalog.setPrice({ packageId: pReseller.id, scope: 'site', siteId: site.id, amountMinor: 900 });
    await catalog.setPrice({ packageId: pReseller.id, scope: 'reseller', resellerId: reseller.id, amountMinor: 800 });
    const price = await catalog.resolvePrice({ packageId: pReseller.id, resellerId: reseller.id, siteId: site.id });
    assert.equal(price.amountMinor, 800);
    assert.equal(price.scope, 'reseller');
  });

  await t.test('reseller+site is the most specific override', async () => {
    await catalog.setPrice({ packageId: pBoth.id, scope: 'base', amountMinor: 1000 });
    await catalog.setPrice({ packageId: pBoth.id, scope: 'site', siteId: site.id, amountMinor: 900 });
    await catalog.setPrice({ packageId: pBoth.id, scope: 'reseller', resellerId: reseller.id, amountMinor: 800 });
    await catalog.setPrice({ packageId: pBoth.id, scope: 'reseller_site', resellerId: reseller.id, siteId: site.id, amountMinor: 700 });
    const price = await catalog.resolvePrice({ packageId: pBoth.id, resellerId: reseller.id, siteId: site.id });
    assert.equal(price.amountMinor, 700);
    assert.equal(price.scope, 'reseller_site');
  });

  await t.test('missing price is reported, not defaulted', async () => {
    await assert.rejects(
      () => catalog.resolvePrice({ packageId: pMissing.id, resellerId: reseller.id, siteId: site.id }),
      (err) => err.code === 'price_missing',
    );
  });

  await t.test('overlapping validity windows are rejected', async () => {
    const pkg = await createPackage(pool, site.id, { name: 'Overlap' });
    const at = new Date(Date.now() - 60_000);
    await catalog.setPrice({ packageId: pkg.id, scope: 'base', amountMinor: 1000, effectiveFrom: at });
    await assert.rejects(
      () => catalog.setPrice({ packageId: pkg.id, scope: 'base', amountMinor: 2000, effectiveFrom: at }),
      (err) => err.code === 'price_overlap',
    );
  });

  await t.test('order snapshot is immune to later price changes', async () => {
    await grantPackage(pool, reseller.id, pBase.id);
    await catalog.setPrice({ packageId: pBase.id, scope: 'base', amountMinor: 1500 });
    const created = await orders.createOrder({
      auth: authFor(user),
      siteId: site.id,
      packageId: pBase.id,
      quantity: 3,
      localReference: 'snap-1',
    });
    assert.equal(Number(created.order.unit_price_minor), 1500);
    assert.equal(Number(created.order.total_minor), 4500);
    assert.equal(created.snapshot.totalMinor, 4500);

    await catalog.setPrice({ packageId: pBase.id, scope: 'base', amountMinor: 2000 });
    const fetched = await orders.getOrder(created.order.id);
    assert.equal(Number(fetched.unit_price_minor), 1500);
    assert.equal(Number(fetched.total_minor), 4500);
    const nowPrice = await catalog.resolvePrice({ packageId: pBase.id, resellerId: reseller.id, siteId: site.id });
    assert.equal(nowPrice.amountMinor, 2000);
  });
});
