import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { hashPassword } from '../../src/lib/password.js';
import { Cipher } from '../../src/lib/crypto.js';
import { bootstrapAdmin } from '../../src/modules/identity/bootstrap.js';
import { createAuth } from '../../src/auth/plugin.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const KEY = '0'.repeat(64);
const FAST = { N: 1024, r: 8, p: 1 };

function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find((c) => c && c.startsWith('skyticket_sid='))?.split(';')[0];
}

async function cleanup(pool, suffix) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(
      `DELETE FROM auth_rate_limits WHERE bucket_key LIKE $1
         OR bucket_key IN (SELECT 'user:'||id::text FROM users WHERE email LIKE $2)`,
      [`%authit-${suffix}%`, `authit-${suffix}%`],
    );
    await client.query('DELETE FROM audit_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`authit-${suffix}%`]);
    await client.query('DELETE FROM users WHERE email LIKE $1', [`authit-${suffix}%`]);
    await client.query('DELETE FROM resellers WHERE name LIKE $1', [`authit-${suffix}%`]);
    await client.query("SET session_replication_role = 'origin'");
  } finally {
    client.release();
  }
}

async function makeApp(pool) {
  const auth = createAuth({ runner: pool, cipher: Cipher.fromKey(KEY), passwordParams: FAST });
  const app = Fastify();
  await app.register(auth.plugin, { prefix: '/auth' });
  await app.ready();
  return app;
}

test('auth sessions', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `authit-${suffix}@example.test`;
  const password = 'session-password';

  await bootstrapAdmin({ email: adminEmail, password, runner: pool, cipher: Cipher.fromKey(KEY), passwordParams: FAST });
  const app = await makeApp(pool);

  t.after(async () => {
    await app.close();
    await cleanup(pool, suffix);
    await close();
  });

  await t.test('logout revokes the session server-side', async () => {
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: adminEmail, password } });
    const cookie = cookieFrom(login);
    const csrf = login.json().csrfToken;

    const before = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    assert.equal(before.statusCode, 200);

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    assert.equal(out.statusCode, 200);

    const after = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    assert.equal(after.statusCode, 401);
  });

  await t.test('expired sessions are rejected and marked revoked', async () => {
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: adminEmail, password } });
    const cookie = cookieFrom(login);
    const userId = login.json().user.id;

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [userId]);

    const res = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    assert.equal(res.statusCode, 401);

    const { rows } = await pool.query('SELECT revoke_reason FROM sessions WHERE user_id = $1', [userId]);
    assert.ok(rows.some((row) => row.revoke_reason === 'expired'));
  });

  await t.test('suspending the reseller revokes its sessions', async () => {
    const resellerEmail = `authit-${suffix}-res@example.test`;
    const reseller = await pool.query(
      "INSERT INTO resellers (name, status) VALUES ($1, 'active') RETURNING id",
      [`authit-${suffix}-res`],
    );
    await pool.query(
      "INSERT INTO users (email, password_hash, role, reseller_id) VALUES ($1, $2, 'reseller', $3)",
      [resellerEmail, hashPassword(password, FAST), reseller.rows[0].id],
    );

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: resellerEmail, password } });
    assert.equal(login.statusCode, 200);
    const cookie = cookieFrom(login);

    await pool.query("UPDATE resellers SET status = 'suspended' WHERE id = $1", [reseller.rows[0].id]);

    const res = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    assert.equal(res.statusCode, 401);

    const loginAgain = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: resellerEmail, password } });
    assert.equal(loginAgain.statusCode, 403);
  });
});
