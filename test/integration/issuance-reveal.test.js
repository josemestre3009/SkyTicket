import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { TooManyRequestsError } from '../../src/auth/errors.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createReseller, createUser, authFor, teardownReseller } from './reseller-fixtures.js';
import { seedTenant, teardownTenant, createSimulatedAdapter } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('issuance delivery: masked listing, audited reveal/copy and rate limits', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const hits = [];
  const svc = createIssuanceService({
    runner: pool,
    adapter,
    cipher,
    rateLimit: async (scope, key) => {
      hits.push({ scope, key });
    },
  });

  const fx = await seedTenant(pool, { availableMinor: 50000, unitPriceMinor: 1000 });
  const otherReseller = await createReseller(pool);
  const otherUser = await createUser(pool, { role: 'reseller', resellerId: otherReseller.id });
  const admin = await createUser(pool, { role: 'admin' });

  const issued = await svc.issue({
    auth: authFor(fx.user),
    siteId: fx.site.id,
    packageId: fx.pkg.id,
    quantity: 2,
    localReference: 'mobile-reveal',
  });
  const voucherId = issued.vouchers[0].id;

  t.after(async () => {
    await teardownTenant(pool, fx);
    await teardownReseller(pool, otherReseller.id);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await close();
  });

  await t.test('listing is masked and never contains the plaintext code', async () => {
    const list = await svc.listOrderVouchers({ orderId: issued.order.id, auth: authFor(fx.user) });
    assert.equal(list.length, 2);
    assert.ok(list.every((v) => v.codeMasked.includes('*')));
    assert.equal(JSON.stringify(list).includes(cipher.decrypt(
      (await pool.query('SELECT code_encrypted FROM vouchers WHERE id = $1', [voucherId])).rows[0].code_encrypted,
    )), false);
  });

  await t.test('owner reveal returns the code, audits the event and hits the rate hook', async () => {
    const before = hits.length;
    const revealed = await svc.revealVoucher({ voucherId, auth: authFor(fx.user), channel: 'view' });
    assert.ok(revealed.code && revealed.code.length > 0);
    assert.equal(hits.length, before + 1);
    assert.equal(hits.at(-1).scope, 'reveal');
    assert.equal(hits.at(-1).key, `user:${fx.user.id}`);

    const audit = await pool.query(
      "SELECT * FROM audit_events WHERE action = 'voucher.reveal' AND entity_id = $1",
      [voucherId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].after_data.channel, 'view');
  });

  await t.test('copy uses the copy channel', async () => {
    const copied = await svc.copyVoucher({ voucherId, auth: authFor(fx.user) });
    assert.equal(copied.channel, 'copy');
  });

  await t.test('administrator may reveal any voucher', async () => {
    const revealed = await svc.revealVoucher({ voucherId, auth: authFor(admin), channel: 'view' });
    assert.ok(revealed.code);
  });

  await t.test('cross-tenant reveal is denied and audited', async () => {
    await assert.rejects(
      () => svc.revealVoucher({ voucherId, auth: authFor(otherUser), channel: 'view' }),
      (err) => err.code === 'cross_tenant',
    );
    const denied = await pool.query(
      "SELECT * FROM audit_events WHERE action = 'auth.cross_tenant.denied' AND entity_id = $1 AND result = 'denied'",
      [voucherId],
    );
    assert.ok(denied.rowCount >= 1);
  });

  await t.test('rate limit hook can block reveal', async () => {
    const blocking = createIssuanceService({
      runner: pool,
      adapter,
      cipher,
      rateLimit: async () => {
        throw new TooManyRequestsError('slow down', 30);
      },
    });
    await assert.rejects(
      () => blocking.revealVoucher({ voucherId, auth: authFor(fx.user), channel: 'view' }),
      (err) => err.code === 'rate_limited' && err.statusCode === 429,
    );
  });
});
