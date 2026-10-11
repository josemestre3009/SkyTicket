-- Remove 2FA/TOTP enforcement from the MVP.
-- Forward-only: neutralize existing sessions and users so no account is left
-- gated behind a second factor, and purge stale 2FA artifacts. Legacy tables
-- and columns (second_factors, recovery_codes, users.totp_*, sessions.second_factor_verified)
-- are intentionally NOT dropped so the migration stays reversible in shape.

UPDATE sessions SET second_factor_verified = true WHERE second_factor_verified = false;

UPDATE users
SET totp_enabled = false,
    totp_secret_encrypted = NULL
WHERE totp_enabled = true OR totp_secret_encrypted IS NOT NULL;

DELETE FROM second_factors;
DELETE FROM recovery_codes;
DELETE FROM auth_rate_limits WHERE scope = '2fa';
