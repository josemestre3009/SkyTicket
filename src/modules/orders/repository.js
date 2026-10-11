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

export async function insertOrder(order, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO voucher_orders
       (reseller_id, site_id, package_id, created_by, client_reference, quantity, currency,
        unit_price_minor, total_minor, price_rule_id, status, local_reference,
        request_fingerprint, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (reseller_id, local_reference) DO NOTHING
     RETURNING *`,
    [
      order.resellerId,
      order.siteId,
      order.packageId,
      order.createdBy ?? null,
      order.clientReference ?? null,
      order.quantity,
      order.currency ?? 'COP',
      order.unitPriceMinor,
      order.totalMinor,
      order.priceRuleId ?? null,
      order.status ?? 'draft',
      order.localReference,
      order.requestFingerprint ?? null,
      order.correlationId ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function findOrderById(orderId, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM voucher_orders WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [orderId],
  );
  return rows[0] ?? null;
}

export async function findOrderByLocalReference(resellerId, localReference, { forUpdate = false } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM voucher_orders WHERE reseller_id = $1 AND local_reference = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [resellerId, localReference],
  );
  return rows[0] ?? null;
}

export async function updateOrderStatus(orderId, { to, fields = {} }, runner) {
  const { rows } = await db(runner).query(
    `UPDATE voucher_orders SET
       status = $2,
       reserved_at = CASE WHEN $2 = 'reserved' THEN COALESCE(reserved_at, now()) ELSE reserved_at END,
       issuing_at = CASE WHEN $2 = 'issuing' THEN COALESCE(issuing_at, now()) ELSE issuing_at END,
       issued_at = CASE WHEN $2 = 'issued' THEN COALESCE(issued_at, now()) ELSE issued_at END,
       issued_quantity = COALESCE($3, issued_quantity),
       failure_reason = COALESCE($4, failure_reason),
       ruijie_raw_response = COALESCE($5::jsonb, ruijie_raw_response),
       hold_id = COALESCE($6, hold_id)
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      to,
      fields.issuedQuantity ?? null,
      fields.failureReason ?? null,
      fields.ruijieRawResponse != null ? JSON.stringify(fields.ruijieRawResponse) : null,
      fields.holdId ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function insertOrderEvent(event, runner) {
  const { rows } = await db(runner).query(
    `INSERT INTO order_events
       (order_id, from_status, to_status, event_type, actor_id, idempotency_key, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      event.orderId,
      event.fromStatus ?? null,
      event.toStatus,
      event.eventType,
      event.actorId ?? null,
      event.idempotencyKey ?? null,
      event.detail != null ? JSON.stringify(event.detail) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function findOrderEventByIdempotency(idempotencyKey, runner) {
  const { rows } = await db(runner).query(
    'SELECT * FROM order_events WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function listOrderEvents(orderId, runner) {
  const { rows } = await db(runner).query(
    'SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at, id',
    [orderId],
  );
  return rows;
}

export async function listOrders({ resellerId = null, status = null, limit = 100, offset = 0 } = {}, runner) {
  const { rows } = await db(runner).query(
    `SELECT * FROM voucher_orders
     WHERE ($1::uuid IS NULL OR reseller_id = $1)
       AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [resellerId, status, limit, offset],
  );
  return rows;
}
