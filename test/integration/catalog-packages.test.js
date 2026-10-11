import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createConnection, createSite, createPackage, teardownConnection } from './reseller-fixtures.js';
import { createCatalogService } from '../../src/modules/catalog/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('catalog sync: upsert, raw JSON, text IDs, non-destructive deactivation', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const catalog = createCatalogService({ runner: pool });
  const connection = await createConnection(pool);

  t.after(async () => {
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('sites upsert and deactivate missing', async () => {
    const first = await catalog.syncSites({
      connectionId: connection.id,
      sites: [
        { ruijieGroupId: 'g-1', name: 'One', raw: { id: 'g-1' } },
        { ruijieGroupId: 'g-2', name: 'Two' },
      ],
    });
    assert.equal(first.upserted, 2);

    const resync = await catalog.syncSites({
      connectionId: connection.id,
      sites: [{ ruijieGroupId: 'g-1', name: 'One renamed', raw: { id: 'g-1' } }],
    });
    assert.equal(resync.upserted, 1);
    assert.equal(resync.disabled, 1);

    const rows = await pool.query(
      'SELECT ruijie_group_id, name, status, raw_json FROM sites WHERE ruijie_connection_id = $1 ORDER BY ruijie_group_id',
      [connection.id],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.ruijie_group_id, r]));
    assert.equal(byId['g-1'].name, 'One renamed');
    assert.equal(byId['g-1'].status, 'active');
    assert.deepEqual(byId['g-1'].raw_json, { id: 'g-1' });
    assert.equal(byId['g-2'].status, 'disabled');
  });

  await t.test('packages upsert, keep long IDs as text and raw JSON', async () => {
    const site = await createSite(pool, connection.id);
    const longId = '90071992547409931999';
    await catalog.syncPackages({
      siteId: site.id,
      packages: [
        { ruijieUserGroupId: longId, ruijieProfileId: '90071992547409932', name: 'Big', quota: 100, raw: { marker: true } },
        { ruijieUserGroupId: 'pkg-2', ruijieProfileId: 'profile-2', name: 'Small' },
      ],
    });

    const stored = await pool.query('SELECT ruijie_user_group_id, ruijie_profile_id, raw_json, status FROM packages WHERE site_id = $1', [site.id]);
    const big = stored.rows.find((r) => r.ruijie_user_group_id === longId);
    assert.ok(big, 'long id preserved exactly');
    assert.equal(big.ruijie_profile_id, '90071992547409932');
    assert.deepEqual(big.raw_json, { marker: true });

    const resync = await catalog.syncPackages({
      siteId: site.id,
      packages: [{ ruijieUserGroupId: longId, name: 'Big renamed' }],
    });
    assert.equal(resync.disabled, 1);
    const after = await pool.query(
      "SELECT status, name FROM packages WHERE site_id = $1 AND ruijie_user_group_id = $2",
      [site.id, 'pkg-2'],
    );
    assert.equal(after.rows[0].status, 'disabled');
    const renamed = await pool.query(
      'SELECT name, status FROM packages WHERE site_id = $1 AND ruijie_user_group_id = $2',
      [site.id, longId],
    );
    assert.equal(renamed.rows[0].name, 'Big renamed');
    assert.equal(renamed.rows[0].status, 'active');
  });

  await t.test('empty sync disables everything without deleting', async () => {
    const site = await createSite(pool, connection.id);
    await createPackage(pool, site.id, { ruijieUserGroupId: 'only-1' });
    const out = await catalog.syncPackages({ siteId: site.id, packages: [] });
    assert.equal(out.disabled, 1);
    const rows = await pool.query('SELECT count(*)::int AS count FROM packages WHERE site_id = $1', [site.id]);
    assert.equal(rows.rows[0].count, 1, 'package row still exists');
  });
});
