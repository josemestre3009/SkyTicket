import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { bootstrapAdmin } from '../../src/modules/identity/bootstrap.js';
import { createAuth } from '../../src/auth/plugin.js';
import { authErrorHandler } from '../../src/auth/plugin.js';

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
    await client.query("SET session_replication_role = 'origin'");
  } finally {
    client.release();
  }
}

test('auth CSRF protection', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `authit-${suffix}@example.test`;
  const password = 'csrf-password';

  await bootstrapAdmin({ email, password, runner: pool, cipher: Cipher.fromKey(KEY), passwordParams: FAST });
  const auth = createAuth({ runner: pool, cipher: Cipher.fromKey(KEY), passwordParams: FAST });
  const app = Fastify();
  await app.register(auth.plugin, { prefix: '/auth' });
  app.setErrorHandler(authErrorHandler);
  await app.ready();

  t.after(async () => {
    await app.close();
    await cleanup(pool, suffix);
    await close();
  });

  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  const cookie = cookieFrom(login);
  const csrf = login.json().csrfToken;

  await t.test('safe reads do not require a CSRF token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    assert.equal(res.statusCode, 200);
  });

  await t.test('mutations without a CSRF token are rejected', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'csrf_missing');
  });

  await t.test('mutations with a wrong CSRF token are rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': `${csrf}-wrong` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'csrf_invalid');
  });

  await t.test('mutations with the session CSRF token succeed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    assert.equal(res.statusCode, 200);
  });
});
