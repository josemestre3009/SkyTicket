import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { teardownReseller } from './reseller-fixtures.js';
import { createResellerService, MIN_TEMP_PASSWORD_LENGTH } from '../../src/modules/resellers/service.js';
import { verifyPassword } from '../../src/lib/password.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const FAST_PARAMS = { N: 1024, r: 8, p: 1 };

test('reseller user provisioning', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createResellerService({ runner: pool, passwordParams: FAST_PARAMS });
  const s = crypto.randomUUID().slice(0, 8);
  const password = 'temporal-segura-123';
  const created = [];

  t.after(async () => {
    for (const id of created) await teardownReseller(pool, id);
    await close();
  });

  async function newReseller() {
    const out = await service.createResellerWithUser({
      name: `UserProv ${s}`,
      email: `owner-${crypto.randomUUID().slice(0, 8)}@example.test`,
      password,
      actor: { id: null, role: 'admin' },
    });
    created.push(out.reseller.id);
    return out;
  }

  await t.test('adds a second user to an existing reseller with role/must-change and no password in audit', async () => {
    const { reseller } = await newReseller();
    const email = `second-${s}@example.test`;

    const out = await service.createUserForReseller({
      resellerId: reseller.id,
      email: email.toUpperCase(),
      password,
      actor: { id: null, role: 'admin' },
      ip: '127.0.0.1',
    });

    assert.equal(out.user.role, 'reseller');
    assert.equal(out.user.resellerId, reseller.id);
    assert.equal(out.user.mustChangePassword, true);
    assert.equal(out.user.email, email.toLowerCase());
    assert.equal(out.user.password, undefined);

    const row = await pool.query('SELECT password_hash FROM users WHERE id = $1', [out.user.id]);
    assert.match(row.rows[0].password_hash, /^scrypt\$/);
    assert.equal(verifyPassword(password, row.rows[0].password_hash), true);

    const audit = await pool.query(
      "SELECT after_data FROM audit_events WHERE action = 'reseller.user.create' AND entity_id = $1",
      [out.user.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].after_data.email, email.toLowerCase());
    assert.equal(audit.rows[0].after_data.password, undefined);
    assert.equal(audit.rows[0].after_data.resellerId, reseller.id);

    const users = await service.listResellerUsers(reseller.id);
    assert.equal(users.length, 2);
    for (const u of users) assert.equal(u.password_hash, undefined);
  });

  await t.test('rejects a closed reseller', async () => {
    const { reseller } = await newReseller();
    await service.setStatus({ resellerId: reseller.id, status: 'closed' });

    await assert.rejects(
      () => service.createUserForReseller({ resellerId: reseller.id, email: `closed-${s}@example.test`, password }),
      (err) => err.code === 'reseller_closed',
    );
    const users = await service.listResellerUsers(reseller.id);
    assert.equal(users.length, 1);
  });

  await t.test('rejects an unknown reseller', async () => {
    await assert.rejects(
      () => service.createUserForReseller({ resellerId: crypto.randomUUID(), email: `missing-${s}@example.test`, password }),
      (err) => err.code === 'reseller_not_found',
    );
  });

  await t.test('validates email and password length', async () => {
    const { reseller } = await newReseller();
    assert.equal(MIN_TEMP_PASSWORD_LENGTH, 12);
    await assert.rejects(
      () => service.createUserForReseller({ resellerId: reseller.id, email: 'not-an-email', password }),
      (err) => err.code === 'email_required',
    );
    await assert.rejects(
      () => service.createUserForReseller({ resellerId: reseller.id, email: `short-${s}@example.test`, password: 'short' }),
      (err) => err.code === 'password_too_short',
    );
  });

  await t.test('duplicate email rolls back without a new user', async () => {
    const { reseller, user: first } = await newReseller();

    await assert.rejects(
      () => service.createUserForReseller({ resellerId: reseller.id, email: first.email.toUpperCase(), password }),
      (err) => err.code === 'email_taken',
    );

    const users = await service.listResellerUsers(reseller.id);
    assert.equal(users.length, 1);
  });
});
