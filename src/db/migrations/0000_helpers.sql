-- Shared helpers for the SkyTicket schema.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Reject UPDATE/DELETE on append-only tables (ledger, audit).
CREATE OR REPLACE FUNCTION prevent_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
