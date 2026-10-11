import test from 'node:test';
import assert from 'node:assert/strict';
import { Cipher } from '../../src/lib/crypto.js';
import { normalizeUserGroupList, normalizeVoucherList } from '../../src/ruijie/normalize.js';
import {
  ReadDisabledError,
  createRuijieInventoryService,
  selectSiteNodes,
  summarizeVouchers,
  toPackageDto,
} from '../../src/modules/ruijie-inventory/service.js';

const CIPHER = Cipher.fromKey('inventory-unit-test-key');
const BASE_CONFIG = {
  ruijie: {
    readEnabled: true,
    liveEnabled: false,
    region: 'eu',
    baseUrl: 'https://example.test',
    appId: 'app-public',
    appSecret: 'app-secret-plain',
    apiToken: 'constant-token-plain',
  },
};

const TREE = {
  nodes: [
    { groupId: 'root', name: 'Root', type: 'BUILDING', timezone: 'America/Bogota', parentGroupId: null, raw: { groupId: 'root' } },
    { groupId: 'floor', name: 'Floor 1', type: 'FLOOR', parentGroupId: 'root', raw: { groupId: 'floor' } },
    { groupId: 'lobby', name: 'Lobby', type: 'BUILDING', parentGroupId: 'root', raw: { groupId: 'lobby' } },
  ],
};

const USER_GROUPS = [
  { id: 18067, userGroupName: '1DayWiFi', authProfileId: '30113648274480073538014045592098', timePeriod: 1440, quota: 100, bindMac: 0, downloadRateLimit: 0, uploadRateLimit: 0 },
  { id: 18068, userGroupName: '2DayWiFi', authProfileId: '30113648274480073538014045592099', timePeriod: 2880, quota: 0, bindMac: 1, downloadRateLimit: 0, uploadRateLimit: 0 },
];

const RAW_VOUCHERS = [
  { uuid: 'u1', voucherCode: 'h3mtkr', nameRef: 'Room1', status: '1', expiryTime: 1531122313000, createTime: 1531122313000, packageName: '1DayWiFi', limitClients: 3, quota: 100 },
  { uuid: 'u2', voucherCode: 'h3mtks', nameRef: 'Room2', status: '2', expiryTime: 1531122313001, createTime: 1531122313001, packageName: '1DayWiFi', limitClients: 3, quota: 100 },
  { uuid: 'u3', voucherCode: 'h3mtkt', nameRef: 'Room3', status: '3', expiryTime: 1531122313002, createTime: 1531122313002, packageName: '1DayWiFi', limitClients: 3, quota: 100 },
  { uuid: 'u4', voucherCode: 'h3mtku', nameRef: 'Room4', status: '1', expiryTime: 1531122313003, createTime: 1531122313003, packageName: '1DayWiFi', limitClients: 3, quota: 100 },
  { uuid: 'u5', voucherCode: 'h3mtkv', nameRef: 'Room5', status: '1', expiryTime: 1531122313004, createTime: 1531122313004, packageName: '1DayWiFi', limitClients: 3, quota: 100 },
];

function makeRepository() {
  const state = { connections: new Map(), sites: [] };
  let seq = 0;
  return {
    state,
    async transaction(_runner, fn) {
      return fn(undefined);
    },
    async createConnection(params) {
      const existing = [...state.connections.values()].find(
        (row) => row.region === params.region && row.base_url === params.baseUrl && row.app_id === params.appId,
      );
      const row = existing ?? {
        id: `conn-${(seq += 1)}`,
        region: params.region,
        base_url: params.baseUrl,
        app_id: params.appId,
      };
      row.app_secret_encrypted = params.appSecretEncrypted;
      row.api_token_encrypted = params.apiTokenEncrypted;
      state.connections.set(row.id, row);
      return row;
    },
    async findConnectionById(id) {
      return state.connections.get(id) ?? null;
    },
    async findSiteById(id) {
      return state.sites.find((site) => site.id === id) ?? null;
    },
    async upsertSite(params) {
      let site = state.sites.find(
        (row) => row.ruijie_connection_id === params.connectionId && row.ruijie_group_id === params.ruijieGroupId,
      );
      if (!site) {
        site = {
          id: `site-${(seq += 1)}`,
          ruijie_connection_id: params.connectionId,
          ruijie_group_id: params.ruijieGroupId,
        };
        state.sites.push(site);
      }
      site.name = params.name;
      site.timezone = params.timezone;
      site.raw_json = params.rawJson;
      return site;
    },
    async deactivateMissingSites() {
      return 0;
    },
  };
}

function makeClientFactory({ tree = TREE, vouchers = RAW_VOUCHERS, userGroups = USER_GROUPS, failUserGroupsAtPage = null, calls } = {}) {
  let groupPages = 0;
  return () => ({
    async getGroupTree() {
      calls?.getGroupTree.push(1);
      return tree;
    },
    async listUserGroups(_groupId, { offset, pageSize }) {
      groupPages += 1;
      calls?.listUserGroups.push({ offset, pageSize });
      if (failUserGroupsAtPage && groupPages >= failUserGroupsAtPage) throw new Error('ruijie user groups unavailable');
      const list = userGroups.slice(offset, offset + pageSize);
      // Real contract: { code, msg, data: [...], count, maxAllowNum }.
      return normalizeUserGroupList({ code: 0, msg: 'OK.', data: list, count: userGroups.length, maxAllowNum: 50 });
    },
    async listVouchers(_groupId, { offset, pageSize }) {
      calls?.listVouchers.push({ offset, pageSize });
      const list = vouchers.slice(offset, offset + pageSize);
      return normalizeVoucherList({ code: 0, voucherData: { code: 0, count: vouchers.length, list } });
    },
  });
}

function makeCatalog() {
  const calls = [];
  return {
    calls,
    async syncPackages(params) {
      calls.push(params);
      return {
        upserted: params.packages.length,
        disabled: params.deactivate ? 1 : 0,
        packages: params.packages,
      };
    },
  };
}

function build(overrides = {}) {
  const repository = overrides.repository ?? makeRepository();
  const calls = { getGroupTree: [], listUserGroups: [], listVouchers: [] };
  const service = createRuijieInventoryService({
    config: overrides.config ?? BASE_CONFIG,
    repository,
    catalog: overrides.catalog ?? null,
    cipher: CIPHER,
    clientFactory: makeClientFactory({ ...overrides, calls }),
  });
  return { service, repository, calls };
}

test('selectSiteNodes prefers BUILDING groups and falls back to leaves', () => {
  assert.deepEqual(selectSiteNodes(TREE.nodes).map((n) => n.groupId), ['root', 'lobby']);
  const leaves = [
    { groupId: 'a', type: 'FLOOR', parentGroupId: null },
    { groupId: 'b', type: 'ROOM', parentGroupId: 'a' },
  ];
  assert.deepEqual(selectSiteNodes(leaves).map((n) => n.groupId), ['b']);
});

test('summarizeVouchers counts by normalized status', () => {
  assert.deepEqual(summarizeVouchers(RAW_VOUCHERS.map((v) => normalizeVoucherList({ list: [v] }).list[0])), {
    total: 5,
    unused: 3,
    in_use: 1,
    expired: 1,
    unknown: 0,
  });
});

test('syncSites encrypts env credentials into ruijie_connections and persists BUILDING sites', async () => {
  const { service, repository } = build();
  const result = await service.syncSites();

  assert.equal(result.discovered, 3);
  assert.deepEqual(result.sites.map((s) => s.ruijie_group_id), ['root', 'lobby']);

  const [row] = [...repository.state.connections.values()];
  assert.ok(row);
  assert.notEqual(row.app_secret_encrypted, BASE_CONFIG.ruijie.appSecret);
  assert.ok(!row.app_secret_encrypted.includes(BASE_CONFIG.ruijie.appSecret));
  assert.equal(CIPHER.decrypt(row.app_secret_encrypted), BASE_CONFIG.ruijie.appSecret);
  assert.equal(CIPHER.decrypt(row.api_token_encrypted), BASE_CONFIG.ruijie.apiToken);
});

test('listRemoteVouchers pages until count is reached and never leaks plaintext codes', async () => {
  const { service, repository, calls } = build();
  await service.syncSites();
  const site = repository.state.sites[0];

  const result = await service.listRemoteVouchers(site.id, { pageSize: 2 });

  assert.equal(result.count, 5);
  assert.equal(result.vouchers.length, 5);
  assert.equal(calls.listVouchers.length, 3, 'pagination advances by received quantity');
  assert.deepEqual(calls.listVouchers.map((c) => c.offset), [0, 2, 4]);
  assert.deepEqual(result.summary, { total: 5, unused: 3, in_use: 1, expired: 1, unknown: 0 });

  const serialized = JSON.stringify(result);
  for (const raw of RAW_VOUCHERS) {
    assert.ok(!serialized.includes(raw.voucherCode), `plaintext code ${raw.voucherCode} leaked`);
  }
  assert.ok(!serialized.includes('app-secret-plain'));
  assert.ok(!serialized.includes('constant-token-plain'));
  assert.ok(!('code' in result.vouchers[0]));
  assert.ok(!('raw' in result.vouchers[0]));
  assert.match(result.vouchers[0].codeMasked, /^\w{2}\*+\w{2}$/);
});

test('read is gated by RUIJIE_READ_ENABLED and rejects before any outbound call', async () => {
  const calls = { getGroupTree: [], listVouchers: [] };
  const service = createRuijieInventoryService({
    config: { ruijie: { ...BASE_CONFIG.ruijie, readEnabled: false } },
    repository: makeRepository(),
    cipher: CIPHER,
    clientFactory: makeClientFactory({ calls }),
  });

  await assert.rejects(() => service.syncSites(), (err) => err instanceof ReadDisabledError && err.code === 'ruijie_read_disabled');
  await assert.rejects(
    () => service.listRemoteVouchers('site-1'),
    (err) => err instanceof ReadDisabledError,
  );
  assert.equal(calls.getGroupTree.length + calls.listVouchers.length, 0);
});

test('toPackageDto maps normalized user groups to the catalog package shape', () => {
  const dto = toPackageDto({
    userGroupId: '18067',
    name: '1DayWiFi',
    profileId: '30113648274480073538014045592098',
    timePeriod: 1440,
    quota: 100,
    uploadRateLimit: 5,
    downloadRateLimit: 10,
    bindMac: 1,
    raw: { id: 18067 },
  });
  assert.deepEqual(dto, {
    ruijieUserGroupId: '18067',
    ruijieProfileId: '30113648274480073538014045592098',
    name: '1DayWiFi',
    duration: 1440,
    quota: 100,
    upSpeed: 5,
    downSpeed: 10,
    bindMac: 1,
    raw: { id: 18067 },
  });
});

test('syncPackages pages real user-group payloads and persists via catalog with deactivation', async () => {
  const catalog = makeCatalog();
  const { service, repository, calls } = build({ catalog });
  await service.syncSites();
  const site = repository.state.sites[0];

  const result = await service.syncPackages(site.id, { pageSize: 1 });

  assert.equal(result.received, 2);
  assert.equal(result.complete, true);
  assert.equal(result.error, null);
  assert.deepEqual(calls.listUserGroups.map((c) => c.offset), [0, 1]);

  assert.equal(catalog.calls.length, 1);
  const [{ siteId, packages, deactivate }] = catalog.calls;
  assert.equal(siteId, site.id);
  assert.equal(deactivate, true);
  assert.equal(packages[0].ruijieUserGroupId, '18067');
  assert.equal(packages[0].ruijieProfileId, '30113648274480073538014045592098');
  assert.equal(packages[0].duration, 1440);
});

test('a failed package query persists partial results but never deactivates', async () => {
  const catalog = makeCatalog();
  const { service, repository } = build({ catalog, failUserGroupsAtPage: 2 });
  await service.syncSites();
  const site = repository.state.sites[0];

  const result = await service.syncPackages(site.id, { pageSize: 1 });

  assert.equal(result.complete, false);
  assert.match(result.error, /unavailable/);
  assert.equal(catalog.calls.length, 1);
  assert.equal(catalog.calls[0].deactivate, false, 'failed query must not deactivate');
  assert.equal(catalog.calls[0].packages.length, 1, 'the first page is still upserted');
});

test('an empty but valid response may deactivate packages', async () => {
  const catalog = makeCatalog();
  const { service, repository } = build({ catalog, userGroups: [] });
  await service.syncSites();
  const site = repository.state.sites[0];

  const result = await service.syncPackages(site.id);

  assert.equal(result.received, 0);
  assert.equal(result.complete, true);
  assert.equal(catalog.calls[0].deactivate, true);
});

test('syncCatalog syncs sites first, then every site packages', async () => {
  const catalog = makeCatalog();
  const { service, repository } = build({ catalog });

  const out = await service.syncCatalog({});

  assert.equal(out.discoveredSites, 3);
  assert.equal(out.syncedSites, repository.state.sites.length);
  assert.equal(catalog.calls.length, repository.state.sites.length);
  assert.equal(out.packageCount, repository.state.sites.length * USER_GROUPS.length);
  assert.deepEqual(out.errors, []);
});

test('syncPackages requires the injected catalog service', async () => {
  const { service, repository } = build();
  await service.syncSites();
  const site = repository.state.sites[0];
  await assert.rejects(() => service.syncPackages(site.id), /catalog service/);
});
