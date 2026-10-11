import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { hashPassword } from '../../src/lib/password.js';
import { createAuthService } from '../../src/modules/identity/service.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createOrderService } from '../../src/modules/orders/service.js';
import { createReseller, createUser, authFor, teardownReseller, suffix } from './reseller-fixtures.js';
import { seedTenant, teardownTenant, createSimulatedAdapter, makeVouchers } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const FAST = { N: 1024, r: 8, p: 1 };
const CIPHER = Cipher.fromKey('security-fixes-key');

async function createResellerUser(pool, { status, password }) {
  const reseller = await createReseller(pool, { status });
  const email = `sec-${suffix()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, role, reseller_id) VALUES ($1, $2, 'reseller', $3)",
    [email, hashPassword(password, FAST), reseller.id],
  );
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return { reseller, user: rows[0], email };
}

test('reseller access: restricted may sign in/consult but never emit; pending may not sign in', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const password = 'security-fixes-password';
  const auth = createAuthService({ runner: pool, passwordParams: FAST });

  const restricted = await createResellerUser(pool, { status: 'restricted', password });
  const pending = await createResellerUser(pool, { status: 'pending', password });
  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await teardownReseller(pool, restricted.reseller.id);
    await teardownReseller(pool, pending.reseller.id);
    await pool.query('DELETE FROM auth_rate_limits WHERE bucket_key LIKE $1', [`email:sec-%`]);
    await close();
  });

  await t.test('restricted reseller logs in and keeps a resolvable session', async () => {
    const login = await auth.login({ email: restricted.email, password, ip: '127.0.0.1' });
    assert.equal(login.user.role, 'reseller');
    const context = await auth.resolve(login.token);
    assert.ok(context, 'session resolves for a restricted reseller');
    assert.equal(context.user.reseller_id, restricted.reseller.id);
  });

  await t.test('pending reseller is refused at login', async () => {
    await assert.rejects(
      () => auth.login({ email: pending.email, password, ip: '127.0.0.1' }),
      (err) => err.code === 'reseller_inactive',
    );
  });

  await t.test('restricted reseller cannot emit', async () => {
    await pool.query("UPDATE resellers SET status = 'restricted' WHERE id = $1", [fx.reseller.id]);
    const adapter = createSimulatedAdapter({ behavior: 'success' });
    const svc = createIssuanceService({ runner: pool, adapter, cipher: CIPHER, rateLimit: async () => {} });
    await assert.rejects(
      () =>
        svc.issue({
          auth: authFor(fx.user),
          siteId: fx.site.id,
          packageId: fx.pkg.id,
          quantity: 1,
          localReference: 'sec-restricted',
        }),
      (err) => err.code === 'reseller_cannot_emit',
    );
    const orders = await pool.query('SELECT count(*)::int AS c FROM voucher_orders WHERE local_reference = $1', [
      'sec-restricted',
    ]);
    assert.equal(orders.rows[0].c, 0, 'no order persisted for a restricted reseller');
    assert.equal(adapter.calls.length, 0, 'Ruijie never contacted');
  });
});

test('issuance count validation: duplicate vouchers go to reconciliation, not capture', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const base = createSimulatedAdapter({ behavior: 'success' });
  const adapter = {
    ...base,
    async createVouchers({ quantity }) {
      const list = makeVouchers(quantity);
      if (list.length > 1) list[1] = { ...list[1], uuid: list[0].uuid };
      return { list, count: quantity, code: 0, raw: { code: 0, count: quantity }, partial: false };
    },
  };
  const svc = createIssuanceService({ runner: pool, adapter, cipher: CIPHER, rateLimit: async () => {} });
  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  const balanceBefore = await pool.query('SELECT available_minor, reserved_minor FROM wallets WHERE reseller_id = $1', [
    fx.reseller.id,
  ]);

  const out = await svc.issue({
    auth: authFor(fx.user),
    siteId: fx.site.id,
    packageId: fx.pkg.id,
    quantity: 3,
    localReference: 'sec-dup',
  });

  assert.equal(out.outcome, 'needs_reconciliation');
  assert.equal(out.order.status, 'needs_reconciliation');
  assert.equal(out.order.reconciliation_reason, 'voucher_persistence_mismatch');

  const balanceAfter = await pool.query('SELECT available_minor, reserved_minor FROM wallets WHERE reseller_id = $1', [
    fx.reseller.id,
  ]);
  assert.equal(
    Number(balanceAfter.rows[0].reserved_minor),
    Number(balanceBefore.rows[0].reserved_minor) + 3000,
    'reservation kept intact (no capture)',
  );

  const stored = await pool.query('SELECT count(*)::int AS c FROM vouchers WHERE order_id = $1', [out.order.id]);
  assert.equal(stored.rows[0].c, 2, 'only distinct vouchers persisted as evidence');
});

test('order tenant guard: cross-tenant read is denied and audited', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const orders = createOrderService({ runner: pool });
  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });
  const other = await createReseller(pool);
  const otherUser = await createUser(pool, { role: 'reseller', resellerId: other.id });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await teardownReseller(pool, other.id);
    await close();
  });

  const created = await orders.createOrder({
    auth: authFor(fx.user),
    siteId: fx.site.id,
    packageId: fx.pkg.id,
    quantity: 1,
    localReference: 'sec-audit',
  });

  await assert.rejects(
    () => orders.assertOrderAccess({ auth: authFor(otherUser), order: created.order, ip: '10.0.0.9' }),
    (err) => err.code === 'cross_tenant',
  );

  const denied = await pool.query(
    "SELECT * FROM audit_events WHERE action = 'auth.cross_tenant.denied' AND entity_id = $1 AND result = 'denied'",
    [created.order.id],
  );
  assert.equal(denied.rowCount, 1, 'cross-tenant order read is audited');
  assert.equal(denied.rows[0].ip, '10.0.0.9');
});

test('emission uses the persisted issue rate limit scope', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const hits = [];
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const svc = createIssuanceService({
    runner: pool,
    adapter,
    cipher: CIPHER,
    rateLimit: async (scope, key) => {
      hits.push({ scope, key });
    },
  });
  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  await svc.issue({
    auth: authFor(fx.user),
    siteId: fx.site.id,
    packageId: fx.pkg.id,
    quantity: 1,
    localReference: 'sec-rate',
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].scope, 'issue');
  assert.equal(hits[0].key, `user:${fx.user.id}`);
});
