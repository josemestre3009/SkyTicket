import { ENDPOINTS, TOKEN_QUERY_CONSTANT } from './endpoints.js';
import { RUIJIE_KIND, RuijieError, protocolError } from './errors.js';

export const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

export function createTokenManager({
  connectionId,
  cipher,
  http,
  store,
  credentials,
  clock = () => Date.now(),
  tokenTtlMs = 30 * 60 * 1000,
  expirySkewMs = 60 * 1000,
} = {}) {
  function isFresh(record) {
    if (!record || !record.encrypted) return false;
    if (!record.expiresAt) return false;
    const expiresAt = new Date(record.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt - expirySkewMs > clock();
  }

  async function fetchNewToken() {
    const payload = await http.request({
      method: 'POST',
      path: ENDPOINTS.ACCESS_TOKEN,
      query: { token: credentials.apiToken || TOKEN_QUERY_CONSTANT },
      body: { appid: credentials.appId, secret: credentials.appSecret },
      idempotent: false,
    });
    if (!payload || !payload.accessToken) {
      throw protocolError('Ruijie token response missing accessToken', { endpoint: ENDPOINTS.ACCESS_TOKEN });
    }
    return payload.accessToken;
  }

  async function refreshToken(currentToken) {
    const payload = await http.request({
      method: 'GET',
      path: ENDPOINTS.TOKEN_REFRESH,
      query: { appid: credentials.appId, secret: credentials.appSecret, access_token: currentToken },
      idempotent: false,
    });
    if (!payload || !payload.accessToken) {
      throw protocolError('Ruijie refresh response missing accessToken', { endpoint: ENDPOINTS.TOKEN_REFRESH });
    }
    return payload.accessToken;
  }

  async function renew(previous) {
    if (!previous) return fetchNewToken();
    try {
      return await refreshToken(previous);
    } catch (err) {
      // A stale/invalid cached token makes refresh fail with an auth code; a
      // fresh client-credentials token is the safe fallback.
      if (err instanceof RuijieError && err.kind === RUIJIE_KIND.AUTH) return fetchNewToken();
      throw err;
    }
  }

  async function renewUnderLock(failedToken) {
    return store.withLock(connectionId, async (tx) => {
      const inner = await store.read(connectionId, tx);
      if (inner && inner.encrypted) {
        const current = cipher.decrypt(inner.encrypted);
        if (failedToken !== undefined && current !== failedToken) return current;
        if (failedToken === undefined && isFresh(inner)) return current;
      }
      const previous = inner && inner.encrypted ? cipher.decrypt(inner.encrypted) : null;
      const value = await renew(previous);
      await store.write(
        connectionId,
        { encrypted: cipher.encrypt(value), expiresAt: new Date(clock() + tokenTtlMs) },
        tx,
      );
      return value;
    });
  }

  async function getAccessToken() {
    const record = await store.read(connectionId);
    if (isFresh(record)) return cipher.decrypt(record.encrypted);
    return renewUnderLock(undefined);
  }

  async function forceRenew(failedToken) {
    return renewUnderLock(failedToken);
  }

  async function invalidate() {
    await store.write(connectionId, null);
  }

  return { getAccessToken, forceRenew, invalidate };
}

export function createCircuitBreaker({
  connectionId,
  store,
  clock = () => Date.now(),
  failureThreshold = 5,
  resetTimeoutMs = 30000,
} = {}) {
  let probing = false;

  async function allowRequest() {
    const state = await store.read(connectionId);
    if (state.state === CIRCUIT_STATE.CLOSED) return true;

    if (state.state === CIRCUIT_STATE.OPEN) {
      const openedAt = state.openedAt ? new Date(state.openedAt).getTime() : 0;
      if (Number.isFinite(openedAt) && clock() - openedAt >= resetTimeoutMs) {
        probing = true;
        await store.write(connectionId, {
          ...state,
          state: CIRCUIT_STATE.HALF_OPEN,
          halfOpenAt: new Date(clock()),
        });
        return true;
      }
      return false;
    }

    if (state.state === CIRCUIT_STATE.HALF_OPEN) {
      if (probing) return false;
      probing = true;
      return true;
    }
    return false;
  }

  async function recordSuccess() {
    probing = false;
    await store.write(connectionId, {
      state: CIRCUIT_STATE.CLOSED,
      failures: 0,
      openedAt: null,
      halfOpenAt: null,
    });
  }

  async function recordFailure() {
    probing = false;
    const state = await store.read(connectionId);
    const failures = (state.failures ?? 0) + 1;
    const shouldOpen = state.state === CIRCUIT_STATE.HALF_OPEN || failures >= failureThreshold;
    await store.write(connectionId, {
      state: shouldOpen ? CIRCUIT_STATE.OPEN : state.state,
      failures,
      openedAt: shouldOpen ? new Date(clock()) : state.openedAt ?? null,
      halfOpenAt: null,
    });
  }

  async function isOpen() {
    const state = await store.read(connectionId);
    return state.state === CIRCUIT_STATE.OPEN;
  }

  return { allowRequest, recordSuccess, recordFailure, isOpen };
}

export function circuitOpenError(endpoint) {
  return new RuijieError('Ruijie circuit open; emission unavailable', {
    kind: RUIJIE_KIND.CIRCUIT_OPEN,
    endpoint,
  });
}
