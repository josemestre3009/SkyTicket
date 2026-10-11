import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import {
  createReseller,
  createConnection,
  createSite,
  assignSite,
  createUser,
  authFor,
  teardownReseller,
  teardownConnection,
} from './reseller-fixtures.js';
import { createResellerService } from '../../src/modules/resellers/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('tenant authorization', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createResellerService({ runner: pool });

  const connection = await createConnection(pool);
  const site = await createSite(pool, connection.id);
  const resellerA = await createReseller(pool);
  const resellerB = await createReseller(pool);
  await assignSite(pool, resellerA.id, site.id);
  const userA = await createUser(pool, { role: 'reseller', resellerId: resellerA.id });
  const userB = await createUser(pool, { role: 'reseller', resellerId: resellerB.id });
  const admin = await createUser(pool, { role: 'admin' });

  const spy = () => {
    let calls = 0;
    return {
      adapter: { resolveConnection: async () => { calls += 1; return { region: 'eu' }; } },
      calls: () => calls,
    };
  };

  t.after(async () => {
    await teardownReseller(pool, resellerA.id);
    await teardownReseller(pool, resellerB.id);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('authorizes an assigned site for the session tenant', async () => {
    const s = spy();
    const result = await service.authorizeSiteAccess({
      auth: authFor(userA),
      siteId: site.id,
      adapter: s.adapter,
    });
    assert.equal(result.resellerId, resellerA.id);
    assert.equal(result.site.ruijieGroupId, site.ruijie_group_id);
    assert.equal(s.calls(), 1);
  });

  await t.test('rejects a client-supplied groupId with 403 and no adapter call', async () => {
    const s = spy();
    await assert.rejects(
      () => service.authorizeSiteAccess({
        auth: authFor(userA),
        siteId: site.id,
        clientIdentifiers: { groupId: 'injected-999' },
        adapter: s.adapter,
      }),
      (err) => err.statusCode === 403 && err.code === 'cross_tenant',
    );
    assert.equal(s.calls(), 0, 'no Ruijie call on denial');
  });

  await t.test('rejects cross-tenant site with 403 and zero adapter calls', async () => {
    const s = spy();
    await assert.rejects(
      () => service.authorizeSiteAccess({ auth: authFor(userB), siteId: site.id, adapter: s.adapter }),
      (err) => err.statusCode === 403 && err.code === 'cross_tenant',
    );
    assert.equal(s.calls(), 0);
    const audit = await pool.query(
      "SELECT count(*)::int AS c FROM audit_events WHERE action = 'auth.cross_tenant.denied' AND entity_id = $1",
      [site.id],
    );
    assert.ok(audit.rows[0].c >= 1);
  });

  await t.test('reseller cannot override reseller_id', async () => {
    await assert.rejects(
      () => service.authorizeSiteAccess({ auth: authFor(userA), siteId: site.id, clientIdentifiers: { resellerId: resellerB.id } }),
      (err) => err.code === 'cross_tenant',
    );
  });

  await t.test('admin must provide an explicit reseller target', async () => {
    await assert.rejects(
      () => service.authorizeSiteAccess({ auth: authFor(admin), siteId: site.id }),
      (err) => err.code === 'reseller_id_required',
    );
    const result = await service.authorizeSiteAccess({
      auth: authFor(admin),
      siteId: site.id,
      clientIdentifiers: { resellerId: resellerA.id },
    });
    assert.equal(result.resellerId, resellerA.id);
  });
});
