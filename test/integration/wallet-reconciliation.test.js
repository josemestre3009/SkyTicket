import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createReseller, createWallet, teardownReseller, suffix } from './reseller-fixtures.js';
import { createWalletService } from '../../src/modules/wallet/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('ledger/projection reconciliation', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createWalletService({ runner: pool });
  const reseller = await createReseller(pool);
  await createWallet(pool, reseller.id, { availableMinor: 0 });
  const s = suffix();

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await close();
  });

  await t.test('consistent ledger reports no case', async () => {
    await service.recharge({ resellerId: reseller.id, amountMinor: 5000, reason: 'seed', idempotencyKey: `rec-${s}-1` });
    const out = await service.reconcile({ resellerId: reseller.id });
    assert.equal(out.consistent, true);
    assert.equal(out.case, null);
  });

  await t.test('tampered projection is detected and blocked, never auto-corrected', async () => {
    await pool.query('UPDATE wallets SET available_minor = available_minor + 123 WHERE reseller_id = $1', [reseller.id]);

    const out = await service.reconcile({ resellerId: reseller.id });
    assert.equal(out.consistent, false);
    assert.equal(out.expected.available, 5000);
    assert.equal(out.actual.available, 5123);
    assert.ok(out.case, 'a reconciliation case is opened');
    assert.equal(out.case.case_type, 'wallet_projection_mismatch');

    const wallet = await pool.query('SELECT available_minor, integrity_blocked FROM wallets WHERE reseller_id = $1', [reseller.id]);
    assert.equal(Number(wallet.rows[0].available_minor), 5123, 'projection left untouched');
    assert.equal(wallet.rows[0].integrity_blocked, true);

    await assert.rejects(
      () => service.reserve({ resellerId: reseller.id, amountMinor: 100, reserveKey: `blk-${s}` }),
      (err) => err.code === 'integrity_blocked',
    );
    await assert.rejects(
      () => service.recharge({ resellerId: reseller.id, amountMinor: 100, reason: 'x', idempotencyKey: `blk-${s}-r` }),
      (err) => err.code === 'integrity_blocked',
    );
  });

  await t.test('repeated reconciliation reuses the open case', async () => {
    const first = await service.reconcile({ resellerId: reseller.id });
    const second = await service.reconcile({ resellerId: reseller.id });
    assert.equal(first.case.id, second.case.id);
    const count = await pool.query(
      "SELECT count(*)::int AS c FROM reconciliation_cases WHERE wallet_id = $1 AND status <> 'resolved'",
      [first.case.wallet_id],
    );
    assert.equal(count.rows[0].c, 1);
  });
});
