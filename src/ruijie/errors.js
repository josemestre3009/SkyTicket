export const RUIJIE_CODE = Object.freeze({
  SUCCESS: 0,
  INVALID_APPID: 1,
  INVALID_PARAM: 2,
  TOKEN_INVALID: 3,
  TOKEN_EXPIRED: 4,
  UNAUTHORIZED_API: 5,
  UNAUTHORIZED_API_ALT: '16.4',
  EXECUTION_TIMEOUT: 7,
  IN_PROGRESS: 25,
  INTERNAL_ERROR: -1002,
  LOGIN_FAILED: 1009,
});

export const RUIJIE_KIND = Object.freeze({
  AUTH: 'auth',
  RECOVERABLE: 'recoverable',
  NON_RECOVERABLE: 'non_recoverable',
  RATE_LIMITED: 'rate_limited',
  NETWORK: 'network',
  CIRCUIT_OPEN: 'circuit_open',
  PROTOCOL: 'protocol',
});

const NON_RECOVERABLE_CODES = new Set([
  RUIJIE_CODE.INVALID_APPID,
  RUIJIE_CODE.INVALID_PARAM,
  RUIJIE_CODE.UNAUTHORIZED_API,
  RUIJIE_CODE.UNAUTHORIZED_API_ALT,
  RUIJIE_CODE.LOGIN_FAILED,
]);

const RECOVERABLE_CODES = new Set([
  RUIJIE_CODE.EXECUTION_TIMEOUT,
  RUIJIE_CODE.IN_PROGRESS,
  RUIJIE_CODE.INTERNAL_ERROR,
]);

const AUTH_CODES = new Set([RUIJIE_CODE.TOKEN_INVALID, RUIJIE_CODE.TOKEN_EXPIRED]);

export function isAuthCode(code) {
  return AUTH_CODES.has(Number(code));
}

export function classify({ code, httpStatus } = {}) {
  if (httpStatus === 429) return RUIJIE_KIND.RATE_LIMITED;
  if (isAuthCode(code)) return RUIJIE_KIND.AUTH;
  if (NON_RECOVERABLE_CODES.has(code)) return RUIJIE_KIND.NON_RECOVERABLE;
  if (RECOVERABLE_CODES.has(code)) return RUIJIE_KIND.RECOVERABLE;
  if (Number(httpStatus) >= 500) return RUIJIE_KIND.RECOVERABLE;
  if (Number(httpStatus) >= 400) return RUIJIE_KIND.NON_RECOVERABLE;
  return RUIJIE_KIND.RECOVERABLE;
}

export function isRecoverable(err) {
  return err instanceof RuijieError && err.kind === RUIJIE_KIND.RECOVERABLE;
}

export class RuijieError extends Error {
  constructor(message, { code, httpStatus, kind, retryAfterMs, endpoint, cause } = {}) {
    super(message);
    this.name = 'RuijieError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.kind = kind || classify({ code, httpStatus });
    this.retryAfterMs = retryAfterMs ?? null;
    this.endpoint = endpoint ?? null;
    this.needsReconciliation = false;
    if (cause) this.cause = cause;
  }
}

export function protocolError(message, { code, endpoint, cause } = {}) {
  return new RuijieError(message, { code, kind: RUIJIE_KIND.PROTOCOL, endpoint, cause });
}

const SECRET_QUERY_KEYS = ['access_token', 'token', 'appid', 'secret', 'app_id', 'app_secret'];

export function redactUrl(rawUrl) {
  const value = String(rawUrl);
  const [path, query] = value.split('?');
  if (!query) return path;
  const params = new URLSearchParams(query);
  for (const key of SECRET_QUERY_KEYS) {
    if (params.has(key)) params.set(key, '[REDACTED]');
  }
  return `${path}?${params.toString()}`;
}

export function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue === undefined || headerValue === null || headerValue === '') return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(String(headerValue));
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}
