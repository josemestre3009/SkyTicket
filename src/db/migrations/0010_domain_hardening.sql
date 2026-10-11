-- Domain hardening for reseller panel: partial hold settlement, ledger evidence
-- and reconciliation/pricing determinism guards. Additive only (expand/contract).

-- Holds keep amount_minor as the reserved total; capture/release may be partial.
ALTER TABLE holds
  ADD COLUMN IF NOT EXISTS captured_minor bigint NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  ADD COLUMN IF NOT EXISTS released_minor bigint NOT NULL DEFAULT 0 CHECK (released_minor >= 0);

ALTER TABLE holds
  ADD CONSTRAINT holds_settlement_within_amount
  CHECK (captured_minor + released_minor <= amount_minor);

-- Administrative evidence (receipt/reference metadata) for recharges and adjustments.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS evidence jsonb;

-- At most one open reconciliation case per (type, wallet); resolved history stays.
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_cases_open_wallet_uniq
  ON reconciliation_cases (case_type, wallet_id)
  WHERE status <> 'resolved' AND wallet_id IS NOT NULL;

-- At most one open-ended price version per rule so a winning rule is deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS price_versions_open_uniq
  ON price_versions (price_rule_id)
  WHERE effective_to IS NULL;
