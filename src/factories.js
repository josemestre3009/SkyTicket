import { config as defaultConfig } from './config.js';
import { listAuditEvents } from './lib/audit.js';
import { createGuards } from './auth/guards.js';
import { RUIJIE_KIND } from './ruijie/errors.js';
import { createAuthService } from './modules/identity/service.js';
import { createResellerService } from './modules/resellers/service.js';
import { createWalletService } from './modules/wallet/service.js';
import { createCatalogService } from './modules/catalog/service.js';
import { createOrderService } from './modules/orders/service.js';
import { createIssuanceService } from './modules/issuance/service.js';
import { createRuijieAdapter } from './modules/issuance/adapter.js';
import { createNotificationService } from './modules/notifications/service.js';
import { createReconciliationService } from './modules/reconciliation/service.js';
import { createRuijieInventoryService } from './modules/ruijie-inventory/service.js';
import { createAdminDashboardService } from './modules/admin-dashboard/service.js';

/**
 * Adapter used while `RUIJIE_LIVE_ENABLED` is off: it never opens a socket,
 * resolves the site context locally and rejects emission so the order fails
 * cleanly instead of holding balance against an upstream that was not called.
 */
export function createDisabledRuijieAdapter() {
  function disabled() {
    const err = new Error('Ruijie live emission is disabled (RUIJIE_LIVE_ENABLED=false)');
    err.kind = RUIJIE_KIND.NON_RECOVERABLE;
    err.code = 'ruijie_live_disabled';
    return err;
  }
  return {
    async resolveConnection({ site }) {
      return {
        id: site?.ruijie_connection_id ?? 'ruijie-disabled',
        region: site?.connection_region ?? null,
        baseUrl: site?.connection_base_url ?? null,
        liveEnabled: false,
      };
    },
    async isCircuitOpen() {
      return false;
    },
    async createVouchers() {
      throw disabled();
    },
    async listVouchers() {
      return { count: 0, list: [], code: 0, raw: null };
    },
  };
}

export function createIssuanceAdapter({ liveEnabled = false, adapter = null, cipher } = {}) {
  if (adapter) return adapter;
  if (liveEnabled) return createRuijieAdapter({ cipher });
  return createDisabledRuijieAdapter();
}

/**
 * Compose the real service graph. `runner` may be injected (a pool or a test
 * shim); when omitted every repository resolves the shared pool lazily, so
 * building the graph never touches the database.
 */
export function buildServices(options = {}) {
  const cfg = options.config ?? defaultConfig;
  const runner = options.runner;
  const base = { ...options, runner };

  const adapter =
    options.adapter ?? createIssuanceAdapter({ liveEnabled: cfg.ruijie?.liveEnabled, cipher: options.cipher });

  // Notifications are built first (no domain dependencies) so wallet, reseller
  // and issuance operations can emit alerts inside their own transaction.
  const notifications = options.notifications ?? createNotificationService(base);
  const identity = options.identity ?? createAuthService(base);
  const resellers = options.resellers ?? createResellerService({ ...base, notifications });
  const wallet = options.wallet ?? createWalletService({ ...base, notifications });
  const catalog = options.catalog ?? createCatalogService(base);
  const orders = options.orders ?? createOrderService({ ...base, catalog, resellerService: resellers });
  const vouchers =
    options.vouchers ??
    createIssuanceService({ ...base, orders, wallet, resellerService: resellers, adapter, notifications });
  const inventory =
    options.inventory ?? createRuijieInventoryService({ ...base, config: cfg, catalog });
  const adminDashboard = options.adminDashboard ?? createAdminDashboardService(base);
  const audit = options.audit ?? { list: (params = {}, opts = {}) => listAuditEvents(params, opts.runner ?? runner) };
  const reconciliation =
    options.reconciliation ??
    createReconciliationService({
      ...base,
      wallet,
      orders,
      thresholds: {
        holdGraceMs: cfg.reconciliation?.holdGraceMs,
        stuckOrderMs: cfg.reconciliation?.stuckOrderMs,
      },
    });

  return { identity, resellers, wallet, catalog, orders, vouchers, notifications, audit, reconciliation, inventory, adminDashboard, adapter };
}

export function buildGuards({ services, config: cfg = defaultConfig, cookieName, csrfHeader } = {}) {
  return createGuards({
    service: services.identity,
    cookieName: cookieName ?? cfg.session.cookieName,
    csrfHeader,
  });
}
