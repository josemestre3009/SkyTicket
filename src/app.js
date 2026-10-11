import Fastify from 'fastify';
import { loggerOptions } from './logger.js';
import { ping } from './db/index.js';
import { config } from './config.js';
import { createRuntime } from './bootstrap.js';
import { createAuth } from './auth/plugin.js';
import { createWebPlugin } from './web/plugin.js';

export async function healthRoutes(app) {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (request, reply) => {
    try {
      await ping();
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      request.log.warn({ err: err.message }, 'readiness check failed');
      reply.code(503);
      return { status: 'unavailable', db: 'down' };
    }
  });
}

/**
 * Baseline hardening for every response. Inline script/style is never emitted,
 * so a self-only CSP holds for both SSR pages and static assets.
 */
export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
});

function securityHeaders(app) {
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });
}

/**
 * Root error handler for routes that never opted into an HTML/auth handler.
 * Always answers with a safe JSON envelope; 5xx never leaks the raw message.
 */
function safeErrors(app) {
  app.setErrorHandler((error, request, reply) => {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled request error');
    reply.code(status).send({
      error: status >= 500 ? 'internal_error' : (error?.code ?? 'error'),
      message: status >= 500 ? 'Internal server error' : (error?.message ?? 'Request failed'),
    });
  });
}

export function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? loggerOptions,
    trustProxy: options.trustProxy ?? config.trustProxy,
  });

  const runtime = options.runtime ?? createRuntime(options);

  securityHeaders(app);
  safeErrors(app);
  app.register(healthRoutes);

  // JSON auth API under /auth, sharing the exact session/guards as the web layer
  // so neither registers a second, divergent session resolution hook.
  const auth = createAuth({
    service: runtime.services.identity,
    guards: runtime.guards,
    secureCookies: options.secureCookies ?? config.isProduction,
    cookieName: options.cookieName,
  });
  app.register(auth.plugin, { prefix: '/auth' });

  const web = createWebPlugin({
    services: runtime.services,
    guards: runtime.guards,
    config: runtime.config,
    secureCookies: options.secureCookies ?? config.isProduction,
  });
  app.register(web.plugin);

  app.decorate('runtime', runtime);
  return app;
}

export default buildApp;
