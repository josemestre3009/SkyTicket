import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createOrderService } from '../../src/modules/orders/service.js';
import { createWalletService } from '../../src/modules/wallet/service.js';
import { createReconciliationService } from '../../src/modules/reconciliation/service.js';
import * as issuanceRepo from '../../src/modules/issuance/repository.js';
import { createUser, authFor } from './reseller-fixtures.js';
import { seedTenant, teardownTenant } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('manual reconciliation resolution: permissions, evidence and idempotency', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const orders = createOrderService({ runner: pool });
  const wallet = createWalletService({ runner: pool });
  const recon = createReconciliationService({ runner: pool });
  const admin = await createUser(pool, { role: 'admin' });

  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await close();
  });

  let caseId;
  let orderId;

  await t.test('setup: an uncertain stuck order opens a case', async () => {
    const created = await orders.createOrder({
      auth: authFor(fx.user),
      siteId: fx.site.id,
      packageId: fx.pkg.id,
      quantity: 1,
      localReference: 'resolve-stuck',
    });
    orderId = created.order.id;
    const reserved = await wallet.reserve({
      resellerId: fx.reseller.id,
      amountMinor: Number(created.order.total_minor),
      reserveKey: `order:${orderId}`,
      orderId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await orders.transition(
      {
        orderId,
        to: 'reserved',
        eventType: 'reserved',
        idempotencyKey: `order:${orderId}:reserved`,
        fields: { holdId: reserved.hold.id },
      },
      { runner: pool },
    );
    await orders.transition(
      { orderId, to: 'issuing', eventType: 'issuing', idempotencyKey: `order:${orderId}:issuing` },
      { runner: pool },
    );
    await issuanceRepo.patchOrderDispatched(orderId, null, pool);

    await recon.recover();
    const caseRow = await pool.query(
      "SELECT * FROM reconciliation_cases WHERE order_id = $1 AND case_type = 'order_stuck' AND status <> 'resolved'",
      [orderId],
    );
    assert.equal(caseRow.rowCount, 1);
    caseId = caseRow.rows[0].id;
  });

  await t.test('reseller cannot resolve', async () => {
    await assert.rejects(
      () => recon.resolveCase({ caseId, actor: authFor(fx.user).user, reason: 'x', evidence: { ref: 'y' } }),
      (err) => err.code === 'forbidden',
    );
  });

  await t.test('administrator resolves a confirmed no-emission case once', async () => {
    const before = await wallet.getBalance(fx.reseller.id);
    const out = await recon.resolveCase({
      caseId,
      actor: admin,
      reason: 'Ruijie export shows no voucher',
      evidence: { reference: 'RUIJIE-EXPORT-1' },
      disposition: 'confirmed_no_emission',
    });
    assert.equal(out.replayed, false);
    assert.equal(out.case.status, 'resolved');
    const after = await wallet.getBalance(fx.reseller.id);
    assert.equal(after.reservedMinor, before.reservedMinor - 1000, 'hold released');
    assert.equal(after.availableMinor, before.availableMinor + 1000);
    const reloaded = await orders.getOrder(orderId);
    assert.equal(reloaded.status, 'failed');

    const audit = await pool.query(
      "SELECT * FROM audit_events WHERE action = 'reconciliation.resolve' AND entity_id = $1",
      [caseId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_role, 'admin');
  });

  await t.test('replaying a resolution never double-captures or releases', async () => {
    const before = await wallet.getBalance(fx.reseller.id);
    const out = await recon.resolveCase({
      caseId,
      actor: admin,
      reason: 'again',
      evidence: { reference: 'RUIJIE-EXPORT-1' },
      disposition: 'confirmed_no_emission',
    });
    assert.equal(out.replayed, true);
    const after = await wallet.getBalance(fx.reseller.id);
    assert.equal(after.reservedMinor, before.reservedMinor);
    assert.equal(after.availableMinor, before.availableMinor);
  });

  await t.test('partial issuance resolution stays disabled', async () => {
    const inserted = await pool.query(
      "INSERT INTO reconciliation_cases (case_type, severity, status, reseller_id, summary) VALUES ('partial_issue','high','open',$1,'partial') RETURNING *",
      [fx.reseller.id],
    );
    await assert.rejects(
      () => recon.resolveCase({ caseId: inserted.rows[0].id, actor: admin, reason: 'x', evidence: { ref: 'y' }, disposition: 'confirmed_emitted' }),
      (err) => err.code === 'partial_resolution_disabled',
    );
    await pool.query('DELETE FROM reconciliation_cases WHERE id = $1', [inserted.rows[0].id]);
  });

  await t.test('non-monetary voucher case resolves without moving money', async () => {
    const inserted = await pool.query(
      "INSERT INTO reconciliation_cases (case_type, severity, status, reseller_id, site_id, summary) VALUES ('voucher_local_only','medium','open',$1,$2,'missing') RETURNING *",
      [fx.reseller.id, fx.site.id],
    );
    const before = await wallet.getBalance(fx.reseller.id);
    const out = await recon.resolveCase({
      caseId: inserted.rows[0].id,
      actor: admin,
      reason: 'retention window passed',
      evidence: { reference: 'RUIJIE-EXPORT-2' },
    });
    assert.equal(out.case.status, 'resolved');
    const after = await wallet.getBalance(fx.reseller.id);
    assert.equal(after.availableMinor, before.availableMinor);
    assert.equal(after.reservedMinor, before.reservedMinor);
  });
});
