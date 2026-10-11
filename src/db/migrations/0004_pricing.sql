-- Pricing: scoped rules (base/site/reseller/reseller+site) and versioned amounts.

CREATE TABLE price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES packages(id),
  scope text NOT NULL CHECK (scope IN ('base','site','reseller','reseller_site')),
  reseller_id uuid REFERENCES resellers(id),
  site_id uuid REFERENCES sites(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'base' AND reseller_id IS NULL AND site_id IS NULL) OR
    (scope = 'site' AND reseller_id IS NULL AND site_id IS NOT NULL) OR
    (scope = 'reseller' AND reseller_id IS NOT NULL AND site_id IS NULL) OR
    (scope = 'reseller_site' AND reseller_id IS NOT NULL AND site_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX price_rules_base_uniq ON price_rules (package_id) WHERE scope = 'base';
CREATE UNIQUE INDEX price_rules_site_uniq ON price_rules (package_id, site_id) WHERE scope = 'site';
CREATE UNIQUE INDEX price_rules_reseller_uniq ON price_rules (package_id, reseller_id) WHERE scope = 'reseller';
CREATE UNIQUE INDEX price_rules_reseller_site_uniq ON price_rules (package_id, reseller_id, site_id) WHERE scope = 'reseller_site';

CREATE TRIGGER trg_price_rules_updated
  BEFORE UPDATE ON price_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_rule_id uuid NOT NULL REFERENCES price_rules(id),
  currency text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Reject overlapping validity windows for the same rule.
ALTER TABLE price_versions ADD CONSTRAINT price_versions_no_overlap
  EXCLUDE USING gist (price_rule_id WITH =, tstzrange(effective_from, effective_to) WITH &&);

CREATE INDEX idx_price_versions_rule ON price_versions (price_rule_id);
