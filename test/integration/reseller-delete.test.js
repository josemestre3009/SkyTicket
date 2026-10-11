import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createReseller, createUser, createSession, createWallet, teardownReseller } from './reseller-fixtures.js';
import { createResellerService } from '../../src/modules/resellers/service.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('safe reseller deletion', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const service = createResellerService({ runner: pool });
  const reseller = await createReseller(pool, { status: 'active' });
  await createWallet(pool, reseller.id, { availableMinor: 5000 });
  const user = await createUser(pool, { role: 'reseller', resellerId: reseller.id });
  const session = await createSession(pool, user);

  t.after(async () => {
    await teardownReseller(pool, reseller.id);
    await close();
  });

  const result = await service.deleteReseller({ resellerId: reseller.id });
  assert.equal(result.deleted, true);
  assert.equal(result.reseller.status, 'closed');
  assert.ok(result.reseller.archived_at);
  assert.equal(result.revokedSessions, 1);

  const live = await service.listResellers({});
  assert.ok(!live.some((row) => row.id === reseller.id));

  const stored = await pool.query('SELECT status, archived_at FROM resellers WHERE id = $1', [reseller.id]);
  assert.equal(stored.rows[0].status, 'closed');
  assert.ok(stored.rows[0].archived_at);

  const wallet = await pool.query('SELECT id FROM wallets WHERE reseller_id = $1', [reseller.id]);
  assert.equal(wallet.rowCount, 1, 'financial wallet history is preserved');

  const storedSession = await pool.query('SELECT revoked_at, revoke_reason FROM sessions WHERE id = $1', [session.id]);
  assert.ok(storedSession.rows[0].revoked_at);
  assert.equal(storedSession.rows[0].revoke_reason, 'reseller_deleted');

  const audit = await pool.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE reseller_id = $1 AND action = 'reseller.delete'",
    [reseller.id],
  );
  assert.equal(audit.rows[0].count, 1);

  const replay = await service.deleteReseller({ resellerId: reseller.id });
  assert.equal(replay.deleted, false);
});
