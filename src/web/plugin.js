import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createGuards } from '../auth/guards.js';
import { createAuthService, DEFAULT_SESSION_TTL_MS } from '../modules/identity/service.js';
import { createResellerService } from '../modules/resellers/service.js';
import { createWalletService } from '../modules/wallet/service.js';
import { createCatalogService } from '../modules/catalog/service.js';
import { createOrderService } from '../modules/orders/service.js';
import { createRuijieInventoryService } from '../modules/ruijie-inventory/service.js';
import { createAdminDashboardService } from '../modules/admin-dashboard/service.js';
import { createRenderer, DEFAULT_PUBLIC_DIR, DEFAULT_VIEWS_DIR } from './render.js';
import { registerWebRoutes } from './routes.js';

const ASSETS = Object.freeze({
  '/assets/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
});

/**
 * Build the SSR web plugin. Everything is injectable so the layer can be
 * exercised with fakes: pass `services`, `guards`, or `authService` to override
 * the production wiring.
 *
 * app.js usage:
 *   import { webPlugin } from './web/index.js';
 *   app.register(webPlugin, { services, guards, config });
 */
export function createWebPlugin(options = {}) {
  const viewsDir = options.viewsDir ?? DEFAULT_VIEWS_DIR;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const render = options.render ?? createRenderer({ viewsDir, cache: options.cache ?? config.isProduction });

  const provided = options.services ?? {};
  const identity = provided.identity ?? options.authService ?? createAuthService(options);
  const resellers = provided.resellers ?? options.resellerService ?? createResellerService(options);
  const wallet = provided.wallet ?? options.walletService ?? createWalletService(options);
  const catalog = provided.catalog ?? options.catalogService ?? createCatalogService(options);
  const orders =
    provided.orders ??
    options.orderService ??
    createOrderService({ ...options, catalog, resellerService: resellers });

  const services = {
    identity,
    resellers,
    wallet,
    catalog,
    orders,
    vouchers: provided.vouchers ?? options.voucherService ?? null,
    notifications: provided.notifications ?? options.notificationService ?? null,
    audit: provided.audit ?? options.auditService ?? null,
    reconciliation: provided.reconciliation ?? options.reconciliationService ?? null,
    inventory:
      provided.inventory ??
      options.inventoryService ??
      createRuijieInventoryService({ ...options, config: options.config ?? config, catalog }),
    adminDashboard:
      provided.adminDashboard ?? options.adminDashboardService ?? createAdminDashboardService(options),
  };

  const cookieName = options.cookieName ?? config.session.cookieName;
  const guards =
    options.guards ??
    createGuards({ service: identity, cookieName, csrfHeader: options.csrfHeader });

  const cookieOptions =
    options.cookieOptions ?? {
      maxAgeMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      secure: options.secureCookies ?? config.isProduction,
      sameSite: 'Lax',
      httpOnly: true,
      path: '/',
    };

  const assetCache = new Map();

  async function sendAsset(reply, definition) {
    let content = assetCache.get(definition.file);
    if (content === undefined) {
      content = await fs.readFile(path.join(publicDir, definition.file), 'utf8');
      assetCache.set(definition.file, content);
    }
    return reply.type(definition.type).send(content);
  }

  async function plugin(app) {
    try {
      app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, done) => {
          try {
            done(null, Object.fromEntries(new URLSearchParams(body)));
          } catch (err) {
            done(err);
          }
        },
      );
    } catch (err) {
      if (err?.code !== 'FST_ERR_CTP_ALREADY_PRESENT') throw err;
    }

    app.addHook('onRequest', async (request) => {
      await guards.attachSession(request);
    });

    for (const [url, definition] of Object.entries(ASSETS)) {
      app.get(url, (_request, reply) => sendAsset(reply, definition));
    }

    registerWebRoutes(app, {
      services,
      guards,
      render,
      options: { ...options, cookieName, cookieOptions, csrfCookieName: options.csrfCookieName },
      config: options.config ?? config,
    });
  }

  return { plugin, services, guards, render, cookieName, cookieOptions };
}

/** Ready-to-register Fastify plugin: `app.register(webPlugin, opts)`. */
export async function webPlugin(app, opts = {}) {
  const web = createWebPlugin(opts);
  await web.plugin(app);
}

export default webPlugin;
