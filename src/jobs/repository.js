import { getPool } from '../db/index.js';
import { config } from '../config.js';

export const JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  DEAD: 'dead',
});

export function backoffMs(attempt, { baseMs = config.jobs.backoffBaseMs, capMs = config.jobs.backoffCapMs, jitter = Math.random } = {}) {
  const safeAttempt = Math.max(1, attempt);
  const exponential = Math.min(capMs, baseMs * 2 ** (safeAttempt - 1));
  const factor = 0.5 + jitter();
  return Math.min(capMs, Math.round(exponential * factor));
}

export async function enqueue(
  { type, payload = {}, priority = 0, runAfter = null, maxAttempts = config.jobs.maxAttempts, dedupeKey = null },
  client,
) {
  const runner = client || getPool();
  const { rows } = await runner.query(
    `INSERT INTO jobs (job_type, payload, priority, run_after, max_attempts, dedupe_key)
     SELECT $1, $2::jsonb, $3, COALESCE($4::timestamptz, now()), $5, $6
     WHERE NOT (
       $6::text IS NOT NULL AND EXISTS (
         SELECT 1 FROM jobs WHERE dedupe_key = $6 AND status IN ('pending','running')
       )
     )
     RETURNING *`,
    [type, JSON.stringify(payload), priority, runAfter, maxAttempts, dedupeKey],
  );
  return rows[0] ?? null;
}

export async function claim({ workerId, types, leaseMs = config.jobs.leaseMs }, client) {
  if (!Array.isArray(types) || types.length === 0) return null;
  const runner = client || getPool();
  const { rows } = await runner.query(
    `WITH candidate AS (
       SELECT id FROM jobs
       WHERE status = 'pending'
         AND run_after <= now()
         AND job_type = ANY($3::text[])
       ORDER BY priority DESC, run_after ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE jobs SET
       status = 'running',
       locked_by = $1,
       locked_at = now(),
       lease_expires_at = now() + make_interval(secs => $2::double precision / 1000.0),
       attempts = attempts + 1,
       updated_at = now()
     FROM candidate
     WHERE jobs.id = candidate.id
     RETURNING jobs.*`,
    [workerId, leaseMs, types],
  );
  return rows[0] ?? null;
}

export async function complete({ id, workerId, result = null }, client) {
  const runner = client || getPool();
  const { rows } = await runner.query(
    `UPDATE jobs SET
       status = 'succeeded',
       result = $3::jsonb,
       last_error = NULL,
       locked_by = NULL,
       locked_at = NULL,
       lease_expires_at = NULL,
       updated_at = now()
     WHERE id = $1 AND locked_by = $2
     RETURNING *`,
    [id, workerId, result != null ? JSON.stringify(result) : null],
  );
  return rows[0] ?? null;
}

export async function fail({ id, workerId, error }, client) {
  const runner = client || getPool();
  const { rows: current } = await runner.query('SELECT attempts, max_attempts FROM jobs WHERE id = $1', [id]);
  const row = current[0];
  if (!row) return null;
  const willDie = row.attempts >= row.max_attempts;
  const delay = backoffMs(row.attempts);
  const { rows } = await runner.query(
    `UPDATE jobs SET
       status = CASE WHEN $3 THEN 'dead' ELSE 'pending' END,
       last_error = $4,
       run_after = CASE WHEN $3 THEN run_after ELSE now() + make_interval(secs => $5::double precision / 1000.0) END,
       locked_by = NULL,
       locked_at = NULL,
       lease_expires_at = NULL,
       updated_at = now()
     WHERE id = $1 AND locked_by = $2
     RETURNING *`,
    [id, workerId, willDie, error ? String(error).slice(0, 2000) : null, delay],
  );
  return rows[0] ?? null;
}

export async function heartbeat({ id, workerId, leaseMs = config.jobs.leaseMs }, client) {
  const runner = client || getPool();
  const { rows } = await runner.query(
    `UPDATE jobs SET
       lease_expires_at = now() + make_interval(secs => $3::double precision / 1000.0),
       updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'running'
     RETURNING *`,
    [id, workerId, leaseMs],
  );
  return rows[0] ?? null;
}

/**
 * Return jobs whose worker died (lease expired) to the pending pool.
 * Attempts were already incremented at claim time, so a poison job still
 * exhausts its budget instead of looping forever.
 */
export async function recoverExpiredLeases(client) {
  const runner = client || getPool();
  const { rows } = await runner.query(
    `UPDATE jobs SET
       status = 'pending',
       locked_by = NULL,
       locked_at = NULL,
       lease_expires_at = NULL,
       updated_at = now()
     WHERE status = 'running' AND lease_expires_at < now()
     RETURNING id`,
  );
  return rows.map((row) => row.id);
}
