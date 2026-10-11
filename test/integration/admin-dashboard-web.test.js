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

function captureRender() {
  const pages = [];
  return {
    pages,
    async renderPage(view, locals) {
      pages.push({ view, locals });
      return `<!doctype html><html><body data-view="${view}">ok</body></html>`;
    },
  };
}

function buildServices(overrides = {}) {
  const calls = { recharge: [], lookups: [] };
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
        return [];
      },
      async findResellerByUserEmail(email) {
        calls.lookups.push(email);
        if (email === 'known@test') {
          return { id: 'r1', name: 'Revendedor Uno', status: 'active', archived: false, email };
        }
        if (email === 'archived@test') {
          const err = new Error('Reseller is archived');
          err.code = 'reseller_archived';
          throw err;
        }
        const err = new Error('a valid email is required');
        err.code = 'email_required';
        throw err;
      },
    },
    wallet: {
      async recharge(payload) {
        calls.recharge.push(payload);
        return { entry: { id: 'm1' }, balance: {} };
      },
    },
    orders: {
      async listOrders() {
        return [];
      },
    },
    adminDashboard: {
      async getSummary() {
        return null;
      },
    },
  };
  return Object.assign(services, overrides);
}

async function buildApp(overrides = {}) {
  const services = buildServices(overrides);
  const render = captureRender();
  const web = createWebPlugin({ services, authService: services.identity, render });
  const app = Fastify();
  await app.register(web.plugin);
  await app.ready();
  return { app, services, render };
}

function cookie(token) {
  return `skyticket_sid=${token}`;
}

function lastPage(render) {
  return render.pages[render.pages.length - 1];
}

test('recharge-by-email resolves the reseller server-side and reuses wallet.recharge', async (t) => {
  const { app, services } = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/admin/dashboard/recharge-by-email',
    headers: { cookie: cookie('admin') },
    payload: {
      csrfToken: CSRF,
      email: 'known@test',
      amountMinor: '15000',
      reference: 'ref-1',
      idempotencyKey: 'idem-1',
      reason: 'carga administrativa',
      // A forged tenant id must be ignored; the server resolves it from email.
      resellerId: 'someone-else',
    },
  });

  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location, /^\/dashboard\?notice=/);
  assert.deepEqual(services.calls.lookups, ['known@test']);
  assert.equal(services.calls.recharge.length, 1);
  const payload = services.calls.recharge[0];
  assert.equal(payload.resellerId, 'r1');
  assert.equal(payload.amountMinor, 15000);
  assert.equal(payload.reference, 'ref-1');
  assert.equal(payload.idempotencyKey, 'idem-1');
  assert.equal(payload.reason, 'carga administrativa');
  assert.equal(payload.actor, adminUser);
});

test('invalid or unknown email re-renders the dashboard and never recharges', async (t) => {
  const { app, services, render } = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/admin/dashboard/recharge-by-email',
    headers: { cookie: cookie('admin') },
    payload: { csrfToken: CSRF, email: 'not-an-email', amountMinor: '15000', reference: 'ref-1', reason: 'carga' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(services.calls.recharge.length, 0);
  const page = lastPage(render);
  assert.equal(page.view, 'dashboard');
  assert.match(page.locals.error, /valid email/);
  assert.deepEqual(page.locals.form, {
    email: 'not-an-email',
    amountMinor: '15000',
    reference: 'ref-1',
    reason: 'carga',
  });
  // The form only carries the attempted values; no secret ever travels back.
  assert.deepEqual(Object.keys(page.locals.form).sort(), ['amountMinor', 'email', 'reason', 'reference']);
});

test('archived reseller is rejected without a recharge', async (t) => {
  const { app, services, render } = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/admin/dashboard/recharge-by-email',
    headers: { cookie: cookie('admin') },
    payload: { csrfToken: CSRF, email: 'archived@test', amountMinor: '15000', reason: 'carga' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(services.calls.recharge.length, 0);
  assert.match(lastPage(render).locals.error, /archived/i);
});

test('recharge-by-email requires CSRF and admin role', async (t) => {
  const { app, services } = await buildApp();
  t.after(() => app.close());

  const noCsrf = await app.inject({
    method: 'POST',
    url: '/admin/dashboard/recharge-by-email',
    headers: { cookie: cookie('admin') },
    payload: { email: 'known@test', amountMinor: '15000', reason: 'carga' },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(services.calls.recharge.length, 0);

  const asReseller = await app.inject({
    method: 'POST',
    url: '/admin/dashboard/recharge-by-email',
    headers: { cookie: cookie('reseller') },
    payload: { csrfToken: CSRF, email: 'known@test', amountMinor: '15000', reason: 'carga' },
  });
  assert.equal(asReseller.statusCode, 403);
  assert.equal(services.calls.recharge.length, 0);
  assert.equal(services.calls.lookups.length, 0);
});

test('admin dashboard GET uses the shared locals helper without secrets', async (t) => {
  const { app, render } = await buildApp({
    adminDashboard: {
      async getSummary() {
        return {
          period: { label: 'Últimos 30 días', from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' },
          revenueMinor: 40000,
          salesCount: 2,
          vouchersIssued: 5,
          rechargeMinor: 50000,
          rechargeCount: 2,
          circulatingBalanceMinor: 13000,
          activeResellers: 2,
          successRate: 0.4,
          resolvedOrders: 5,
          ranking: [],
        };
      },
    },
  });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: cookie('admin') } });
  assert.equal(res.statusCode, 200);
  const page = lastPage(render);
  assert.equal(page.view, 'dashboard');
  assert.equal(page.locals.variant, 'admin');
  assert.equal(page.locals.form.email, '');
  assert.equal(JSON.stringify(page.locals).includes('password'), false);
});
