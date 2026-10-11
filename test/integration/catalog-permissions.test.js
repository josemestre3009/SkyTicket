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

test('catalog permissions gate visibility and purchase', { skip }, async (t) => {
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
  const allowed = await createPackage(pool, site.id, { name: 'Allowed' });
  const blocked = await createPackage(pool, site.id, { name: 'Blocked' });
  await grantPackage(pool, reseller.id, allowed.id);

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('only authorized packages are listed', async () => {
    const list = await catalog.listAuthorizedPackages({ resellerId: reseller.id, siteId: site.id });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, allowed.id);
  });

  await t.test('unauthorized package cannot be resolved even by direct id', async () => {
    await assert.rejects(
      () => catalog.assertPackageAuthorized({ resellerId: reseller.id, siteId: site.id, packageId: blocked.id }),
      (err) => err.statusCode === 403 && err.code === 'package_not_authorized',
    );
  });

  await t.test('direct order creation with unauthorized package fails', async () => {
    await assert.rejects(
      () => orders.createOrder({
        auth: authFor(user),
        siteId: site.id,
        packageId: blocked.id,
        quantity: 1,
        localReference: 'perm-blocked-1',
      }),
      (err) => err.code === 'package_not_authorized',
    );
  });

  await t.test('revoking removes visibility', async () => {
    await catalog.revokePackage({ resellerId: reseller.id, packageId: allowed.id });
    const list = await catalog.listAuthorizedPackages({ resellerId: reseller.id, siteId: site.id });
    assert.equal(list.length, 0);
  });
});
