import { parseCookies } from './cookies.js';
import { hashCsrfToken, timingSafeEqualHex } from './tokens.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createGuards({ service, cookieName, csrfHeader = 'x-csrf-token' }) {
  async function attachSession(request) {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[cookieName] ?? null;
    const context = token ? await service.resolve(token) : null;
    request.auth = context;
    return context;
  }

  async function currentAuth(request) {
    if (request.auth === undefined) {
      await attachSession(request);
    }
    return request.auth;
  }

  async function requireAuth(request) {
    const auth = await currentAuth(request);
    if (!auth) throw new UnauthorizedError('Authentication required', 'unauthorized');
    return auth;
  }

  function requireRole(...roles) {
    return async function roleGuard(request) {
      const auth = await requireAuth(request);
      if (!roles.includes(auth.user.role)) throw new ForbiddenError('Access denied', 'forbidden');
      return auth;
    };
  }

  async function requireCsrf(request) {
    if (SAFE_METHODS.has(request.method)) return;
    const auth = await requireAuth(request);
    const provided = request.headers[csrfHeader] ?? request.body?.csrfToken;
    if (!provided || !auth.session.csrf_hash) {
      throw new ForbiddenError('Missing CSRF token', 'csrf_missing');
    }
    if (!timingSafeEqualHex(hashCsrfToken(provided), auth.session.csrf_hash)) {
      throw new ForbiddenError('Invalid CSRF token', 'csrf_invalid');
    }
  }

  return { attachSession, requireAuth, requireRole, requireCsrf };
}
