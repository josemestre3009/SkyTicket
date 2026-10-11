import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import {
  createReseller,
  createUser,
  createSession,
  teardownReseller,
  suffix,
} from './reseller-fixtures.js';
import { createResellerService, RESELLER_STATUS, canEmit, canLogin, canConsult } from '../../src/modules/resellers/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('reseller lifecycle', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createResellerService({ runner: pool });
  const reseller = await createReseller(pool, { status: 'pending' });

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await close();
  });

  await t.test('walks pending -> active -> restricted -> active -> suspended -> closed', async () => {
    let out = await service.setStatus({ resellerId: reseller.id, status: 'active' });
    assert.equal(out.reseller.status, 'active');
    out = await service.setStatus({ resellerId: reseller.id, status: 'restricted' });
    assert.equal(out.reseller.status, 'restricted');
    out = await service.setStatus({ resellerId: reseller.id, status: 'active' });
    assert.equal(out.reseller.status, 'active');
    out = await service.setStatus({ resellerId: reseller.id, status: 'suspended' });
    assert.equal(out.reseller.status, 'suspended');
    out = await service.setStatus({ resellerId: reseller.id, status: 'closed' });
    assert.equal(out.reseller.status, 'closed');
    assert.equal(out.changed, true);
  });

  await t.test('state capability matrix', () => {
    assert.equal(canEmit('active'), true);
    assert.equal(canEmit('restricted'), false);
    assert.equal(canEmit('suspended'), false);
    assert.equal(canConsult('restricted'), true);
    assert.equal(canConsult('suspended'), false);
    assert.equal(canLogin('suspended'), false);
    assert.equal(canLogin('closed'), false);
    assert.equal(canLogin('pending'), false);
    assert.equal(canLogin('active'), true);
    assert.equal(canLogin('restricted'), true);
  });

  await t.test('rejects invalid transition from closed', async () => {
    await assert.rejects(
      () => service.setStatus({ resellerId: reseller.id, status: 'active' }),
      (err) => err.code === 'invalid_transition',
    );
  });

  await t.test('suspension revokes reseller sessions and records audit', async () => {
    const target = await createReseller(pool, { status: 'active' });
    const user = await createUser(pool, { role: 'reseller', resellerId: target.id });
    const session = await createSession(pool, user);

    const out = await service.setStatus({ resellerId: target.id, status: 'suspended', reason: 'fraud' });
    assert.equal(out.revokedSessions, 1);

    const revoked = await pool.query('SELECT revoked_at, revoke_reason FROM sessions WHERE id = $1', [session.id]);
    assert.ok(revoked.rows[0].revoked_at, 'session should be revoked');
    assert.equal(revoked.rows[0].revoke_reason, 'reseller_suspended');

    const audit = await pool.query(
      "SELECT count(*)::int AS c FROM audit_events WHERE reseller_id = $1 AND action = 'reseller.suspension'",
      [target.id],
    );
    assert.equal(audit.rows[0].c, 1);

    await teardownReseller(pool, target.id);
    assert.equal(RESELLER_STATUS.ACTIVE, 'active');
    assert.ok(suffix());
  });
});
