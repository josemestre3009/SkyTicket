-- Ruijie adapter hardening: token last-use tracking and half-open circuit recovery.

ALTER TABLE ruijie_connections
  ADD COLUMN IF NOT EXISTS token_last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS circuit_half_open_at timestamptz;

ALTER TABLE ruijie_connections DROP CONSTRAINT IF EXISTS ruijie_connections_circuit_state_check;
ALTER TABLE ruijie_connections ADD CONSTRAINT ruijie_connections_circuit_state_check
  CHECK (circuit_state IN ('closed','open','half_open'));
