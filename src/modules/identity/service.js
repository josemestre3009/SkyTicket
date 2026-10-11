import { hashPassword, verifyPassword } from '../../lib/password.js';
import { recordAudit, AUDIT_ACTIONS } from '../../lib/audit.js';
import {
  hashToken,
  hashCsrfToken,
  generateSessionToken,
  generateCsrfToken,
} from '../../auth/tokens.js';
import { canLogin } from '../resellers/service.js';
import { rateLimitHit, rateLimitClear, AUTH_RATE_LIMITS } from '../../auth/rate-limit.js';
import {
  ConflictError,
  ForbiddenError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../auth/errors.js';
import * as repo from './repository.js';

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function toUserDto(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    resellerId: user.reseller_id ?? null,
  };
}

export function createAuthService(options = {}) {
  const runner = options.runner;
  const auditFn = options.audit ?? recordAudit;
  const now = options.now ?? (() => Date.now());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const rateLimits = options.rateLimits ?? AUTH_RATE_LIMITS;
  const passwordParams = options.passwordParams;

  async function audit(entry) {
    return auditFn({ ...entry, correlationId: entry.correlationId ?? null }, runner);
  }

  /**
   * Reseller-scoped sessions are allowed for `active` and `restricted` status.
   * Emission is gated separately (resellers.assertCanEmit), so a restricted
   * reseller may sign in and consult without ever emitting.
   */
  async function assertResellerCanLogin(user) {
    if (user.role !== 'reseller' || !user.reseller_id) return;
    const status = await repo.getResellerStatus(user.reseller_id, runner);
    if (!canLogin(status)) {
      await repo.revokeAllUserSessions(user.id, 'reseller_inactive', runner);
      throw new ForbiddenError('Reseller is not allowed to sign in', 'reseller_inactive');
    }
  }

  async function issueSession({ user, ip, userAgent }) {
    const token = generateSessionToken();
    const csrfToken = generateCsrfToken();
    const expiresAt = new Date(now() + sessionTtlMs);
    const session = await repo.createSession(
      {
        userId: user.id,
        resellerId: user.reseller_id ?? null,
        role: user.role,
        tokenHash: hashToken(token),
        csrfHash: hashCsrfToken(csrfToken),
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        expiresAt,
      },
      runner,
    );
    return { token, csrfToken, session };
  }

  async function login({ email, password, ip, userAgent }) {
    const normalized = String(email ?? '').trim();
    if (!normalized || !password) {
      throw new UnauthorizedError('Invalid credentials', 'invalid_credentials');
    }

    const loginKey = `email:${normalized.toLowerCase()}`;
    const rl = await rateLimitHit({ ...rateLimits.login, key: loginKey }, runner);
    if (!rl.allowed) {
      throw new TooManyRequestsError('Too many login attempts', rl.retryAfterSec);
    }

    const user = await repo.findUserByEmail(normalized, runner);
    const passwordOk = user ? verifyPassword(password, user.password_hash) : false;
    if (!user || !passwordOk || user.status !== 'active') {
      await audit({
        actorUserId: user?.id ?? null,
        actorRole: user?.role ?? null,
        action: AUDIT_ACTIONS.AUTH_LOGIN,
        entityType: 'auth.login',
        reason: 'invalid_credentials',
        ip,
        result: 'failure',
      });
      throw new UnauthorizedError('Invalid credentials', 'invalid_credentials');
    }

    await assertResellerCanLogin(user);
    await rateLimitClear({ ...rateLimits.login, key: loginKey }, runner);
    await repo.markLogin(user.id, runner);

    const { token, csrfToken, session } = await issueSession({
      user,
      ip,
      userAgent,
    });

    await audit({
      actorUserId: user.id,
      actorRole: user.role,
      resellerId: user.reseller_id ?? null,
      action: AUDIT_ACTIONS.AUTH_LOGIN,
      entityType: 'user',
      entityId: user.id,
      ip,
      sessionId: session.id,
      result: 'success',
    });

    return {
      token,
      csrfToken,
      session,
      user: toUserDto(user),
    };
  }

  async function resolve(token) {
    if (!token) return null;
    const session = await repo.findSessionByTokenHash(hashToken(token), runner);
    if (!session || session.revoked_at) return null;

    if (new Date(session.expires_at).getTime() <= now()) {
      await repo.revokeSession(session.id, 'expired', runner);
      return null;
    }
    if (session.user_status !== 'active') {
      await repo.revokeAllUserSessions(session.user_id, 'user_inactive', runner);
      return null;
    }
    if (session.user_role === 'reseller' && !canLogin(session.reseller_status)) {
      await repo.revokeAllUserSessions(session.user_id, 'reseller_inactive', runner);
      return null;
    }

    await repo.touchSession(session.id, runner);
    const user = {
      id: session.user_id,
      email: session.user_email,
      role: session.user_role,
      reseller_id: session.user_reseller_id,
      status: session.user_status,
    };
    return { session, user };
  }

  async function logout({ session, ip }) {
    if (!session) return false;
    await repo.revokeSession(session.id, 'logout', runner);
    await audit({
      actorUserId: session.user_id,
      actorRole: session.role,
      resellerId: session.reseller_id ?? null,
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      entityType: 'session',
      entityId: session.id,
      ip,
      sessionId: session.id,
      result: 'success',
    });
    return true;
  }

  async function ensureAdmin({ email, password }) {
    const normalized = String(email ?? '').trim();
    if (!normalized) throw new Error('ADMIN_EMAIL is required');
    if (!password || typeof password !== 'string') throw new Error('admin password is required');

    const existing = await repo.findUserByEmail(normalized, runner);
    if (existing) {
      if (existing.role !== 'admin') {
        throw new ConflictError('Email already used by a non-admin user', 'email_taken');
      }
      return { created: false, user: existing };
    }

    try {
      const user = await repo.createUser(
        {
          email: normalized,
          passwordHash: hashPassword(password, passwordParams),
          role: 'admin',
        },
        runner,
      );
      await audit({
        actorUserId: user.id,
        actorRole: 'admin',
        action: AUDIT_ACTIONS.AUTH_ADMIN_BOOTSTRAP,
        entityType: 'user',
        entityId: user.id,
        reason: 'admin_bootstrap',
        result: 'success',
      });
      return { created: true, user };
    } catch (err) {
      if (err.code === '23505') {
        const raced = await repo.findUserByEmail(normalized, runner);
        if (raced) return { created: false, user: raced };
      }
      throw err;
    }
  }

  return {
    login,
    resolve,
    logout,
    ensureAdmin,
  };
}
