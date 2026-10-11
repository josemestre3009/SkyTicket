-- Sales: orders, order event trail and issued vouchers.

CREATE TABLE voucher_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  package_id uuid NOT NULL REFERENCES packages(id),
  created_by uuid REFERENCES users(id),
  client_reference text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  currency text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  price_rule_id uuid REFERENCES price_rules(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','reserved','issuing','issued','partially_issued','needs_reconciliation','failed','canceled'
  )),
  hold_id uuid,
  issued_quantity integer NOT NULL DEFAULT 0 CHECK (issued_quantity >= 0),
  local_reference text NOT NULL,
  request_fingerprint text,
  correlation_id uuid,
  ruijie_raw_response jsonb,
  failure_reason text,
  reserved_at timestamptz,
  issuing_at timestamptz,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Order must reference a site actually assigned to its reseller (tenant isolation).
  CONSTRAINT voucher_orders_reseller_site_fk
    FOREIGN KEY (reseller_id, site_id) REFERENCES reseller_sites (reseller_id, site_id),
  -- Package must belong to the ordered site.
  CONSTRAINT voucher_orders_site_package_fk
    FOREIGN KEY (package_id, site_id) REFERENCES packages (id, site_id)
);

CREATE UNIQUE INDEX voucher_orders_local_reference_uniq ON voucher_orders (reseller_id, local_reference);
CREATE INDEX idx_voucher_orders_reseller_status ON voucher_orders (reseller_id, status);
CREATE INDEX idx_voucher_orders_status_updated ON voucher_orders (status, updated_at);

CREATE TRIGGER trg_voucher_orders_updated
  BEFORE UPDATE ON voucher_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE holds ADD CONSTRAINT holds_order_fk FOREIGN KEY (order_id) REFERENCES voucher_orders(id);
ALTER TABLE voucher_orders ADD CONSTRAINT voucher_orders_hold_fk FOREIGN KEY (hold_id) REFERENCES holds(id);

CREATE TABLE order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES voucher_orders(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  event_type text NOT NULL,
  actor_id uuid REFERENCES users(id),
  idempotency_key text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_events_order ON order_events (order_id, created_at);
CREATE UNIQUE INDEX order_events_idempotency_uniq ON order_events (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES voucher_orders(id),
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  ruijie_uuid text NOT NULL,
  code_encrypted text NOT NULL,
  code_masked text NOT NULL,
  code_fingerprint text,
  alias text,
  raw_status text,
  normalized_status text NOT NULL DEFAULT 'issued' CHECK (normalized_status IN (
    'issued','unused','in_use','expired','delivered','orphan','unknown'
  )),
  raw_json jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vouchers_ruijie_uuid_uniq ON vouchers (ruijie_uuid);
CREATE UNIQUE INDEX vouchers_code_fingerprint_uniq ON vouchers (code_fingerprint) WHERE code_fingerprint IS NOT NULL;
CREATE INDEX idx_vouchers_order ON vouchers (order_id);
CREATE INDEX idx_vouchers_reseller ON vouchers (reseller_id, created_at);

CREATE TRIGGER trg_vouchers_updated
  BEFORE UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
