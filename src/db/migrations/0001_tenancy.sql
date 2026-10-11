-- Tenancy: resellers, Ruijie connections, sites and reseller<->site assignments.

CREATE TABLE resellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','restricted','closed')),
  currency text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  low_balance_threshold_minor bigint NOT NULL DEFAULT 0 CHECK (low_balance_threshold_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_resellers_updated
  BEFORE UPDATE ON resellers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ruijie_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region text NOT NULL,
  base_url text NOT NULL,
  app_id text NOT NULL,
  app_secret_encrypted text NOT NULL,
  api_token_encrypted text,
  access_token_encrypted text,
  token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  circuit_state text NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed','open')),
  circuit_opened_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  lock_token uuid,
  lock_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region, base_url, app_id)
);

CREATE TRIGGER trg_ruijie_connections_updated
  BEFORE UPDATE ON ruijie_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruijie_connection_id uuid NOT NULL REFERENCES ruijie_connections(id),
  ruijie_group_id text NOT NULL,
  ruijie_tenant_id text,
  name text NOT NULL,
  timezone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  raw_json jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ruijie_connection_id, ruijie_group_id)
);

CREATE TRIGGER trg_sites_updated
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reseller_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  site_id uuid NOT NULL REFERENCES sites(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reseller_id, site_id)
);

CREATE TRIGGER trg_reseller_sites_updated
  BEFORE UPDATE ON reseller_sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_reseller_sites_site ON reseller_sites (site_id);
