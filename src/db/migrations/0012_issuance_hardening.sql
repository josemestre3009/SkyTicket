-- Issuance hardening: dispatch intent tracking, reconciliation reason and
-- dedupe indexes for order/voucher/external reconciliation cases. Additive only.

ALTER TABLE voucher_orders
  ADD COLUMN IF NOT EXISTS create_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_reason text;

-- One open case per order for a given type (e.g. order_stuck).
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_cases_open_order_uniq
  ON reconciliation_cases (case_type, order_id)
  WHERE status <> 'resolved' AND order_id IS NOT NULL;

-- One open case per local voucher for a given type.
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_cases_open_voucher_uniq
  ON reconciliation_cases (case_type, voucher_id)
  WHERE status <> 'resolved' AND voucher_id IS NOT NULL;

-- One open external-voucher case per Ruijie UUID (no local attribution).
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_cases_open_external_uniq
  ON reconciliation_cases (case_type, (ruijie_evidence ->> 'uuid'))
  WHERE status <> 'resolved' AND voucher_id IS NULL AND (ruijie_evidence ->> 'uuid') IS NOT NULL;

-- Voucher reconciliation scans by site and status.
CREATE INDEX IF NOT EXISTS idx_vouchers_site_status ON vouchers (site_id, normalized_status);
