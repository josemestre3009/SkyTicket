-- Catalog: Ruijie packages synced read-only and per-reseller authorization.

CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  ruijie_user_group_id text NOT NULL,
  ruijie_profile_id text NOT NULL,
  name text NOT NULL,
  duration integer,
  quota bigint,
  up_speed bigint,
  down_speed bigint,
  concurrent_clients integer,
  bind_mac boolean,
  technical_limits_json jsonb,
  raw_json jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, ruijie_user_group_id)
);

-- Enables composite FK from voucher_orders to guarantee package belongs to site.
ALTER TABLE packages ADD CONSTRAINT packages_id_site_uniq UNIQUE (id, site_id);

CREATE TRIGGER trg_packages_updated
  BEFORE UPDATE ON packages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reseller_package_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  package_id uuid NOT NULL REFERENCES packages(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reseller_id, package_id)
);

CREATE TRIGGER trg_reseller_package_permissions_updated
  BEFORE UPDATE ON reseller_package_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_reseller_package_permissions_package ON reseller_package_permissions (package_id);
