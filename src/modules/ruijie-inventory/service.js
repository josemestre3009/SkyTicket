import { AuthError } from '../../auth/errors.js';
import { config as defaultConfig } from '../../config.js';
import { Cipher } from '../../lib/crypto.js';
import { maskCode } from '../../lib/redact.js';
import { createRuijieClient } from '../../ruijie/client.js';
import { normalizeStatus } from '../../ruijie/normalize.js';
import { syncPaginated } from '../../ruijie/sync.js';
import * as defaultRepo from './repository.js';

const DEFAULT_BASE_URL = 'https://cloud-eu.ruijienetworks.com';

export class ValidationError extends AuthError {
  constructor(message, code = 'validation_error') {
    super(message, { statusCode: 400, code });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AuthError {
  constructor(message, code = 'not_found') {
    super(message, { statusCode: 404, code });
    this.name = 'NotFoundError';
  }
}

export class ReadDisabledError extends AuthError {
  constructor(message = 'Ruijie read is disabled or has no credentials', code = 'ruijie_read_disabled') {
    super(message, { statusCode: 503, code });
    this.name = 'ReadDisabledError';
  }
}

/**
 * Persist only the useful site nodes: BUILDING groups when present, otherwise
 * the leaf groups so a tree without buildings still yields something to browse.
 */
export function selectSiteNodes(nodes = []) {
  const buildings = nodes.filter((node) => String(node.type ?? '').toUpperCase() === 'BUILDING');
  if (buildings.length) return buildings;
  const parents = new Set(nodes.map((node) => node.parentGroupId).filter(Boolean));
  return nodes.filter((node) => !parents.has(node.groupId));
}

/** Accepts either an already-normalized status or a raw Ruijie code. */
export function normalizeVoucherStatus(value) {
  if (value === 'unused' || value === 'in_use' || value === 'expired') return value;
  return normalizeStatus(value);
}

/** Map a normalized Ruijie user group to the catalog package shape. */
export function toPackageDto(group = {}) {
  return {
    ruijieUserGroupId: group.userGroupId ?? group.id ?? null,
    ruijieProfileId: group.profileId ?? null,
    name: group.name ?? String(group.userGroupId ?? group.id ?? ''),
    duration: group.timePeriod ?? null,
    quota: group.quota ?? null,
    upSpeed: group.uploadRateLimit ?? null,
    downSpeed: group.downloadRateLimit ?? null,
    bindMac: group.bindMac ?? null,
    raw: group.raw ?? null,
  };
}

/** Masked remote voucher for the panel: never the plaintext code nor raw payload. */
export function toRemoteVoucherDto(voucher = {}) {
  return {
    uuid: voucher.uuid ?? null,
    codeMasked: maskCode(voucher.code),
    alias: voucher.alias ?? null,
    status: normalizeVoucherStatus(voucher.status ?? voucher.rawStatus),
    rawStatus: voucher.rawStatus ?? null,
    expiryTime: voucher.expiryTime ?? null,
    createTime: voucher.createTime ?? null,
    packageName: voucher.packageName ?? null,
    maxClients: voucher.maxClients ?? null,
    currentClients: voucher.currentClients ?? null,
    quota: voucher.quota ?? null,
  };
}

export function summarizeVouchers(vouchers = []) {
  const summary = { total: vouchers.length, unused: 0, in_use: 0, expired: 0, unknown: 0 };
  for (const voucher of vouchers) {
    const status = normalizeVoucherStatus(voucher.status ?? voucher.rawStatus);
    if (Object.hasOwn(summary, status)) summary[status] += 1;
    else summary.unknown += 1;
  }
  return summary;
}

/**
 * Read-only Ruijie inventory. It never calls create, is independent from
 * `RUIJIE_LIVE_ENABLED`, and is gated by `RUIJIE_READ_ENABLED` (default: true
 * only when credentials are present). Credentials live in the backend config or
 * in an encrypted `ruijie_connections` row; secrets never leave this module.
 */
export function createRuijieInventoryService(options = {}) {
  const cfg = options.config ?? defaultConfig;
  const repo = options.repository ?? defaultRepo;
  const catalog = options.catalog ?? null;
  const clientFactory = options.clientFactory ?? createRuijieClient;
  const runner = options.runner;
  const clients = new Map();

  function assertCatalog() {
    if (!catalog || typeof catalog.syncPackages !== 'function') {
      throw new Error('catalog service with syncPackages is required for package sync');
    }
    return catalog;
  }

  let cipher = options.cipher ?? null;
  function getCipher() {
    if (!cipher) cipher = Cipher.fromConfig();
    return cipher;
  }

  function envCredentials() {
    const ruijie = cfg.ruijie ?? {};
    if (!ruijie.appId || !ruijie.appSecret) return null;
    return {
      region: ruijie.region || 'eu',
      baseUrl: ruijie.baseUrl || DEFAULT_BASE_URL,
      appId: ruijie.appId,
      appSecret: ruijie.appSecret,
      apiToken: ruijie.apiToken || null,
    };
  }

  function assertReadEnabled() {
    if (!cfg.ruijie?.readEnabled) throw new ReadDisabledError();
  }

  /** Encrypt env credentials and upsert them into `ruijie_connections`. */
  async function ensureEnvConnection(opts = {}) {
    const creds = envCredentials();
    if (!creds) return null;
    return repo.createConnection(
      {
        region: creds.region,
        baseUrl: creds.baseUrl,
        appId: creds.appId,
        appSecretEncrypted: getCipher().encrypt(creds.appSecret),
        apiTokenEncrypted: creds.apiToken ? getCipher().encrypt(creds.apiToken) : null,
      },
      opts.runner ?? runner,
    );
  }

  function toClientConnection(row) {
    return {
      id: row.id,
      region: row.region,
      baseUrl: row.base_url,
      appId: row.app_id,
      appSecret: getCipher().decrypt(row.app_secret_encrypted),
      apiToken: row.api_token_encrypted ? getCipher().decrypt(row.api_token_encrypted) : undefined,
    };
  }

  function clientFor(connection) {
    if (!clients.has(connection.id)) {
      clients.set(
        connection.id,
        clientFactory({
          connection,
          cipher: getCipher(),
          fetchImpl: options.fetchImpl,
          clock: options.clock,
          sleep: options.sleep,
          jitter: options.jitter,
          tokenStore: options.tokenStore,
          circuitStore: options.circuitStore,
          maxAttempts: options.maxAttempts,
          backoffBaseMs: options.backoffBaseMs,
          backoffCapMs: options.backoffCapMs,
          tokenTtlMs: options.tokenTtlMs,
          expirySkewMs: options.expirySkewMs,
          circuitFailureThreshold: options.circuitFailureThreshold,
          circuitResetTimeoutMs: options.circuitResetTimeoutMs,
        }),
      );
    }
    return clients.get(connection.id);
  }

  /** Connection row for a specific site, falling back to the env-seeded one. */
  async function resolveConnectionRow(site, opts = {}) {
    if (site?.ruijie_connection_id) {
      const row = await repo.findConnectionById(site.ruijie_connection_id, opts.runner ?? runner);
      if (row?.app_secret_encrypted) return { row, seeded: false };
    }
    const seeded = await ensureEnvConnection(opts);
    return { row: seeded, seeded: true };
  }

  async function clientForSite(site, opts = {}) {
    const { row } = await resolveConnectionRow(site, opts);
    if (!row) throw new ReadDisabledError();
    return clientFor(toClientConnection(row));
  }

  /**
   * Fetch the Ruijie group tree and upsert the useful nodes as sites. Secrets
   * are encrypted into `ruijie_connections` before any outbound call.
   */
  async function syncSites(params = {}, opts = {}) {
    assertReadEnabled();
    const runnerClient = opts.runner ?? runner;
    const { row } = params.connectionId
      ? { row: await repo.findConnectionById(params.connectionId, runnerClient) }
      : { row: await ensureEnvConnection({ runner: runnerClient }) };
    if (!row?.app_secret_encrypted) throw new ReadDisabledError();

    const tree = await clientFor(toClientConnection(row)).getGroupTree({ depth: 'BUILDING' });
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const siteNodes = selectSiteNodes(nodes);

    const sites = await repo.transaction(runnerClient, async (tx) => {
      const saved = [];
      for (const node of siteNodes) {
        saved.push(
          await repo.upsertSite(
            {
              connectionId: row.id,
              ruijieGroupId: node.groupId,
              name: node.name ?? node.groupId,
              timezone: node.timezone ?? null,
              rawJson: node.raw ?? null,
            },
            tx,
          ),
        );
      }
      await repo.deactivateMissingSites(
        row.id,
        saved.map((site) => site.ruijie_group_id),
        tx,
      );
      return saved;
    });

    return { connectionId: row.id, discovered: nodes.length, sites };
  }

  /**
   * Page `getList` until the reported count is reached or a page is empty.
   * Returns masked codes only plus a per-status summary.
   */
  async function listRemoteVouchers(siteId, params = {}, opts = {}) {
    assertReadEnabled();
    if (!siteId) throw new ValidationError('siteId is required', 'site_required');
    const runnerClient = opts.runner ?? runner;

    const site = await repo.findSiteById(siteId, runnerClient);
    if (!site) throw new NotFoundError('Site not found', 'site_not_found');

    const client = await clientForSite(site, { runner: runnerClient });
    const collected = [];
    const result = await syncPaginated({
      pageSize: params.pageSize ?? 200,
      maxPages: params.maxPages ?? Number.POSITIVE_INFINITY,
      fetchPage: ({ offset, pageSize }) =>
        client.listVouchers(site.ruijie_group_id, { offset, pageSize }),
      persist: (list) => {
        collected.push(...list);
      },
    });

    const vouchers = collected.map(toRemoteVoucherDto);
    return {
      siteId: site.id,
      count: result.total ?? vouchers.length,
      received: vouchers.length,
      vouchers,
      summary: summarizeVouchers(vouchers),
    };
  }

  /**
   * Page every user group of a site and persist them as catalog packages via
   * the injected catalog service. If a page fails the packages already fetched
   * are upserted with `deactivate: false`, so a failed query never disables
   * existing packages; a valid empty response may deactivate them.
   */
  async function syncPackages(siteId, params = {}, opts = {}) {
    assertReadEnabled();
    if (!siteId) throw new ValidationError('siteId is required', 'site_required');
    const store = assertCatalog();
    const runnerClient = opts.runner ?? runner;

    const site = await repo.findSiteById(siteId, runnerClient);
    if (!site) throw new NotFoundError('Site not found', 'site_not_found');

    const client = await clientForSite(site, { runner: runnerClient });
    const collected = [];
    let complete = true;
    let error = null;
    try {
      await syncPaginated({
        pageSize: params.pageSize ?? 200,
        maxPages: params.maxPages ?? Number.POSITIVE_INFINITY,
        fetchPage: ({ offset, pageSize }) =>
          client.listUserGroups(site.ruijie_group_id, { offset, pageSize }),
        persist: (list) => {
          collected.push(...list);
        },
      });
    } catch (err) {
      complete = false;
      error = err;
    }

    const packages = collected.map(toPackageDto);
    const result = await store.syncPackages(
      { siteId: site.id, packages, deactivate: complete },
      { runner: runnerClient },
    );
    return {
      siteId: site.id,
      received: packages.length,
      complete,
      error: error ? error.message : null,
      ...result,
    };
  }

  /**
   * Full catalog sync: discover sites first, then pull each site's user groups.
   * A failing site is reported but never aborts the remaining sites, and never
   * disables that site's existing packages.
   */
  async function syncCatalog(params = {}, opts = {}) {
    assertReadEnabled();
    assertCatalog();
    const runnerClient = opts.runner ?? runner;

    const siteResult = await syncSites(params, { runner: runnerClient });
    const sites = [];
    for (const site of siteResult.sites) {
      sites.push(await syncPackages(site.id, params, { runner: runnerClient }));
    }
    return {
      connectionId: siteResult.connectionId,
      discoveredSites: siteResult.discovered,
      syncedSites: sites.length,
      packageCount: sites.reduce((total, site) => total + site.received, 0),
      sites,
      errors: sites
        .filter((site) => site.error)
        .map((site) => ({ siteId: site.siteId, error: site.error })),
    };
  }

  return {
    isReadEnabled: () => Boolean(cfg.ruijie?.readEnabled),
    syncSites,
    syncPackages,
    syncCatalog,
    listRemoteVouchers,
    resolveConnectionRow,
  };
}

export const createRuijieInventory = createRuijieInventoryService;
export default createRuijieInventoryService;
