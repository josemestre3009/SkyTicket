import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVED_ENDPOINTS,
  ENDPOINTS,
  assertApprovedPath,
  buildUrl,
  userGroupsPath,
  voucherCreatePath,
  voucherListPath,
} from '../../src/ruijie/endpoints.js';

test('only approved public endpoints are declared', () => {
  assert.equal(ENDPOINTS.ACCESS_TOKEN, '/service/api/oauth20/client/access_token');
  assert.equal(ENDPOINTS.TOKEN_REFRESH, '/service/api/token/refresh');
  assert.equal(ENDPOINTS.ACCOUNT_INFO, '/service/api/org/account/info');
  assert.equal(ENDPOINTS.GROUP_TREE, '/service/api/group/single/tree');
  assert.equal(ENDPOINTS.USER_GROUPS, '/service/api/intl/usergroup/list/{groupId}');
  assert.equal(ENDPOINTS.VOUCHER_CREATE, '/service/api/open/auth/voucher/create/{groupId}');
  assert.equal(ENDPOINTS.VOUCHER_GET_LIST, '/service/api/open/auth/voucher/getList/{groupId}');
  assert.ok(APPROVED_ENDPOINTS.every((path) => !path.includes('/webproxy')));
});

test('rejects the private webproxy API', () => {
  assert.throws(() => assertApprovedPath('/webproxy/common/api/anything'), /Forbidden Ruijie path/);
  assert.throws(() => buildUrl('https://x.test', '/webproxy/common/api'), /Forbidden Ruijie path/);
});

test('builds URLs with encoded query and group ids', () => {
  const url = new URL(buildUrl('https://cloud-eu.ruijienetworks.com/', ENDPOINTS.GROUP_TREE, { depth: 'BUILDING', access_token: 'abc' }));
  assert.equal(url.pathname, '/service/api/group/single/tree');
  assert.equal(url.searchParams.get('depth'), 'BUILDING');
  assert.equal(url.searchParams.get('access_token'), 'abc');

  assert.equal(userGroupsPath('12/34'), '/service/api/intl/usergroup/list/12%2F34');
  assert.equal(voucherCreatePath('12345'), '/service/api/open/auth/voucher/create/12345');
  assert.equal(voucherListPath('12345'), '/service/api/open/auth/voucher/getList/12345');
});

test('requires a base url', () => {
  assert.throws(() => buildUrl('', ENDPOINTS.ACCOUNT_INFO), /baseUrl is required/);
});
