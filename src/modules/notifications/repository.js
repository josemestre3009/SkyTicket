import { getPool } from '../../db/index.js';

function db(runner) {
  return runner || getPool();
}

export async function findRecipientUsers({ recipientType, resellerId = null }, runner) {
  if (recipientType === 'admin') {
    const { rows } = await db(runner).query(
      "SELECT id, email, role, reseller_id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at",
    );
    return rows;
  }
  if (recipientType === 'reseller') {
    if (!resellerId) throw new Error('resellerId is required for reseller notifications');
    const { rows } = await db(runner).query(
      `SELECT id, email, role, reseller_id FROM users
       WHERE role = 'reseller' AND status = 'active' AND reseller_id = $1
       ORDER BY created_at`,
      [resellerId],
    );
    return rows;
  }
  throw new Error(`unknown recipient type ${recipientType}`);
}

export async function insertNotification(
  {
    type,
    severity = 'info',
    channel,
    recipientUserId,
    recipientResellerId = null,
    resourceType = null,
    resourceId = null,
    title,
    body = null,
    dedupeKey,
  },
  runner,
) {
  try {
    const { rows } = await db(runner).query(
      `INSERT INTO notifications
         (type, severity, channel, recipient_user_id, recipient_reseller_id,
          resource_type, resource_id, title, body, dedupe_key)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
       WHERE EXISTS (SELECT 1 FROM users WHERE id = $4)
       ON CONFLICT (recipient_user_id, channel, dedupe_key) DO NOTHING
       RETURNING *`,
      [
        type,
        severity,
        channel,
        recipientUserId,
        recipientResellerId,
        resourceType,
        resourceId,
        title,
        body,
        dedupeKey,
      ],
    );
    return rows[0] ?? null;
  } catch (err) {
    // The recipient was deleted concurrently; a notification for a vanished
    // user is simply skipped rather than failing the whole emit.
    if (err.code === '23503') return null;
    throw err;
  }
}

export async function insertEmailDelivery({ notificationId, recipientEmail, subject }, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO email_deliveries (notification_id, recipient_email, subject)
     SELECT $1,$2,$3
     WHERE EXISTS (SELECT 1 FROM notifications WHERE id = $1)
     ON CONFLICT (notification_id) DO NOTHING
     RETURNING *`,
    [notificationId, recipientEmail, subject],
  );
  return rows[0] ?? null;
}

export async function listForUser(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM notifications
     WHERE recipient_user_id = $1
       AND ($2::boolean IS FALSE OR read_at IS NULL)
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, unreadOnly, limit, offset],
  );
  return rows;
}

export async function countUnread(userId, runner) {
  const { rows } = await db(runner).query(
    'SELECT count(*)::int AS count FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return rows[0].count;
}

/**
 * Idempotent and tenant-safe: the WHERE clause binds the row to the caller, so
 * a foreign notification can never be marked read and the caller's own row is
 * only ever touched (COALESCE preserves the first read timestamp).
 */
export async function markRead({ notificationId, userId }, runner) {
  const { rows } = await db(runner).query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND recipient_user_id = $2
     RETURNING *`,
    [notificationId, userId],
  );
  return rows[0] ?? null;
}

export async function findEmailDeliveryById(id, runner) {
  const { rows } = await db(runner).query(
    `SELECT d.*, n.type AS notification_type, n.title, n.body, n.resource_type, n.resource_id
     FROM email_deliveries d
     JOIN notifications n ON n.id = d.notification_id
     WHERE d.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function markDeliverySent(id, runner) {
  const { rows } = await db(runner).query(
    `UPDATE email_deliveries
     SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function recordDeliveryFailure(id, lastError, runner) {
  const { rows } = await db(runner).query(
    `UPDATE email_deliveries
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'failed' END,
         last_error = $2
     WHERE id = $1
     RETURNING *`,
    [id, lastError ? String(lastError).slice(0, 2000) : null],
  );
  return rows[0] ?? null;
}

export async function findResourceOwner({ resourceType, resourceId }, runner) {
  if (resourceType === 'voucher_order') {
    const { rows } = await db(runner).query('SELECT reseller_id FROM voucher_orders WHERE id = $1', [resourceId]);
    return rows[0] ?? null;
  }
  return null;
}
