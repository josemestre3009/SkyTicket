import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuijieAdapter } from '../../src/modules/issuance/adapter.js';

test('issuance adapter sends the required Ruijie package contract', async () => {
  let sent;
  const adapter = createRuijieAdapter({
    cipher: { decrypt: (value) => value },
    connectionLoader: async () => ({
      id: 'connection-1',
      region: 'eu',
      base_url: 'https://example.test',
      app_id: 'app',
      app_secret_encrypted: 'secret',
      api_token_encrypted: 'manual-token',
    }),
    packageLoader: async () => ({
      ruijie_profile_id: '87454832236495399234072014805253',
      ruijie_user_group_id: '92256',
    }),
    clientFactory: () => ({
      breaker: { isOpen: async () => false },
      createVouchers: async (groupId, body) => {
        sent = { groupId, body };
        return { count: 1, list: [] };
      },
    }),
  });

  const connection = await adapter.resolveConnection({ site: { ruijie_connection_id: 'connection-1' } });
  await adapter.createVouchers({
    connection,
    site: { ruijieGroupId: '8876839' },
    order: { id: 'order-1', package_id: 'package-1', quantity: 1 },
  });

  assert.deepEqual(sent, {
    groupId: '8876839',
    body: {
      quantity: 1,
      profile: '87454832236495399234072014805253',
      userGroupId: 92256,
      comment: 'order-1',
    },
  });
});

test('issuance adapter rejects incomplete packages before calling Ruijie', async () => {
  let calls = 0;
  const adapter = createRuijieAdapter({
    cipher: { decrypt: (value) => value },
    packageLoader: async () => ({ ruijie_profile_id: null, ruijie_user_group_id: '92256' }),
    clientFactory: () => ({
      breaker: { isOpen: async () => false },
      createVouchers: async () => { calls += 1; },
    }),
  });

  await assert.rejects(
    () => adapter.createVouchers({
      connection: { id: 'connection-1' },
      site: { ruijieGroupId: '8876839' },
      order: { id: 'order-1', package_id: 'package-1', quantity: 1 },
    }),
    (error) => error.code === 'package_contract_missing',
  );
  assert.equal(calls, 0);
});
