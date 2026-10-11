import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { recordAudit } from '../../src/lib/audit.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('audit events are append-only and redacted', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const marker = `test.audit.${crypto.randomUUID()}`;

  t.after(async () => {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      await client.query('DELETE FROM audit_events WHERE entity_type = $1', [marker]);
    } finally {
      await client.query("SET session_replication_role = 'origin'").catch(() => {});
      client.release();
    }
    await close();
  });

  await t.test('requires action and entityType', async () => {
    await assert.rejects(() => recordAudit({ entityType: marker }, pool), /requires "action"/);
    await assert.rejects(() => recordAudit({ action: 'x' }, pool), /requires "entityType"/);
  });

  await t.test('stores redacted before/after without plaintext secrets', async () => {
    const { id } = await recordAudit(
      {
        actorRole: 'admin',
        action: 'voucher.reveal',
        entityType: marker,
        entityId: '42',
        before: { status: 'issued', password: 'p@ss', access_token: 'raw-token' },
        after: { code: '1234567890', note: 'kept' },
        reason: 'manual review',
        result: 'success',
      },
      pool,
    );

    const { rows } = await pool.query('SELECT * FROM audit_events WHERE id = $1', [id]);
    const row = rows[0];
    assert.equal(row.before_data.status, 'issued');
    assert.equal(row.before_data.password, '[REDACTED]');
    assert.equal(row.before_data.access_token, '[REDACTED]');
    assert.equal(row.after_data.code, '[REDACTED]');
    assert.equal(row.after_data.note, 'kept');
    assert.equal(row.entity_id, '42');
    assert.equal(row.reason, 'manual review');
  });

  await t.test('rejects updates and deletes at the database level', async () => {
    const { id } = await recordAudit(
      { action: 'price.change', entityType: marker, result: 'success' },
      pool,
    );
    await assert.rejects(() => pool.query('UPDATE audit_events SET reason = $2 WHERE id = $1', [id, 'tamper']));
    await assert.rejects(() => pool.query('DELETE FROM audit_events WHERE id = $1', [id]));
  });
});
