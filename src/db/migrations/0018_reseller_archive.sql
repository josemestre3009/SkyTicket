-- Safe reseller deletion: hide the tenant while preserving financial history.
ALTER TABLE resellers
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_resellers_live
  ON resellers (created_at DESC)
  WHERE archived_at IS NULL;
