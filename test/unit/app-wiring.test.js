import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, SECURITY_HEADERS } from '../../src/app.js';
import { createRuntime } from '../../src/bootstrap.js';

function fakeIdentity() {
  const calls = { resolve: 0, login: 0 };
  const user = { id: 'u-admin', email: 'admin@test', role: 'admin', reseller_id: null, status: 'active' };
  const identity = {
    calls,
    async resolve() {
      calls.resolve += 1;
      return null;
    },
    async login() {
      calls.login += 1;
      return { token: 'session-token', csrfToken: 'csrf-token', user, session: { id: 's-1', expires_at: null } };
    },
    async logout() {
      return true;
    },
  };
  return identity;
}

function buildWiredApp() {
  const identity = fakeIdentity();
  const runtime = createRuntime({ services: { identity } });
  const app = buildApp({ runtime, logger: false });
  return { app, runtime, identity };
}

test('app wiring: composition root shares one service graph and guards', async (t) => {
  const { app, runtime } = buildWiredApp();
  t.after(() => app.close());
  await app.ready();

  assert.equal(app.runtime, runtime);
  assert.equal(app.runtime.guards, runtime.guards);
  assert.equal(typeof runtime.guards.attachSession, 'function');
});

test('app wiring: health, SSR, assets and auth API are all mounted', async (t) => {
  const { app } = buildWiredApp();
  t.after(() => app.close());
  await app.ready();

  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });

  const login = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['content-type'], /text\/html/);

  const css = await app.inject({ method: 'GET', url: '/assets/app.css' });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const authApi = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@test', password: 'secret' },
  });
  assert.equal(authApi.statusCode, 200);
  assert.equal(authApi.json().csrfToken, 'csrf-token');
  assert.match(authApi.headers['set-cookie'].toString(), /skyticket_sid=/);
});

test('app wiring: security headers are applied to HTML, assets and JSON', async (t) => {
  const { app } = buildWiredApp();
  t.after(() => app.close());
  await app.ready();

  for (const url of ['/', '/login', '/assets/app.css', '/healthz']) {
    const res = await app.inject({ method: 'GET', url });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers[name], value, `${url} missing ${name}`);
    }
  }
});

test('app wiring: trustProxy is off by default and only trusted when configured', async (t) => {
  const off = buildWiredApp().app;
  t.after(() => off.close());
  off.get('/ip', async (request) => ({ ip: request.ip }));
  await off.ready();
  const spoofed = await off.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(spoofed.json().ip, '127.0.0.1', 'X-Forwarded-For is ignored without trustProxy');

  const on = buildApp({
    runtime: createRuntime({ services: { identity: fakeIdentity() } }),
    logger: false,
    trustProxy: true,
  });
  t.after(() => on.close());
  on.get('/ip', async (request) => ({ ip: request.ip }));
  await on.ready();
  const trusted = await on.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(trusted.json().ip, '9.9.9.9');
});

test('app wiring: unauthenticated auth API returns a safe JSON error, not a page', async (t) => {
  const { app } = buildWiredApp();
  t.after(() => app.close());
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/auth/session' });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = res.json();
  assert.equal(body.error, 'unauthorized');
  assert.ok(body.message);
  assert.doesNotMatch(res.payload, /at .*\(.*:\d+:\d+\)/);
});

test('app wiring: legacy 2FA/recovery routes are gone', async (t) => {
  const { app } = buildWiredApp();
  t.after(() => app.close());
  await app.ready();

  const routes = [
    { method: 'GET', url: '/2fa' },
    { method: 'POST', url: '/2fa/verify' },
    { method: 'POST', url: '/2fa/recovery' },
    { method: 'POST', url: '/2fa/enroll' },
    { method: 'POST', url: '/2fa/confirm' },
    { method: 'POST', url: '/auth/2fa/verify' },
    { method: 'POST', url: '/auth/recovery/verify' },
  ];
  for (const route of routes) {
    const res = await app.inject(route);
    assert.equal(res.statusCode, 404, `${route.method} ${route.url} should be gone`);
  }
});

test('app wiring: root error handler hides 5xx internals behind a safe envelope', async (t) => {
  const { app } = buildWiredApp();
  t.after(() => app.close());
  app.get('/boom', async () => {
    throw new Error('secret stack detail');
  });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'internal_error', message: 'Internal server error' });
  assert.doesNotMatch(res.payload, /secret stack detail/);
});
