import { AuthError, ConflictError, ForbiddenError } from '../../auth/errors.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import * as repo from './repository.js';
import * as resellerRepo from '../resellers/repository.js';

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

export const PRICE_SCOPES = Object.freeze(['base', 'site', 'reseller', 'reseller_site']);

const SCOPE_TARGETS = Object.freeze({
  base: (r, s) => r == null && s == null,
  site: (r, s) => r == null && s != null,
  reseller: (r, s) => r != null && s == null,
  reseller_site: (r, s) => r != null && s != null,
});

function assertAmount(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new ValidationError('amountMinor must be a non-negative integer (COP)', 'invalid_amount');
  }
}

export function toPriceDto(row) {
  if (!row) return null;
  return {
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    priceRuleId: row.price_rule_id,
    priceVersionId: row.price_version_id,
    scope: row.scope,
  };
}

export function createCatalogService(options = {}) {
  const runner = options.runner;
  const auditFn = options.audit ?? recordAudit;
  const now = options.now ?? (() => new Date());

  async function audit(entry, client) {
    return auditFn(entry, client ?? runner);
  }

  /** Upsert synced sites and non-destructively deactivate resources that vanished. */
  async function syncSites({ connectionId, sites = [] }, opts = {}) {
    const client = opts.runner ?? runner;
    if (!connectionId) throw new ValidationError('connectionId is required', 'connection_required');
    return repo.transaction(client, async (tx) => {
      const upserted = [];
      for (const site of sites) {
        upserted.push(
          await resellerRepo.upsertSite(
            {
              connectionId,
              ruijieGroupId: site.ruijieGroupId ?? site.groupId,
              ruijieTenantId: site.ruijieTenantId ?? null,
              name: site.name,
              timezone: site.timezone ?? null,
              rawJson: site.raw ?? null,
            },
            tx,
          ),
        );
      }
      const disabled = await resellerRepo.deactivateMissingSites(
        connectionId,
        upserted.map((site) => site.ruijie_group_id),
        tx,
      );
      return { upserted: upserted.length, disabled, sites: upserted };
    });
  }

  /**
   * Upsert synced packages and, when `deactivate` is true, disable packages no
   * longer returned by Ruijie. Callers that saw a partial/failed fetch pass
   * `deactivate: false` so a failed query never disables existing packages.
   */
  async function syncPackages({ siteId, packages = [], deactivate = true }, opts = {}) {
    const client = opts.runner ?? runner;
    if (!siteId) throw new ValidationError('siteId is required', 'site_required');
    return repo.transaction(client, async (tx) => {
      const upserted = [];
      for (const pkg of packages) {
        upserted.push(
          await repo.upsertPackage(
            {
              siteId,
              ruijieUserGroupId: pkg.ruijieUserGroupId ?? pkg.userGroupId,
              ruijieProfileId: pkg.ruijieProfileId ?? pkg.profileId ?? null,
              name: pkg.name,
              duration: pkg.duration ?? pkg.timePeriod ?? null,
              quota: pkg.quota ?? null,
              upSpeed: pkg.upSpeed ?? pkg.uploadRateLimit ?? null,
              downSpeed: pkg.downSpeed ?? pkg.downloadRateLimit ?? null,
              concurrentClients: pkg.concurrentClients ?? null,
              bindMac: pkg.bindMac ?? null,
              technicalLimits: pkg.technicalLimits ?? null,
              raw: pkg.raw ?? null,
            },
            tx,
          ),
        );
      }
      const disabled = deactivate
        ? await repo.deactivateMissingPackages(
            siteId,
            upserted.map((pkg) => pkg.ruijie_user_group_id),
            tx,
          )
        : 0;
      return { upserted: upserted.length, disabled, packages: upserted };
    });
  }

  function listPackages({ siteId }, opts = {}) {
    return repo.listPackagesBySite(siteId, opts.runner ?? runner);
  }

  function listAuthorizedPackages({ resellerId, siteId = null }, opts = {}) {
    return repo.listAuthorizedPackages({ resellerId, siteId }, opts.runner ?? runner);
  }

  async function assertPackageAuthorized({ resellerId, siteId, packageId }, opts = {}) {
    const pkg = await repo.findAuthorizedPackage({ resellerId, siteId, packageId }, opts.runner ?? runner);
    if (!pkg) throw new ForbiddenError('Package not authorized for this reseller and site', 'package_not_authorized');
    return pkg;
  }

  async function grantPackage({ resellerId, packageId, actor = null, reason = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const pkg = await repo.findPackageById(packageId, tx);
      if (!pkg) throw new NotFoundError('Package not found', 'package_not_found');
      const permission = await repo.grantPermission({ resellerId, packageId }, tx);
      await audit(
        {
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          resellerId,
          action: AUDIT_ACTIONS.PERMISSION_CHANGE,
          entityType: 'reseller_package_permission',
          entityId: permission.id,
          after: { resellerId, packageId, status: permission.status },
          reason,
          ip,
          result: 'success',
        },
        tx,
      );
      return permission;
    });
  }

  async function revokePackage({ resellerId, packageId, actor = null, reason = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const removed = await repo.revokePermission({ resellerId, packageId }, tx);
      if (!removed) throw new NotFoundError('Permission not found', 'permission_not_found');
      await audit(
        {
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          resellerId,
          action: AUDIT_ACTIONS.PERMISSION_CHANGE,
          entityType: 'reseller_package_permission',
          entityId: removed.id,
          before: { resellerId, packageId, status: 'active' },
          after: { status: 'removed' },
          reason,
          ip,
          result: 'success',
        },
        tx,
      );
      return removed;
    });
  }

  /**
   * Create a new price version. Editing never rewrites history: the prior open
   * version is closed at the new effective time and overlapping windows are
   * rejected by the DB exclusion constraint.
   */
  async function setPrice(params, opts = {}) {
    const {
      packageId,
      scope,
      resellerId = null,
      siteId = null,
      amountMinor,
      currency = 'COP',
      effectiveFrom = null,
      reason = null,
      actor = null,
      ip = null,
    } = params;

    if (!PRICE_SCOPES.includes(scope)) throw new ValidationError(`unknown scope ${scope}`, 'invalid_scope');
    if (!SCOPE_TARGETS[scope](resellerId, siteId)) {
      throw new ValidationError(`scope ${scope} has invalid reseller/site targets`, 'invalid_scope_targets');
    }
    assertAmount(amountMinor);

    const client = opts.runner ?? runner;
    const at = effectiveFrom ? new Date(effectiveFrom) : now();
    try {
      return await repo.transaction(client, async (tx) => {
        const pkg = await repo.findPackageById(packageId, tx);
        if (!pkg) throw new NotFoundError('Package not found', 'package_not_found');

        let rule = await repo.findPriceRule({ packageId, scope, resellerId, siteId }, tx);
        if (!rule) {
          rule = await repo.createPriceRule({ packageId, scope, resellerId, siteId }, tx);
          if (!rule) rule = await repo.findPriceRule({ packageId, scope, resellerId, siteId }, tx);
        }

        await repo.closeOpenPriceVersion(rule.id, at, tx);
        const version = await repo.createPriceVersion(
          {
            priceRuleId: rule.id,
            amountMinor,
            currency,
            effectiveFrom: at,
            createdBy: actor?.id ?? null,
            reason,
          },
          tx,
        );

        await audit(
          {
            actorUserId: actor?.id ?? null,
            actorRole: actor?.role ?? null,
            resellerId: resellerId ?? null,
            action: AUDIT_ACTIONS.PRICE_CHANGE,
            entityType: 'price_version',
            entityId: version.id,
            after: { packageId, scope, amountMinor, currency, effectiveFrom: at.toISOString() },
            reason,
            ip,
            result: 'success',
          },
          tx,
        );
        return version;
      });
    } catch (err) {
      if (err?.code === '23P01') {
        throw new ConflictError('Overlapping price validity window', 'price_overlap');
      }
      throw err;
    }
  }

  /** Deterministic precedence: reseller_site > reseller > site > base. */
  async function resolvePrice({ packageId, resellerId, siteId, at = null }, opts = {}) {
    const effectiveAt = at ? new Date(at) : now();
    const row = await repo.resolvePriceRow(
      { packageId, resellerId, siteId, at: effectiveAt },
      opts.runner ?? runner,
    );
    if (!row) throw new NotFoundError('No active price for package', 'price_missing');
    return toPriceDto(row);
  }

  async function priceSnapshot(params, opts = {}) {
    const price = await resolvePrice(params, opts);
    return { ...price, capturedAt: (params.at ? new Date(params.at) : now()).toISOString() };
  }

  function listPriceRules(packageId, opts = {}) {
    return repo.listPriceRules(packageId, opts.runner ?? runner);
  }

  return {
    syncSites,
    syncPackages,
    listPackages,
    listAuthorizedPackages,
    assertPackageAuthorized,
    grantPackage,
    revokePackage,
    setPrice,
    resolvePrice,
    priceSnapshot,
    listPriceRules,
  };
}
