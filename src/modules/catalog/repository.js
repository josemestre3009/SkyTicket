import { getPool } from '../../db/index.js';

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
  return fn(db(runner));
}

export async function upsertPackage(pkg, runner) {
  const runner2 = db(runner);
  const params = [
    pkg.siteId,
    String(pkg.ruijieUserGroupId),
    pkg.ruijieProfileId == null ? null : String(pkg.ruijieProfileId),
    pkg.name,
    pkg.duration ?? null,
    pkg.quota ?? null,
    pkg.upSpeed ?? null,
    pkg.downSpeed ?? null,
    pkg.concurrentClients ?? null,
    pkg.bindMac ?? null,
    pkg.technicalLimits != null ? JSON.stringify(pkg.technicalLimits) : null,
    pkg.raw != null ? JSON.stringify(pkg.raw) : null,
  ];

  // Update first so a sync that omits the profile keeps the previously stored one.
  const updated = await runner2.query(
    `UPDATE packages SET
       ruijie_profile_id = COALESCE($3, ruijie_profile_id),
       name = $4,
       duration = $5,
       quota = $6,
       up_speed = $7,
       down_speed = $8,
       concurrent_clients = $9,
       bind_mac = $10,
       technical_limits_json = $11,
       raw_json = $12,
       status = 'active',
       last_synced_at = now()
     WHERE site_id = $1 AND ruijie_user_group_id = $2
     RETURNING *`,
    params,
  );
  if (updated.rows[0]) return updated.rows[0];

  const inserted = await runner2.query(
    `INSERT INTO packages
       (site_id, ruijie_user_group_id, ruijie_profile_id, name, duration, quota,
        up_speed, down_speed, concurrent_clients, bind_mac, technical_limits_json, raw_json,
        status, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',now())
     ON CONFLICT (site_id, ruijie_user_group_id) DO NOTHING
     RETURNING *`,
    params,
  );
  return inserted.rows[0] ?? null;
}

export async function deactivateMissingPackages(siteId, seenUserGroupIds, runner) {
  const { rowCount } = await db(runner).query(
    `UPDATE packages SET status = 'disabled'
     WHERE site_id = $1 AND ruijie_user_group_id <> ALL($2::text[])`,
    [siteId, seenUserGroupIds.map(String)],
  );
  return rowCount;
}

export async function findPackageById(packageId, runner) {
  const { rows } = await db(runner).query('SELECT * FROM packages WHERE id = $1', [packageId]);
  return rows[0] ?? null;
}

export async function listPackagesBySite(siteId, runner) {
  const { rows } = await db(runner).query(
    'SELECT * FROM packages WHERE site_id = $1 ORDER BY name',
    [siteId],
  );
  return rows;
}

export async function listAuthorizedPackages({ resellerId, siteId = null }, runner) {
  const { rows } = await db(runner).query(
    `SELECT p.*
     FROM packages p
     JOIN reseller_package_permissions rp
       ON rp.package_id = p.id AND rp.reseller_id = $1 AND rp.status = 'active'
     JOIN reseller_sites rs
       ON rs.site_id = p.site_id AND rs.reseller_id = $1 AND rs.status = 'active'
     WHERE p.status = 'active' AND ($2::uuid IS NULL OR p.site_id = $2)
     ORDER BY p.name`,
    [resellerId, siteId],
  );
  return rows;
}

export async function findAuthorizedPackage({ resellerId, siteId, packageId }, runner) {
  const { rows } = await db(runner).query(
    `SELECT p.*
     FROM packages p
     JOIN reseller_package_permissions rp
       ON rp.package_id = p.id AND rp.reseller_id = $1 AND rp.status = 'active'
     JOIN reseller_sites rs
       ON rs.site_id = p.site_id AND rs.reseller_id = $1 AND rs.status = 'active'
     WHERE p.id = $3 AND p.site_id = $2 AND p.status = 'active'`,
    [resellerId, siteId, packageId],
  );
  return rows[0] ?? null;
}

export async function grantPermission({ resellerId, packageId, status = 'active' }, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO reseller_package_permissions (reseller_id, package_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (reseller_id, package_id) DO UPDATE SET status = EXCLUDED.status
     RETURNING *`,
    [resellerId, packageId, status],
  );
  return rows[0];
}

export async function revokePermission({ resellerId, packageId }, runner) {
  const { rows } = await db(runner).query(
    'DELETE FROM reseller_package_permissions WHERE reseller_id = $1 AND package_id = $2 RETURNING id',
    [resellerId, packageId],
  );
  return rows[0] ?? null;
}

export async function findPriceRule({ packageId, scope, resellerId, siteId }, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM price_rules
     WHERE package_id = $1 AND scope = $2
       AND reseller_id IS NOT DISTINCT FROM $3
       AND site_id IS NOT DISTINCT FROM $4`,
    [packageId, scope, resellerId ?? null, siteId ?? null],
  );
  return rows[0] ?? null;
}

export async function createPriceRule({ packageId, scope, resellerId = null, siteId = null }, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO price_rules (package_id, scope, reseller_id, site_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [packageId, scope, resellerId, siteId],
  );
  return rows[0] ?? null;
}

export async function closeOpenPriceVersion(ruleId, at, runner) {
  const { rowCount } = await db(runner).query(
    `UPDATE price_versions SET effective_to = $2
     WHERE price_rule_id = $1 AND effective_to IS NULL AND effective_from < $2`,
    [ruleId, at],
  );
  return rowCount;
}

export async function createPriceVersion(
  { priceRuleId, amountMinor, currency = 'COP', effectiveFrom, createdBy = null, reason = null },
  runner,
) {
  const { rows } = await db(runner).query(
    `INSERT INTO price_versions
       (price_rule_id, currency, amount_minor, effective_from, created_by, reason)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)
     RETURNING *`,
    [priceRuleId, currency, amountMinor, effectiveFrom ?? null, createdBy, reason],
  );
  return rows[0];
}

export async function listPriceRules(packageId, runner) {
  const { rows } = await db(runner).query(
    `SELECT pr.*, pv.amount_minor, pv.currency, pv.effective_from, pv.effective_to, pv.id AS price_version_id
     FROM price_rules pr
     LEFT JOIN price_versions pv ON pv.price_rule_id = pr.id
     WHERE pr.package_id = $1
     ORDER BY pr.created_at, pv.effective_from`,
    [packageId],
  );
  return rows;
}

export async function resolvePriceRow({ packageId, resellerId, siteId, at }, runner) {
  const { rows } = await db(runner).query(
    `SELECT pv.id AS price_version_id, pv.amount_minor, pv.currency, pr.id AS price_rule_id, pr.scope
     FROM price_rules pr
     JOIN price_versions pv ON pv.price_rule_id = pr.id
     WHERE pr.package_id = $1
       AND pv.effective_from <= $4
       AND (pv.effective_to IS NULL OR pv.effective_to > $4)
       AND (
         pr.scope = 'base'
         OR (pr.scope = 'site' AND pr.site_id = $3)
         OR (pr.scope = 'reseller' AND pr.reseller_id = $2)
         OR (pr.scope = 'reseller_site' AND pr.reseller_id = $2 AND pr.site_id = $3)
       )
     ORDER BY CASE pr.scope
                WHEN 'reseller_site' THEN 4
                WHEN 'reseller' THEN 3
                WHEN 'site' THEN 2
                ELSE 1
              END DESC,
              pv.effective_from DESC
     LIMIT 1`,
    [packageId, resellerId, siteId, at],
  );
  return rows[0] ?? null;
}
