import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createWebPlugin } from '../../src/web/index.js';
import { hashCsrfToken } from '../../src/auth/tokens.js';

const CSRF = 'csrf-good';

const adminUser = { id: 'u-admin', email: 'admin@test', role: 'admin', reseller_id: null, status: 'active' };
const resellerUser = { id: 'u-r1', email: 'r@test', role: 'reseller', reseller_id: 'r1', status: 'active' };

function sessionFor(user) {
  return { id: `s-${user.id}`, user_id: user.id, csrf_hash: hashCsrfToken(CSRF) };
}

const PLAINTEXT = 'SUPERSECRET-CODE-9999';

function voucher(overrides = {}) {
  return {
    uuid: 'uuid-1',
    codeMasked: 'h3****kr',
    alias: 'Lobby',
    packageName: '1DayWiFi',
    status: 'unused',
    expiryTime: 1531122313000,
    createTime: 1531122313000,
    maxClients: 3,
    currentClients: 0,
    // The service must never emit these; include them to prove the view ignores them.
    code: PLAINTEXT,
    raw: { voucherCode: PLAINTEXT },
    ...overrides,
  };
}

function catalogPackage(overrides = {}) {
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

function buildServices(overrides = {}) {
  const calls = { createResellerWithUser: [], createUserForReseller: [], deleteReseller: [], syncSites: 0, syncCatalog: 0, listRemoteVouchers: [] };
  const services = {
    calls,
    identity: {
      async resolve(token) {
        if (token === 'admin') return { user: adminUser, session: sessionFor(adminUser) };
        if (token === 'reseller') return { user: resellerUser, session: sessionFor(resellerUser) };
        return null;
      },
    },
    resellers: {
      async listResellers() {
        return [
          { id: 'r1', name: 'Revendedor Uno', status: 'pending', currency: 'COP', low_balance_threshold_minor: 0, created_at: new Date('2024-01-01') },
        ];
      },
      async getReseller(id) {
        return { id, name: 'Revendedor Uno', status: 'pending', currency: 'COP', low_balance_threshold_minor: 0 };
      },
      async listResellerSites() {
        return [];
      },
      async listSites() {
        return [{ id: 's1', name: 'Sitio Centro' }];
      },
      async listResellerUsers() {
        return [
          { id: 'u1', email: 'r@test', role: 'reseller', status: 'active', must_change_password: true, last_login_at: null, created_at: new Date('2024-01-01') },
        ];
      },
      async createResellerWithUser(payload) {
        calls.createResellerWithUser.push(payload);
        return { reseller: { id: 'r2' }, user: { id: 'u2' } };
      },
      async createUserForReseller(payload) {
        calls.createUserForReseller.push(payload);
        return { user: { id: 'u3' } };
      },
      async setStatus() {
        return { changed: true };
      },
      async deleteReseller(payload) {
        calls.deleteReseller.push(payload);
        return { reseller: { id: payload.resellerId, status: 'closed' }, deleted: true };
      },
    },
    wallet: {},
    catalog: {
      async listPackages() {
        return [catalogPackage()];
      },
      async listAuthorizedPackages() {
        return [catalogPackage()];
      },
      async listPriceRules() {
        return [];
      },
      async grantPackage() {},
      async revokePackage() {},
      async setPrice() {
        return { id: 'pv1' };
      },
    },
    orders: {},
    inventory: {
      isReadEnabled() {
        return true;
      },
      async syncSites() {
        calls.syncSites += 1;
        return { connectionId: 'c1', discovered: 3, sites: [{ id: 's1' }, { id: 's2' }] };
      },
      async syncCatalog() {
        calls.syncCatalog += 1;
        return {
          connectionId: 'c1',
          discoveredSites: 2,
          syncedSites: 2,
          packageCount: 4,
          sites: [],
          errors: [],
        };
      },
      async listRemoteVouchers(siteId) {
        calls.listRemoteVouchers.push(siteId);
        return {
          siteId,
          count: 3,
          received: 3,
          vouchers: [
            voucher(),
            voucher({ uuid: 'uuid-2', codeMasked: 'h3****ks', alias: 'Room2', status: 'in_use', currentClients: 1 }),
            voucher({ uuid: 'uuid-3', codeMasked: 'h3****kt', alias: 'Room3', status: 'expired', currentClients: 0 }),
          ],
          summary: { total: 3, unused: 1, in_use: 1, expired: 1, unknown: 0 },
        };
      },
    },
  };
  return { ...services, ...overrides };
}

async function buildApp(overrides = {}) {
  const services = buildServices(overrides);
  const web = createWebPlugin({ services, authService: services.identity });
  const app = Fastify();
  await app.register(web.plugin);
  await app.ready();
  return { app, services };
}

function cookie(token) {
  return `skyticket_sid=${token}`;
}

test('admin reseller provisioning forms', async (t) => {
  await t.test('creates reseller + user and redirects', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/resellers',
      headers: { cookie: cookie('admin') },
      payload: {
        csrfToken: CSRF,
        name: 'Nuevo Revendedor',
        email: 'nuevo@test',
        password: 'temporal-segura-123',
        lowBalanceThresholdMinor: '5000',
      },
    });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location, /^\/admin\/resellers\?notice=/);
    const [payload] = services.calls.createResellerWithUser;
    assert.equal(payload.name, 'Nuevo Revendedor');
    assert.equal(payload.email, 'nuevo@test');
    assert.equal(payload.lowBalanceThresholdMinor, 5000);
    assert.equal(payload.password, 'temporal-segura-123');
  });

  await t.test('error preserves name/email/threshold but never the password', async () => {
    const { app } = await buildApp({
      resellers: {
        ...buildServices().resellers,
        async createResellerWithUser() {
          const err = new Error('email already in use');
          err.code = 'email_taken';
          throw err;
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/resellers',
      headers: { cookie: cookie('admin') },
      payload: {
        csrfToken: CSRF,
        name: 'Duplicado',
        email: 'dup@test',
        password: 'temporal-segura-123',
        lowBalanceThresholdMinor: '7000',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload, /Duplicado/);
    assert.match(res.payload, /dup@test/);
    assert.match(res.payload, /7000/);
    assert.match(res.payload, /email already in use/);
    assert.doesNotMatch(res.payload, /temporal-segura-123/);
  });

  await t.test('reseller cannot create resellers', async () => {
    const { app } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/resellers',
      headers: { cookie: cookie('reseller') },
      payload: { csrfToken: CSRF, name: 'X', email: 'x@test', password: 'temporal-segura-123' },
    });
    assert.equal(res.statusCode, 403);
  });
});

test('admin safely deletes a reseller', async (t) => {
  const { app, services } = await buildApp();
  t.after(() => app.close());

  const noCsrf = await app.inject({
    method: 'POST',
    url: '/admin/resellers/r1/delete',
    headers: { cookie: cookie('admin') },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(services.calls.deleteReseller.length, 0);

  const forbidden = await app.inject({
    method: 'POST',
    url: '/admin/resellers/r1/delete',
    headers: { cookie: cookie('reseller') },
    payload: { csrfToken: CSRF },
  });
  assert.equal(forbidden.statusCode, 403);

  const response = await app.inject({
    method: 'POST',
    url: '/admin/resellers/r1/delete',
    headers: { cookie: cookie('admin') },
    payload: { csrfToken: CSRF },
  });
  assert.equal(response.statusCode, 303);
  assert.match(response.headers.location, /^\/admin\/resellers\?notice=/);
  assert.equal(services.calls.deleteReseller.length, 1);
  assert.equal(services.calls.deleteReseller[0].resellerId, 'r1');
});

test('admin Ruijie voucher inventory page', async (t) => {
  await t.test('renders masked vouchers with localized statuses and summary', async () => {
    const { app } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/admin/vouchers?siteId=s1', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /uuid-1/);
    assert.match(res.payload, /h3\*\*\*\*kr/);
    assert.match(res.payload, /Disponible/);
    assert.match(res.payload, /En uso/);
    assert.match(res.payload, /Vencido/);
    assert.match(res.payload, /Bonos Ruijie/);
    assert.doesNotMatch(res.payload, new RegExp(PLAINTEXT));
    assert.doesNotMatch(res.payload, /data-reveal/);
  });

  await t.test('guides to sync when there are no sites', async () => {
    const { app } = await buildApp({
      resellers: { ...buildServices().resellers, async listSites() { return []; } },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/admin/vouchers', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Sincronizar sitios/);
    assert.match(res.payload, /No hay sitios sincronizados/);
  });

  await t.test('cross-role: reseller is forbidden from the vouchers page', async () => {
    const { app } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/admin/vouchers', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 403);
  });
});

test('admin sync-sites route', async (t) => {
  await t.test('requires CSRF and syncs with a valid token', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());

    const denied = await app.inject({
      method: 'POST',
      url: '/admin/vouchers/sync-sites',
      headers: { cookie: cookie('admin') },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(services.calls.syncSites, 0);

    const ok = await app.inject({
      method: 'POST',
      url: '/admin/vouchers/sync-sites',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF },
    });
    assert.equal(ok.statusCode, 303);
    assert.match(ok.headers.location, /^\/admin\/vouchers\?notice=/);
    assert.equal(services.calls.syncSites, 1);
  });

  await t.test('reseller cannot trigger sync', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/vouchers/sync-sites',
      headers: { cookie: cookie('reseller') },
      payload: { csrfToken: CSRF },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(services.calls.syncSites, 0);
  });
});

test('admin catalog sync and context', async (t) => {
  await t.test('catalog sync requires CSRF and calls syncCatalog with a valid token', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());

    const denied = await app.inject({
      method: 'POST',
      url: '/catalog/sync',
      headers: { cookie: cookie('admin') },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(services.calls.syncCatalog, 0);

    const ok = await app.inject({
      method: 'POST',
      url: '/catalog/sync',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF },
    });
    assert.equal(ok.statusCode, 303);
    assert.match(ok.headers.location, /^\/catalog\?notice=/);
    assert.equal(services.calls.syncCatalog, 1);
  });

  await t.test('reseller cannot trigger catalog sync', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/sync',
      headers: { cookie: cookie('reseller') },
      payload: { csrfToken: CSRF },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(services.calls.syncCatalog, 0);
  });

  await t.test('secondary sync action and guided empty state without context', async () => {
    const { app } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/catalog', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /action="\/catalog\/sync"/);
    assert.match(res.payload, />Sincronizar</);
    assert.match(res.payload, /Selecciona un revendedor y un sitio/);
    // No context means no package list and no site selector yet.
    assert.doesNotMatch(res.payload, /Paquetes del sitio/);
    assert.doesNotMatch(res.payload, /id="siteId"/);
    assert.doesNotMatch(res.payload, /<ol class="steps"/);
  });

  await t.test('reseller selection reveals the contextual site selector', async () => {
    const { app } = await buildApp({
      resellers: {
        ...buildServices().resellers,
        async listResellerSites() {
          return [{ id: 's1', name: 'Sitio Centro', ruijie_group_id: 'g1', status: 'active' }];
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/catalog?resellerId=r1', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /id="siteId"/);
    assert.match(res.payload, /Sitio Centro/);
    assert.match(res.payload, /Selecciona un revendedor y un sitio/);
  });

  await t.test('one package list per site without a duplicate package select', async () => {
    const { app } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'GET',
      url: '/catalog?resellerId=r1&siteId=s1',
      headers: { cookie: cookie('admin') },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Paquetes del sitio/);
    assert.match(res.payload, /Paquete 1h/);
    // Packages are addressed per row; there is no duplicated package select.
    assert.doesNotMatch(res.payload, /<select[^>]*id="packageId"/);
    assert.doesNotMatch(res.payload, /<option value="p1">/);
  });

  await t.test('authorized package offers price and revoke; inline price is reseller_site scoped', async () => {
    const { app } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'GET',
      url: '/catalog?resellerId=r1&siteId=s1',
      headers: { cookie: cookie('admin') },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Autorizado/);
    assert.match(res.payload, /action="\/catalog\/prices"/);
    assert.match(res.payload, /name="scope" value="reseller_site"/);
    assert.match(res.payload, /action="\/catalog\/permissions\/revoke"/);
    assert.doesNotMatch(res.payload, /action="\/catalog\/permissions"/);
  });

  await t.test('unauthorized package only offers authorize', async () => {
    const { app } = await buildApp({
      catalog: {
        ...buildServices().catalog,
        async listAuthorizedPackages() {
          return [];
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({
      method: 'GET',
      url: '/catalog?resellerId=r1&siteId=s1',
      headers: { cookie: cookie('admin') },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /No autorizado/);
    assert.match(res.payload, /action="\/catalog\/permissions"/);
    assert.doesNotMatch(res.payload, /action="\/catalog\/prices"/);
    assert.doesNotMatch(res.payload, /action="\/catalog\/permissions\/revoke"/);
  });
});

test('reseller catalog only shows authorized packages with a price', async (t) => {
  await t.test('shows the resolved price', async () => {
    const { app } = await buildApp({
      catalog: {
        ...buildServices().catalog,
        async resolvePrice() {
          return { amountMinor: 5000, currency: 'COP' };
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/catalog', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Paquete 1h/);
    assert.match(res.payload, /5\.000/);
  });

  await t.test('hides authorized packages without a price', async () => {
    const { app } = await buildApp({
      catalog: {
        ...buildServices().catalog,
        async resolvePrice() {
          const err = new Error('price_missing');
          err.code = 'price_missing';
          throw err;
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/catalog', headers: { cookie: cookie('reseller') } });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.payload, /Paquete 1h/);
  });
});

test('reseller detail lists users without hashes and only valid transitions', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/admin/resellers/r1', headers: { cookie: cookie('admin') } });
  assert.equal(res.statusCode, 200);
  assert.match(res.payload, /r@test/);
  assert.doesNotMatch(res.payload, /password_hash/);
  assert.doesNotMatch(res.payload, /hash/);
  // pending -> active|closed only, never suspended/restricted
  assert.match(res.payload, /value="active"/);
  assert.match(res.payload, /value="closed"/);
  assert.doesNotMatch(res.payload, /value="suspended"/);
  assert.doesNotMatch(res.payload, /value="restricted"/);
});

test('reseller surfaces: quick-create copy and flat detail', async (t) => {
  await t.test('list shows the advanced balance option and a clean row', async () => {
    const { app } = await buildApp({
      resellers: {
        ...buildServices().resellers,
        async listResellers() {
          return [
            {
              id: 'r1',
              name: 'Revendedor Uno',
              status: 'active',
              currency: 'COP',
              low_balance_threshold_minor: 5000,
              primary_email: 'uno@test',
              created_at: new Date('2024-01-01'),
            },
          ];
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/admin/resellers', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Opciones avanzadas/);
    assert.match(res.payload, /Avisar cuando el saldo baje de/);
    assert.doesNotMatch(res.payload, /Umbral/);
    assert.match(res.payload, /uno@test/);
    assert.match(res.payload, />Gestionar</);
    assert.match(res.payload, /Activo/);
  });

  await t.test('detail uses flat sections, details add forms and fixes Ruijie', async () => {
    const { app } = await buildApp({
      resellers: {
        ...buildServices().resellers,
        async listResellerSites() {
          return [{ id: 's1', name: 'Sitio Centro', ruijie_group_id: 'g1', status: 'active' }];
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/admin/resellers/r1', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Grupo Ruijie/);
    assert.doesNotMatch(res.payload, /Ruizie/);
    assert.match(res.payload, /<details/);
    assert.match(res.payload, /action="\/admin\/resellers\/r1\/users"/);
    assert.match(res.payload, /action="\/admin\/resellers\/r1\/sites"/);
    assert.doesNotMatch(res.payload, /Umbral/);
  });
});

test('admin reseller user provisioning', async (t) => {
  await t.test('creates a reseller user and redirects', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/resellers/r1/users',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF, email: 'nuevo-user@test', password: 'temporal-segura-123' },
    });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location, /^\/admin\/resellers\/r1\?notice=/);
    const [payload] = services.calls.createUserForReseller;
    assert.equal(payload.resellerId, 'r1');
    assert.equal(payload.email, 'nuevo-user@test');
    assert.equal(payload.password, 'temporal-segura-123');
  });

  await t.test('requires CSRF', async () => {
    const { app, services } = await buildApp();
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/resellers/r1/users',
      headers: { cookie: cookie('admin') },
      payload: { email: 'x@test', password: 'temporal-segura-123' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(services.calls.createUserForReseller.length, 0);
  });

  await t.test('error preserves email but never the password', async () => {
    const { app } = await buildApp({
      resellers: {
        ...buildServices().resellers,
        async createUserForReseller() {
          const err = new Error('email already in use');
          err.code = 'email_taken';
          throw err;
        },
      },
    });
    t.after(() => app.close());
    const res = await app.inject({
      method: 'POST',
      url: '/admin/resellers/r1/users',
      headers: { cookie: cookie('admin') },
      payload: { csrfToken: CSRF, email: 'dup-user@test', password: 'temporal-segura-123' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload, /dup-user@test/);
    assert.match(res.payload, /email already in use/);
    assert.doesNotMatch(res.payload, /temporal-segura-123/);
  });

  await t.test('empty user list shows the no-access alert and the form', async () => {
    const { app } = await buildApp({
      resellers: { ...buildServices().resellers, async listResellerUsers() { return []; } },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/admin/resellers/r1', headers: { cookie: cookie('admin') } });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /no tiene acceso/);
    assert.match(res.payload, /action="\/admin\/resellers\/r1\/users"/);
  });
});
