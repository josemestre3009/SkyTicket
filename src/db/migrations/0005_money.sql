-- Money: prepaid wallets, append-only ledger and holds.

CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL UNIQUE REFERENCES resellers(id),
  currency text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  low_balance_threshold_minor bigint NOT NULL DEFAULT 0 CHECK (low_balance_threshold_minor >= 0),
  integrity_blocked boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_wallets_updated
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  entry_type text NOT NULL CHECK (entry_type IN (
    'recharge','adjustment_credit','adjustment_debit','reserve','capture','release','reversal'
  )),
  currency text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  available_delta bigint NOT NULL DEFAULT 0,
  reserved_delta bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  reference text,
  reason text,
  actor_id uuid REFERENCES users(id),
  effective_at timestamptz NOT NULL DEFAULT now(),
  reversal_of_id uuid REFERENCES ledger_entries(id),
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ledger_entries_idempotency_uniq ON ledger_entries (idempotency_key);
-- A given entry can be reversed at most once.
CREATE UNIQUE INDEX ledger_entries_reversal_uniq ON ledger_entries (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE INDEX idx_ledger_entries_wallet ON ledger_entries (wallet_id, created_at);
CREATE INDEX idx_ledger_entries_reseller ON ledger_entries (reseller_id, created_at);

CREATE TRIGGER trg_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE TABLE holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  order_id uuid,
  currency text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','captured','released','expired')),
  reserve_key text NOT NULL,
  capture_key text,
  release_key text,
  captured_at timestamptz,
  released_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'captured' OR captured_at IS NOT NULL),
  CHECK (status <> 'released' OR released_at IS NOT NULL)
);

CREATE UNIQUE INDEX holds_reserve_key_uniq ON holds (reserve_key);
CREATE UNIQUE INDEX holds_capture_key_uniq ON holds (capture_key) WHERE capture_key IS NOT NULL;
CREATE UNIQUE INDEX holds_release_key_uniq ON holds (release_key) WHERE release_key IS NOT NULL;
CREATE INDEX idx_holds_order ON holds (order_id);
CREATE INDEX idx_holds_expiry ON holds (status, expires_at);

CREATE TRIGGER trg_holds_updated
  BEFORE UPDATE ON holds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
