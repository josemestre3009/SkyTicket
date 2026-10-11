import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { bootstrapAdmin } from '../../src/modules/identity/bootstrap.js';
import { createAuth } from '../../src/auth/plugin.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const KEY = '0'.repeat(64);

function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find((c) => c && c.startsWith('skyticket_sid='))?.split(';')[0];
}

async function cleanup(pool, suffix) {
  const pattern = `%authit-${suffix}%`;
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(
      `DELETE FROM auth_rate_limits WHERE bucket_key LIKE $1
         OR bucket_key IN (SELECT 'user:'||id::text FROM users WHERE email LIKE $2)`,
      [pattern, `authit-${suffix}%`],
    );
    await client.query('DELETE FROM audit_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`authit-${suffix}%`]);
    await client.query('DELETE FROM users WHERE email LIKE $1', [`authit-${suffix}%`]);
    await client.query('DELETE FROM resellers WHERE name LIKE $1', [`authit-${suffix}%`]);
    await client.query("SET session_replication_role = 'origin'");
  } finally {
    client.release();
  }
}

test('auth login', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `authit-${suffix}@example.test`;
  const password = 'correct-horse-battery';

  await bootstrapAdmin({
    email,
    password,
    runner: pool,
    cipher: Cipher.fromKey(KEY),
    passwordParams: { N: 1024, r: 8, p: 1 },
  });

  const auth = createAuth({
    runner: pool,
    cipher: Cipher.fromKey(KEY),
    passwordParams: { N: 1024, r: 8, p: 1 },
  });
  const app = Fastify();
  await app.register(auth.plugin, { prefix: '/auth' });
  await app.ready();

  t.after(async () => {
    await app.close();
    await cleanup(pool, suffix);
    await close();
  });

  await t.test('valid credentials create a secure revocable session', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.user.email, email);
    assert.equal(body.user.role, 'admin');
    assert.equal(body.requires2fa, undefined);
    assert.ok(body.csrfToken);

    const setCookie = res.headers['set-cookie'].toString();
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const me = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: cookieFrom(res) } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, email);
  });

  await t.test('invalid credentials are rejected without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'invalid_credentials');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  await t.test('missing fields are rejected', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email } });
    assert.equal(res.statusCode, 401);
  });
});
