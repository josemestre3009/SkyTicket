-- Audit: append-only event trail for sensitive operations.

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  actor_role text,
  reseller_id uuid REFERENCES resellers(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  reason text,
  ip inet,
  session_id uuid,
  correlation_id uuid,
  result text NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied','failure')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX idx_audit_events_reseller ON audit_events (reseller_id, created_at);
CREATE INDEX idx_audit_events_action ON audit_events (action, created_at);
CREATE INDEX idx_audit_events_actor ON audit_events (actor_user_id, created_at);

CREATE TRIGGER trg_audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
