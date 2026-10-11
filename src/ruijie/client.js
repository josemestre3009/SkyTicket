import { ENDPOINTS, voucherCreatePath, voucherListPath, userGroupsPath } from './endpoints.js';
import { RUIJIE_KIND, RuijieError, isRecoverable, protocolError } from './errors.js';
import { createHttpClient } from './http.js';
import {
  normalizeAccount,
  normalizeGroupTree,
  normalizeUserGroupList,
  normalizeVoucherList,
} from './normalize.js';
import { circuitOpenError, createCircuitBreaker, createTokenManager } from './resilience.js';
import { createPgCircuitStore, createPgTokenStore } from './stores.js';

const RECOVERY_KINDS = new Set([
  RUIJIE_KIND.RECOVERABLE,
  RUIJIE_KIND.NETWORK,
  RUIJIE_KIND.RATE_LIMITED,
]);

export function createRuijieClient({
  connection,
  cipher,
  fetchImpl,
  clock,
  sleep,
  jitter,
  tokenStore,
  circuitStore,
  maxAttempts,
  backoffBaseMs,
  backoffCapMs,
  tokenTtlMs,
  expirySkewMs,
  circuitFailureThreshold,
  circuitResetTimeoutMs,
} = {}) {
  if (!connection || !connection.id) throw new Error('connection with id is required');
  if (!connection.baseUrl) throw new Error('connection.baseUrl is required');
  if (!cipher) throw new Error('cipher is required');

  const http = createHttpClient({
    baseUrl: connection.baseUrl,
    fetchImpl,
    clock,
    sleep,
    jitter,
    maxAttempts,
    backoffBaseMs,
    backoffCapMs,
  });

  const tokens = createTokenManager({
    connectionId: connection.id,
    cipher,
    http,
    store: tokenStore || createPgTokenStore(),
    credentials: {
      appId: connection.appId,
      appSecret: connection.appSecret,
      apiToken: connection.apiToken,
    },
    clock,
    tokenTtlMs,
    expirySkewMs,
  });

  const breaker = createCircuitBreaker({
    connectionId: connection.id,
    store: circuitStore || createPgCircuitStore(),
    clock,
    failureThreshold: circuitFailureThreshold,
    resetTimeoutMs: circuitResetTimeoutMs,
  });

  async function guarded(op) {
    const allowed = await breaker.allowRequest();
    if (!allowed) throw circuitOpenError();
    try {
      const result = await op();
      await breaker.recordSuccess();
      return result;
    } catch (err) {
      if (RECOVERY_KINDS.has(err?.kind) || isRecoverable(err)) {
        await breaker.recordFailure();
      }
      throw err;
    }
  }

  async function withTokenRead(fn) {
    const token = await tokens.getAccessToken();
    try {
      return await fn(token);
    } catch (err) {
      if (err instanceof RuijieError && err.kind === RUIJIE_KIND.AUTH) {
        const fresh = await tokens.forceRenew(token);
        return fn(fresh);
      }
      throw err;
    }
  }

  function read(fn) {
    return guarded(() => withTokenRead(fn));
  }

  async function getAccount() {
    return read(async (token) => normalizeAccount(await http.get(ENDPOINTS.ACCOUNT_INFO, { token })));
  }

  async function getGroupTree({ depth = 'BUILDING' } = {}) {
    return read(async (token) =>
      normalizeGroupTree(await http.get(ENDPOINTS.GROUP_TREE, { token, query: { depth } })),
    );
  }

  async function listUserGroups(groupId, { offset = 0, pageSize = 1000 } = {}) {
    return read(async (token) =>
      normalizeUserGroupList(
        await http.get(userGroupsPath(groupId), {
          token,
          query: { pageIndex: offset, pageSize },
        }),
      ),
    );
  }

  async function listVouchers(groupId, { offset = 0, pageSize = 200 } = {}) {
    return read(async (token) =>
      normalizeVoucherList(
        await http.get(voucherListPath(groupId), {
          token,
          query: { start: offset, pageSize },
        }),
      ),
    );
  }

  async function createVouchers(groupId, body) {
    return guarded(async () => {
      const token = await tokens.getAccessToken();
      let payload;
      try {
        payload = await http.post(voucherCreatePath(groupId), { token, body });
      } catch (err) {
        if (err instanceof RuijieError) {
          if (err.kind === RUIJIE_KIND.AUTH) {
            await tokens.invalidate();
            err.needsReconciliation = false;
          } else if (RECOVERY_KINDS.has(err.kind)) {
            err.needsReconciliation = true;
          }
        }
        throw err;
      }
      const normalized = normalizeVoucherList(payload);
      if (normalized.code !== null && normalized.code !== undefined && Number(normalized.code) !== 0) {
        const error = protocolError('Ruijie voucher create rejected', {
          code: normalized.code,
          endpoint: voucherCreatePath(groupId),
        });
        error.needsReconciliation = true;
        throw error;
      }
      const requested = Number(body?.quantity);
      return {
        ...normalized,
        partial: Number.isFinite(requested) && requested > 0 ? normalized.list.length < requested : false,
      };
    });
  }

  return {
    connection,
    http,
    tokens,
    breaker,
    isCircuitOpen: () => breaker.isOpen(),
    getAccount,
    getGroupTree,
    listUserGroups,
    listVouchers,
    createVouchers,
  };
}
