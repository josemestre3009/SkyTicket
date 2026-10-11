import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createWebPlugin } from '../../src/web/index.js';
import { hashCsrfToken } from '../../src/auth/tokens.js';
import { ValidationError } from '../../src/modules/resellers/service.js';

const CSRF = 'csrf-good';

const adminUser = { id: 'u-admin', email: 'admin@test', role: 'admin', reseller_id: null, status: 'active' };
const resellerUser = { id: 'u-r1', email: 'r@test', role: 'reseller', reseller_id: 'r1', status: 'active' };

function sessionFor(user) {
  return {
    id: `s-${user.id}`,
    user_id: user.id,
    csrf_hash: hashCsrfToken(CSRF),
  };
}

function pkg(overrides = {}) {
  return {
    id: 'p1',
    site_id: 's1',
    name: 'Paquete 1h',
    ruijie_user_group_id: 'g1',
    duration: 60,
    quota: '1GB',
    up_speed: 10,
    down_speed: 10,
    concurrent_clients: 1,
    status: 'active',
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'o1',
    reseller_id: 'r1',
    site_id: 's1',
    package_id: 'p1',
    quantity: 2,
    status: 'issued',
    unit_price_minor: 5000,
    total_minor: 10000,
    issued_quantity: 2,
    client_reference: null,
    local_reference: 'lr-1',
    failure_reason: null,
    created_at: new Date('2024-02-03T10:00:00Z'),
    updated_at: new Date('2024-02-03T10:00:00Z'),
    ...overrides,
  };
}

function buildServices() {
  return {
    identity: {
      async resolve(token) {
        if (token === 'admin') return { user: adminUser, session: sessionFor(adminUser) };
        if (token === 'reseller') return { user: resellerUser, session: sessionFor(resellerUser) };
        return null;
      },
      async login({ email }) {
        const user = email === 'admin@test' ? adminUser : resellerUser;
        return { token: user.role, csrfToken: CSRF, user, session: sessionFor(user) };
      },
      async logout() {
        return true;
      },
    },
    resellers: {
      resolveTenant(auth, explicit) {
        if (auth.user.role === 'admin') {
          if (!explicit) throw new ValidationError('reseller_id is required', 'reseller_id_required');
          return explicit;
        }
        return auth.user.reseller_id;
      },
      assertNoIdentityOverride() {},
      async listResellers() {
        return [
          { id: 'r1', name: 'Revendedor Uno', status: 'active', currency: 'COP', low_balance_threshold_minor: 0, created_at: new Date('2024-01-01') },
        ];
      },
      async getReseller(id) {
        return { id, name: 'Revendedor Uno', status: 'active', currency: 'COP', low_balance_threshold_minor: 0 };
      },
      async listResellerSites() {
        return [{ id: 's1', name: 'Sitio Centro', ruijie_group_id: 'g1', status: 'active' }];
      },
      async listSites() {
        return [{ id: 's1', name: 'Sitio Centro' }];
      },
      async createReseller() {
        return { id: 'r2' };
      },
      async setStatus() {
        return { changed: true };
      },
      async assignSite() {
        return { id: 'rs1' };
      },
      async unassignSite() {
        return { id: 'rs1' };
      },
    },
    wallet: {
      async getBalance() {
        return { walletId: 'w1', resellerId: 'r1', currency: 'COP', availableMinor: 100000, reservedMinor: 0, totalMinor: 100000, blocked: false, version: 1 };
      },
      async listMovements() {
        return [
          { id: 'm1', entry_type: 'recharge', amount_minor: 100000, available_delta: 100000, reserved_delta: 0, reference: 'ref-1', reason: 'Carga inicial', effective_at: new Date('2024-01-02'), created_at: new Date('2024-01-02') },
        ];
      },
      async listHolds() {
        return [];
      },
      async recharge() {
        return { entry: { id: 'm2' }, balance: {} };
      },
      async adjustment() {
        return {};
      },
      async reverse() {
        return {};
      },
    },
    catalog: {
      async listPackages() {
        return [pkg()];
      },
      async listAuthorizedPackages() {
        return [pkg()];
      },
      async listPriceRules() {
        return [{ scope: 'base', amount_minor: 5000, effective_from: new Date('2024-01-01'), effective_to: null }];
      },
      async grantPackage() {},
      async revokePackage() {},
      async setPrice() {
        return { id: 'pv1' };
      },
    },
    orders: {
      async listOrders() {
        return [order()];
      },
      async getOrder(id) {
        return order({ id });
      },
      async listOrderEvents() {
        return [{ from_status: 'draft', to_status: 'reserved', event_type: 'status_change', created_at: new Date('2024-01-03') }];
      },
      async createOrder() {
        return { order: { id: 'o-new' }, replayed: false };
      },
      async revealVoucher() {
        return { code: 'ABCD-EFGH-1234' };
      },
    },
    notifications: {
      async list() {
        return [{ id: 'n1', severity: 'warning', title: 'Saldo bajo', body: 'Recarga pronto', resource_type: 'order', resource_id: 'o1', read_at: null, created_at: new Date('2024-01-04') }];
      },
      async unreadCount() {
        return 1;
      },
      async markRead() {},
    },
    audit: {
      async list() {
        return [{ id: 1, action: 'wallet.recharge', actor_role: 'admin', entity_type: 'ledger_entry', entity_id: 'm1', result: 'success', reason: null, created_at: new Date('2024-01-05'), after_data: { secret: 'x' } }];
      },
    },
  };
}

async function buildApp(overrides = {}) {
  const services = { ...buildServices(), ...overrides };
  const web = createWebPlugin({ services, authService: services.identity });
  const app = Fastify();
  await app.register(web.plugin);
  await app.ready();
  return app;
}

function cookie(token) {
  return `skyticket_sid=${token}`;
}

test('web panel routing and rendering', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await t.test('anonymous access redirects to login', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    assert.equal(res.statusCode, 302);
    assert.match(res.headers.location, /^\/login/);
  });

  await t.test('login page renders', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.payload, /action="\/login"/);
  });

  await t.test('static assets are served with correct types', async () => {
    const css = await app.inject({ method: 'GET', url: '/assets/app.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'], /javascript/);
  });

  await t.test('reseller dashboard shows balance', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /100\.000/);
    assert.match(res.payload, /Saldo disponible/);
  });

  await t.test('admin dashboard shows metrics without reconciliation cases', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Resumen del negocio/);
    assert.match(res.payload, /Revendedores/);
    assert.doesNotMatch(res.payload, /Casos abiertos/);
    assert.doesNotMatch(res.payload, /conciliacion/i);
  });

  await t.test('admin resellers list renders', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/resellers', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Revendedor Uno/);
  });

  await t.test('reseller is forbidden from admin pages', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/resellers', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 403);
  });

  await t.test('reseller status form omits the reason field', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/resellers/r1', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /action="\/admin\/resellers\/r1\/status"/);
    assert.doesNotMatch(res.payload, /name="reason"/);
  });

  await t.test('emission page has no horizontal table and preserves form', async () => {
    const res = await app.inject({ method: 'GET', url: '/orders/new', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.payload, /<table/);
    assert.match(res.payload, /package-choices/);
  });

  await t.test('wallet page hides mutable actions from reseller', async () => {
    const res = await app.inject({ method: 'GET', url: '/wallet', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.payload, /action="\/wallet\/recharge"/);
  });

  await t.test('wallet page shows recharge form to admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/wallet?resellerId=r1', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /action="\/wallet\/recharge"/);
  });

  await t.test('order detail exposes masked vouchers with reveal', async () => {
    const services = buildServices();
    services.vouchers = {
      async listByOrder() {
        return [{ id: 'v1', code_masked: 'AB****GH', normalized_status: 'issued' }];
      },
      async reveal() {
        return { code: 'ABCD-EFGH-1234' };
      },
    };
    const local = await buildApp(services);
    t.after(() => local.close());
    const res = await local.inject({ method: 'GET', url: '/orders/o1', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /AB\*\*\*\*GH/);
    assert.match(res.payload, /data-reveal/);
    assert.doesNotMatch(res.payload, /ABCD-EFGH-1234/);
  });

  await t.test('cross-reseller order access is denied', async () => {
    const local = await buildApp({
      orders: {
        ...buildServices().orders,
        async getOrder(id) {
          return order({ id, reseller_id: 'other' });
        },
      },
    });
    t.after(() => local.close());
    const res = await local.inject({ method: 'GET', url: '/orders/o1', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 403);
  });

  await t.test('notifications and reconciliation pages are retired; audit remains', async () => {
    const admin = { cookie: cookie('admin') };
    const notifications = await app.inject({ method: 'GET', url: '/notifications', headers: admin });
    assert.equal(notifications.statusCode, 404);
    const notificationRead = await app.inject({
      method: 'POST',
      url: '/notifications/n1/read',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF },
    });
    assert.equal(notificationRead.statusCode, 404);

    const recon = await app.inject({ method: 'GET', url: '/admin/reconciliation', headers: admin });
    assert.equal(recon.statusCode, 404);
    const reconResolve = await app.inject({
      method: 'POST',
      url: '/admin/reconciliation/c1/resolve',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF, resolution: 'x' },
    });
    assert.equal(reconResolve.statusCode, 404);

    const audit = await app.inject({ method: 'GET', url: '/admin/audit', headers: admin });
    assert.equal(audit.statusCode, 200);
    assert.match(audit.payload, /wallet\.recharge/);
  });

  await t.test('configuration page never leaks secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/config', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Ajustes operativos/);
    assert.doesNotMatch(res.payload, /admin@test/);
  });
});

test('web panel: admin logs in without 2FA and legacy 2FA routes are gone', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await t.test('admin login redirects straight to the dashboard', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=admin%40test&password=secret',
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/dashboard');

    const sid = res.headers['set-cookie'].toString().match(/skyticket_sid=[^;]+/)[0];
    const config = await app.inject({ method: 'GET', url: '/admin/config', headers: { cookie: sid } });
    assert.equal(config.statusCode, 200, 'admin reaches a privileged page with no second factor');
  });

  await t.test('removed 2FA pages return 404', async () => {
    for (const route of [
      { method: 'GET', url: '/2fa' },
      { method: 'POST', url: '/2fa/verify' },
      { method: 'POST', url: '/2fa/recovery' },
      { method: 'POST', url: '/2fa/enroll' },
      { method: 'POST', url: '/2fa/confirm' },
    ]) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 404, `${route.method} ${route.url} should be gone`);
    }
  });
});

test('web panel mutation flows', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await t.test('form-encoded login sets session and csrf cookies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=reseller%40test&password=secret',
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/dashboard');
    const setCookie = res.headers['set-cookie'].toString();
    assert.match(setCookie, /skyticket_sid=/);
    assert.match(setCookie, /skyticket_csrf=/);
  });

  await t.test('order creation requires csrf and redirects on success', async () => {
    const headers = { cookie: cookie('reseller') };
    const missing = await app.inject({
      method: 'POST',
      url: '/orders',
      headers,
      payload: { siteId: 's1', packageId: 'p1', quantity: 1, localReference: 'lr-1' },
    });
    assert.equal(missing.statusCode, 403);

    const ok = await app.inject({
      method: 'POST',
      url: '/orders',
      headers,
      payload: { csrfToken: CSRF, siteId: 's1', packageId: 'p1', quantity: 1, localReference: 'lr-1' },
    });
    assert.equal(ok.statusCode, 303);
    assert.match(ok.headers.location, /^\/orders\/o-new/);
  });

  await t.test('order creation error preserves the form', async () => {
    const local = await buildApp({
      orders: {
        ...buildServices().orders,
        async createOrder() {
          throw new Error('cantidad fuera de rango');
        },
      },
    });
    t.after(() => local.close());
    const res = await local.inject({
      method: 'POST',
      url: '/orders',
      headers: { cookie: cookie('reseller') },
      payload: { csrfToken: CSRF, siteId: 's1', packageId: 'p1', quantity: 999, clientReference: 'cliente-x' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload, /cantidad fuera de rango/);
    assert.match(res.payload, /cliente-x/);
  });

  await t.test('reseller cannot recharge (admin only)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/recharge',
      headers: { cookie: cookie('reseller') },
      payload: { csrfToken: CSRF, resellerId: 'r1', amountMinor: 1000, reason: 'x' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('admin recharge redirects back to wallet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/recharge',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF, resellerId: 'r1', amountMinor: 1000, reason: 'carga' },
    });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location, /^\/wallet\?resellerId=r1/);
  });

  await t.test('reveal endpoint returns the code and is csrf-protected', async () => {
    const services = buildServices();
    services.vouchers = {
      async reveal() {
        return { code: 'ABCD-EFGH-1234' };
      },
    };
    const local = await buildApp(services);
    t.after(() => local.close());
    const denied = await local.inject({ method: 'POST', url: '/orders/o1/vouchers/v1/reveal', headers: { cookie: cookie('reseller') } });
    assert.equal(denied.statusCode, 403);
    const ok = await local.inject({
      method: 'POST',
      url: '/orders/o1/vouchers/v1/reveal',
      headers: { cookie: cookie('reseller'), 'x-csrf-token': CSRF },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().code, 'ABCD-EFGH-1234');
  });

  await t.test('logout clears cookies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: cookie('reseller') },
      payload: { csrfToken: CSRF },
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/login');
    const setCookie = res.headers['set-cookie'].toString();
    assert.match(setCookie, /skyticket_sid=;/);
  });
});

test('app shell: light color scheme, sidebar, drawer hooks and accessible nav', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await t.test('login is bare: no sidebar shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /<meta name="color-scheme" content="light"/);
    assert.doesNotMatch(res.payload, /class="sidebar"/);
    assert.doesNotMatch(res.payload, /data-nav-toggle/);
  });

  await t.test('authenticated pages mount the fixed sidebar shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /class="app app--shell"/);
    assert.match(res.payload, /class="sidebar"/);
    assert.match(res.payload, /aria-label="Principal"/);
    assert.match(res.payload, /aria-controls="primary-nav"/);
    assert.match(res.payload, /aria-expanded="false"/);
    assert.match(res.payload, /data-nav-scrim/);
    assert.match(res.payload, /href="#i-dashboard"/);
    assert.match(res.payload, /action="\/logout"/);
  });
});
