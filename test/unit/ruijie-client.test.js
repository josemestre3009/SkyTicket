import test from 'node:test';
import assert from 'node:assert/strict';
import { Cipher } from '../../src/lib/crypto.js';
import { createRuijieClient } from '../../src/ruijie/client.js';
import { ENDPOINTS } from '../../src/ruijie/endpoints.js';
import { RUIJIE_KIND } from '../../src/ruijie/errors.js';
import { createMemoryCircuitStore, createMemoryTokenStore } from '../../src/ruijie/stores.js';
import { createRuijieHandlers, createSimulatedFetch, fixtures, pathIs } from '../../src/ruijie/simulation.js';

function makeClient(handlers, options = {}) {
  const sim = createSimulatedFetch(handlers);
  const clockRef = { now: 1_700_000_000_000 };
  const client = createRuijieClient({
    connection: { id: 'conn-1', baseUrl: 'https://cloud-eu.ruijienetworks.com', appId: 'app', appSecret: 'secret', apiToken: 'const' },
    cipher: Cipher.fromKey('unit-test-key'),
    fetchImpl: sim.fetch,
    clock: () => clockRef.now,
    sleep: () => Promise.resolve(),
    jitter: () => 0.5,
    tokenStore: createMemoryTokenStore(),
    circuitStore: createMemoryCircuitStore(),
    circuitFailureThreshold: options.threshold ?? 5,
    circuitResetTimeoutMs: options.reset ?? 30000,
  });
  return { client, sim, clockRef };
}

const countPath = (sim, path) => sim.calls.filter((call) => call.path === path).length;

test('reuses a cached token across reads', async () => {
  const { client, sim } = makeClient(createRuijieHandlers());
  await client.getAccount();
  await client.getAccount();
  assert.equal(countPath(sim, ENDPOINTS.ACCESS_TOKEN), 1);
  assert.equal(countPath(sim, ENDPOINTS.ACCOUNT_INFO), 2);
});

test('renews and repeats a read once on token expiry (code 4)', async () => {
  let accountCalls = 0;
  const { client, sim } = makeClient([
    { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) },
    { match: pathIs(ENDPOINTS.TOKEN_REFRESH, 'GET'), respond: () => ({ body: fixtures.refresh }) },
    {
      match: pathIs(ENDPOINTS.ACCOUNT_INFO, 'GET'),
      respond: () => {
        accountCalls += 1;
        return { body: accountCalls === 1 ? fixtures.errors.tokenExpired : fixtures.account };
      },
    },
  ]);
  const account = await client.getAccount();
  assert.equal(account.account, 'demo-account');
  assert.equal(accountCalls, 2);
  assert.equal(countPath(sim, ENDPOINTS.ACCESS_TOKEN), 1);
  assert.equal(countPath(sim, ENDPOINTS.TOKEN_REFRESH), 1);
});

test('falls back to a fresh token when refresh rejects a stale cached token', async () => {
  let accountCalls = 0;
  let tokenCalls = 0;
  const { client, sim } = makeClient([
    {
      match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'),
      respond: () => {
        tokenCalls += 1;
        return { body: fixtures.token };
      },
    },
    { match: pathIs(ENDPOINTS.TOKEN_REFRESH, 'GET'), respond: () => ({ body: fixtures.errors.tokenInvalid }) },
    {
      match: pathIs(ENDPOINTS.ACCOUNT_INFO, 'GET'),
      respond: () => {
        accountCalls += 1;
        return { body: accountCalls === 1 ? fixtures.errors.tokenInvalid : fixtures.account };
      },
    },
  ]);
  const account = await client.getAccount();
  assert.equal(account.account, 'demo-account');
  assert.equal(accountCalls, 2);
  assert.equal(countPath(sim, ENDPOINTS.TOKEN_REFRESH), 1);
  assert.equal(tokenCalls, 2, 'a fresh token is fetched after refresh auth failure');
});

test('does not repeat voucher create on token expiry and flags no reconciliation', async () => {
  const { client, sim } = makeClient([
    { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) },
    { match: pathIs(ENDPOINTS.TOKEN_REFRESH, 'GET'), respond: () => ({ body: fixtures.refresh }) },
    { match: (call) => call.path.startsWith('/service/api/open/auth/voucher/create/'), respond: () => ({ body: fixtures.errors.tokenExpired }) },
  ]);
  await assert.rejects(
    () => client.createVouchers('12345', { quantity: 1, profile: 'p', userGroupId: 1 }),
    (err) => {
      assert.equal(err.kind, RUIJIE_KIND.AUTH);
      assert.equal(err.needsReconciliation, false);
      return true;
    },
  );
  assert.equal(sim.calls.filter((call) => call.path.startsWith('/service/api/open/auth/voucher/create/')).length, 1);
  assert.equal(countPath(sim, ENDPOINTS.TOKEN_REFRESH), 0);
});

test('opens the circuit after repeated recoverable failures and blocks create before reservation', async () => {
  const { client, sim } = makeClient(
    [
      { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) },
      { match: (call) => call.path.startsWith('/service/api/open/auth/voucher/create/'), respond: () => ({ body: fixtures.errors.timeout }) },
    ],
    { threshold: 2 },
  );
  const body = { quantity: 1, profile: 'p', userGroupId: 1 };
  await assert.rejects(() => client.createVouchers('1', body), (err) => err.kind === RUIJIE_KIND.RECOVERABLE);
  await assert.rejects(() => client.createVouchers('1', body), (err) => err.kind === RUIJIE_KIND.RECOVERABLE);
  assert.equal(await client.isCircuitOpen(), true);

  await assert.rejects(() => client.createVouchers('1', body), (err) => err.kind === RUIJIE_KIND.CIRCUIT_OPEN);
  assert.equal(sim.calls.filter((call) => call.path.startsWith('/service/api/open/auth/voucher/create/')).length, 2);
});

test('closes the circuit after a controlled half-open probe', async () => {
  let failing = true;
  const { client, sim, clockRef } = makeClient(
    [
      { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) },
      {
        match: (call) => call.path.startsWith('/service/api/open/auth/voucher/create/'),
        respond: () => ({ body: failing ? fixtures.errors.timeout : fixtures.voucherCreate }),
      },
    ],
    { threshold: 1, reset: 1000 },
  );
  const body = { quantity: 2, profile: 'p', userGroupId: 1 };
  await assert.rejects(() => client.createVouchers('1', body), (err) => err.kind === RUIJIE_KIND.RECOVERABLE);
  assert.equal(await client.isCircuitOpen(), true);

  clockRef.now += 2000;
  failing = false;
  const result = await client.createVouchers('1', body);
  assert.equal(result.list.length, 2);
  assert.equal(result.partial, false);
  assert.equal(await client.isCircuitOpen(), false);
  assert.equal(sim.calls.filter((call) => call.path.startsWith('/service/api/open/auth/voucher/create/')).length, 2);
});

test('degrades reads when the circuit is open', async () => {
  const { client } = makeClient(
    [
      { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) },
      { match: pathIs(ENDPOINTS.ACCOUNT_INFO, 'GET'), respond: () => ({ body: fixtures.errors.internal }) },
    ],
    { threshold: 1 },
  );
  await assert.rejects(() => client.getAccount(), (err) => err.kind === RUIJIE_KIND.RECOVERABLE);
  await assert.rejects(() => client.listVouchers('1'), (err) => err.kind === RUIJIE_KIND.CIRCUIT_OPEN);
});

test('flags partial voucher create responses', async () => {
  const partial = { code: 0, voucherData: { code: 0, count: 1, list: [{ uuid: 'x', codeNo: 'c' }] } };
  const { client } = makeClient([
    { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: fixtures.token }) },
    { match: (call) => call.path.startsWith('/service/api/open/auth/voucher/create/'), respond: () => ({ body: partial }) },
  ]);
  const result = await client.createVouchers('1', { quantity: 2, profile: 'p', userGroupId: 1 });
  assert.equal(result.partial, true);
});
