import { AuthError, ConflictError, ForbiddenError } from '../../auth/errors.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import { hashPassword } from '../../lib/password.js';
import { NOTIFICATION_TYPES } from '../notifications/matrix.js';
import * as identityRepo from '../identity/repository.js';
import * as walletRepo from '../wallet/repository.js';
import * as repo from './repository.js';

/** Minimum length for a manually issued temporary reseller password. */
export const MIN_TEMP_PASSWORD_LENGTH = 12;

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

export const RESELLER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  RESTRICTED: 'restricted',
  CLOSED: 'closed',
});

export const RESELLER_STATUSES = Object.freeze(Object.values(RESELLER_STATUS));

/** Allowed lifecycle transitions. `closed` is a terminal history state. */
export const RESELLER_TRANSITIONS = Object.freeze({
  pending: ['active', 'closed'],
  active: ['suspended', 'restricted', 'closed'],
  suspended: ['active', 'closed'],
  restricted: ['active', 'suspended', 'closed'],
  closed: [],
});

/**
 * Only `active` and `restricted` resellers may start a session (see
 * reseller-management spec): `pending` is not yet provisioned, `suspended`
 * must not log in and `closed` is retained as administrative history only.
 */
export function canLogin(status) {
  return status === RESELLER_STATUS.ACTIVE || status === RESELLER_STATUS.RESTRICTED;
}

export function canEmit(status) {
  return status === RESELLER_STATUS.ACTIVE;
}

export function canConsult(status) {
  return status === RESELLER_STATUS.ACTIVE || status === RESELLER_STATUS.RESTRICTED;
}

export function assertResellerTransition(from, to) {
  if (from === to) return;
  const allowed = RESELLER_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ConflictError(`invalid reseller transition ${from} -> ${to}`, 'invalid_transition');
  }
}

export function toResellerDto(reseller) {
  if (!reseller) return null;
  return {
    id: reseller.id,
    name: reseller.name,
    status: reseller.status,
    currency: reseller.currency,
    lowBalanceThresholdMinor: Number(reseller.low_balance_threshold_minor),
    canLogin: canLogin(reseller.status),
    canEmit: canEmit(reseller.status),
    canConsult: canConsult(reseller.status),
  };
}

function isClientIdentifier(value) {
  return value !== undefined && value !== null && value !== '';
}

export function createResellerService(options = {}) {
  const runner = options.runner;
  const auditFn = options.audit ?? recordAudit;
  const notifications = options.notifications ?? null;
  const passwordParams = options.passwordParams;

  function resolveTenant(auth, explicitResellerId) {
    if (!auth?.user) throw new ForbiddenError('Authentication required', 'unauthorized');
    if (auth.user.role === 'admin') {
      if (!explicitResellerId) throw new ValidationError('reseller_id is required', 'reseller_id_required');
      return explicitResellerId;
    }
    if (auth.user.role === 'reseller') {
      if (!auth.user.reseller_id) throw new ForbiddenError('No reseller scope', 'forbidden');
      if (explicitResellerId && explicitResellerId !== auth.user.reseller_id) {
        throw new ForbiddenError('Cross-tenant access denied', 'cross_tenant');
      }
      return auth.user.reseller_id;
    }
    throw new ForbiddenError('Access denied', 'forbidden');
  }

  /** Never trust reseller_id/groupId supplied by a reseller-scoped client. */
  function assertNoIdentityOverride(auth, input = {}) {
    if (auth?.user?.role !== 'reseller') return;
    if (
      isClientIdentifier(input.reseller_id) ||
      isClientIdentifier(input.resellerId) ||
      isClientIdentifier(input.groupId) ||
      isClientIdentifier(input.group_id)
    ) {
      throw new ForbiddenError('Client may not select tenant identifiers', 'cross_tenant');
    }
  }

  async function createReseller({ name, status = RESELLER_STATUS.PENDING, lowBalanceThresholdMinor = 0 }, opts = {}) {
    if (!name || !String(name).trim()) throw new ValidationError('name is required', 'name_required');
    if (!RESELLER_STATUSES.includes(status)) throw new ValidationError(`unknown status ${status}`, 'invalid_status');
    return repo.createReseller(
      { name: String(name).trim(), status, lowBalanceThresholdMinor },
      opts.runner ?? runner,
    );
  }

  /**
   * Atomic reseller + first reseller-user provisioning. The reseller row, its
   * wallet and the login are created in one transaction: a duplicate email
   * aborts everything, so no reseller is left without a user (or vice versa).
   * The uploaded password is hashed with scrypt and never written to the audit
   * trail.
   */
  async function createResellerWithUser(
    {
      name,
      email,
      password,
      lowBalanceThresholdMinor = 0,
      status = RESELLER_STATUS.ACTIVE,
      createWallet = true,
      actor = null,
      ip = null,
    } = {},
    opts = {},
  ) {
    const normalizedName = String(name ?? '').trim();
    if (!normalizedName) throw new ValidationError('name is required', 'name_required');

    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new ValidationError('a valid email is required', 'email_required');
    }
    if (typeof password !== 'string' || password.length < MIN_TEMP_PASSWORD_LENGTH) {
      throw new ValidationError(
        `password must be at least ${MIN_TEMP_PASSWORD_LENGTH} characters`,
        'password_too_short',
      );
    }
    if (!RESELLER_STATUSES.includes(status)) throw new ValidationError(`unknown status ${status}`, 'invalid_status');
    if (!Number.isInteger(lowBalanceThresholdMinor) || lowBalanceThresholdMinor < 0) {
      throw new ValidationError('lowBalanceThresholdMinor must be a non-negative integer', 'invalid_threshold');
    }

    const client = opts.runner ?? runner;
    try {
      return await repo.transaction(client, async (tx) => {
        const reseller = await repo.createReseller(
          { name: normalizedName, status, lowBalanceThresholdMinor },
          tx,
        );

        // ponytail: a wallet row is created up-front so the tenant can be
        // credited immediately; drop to lazy wallet creation if provisioning
        // ever needs to stay catalog-only. Pass createWallet:false to skip.
        if (createWallet) await walletRepo.ensureWallet(reseller.id, tx);

        const user = await identityRepo.createUser(
          {
            email: normalizedEmail,
            passwordHash: hashPassword(password, passwordParams),
            role: 'reseller',
            resellerId: reseller.id,
            // ponytail: flag is persisted but not yet enforced at login (no
            // forced rotation screen). Enforce in the login/guards flow when the
            // password-change UI lands.
            mustChangePassword: true,
          },
          tx,
        );

        await auditFn(
          {
            actorUserId: actor?.id ?? null,
            actorRole: actor?.role ?? null,
            resellerId: reseller.id,
            action: AUDIT_ACTIONS.RESELLER_CREATE,
            entityType: 'reseller',
            entityId: reseller.id,
            after: {
              name: reseller.name,
              email: user.email,
              status: reseller.status,
              lowBalanceThresholdMinor: Number(reseller.low_balance_threshold_minor),
              userId: user.id,
              mustChangePassword: user.must_change_password,
            },
            ip,
            result: 'success',
          },
          tx,
        );

        return {
          reseller,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            resellerId: user.reseller_id,
            mustChangePassword: Boolean(user.must_change_password),
          },
        };
      });
    } catch (err) {
      if (err?.code === '23505') {
        throw new ConflictError('email already in use', 'email_taken');
      }
      throw err;
    }
  }

  /**
   * Provision an additional login for an existing reseller. The user, role and
   * audit row commit together; a duplicate email rolls the whole thing back.
   * The uploaded password is hashed with scrypt and never written to the audit
   * trail (nor returned to the caller). `closed` resellers are refused.
   */
  async function createUserForReseller(
    { resellerId, email, password, actor = null, ip = null } = {},
    opts = {},
  ) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new ValidationError('a valid email is required', 'email_required');
    }
    if (typeof password !== 'string' || password.length < MIN_TEMP_PASSWORD_LENGTH) {
      throw new ValidationError(
        `password must be at least ${MIN_TEMP_PASSWORD_LENGTH} characters`,
        'password_too_short',
      );
    }

    const client = opts.runner ?? runner;
    try {
      return await repo.transaction(client, async (tx) => {
        const reseller = await repo.findResellerById(resellerId, tx);
        if (!reseller) throw new NotFoundError('Reseller not found', 'reseller_not_found');
        if (reseller.status === RESELLER_STATUS.CLOSED) {
          throw new ValidationError('Reseller is closed and can not receive new users', 'reseller_closed');
        }

        const user = await identityRepo.createUser(
          {
            email: normalizedEmail,
            passwordHash: hashPassword(password, passwordParams),
            role: 'reseller',
            resellerId: reseller.id,
            mustChangePassword: true,
          },
          tx,
        );

        await auditFn(
          {
            actorUserId: actor?.id ?? null,
            actorRole: actor?.role ?? null,
            resellerId: reseller.id,
            action: AUDIT_ACTIONS.RESELLER_USER_CREATE,
            entityType: 'user',
            entityId: user.id,
            after: {
              email: user.email,
              role: user.role,
              resellerId: user.reseller_id,
              mustChangePassword: Boolean(user.must_change_password),
            },
            ip,
            result: 'success',
          },
          tx,
        );

        return {
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            resellerId: user.reseller_id,
            mustChangePassword: Boolean(user.must_change_password),
          },
        };
      });
    } catch (err) {
      if (err?.code === '23505') {
        throw new ConflictError('email already in use', 'email_taken');
      }
      throw err;
    }
  }

  async function getReseller(resellerId, opts = {}) {
    const reseller = await repo.findResellerById(resellerId, opts.runner ?? runner);
    if (!reseller) throw new NotFoundError('Reseller not found', 'reseller_not_found');
    return reseller;
  }

  /**
   * Safe email lookup for admin actions (e.g. recharge-by-email). Rejects
   * malformed emails, unknown emails and archived resellers; returns only
   * identity fields, never the user's password hash or other secrets.
   */
  async function findResellerByUserEmail(email, opts = {}) {
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new ValidationError('a valid email is required', 'email_required');
    }
    const row = await repo.findResellerByUserEmail(normalized, opts.runner ?? runner);
    if (!row) throw new NotFoundError('No reseller matches that email', 'reseller_not_found');
    if (row.archived_at) throw new ValidationError('Reseller is archived', 'reseller_archived');
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      archived: false,
      email: row.email,
    };
  }

  /** Emission gate: only an `active` reseller may create or dispatch a voucher order. */
  async function assertCanEmit(resellerId, opts = {}) {
    const reseller = await repo.findResellerById(resellerId, opts.runner ?? runner);
    if (!reseller || !canEmit(reseller.status)) {
      throw new ForbiddenError('Reseller is not allowed to emit vouchers', 'reseller_cannot_emit');
    }
    return reseller;
  }

  function listResellers(params = {}, opts = {}) {
    return repo.listResellers(params, opts.runner ?? runner);
  }

  async function setStatus({ resellerId, status, actor = null, reason = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    if (!RESELLER_STATUSES.includes(status)) throw new ValidationError(`unknown status ${status}`, 'invalid_status');
    return repo.transaction(client, async (tx) => {
      const current = await repo.findResellerById(resellerId, tx);
      if (!current) throw new NotFoundError('Reseller not found', 'reseller_not_found');
      if (current.status === status) return { reseller: current, changed: false };

      assertResellerTransition(current.status, status);
      const updated = await repo.updateResellerStatus(resellerId, status, tx);

      let revoked = [];
      if (status === RESELLER_STATUS.SUSPENDED || status === RESELLER_STATUS.CLOSED) {
        revoked = await repo.revokeResellerSessions(resellerId, `reseller_${status}`, tx);
      }

      // Suspension alerts are committed atomically with the status change; email
      // delivery is enqueued here and sent later by the worker.
      if (status === RESELLER_STATUS.SUSPENDED && notifications?.emit) {
        await notifications.emit(
          {
            type: NOTIFICATION_TYPES.SUSPENSION,
            resourceType: 'reseller',
            resourceId: resellerId,
            resellerId,
            title: 'Cuenta suspendida',
            body: 'Tu cuenta fue suspendida. Contacta al administrador.',
            reason,
          },
          { runner: tx },
        );
      }

      await auditFn(
        {
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          resellerId,
          action: AUDIT_ACTIONS.RESELLER_SUSPENSION,
          entityType: 'reseller',
          entityId: resellerId,
          before: { status: current.status },
          after: { status },
          reason,
          ip,
          result: 'success',
        },
        tx,
      );

      return { reseller: updated, changed: true, revokedSessions: revoked.length };
    });
  }

  async function deleteReseller({ resellerId, actor = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const current = await repo.findResellerById(resellerId, tx);
      if (!current) throw new NotFoundError('Reseller not found', 'reseller_not_found');
      if (current.archived_at) return { reseller: current, deleted: false, revokedSessions: 0 };

      // ponytail: physical deletion is intentionally unavailable because
      // financial ledger, orders and append-only audit history must survive.
      const archived = await repo.archiveReseller(resellerId, tx);
      const revoked = await repo.revokeResellerSessions(resellerId, 'reseller_deleted', tx);
      await auditFn(
        {
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          resellerId,
          action: AUDIT_ACTIONS.RESELLER_DELETE,
          entityType: 'reseller',
          entityId: resellerId,
          before: { status: current.status },
          after: { status: archived.status, deleted: true },
          ip,
          result: 'success',
        },
        tx,
      );
      return { reseller: archived, deleted: true, revokedSessions: revoked.length };
    });
  }

  async function createConnection(payload, opts = {}) {
    if (!payload.region || !payload.baseUrl || !payload.appId || !payload.appSecretEncrypted) {
      throw new ValidationError('region, baseUrl, appId and appSecretEncrypted are required', 'connection_fields');
    }
    return repo.createConnection(payload, opts.runner ?? runner);
  }

  async function upsertSite(payload, opts = {}) {
    if (!payload.connectionId || !isClientIdentifier(payload.ruijieGroupId) || !payload.name) {
      throw new ValidationError('connectionId, ruijieGroupId and name are required', 'site_fields');
    }
    return repo.upsertSite(payload, opts.runner ?? runner);
  }

  async function assignSite({ resellerId, siteId, actor = null, reason = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const reseller = await repo.findResellerById(resellerId, tx);
      if (!reseller) throw new NotFoundError('Reseller not found', 'reseller_not_found');
      const site = await repo.findSiteById(siteId, tx);
      if (!site) throw new NotFoundError('Site not found', 'site_not_found');

      const assignment = await repo.assignSite({ resellerId, siteId }, tx);
      await auditFn(
        {
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          resellerId,
          action: AUDIT_ACTIONS.SITE_ASSIGNMENT,
          entityType: 'reseller_site',
          entityId: assignment.id,
          after: { resellerId, siteId, status: assignment.status },
          reason,
          ip,
          result: 'success',
        },
        tx,
      );
      return assignment;
    });
  }

  async function unassignSite({ resellerId, siteId, actor = null, reason = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    return repo.transaction(client, async (tx) => {
      const removed = await repo.unassignSite({ resellerId, siteId }, tx);
      if (!removed) throw new NotFoundError('Assignment not found', 'assignment_not_found');
      await auditFn(
        {
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          resellerId,
          action: AUDIT_ACTIONS.SITE_ASSIGNMENT,
          entityType: 'reseller_site',
          entityId: removed.id,
          before: { resellerId, siteId, status: 'active' },
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

  function listSites(params = {}, opts = {}) {
    return repo.listSites(params, opts.runner ?? runner);
  }

  function listResellerSites(resellerId, opts = {}) {
    return repo.listResellerSites(resellerId, opts.runner ?? runner);
  }

  function listSiteResellers(siteId, opts = {}) {
    return repo.listSiteResellers(siteId, opts.runner ?? runner);
  }

  function listResellerUsers(resellerId, opts = {}) {
    return repo.listResellerUsers(resellerId, opts.runner ?? runner);
  }

  /**
   * Resolve the local site context (region/connection/tenant/groupId) and assert
   * the session tenant owns an active assignment. Client-supplied identifiers are
   * rejected before any adapter is consulted.
   */
  async function authorizeSiteAccess({ auth, siteId, clientIdentifiers = {}, adapter = null, ip = null }, opts = {}) {
    const client = opts.runner ?? runner;
    assertNoIdentityOverride(auth, clientIdentifiers);
    const resellerId = resolveTenant(auth, clientIdentifiers.resellerId ?? clientIdentifiers.reseller_id);

    const site = await repo.findSiteContext(siteId, client);
    const assignment = site ? await repo.findAssignment(resellerId, siteId, client) : null;

    if (!site || site.status !== 'active' || !assignment || assignment.status !== 'active') {
      await auditFn(
        {
          actorUserId: auth.user.id,
          actorRole: auth.user.role,
          resellerId,
          action: AUDIT_ACTIONS.AUTH_CROSS_TENANT_DENIED,
          entityType: 'site',
          entityId: siteId,
          reason: 'site_not_authorized',
          ip,
          result: 'denied',
        },
        client,
      );
      throw new ForbiddenError('Site not authorized for this tenant', 'cross_tenant');
    }

    // Only reached after authorization; the adapter is never contacted on denial.
    const connection = adapter
      ? await adapter.resolveConnection({ site, resellerId })
      : { region: site.connection_region, baseUrl: site.connection_base_url };

    return {
      resellerId,
      site: {
        id: site.id,
        ruijieGroupId: site.ruijie_group_id,
        ruijieTenantId: site.ruijie_tenant_id,
        status: site.status,
      },
      connection,
    };
  }

  return {
    createReseller,
    createResellerWithUser,
    createUserForReseller,
    getReseller,
    findResellerByUserEmail,
    listResellers,
    setStatus,
    deleteReseller,
    createConnection,
    upsertSite,
    assignSite,
    unassignSite,
    listSites,
    listResellerSites,
    listSiteResellers,
    listResellerUsers,
    authorizeSiteAccess,
    assertCanEmit,
    resolveTenant,
    assertNoIdentityOverride,
    canLogin,
    canEmit: canEmit,
    canConsult,
  };
}
