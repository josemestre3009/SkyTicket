import { getPool, withTransaction } from '../../db/index.js';

function db(runner) {
  return runner || getPool();
}

export async function transaction(runner, fn) {
  if (runner && typeof runner.connect === 'function') {
    const client = await runner.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  if (runner) return fn(runner);
  // No runner injected (production graph): borrow a dedicated client so the
  // BEGIN/COMMIT spans every statement instead of running on pooled clients.
  return withTransaction(fn);
}

export async function createReseller(
  { name, currency = 'COP', lowBalanceThresholdMinor = 0, status = 'pending' },
  runner,
) {
  const { rows } = await db(runner).query(
    `INSERT INTO resellers (name, currency, low_balance_threshold_minor, status)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, currency, lowBalanceThresholdMinor, status],
  );
  return rows[0];
}

export async function findResellerById(id, runner) {
  const { rows } = await db(runner).query('SELECT * FROM resellers WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Resolve the reseller that owns a login email. Projection only: never selects
 * password hashes or any other user secret. Email match is case-insensitive.
 */
export async function findResellerByUserEmail(email, runner) {
  const { rows } = await db(runner).query(
    `SELECT r.id, r.name, r.status, r.archived_at, u.email
     FROM users u
     JOIN resellers r ON r.id = u.reseller_id
     WHERE lower(u.email) = lower($1)
     ORDER BY u.created_at
     LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function listResellers({ status = null, limit = 100, offset = 0 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT r.*, u.email AS primary_email
     FROM resellers r
     LEFT JOIN LATERAL (
       SELECT email FROM users WHERE reseller_id = r.id ORDER BY created_at LIMIT 1
     ) u ON true
     WHERE ($1::text IS NULL OR r.status = $1)
       AND r.archived_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset],
  );
  return rows;
}

export async function archiveReseller(id, runner) {
  const { rows } = await db(runner).query(
    `UPDATE resellers
     SET status = 'closed', archived_at = now()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function updateResellerStatus(id, status, runner) {
  const { rows } = await db(runner).query(
    'UPDATE resellers SET status = $2 WHERE id = $1 RETURNING *',
    [id, status],
  );
  return rows[0] ?? null;
}

export async function createConnection(
  { region, baseUrl, appId, appSecretEncrypted, apiTokenEncrypted = null },
  runner,
) {
  const { rows } = await db(runner).query(
    `INSERT INTO ruijie_connections (region, base_url, app_id, app_secret_encrypted, api_token_encrypted)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (region, base_url, app_id) DO UPDATE
       SET app_secret_encrypted = EXCLUDED.app_secret_encrypted,
           api_token_encrypted = EXCLUDED.api_token_encrypted
     RETURNING *`,
    [region, baseUrl, appId, appSecretEncrypted, apiTokenEncrypted],
  );
  return rows[0];
}

export async function findConnectionById(id, runner) {
  const { rows } = await db(runner).query('SELECT * FROM ruijie_connections WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function upsertSite(
  { connectionId, ruijieGroupId, ruijieTenantId = null, name, timezone = null, rawJson = null },
  runner,
) {
  const { rows } = await db(runner).query(
    `INSERT INTO sites (ruijie_connection_id, ruijie_group_id, ruijie_tenant_id, name, timezone, raw_json, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (ruijie_connection_id, ruijie_group_id) DO UPDATE
       SET ruijie_tenant_id = EXCLUDED.ruijie_tenant_id,
           name = EXCLUDED.name,
           timezone = EXCLUDED.timezone,
           raw_json = EXCLUDED.raw_json,
           status = 'active',
           last_synced_at = now()
     RETURNING *`,
    [
      connectionId,
      String(ruijieGroupId),
      ruijieTenantId === null ? null : String(ruijieTenantId),
      name,
      timezone,
      rawJson ? JSON.stringify(rawJson) : null,
    ],
  );
  return rows[0];
}

export async function deactivateMissingSites(connectionId, seenGroupIds, runner) {
  const { rowCount } = await db(runner).query(
    `UPDATE sites SET status = 'disabled'
     WHERE ruijie_connection_id = $1 AND ruijie_group_id <> ALL($2::text[])`,
    [connectionId, seenGroupIds.map(String)],
  );
  return rowCount;
}

export async function findSiteById(id, runner) {
  const { rows } = await db(runner).query('SELECT * FROM sites WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findSiteContext(siteId, runner) {
  const { rows } = await db(runner).query(
    `SELECT s.*, c.region AS connection_region, c.base_url AS connection_base_url,
            c.status AS connection_status
     FROM sites s
     JOIN ruijie_connections c ON c.id = s.ruijie_connection_id
     WHERE s.id = $1`,
    [siteId],
  );
  return rows[0] ?? null;
}

export async function assignSite({ resellerId, siteId, status = 'active' }, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO reseller_sites (reseller_id, site_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (reseller_id, site_id) DO UPDATE SET status = EXCLUDED.status
     RETURNING *`,
    [resellerId, siteId, status],
  );
  return rows[0];
}

export async function unassignSite({ resellerId, siteId }, runner) {
  const { rows } = await db(runner).query(
    'DELETE FROM reseller_sites WHERE reseller_id = $1 AND site_id = $2 RETURNING id',
    [resellerId, siteId],
  );
  return rows[0] ?? null;
}

export async function findAssignment(resellerId, siteId, runner) {
  const { rows } = await db(runner).query(
    'SELECT * FROM reseller_sites WHERE reseller_id = $1 AND site_id = $2',
    [resellerId, siteId],
  );
  return rows[0] ?? null;
}

export async function listSites({ status = 'active', limit = 500 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM sites
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY name
     LIMIT $2`,
    [status, limit],
  );
  return rows;
}

export async function listResellerSites(resellerId, runner) {
  const { rows } = await db(runner).query(
    `SELECT s.*, rs.status AS assignment_status
     FROM reseller_sites rs
     JOIN sites s ON s.id = rs.site_id
     WHERE rs.reseller_id = $1
     ORDER BY s.name`,
    [resellerId],
  );
  return rows;
}

export async function listSiteResellers(siteId, runner) {
  const { rows } = await db(runner).query(
    `SELECT r.*, rs.status AS assignment_status
     FROM reseller_sites rs
     JOIN resellers r ON r.id = rs.reseller_id
     WHERE rs.site_id = $1
     ORDER BY r.name`,
    [siteId],
  );
  return rows;
}

export async function revokeResellerSessions(resellerId, reason, runner) {
  const { rows } = await db(runner).query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
     WHERE revoked_at IS NULL
       AND user_id IN (SELECT id FROM users WHERE reseller_id = $1)
     RETURNING id`,
    [resellerId, reason ?? null],
  );
  return rows.map((row) => row.id);
}

export async function countResellerUsers(resellerId, runner) {
  const { rows } = await db(runner).query(
    'SELECT count(*)::int AS count FROM users WHERE reseller_id = $1',
    [resellerId],
  );
  return rows[0].count;
}

/** Reseller-scoped user list for the admin detail view; never selects secrets. */
export async function listResellerUsers(resellerId, runner) {
  const { rows } = await db(runner).query(
    `SELECT id, email, role, status, must_change_password, last_login_at, created_at
     FROM users
     WHERE reseller_id = $1
     ORDER BY created_at`,
    [resellerId],
  );
  return rows;
}
