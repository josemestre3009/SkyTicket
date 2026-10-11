import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { TEST_DATABASE_URL, hasDb } from '../helpers/db.js';
import { createReseller, teardownReseller } from '../integration/reseller-fixtures.js';
import { createWalletService } from '../../src/modules/wallet/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

/**
 * Regression for the wallet lock-upgrade deadlock found by the task 11.3 volume
 * run: concurrent captures on the same wallet each inserted a ledger row (FK
 * KEY SHARE on the wallet) and then requested the wallet's exclusive lock,
 * deadlocking with PostgreSQL error 40P01. Settlement now locks the wallet
 * first (wallet -> hold), so both capture and release must settle cleanly.
 */
test('concurrent hold settlement never deadlocks on one wallet', { skip, timeout: 60000 }, async (t) => {
  const silent = { log() {}, warn() {} };
  await runMigrations({ connectionString: TEST_DATABASE_URL, logger: silent });

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 32 });
  const wallet = createWalletService({ runner: pool });
  const reseller = await createReseller(pool);

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await pool.end();
  });

  await wallet.ensureWallet(reseller.id);
  await wallet.recharge({
    resellerId: reseller.id,
    amountMinor: 100000,
    reason: 'seed',
    idempotencyKey: `seed-${reseller.id}`,
  });

  const batch = 24;

  async function reserveBatch(prefix) {
    const holds = [];
    for (let i = 0; i < batch; i += 1) {
      const { hold } = await wallet.reserve({
        resellerId: reseller.id,
        amountMinor: 1000,
        reserveKey: `${prefix}-${i}`,
      });
      holds.push(hold);
    }
    return holds;
  }

  await t.test('concurrent captures all succeed', async () => {
    const holds = await reserveBatch('cap');
    const results = await Promise.allSettled(
      holds.map((hold, i) => wallet.capture({ holdId: hold.id, captureKey: `cap-${i}` })),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.deepEqual(
      rejected.map((r) => r.reason?.code ?? r.reason?.message),
      [],
      'no capture may deadlock or fail',
    );

    const balance = await wallet.getBalance(reseller.id);
    assert.equal(balance.reservedMinor, 0, 'every hold settled');
    assert.equal(balance.availableMinor, 100000 - batch * 1000, 'captured once per hold');
    const integrity = await wallet.reconcile({ resellerId: reseller.id });
    assert.equal(integrity.consistent, true, 'projection equals ledger, non-negative');
  });

  await t.test('concurrent releases all succeed', async () => {
    const holds = await reserveBatch('rel');
    const results = await Promise.allSettled(
      holds.map((hold, i) => wallet.release({ holdId: hold.id, releaseKey: `rel-${i}`, reason: 'test' })),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.deepEqual(
      rejected.map((r) => r.reason?.code ?? r.reason?.message),
      [],
      'no release may deadlock or fail',
    );

    const balance = await wallet.getBalance(reseller.id);
    assert.equal(balance.reservedMinor, 0, 'every reservation released');
    assert.equal(balance.availableMinor, 100000 - batch * 1000, 'release returns the reservation');
    const integrity = await wallet.reconcile({ resellerId: reseller.id });
    assert.equal(integrity.consistent, true, 'projection equals ledger, non-negative');
  });
});
