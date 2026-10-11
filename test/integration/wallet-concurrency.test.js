import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createReseller, createWallet, teardownReseller, suffix } from './reseller-fixtures.js';
import { createWalletService } from '../../src/modules/wallet/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('wallet concurrency on PostgreSQL', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createWalletService({ runner: pool });
  const reseller = await createReseller(pool);
  await createWallet(pool, reseller.id, { availableMinor: 0 });
  const s = suffix();
  await service.recharge({ resellerId: reseller.id, amountMinor: 1000, reason: 'seed', idempotencyKey: `seed-${s}` });

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await close();
  });

  await t.test('competing reserves never exceed available nor go negative', async () => {
    const results = await Promise.allSettled([
      service.reserve({ resellerId: reseller.id, amountMinor: 600, reserveKey: `CR-A-${s}` }),
      service.reserve({ resellerId: reseller.id, amountMinor: 600, reserveKey: `CR-B-${s}` }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one reserve should succeed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.code, 'insufficient_funds');

    const bal = await service.getBalance(reseller.id);
    assert.equal(bal.availableMinor, 400);
    assert.equal(bal.reservedMinor, 600);
    assert.ok(bal.availableMinor >= 0 && bal.reservedMinor >= 0);
  });

  await t.test('concurrent idempotent recharges apply once', async () => {
    const key = `CC-${s}`;
    const results = await Promise.all([
      service.recharge({ resellerId: reseller.id, amountMinor: 500, reason: 'race', idempotencyKey: key }),
      service.recharge({ resellerId: reseller.id, amountMinor: 500, reason: 'race', idempotencyKey: key }),
    ]);
    const replayed = results.filter((r) => r.replayed).length;
    assert.equal(replayed, 1, 'one call applies, the other replays');
    const bal = await service.getBalance(reseller.id);
    assert.equal(bal.availableMinor, 900);
  });

  await t.test('many concurrent reserves keep the ledger sum equal to projection', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `CD-${s}-${i}`);
    await Promise.allSettled(
      keys.map((reserveKey) => service.reserve({ resellerId: reseller.id, amountMinor: 100, reserveKey })),
    );
    const bal = await service.getBalance(reseller.id);
    const sum = await pool.query(
      `SELECT COALESCE(SUM(available_delta),0)::bigint AS a, COALESCE(SUM(reserved_delta),0)::bigint AS r
       FROM ledger_entries WHERE reseller_id = $1`,
      [reseller.id],
    );
    assert.equal(Number(sum.rows[0].a), bal.availableMinor);
    assert.equal(Number(sum.rows[0].r), bal.reservedMinor);
    assert.ok(bal.availableMinor >= 0 && bal.reservedMinor >= 0);
  });
});
