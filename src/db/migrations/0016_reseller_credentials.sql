-- Reseller credentials: track provisioned temporary-password state on users.
-- `must_change_password` is persisted so the flag survives even while the login
-- flow does not yet force a rotation (see service comment). Forward-only.

ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
