import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { bootstrapAdmin } from '../../src/modules/identity/bootstrap.js';
import { createAuth } from '../../src/auth/plugin.js';
import { AUTH_RATE_LIMITS } from '../../src/auth/rate-limit.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const KEY = '0'.repeat(64);
const FAST = { N: 1024, r: 8, p: 1 };

async function cleanup(pool, suffix) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query('DELETE FROM auth_rate_limits WHERE bucket_key LIKE $1', [`%authit-${suffix}%`]);
    await client.query('DELETE FROM audit_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`authit-${suffix}%`]);
    await client.query('DELETE FROM users WHERE email LIKE $1', [`authit-${suffix}%`]);
    await client.query("SET session_replication_role = 'origin'");
  } finally {
    client.release();
  }
}

test('auth login rate limit', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `authit-${suffix}@example.test`;
  const password = 'rate-limit-password';

  await bootstrapAdmin({ email, password, runner: pool, cipher: Cipher.fromKey(KEY), passwordParams: FAST });

  const auth = createAuth({
    runner: pool,
    cipher: Cipher.fromKey(KEY),
    passwordParams: FAST,
    rateLimits: {
      ...AUTH_RATE_LIMITS,
      login: { scope: 'login', limit: 3, windowMs: 60000, blockMs: 60000 },
    },
  });
  const app = Fastify();
  await app.register(auth.plugin, { prefix: '/auth' });
  await app.ready();

  t.after(async () => {
    await app.close();
    await cleanup(pool, suffix);
    await close();
  });

  await t.test('blocks brute force after the threshold and recovers after the window', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong' } });
      assert.equal(res.statusCode, 401);
    }

    const blocked = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong' } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);

    const stillBlocked = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    assert.equal(stillBlocked.statusCode, 429);

    await pool.query(
      "UPDATE auth_rate_limits SET blocked_until = now() - interval '1 second' WHERE scope = 'login' AND bucket_key = $1",
      [`email:${email}`],
    );

    const recovered = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    assert.equal(recovered.statusCode, 200);
  });
});
