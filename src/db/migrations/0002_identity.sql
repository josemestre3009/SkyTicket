-- Identity: users, server-side sessions, TOTP second factors and recovery codes.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','reseller')),
  reseller_id uuid REFERENCES resellers(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  totp_secret_encrypted text,
  totp_enabled boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'reseller' OR reseller_id IS NOT NULL),
  CHECK (role <> 'admin' OR reseller_id IS NULL)
);

CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
CREATE INDEX idx_users_reseller ON users (reseller_id);

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  reseller_id uuid REFERENCES resellers(id),
  role text NOT NULL CHECK (role IN ('admin','reseller')),
  ip inet,
  user_agent text,
  second_factor_verified boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_token_hash_uniq ON sessions (token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE second_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TRIGGER trg_second_factors_updated
  BEFORE UPDATE ON second_factors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recovery_codes_user ON recovery_codes (user_id);
