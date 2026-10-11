import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import {
  createReseller,
  createConnection,
  createSite,
  createPackage,
  assignSite,
  createUser,
  authFor,
  suffix,
  teardownReseller,
  teardownConnection,
} from './reseller-fixtures.js';
import {
  createNotificationService,
  EMAIL_DELIVERY_JOB_TYPE,
  NOTIFICATION_TYPES,
} from '../../src/modules/notifications/index.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('notification read and tenant safety', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createNotificationService({ runner: pool });

  const connection = await createConnection(pool);
  const site = await createSite(pool, connection.id);
  const resellerA = await createReseller(pool);
  const resellerB = await createReseller(pool);
  await assignSite(pool, resellerA.id, site.id);
  const pkg = await createPackage(pool, site.id);
  const userA = await createUser(pool, { role: 'reseller', resellerId: resellerA.id });
  const userB = await createUser(pool, { role: 'reseller', resellerId: resellerB.id });
  const admin = await createUser(pool, { role: 'admin' });
  const userIds = [userA.id, userB.id, admin.id];

  const { rows: orderRows } = await pool.query(
    `INSERT INTO voucher_orders
       (reseller_id, site_id, package_id, quantity, unit_price_minor, total_minor, local_reference)
     VALUES ($1,$2,$3,1,100,100,$4) RETURNING *`,
    [resellerA.id, site.id, pkg.id, `ref-${suffix()}`],
  );
  const order = orderRows[0];

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
    await teardownReseller(pool, resellerA.id);
    await teardownReseller(pool, resellerB.id);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await teardownConnection(pool, connection.id);
    await close();
  });

  let aNotification;
  await t.test('emit a reseller notification and an admin notification', async () => {
    const res = await service.emit({
      type: NOTIFICATION_TYPES.LOW_BALANCE,
      resourceType: 'voucher_order',
      resourceId: order.id,
      resellerId: resellerA.id,
      title: 'Saldo bajo',
    });
    assert.equal(res.created.length, 1);
    aNotification = res.created[0];
    await service.emit({
      type: NOTIFICATION_TYPES.SYNC_FAILURE,
      resourceType: 'ruijie_connection',
      resourceId: connection.id,
      title: 'Fallo de sincronizacion',
    });
  });

  await t.test('list only returns the caller notifications', async () => {
    const forA = await service.list({ auth: authFor(userA) });
    assert.ok(forA.some((n) => n.id === aNotification.id));
    assert.ok(forA.every((n) => n.channel !== undefined));

    const forB = await service.list({ auth: authFor(userB) });
    assert.equal(forB.length, 0, 'no cross-tenant leakage');
  });

  await t.test('unread count is per user', async () => {
    assert.equal(await service.unreadCount({ auth: authFor(userA) }), 1);
    assert.equal(await service.unreadCount({ auth: authFor(userB) }), 0);
  });

  await t.test("marking another user's notification fails without side effects", async () => {
    await assert.rejects(
      () => service.markRead({ auth: authFor(userB), notificationId: aNotification.id }),
      (err) => err.statusCode === 404,
    );
    const still = await pool.query('SELECT read_at FROM notifications WHERE id = $1', [aNotification.id]);
    assert.equal(still.rows[0].read_at, null);
  });

  await t.test('marking own notification sets read_at only for that user', async () => {
    const marked = await service.markRead({ auth: authFor(userA), notificationId: aNotification.id });
    assert.ok(marked.readAt);
    assert.equal(await service.unreadCount({ auth: authFor(userA) }), 0);

    const adminRows = await pool.query(
      'SELECT read_at FROM notifications WHERE recipient_user_id = $1 AND type = $2',
      [admin.id, NOTIFICATION_TYPES.SYNC_FAILURE],
    );
    assert.ok(adminRows.rowCount >= 1, "admin's own notifications untouched");
    assert.ok(adminRows.rows.every((r) => r.read_at === null));
  });

  await t.test('resource links are resolved per tenant and fail safe cross-tenant', async () => {
    const note = { resourceType: 'voucher_order', resourceId: order.id };
    const linkA = await service.resolveResourceLink({ auth: authFor(userA), notification: note });
    assert.equal(linkA.href, `/orders/${order.id}`);

    const linkB = await service.resolveResourceLink({ auth: authFor(userB), notification: note });
    assert.equal(linkB, null, 'cross-tenant link is withheld');

    const linkAdmin = await service.resolveResourceLink({ auth: authFor(admin), notification: note });
    assert.equal(linkAdmin.href, `/orders/${order.id}`);

    const unknown = await service.resolveResourceLink({
      auth: authFor(admin),
      notification: { resourceType: 'nope', resourceId: order.id },
    });
    assert.equal(unknown, null);
  });
});
