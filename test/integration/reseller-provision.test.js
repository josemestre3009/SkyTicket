import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { teardownReseller } from './reseller-fixtures.js';
import { createResellerService, MIN_TEMP_PASSWORD_LENGTH } from '../../src/modules/resellers/service.js';
import { createAuthService } from '../../src/modules/identity/service.js';
import { verifyPassword } from '../../src/lib/password.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const FAST_PARAMS = { N: 1024, r: 8, p: 1 };

test('reseller provisioning', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createResellerService({ runner: pool, passwordParams: FAST_PARAMS });
  const auth = createAuthService({ runner: pool });
  const s = crypto.randomUUID().slice(0, 8);
  const password = 'temporal-segura-123';
  const created = [];

  t.after(async () => {
    for (const id of created) await teardownReseller(pool, id);
    await close();
  });

  await t.test('creates reseller + reseller user atomically with scrypt password', async () => {
    const name = `Prov ${s}`;
    const email = `prov-${s}@example.test`;
    const out = await service.createResellerWithUser({
      name,
      email,
      password,
      lowBalanceThresholdMinor: 5000,
      actor: { id: null, role: 'admin' },
    });
    created.push(out.reseller.id);

    assert.equal(out.reseller.status, 'active');
    assert.equal(out.reseller.name, name);
    assert.equal(Number(out.reseller.low_balance_threshold_minor), 5000);
    assert.equal(out.user.role, 'reseller');
    assert.equal(out.user.resellerId, out.reseller.id);
    assert.equal(out.user.mustChangePassword, true);

    const userRow = await pool.query('SELECT password_hash FROM users WHERE id = $1', [out.user.id]);
    assert.match(userRow.rows[0].password_hash, /^scrypt\$/);
    assert.ok(!userRow.rows[0].password_hash.includes(password));
    assert.equal(verifyPassword(password, userRow.rows[0].password_hash), true);

    const wallet = await pool.query('SELECT * FROM wallets WHERE reseller_id = $1', [out.reseller.id]);
    assert.equal(wallet.rows.length, 1);
    assert.equal(Number(wallet.rows[0].low_balance_threshold_minor), 5000);

    const audit = await pool.query(
      "SELECT after_data FROM audit_events WHERE reseller_id = $1 AND action = 'reseller.create'",
      [out.reseller.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].after_data.email, email.toLowerCase());
    assert.equal(audit.rows[0].after_data.password, undefined);
    assert.equal(audit.rows[0].after_data.userId, out.user.id);

    const users = await service.listResellerUsers(out.reseller.id);
    assert.equal(users.length, 1);
    assert.equal(users[0].email, email.toLowerCase());
    assert.equal(users[0].must_change_password, true);
    assert.equal(users[0].password_hash, undefined);
  });

  await t.test('new reseller can log in immediately', async () => {
    const email = `login-${s}@example.test`;
    const out = await service.createResellerWithUser({ name: `Login ${s}`, email, password });
    created.push(out.reseller.id);

    const session = await auth.login({ email, password });
    assert.equal(session.user.email, email);
    assert.equal(session.user.resellerId, out.reseller.id);
  });

  await t.test('duplicate email rolls back without an orphan reseller', async () => {
    const email = `dup-${s}@example.test`;
    const first = await service.createResellerWithUser({ name: `Dup A ${s}`, email, password });
    created.push(first.reseller.id);

    const orphanName = `Orphan ${s}`;
    await assert.rejects(
      () => service.createResellerWithUser({ name: orphanName, email: email.toUpperCase(), password }),
      (err) => err.code === 'email_taken',
    );

    const orphans = await pool.query('SELECT id FROM resellers WHERE name = $1', [orphanName]);
    assert.equal(orphans.rows.length, 0);
    const users = await pool.query('SELECT count(*)::int AS c FROM users WHERE email ILIKE $1', [email]);
    assert.equal(users.rows[0].c, 1);
  });

  await t.test('validates name, email, password length, status and threshold', async () => {
    assert.equal(MIN_TEMP_PASSWORD_LENGTH, 12);
    const validEmail = `val-${s}@example.test`;

    await assert.rejects(
      () => service.createResellerWithUser({ email: validEmail, password }),
      (err) => err.code === 'name_required',
    );
    await assert.rejects(
      () => service.createResellerWithUser({ name: 'X', email: 'not-an-email', password }),
      (err) => err.code === 'email_required',
    );
    await assert.rejects(
      () => service.createResellerWithUser({ name: 'X', email: validEmail, password: 'short' }),
      (err) => err.code === 'password_too_short',
    );
    await assert.rejects(
      () => service.createResellerWithUser({ name: 'X', email: validEmail, password, status: 'bogus' }),
      (err) => err.code === 'invalid_status',
    );
    await assert.rejects(
      () => service.createResellerWithUser({ name: 'X', email: validEmail, password, lowBalanceThresholdMinor: -1 }),
      (err) => err.code === 'invalid_threshold',
    );
  });
});
