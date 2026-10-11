import crypto from 'node:crypto';
import { parseCookies, setCookie, clearCookie } from '../auth/cookies.js';
import { AuthError, ForbiddenError, UnauthorizedError, TooManyRequestsError } from '../auth/errors.js';
import { redact } from '../lib/redact.js';
import { RESELLER_STATUSES, RESELLER_TRANSITIONS } from '../modules/resellers/service.js';
import { ORDER_STATES } from '../modules/orders/service.js';

/**
 * Services contract consumed by the web layer. Every method is optional at the
 * edges (dashboard aggregates, audit, vouchers);
 * when a method is missing the page degrades to an explicit empty state instead
 * of inventing data. Core flows (auth, resellers, wallet, catalog, orders) rely
 * on the modules' public services.
 */
export function registerWebRoutes(app, ctx) {
  const { services, guards, render, options = {} } = ctx;
  const sessionCookie = options.cookieName;
  const cookieOptions = options.cookieOptions;
  const csrfCookieName = options.csrfCookieName || 'skyticket_csrf';

  const csrfCookieOptions = { ...cookieOptions, httpOnly: false, sameSite: 'Lax', path: '/' };

  function setSessionCookies(reply, { token, csrfToken }) {
    if (token) setCookie(reply, sessionCookie, token, cookieOptions);
    if (csrfToken) setCookie(reply, csrfCookieName, csrfToken, csrfCookieOptions);
  }

  function clearSessionCookies(reply) {
    clearCookie(reply, sessionCookie, cookieOptions);
    clearCookie(reply, csrfCookieName, csrfCookieOptions);
  }

  async function safe(fn, fallback) {
    try {
      const value = await fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function toInt(value, fallback = null) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function csrfFrom(request) {
    return parseCookies(request.headers.cookie)[csrfCookieName] ?? '';
  }

  function navFor(user) {
    if (!user) return [];
    if (user.role === 'admin') {
      return [
        { key: 'dashboard', href: '/dashboard', label: 'Panel', icon: 'dashboard' },
        { key: 'resellers', href: '/admin/resellers', label: 'Revendedores', icon: 'people' },
        { key: 'catalog', href: '/catalog', label: 'Catálogo', icon: 'catalog' },
        { key: 'admin-orders', href: '/admin/orders', label: 'Órdenes', icon: 'orders' },
        { key: 'admin-vouchers', href: '/admin/vouchers', label: 'Bonos Ruijie', icon: 'voucher' },
        { key: 'audit', href: '/admin/audit', label: 'Auditoría', icon: 'audit' },
        { key: 'config', href: '/admin/config', label: 'Configuración', icon: 'gear' },
      ];
    }
    return [
      { key: 'dashboard', href: '/dashboard', label: 'Panel', icon: 'dashboard' },
      { key: 'wallet', href: '/wallet', label: 'Saldo', icon: 'wallet' },
      { key: 'catalog', href: '/catalog', label: 'Catálogo', icon: 'catalog' },
      { key: 'issue', href: '/orders/new', label: 'Emitir', icon: 'plus' },
      { key: 'orders', href: '/orders', label: 'Historial', icon: 'orders' },
    ];
  }

  function commonLocals(request, extra = {}) {
    const auth = request.auth;
    const query = request.query ?? {};
    return {
      title: 'SkyTicket',
      user: auth?.user ?? null,
      role: auth?.user?.role ?? null,
      csrfToken: csrfFrom(request),
      activeNav: '',
      currentPath: request.url,
      nav: navFor(auth?.user),
      notice: query.notice ?? null,
      error: query.error ?? null,
      ...extra,
    };
  }

  async function sendPage(reply, request, view, extra = {}, status = 200) {
    const html = await render.renderPage(view, commonLocals(request, extra));
    return reply.code(status).type('text/html; charset=utf-8').send(html);
  }

  function redirect(reply, location, code = 302) {
    return reply.redirect(location, code);
  }

  function loginLocation(request) {
    const next = request.url && request.url !== '/login' ? request.url : '/dashboard';
    return `/login?next=${encodeURIComponent(next)}`;
  }

  function handlePageError(request, reply, err) {
    if (reply.sent) return reply;
    if (err instanceof UnauthorizedError || err?.code === 'unauthorized') {
      return redirect(reply, loginLocation(request));
    }
    if (err instanceof TooManyRequestsError) {
      return sendPage(
        reply,
        request,
        'error',
        { status: 429, message: `Demasiadas solicitudes. Reintenta en ${err.retryAfterSec}s.` },
        429,
      );
    }
    if (err instanceof AuthError) {
      return sendPage(reply, request, 'error', { status: err.statusCode, message: err.message, code: err.code }, err.statusCode);
    }
    request.log?.error?.({ err }, 'web page error');
    return sendPage(reply, request, 'error', { status: 500, message: 'Error interno del panel.' }, 500);
  }

  function page(handler, { roles = null, isPublic = false } = {}) {
    return async (request, reply) => {
      try {
        if (!isPublic) {
          if (!request.auth) return redirect(reply, loginLocation(request));
          if (roles && !roles.includes(request.auth.user.role)) {
            return sendPage(reply, request, 'error', { status: 403, message: 'No tienes acceso a esta sección.' }, 403);
          }
        }
        return await handler(request, reply);
      } catch (err) {
        return handlePageError(request, reply, err);
      }
    };
  }

  function tenantId(auth, explicit) {
    return services.resellers.resolveTenant(auth, explicit ?? null);
  }

  // ---------------------------------------------------------------- auth ----

  app.get(
    '/login',
    page(
      async (request, reply) => {
        if (request.auth) return redirect(reply, '/dashboard');
        const next = request.query?.next ?? '';
        return sendPage(reply, request, 'login', { email: '', next });
      },
      { isPublic: true },
    ),
  );

  app.post(
    '/login',
    page(
      async (request, reply) => {
        const body = request.body ?? {};
        const email = String(body.email ?? '').trim();
        const next = String(body.next ?? '');
        try {
          const result = await services.identity.login({
            email,
            password: body.password,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
          });
          setSessionCookies(reply, result);
          const target = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
          return redirect(reply, target, 303);
        } catch (err) {
          const status = err instanceof TooManyRequestsError ? 429 : err?.code === 'reseller_inactive' ? 403 : 401;
          const error = err?.code === 'reseller_inactive'
            ? 'La cuenta del revendedor no está activa. Contacta al administrador.'
            : 'Credenciales inválidas.';
          return sendPage(reply, request, 'login', { email, next, error }, status);
        }
      },
      { isPublic: true },
    ),
  );

  app.post(
    '/logout',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        await safe(() => services.identity.logout({ session: request.auth.session, ip: request.ip }));
        clearSessionCookies(reply);
        return redirect(reply, '/login', 303);
      },
      { isPublic: true },
    ),
  );

  // ----------------------------------------------------------- dashboard ----

  app.get('/', page((request, reply) => redirect(reply, '/dashboard')));

  /**
   * Presentation-only view of the admin aggregates. The success-rate
   * percentage and its denominator are derived here so the template stays a
   * dumb formatter; nothing here is business logic.
   */
  function adminOperation(summary) {
    if (!summary) return null;
    const rate = Number(summary.successRate ?? 0);
    const salesCount = Number(summary.salesCount ?? 0);
    return {
      salesCount,
      vouchersIssued: Number(summary.vouchersIssued ?? 0),
      activeResellers: Number(summary.activeResellers ?? 0),
      successPercent: `${Math.round(rate * 100)}%`,
      successResolved: Number(summary.resolvedOrders ?? 0),
    };
  }

  /**
   * Locals for the admin dashboard. Shared by the GET page and the
   * recharge-by-email error re-render so the operator's attempt is preserved.
   * Only email/amount/reference/reason travel back to the form - never
   * credentials or other secrets. The idempotency key travels separately in a
   * hidden field so a retried submit is not double-charged.
   */
  async function adminDashboardLocals(request, error = null, form = null, idempotencyKey = null) {
    const [summary, orders] = await Promise.all([
      safe(() => services.adminDashboard?.getSummary?.(), null),
      safe(() => services.orders.listOrders({ limit: 50 }), []),
    ]);
    return {
      activeNav: 'dashboard',
      variant: 'admin',
      summary,
      operation: adminOperation(summary),
      ranking: summary?.ranking ?? [],
      recentOrders: orders.slice(0, 8),
      error,
      form: form ?? { email: '', amountMinor: '', reference: '', reason: '' },
      idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    };
  }

  app.get(
    '/dashboard',
    page(async (request, reply) => {
      const auth = request.auth;
      if (auth.user.role === 'admin') {
        return sendPage(reply, request, 'dashboard', await adminDashboardLocals(request));
      }
      const resellerId = auth.user.reseller_id;
      const [balance, orders] = await Promise.all([
        safe(() => services.wallet.getBalance(resellerId), null),
        safe(() => services.orders.listOrders({ resellerId, limit: 8 }), []),
      ]);
      return sendPage(reply, request, 'dashboard', {
        activeNav: 'dashboard',
        variant: 'reseller',
        balance,
        recentOrders: orders,
      });
    }),
  );

  app.post(
    '/admin/dashboard/recharge-by-email',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        const form = {
          email: String(body.email ?? '').trim(),
          amountMinor: String(body.amountMinor ?? '').trim(),
          reference: String(body.reference ?? '').trim(),
          reason: String(body.reason ?? '').trim(),
        };
        try {
          // The reseller is resolved server-side from the email; the client
          // never supplies a resellerId for this flow.
          const reseller = await services.resellers.findResellerByUserEmail(form.email);
          await services.wallet.recharge({
            resellerId: reseller.id,
            amountMinor: toInt(body.amountMinor, 0),
            reference: form.reference || null,
            idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
            reason: form.reason,
            actor: request.auth.user,
            ip: request.ip,
          });
          return redirect(reply, '/dashboard?notice=Recarga+registrada', 303);
        } catch (err) {
          const locals = await adminDashboardLocals(request, err.message, form, body.idempotencyKey || null);
          return sendPage(reply, request, 'dashboard', locals, 400);
        }
      },
      { roles: ['admin'] },
    ),
  );

  // ----------------------------------------------------------- resellers ----

  app.get(
    '/admin/resellers',
    page(
      async (request, reply) => {
        const status = request.query?.status ?? null;
        const resellers = await safe(() => services.resellers.listResellers({ status, limit: 200 }), []);
        return sendPage(reply, request, 'resellers', {
          activeNav: 'resellers',
          resellers,
          status,
          statuses: RESELLER_STATUSES,
          form: { name: '' },
          createKey: crypto.randomUUID(),
        });
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/resellers',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        // Preserve name/email/threshold on error; the temporary password is
        // never echoed back into the form or the error page.
        const form = {
          name: String(body.name ?? '').trim(),
          email: String(body.email ?? '').trim(),
          lowBalanceThresholdMinor: toInt(body.lowBalanceThresholdMinor, 0) ?? 0,
        };
        try {
          await services.resellers.createResellerWithUser({
            name: form.name,
            email: form.email,
            password: body.password,
            lowBalanceThresholdMinor: form.lowBalanceThresholdMinor,
            actor: request.auth.user,
            ip: request.ip,
          });
          return redirect(reply, '/admin/resellers?notice=Revendedor+y+acceso+creados', 303);
        } catch (err) {
          const resellers = await safe(() => services.resellers.listResellers({ limit: 200 }), []);
          return sendPage(
            reply,
            request,
            'resellers',
            {
              activeNav: 'resellers',
              resellers,
              status: null,
              statuses: RESELLER_STATUSES,
              form,
              createKey: crypto.randomUUID(),
              error: err.message,
            },
            400,
          );
        }
      },
      { roles: ['admin'] },
    ),
  );

  app.get(
    '/admin/resellers/:resellerId',
    page(
      async (request, reply) => {
        const { resellerId } = request.params;
        const reseller = await services.resellers.getReseller(resellerId);
        const [sites, availableSites, users, balance] = await Promise.all([
          safe(() => services.resellers.listResellerSites(resellerId), []),
          safe(async () => (services.resellers.listSites ? services.resellers.listSites({}) : []), []),
          safe(async () => (services.resellers.listResellerUsers ? services.resellers.listResellerUsers(resellerId) : []), []),
          safe(() => services.wallet.getBalance(resellerId), null),
        ]);
        return sendPage(reply, request, 'reseller-detail', {
          activeNav: 'resellers',
          reseller,
          sites,
          availableSites,
          users,
          balance,
          nextStatuses: RESELLER_TRANSITIONS[reseller.status] ?? [],
          statuses: RESELLER_STATUSES,
          assignKey: crypto.randomUUID(),
          createUserKey: crypto.randomUUID(),
          form: { email: '' },
        });
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/resellers/:resellerId/users',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const { resellerId } = request.params;
        const body = request.body ?? {};
        const email = String(body.email ?? '').trim();
        try {
          await services.resellers.createUserForReseller({
            resellerId,
            email,
            password: body.password,
            actor: request.auth.user,
            ip: request.ip,
          });
          return redirect(reply, `/admin/resellers/${resellerId}?notice=Usuario+creado`, 303);
        } catch (err) {
          // Preserve the attempted email on error; the password is never
          // echoed back into the form or the error page.
          const reseller = await services.resellers.getReseller(resellerId);
          const [sites, availableSites, users, balance] = await Promise.all([
            safe(() => services.resellers.listResellerSites(resellerId), []),
            safe(async () => (services.resellers.listSites ? services.resellers.listSites({}) : []), []),
            safe(async () => (services.resellers.listResellerUsers ? services.resellers.listResellerUsers(resellerId) : []), []),
            safe(() => services.wallet.getBalance(resellerId), null),
          ]);
          return sendPage(
            reply,
            request,
            'reseller-detail',
            {
              activeNav: 'resellers',
              reseller,
              sites,
              availableSites,
               users,
               balance,
              nextStatuses: RESELLER_TRANSITIONS[reseller.status] ?? [],
              statuses: RESELLER_STATUSES,
              assignKey: crypto.randomUUID(),
              createUserKey: crypto.randomUUID(),
              form: { email },
              error: err.message,
            },
            400,
          );
        }
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/resellers/:resellerId/status',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const { resellerId } = request.params;
        const body = request.body ?? {};
        await services.resellers.setStatus({
          resellerId,
          status: String(body.status ?? ''),
          actor: request.auth.user,
          ip: request.ip,
        });
        return redirect(reply, `/admin/resellers/${resellerId}?notice=Estado+actualizado`, 303);
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/resellers/:resellerId/delete',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        await services.resellers.deleteReseller({
          resellerId: request.params.resellerId,
          actor: request.auth.user,
          ip: request.ip,
        });
        return redirect(reply, '/admin/resellers?notice=Revendedor+eliminado', 303);
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/resellers/:resellerId/sites',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const { resellerId } = request.params;
        const siteId = String((request.body ?? {}).siteId ?? '');
        await services.resellers.assignSite({
          resellerId,
          siteId,
          actor: request.auth.user,
          ip: request.ip,
        });
        return redirect(reply, `/admin/resellers/${resellerId}?notice=Sitio+asignado`, 303);
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/resellers/:resellerId/sites/:siteId/unassign',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const { resellerId, siteId } = request.params;
        await services.resellers.unassignSite({
          resellerId,
          siteId,
          actor: request.auth.user,
          ip: request.ip,
        });
        return redirect(reply, `/admin/resellers/${resellerId}?notice=Asignacion+retirada`, 303);
      },
      { roles: ['admin'] },
    ),
  );

  // -------------------------------------------------------------- wallet ----

  function movementView(row) {
    return {
      id: row.id,
      type: row.entry_type,
      amountMinor: Number(row.amount_minor),
      availableDelta: Number(row.available_delta),
      reservedDelta: Number(row.reserved_delta),
      reference: row.reference,
      reason: row.reason,
      effectiveAt: row.effective_at ?? row.created_at,
      reversible: ['recharge', 'adjustment_credit', 'adjustment_debit'].includes(row.entry_type),
    };
  }

  function holdView(row) {
    return {
      id: row.id,
      orderId: row.order_id,
      amountMinor: Number(row.amount_minor),
      capturedMinor: Number(row.captured_minor),
      releasedMinor: Number(row.released_minor),
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async function walletLocals(request, error, form) {
    const auth = request.auth;
    const explicit = request.query?.resellerId ?? form?.resellerId ?? null;
    const safeForm = form ?? { idempotencyKey: crypto.randomUUID() };
    let resellerId = null;
    try {
      resellerId = tenantId(auth, explicit);
    } catch {
      const resellers = await safe(() => services.resellers.listResellers({ limit: 200 }), []);
      return { activeNav: 'wallet', resellerId: null, reseller: null, needReseller: true, resellers, balance: null, movements: [], holds: [], error, form: safeForm };
    }
    const [reseller, balance, movements, holds] = await Promise.all([
      safe(() => services.resellers.getReseller(resellerId), null),
      safe(() => services.wallet.getBalance(resellerId), null),
      safe(() => services.wallet.listMovements({ resellerId, limit: 100 }), []),
      safe(() => services.wallet.listHolds({ resellerId, status: 'active', limit: 50 }), []),
    ]);
    return {
      activeNav: 'wallet',
      resellerId,
      reseller,
      needReseller: false,
      balance,
      movements: movements.map(movementView),
      holds: holds.map(holdView),
      error,
      form: safeForm,
    };
  }

  app.get(
    '/wallet',
    page(async (request, reply) => {
      return sendPage(reply, request, 'wallet', await walletLocals(request));
    }),
  );

  app.post(
    '/wallet/recharge',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        try {
          await services.wallet.recharge({
            resellerId: body.resellerId,
            amountMinor: toInt(body.amountMinor, 0),
            reference: body.reference || null,
            idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
            reason: body.reason,
            actor: request.auth.user,
            ip: request.ip,
          });
          return redirect(reply, `/wallet?resellerId=${encodeURIComponent(body.resellerId)}&notice=Recarga+registrada`, 303);
        } catch (err) {
          const locals = await walletLocals(request, err.message, { resellerId: body.resellerId, amountMinor: body.amountMinor, reason: body.reason, reference: body.reference });
          return sendPage(reply, request, 'wallet', locals, 400);
        }
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/wallet/adjustment',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        try {
          await services.wallet.adjustment({
            resellerId: body.resellerId,
            direction: body.direction,
            amountMinor: toInt(body.amountMinor, 0),
            reference: body.reference || null,
            idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
            reason: body.reason,
            evidence: body.evidence || null,
            actor: request.auth.user,
            ip: request.ip,
          });
          return redirect(reply, `/wallet?resellerId=${encodeURIComponent(body.resellerId)}&notice=Ajuste+registrado`, 303);
        } catch (err) {
          const locals = await walletLocals(request, err.message, { resellerId: body.resellerId, amountMinor: body.amountMinor, reason: body.reason, direction: body.direction });
          return sendPage(reply, request, 'wallet', locals, 400);
        }
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/wallet/reverse',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        await services.wallet.reverse({
          entryId: body.entryId,
          reason: body.reason || null,
          actor: request.auth.user,
          ip: request.ip,
        });
        return redirect(reply, `/wallet?resellerId=${encodeURIComponent(body.resellerId ?? '')}&notice=Reverso+registrado`, 303);
      },
      { roles: ['admin'] },
    ),
  );

  // ------------------------------------------------------------- catalog ----

  function packageView(pkg) {
    return {
      id: pkg.id,
      siteId: pkg.site_id,
      name: pkg.name,
      ruijieUserGroupId: pkg.ruijie_user_group_id,
      duration: pkg.duration,
      quota: pkg.quota,
      upSpeed: pkg.up_speed,
      downSpeed: pkg.down_speed,
      concurrentClients: pkg.concurrent_clients,
      status: pkg.status,
    };
  }

  app.get(
    '/catalog',
    page(async (request, reply) => {
      const auth = request.auth;
      if (auth.user.role === 'admin') {
        const resellerId = request.query?.resellerId ?? null;
        const siteId = request.query?.siteId ?? null;
        const resellers = await safe(() => services.resellers.listResellers({ limit: 200 }), []);
        // Context is Reseller -> Site: sites only appear once a reseller is
        // chosen, and the package list only once a site is chosen too.
        const sites = resellerId
          ? await safe(() => services.resellers.listResellerSites(resellerId), [])
          : [];
        const hasContext = Boolean(resellerId && siteId);
        let packages = [];
        if (hasContext) {
          const [all, authorized] = await Promise.all([
            safe(() => services.catalog.listPackages({ siteId }), []),
            safe(() => services.catalog.listAuthorizedPackages({ resellerId, siteId }), []),
          ]);
          const authorizedIds = new Set(authorized.map((pkg) => pkg.id));
          const canPrice = typeof services.catalog.resolvePrice === 'function';
          for (const pkg of all) {
            // Disabled packages are noise in the operator's guided task.
            if (pkg.status === 'disabled') continue;
            const isAuthorized = authorizedIds.has(pkg.id);
            const price = isAuthorized && canPrice
              ? await safe(() => services.catalog.resolvePrice({ packageId: pkg.id, resellerId, siteId }), null)
              : null;
            packages.push({ ...packageView(pkg), authorized: isAuthorized, price });
          }
        }
        return sendPage(reply, request, 'catalog', {
          activeNav: 'catalog',
          variant: 'admin',
          resellers,
          sites,
          resellerId,
          siteId,
          hasContext,
          packages,
          syncAvailable: typeof services.inventory?.syncCatalog === 'function',
        });
      }
      const resellerId = auth.user.reseller_id;
      const authorized = await safe(() => services.catalog.listAuthorizedPackages({ resellerId }), []);
      const canPrice = typeof services.catalog.resolvePrice === 'function';
      const packages = [];
      for (const pkg of authorized) {
        const price = canPrice
          ? await safe(
              () => services.catalog.resolvePrice({ packageId: pkg.id, resellerId, siteId: pkg.site_id }),
              null,
            )
          : null;
        // The reseller only sees authorized packages that actually have a price.
        if (canPrice && !price) continue;
        packages.push({ ...packageView(pkg), price });
      }
      return sendPage(reply, request, 'catalog', {
        activeNav: 'catalog',
        variant: 'reseller',
        packages,
      });
    }),
  );

  app.post(
    '/catalog/sync',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        if (typeof services.inventory?.syncCatalog !== 'function') {
          return sendPage(
            reply,
            request,
            'error',
            { status: 501, message: 'Sincronización de catálogo no disponible.' },
            501,
          );
        }
        try {
          const out = await services.inventory.syncCatalog({});
          const sites = out?.syncedSites ?? 0;
          const packages = out?.packageCount ?? 0;
          const failed = Array.isArray(out?.errors) ? out.errors.length : 0;
          const notice = `Catalogo sincronizado: ${sites} sitios, ${packages} paquetes${failed ? `, ${failed} con error` : ''}`;
          return redirect(reply, `/catalog?notice=${encodeURIComponent(notice)}`, 303);
        } catch (err) {
          return sendPage(
            reply,
            request,
            'error',
            { status: err.statusCode ?? 400, message: err.message },
            err.statusCode ?? 400,
          );
        }
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/catalog/permissions',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        await services.catalog.grantPackage({
          resellerId: body.resellerId,
          packageId: body.packageId,
          actor: request.auth.user,
          reason: body.reason || null,
          ip: request.ip,
        });
        return redirect(reply, `/catalog?resellerId=${encodeURIComponent(body.resellerId)}&siteId=${encodeURIComponent(body.siteId)}&notice=Paquete+autorizado`, 303);
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/catalog/permissions/revoke',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        await services.catalog.revokePackage({
          resellerId: body.resellerId,
          packageId: body.packageId,
          actor: request.auth.user,
          reason: body.reason || null,
          ip: request.ip,
        });
        return redirect(reply, `/catalog?resellerId=${encodeURIComponent(body.resellerId)}&siteId=${encodeURIComponent(body.siteId)}&notice=Paquete+retirado`, 303);
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/catalog/prices',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        const body = request.body ?? {};
        try {
          await services.catalog.setPrice({
            packageId: body.packageId,
            scope: body.scope,
            resellerId: body.resellerId || null,
            siteId: body.siteId || null,
            amountMinor: toInt(body.amountMinor, -1),
            currency: 'COP',
            reason: body.reason || null,
            actor: request.auth.user,
            ip: request.ip,
          });
          return redirect(reply, `/catalog?resellerId=${encodeURIComponent(body.resellerId)}&siteId=${encodeURIComponent(body.siteId)}&notice=Precio+actualizado`, 303);
        } catch (err) {
          return sendPage(reply, request, 'error', { status: 400, message: err.message }, 400);
        }
      },
      { roles: ['admin'] },
    ),
  );

  // -------------------------------------------------------------- orders ----

  function orderView(order) {
    return {
      id: order.id,
      siteId: order.site_id,
      packageId: order.package_id,
      quantity: order.quantity,
      status: order.status,
      unitPriceMinor: Number(order.unit_price_minor),
      totalMinor: Number(order.total_minor),
      issuedQuantity: order.issued_quantity,
      clientReference: order.client_reference,
      localReference: order.local_reference,
      failureReason: order.failure_reason,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
    };
  }

  async function orderLocals(auth, orderId, request = {}) {
    const order = await services.orders.getOrder(orderId);
    if (typeof services.orders.assertOrderAccess === 'function') {
      // Audited tenant guard (records the denial) on the real order service.
      await services.orders.assertOrderAccess({ auth, order, ip: request.ip ?? null });
    } else if (auth.user.role === 'reseller' && order.reseller_id !== auth.user.reseller_id) {
      throw new ForbiddenError('Cross-tenant access denied', 'cross_tenant');
    }
    const events = await safe(() => services.orders.listOrderEvents(orderId), []);
    let vouchers = [];
    let vouchersAvailable = false;
    const listFn = services.vouchers?.listByOrder ?? services.orders?.listVouchers;
    if (listFn) {
      const source = services.vouchers?.listByOrder ? services.vouchers : services.orders;
      const rows = await safe(() => listFn.call(source, { auth, orderId }), []);
      vouchers = rows.map((row) => ({
        id: row.id,
        masked: row.code_masked ?? row.masked ?? '****',
        status: row.normalized_status ?? row.status ?? 'issued',
      }));
      vouchersAvailable = true;
    }
    return { order: orderView(order), events, vouchers, vouchersAvailable };
  }

  app.get(
    '/orders/new',
    page(async (request, reply) => {
      const auth = request.auth;
      const resellerId = auth.user.reseller_id;
      const packages = await safe(() => services.catalog.listAuthorizedPackages({ resellerId }), []);
      const sites = await safe(() => services.resellers.listResellerSites(resellerId), []);
      return sendPage(reply, request, 'issue', {
        activeNav: 'issue',
        packages: packages.map(packageView),
        sites,
        form: {
          siteId: request.query?.siteId ?? '',
          packageId: request.query?.packageId ?? '',
          quantity: 1,
          clientReference: '',
        },
        localReference: crypto.randomUUID(),
      });
    }),
  );

  app.post(
    '/orders',
    page(async (request, reply) => {
      await guards.requireCsrf(request);
      const auth = request.auth;
      const body = request.body ?? {};
      const form = {
        siteId: body.siteId ?? '',
        packageId: body.packageId ?? '',
        quantity: toInt(body.quantity, 1),
        clientReference: body.clientReference ?? '',
      };
      try {
        // Real wiring runs the full issuance flow (reserve, single create,
        // capture); a bare order service is only used by degraded/test setups.
        const issueFn = services.vouchers?.issue
          ? services.vouchers.issue.bind(services.vouchers)
          : services.orders.createOrder.bind(services.orders);
        const result = await issueFn({
          auth,
          siteId: form.siteId,
          packageId: form.packageId,
          quantity: form.quantity,
          localReference: body.localReference || crypto.randomUUID(),
          clientReference: form.clientReference || null,
          ip: request.ip,
        });
        return redirect(reply, `/orders/${result.order.id}?notice=Orden+creada`, 303);
      } catch (err) {
        const resellerId = auth.user.reseller_id;
        const [packages, sites] = await Promise.all([
          safe(() => services.catalog.listAuthorizedPackages({ resellerId }), []),
          safe(() => services.resellers.listResellerSites(resellerId), []),
        ]);
        return sendPage(
          reply,
          request,
          'issue',
          {
            activeNav: 'issue',
            packages: packages.map(packageView),
            sites,
            form,
            localReference: crypto.randomUUID(),
            error: err.message,
          },
          400,
        );
      }
    }),
  );

  app.get(
    '/orders',
    page(async (request, reply) => {
      const auth = request.auth;
      const status = request.query?.status ?? null;
      const params =
        auth.user.role === 'admin'
          ? { status, limit: 100 }
          : { resellerId: auth.user.reseller_id, status, limit: 100 };
      const orders = await safe(() => services.orders.listOrders(params), []);
      return sendPage(reply, request, 'orders', {
        activeNav: 'orders',
        orders: orders.map(orderView),
        status,
        statuses: Object.values(ORDER_STATES),
        variant: auth.user.role,
      });
    }),
  );

  app.get(
    '/orders/:orderId',
    page(async (request, reply) => {
      const locals = await orderLocals(request.auth, request.params.orderId, request);
      return sendPage(reply, request, 'order-detail', { activeNav: 'orders', ...locals });
    }),
  );

  app.post(
    '/orders/:orderId/vouchers/:voucherId/reveal',
    page(async (request, reply) => {
      await guards.requireCsrf(request);
      const revealFn = services.vouchers?.reveal ?? services.orders?.revealVoucher;
      if (!revealFn) {
        return reply.code(501).send({ error: 'reveal_unavailable', message: 'Reveal no disponible.' });
      }
      const source = services.vouchers?.reveal ? services.vouchers : services.orders;
      try {
        const result = await revealFn.call(source, {
          auth: request.auth,
          orderId: request.params.orderId,
          voucherId: request.params.voucherId,
          ip: request.ip,
        });
        return reply.send({ code: result.code ?? result.voucher_code ?? null });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }),
  );

  // --------------------------------------------------------------- admin ----

  app.get(
    '/admin/orders',
    page(
      async (request, reply) => {
        const status = request.query?.status ?? null;
        const resellerId = request.query?.resellerId ?? null;
        const orders = await safe(() => services.orders.listOrders({ resellerId, status, limit: 200 }), []);
        const resellers = await safe(() => services.resellers.listResellers({ limit: 200 }), []);
        return sendPage(reply, request, 'admin-orders', {
          activeNav: 'admin-orders',
          orders: orders.map(orderView),
          resellers,
          resellerId,
          status,
          statuses: Object.values(ORDER_STATES),
        });
      },
      { roles: ['admin'] },
    ),
  );

  app.get(
    '/admin/vouchers',
    page(
      async (request, reply) => {
        const siteId = request.query?.siteId ?? null;
        const sites = await safe(() => services.resellers.listSites({ status: 'active' }), []);
        const readEnabled = Boolean(services.inventory?.isReadEnabled?.());
        let result = null;
        let error = null;
        if (siteId && typeof services.inventory?.listRemoteVouchers === 'function') {
          try {
            result = await services.inventory.listRemoteVouchers(siteId, {});
          } catch (err) {
            error = err.message;
          }
        }
        return sendPage(reply, request, 'vouchers', {
          activeNav: 'admin-vouchers',
          sites,
          siteId,
          readEnabled,
          result,
          error,
          syncKey: crypto.randomUUID(),
        });
      },
      { roles: ['admin'] },
    ),
  );

  app.post(
    '/admin/vouchers/sync-sites',
    page(
      async (request, reply) => {
        await guards.requireCsrf(request);
        if (typeof services.inventory?.syncSites !== 'function') {
          return sendPage(reply, request, 'error', { status: 501, message: 'Sincronización no disponible.' }, 501);
        }
        try {
          const out = await services.inventory.syncSites({}, {});
          const discovered = Array.isArray(out?.sites) ? out.sites.length : 0;
          return redirect(reply, `/admin/vouchers?notice=Sitios+sincronizados:+${discovered}`, 303);
        } catch (err) {
          return sendPage(reply, request, 'error', { status: err.statusCode ?? 400, message: err.message }, err.statusCode ?? 400);
        }
      },
      { roles: ['admin'] },
    ),
  );

  app.get(
    '/admin/audit',
    page(
      async (request, reply) => {
        const action = request.query?.action ?? null;
        const entityType = request.query?.entityType ?? null;
        const available = Boolean(services.audit?.list);
        const events = available
          ? await safe(() => services.audit.list({ action, entityType, limit: 200 }), [])
          : [];
        return sendPage(reply, request, 'audit', {
          activeNav: 'audit',
          events: events.map((event) => ({
            id: event.id,
            action: event.action,
            actorRole: event.actor_role,
            entityType: event.entity_type,
            entityId: event.entity_id,
            result: event.result,
            reason: event.reason,
            createdAt: event.created_at,
            detail: redact(event.after_data ?? null),
          })),
          action,
          entityType,
          available,
        });
      },
      { roles: ['admin'] },
    ),
  );

  app.get(
    '/admin/config',
    page(
      async (request, reply) => {
        const { config } = ctx;
        return sendPage(reply, request, 'config', {
          activeNav: 'config',
          settings: buildConfigView(config, request.auth.user),
        });
      },
      { roles: ['admin'] },
    ),
  );

  return app;
}

/** Non-secret operational settings only; secrets are never rendered. */
export function buildConfigView(config, user = null) {
  const masked = (value) => (value ? 'configurado' : 'sin configurar');
  const maskEmail = (email) => {
    if (!email || !email.includes('@')) return email || '—';
    const [local, domain] = email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  };
  return [
    { label: 'Entorno', value: config?.nodeEnv ?? '—' },
    { label: 'Puerto', value: String(config?.port ?? '—') },
    { label: 'Base de datos', value: masked(config?.databaseUrl) },
    { label: 'Clave de cifrado', value: masked(config?.encryption?.primaryKey) },
    { label: 'Region Ruijie', value: config?.ruijie?.region ?? '—' },
    { label: 'Ruijie API', value: masked(config?.ruijie?.baseUrl) },
    { label: 'Correo remitente', value: config?.mail?.from ?? '—' },
    { label: 'Administrador', value: maskEmail(user?.email) },
  ];
}
