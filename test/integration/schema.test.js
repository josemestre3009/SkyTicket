import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

const EXPECTED_TABLES = [
  'resellers', 'ruijie_connections', 'sites', 'reseller_sites',
  'users', 'sessions', 'second_factors', 'recovery_codes',
  'packages', 'reseller_package_permissions',
  'price_rules', 'price_versions',
  'wallets', 'ledger_entries', 'holds',
  'voucher_orders', 'order_events', 'vouchers',
  'sync_cursors', 'jobs', 'reconciliation_cases', 'notifications', 'email_deliveries',
  'audit_events', 'schema_migrations',
];

test('schema', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();

  await t.test('creates all required tables', async () => {
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = new Set(rows.map((row) => row.tablename));
    for (const table of EXPECTED_TABLES) {
      assert.ok(names.has(table), `missing table ${table}`);
    }
  });

  const suffix = crypto.randomUUID().slice(0, 8);
  const state = {};

  await t.test('set up tenant fixtures', async () => {
    const reseller = await pool.query(
      "INSERT INTO resellers (name, status) VALUES ($1, 'active') RETURNING id",
      [`Test Reseller ${suffix}`],
    );
    state.resellerId = reseller.rows[0].id;

    const other = await pool.query(
      "INSERT INTO resellers (name, status) VALUES ($1, 'active') RETURNING id",
      [`Other Reseller ${suffix}`],
    );
    state.otherResellerId = other.rows[0].id;

    const connection = await pool.query(
      `INSERT INTO ruijie_connections (region, base_url, app_id, app_secret_encrypted)
       VALUES ('eu', 'https://example.test', $1, 'v1.x.y.z.w') RETURNING id`,
      [`app-${suffix}`],
    );
    state.connectionId = connection.rows[0].id;

    const site = await pool.query(
      `INSERT INTO sites (ruijie_connection_id, ruijie_group_id, name)
       VALUES ($1, $2, 'Site A') RETURNING id`,
      [state.connectionId, `group-${suffix}`],
    );
    state.siteId = site.rows[0].id;

    const otherSite = await pool.query(
      `INSERT INTO sites (ruijie_connection_id, ruijie_group_id, name)
       VALUES ($1, $2, 'Site B') RETURNING id`,
      [state.connectionId, `group-b-${suffix}`],
    );
    state.otherSiteId = otherSite.rows[0].id;

    await pool.query(
      'INSERT INTO reseller_sites (reseller_id, site_id) VALUES ($1, $2)',
      [state.resellerId, state.siteId],
    );

    const pkg = await pool.query(
      `INSERT INTO packages (site_id, ruijie_user_group_id, ruijie_profile_id, name)
       VALUES ($1, $2, 'profile-1', 'Package A') RETURNING id`,
      [state.siteId, `ug-${suffix}`],
    );
    state.packageId = pkg.rows[0].id;

    const otherPkg = await pool.query(
      `INSERT INTO packages (site_id, ruijie_user_group_id, ruijie_profile_id, name)
       VALUES ($1, $2, 'profile-2', 'Package B') RETURNING id`,
      [state.otherSiteId, `ug-b-${suffix}`],
    );
    state.otherPackageId = otherPkg.rows[0].id;

    await pool.query('INSERT INTO wallets (reseller_id) VALUES ($1)', [state.resellerId]);
  });

  await t.test('enforces case-insensitive unique user email', async () => {
    await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, 'hash', 'admin')",
      [`Admin-${suffix}@Example.com`],
    );
    await assert.rejects(() =>
      pool.query(
        "INSERT INTO users (email, password_hash, role) VALUES ($1, 'hash', 'admin')",
        [`admin-${suffix}@example.com`],
      ),
    );
  });

  await t.test('rejects negative wallet balance', async () => {
    await assert.rejects(() =>
      pool.query('UPDATE wallets SET available_minor = -1 WHERE reseller_id = $1', [state.resellerId]),
    );
  });

  await t.test('rejects duplicate reseller/site assignment', async () => {
    await assert.rejects(() =>
      pool.query('INSERT INTO reseller_sites (reseller_id, site_id) VALUES ($1, $2)', [
        state.resellerId,
        state.siteId,
      ]),
    );
  });

  await t.test('rejects overlapping price validity windows', async () => {
    const rule = await pool.query(
      "INSERT INTO price_rules (package_id, scope) VALUES ($1, 'base') RETURNING id",
      [state.packageId],
    );
    await pool.query(
      `INSERT INTO price_versions (price_rule_id, amount_minor, effective_from, effective_to)
       VALUES ($1, 1000, now(), now() + interval '1 day')`,
      [rule.rows[0].id],
    );
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO price_versions (price_rule_id, amount_minor, effective_from, effective_to)
         VALUES ($1, 2000, now() + interval '1 hour', now() + interval '2 days')`,
        [rule.rows[0].id],
      ),
    );
  });

  await t.test('enforces tenant isolation on orders', async () => {
    await pool.query(
      `INSERT INTO voucher_orders (reseller_id, site_id, package_id, quantity, unit_price_minor, total_minor, local_reference)
       VALUES ($1, $2, $3, 1, 1000, 1000, $4)`,
      [state.resellerId, state.siteId, state.packageId, `ref-${suffix}`],
    );

    await assert.rejects(() =>
      pool.query(
        `INSERT INTO voucher_orders (reseller_id, site_id, package_id, quantity, unit_price_minor, total_minor, local_reference)
         VALUES ($1, $2, $3, 1, 1000, 1000, $4)`,
        [state.otherResellerId, state.siteId, state.packageId, `ref-other-${suffix}`],
      ),
      'reseller without site assignment must be rejected',
    );

    await assert.rejects(() =>
      pool.query(
        `INSERT INTO voucher_orders (reseller_id, site_id, package_id, quantity, unit_price_minor, total_minor, local_reference)
         VALUES ($1, $2, $3, 1, 1000, 1000, $4)`,
        [state.resellerId, state.siteId, state.otherPackageId, `ref-pkg-${suffix}`],
      ),
      'package from another site must be rejected',
    );
  });

  await t.test('enforces append-only ledger', async () => {
    const client = await pool.connect();
    try {
      const wallet = await client.query('SELECT id FROM wallets WHERE reseller_id = $1', [state.resellerId]);
      const entry = await client.query(
        `INSERT INTO ledger_entries
           (reseller_id, wallet_id, entry_type, amount_minor, available_delta, idempotency_key)
         VALUES ($1, $2, 'recharge', 5000, 5000, $3) RETURNING id`,
        [state.resellerId, wallet.rows[0].id, `recharge-${suffix}`],
      );
      await assert.rejects(() =>
        client.query('UPDATE ledger_entries SET reason = $2 WHERE id = $1', [entry.rows[0].id, 'tamper']),
      );
      await assert.rejects(() => client.query('DELETE FROM ledger_entries WHERE id = $1', [entry.rows[0].id]));
    } finally {
      client.release();
    }
  });

  t.after(async () => {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      await client.query('DELETE FROM ledger_entries WHERE idempotency_key = $1', [`recharge-${suffix}`]);
      await client.query("SET session_replication_role = 'origin'");
    } finally {
      client.release();
    }
    await pool.query('DELETE FROM order_events WHERE order_id IN (SELECT id FROM voucher_orders WHERE local_reference LIKE $1)', [`%${suffix}`]);
    await pool.query('DELETE FROM voucher_orders WHERE local_reference LIKE $1', [`%${suffix}`]);
    await pool.query('DELETE FROM price_versions WHERE price_rule_id IN (SELECT id FROM price_rules WHERE package_id IN (SELECT id FROM packages WHERE ruijie_user_group_id LIKE $1))', [`%${suffix}`]);
    await pool.query('DELETE FROM price_rules WHERE package_id IN (SELECT id FROM packages WHERE ruijie_user_group_id LIKE $1)', [`%${suffix}`]);
    await pool.query('DELETE FROM reseller_package_permissions WHERE package_id IN (SELECT id FROM packages WHERE ruijie_user_group_id LIKE $1)', [`%${suffix}`]);
    await pool.query('DELETE FROM packages WHERE ruijie_user_group_id LIKE $1', [`%${suffix}`]);
    await pool.query('DELETE FROM reseller_sites WHERE reseller_id IN ($1,$2)', [state.resellerId, state.otherResellerId]);
    await pool.query('DELETE FROM wallets WHERE reseller_id IN ($1,$2)', [state.resellerId, state.otherResellerId]);
    await pool.query('DELETE FROM sites WHERE ruijie_group_id LIKE $1', [`%${suffix}`]);
    await pool.query('DELETE FROM ruijie_connections WHERE app_id = $1', [`app-${suffix}`]);
    await pool.query('DELETE FROM users WHERE reseller_id IN ($1,$2) OR email LIKE $3', [state.resellerId, state.otherResellerId, `%${suffix}%`]);
    await pool.query('DELETE FROM resellers WHERE name LIKE $1', [`%${suffix}`]);
    await close();
  });
});
