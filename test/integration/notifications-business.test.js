import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import {
  createNotificationService,
  NOTIFICATION_TYPES,
  EMAIL_DELIVERY_JOB_TYPE,
} from '../../src/modules/notifications/index.js';
import { createWalletService } from '../../src/modules/wallet/service.js';
import { createResellerService } from '../../src/modules/resellers/service.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createReseller, createUser, teardownReseller } from './reseller-fixtures.js';
import { seedTenant, teardownTenant, createSimulatedAdapter, authFor } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';
const CIPHER = Cipher.fromKey('notifications-business-key');

async function cleanupNotifications(pool, userIds) {
  if (!userIds.length) return;
  await pool.query(
    `DELETE FROM jobs WHERE job_type = $1 AND payload->>'deliveryId' IN (
       SELECT d.id::text FROM email_deliveries d
       WHERE d.notification_id IN (SELECT id FROM notifications WHERE recipient_user_id = ANY($2::uuid[])))`,
    [EMAIL_DELIVERY_JOB_TYPE, userIds],
  );
  await pool.query('DELETE FROM notifications WHERE recipient_user_id = ANY($1::uuid[])', [userIds]);
}

async function rowsFor(pool, type, resourceId) {
  const { rows } = await pool.query(
    'SELECT * FROM notifications WHERE type = $1 AND resource_id = $2 ORDER BY channel',
    [type, resourceId],
  );
  return rows;
}

test('business notifications: topup, low balance and suspension are emitted transactionally', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const notifications = createNotificationService({ runner: pool });
  const wallet = createWalletService({ runner: pool, notifications });
  const resellers = createResellerService({ runner: pool, notifications });

  const reseller = await createReseller(pool, { lowBalanceThresholdMinor: 5000 });
  const user = await createUser(pool, { role: 'reseller', resellerId: reseller.id });
  const suspended = await createReseller(pool, { status: 'active' });
  const suspendedUser = await createUser(pool, { role: 'reseller', resellerId: suspended.id });
  const userIds = [user.id, suspendedUser.id];

  t.after(async () => {
    await cleanupNotifications(pool, userIds);
    await teardownReseller(pool, reseller.id);
    await teardownReseller(pool, suspended.id);
    await close();
  });

  await t.test('recharge emits a topup alert to the reseller by email', async () => {
    await wallet.ensureWallet(reseller.id);
    await wallet.recharge({
      resellerId: reseller.id,
      amountMinor: 100000,
      reason: 'seed',
      idempotencyKey: 'nb-topup',
    });
    const rows = await rowsFor(pool, NOTIFICATION_TYPES.TOPUP, reseller.id);
    assert.equal(rows.length, 1);
    assert.ok(rows.every((row) => row.recipient_user_id === user.id));
    assert.deepEqual(rows.map((r) => r.channel), ['email']);

    const emailRow = rows.find((r) => r.channel === 'email');
    const deliveries = await pool.query('SELECT * FROM email_deliveries WHERE notification_id = $1', [emailRow.id]);
    assert.equal(deliveries.rowCount, 1);
  });

  await t.test('reserving below the threshold emits exactly one low-balance alert', async () => {
    await wallet.reserve({ resellerId: reseller.id, amountMinor: 98000, reserveKey: 'nb-low' });
    const rows = await rowsFor(pool, NOTIFICATION_TYPES.LOW_BALANCE, reseller.id);
    assert.equal(rows.length, 1);
    assert.ok(rows.every((row) => row.recipient_user_id === user.id));
  });

  await t.test('suspension emits an email-only alert to the reseller', async () => {
    await resellers.setStatus({ resellerId: suspended.id, status: 'suspended', reason: 'fraud' });
    const rows = await rowsFor(pool, NOTIFICATION_TYPES.SUSPENSION, suspended.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, 'email');
    assert.equal(rows[0].recipient_user_id, suspendedUser.id);
  });
});

test('issuance notifications: completed and uncertain outcomes are emitted', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const notifications = createNotificationService({ runner: pool });
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const svc = createIssuanceService({ runner: pool, adapter, cipher: CIPHER, notifications, rateLimit: async () => {} });
  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });
  const admin = await createUser(pool, { role: 'admin' });
  const userIds = [fx.user.id, admin.id];

  t.after(async () => {
    await cleanupNotifications(pool, userIds);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await teardownTenant(pool, fx);
    await close();
  });

  await t.test('a completed emission sends no notification in the MVP', async () => {
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 2,
      localReference: 'nb-complete',
    });
    assert.equal(out.outcome, 'issued');
    const rows = await rowsFor(pool, NOTIFICATION_TYPES.ISSUE_COMPLETED, out.order.id);
    assert.equal(rows.length, 0);
  });

  await t.test('an uncertain emission notifies admin and reseller by email', async () => {
    adapter.setBehavior('timeout');
    const out = await svc.issue({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 2,
      localReference: 'nb-uncertain',
    });
    assert.equal(out.outcome, 'needs_reconciliation');
    const rows = await rowsFor(pool, NOTIFICATION_TYPES.ISSUE_UNCERTAIN, out.order.id);
    assert.equal(rows.filter((r) => r.recipient_user_id === fx.user.id).length, 1);
    assert.equal(rows.filter((r) => r.recipient_user_id === admin.id).length, 1);
    assert.ok(rows.every((r) => r.channel === 'email'));
  });
});

test('notifications are part of the business transaction', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const exploding = { emit: async () => { throw new Error('notification sink down'); } };
  const wallet = createWalletService({ runner: pool, notifications: exploding });

  const reseller = await createReseller(pool, { lowBalanceThresholdMinor: 5000 });

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await close();
  });

  await wallet.ensureWallet(reseller.id);

  await assert.rejects(
    () => wallet.recharge({ resellerId: reseller.id, amountMinor: 10000, reason: 'seed', idempotencyKey: 'nb-tx' }),
    (err) => /notification sink down/.test(err.message),
  );

  const entries = await pool.query('SELECT count(*)::int AS c FROM ledger_entries WHERE reseller_id = $1', [reseller.id]);
  assert.equal(entries.rows[0].c, 0, 'ledger write rolled back with the failed notification');
  const balance = await pool.query('SELECT available_minor FROM wallets WHERE reseller_id = $1', [reseller.id]);
  assert.equal(Number(balance.rows[0].available_minor), 0, 'wallet projection rolled back');
});
