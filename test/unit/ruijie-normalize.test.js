import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccount,
  normalizeAuthProfileId,
  normalizeExpiryTime,
  normalizeGroupTree,
  normalizeStatus,
  normalizeUserGroup,
  normalizeUserGroupList,
  normalizeVoucher,
  normalizeVoucherList,
} from '../../src/ruijie/normalize.js';

test('preserves long authProfileId as string without precision loss', () => {
  const value = '30113648274480073538014045592098';
  assert.equal(normalizeAuthProfileId(value), value);
  assert.equal(normalizeAuthProfileId('  30113648274480073538014045592098  '), value);
  assert.equal(normalizeAuthProfileId(18067), '18067');
  assert.equal(normalizeAuthProfileId(null), null);
  assert.equal(normalizeAuthProfileId(''), null);
});

test('normalizes expiryTime across string, epoch ms, epoch seconds and null', () => {
  assert.equal(normalizeExpiryTime('2121-09-01 22:48:10'), '2121-09-01T22:48:10.000Z');
  assert.equal(normalizeExpiryTime('2121-09-01T22:48:10Z'), '2121-09-01T22:48:10.000Z');
  assert.equal(normalizeExpiryTime(1531122313000), '2018-07-09T07:45:13.000Z');
  assert.equal(normalizeExpiryTime(1531122313), '2018-07-09T07:45:13.000Z');
  assert.equal(normalizeExpiryTime('1531122313000'), '2018-07-09T07:45:13.000Z');
  assert.equal(normalizeExpiryTime(null), null);
  assert.equal(normalizeExpiryTime(''), null);
  assert.equal(normalizeExpiryTime('not-a-date'), null);
});

test('maps raw status codes to domain states', () => {
  assert.equal(normalizeStatus('1'), 'unused');
  assert.equal(normalizeStatus(2), 'in_use');
  assert.equal(normalizeStatus('3'), 'expired');
  assert.equal(normalizeStatus('9'), 'unknown');
  assert.equal(normalizeStatus(undefined), 'unknown');
});

test('normalizes create aliases codeNo/comment/limitClients and keeps raw', () => {
  const raw = {
    uuid: '78eb665b70d44658937db776905676c9',
    codeNo: '4zr45r',
    status: '1',
    expiryTime: '2121-09-01 22:48:10',
    limitClients: 3,
    comment: 'order-demo',
  };
  const voucher = normalizeVoucher(raw);
  assert.equal(voucher.code, '4zr45r');
  assert.equal(voucher.alias, 'order-demo');
  assert.equal(voucher.maxClients, 3);
  assert.equal(voucher.status, 'unused');
  assert.equal(voucher.expiryTime, '2121-09-01T22:48:10.000Z');
  assert.equal(voucher.raw, raw);
});

test('normalizes list aliases voucherCode/nameRef/maxClients', () => {
  const voucher = normalizeVoucher({ uuid: 'u1', voucherCode: 'h3mtkr', nameRef: 'Room403', maxClients: 3, status: '2' });
  assert.equal(voucher.code, 'h3mtkr');
  assert.equal(voucher.alias, 'Room403');
  assert.equal(voucher.maxClients, 3);
  assert.equal(voucher.status, 'in_use');
});

test('flattens nested voucher list payloads', () => {
  const result = normalizeVoucherList({
    code: 0,
    voucherData: { code: 0, count: 2, list: [{ uuid: 'a', codeNo: 'x' }, { uuid: 'b', voucherCode: 'y' }] },
  });
  assert.equal(result.count, 2);
  assert.equal(result.list.length, 2);
  assert.equal(result.list[0].code, 'x');
  assert.equal(result.list[1].code, 'y');
});

test('normalizes user groups including authProfileId', () => {
  const group = normalizeUserGroup({ id: 18067, userGroupName: '1DayWiFi', authProfileId: '30113648274480073538014045592098', timePeriod: 1440, bindMac: 1 });
  assert.equal(group.userGroupId, '18067');
  assert.equal(group.profileId, '30113648274480073538014045592098');
  assert.equal(group.name, '1DayWiFi');
  assert.equal(group.timePeriod, 1440);
  assert.equal(group.bindMac, 1);

  const list = normalizeUserGroupList({ count: 1, maxAllowNum: 50, list: [{ id: 1, authProfileId: '999999999999999999999999' }] });
  assert.equal(list.count, 1);
  assert.equal(list.maxAllowNum, 50);
  assert.equal(list.list[0].profileId, '999999999999999999999999');
});

test('normalizes the real user-group payload {code,msg,data,count,maxAllowNum}', () => {
  const list = normalizeUserGroupList({
    code: 0,
    msg: 'OK.',
    count: 2,
    maxAllowNum: 50,
    data: [
      { id: 18067, userGroupName: '1DayWiFi', authProfileId: '30113648274480073538014045592098', timePeriod: 1440 },
      { id: 18068, userGroupName: '2DayWiFi', authProfileId: '30113648274480073538014045592099', timePeriod: 2880 },
    ],
  });
  assert.equal(list.count, 2);
  assert.equal(list.maxAllowNum, 50);
  assert.equal(list.code, 0);
  assert.equal(list.msg, 'OK.');
  assert.equal(list.list.length, 2);
  assert.equal(list.list[0].userGroupId, '18067');
  assert.equal(list.list[0].name, '1DayWiFi');
  assert.equal(list.list[0].profileId, '30113648274480073538014045592098');
  assert.equal(list.list[1].userGroupId, '18068');
});

test('normalizes nested data.list and legacy top-level list payloads', () => {
  const nested = normalizeUserGroupList({ code: 0, data: { list: [{ id: 1 }] }, count: 1 });
  assert.equal(nested.list.length, 1);
  assert.equal(nested.list[0].userGroupId, '1');

  const legacy = normalizeUserGroupList({ userGroups: [{ userGroupId: 'u-9', name: 'Legacy' }] });
  assert.equal(legacy.list.length, 1);
  assert.equal(legacy.list[0].name, 'Legacy');
});

test('flattens the group tree recursively', () => {
  const tree = normalizeGroupTree({
    list: [{ groupId: 'root', name: 'Root', type: 'BUILDING', subGroups: [{ groupId: 'child', name: 'Child' }] }],
  });
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes[0].groupId, 'root');
  assert.equal(tree.nodes[0].parentGroupId, null);
  assert.equal(tree.nodes[1].groupId, 'child');
  assert.equal(tree.nodes[1].parentGroupId, 'root');
});

test('flattens real payload where groups is a root object and root id/name are top-level', () => {
  const tree = normalizeGroupTree({
    code: 0,
    msg: 'OK.',
    rootGroupId: 'root-1',
    rootGroupName: 'Tenant Root',
    groups: {
      type: 'BUILDING',
      timezone: 'America/Bogota',
      subGroups: [{ groupId: 'child-1', name: 'Piso 1', type: 'BUILDING' }],
    },
  });
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes[0].groupId, 'root-1');
  assert.equal(tree.nodes[0].name, 'Tenant Root');
  assert.equal(tree.nodes[0].timezone, 'America/Bogota');
  assert.equal(tree.nodes[0].parentGroupId, null);
  assert.equal(tree.nodes[1].groupId, 'child-1');
  assert.equal(tree.nodes[1].parentGroupId, 'root-1');
});

test('flattens real payload where groups is a map keyed by group id', () => {
  const tree = normalizeGroupTree({
    rootGroupId: 'r',
    rootGroupName: 'Root',
    groups: {
      'a': { name: 'A', type: 'BUILDING' },
      'b': { name: 'B', type: 'BUILDING' },
    },
  });
  assert.equal(tree.nodes.length, 2);
  assert.deepEqual(
    tree.nodes.map((node) => node.groupId).sort(),
    ['a', 'b'],
  );
});

test('flattens a top-level node payload that keeps its own subGroups', () => {
  const tree = normalizeGroupTree({
    groupId: 'self',
    name: 'Self',
    type: 'BUILDING',
    subGroups: [{ groupId: 'kid', name: 'Kid' }],
  });
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes[0].groupId, 'self');
  assert.equal(tree.nodes[1].parentGroupId, 'self');
});

test('preserves the legacy list array contract', () => {
  const tree = normalizeGroupTree({
    list: [{ groupId: 'root', name: 'Root', type: 'BUILDING', subGroups: [{ groupId: 'child', name: 'Child' }] }],
  });
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes[0].groupId, 'root');
  assert.equal(tree.nodes[1].parentGroupId, 'root');
});

test('normalizes account fields and 2FA flag', () => {
  const account = normalizeAccount({ accountId: 5, account: 'a', tenantRole: 'TENANT_MANAGER', twoFactorCheck: { enable: true } });
  assert.equal(account.accountId, 5);
  assert.equal(account.tenantRole, 'TENANT_MANAGER');
  assert.equal(account.twoFactorEnabled, true);
});
