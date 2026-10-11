import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createReseller, createWallet, teardownReseller, suffix } from './reseller-fixtures.js';
import { createWalletService } from '../../src/modules/wallet/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('wallet holds: reserve/capture/release with partial settlement', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createWalletService({ runner: pool });
  const reseller = await createReseller(pool);
  await createWallet(pool, reseller.id, { availableMinor: 10000 });
  const s = suffix();

  const balance = () => service.getBalance(reseller.id);

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await close();
  });

  let hold1;

  await t.test('reserve moves available to reserved', async () => {
    const r = await service.reserve({ resellerId: reseller.id, amountMinor: 3000, reserveKey: `R1-${s}` });
    hold1 = r.hold;
    assert.equal(r.replayed, false);
    const bal = await balance();
    assert.equal(bal.availableMinor, 7000);
    assert.equal(bal.reservedMinor, 3000);
  });

  await t.test('repeated reserve with same key is idempotent', async () => {
    const again = await service.reserve({ resellerId: reseller.id, amountMinor: 3000, reserveKey: `R1-${s}` });
    assert.equal(again.replayed, true);
    assert.equal(again.hold.id, hold1.id);
    assert.equal((await balance()).reservedMinor, 3000);
  });

  await t.test('capture is applied exactly once', async () => {
    const c = await service.capture({ holdId: hold1.id, captureKey: `C1-${s}` });
    assert.equal(c.replayed, false);
    assert.equal(c.hold.status, 'captured');
    const bal = await balance();
    assert.equal(bal.availableMinor, 7000);
    assert.equal(bal.reservedMinor, 0);

    const again = await service.capture({ holdId: hold1.id, captureKey: `C1-${s}` });
    assert.equal(again.replayed, true);
    assert.equal((await balance()).reservedMinor, 0);
  });

  await t.test('partial capture then release remainder settles correctly', async () => {
    const r = await service.reserve({ resellerId: reseller.id, amountMinor: 3000, reserveKey: `R2-${s}` });
    const cap = await service.capture({ holdId: r.hold.id, captureKey: `C2-${s}`, amountMinor: 1000 });
    assert.equal(Number(cap.hold.captured_minor), 1000);
    assert.equal(Number(cap.hold.released_minor), 0);
    assert.equal((await balance()).reservedMinor, 2000);

    const rel = await service.release({ holdId: r.hold.id, releaseKey: `L2-${s}`, amountMinor: 2000, reason: 'partial' });
    assert.equal(Number(rel.hold.captured_minor), 1000);
    assert.equal(Number(rel.hold.released_minor), 2000);
    assert.equal(rel.hold.status, 'captured');
    const bal = await balance();
    assert.equal(bal.availableMinor, 6000);
    assert.equal(bal.reservedMinor, 0);
  });

  await t.test('invalid transitions are rejected', async () => {
    await assert.rejects(
      () => service.capture({ holdId: hold1.id, captureKey: `C1b-${s}` }),
      (err) => err.code === 'nothing_to_capture',
    );

    const released = await service.reserve({ resellerId: reseller.id, amountMinor: 500, reserveKey: `R3-${s}` });
    await service.release({ holdId: released.hold.id, releaseKey: `L3-${s}` });
    await assert.rejects(
      () => service.capture({ holdId: released.hold.id, captureKey: `C3-${s}` }),
      (err) => err.code === 'hold_not_active',
    );
    await assert.rejects(
      () => service.release({ holdId: released.hold.id, releaseKey: `L3b-${s}` }),
      (err) => err.code === 'hold_already_released',
    );
  });

  await t.test('reserve beyond available is rejected', async () => {
    await assert.rejects(
      () => service.reserve({ resellerId: reseller.id, amountMinor: 999999, reserveKey: `R4-${s}` }),
      (err) => err.code === 'insufficient_funds',
    );
  });
});
