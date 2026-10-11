import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { createHttpClient } from '../../src/ruijie/http.js';
import { createTokenManager } from '../../src/ruijie/resilience.js';
import { createPgTokenStore } from '../../src/ruijie/stores.js';
import { createSimulatedFetch, fixtures, pathIs } from '../../src/ruijie/simulation.js';
import { ENDPOINTS } from '../../src/ruijie/endpoints.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('persistent encrypted token cache', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-test-key');
  const appId = `app-${crypto.randomUUID()}`;
  let connectionId;

  const { rows } = await pool.query(
    `INSERT INTO ruijie_connections (region, base_url, app_id, app_secret_encrypted)
     VALUES ('eu', 'https://example.test', $1, 'v1.x.y.z.w') RETURNING id`,
    [appId],
  );
  connectionId = rows[0].id;

  t.after(async () => {
    await pool.query('DELETE FROM ruijie_connections WHERE id = $1', [connectionId]);
    await close();
  });

  const store = createPgTokenStore(pool);

  function buildManager(sim) {
    return createTokenManager({
      connectionId,
      cipher,
      store,
      http: createHttpClient({ baseUrl: 'https://example.test', fetchImpl: sim.fetch, sleep: () => Promise.resolve() }),
      credentials: { appId, appSecret: 'secret', apiToken: 'const' },
      clock: () => 1_700_000_000_000,
    });
  }

  await t.test('persists the token encrypted, never in plaintext', async () => {
    await store.write(connectionId, null);
    const sim = createSimulatedFetch([{ match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) }]);
    const manager = buildManager(sim);
    const token = await manager.getAccessToken();
    assert.equal(token, fixtures.token.accessToken);

    const { rows: stored } = await pool.query('SELECT access_token_encrypted FROM ruijie_connections WHERE id = $1', [connectionId]);
    assert.ok(stored[0].access_token_encrypted);
    assert.notEqual(stored[0].access_token_encrypted, token);
    assert.ok(!stored[0].access_token_encrypted.includes(token));

    const record = await store.read(connectionId);
    assert.equal(cipher.decrypt(record.encrypted), token);
    assert.ok(record.expiresAt instanceof Date);
  });

  await t.test('reuses the cached token without a second fetch', async () => {
    await store.write(connectionId, null);
    const sim = createSimulatedFetch([{ match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) }]);
    const manager = buildManager(sim);
    await manager.getAccessToken();
    await manager.getAccessToken();
    assert.equal(sim.calls.length, 1);
  });

  await t.test('serializes concurrent renewals under an advisory lock', async () => {
    await store.write(connectionId, null);
    const sim = createSimulatedFetch([{ match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) }]);
    const manager = buildManager(sim);
    const tokens = await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(sim.calls.length, 1);
  });

  await t.test('invalidate clears the persisted token', async () => {
    const sim = createSimulatedFetch([{ match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) }]);
    const manager = buildManager(sim);
    await manager.getAccessToken();
    await manager.invalidate();
    const record = await store.read(connectionId);
    assert.equal(record, null);
  });
});
