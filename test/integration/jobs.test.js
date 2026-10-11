import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import * as jobs from '../../src/jobs/repository.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('job queue', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const type = `test.jobs.${crypto.randomUUID()}`;

  t.after(async () => {
    await pool.query('DELETE FROM jobs WHERE job_type = $1', [type]);
    await close();
  });

  await t.test('claims a pending job exactly once', async () => {
    const job = await jobs.enqueue({ type, payload: { n: 1 } }, pool);
    const first = await jobs.claim({ workerId: 'w1', types: [type], leaseMs: 5000 }, pool);
    assert.equal(first.id, job.id);
    assert.equal(first.status, 'running');
    assert.equal(first.attempts, 1);
    const second = await jobs.claim({ workerId: 'w2', types: [type], leaseMs: 5000 }, pool);
    assert.equal(second, null);
  });

  await t.test('two workers never claim the same job', async () => {
    await jobs.enqueue({ type, payload: { n: 2 } }, pool);
    await jobs.enqueue({ type, payload: { n: 3 } }, pool);
    const [a, b] = await Promise.all([
      jobs.claim({ workerId: 'w1', types: [type], leaseMs: 5000 }, pool),
      jobs.claim({ workerId: 'w2', types: [type], leaseMs: 5000 }, pool),
    ]);
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a.id, b.id);
    await jobs.complete({ id: a.id, workerId: 'w1', result: { ok: true } }, pool);
    const done = await pool.query('SELECT status, result FROM jobs WHERE id = $1', [a.id]);
    assert.equal(done.rows[0].status, 'succeeded');
    assert.deepEqual(done.rows[0].result, { ok: true });
  });

  await t.test('recovers a job whose worker lease expired', async () => {
    const job = await jobs.enqueue({ type, payload: { n: 4 } }, pool);
    await jobs.claim({ workerId: 'dead-worker', types: [type], leaseMs: 5000 }, pool);
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [job.id]);
    const recovered = await jobs.recoverExpiredLeases(pool);
    assert.ok(recovered.includes(job.id));
    const reclaimed = await jobs.claim({ workerId: 'w3', types: [type], leaseMs: 5000 }, pool);
    assert.equal(reclaimed.id, job.id);
    assert.equal(reclaimed.attempts, 2);
  });

  await t.test('moves a job to dead after exhausting attempts', async () => {
    const job = await jobs.enqueue({ type, payload: { n: 5 }, maxAttempts: 2 }, pool);
    await jobs.claim({ workerId: 'w1', types: [type], leaseMs: 5000 }, pool);
    await jobs.fail({ id: job.id, workerId: 'w1', error: 'boom' }, pool);
    const afterFirst = await pool.query('SELECT status, attempts FROM jobs WHERE id = $1', [job.id]);
    assert.equal(afterFirst.rows[0].status, 'pending');

    await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [job.id]);
    await jobs.claim({ workerId: 'w1', types: [type], leaseMs: 5000 }, pool);
    await jobs.fail({ id: job.id, workerId: 'w1', error: 'boom again' }, pool);
    const afterSecond = await pool.query('SELECT status, attempts FROM jobs WHERE id = $1', [job.id]);
    assert.equal(afterSecond.rows[0].status, 'dead');
    assert.equal(afterSecond.rows[0].attempts, 2);
  });

  await t.test('deduplicates active jobs by key', async () => {
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const first = await jobs.enqueue({ type, payload: { n: 6 }, dedupeKey }, pool);
    const second = await jobs.enqueue({ type, payload: { n: 7 }, dedupeKey }, pool);
    assert.ok(first);
    assert.equal(second, null);
  });
});
