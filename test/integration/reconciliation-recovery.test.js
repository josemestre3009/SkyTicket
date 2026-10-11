import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createOrderService } from '../../src/modules/orders/service.js';
import { createWalletService } from '../../src/modules/wallet/service.js';
import { createReconciliationService } from '../../src/modules/reconciliation/service.js';
import * as issuanceRepo from '../../src/modules/issuance/repository.js';
import { seedTenant, teardownTenant, authFor } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('reconciliation recovery: only confirmed failures release balance', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const orders = createOrderService({ runner: pool });
  const wallet = createWalletService({ runner: pool });
  const recon = createReconciliationService({ runner: pool });

  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  async function newReservedOrder(localReference, { expiresAt = null } = {}) {
    const created = await orders.createOrder({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 1,
      localReference,
    });
    const order = created.order;
    const reserved = await wallet.reserve({
      resellerId: fx.reseller.id,
      amountMinor: Number(order.total_minor),
      reserveKey: `order:${order.id}`,
      orderId: order.id,
      expiresAt,
    });
    await orders.transition(
      {
        orderId: order.id,
        to: 'reserved',
        eventType: 'reserved',
        idempotencyKey: `order:${order.id}:reserved`,
        fields: { holdId: reserved.hold.id },
      },
      { runner: pool },
    );
    return { order, hold: reserved.hold };
  }

  await t.test('expired reservation without dispatch is released and fails the order', async () => {
    const { order, hold } = await newReservedOrder('rec-expired', { expiresAt: new Date(Date.now() - 60_000) });
    const before = await wallet.getBalance(fx.reseller.id);
    const summary = await recon.recover();
    assert.ok(summary.released >= 1);
    const after = await wallet.getBalance(fx.reseller.id);
    assert.equal(after.reservedMinor, before.reservedMinor - 1000, 'reservation freed');
    assert.equal(after.availableMinor, before.availableMinor + 1000);
    const reloaded = await orders.getOrder(order.id);
    assert.equal(reloaded.status, 'failed');
    const holdRow = await wallet.getHold(hold.id);
    assert.equal(holdRow.status, 'released');
  });

  await t.test('expired reservation on a dispatched order stays reserved and opens a case', async () => {
    const { order, hold } = await newReservedOrder('rec-uncertain', { expiresAt: new Date(Date.now() - 60_000) });
    await orders.transition(
      {
        orderId: order.id,
        to: 'issuing',
        eventType: 'issuing',
        idempotencyKey: `order:${order.id}:issuing`,
      },
      { runner: pool },
    );
    await issuanceRepo.patchOrderDispatched(order.id, null, pool);

    const before = await wallet.getBalance(fx.reseller.id);
    const summary = await recon.recover();
    assert.ok(summary.reconciled >= 1);
    const after = await wallet.getBalance(fx.reseller.id);
    assert.equal(after.reservedMinor, before.reservedMinor, 'uncertain hold kept intact');

    const holdRow = await wallet.getHold(hold.id);
    assert.equal(holdRow.status, 'active');
    const cases = await pool.query(
      "SELECT * FROM reconciliation_cases WHERE order_id = $1 AND case_type = 'order_stuck' AND status <> 'resolved'",
      [order.id],
    );
    assert.equal(cases.rowCount, 1);
  });

  await t.test('stuck issuing order is moved to reconciliation without recreating', async () => {
    const { order } = await newReservedOrder('rec-stuck');
    await orders.transition(
      {
        orderId: order.id,
        to: 'issuing',
        eventType: 'issuing',
        idempotencyKey: `order:${order.id}:issuing`,
      },
      { runner: pool },
    );
    await issuanceRepo.patchOrderDispatched(order.id, null, pool);

    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      await client.query("UPDATE voucher_orders SET updated_at = now() - interval '2 hours' WHERE id = $1", [order.id]);
      await client.query("SET session_replication_role = 'origin'");
    } finally {
      client.release();
    }

    const summary = await recon.recover();
    assert.ok(summary.stuckOrders >= 1);
    const reloaded = await orders.getOrder(order.id);
    assert.equal(reloaded.status, 'needs_reconciliation');
    assert.equal(reloaded.reconciliation_reason, 'stuck_issuing');
    const cases = await pool.query(
      "SELECT count(*)::int AS c FROM reconciliation_cases WHERE order_id = $1 AND case_type = 'order_stuck' AND status <> 'resolved'",
      [order.id],
    );
    assert.equal(cases.rows[0].c, 1);
  });
});
