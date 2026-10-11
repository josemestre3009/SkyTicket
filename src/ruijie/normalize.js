export function normalizeAuthProfileId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

function epochToIso(epoch) {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeExpiryTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return epochToIso(Number(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^\d+$/.test(trimmed)) return epochToIso(Number(trimmed));
    let isoCandidate = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(isoCandidate)) isoCandidate += 'Z';
    const parsed = Date.parse(isoCandidate);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

const STATUS_MAP = Object.freeze({
  1: 'unused',
  2: 'in_use',
  3: 'expired',
});

export function normalizeStatus(value) {
  if (value === undefined || value === null) return 'unknown';
  return STATUS_MAP[value] ?? 'unknown';
}

export function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function normalizeVoucher(raw = {}) {
  return {
    uuid: raw.uuid === undefined || raw.uuid === null ? null : String(raw.uuid),
    code: firstDefined(raw.codeNo, raw.voucherCode, raw.code),
    alias: firstDefined(raw.comment, raw.nameRef, raw.alias),
    profileId: normalizeAuthProfileId(firstDefined(raw.profileId, raw.profile)),
    expiryTime: normalizeExpiryTime(raw.expiryTime),
    maxClients: firstDefined(raw.limitClients, raw.maxClients),
    currentClients: firstDefined(raw.currentClients, raw.current_clients),
    groupId: firstDefined(raw.groupId, raw.group_id),
    status: normalizeStatus(raw.status),
    rawStatus: raw.status === undefined ? null : String(raw.status),
    createTime: normalizeExpiryTime(raw.createTime),
    packageName: firstDefined(raw.packageName, raw.package_name),
    quota: firstDefined(raw.quota),
    raw,
  };
}

export function normalizeVoucherList(payload = {}) {
  const data = payload.voucherData ?? payload.data ?? payload;
  const list = Array.isArray(data.list) ? data.list : Array.isArray(data.vouchers) ? data.vouchers : [];
  const count = Number(data.count);
  return {
    count: Number.isFinite(count) ? count : null,
    list: list.map(normalizeVoucher),
    code: firstDefined(data.code, payload.code),
    msg: firstDefined(data.msg, payload.msg),
    raw: payload,
  };
}

export function normalizeUserGroup(raw = {}) {
  const id = firstDefined(raw.id, raw.userGroupId, raw.user_group_id);
  return {
    userGroupId: id === null ? null : String(id),
    id: id === null ? null : String(id),
    name: firstDefined(raw.userGroupName, raw.name),
    profileId: normalizeAuthProfileId(firstDefined(raw.authProfileId, raw.profileId, raw.profile)),
    timePeriod: firstDefined(raw.timePeriod, raw.time_period),
    quota: firstDefined(raw.quota),
    bindMac: firstDefined(raw.bindMac, raw.bind_mac),
    downloadRateLimit: firstDefined(raw.downloadRateLimit, raw.download_rate_limit),
    uploadRateLimit: firstDefined(raw.uploadRateLimit, raw.upload_rate_limit),
    packageType: firstDefined(raw.packageType, raw.package_type),
    description: firstDefined(raw.description),
    createTime: normalizeExpiryTime(raw.createTime),
    updateTime: normalizeExpiryTime(raw.updateTime),
    raw,
  };
}

export function normalizeUserGroupList(payload = {}) {
  // Real payload: { code, msg, data: [...], count, maxAllowNum }. Older shapes
  // nest the array under data.list / data.userGroups or at the top level.
  const data = payload.data;
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.userGroups)
        ? data.userGroups
        : Array.isArray(payload.list)
          ? payload.list
          : Array.isArray(payload.userGroups)
            ? payload.userGroups
            : [];
  const count = Number(firstDefined(payload.count, data?.count));
  const maxAllowNum = Number(firstDefined(payload.maxAllowNum, data?.maxAllowNum));
  return {
    count: Number.isFinite(count) ? count : null,
    maxAllowNum: Number.isFinite(maxAllowNum) ? maxAllowNum : null,
    code: firstDefined(payload.code, data?.code),
    msg: firstDefined(payload.msg, data?.msg),
    list: list.map(normalizeUserGroup),
    raw: payload,
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function flattenGroupNode(node, parentGroupId, out, overlay = null) {
  if (!node || typeof node !== 'object') return out;
  const groupId = firstDefined(node.groupId, node.group_id, overlay?.groupId);
  if (groupId !== null) {
    out.push({
      groupId: String(groupId),
      name: firstDefined(node.name, node.groupName, overlay?.name),
      type: firstDefined(node.type, node.groupType, node.group_type),
      timezone: firstDefined(node.timezone, node.timeZone, node.time_zone),
      businessType: firstDefined(node.businessType),
      parentGroupId: parentGroupId === null ? null : String(parentGroupId),
      raw: node,
    });
  }
  const children = asArray(node.subGroups ?? node.subgroups);
  for (const child of children) flattenGroupNode(child, groupId, out);
  return out;
}

/** Top-level root identifiers used when the root node itself omits them. */
function rootOverlay(payload) {
  const groupId = firstDefined(payload.rootGroupId, payload.root_group_id);
  const name = firstDefined(payload.rootGroupName, payload.root_group_name);
  return groupId === null && name === null ? null : { groupId, name };
}

function looksLikeGroupNode(value) {
  return ['groupId', 'group_id', 'name', 'groupName', 'type', 'subGroups', 'subgroups'].some(
    (key) => key in value,
  );
}

/**
 * Real Ruijie payloads vary: a `list`/`data` array, a `groups` array, a single
 * root object in `groups`, a `group` object, or top-level `rootGroupId` /
 * `rootGroupName` with the tree under `groups`. Arrays from the older contract
 * are still honored unchanged.
 */
function extractGroupRoots(payload) {
  if (Array.isArray(payload.list)) return { roots: payload.list, overlay: null };
  if (Array.isArray(payload.groups)) return { roots: payload.groups, overlay: null };
  if (payload.groups && typeof payload.groups === 'object') {
    if (looksLikeGroupNode(payload.groups)) {
      return { roots: [payload.groups], overlay: rootOverlay(payload) };
    }
    const roots = Object.entries(payload.groups).map(([key, value]) =>
      value && typeof value === 'object' && value.groupId == null && value.group_id == null
        ? { ...value, groupId: key }
        : value,
    );
    return { roots, overlay: null };
  }
  if (Array.isArray(payload.data)) return { roots: payload.data, overlay: null };
  if (payload.group && typeof payload.group === 'object') {
    return { roots: [payload.group], overlay: rootOverlay(payload) };
  }
  if (looksLikeGroupNode(payload)) return { roots: [payload], overlay: rootOverlay(payload) };
  return { roots: [], overlay: null };
}

export function normalizeGroupTree(payload = {}) {
  const { roots, overlay } = extractGroupRoots(payload);
  const nodes = [];
  for (const root of roots) flattenGroupNode(root, null, nodes, overlay);
  return { nodes, raw: payload };
}

export function normalizeAccount(raw = {}) {
  return {
    accountId: firstDefined(raw.accountId, raw.account_id),
    account: firstDefined(raw.account),
    email: firstDefined(raw.email),
    role: firstDefined(raw.role),
    tenantRole: firstDefined(raw.tenantRole, raw.tenant_role),
    userType: firstDefined(raw.userType, raw.user_type),
    defaultTenant: firstDefined(raw.defaultTenant, raw.default_tenant),
    timeZone: firstDefined(raw.timeZone, raw.timezone),
    twoFactorEnabled: Boolean(raw.twoFactorCheck && raw.twoFactorCheck.enable),
    raw,
  };
}
