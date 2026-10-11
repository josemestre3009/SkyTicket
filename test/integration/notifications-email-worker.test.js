import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import {
  createReseller,
  createUser,
  teardownReseller,
} from './reseller-fixtures.js';
import {
  createNotificationService,
  EMAIL_DELIVERY_JOB_TYPE,
  NOTIFICATION_TYPES,
} from '../../src/modules/notifications/index.js';
import { createNotificationHandlers } from '../../src/worker-handlers/notifications.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

function okTransport() {
  const calls = [];
  return {
    calls,
    transport: { sendMail: async (msg) => { calls.push(msg); return { messageId: 'm1' }; } },
  };
}

test('async email delivery worker', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createNotificationService({ runner: pool });

  const resellerOk = await createReseller(pool);
  const userOk = await createUser(pool, { role: 'reseller', resellerId: resellerOk.id });
  const resellerFail = await createReseller(pool);
  const userFail = await createUser(pool, { role: 'reseller', resellerId: resellerFail.id });
  const userIds = [userOk.id, userFail.id];

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
    await teardownReseller(pool, resellerOk.id);
    await teardownReseller(pool, resellerFail.id);
    await close();
  });

  const deliveryFor = async (resellerId) => {
    const { rows } = await pool.query(
      `SELECT d.* FROM email_deliveries d
       JOIN notifications n ON n.id = d.notification_id
       WHERE n.recipient_reseller_id = $1 AND n.type = $2`,
      [resellerId, NOTIFICATION_TYPES.SUSPENSION],
    );
    return rows[0];
  };

  await t.test('sends and records success for a pending delivery', async () => {
    await service.emit({
      type: NOTIFICATION_TYPES.SUSPENSION,
      resourceType: 'reseller',
      resourceId: resellerOk.id,
      resellerId: resellerOk.id,
      title: 'Cuenta suspendida',
    });
    const delivery = await deliveryFor(resellerOk.id);
    assert.ok(delivery);

    const fake = okTransport();
    const handlers = createNotificationHandlers({ runner: pool, transport: fake.transport });
    const result = await handlers[EMAIL_DELIVERY_JOB_TYPE]({ payload: { deliveryId: delivery.id } });

    assert.equal(result.sent, true);
    assert.equal(fake.calls[0].to, userOk.email);
    const { rows } = await pool.query('SELECT status, attempts, sent_at FROM email_deliveries WHERE id = $1', [delivery.id]);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].attempts, 1);
    assert.ok(rows[0].sent_at);

    const replay = await handlers[EMAIL_DELIVERY_JOB_TYPE]({ payload: { deliveryId: delivery.id } });
    assert.deepEqual(replay, { skipped: 'already_sent' });
    assert.equal(fake.calls.length, 1);
  });

  await t.test('failed provider exhausts limited attempts without reverting business', async () => {
    await service.emit({
      type: NOTIFICATION_TYPES.SUSPENSION,
      resourceType: 'reseller',
      resourceId: resellerFail.id,
      resellerId: resellerFail.id,
      title: 'Cuenta suspendida',
    });
    const delivery = await deliveryFor(resellerFail.id);
    await pool.query('UPDATE email_deliveries SET max_attempts = 2 WHERE id = $1', [delivery.id]);

    const transport = { sendMail: async () => { throw new Error('smtp down'); } };
    const handlers = createNotificationHandlers({ runner: pool, transport, logger: { warn() {} } });

    await assert.rejects(
      () => handlers[EMAIL_DELIVERY_JOB_TYPE]({ payload: { deliveryId: delivery.id } }),
      /smtp down/,
    );
    let row = (await pool.query('SELECT status, attempts, last_error FROM email_deliveries WHERE id = $1', [delivery.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /smtp down/);

    const second = await handlers[EMAIL_DELIVERY_JOB_TYPE]({ payload: { deliveryId: delivery.id } });
    assert.deepEqual(second, { dead: true, attempts: 2 });
    row = (await pool.query('SELECT status, attempts FROM email_deliveries WHERE id = $1', [delivery.id])).rows[0];
    assert.equal(row.status, 'dead');

    const notification = await pool.query(
      'SELECT id FROM notifications WHERE recipient_user_id = $1 AND type = $2',
      [userFail.id, NOTIFICATION_TYPES.SUSPENSION],
    );
    assert.equal(notification.rowCount, 1, 'business notification is not reverted by email failure');
  });
});
