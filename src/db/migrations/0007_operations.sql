-- Operations: sync cursors, PostgreSQL job queue, reconciliation and notifications.

CREATE TABLE sync_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruijie_connection_id uuid NOT NULL REFERENCES ruijie_connections(id),
  site_id uuid REFERENCES sites(id),
  resource text NOT NULL CHECK (resource IN ('networks','packages','vouchers')),
  cursor text,
  last_offset integer,
  last_count integer,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ruijie_connection_id, site_id, resource)
);

CREATE TRIGGER trg_sync_cursors_updated
  BEFORE UPDATE ON sync_cursors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','dead')),
  priority integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  result jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_claimable ON jobs (status, run_after) WHERE status = 'pending';
CREATE INDEX idx_jobs_running_lease ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX idx_jobs_type ON jobs (job_type);
CREATE INDEX idx_jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

CREATE TRIGGER trg_jobs_updated
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type text NOT NULL CHECK (case_type IN (
    'voucher_local_only','voucher_ruijie_only','voucher_mismatch',
    'order_stuck','wallet_projection_mismatch','partial_issue'
  )),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved')),
  reseller_id uuid REFERENCES resellers(id),
  site_id uuid REFERENCES sites(id),
  order_id uuid REFERENCES voucher_orders(id),
  voucher_id uuid REFERENCES vouchers(id),
  wallet_id uuid REFERENCES wallets(id),
  summary text NOT NULL,
  local_evidence jsonb,
  ruijie_evidence jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reconciliation_cases_status ON reconciliation_cases (status, severity, created_at);
CREATE INDEX idx_reconciliation_cases_order ON reconciliation_cases (order_id);

CREATE TRIGGER trg_reconciliation_cases_updated
  BEFORE UPDATE ON reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  channel text NOT NULL CHECK (channel IN ('panel','email')),
  recipient_user_id uuid REFERENCES users(id),
  recipient_reseller_id uuid REFERENCES resellers(id),
  resource_type text,
  resource_id uuid,
  title text NOT NULL,
  body text,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notifications_recipient_dedupe_uniq ON notifications (recipient_user_id, dedupe_key);
CREATE INDEX idx_notifications_unread ON notifications (recipient_user_id, read_at, created_at);

CREATE TABLE email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid REFERENCES notifications(id),
  recipient_email text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_deliveries_pending ON email_deliveries (status, scheduled_at) WHERE status = 'pending';

CREATE TRIGGER trg_email_deliveries_updated
  BEFORE UPDATE ON email_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
