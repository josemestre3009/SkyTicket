import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createReseller, createWallet, createUser, teardownReseller, suffix } from './reseller-fixtures.js';
import { createWalletService } from '../../src/modules/wallet/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('wallet ledger (append-only, idempotent admin money)', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createWalletService({ runner: pool });
  const reseller = await createReseller(pool);
  await createWallet(pool, reseller.id);
  const admin = await createUser(pool, { role: 'admin' });
  const s = suffix();

  const balance = () => service.getBalance(reseller.id);
  const ledgerSum = async () => pool.query(
    'SELECT COALESCE(SUM(available_delta),0)::bigint AS a, COALESCE(SUM(reserved_delta),0)::bigint AS r FROM ledger_entries WHERE reseller_id = $1',
    [reseller.id],
  );

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await close();
  });

  await t.test('recharge updates projection and ledger sum matches', async () => {
    const r = await service.recharge({
      resellerId: reseller.id,
      amountMinor: 5000,
      idempotencyKey: `recharge-${s}-1`,
      reason: 'pilot funding',
      actor: admin,
    });
    assert.equal(r.replayed, false);
    const bal = await balance();
    assert.equal(bal.availableMinor, 5000);
    assert.equal(bal.totalMinor, 5000);
    const sum = await ledgerSum();
    assert.equal(Number(sum.rows[0].a), bal.availableMinor);
  });

  await t.test('repeated recharge with same reference applies once', async () => {
    const params = {
      resellerId: reseller.id,
      amountMinor: 3000,
      idempotencyKey: `recharge-${s}-2`,
      reason: 'top up',
      actor: admin,
    };
    const first = await service.recharge(params);
    const second = await service.recharge(params);
    assert.equal(second.replayed, true);
    assert.equal(second.entry.id, first.entry.id);
    assert.equal((await balance()).availableMinor, 8000);
  });

  await t.test('rejects recharge without reason and leaves balance unchanged', async () => {
    await assert.rejects(
      () => service.recharge({ resellerId: reseller.id, amountMinor: 100, idempotencyKey: `recharge-${s}-nr` }),
      (err) => err.code === 'reason_required',
    );
    assert.equal((await balance()).availableMinor, 8000);
  });

  await t.test('adjustment debit requires evidence', async () => {
    await assert.rejects(
      () => service.adjustment({
        resellerId: reseller.id,
        direction: 'debit',
        amountMinor: 500,
        reason: 'correction',
        idempotencyKey: `adj-${s}-1`,
      }),
      (err) => err.code === 'evidence_required',
    );
    const ok = await service.adjustment({
      resellerId: reseller.id,
      direction: 'debit',
      amountMinor: 500,
      reason: 'correction',
      evidence: { ticket: 'INC-1' },
      idempotencyKey: `adj-${s}-2`,
    });
    assert.equal(ok.replayed, false);
    assert.equal((await balance()).availableMinor, 7500);
  });

  await t.test('debit beyond available balance is rejected', async () => {
    await assert.rejects(
      () => service.adjustment({
        resellerId: reseller.id,
        direction: 'debit',
        amountMinor: 999999,
        reason: 'too much',
        evidence: {},
        idempotencyKey: `adj-${s}-3`,
      }),
      (err) => err.code === 'insufficient_funds',
    );
  });

  await t.test('reversal is unique and never deletes the original', async () => {
    const recharge = await service.recharge({
      resellerId: reseller.id,
      amountMinor: 2000,
      idempotencyKey: `recharge-${s}-3`,
      reason: 'mistake',
      actor: admin,
    });
    const reversed = await service.reverse({ entryId: recharge.entry.id, reason: 'undo' });
    assert.equal(reversed.replayed, false);
    assert.equal(reversed.entry.entry_type, 'reversal');
    assert.equal(reversed.entry.reversal_of_id, recharge.entry.id);
    assert.equal((await balance()).availableMinor, 7500);

    const again = await service.reverse({ entryId: recharge.entry.id, reason: 'undo again' });
    assert.equal(again.replayed, true);
    assert.equal(again.entry.id, reversed.entry.id);

    const stillThere = await pool.query('SELECT reason FROM ledger_entries WHERE id = $1', [recharge.entry.id]);
    assert.equal(stillThere.rows[0].reason, 'mistake');
  });

  await t.test('ledger is append-only at the DB level', async () => {
    const client = await pool.connect();
    try {
      const entry = await client.query('SELECT id FROM ledger_entries WHERE reseller_id = $1 LIMIT 1', [reseller.id]);
      await assert.rejects(() => client.query('UPDATE ledger_entries SET reason = $2 WHERE id = $1', [entry.rows[0].id, 'tamper']));
      await assert.rejects(() => client.query('DELETE FROM ledger_entries WHERE id = $1', [entry.rows[0].id]));
    } finally {
      client.release();
    }
  });
});
