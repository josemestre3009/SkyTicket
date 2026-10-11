-- Security fixes: prepaid wallets must inherit the reseller's configured
-- low-balance threshold so the low-balance alert can fire. Newly created
-- wallets copy the threshold at insert time; this backfills existing rows.
-- Additive and idempotent.

UPDATE wallets w
SET low_balance_threshold_minor = r.low_balance_threshold_minor
FROM resellers r
WHERE r.id = w.reseller_id
  AND w.low_balance_threshold_minor = 0
  AND r.low_balance_threshold_minor <> 0;
