-- Notifications hardening: allow one row per channel while keeping
-- type+resource+window dedupe, and guarantee one email delivery per
-- notification so a job replay can never mint a second event. Additive only.

-- A single event fans out to panel and email rows for the same recipient with
-- the same dedupe_key, so channel must be part of the uniqueness scope.
DROP INDEX IF EXISTS notifications_recipient_dedupe_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_channel_dedupe_uniq
  ON notifications (recipient_user_id, channel, dedupe_key);

-- Exactly one delivery row per email notification; replay of the insert step
-- is a no-op and therefore cannot duplicate the outbound event.
CREATE UNIQUE INDEX IF NOT EXISTS email_deliveries_notification_uniq
  ON email_deliveries (notification_id);

-- Retry sweep for deliveries that still have attempts left.
CREATE INDEX IF NOT EXISTS idx_email_deliveries_retryable
  ON email_deliveries (status, scheduled_at)
  WHERE status = 'failed';

-- Notifications are derived artifacts: deleting a user, reseller or the parent
-- notification must take its rows with it so teardown never hits an FK wall.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_recipient_user_id_fkey;
ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_user_id_fkey
  FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_recipient_reseller_id_fkey;
ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_reseller_id_fkey
  FOREIGN KEY (recipient_reseller_id) REFERENCES resellers(id) ON DELETE CASCADE;

ALTER TABLE email_deliveries DROP CONSTRAINT IF EXISTS email_deliveries_notification_id_fkey;
ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_notification_id_fkey
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE;
