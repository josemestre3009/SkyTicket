import test from 'node:test';
import assert from 'node:assert/strict';
import { Cipher } from '../../src/lib/crypto.js';
import { createRuijieClient } from '../../src/ruijie/client.js';
import { createMemoryCircuitStore, createMemoryTokenStore } from '../../src/ruijie/stores.js';
import { createRuijieHandlers, createSimulatedFetch, fixtures } from '../../src/ruijie/simulation.js';
import { syncPaginated, syncUserGroups, syncVouchers } from '../../src/ruijie/sync.js';

function makeClient(chunkSize) {
  const sim = createSimulatedFetch(createRuijieHandlers(fixtures, { chunkSize }));
  const client = createRuijieClient({
    connection: { id: 'conn-sync', baseUrl: 'https://cloud-eu.ruijienetworks.com', appId: 'app', appSecret: 'secret', apiToken: 'const' },
    cipher: Cipher.fromKey('unit-test-key'),
    fetchImpl: sim.fetch,
    clock: () => 1_700_000_000_000,
    sleep: () => Promise.resolve(),
    tokenStore: createMemoryTokenStore(),
    circuitStore: createMemoryCircuitStore(),
  });
  return { client, sim };
}

test('advances by received amount across partial pages until count is reached', async () => {
  const { client, sim } = makeClient(2);
  const seen = [];
  const result = await syncUserGroups(client, 'g1', {
    pageSize: 1000,
    persist: async (list) => {
      for (const group of list) seen.push(group.userGroupId);
    },
  });
  assert.equal(result.received, 5);
  assert.equal(result.pages, 3);
  assert.equal(result.complete, true);
  assert.deepEqual(seen, ['18067', '18068', '18069', '18070', '18071']);
  assert.equal(sim.calls.filter((call) => call.path.startsWith('/service/api/intl/usergroup/list/')).length, 3);
});

test('syncs vouchers by uuid until the list is empty', async () => {
  const { client } = makeClient(2);
  const uuids = [];
  const result = await syncVouchers(client, 'g1', {
    persist: async (list) => {
      for (const voucher of list) uuids.push(voucher.uuid);
    },
  });
  assert.equal(result.received, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.complete, true);
  assert.equal(new Set(uuids).size, 3);
});

test('reprocessing is idempotent (upsert by stable key)', async () => {
  const { client } = makeClient(2);
  const store = new Map();
  const persist = async (list) => {
    for (const group of list) store.set(group.userGroupId, group);
  };
  await syncUserGroups(client, 'g1', { persist });
  const firstSize = store.size;
  await syncUserGroups(client, 'g1', { persist });
  assert.equal(firstSize, 5);
  assert.equal(store.size, 5);
});

test('an interruption propagates and a rerun completes cleanly', async () => {
  const { client } = makeClient(2);
  let persistCalls = 0;
  await assert.rejects(
    () =>
      syncUserGroups(client, 'g1', {
        persist: async () => {
          persistCalls += 1;
          if (persistCalls === 2) throw new Error('boom');
        },
      }),
    /boom/,
  );
  const result = await syncUserGroups(client, 'g1', { persist: async () => {} });
  assert.equal(result.received, 5);
  assert.equal(result.complete, true);
});

test('stops immediately on an empty first page', async () => {
  let calls = 0;
  const result = await syncPaginated({
    fetchPage: async () => {
      calls += 1;
      return { count: 0, list: [] };
    },
    persist: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.received, 0);
  assert.equal(result.pages, 0);
});

test('handles duplicate uuids without duplicating persisted records', async () => {
  const store = new Map();
  let pages = 0;
  const result = await syncPaginated({
    fetchPage: async () => {
      pages += 1;
      if (pages === 1) return { count: 2, list: [{ uuid: 'dup' }, { uuid: 'dup' }] };
      return { count: 2, list: [] };
    },
    persist: async (list) => {
      for (const item of list) store.set(item.uuid, item);
    },
  });
  assert.equal(result.received, 2);
  assert.equal(store.size, 1);
});
