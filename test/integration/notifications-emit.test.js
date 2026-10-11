import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import {
  createReseller,
  createConnection,
  createUser,
  teardownReseller,
  teardownConnection,
} from './reseller-fixtures.js';
import {
  createNotificationService,
  EMAIL_DELIVERY_JOB_TYPE,
  NOTIFICATION_TYPES,
} from '../../src/modules/notifications/index.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('notification emit matrix and dedupe', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createNotificationService({ runner: pool });

  const connection = await createConnection(pool);
  const reseller = await createReseller(pool);
  const user = await createUser(pool, { role: 'reseller', resellerId: reseller.id });
  const admin = await createUser(pool, { role: 'admin' });
  const userIds = [user.id, admin.id];

  const rowsFor = async (type, { channel = null, resourceId = null } = {}) => {
    const { rows } = await pool.query(
      `SELECT * FROM notifications
       WHERE type = $1
         AND ($2::text IS NULL OR channel = $2)
         AND ($3::uuid IS NULL OR resource_id = $3)`,
      [type, channel, resourceId],
    );
    return rows;
  };

  t.after(async () => {
    await pool.query(
      `DELETE FROM jobs WHERE job_type = $1 AND payload->>'deliveryId' IN (
         SELECT d.id::text FROM email_deliveries d
         WHERE d.notification_id IN (SELECT id FROM notifications WHERE recipient_user_id = ANY($2::uuid[]))
       )`,
      [EMAIL_DELIVERY_JOB_TYPE, userIds],
    );
    await pool.query(
      'DELETE FROM email_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE recipient_user_id = ANY($1::uuid[]))',
      [userIds],
    );
    await pool.query('DELETE FROM notifications WHERE recipient_user_id = ANY($1::uuid[])', [userIds]);
    await teardownReseller(pool, reseller.id);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await teardownConnection(pool, connection.id);
    await close();
  });

  await t.test('low_balance notifies reseller by email, deduped per window', async () => {
    const first = await service.emit({
      type: NOTIFICATION_TYPES.LOW_BALANCE,
      resourceType: 'reseller',
      resourceId: reseller.id,
      resellerId: reseller.id,
      title: 'Saldo bajo',
      body: 'Tu saldo cruzo el umbral',
    });
    assert.equal(first.created.length, 1);

    const email = await rowsFor('low_balance', { channel: 'email', resourceId: reseller.id });
    assert.equal(email.length, 1);
    assert.equal(email[0].recipient_user_id, user.id);

    const emailDelivery = await pool.query(
      'SELECT * FROM email_deliveries WHERE notification_id = $1',
      [email[0].id],
    );
    assert.equal(emailDelivery.rowCount, 1);
    assert.equal(emailDelivery.rows[0].recipient_email, user.email);

    const jobs = await pool.query(
      "SELECT * FROM jobs WHERE job_type = $1 AND payload->>'deliveryId' = $2",
      [EMAIL_DELIVERY_JOB_TYPE, emailDelivery.rows[0].id],
    );
    assert.equal(jobs.rowCount, 1);

    const second = await service.emit({
      type: NOTIFICATION_TYPES.LOW_BALANCE,
      resourceType: 'reseller',
      resourceId: reseller.id,
      resellerId: reseller.id,
      title: 'Saldo bajo',
    });
    assert.equal(second.created.length, 0, 'no duplicate on rerun');
    assert.equal(second.skipped, 1);
    assert.equal((await rowsFor('low_balance', { resourceId: reseller.id })).length, 1);
  });

  await t.test('low_balance requires a reseller target', async () => {
    await assert.rejects(
      () => service.emit({ type: NOTIFICATION_TYPES.LOW_BALANCE, title: 'x' }),
      (err) => err.code === 'reseller_id_required',
    );
  });

  await t.test('issue_uncertain notifies admin and reseller by email', async () => {
    const result = await service.emit({
      type: NOTIFICATION_TYPES.ISSUE_UNCERTAIN,
      resourceType: 'voucher_order',
      resourceId: reseller.id,
      resellerId: reseller.id,
      title: 'Emision incierta',
    });
    assert.equal(result.created.filter((r) => r.recipient_user_id === user.id).length, 1);
    assert.equal(result.created.filter((r) => r.recipient_user_id === admin.id).length, 1);
    const rows = await rowsFor('issue_uncertain', { resourceId: reseller.id });
    assert.equal(rows.filter((r) => r.recipient_user_id === admin.id).length, 1);
    assert.equal(rows.filter((r) => r.recipient_user_id === user.id).length, 1);
    assert.ok(rows.every((r) => r.channel === 'email'));
  });

  await t.test('issue_completed sends no notification in the MVP', async () => {
    const result = await service.emit({
      type: NOTIFICATION_TYPES.ISSUE_COMPLETED,
      resourceType: 'voucher_order',
      resourceId: reseller.id,
      resellerId: reseller.id,
      title: 'Emision completada',
    });
    assert.equal(result.created.length, 0);
    const rows = await rowsFor('issue_completed', { resourceId: reseller.id });
    assert.equal(rows.length, 0);
  });

  await t.test('suspension notifies reseller by email only', async () => {
    const result = await service.emit({
      type: NOTIFICATION_TYPES.SUSPENSION,
      resourceType: 'reseller',
      resourceId: reseller.id,
      resellerId: reseller.id,
      title: 'Cuenta suspendida',
    });
    assert.equal(result.created.length, 1);
    const rows = await rowsFor('suspension', { resourceId: reseller.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, 'email');
  });

  await t.test('sync_failure notifies admin by email only', async () => {
    const result = await service.emit({
      type: NOTIFICATION_TYPES.SYNC_FAILURE,
      resourceType: 'ruijie_connection',
      resourceId: connection.id,
      title: 'Fallo de sincronizacion',
    });
    assert.equal(result.created.filter((r) => r.recipient_user_id === admin.id).length, 1);
    const rows = await rowsFor('sync_failure', { resourceId: connection.id });
    const adminRows = rows.filter((r) => r.recipient_user_id === admin.id);
    assert.equal(adminRows.length, 1);
    assert.equal(adminRows.filter((r) => r.channel === 'email').length, 1);
    assert.ok(rows.every((r) => r.recipient_user_id !== user.id), 'reseller is not a sync_failure recipient');
  });
});
