import { getPool } from '../db/index.js';
import { TooManyRequestsError } from './errors.js';

export const AUTH_RATE_LIMITS = Object.freeze({
  login: { scope: 'login', limit: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  reveal: { scope: 'reveal', limit: 20, windowMs: 60_000, blockMs: 5 * 60_000 },
  issue: { scope: 'issue', limit: 30, windowMs: 60_000, blockMs: 5 * 60_000 },
});

/**
 * Fixed-window limiter persisted in PostgreSQL. Single upsert keeps it
 * concurrency-safe without an explicit lock.
 */
export async function rateLimitHit({ scope, key, limit, windowMs, blockMs }, runner) {
  const db = runner || getPool();
  const { rows } = await db.query(
    `INSERT INTO auth_rate_limits (scope, bucket_key, window_started_at, attempts, blocked_until, updated_at)
     VALUES ($1, $2, now(), 1, NULL, now())
     ON CONFLICT (scope, bucket_key) DO UPDATE SET
       attempts = CASE
         WHEN auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until > now() THEN auth_rate_limits.attempts
         WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3::double precision / 1000.0)
           OR (auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until <= now()) THEN 1
         ELSE auth_rate_limits.attempts + 1
       END,
       window_started_at = CASE
         WHEN auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until > now() THEN auth_rate_limits.window_started_at
         WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3::double precision / 1000.0)
           OR (auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until <= now()) THEN now()
         ELSE auth_rate_limits.window_started_at
       END,
       blocked_until = CASE
         WHEN auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until > now() THEN auth_rate_limits.blocked_until
         WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3::double precision / 1000.0)
           OR (auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until <= now()) THEN NULL
         WHEN auth_rate_limits.attempts + 1 > $4 THEN now() + make_interval(secs => $5::double precision / 1000.0)
         ELSE NULL
       END,
       updated_at = now()
     RETURNING attempts, window_started_at, blocked_until`,
    [scope, key, windowMs, limit, blockMs],
  );

  const row = rows[0];
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until) : null;
  const allowed = !blockedUntil || blockedUntil.getTime() <= Date.now();
  const retryAfterMs = allowed ? 0 : blockedUntil.getTime() - Date.now();

  return {
    allowed,
    attempts: row.attempts,
    remaining: Math.max(0, limit - row.attempts),
    blockedUntil,
    retryAfterSec: retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0,
  };
}

export async function rateLimitClear({ scope, key }, runner) {
  const db = runner || getPool();
  await db.query('DELETE FROM auth_rate_limits WHERE scope = $1 AND bucket_key = $2', [scope, key]);
}

/**
 * Enforce a named scope and throw a 429 while blocked. Used by login now;
 * reveal and issue endpoints call `assertRateLimit('reveal' | 'issue', key)`.
 */
export async function assertRateLimit(name, key, runner, overrides) {
  const preset = AUTH_RATE_LIMITS[name];
  if (!preset) throw new Error(`Unknown auth rate limit scope: ${name}`);
  const cfg = { ...preset, ...overrides, key };
  const rl = await rateLimitHit(cfg, runner);
  if (!rl.allowed) throw new TooManyRequestsError(`Too many ${preset.scope} attempts`, rl.retryAfterSec);
  return rl;
}
