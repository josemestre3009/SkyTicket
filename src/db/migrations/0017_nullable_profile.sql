-- Real Ruijie user groups may omit the auth profile, so the synced package
-- must be allowed to store NULL instead of being skipped or failing the insert.

ALTER TABLE packages ALTER COLUMN ruijie_profile_id DROP NOT NULL;
