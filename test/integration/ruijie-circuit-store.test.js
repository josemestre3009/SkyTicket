import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { createCircuitBreaker, CIRCUIT_STATE } from '../../src/ruijie/resilience.js';
import { createPgCircuitStore } from '../../src/ruijie/stores.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('persistent circuit breaker', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const store = createPgCircuitStore(pool);
  const clockRef = { now: 1_700_000_000_000 };

  const { rows } = await pool.query(
    `INSERT INTO ruijie_connections (region, base_url, app_id, app_secret_encrypted)
     VALUES ('eu', 'https://example.test', $1, 'v1.x.y.z.w') RETURNING id`,
    [`circuit-${crypto.randomUUID()}`],
  );
  const connectionId = rows[0].id;

  t.after(async () => {
    await pool.query('DELETE FROM ruijie_connections WHERE id = $1', [connectionId]);
    await close();
  });

  const build = () =>
    createCircuitBreaker({
      connectionId,
      store,
      clock: () => clockRef.now,
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });

  await t.test('opens after the failure threshold and persists the state', async () => {
    const breaker = build();
    await breaker.recordFailure();
    await breaker.recordFailure();
    assert.equal(await breaker.isOpen(), true);

    const { rows: persisted } = await pool.query(
      'SELECT circuit_state, consecutive_failures FROM ruijie_connections WHERE id = $1',
      [connectionId],
    );
    assert.equal(persisted[0].circuit_state, CIRCUIT_STATE.OPEN);
    assert.equal(persisted[0].consecutive_failures, 2);
  });

  await t.test('blocks requests while open and recovers through half-open', async () => {
    const breaker = build();
    assert.equal(await breaker.allowRequest(), false);

    clockRef.now += 1500;
    assert.equal(await breaker.allowRequest(), true);
    const { rows: half } = await pool.query('SELECT circuit_state FROM ruijie_connections WHERE id = $1', [connectionId]);
    assert.equal(half[0].circuit_state, CIRCUIT_STATE.HALF_OPEN);

    await breaker.recordSuccess();
    const { rows: closed } = await pool.query(
      'SELECT circuit_state, consecutive_failures FROM ruijie_connections WHERE id = $1',
      [connectionId],
    );
    assert.equal(closed[0].circuit_state, CIRCUIT_STATE.CLOSED);
    assert.equal(closed[0].consecutive_failures, 0);
  });
});
