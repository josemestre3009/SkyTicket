-- Auth hardening: session rotation/CSRF, TOTP replay guard and persisted rate limits.

ALTER TABLE sessions ADD COLUMN csrf_hash text;
ALTER TABLE sessions ADD COLUMN rotated_at timestamptz;
ALTER TABLE sessions ADD COLUMN revoke_reason text;
CREATE INDEX idx_sessions_expires ON sessions (expires_at) WHERE revoked_at IS NULL;

ALTER TABLE second_factors ADD COLUMN last_used_timestep bigint;
ALTER TABLE second_factors ADD COLUMN recovery_generated_at timestamptz;

-- Persisted fixed-window rate limiter for login, 2FA, reveal and issue.
CREATE TABLE auth_rate_limits (
  id bigserial PRIMARY KEY,
  scope text NOT NULL,
  bucket_key text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, bucket_key)
);
