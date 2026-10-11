import { config } from '../config.js';
import { setCookie, clearCookie } from './cookies.js';
import { TooManyRequestsError, AuthError } from './errors.js';
import { createGuards } from './guards.js';
import { createAuthService, DEFAULT_SESSION_TTL_MS } from '../modules/identity/service.js';

function sendAuthError(reply, err) {
  if (err instanceof TooManyRequestsError) {
    reply.header('retry-after', String(err.retryAfterSec));
  }
  if (err instanceof AuthError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/** Scoped/global error handler so auth errors keep `{ error, message }` shape. */
export function authErrorHandler(error, request, reply) {
  if (!sendAuthError(reply, error)) {
    reply.send(error);
  }
}

function asyncRoute(handler) {
  return async function route(request, reply) {
    try {
      return await handler(request, reply);
    } catch (err) {
      if (!sendAuthError(reply, err)) throw err;
    }
  };
}

function registerRoutes(app, service, guards, { cookieName, cookieOptions }) {
  app.setErrorHandler(authErrorHandler);
  app.addHook('onRequest', guards.attachSession);

  app.post(
    '/login',
    asyncRoute(async (request, reply) => {
      const { email, password } = request.body ?? {};
      const result = await service.login({
        email,
        password,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setCookie(reply, cookieName, result.token, cookieOptions);
      return reply.send({
        user: result.user,
        csrfToken: result.csrfToken,
        expiresAt: result.session.expires_at,
      });
    }),
  );

  app.post(
    '/logout',
    { preHandler: [guards.requireAuth, guards.requireCsrf] },
    asyncRoute(async (request, reply) => {
      await service.logout({ session: request.auth.session, ip: request.ip });
      clearCookie(reply, cookieName, cookieOptions);
      return reply.send({ ok: true });
    }),
  );

  app.get(
    '/session',
    { preHandler: [guards.requireAuth] },
    asyncRoute(async (request, reply) => {
      const { user, session } = request.auth;
      return reply.send({
        user,
        expiresAt: session.expires_at,
      });
    }),
  );
}

export function createAuth(options = {}) {
  const cookieName = options.cookieName ?? config.session.cookieName;
  const secureCookies = options.secureCookies ?? config.isProduction;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const service = options.service ?? createAuthService({ ...options, sessionTtlMs });
  // Sharing the guards instance with the web layer avoids resolving a session
  // twice under two competing `onRequest` hooks with divergent cookie options.
  const guards =
    options.guards ??
    createGuards({
      service,
      cookieName,
      csrfHeader: options.csrfHeader,
    });
  const cookieOptions = {
    maxAgeMs: sessionTtlMs,
    secure: secureCookies,
    sameSite: 'Lax',
    httpOnly: true,
    path: '/',
  };

  async function plugin(app) {
    registerRoutes(app, service, guards, { cookieName, cookieOptions });
  }

  return { service, guards, plugin, cookieName, cookieOptions };
}

/**
 * Ready-to-register Fastify plugin: `app.register(authPlugin, { });`
 * Auth routes are published under the registration prefix (default `/auth`).
 */
export async function authPlugin(app, opts = {}) {
  const auth = createAuth(opts);
  await auth.plugin(app);
}

export default authPlugin;
