export const FORBIDDEN_PATH_FRAGMENT = '/webproxy';

export const ENDPOINTS = Object.freeze({
  ACCESS_TOKEN: '/service/api/oauth20/client/access_token',
  TOKEN_REFRESH: '/service/api/token/refresh',
  ACCOUNT_INFO: '/service/api/org/account/info',
  GROUP_TREE: '/service/api/group/single/tree',
  USER_GROUPS: '/service/api/intl/usergroup/list/{groupId}',
  VOUCHER_CREATE: '/service/api/open/auth/voucher/create/{groupId}',
  VOUCHER_GET_LIST: '/service/api/open/auth/voucher/getList/{groupId}',
});

export const TOKEN_QUERY_CONSTANT = 'd63dss0a81e4415a889ac5b78fsc904a';

export const APPROVED_ENDPOINTS = Object.freeze([
  ENDPOINTS.ACCESS_TOKEN,
  ENDPOINTS.TOKEN_REFRESH,
  ENDPOINTS.ACCOUNT_INFO,
  ENDPOINTS.GROUP_TREE,
  ENDPOINTS.USER_GROUPS,
  ENDPOINTS.VOUCHER_CREATE,
  ENDPOINTS.VOUCHER_GET_LIST,
]);

export function assertApprovedPath(path) {
  const value = String(path);
  if (value.includes(FORBIDDEN_PATH_FRAGMENT)) {
    throw new Error(`Forbidden Ruijie path: ${value}`);
  }
  return value;
}

export function userGroupsPath(groupId) {
  return assertApprovedPath(ENDPOINTS.USER_GROUPS.replace('{groupId}', encodeURIComponent(groupId)));
}

export function voucherCreatePath(groupId) {
  return assertApprovedPath(ENDPOINTS.VOUCHER_CREATE.replace('{groupId}', encodeURIComponent(groupId)));
}

export function voucherListPath(groupId) {
  return assertApprovedPath(ENDPOINTS.VOUCHER_GET_LIST.replace('{groupId}', encodeURIComponent(groupId)));
}

export function buildUrl(baseUrl, path, query = {}) {
  assertApprovedPath(path);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Ruijie baseUrl is required');
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
