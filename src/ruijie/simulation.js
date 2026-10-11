import { ENDPOINTS } from './endpoints.js';

const USER_GROUPS = [
  { id: 18067, userGroupName: '1DayWiFi', authProfileId: '30113648274480073538014045592098', timePeriod: 1440, quota: 100, bindMac: 0, downloadRateLimit: 0, uploadRateLimit: 0 },
  { id: 18068, userGroupName: '2DayWiFi', authProfileId: '30113648274480073538014045592099', timePeriod: 2880, quota: 0, bindMac: 1, downloadRateLimit: 0, uploadRateLimit: 0 },
  { id: 18069, userGroupName: '1Hour', authProfileId: '30113648274480073538014045592100', timePeriod: 60, quota: 50, bindMac: 0 },
  { id: 18070, userGroupName: '30Min', authProfileId: '30113648274480073538014045592101', timePeriod: 30, quota: 25, bindMac: 0 },
  { id: 18071, userGroupName: '1Week', authProfileId: '30113648274480073538014045592102', timePeriod: 10080, quota: 0, bindMac: 0 },
];

const VOUCHERS = [
  { uuid: '93a88786c5d44d8689fd634bf550ea11', voucherCode: 'h3mtkr', nameRef: 'Room403', timePeriod: 1440, createTime: 1531122313000, maxClients: 3, status: '1', quota: 100, packageName: '1DayWiFi' },
  { uuid: 'a3a88786c5d44d8689fd634bf550ea12', voucherCode: 'h3mtks', nameRef: 'Room404', timePeriod: 1440, createTime: 1531122313001, maxClients: 3, status: '2', quota: 100, packageName: '1DayWiFi' },
  { uuid: 'b3a88786c5d44d8689fd634bf550ea13', voucherCode: 'h3mtkt', nameRef: 'Room405', timePeriod: 1440, createTime: 1531122313002, maxClients: 3, status: '3', quota: 100, packageName: '1DayWiFi' },
];

export const fixtures = Object.freeze({
  token: { code: 0, msg: 'OK.', accessToken: 'SANITIZED-ACCESS-TOKEN' },
  refresh: { code: 0, msg: 'OK.', accessToken: 'SANITIZED-REFRESHED-TOKEN' },
  account: {
    code: 0,
    msg: 'OK.',
    accountId: '100000001',
    account: 'demo-account',
    email: 'ops@example.test',
    role: 'rootManager',
    tenantRole: 'TENANT_MANAGER',
    userType: 'ROOT',
    defaultTenant: 'tenant-demo',
    timeZone: 'America/Bogota',
    twoFactorCheck: { enable: true },
  },
  groupTree: {
    code: 0,
    msg: 'OK.',
    list: [
      {
        groupId: '1be31cf89904484d8b90fe1784261c06',
        name: 'Hotel Centro',
        type: 'BUILDING',
        timezone: 'America/Bogota',
        subGroups: [{ groupId: 'sub-1', name: 'Piso 1', type: 'BUILDING' }],
      },
    ],
  },
  userGroups: USER_GROUPS,
  userGroupsCount: USER_GROUPS.length,
  vouchers: VOUCHERS,
  vouchersCount: VOUCHERS.length,
  voucherCreate: {
    code: 0,
    msg: 'Success.',
    voucherData: {
      code: 0,
      msg: 'OK.',
      count: 2,
      list: [
        { uuid: '78eb665b70d44658937db776905676c9', codeNo: '4zr45r', status: '1', profileId: '30113648274480073538014045592098', expiryTime: '2121-09-01 22:48:10', limitClients: 3, groupId: '1be31cf89904484d8b90fe1784261c06', comment: 'order-demo' },
        { uuid: '88eb665b70d44658937db776905676d0', codeNo: '5zr46r', status: '1', profileId: '30113648274480073538014045592098', expiryTime: 4788888888000, limitClients: 3, groupId: '1be31cf89904484d8b90fe1784261c06', comment: 'order-demo' },
      ],
    },
  },
  errors: Object.freeze({
    tokenInvalid: { code: 3, msg: 'Token invalid.' },
    tokenExpired: { code: 4, msg: 'Token expired.' },
    inProgress: { code: 25, msg: 'In progress.' },
    timeout: { code: 7, msg: 'Execution timeout.' },
    internal: { code: -1002, msg: 'Internal error.' },
    invalidParam: { code: 2, msg: 'Invalid parameter.' },
    loginFailed: { code: 1009, msg: 'Login failed.' },
  }),
});

function makeResponse({ status = 200, body, headers = {} } = {}) {
  const headerMap = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headerMap,
    async text() {
      if (body === undefined) return '';
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

export function createSimulatedFetch(handlers = []) {
  const calls = [];
  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const call = {
      url,
      path: parsed.pathname,
      method: options.method || 'GET',
      query: Object.fromEntries(parsed.searchParams.entries()),
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    for (const handler of handlers) {
      if (handler.match(call)) {
        const response = await handler.respond(call, { index: calls.length - 1 });
        return makeResponse(response);
      }
    }
    return makeResponse({ status: 404, body: { code: -1, msg: 'no simulated route' } });
  }
  return { fetch: fetchImpl, calls };
}

export function pathIs(path, method = 'GET') {
  return (call) => call.path === path && call.method === method;
}

function slicePage(items, offset, pageSize, chunkSize) {
  const size = Math.min(pageSize, chunkSize);
  return items.slice(offset, offset + size);
}

export function createRuijieHandlers(data = fixtures, { chunkSize = Number.POSITIVE_INFINITY } = {}) {
  return [
    { match: pathIs(ENDPOINTS.ACCESS_TOKEN, 'POST'), respond: () => ({ body: data.token }) },
    { match: pathIs(ENDPOINTS.TOKEN_REFRESH, 'GET'), respond: () => ({ body: data.refresh }) },
    { match: pathIs(ENDPOINTS.ACCOUNT_INFO, 'GET'), respond: () => ({ body: data.account }) },
    { match: pathIs(ENDPOINTS.GROUP_TREE, 'GET'), respond: () => ({ body: data.groupTree }) },
    {
      match: (call) => call.path.startsWith('/service/api/intl/usergroup/list/'),
      respond: (call) => {
        const offset = Number(call.query.pageIndex || 0);
        const pageSize = Number(call.query.pageSize || 1000);
        return {
          body: {
            code: 0,
            msg: 'OK.',
            count: data.userGroupsCount,
            maxAllowNum: 50,
            list: slicePage(data.userGroups, offset, pageSize, chunkSize),
          },
        };
      },
    },
    {
      match: (call) => call.path.startsWith('/service/api/open/auth/voucher/create/'),
      respond: () => ({ body: data.voucherCreate }),
    },
    {
      match: (call) => call.path.startsWith('/service/api/open/auth/voucher/getList/'),
      respond: (call) => {
        const offset = Number(call.query.start || 0);
        const pageSize = Number(call.query.pageSize || 200);
        return {
          body: {
            code: 0,
            msg: 'OK.',
            voucherData: {
              code: 0,
              msg: 'OK.',
              count: data.vouchersCount,
              list: slicePage(data.vouchers, offset, pageSize, chunkSize),
            },
          },
        };
      },
    },
  ];
}
