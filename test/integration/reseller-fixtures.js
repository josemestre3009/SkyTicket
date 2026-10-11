import crypto from 'node:crypto';

export function suffix() {
  return crypto.randomUUID().slice(0, 8);
}

export async function createReseller(pool, opts = {}) {
  const s = opts.suffix ?? suffix();
  const { rows } = await pool.query(
    "INSERT INTO resellers (name, status, low_balance_threshold_minor) VALUES ($1, $2, $3) RETURNING *",
    [opts.name ?? `Reseller ${s}`, opts.status ?? 'active', opts.lowBalanceThresholdMinor ?? 0],
  );
  return rows[0];
}

export async function createConnection(pool, opts = {}) {
  const s = opts.suffix ?? suffix();
  const { rows } = await pool.query(
    `INSERT INTO ruijie_connections (region, base_url, app_id, app_secret_encrypted)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [opts.region ?? 'eu', opts.baseUrl ?? 'https://example.test', `app-${s}`, 'v1.x.y.z.w'],
  );
  return rows[0];
}

export async function createSite(pool, connectionId, opts = {}) {
  const s = opts.suffix ?? suffix();
  const { rows } = await pool.query(
    `INSERT INTO sites (ruijie_connection_id, ruijie_group_id, ruijie_tenant_id, name, raw_json)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      connectionId,
      opts.ruijieGroupId ?? `group-${s}`,
      opts.ruijieTenantId ?? null,
      opts.name ?? `Site ${s}`,
      opts.rawJson ?? null,
    ],
  );
  return rows[0];
}

export async function assignSite(pool, resellerId, siteId, status = 'active') {
  const { rows } = await pool.query(
    `INSERT INTO reseller_sites (reseller_id, site_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (reseller_id, site_id) DO UPDATE SET status = EXCLUDED.status RETURNING *`,
    [resellerId, siteId, status],
  );
  return rows[0];
}

export async function createPackage(pool, siteId, opts = {}) {
  const s = opts.suffix ?? suffix();
  const { rows } = await pool.query(
    `INSERT INTO packages (site_id, ruijie_user_group_id, ruijie_profile_id, name, raw_json)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      siteId,
      opts.ruijieUserGroupId ?? `ug-${s}`,
      opts.ruijieProfileId ?? `profile-${s}`,
      opts.name ?? `Package ${s}`,
      opts.rawJson ?? null,
    ],
  );
  return rows[0];
}

export async function grantPackage(pool, resellerId, packageId, status = 'active') {
  const { rows } = await pool.query(
    `INSERT INTO reseller_package_permissions (reseller_id, package_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (reseller_id, package_id) DO UPDATE SET status = EXCLUDED.status RETURNING *`,
    [resellerId, packageId, status],
  );
  return rows[0];
}

export async function createWallet(pool, resellerId, { availableMinor = 0, reservedMinor = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO wallets (reseller_id, available_minor, reserved_minor) VALUES ($1, $2, $3) RETURNING *`,
    [resellerId, availableMinor, reservedMinor],
  );
  return rows[0];
}

export async function createUser(pool, { role, resellerId = null, email = null, status = 'active' } = {}) {
  const s = suffix();
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, reseller_id, status)
     VALUES ($1, 'hash', $2, $3, $4) RETURNING *`,
    [email ?? `${role}-${s}@example.test`, role, resellerId, status],
  );
  return rows[0];
}

export async function createSession(pool, user) {
  const { rows } = await pool.query(
    `INSERT INTO sessions (user_id, reseller_id, role, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING *`,
    [user.id, user.reseller_id ?? null, user.role, `token-${suffix()}`],
  );
  return rows[0];
}

export function authFor(user) {
  return { user: { id: user.id, role: user.role, reseller_id: user.reseller_id ?? null } };
}

/**
 * Remove every row created under a reseller, then its sites' catalog data via
 * `teardownConnection`. Append-only tables are bypassed with replication role.
 */
export async function teardownReseller(pool, resellerId) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query('DELETE FROM audit_events WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM ledger_entries WHERE reseller_id = $1', [resellerId]);
    await client.query("SET session_replication_role = 'origin'");
    await client.query('DELETE FROM order_events WHERE order_id IN (SELECT id FROM voucher_orders WHERE reseller_id = $1)', [resellerId]);
    await client.query('DELETE FROM vouchers WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM reconciliation_cases WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM holds WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM voucher_orders WHERE reseller_id = $1', [resellerId]);
    await client.query(
      `DELETE FROM price_versions WHERE price_rule_id IN (
         SELECT id FROM price_rules WHERE reseller_id = $1)`,
      [resellerId],
    );
    await client.query('DELETE FROM price_rules WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM reseller_package_permissions WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM reseller_sites WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM wallets WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE reseller_id = $1)', [resellerId]);
    await client.query('DELETE FROM users WHERE reseller_id = $1', [resellerId]);
    await client.query('DELETE FROM resellers WHERE id = $1', [resellerId]);
  } finally {
    client.release();
  }
}

export async function teardownConnection(pool, connectionId) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM sync_cursors WHERE ruijie_connection_id = $1', [connectionId]);
    await client.query(
      `DELETE FROM price_versions WHERE price_rule_id IN (
         SELECT id FROM price_rules WHERE package_id IN (
           SELECT id FROM packages WHERE site_id IN (
             SELECT id FROM sites WHERE ruijie_connection_id = $1)))`,
      [connectionId],
    );
    await client.query(
      `DELETE FROM price_rules WHERE package_id IN (
         SELECT id FROM packages WHERE site_id IN (
           SELECT id FROM sites WHERE ruijie_connection_id = $1))`,
      [connectionId],
    );
    await client.query(
      `DELETE FROM reseller_package_permissions WHERE package_id IN (
         SELECT id FROM packages WHERE site_id IN (
           SELECT id FROM sites WHERE ruijie_connection_id = $1))`,
      [connectionId],
    );
    await client.query(
      `DELETE FROM reseller_sites WHERE site_id IN (
         SELECT id FROM sites WHERE ruijie_connection_id = $1)`,
      [connectionId],
    );
    await client.query(
      `DELETE FROM packages WHERE site_id IN (SELECT id FROM sites WHERE ruijie_connection_id = $1)`,
      [connectionId],
    );
    await client.query('DELETE FROM sites WHERE ruijie_connection_id = $1', [connectionId]);
    await client.query('DELETE FROM ruijie_connections WHERE id = $1', [connectionId]);
  } finally {
    client.release();
  }
}
