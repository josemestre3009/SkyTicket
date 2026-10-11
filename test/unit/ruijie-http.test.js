import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../src/ruijie/http.js';
import { RUIJIE_KIND } from '../../src/ruijie/errors.js';
import { createSimulatedFetch } from '../../src/ruijie/simulation.js';

function client(fetchImpl, overrides = {}) {
  const sleeps = [];
  const instance = createHttpClient({
    baseUrl: 'https://cloud-eu.ruijienetworks.com',
    fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    jitter: () => 0.5,
    backoffBaseMs: 100,
    backoffCapMs: 1000,
    ...overrides,
  });
  return { instance, sleeps };
}

function sequence(responses) {
  let index = 0;
  const handlers = [
    {
      match: () => true,
      respond: () => {
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response;
      },
    },
  ];
  return createSimulatedFetch(handlers);
}

test('GET retries a recoverable server error up to three attempts then succeeds', async () => {
  const sim = sequence([{ status: 500, body: { code: -1002 } }, { status: 500, body: { code: -1002 } }, { status: 200, body: { code: 0, ok: true } }]);
  const { instance, sleeps } = client(sim.fetch);
  const result = await instance.get('/service/api/org/account/info');
  assert.equal(result.ok, true);
  assert.equal(sim.calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test('GET stops after three failed attempts', async () => {
  const sim = sequence([{ status: 500, body: { code: -1002 } }]);
  const { instance } = client(sim.fetch);
  await assert.rejects(() => instance.get('/service/api/org/account/info'), (err) => err.kind === RUIJIE_KIND.RECOVERABLE);
  assert.equal(sim.calls.length, 3);
});

test('GET honors Retry-After on HTTP 429', async () => {
  const sim = sequence([{ status: 429, headers: { 'retry-after': '2' }, body: { code: 0 } }, { status: 200, body: { code: 0, ok: true } }]);
  const { instance, sleeps } = client(sim.fetch);
  const result = await instance.get('/service/api/org/account/info');
  assert.equal(result.ok, true);
  assert.equal(sim.calls.length, 2);
  assert.equal(sleeps[0], 2000);
});

test('does not retry non-recoverable logical errors', async () => {
  const sim = sequence([{ status: 200, body: { code: 2, msg: 'Invalid parameter.' } }]);
  const { instance } = client(sim.fetch);
  await assert.rejects(() => instance.get('/service/api/org/account/info'), (err) => err.kind === RUIJIE_KIND.NON_RECOVERABLE);
  assert.equal(sim.calls.length, 1);
});

test('retries a recoverable logical code (7) up to three attempts', async () => {
  const sim = sequence([{ status: 200, body: { code: 7 } }]);
  const { instance } = client(sim.fetch);
  await assert.rejects(() => instance.get('/service/api/org/account/info'), (err) => err.kind === RUIJIE_KIND.RECOVERABLE);
  assert.equal(sim.calls.length, 3);
});

test('retries transient network failures', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('socket hang up');
    return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ code: 0, ok: true }), json: async () => ({ code: 0, ok: true }) };
  };
  const { instance } = client(fetchImpl);
  const result = await instance.get('/service/api/org/account/info');
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
});

test('never leaks access_token in error endpoints', async () => {
  const sim = sequence([{ status: 500, body: { code: -1002 } }]);
  const { instance } = client(sim.fetch);
  await assert.rejects(
    () => instance.get('/service/api/org/account/info', { token: 'SUPER-SECRET-TOKEN' }),
    (err) => {
      assert.ok(!err.endpoint.includes('SUPER-SECRET-TOKEN'));
      assert.ok(err.endpoint.includes('access_token=%5BREDACTED%5D') || err.endpoint.includes('access_token=[REDACTED]'));
      return true;
    },
  );
});

test('POST is never retried automatically', async () => {
  const sim = sequence([{ status: 500, body: { code: -1002 } }]);
  const { instance } = client(sim.fetch);
  await assert.rejects(() => instance.post('/service/api/open/auth/voucher/create/1', { token: 't', body: { quantity: 1 } }));
  assert.equal(sim.calls.length, 1);
});
