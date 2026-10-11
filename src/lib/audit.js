import { getPool, withTransaction } from '../db/index.js';
import { redact } from './redact.js';

/**
 * Mandatory audited events (see specs/audit-security and Doc section 15.4).
 * Kept as constants so services reference a single source of truth.
 */
export const AUDIT_ACTIONS = Object.freeze({
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_ADMIN_BOOTSTRAP: 'auth.admin.bootstrap',
  AUTH_CROSS_TENANT_DENIED: 'auth.cross_tenant.denied',
  WALLET_RECHARGE: 'wallet.recharge',
  WALLET_ADJUSTMENT: 'wallet.adjustment',
  WALLET_REVERSAL: 'wallet.reversal',
  PRICE_CHANGE: 'price.change',
  PERMISSION_CHANGE: 'permission.change',
  SITE_ASSIGNMENT: 'site.assignment',
  RESELLER_CREATE: 'reseller.create',
  RESELLER_USER_CREATE: 'reseller.user.create',
  RESELLER_DELETE: 'reseller.delete',
  RESELLER_SUSPENSION: 'reseller.suspension',
  ORDER_ISSUE: 'order.issue',
  ORDER_RESOLUTION: 'order.resolution',
  VOUCHER_REVEAL: 'voucher.reveal',
  VOUCHER_EXPORT: 'voucher.export',
  RECONCILIATION_RESOLVE: 'reconciliation.resolve',
});

const REQUIRED_FIELDS = ['action', 'entityType'];

/**
 * Append-only audit write. Pass an existing transaction `client` when the
 * audited change must commit atomically with its business transaction.
 */
export async function recordAudit(entry, client) {
  for (const field of REQUIRED_FIELDS) {
    if (!entry?.[field]) {
      throw new Error(`audit entry requires "${field}"`);
    }
  }

  const runner = client || getPool();
  const values = [
    entry.actorUserId ?? null,
    entry.actorRole ?? null,
    entry.resellerId ?? null,
    entry.action,
    entry.entityType,
    entry.entityId != null ? String(entry.entityId) : null,
    entry.before != null ? redact(entry.before) : null,
    entry.after != null ? redact(entry.after) : null,
    entry.reason ?? null,
    entry.ip ?? null,
    entry.sessionId ?? null,
    entry.correlationId ?? null,
    entry.result ?? 'success',
  ];

  const { rows } = await runner.query(
    `INSERT INTO audit_events (
       actor_user_id, actor_role, reseller_id, action, entity_type, entity_id,
       before_data, after_data, reason, ip, session_id, correlation_id, result
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, created_at`,
    values,
  );
  return rows[0];
}

export async function recordAuditTx(entry) {
  return withTransaction((client) => recordAudit(entry, client));
}

/**
 * Read-only, admin-facing view of the audit trail. Never selects secrets that
 * were not already redacted at write time (`before_data`/`after_data`).
 */
export async function listAuditEvents({ action = null, entityType = null, limit = 200 } = {}, client) {
  const runner = client || getPool();
  const { rows } = await runner.query(
    `SELECT id, actor_user_id, actor_role, reseller_id, action, entity_type, entity_id,
            before_data, after_data, reason, ip, correlation_id, result, created_at
     FROM audit_events
     WHERE ($1::text IS NULL OR action = $1)
       AND ($2::text IS NULL OR entity_type = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [action, entityType, limit],
  );
  return rows;
}
