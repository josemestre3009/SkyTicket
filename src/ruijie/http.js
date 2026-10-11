import { assertApprovedPath, buildUrl } from './endpoints.js';
import {
  RUIJIE_KIND,
  RuijieError,
  classify,
  parseRetryAfter,
  redactUrl,
} from './errors.js';

export function createHttpClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 3,
  backoffBaseMs = 300,
  backoffCapMs = 5000,
  jitter = Math.random,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');

  function retryDelay(attempt) {
    const exponential = Math.min(backoffCapMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    const factor = 0.5 + jitter();
    return Math.max(0, Math.round(exponential * factor));
  }

  async function parseBody(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { __raw: text };
    }
  }

  async function request({ method = 'GET', path, query = {}, body, token, idempotent = false } = {}) {
    assertApprovedPath(path);
    const finalQuery = { ...query };
    if (token) finalQuery.access_token = token;
    const url = buildUrl(baseUrl, path, finalQuery);
    const safeEndpoint = redactUrl(url);
    const attempts = idempotent ? Math.max(1, maxAttempts) : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (cause) {
        const error = new RuijieError('Ruijie request failed', {
          kind: RUIJIE_KIND.NETWORK,
          endpoint: safeEndpoint,
          cause,
        });
        if (attempt < attempts) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw error;
      }

      const payload = await parseBody(response);
      const httpStatus = response.status;

      if (httpStatus === 429) {
        const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), clock());
        const error = new RuijieError('Ruijie rate limited', {
          httpStatus,
          kind: RUIJIE_KIND.RATE_LIMITED,
          retryAfterMs,
          endpoint: safeEndpoint,
        });
        if (attempt < attempts) {
          await sleep(retryAfterMs ?? retryDelay(attempt));
          continue;
        }
        throw error;
      }

      if (httpStatus >= 500) {
        const error = new RuijieError(`Ruijie server error HTTP ${httpStatus}`, {
          httpStatus,
          kind: RUIJIE_KIND.RECOVERABLE,
          endpoint: safeEndpoint,
        });
        if (attempt < attempts) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw error;
      }

      if (httpStatus >= 400) {
        throw new RuijieError(`Ruijie request rejected HTTP ${httpStatus}`, {
          httpStatus,
          kind: RUIJIE_KIND.NON_RECOVERABLE,
          endpoint: safeEndpoint,
        });
      }

      const code = payload && typeof payload === 'object' ? payload.code : undefined;
      if (code === 0) {
        return payload;
      }

      const kind = classify({ code, httpStatus });
      const error = new RuijieError(`Ruijie logical error code ${code}`, {
        code,
        httpStatus,
        kind,
        endpoint: safeEndpoint,
      });
      if (kind === RUIJIE_KIND.RECOVERABLE && attempt < attempts) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw error;
    }

    throw new RuijieError('Ruijie request exhausted attempts', {
      kind: RUIJIE_KIND.RECOVERABLE,
      endpoint: safeEndpoint,
    });
  }

  return {
    request,
    get: (path, options = {}) => request({ ...options, method: 'GET', path, idempotent: true }),
    post: (path, options = {}) => request({ ...options, method: 'POST', path, idempotent: false }),
    retryDelay,
  };
}
