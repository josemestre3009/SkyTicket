import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { bootstrapAdmin } from '../../src/modules/identity/bootstrap.js';
import { runBootstrap } from '../../src/cli/bootstrap-admin.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const KEY = '0'.repeat(64);
const deps = (pool) => ({ runner: pool, cipher: Cipher.fromKey(KEY), passwordParams: { N: 1024, r: 8, p: 1 } });

async function cleanup(pool, suffix) {
  const pattern = `authit-${suffix}%`;
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query('DELETE FROM audit_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)', [pattern]);
    await client.query('DELETE FROM users WHERE email LIKE $1', [pattern]);
    await client.query('DELETE FROM resellers WHERE name LIKE $1', [pattern]);
    await client.query("SET session_replication_role = 'origin'");
  } finally {
    client.release();
  }
}

test('admin bootstrap', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `authit-${suffix}@example.test`;

  t.after(async () => {
    await cleanup(pool, suffix);
    await close();
  });

  await t.test('creates the admin once and reports repeats without duplicating', async () => {
    const first = await bootstrapAdmin({ email, password: 'first-pass', ...deps(pool) });
    assert.equal(first.created, true);
    assert.equal(first.user.role, 'admin');

    const second = await bootstrapAdmin({ email, password: 'different-pass', ...deps(pool) });
    assert.equal(second.created, false);
    assert.equal(second.user.id, first.user.id);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    assert.equal(rows[0].n, 1);

    const { rows: hash } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [first.user.id]);
    assert.equal(hash[0].password_hash, first.user.password_hash);
  });

  await t.test('CLI honors an injected password and stays idempotent', async () => {
    const lines = [];
    const result = await runBootstrap({ email, password: 'cli-pass', log: (line) => lines.push(line), ...deps(pool) });
    assert.equal(result.created, false);
    assert.match(lines[0], /already exists/);
  });

  await t.test('rejects an email already used by a non-admin user', async () => {
    const resellerEmail = `authit-${suffix}-r@example.test`;
    const reseller = await pool.query(
      "INSERT INTO resellers (name, status) VALUES ($1, 'active') RETURNING id",
      [`authit-${suffix}-r`],
    );
    await pool.query(
      "INSERT INTO users (email, password_hash, role, reseller_id) VALUES ($1, 'hash', 'reseller', $2)",
      [resellerEmail, reseller.rows[0].id],
    );
    await assert.rejects(
      () => bootstrapAdmin({ email: resellerEmail, password: 'x', ...deps(pool) }),
      /non-admin/,
    );
  });
});
