import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createSite, teardownConnection } from './reseller-fixtures.js';
import { createCatalogService } from '../../src/modules/catalog/service.js';
import { createRuijieInventoryService } from '../../src/modules/ruijie-inventory/service.js';
import { Cipher } from '../../src/lib/crypto.js';
import { normalizeUserGroup } from '../../src/ruijie/normalize.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const CIPHER = Cipher.fromKey('integration-inventory-key');

const CONFIG = {
  ruijie: {
    readEnabled: true,
    liveEnabled: false,
    region: 'eu',
    baseUrl: 'https://example.test',
    appId: 'app-integration',
    appSecret: 'secret-integration',
  },
};

const USER_GROUPS = [
  { id: 18067, userGroupName: '1DayWiFi', authProfileId: '30113648274480073538014045592098', timePeriod: 1440, quota: 100, bindMac: 0 },
  { id: 18068, userGroupName: '2DayWiFi', authProfileId: '30113648274480073538014045592099', timePeriod: 2880, quota: 0, bindMac: 1 },
];

async function createEncryptedConnection(pool) {
  const { rows } = await pool.query(
    `INSERT INTO ruijie_connections (region, base_url, app_id, app_secret_encrypted)
     VALUES ('eu', 'https://example.test', $1, $2) RETURNING *`,
    [`app-${crypto.randomUUID().slice(0, 8)}`, CIPHER.encrypt('secret-integration')],
  );
  return rows[0];
}

function clientFactory({ fail = false } = {}) {
  return () => ({
    async getGroupTree() {
      return {
        nodes: [
          { groupId: 'g-site', name: 'Sitio Centro', type: 'BUILDING', timezone: 'America/Bogota', parentGroupId: null, raw: { groupId: 'g-site' } },
        ],
      };
    },
    async listUserGroups() {
      if (fail) throw new Error('ruijie user groups unavailable');
      return {
        code: 0,
        msg: 'OK.',
        count: USER_GROUPS.length,
        maxAllowNum: 50,
        list: USER_GROUPS.map(normalizeUserGroup),
      };
    },
  });
}

test('ruijie inventory syncCatalog persists sites and packages to PostgreSQL', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const catalog = createCatalogService({ runner: pool });
  const inventory = createRuijieInventoryService({
    config: CONFIG,
    runner: pool,
    catalog,
    cipher: CIPHER,
    clientFactory: clientFactory(),
  });

  const connection = await createEncryptedConnection(pool);
  t.after(async () => {
    await teardownConnection(pool, connection.id);
    await close();
  });

  const out = await inventory.syncCatalog({ connectionId: connection.id });

  assert.equal(out.syncedSites, 1);
  assert.equal(out.packageCount, USER_GROUPS.length);
  assert.deepEqual(out.errors, []);

  const sites = await pool.query('SELECT * FROM sites WHERE ruijie_connection_id = $1', [connection.id]);
  assert.equal(sites.rows.length, 1);
  assert.equal(sites.rows[0].ruijie_group_id, 'g-site');

  const packages = await pool.query(
    'SELECT * FROM packages WHERE site_id = $1 ORDER BY ruijie_user_group_id',
    [sites.rows[0].id],
  );
  assert.equal(packages.rows.length, USER_GROUPS.length);
  assert.equal(packages.rows[0].ruijie_profile_id, '30113648274480073538014045592098');
  assert.equal(packages.rows[0].duration, 1440);
  assert.equal(packages.rows[0].status, 'active');
});

test('a failed package fetch leaves existing packages active', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const catalog = createCatalogService({ runner: pool });
  const inventory = createRuijieInventoryService({
    config: CONFIG,
    runner: pool,
    catalog,
    cipher: CIPHER,
    clientFactory: clientFactory({ fail: true }),
  });

  const connection = await createEncryptedConnection(pool);
  const site = await createSite(pool, connection.id, { ruijieGroupId: 'g-fail' });
  const seeded = await pool.query(
    `INSERT INTO packages (site_id, ruijie_user_group_id, ruijie_profile_id, name)
     VALUES ($1, 'ug-seeded', 'profile-seeded', 'Seeded') RETURNING id`,
    [site.id],
  );

  t.after(async () => {
    await teardownConnection(pool, connection.id);
    await close();
  });

  const result = await inventory.syncPackages(site.id);
  assert.equal(result.complete, false);
  assert.ok(result.error);

  const after = await pool.query('SELECT status FROM packages WHERE id = $1', [seeded.rows[0].id]);
  assert.equal(after.rows[0].status, 'active', 'existing package must stay active after a failed fetch');
});

test('packages allow a NULL ruijie_profile_id (migration 0017)', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const connection = await createEncryptedConnection(pool);
  const site = await createSite(pool, connection.id, { ruijieGroupId: 'g-null' });

  t.after(async () => {
    await teardownConnection(pool, connection.id);
    await close();
  });

  const { rows } = await pool.query(
    `INSERT INTO packages (site_id, ruijie_user_group_id, ruijie_profile_id, name)
     VALUES ($1, 'ug-null', NULL, 'No profile') RETURNING ruijie_profile_id`,
    [site.id],
  );
  assert.equal(rows[0].ruijie_profile_id, null);
});
