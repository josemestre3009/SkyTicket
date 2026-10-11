import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/web/index.js';

const renderer = createRenderer();

function baseLocals(extra = {}) {
  return {
    title: 'Prueba',
    user: null,
    role: null,
    csrfToken: '',
    activeNav: '',
    currentPath: '/',
    nav: [],
    notice: null,
    error: null,
    ...extra,
  };
}

test('renders a public page inside the shared layout', async () => {
  const html = await renderer.renderPage('login', baseLocals({ email: 'a@b.test', next: '/dashboard' }));
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /action="\/login"/);
  assert.match(html, /value="a@b\.test"/);
  assert.match(html, /\/assets\/app\.css/);
});

test('locks the document to light color scheme and hides the shell on login', async () => {
  const html = await renderer.renderPage('login', baseLocals({ email: '', next: '' }));
  assert.match(html, /<meta name="color-scheme" content="light"/);
  assert.doesNotMatch(html, /color-scheme" content="light dark"/);
  assert.doesNotMatch(html, /class="sidebar"/);
  assert.doesNotMatch(html, /data-nav-toggle/);
});

test('authenticated shell renders a vertical sidebar and accessible nav', async () => {
  const html = await renderer.renderPage(
    'error',
    baseLocals({
      user: { id: 'u1', email: 'admin@test', role: 'admin' },
      role: 'admin',
      status: 500,
      message: 'Error interno',
      nav: [
        { key: 'dashboard', href: '/dashboard', label: 'Panel', icon: 'dashboard' },
        { key: 'resellers', href: '/admin/resellers', label: 'Revendedores', icon: 'people' },
      ],
      activeNav: 'dashboard',
    }),
  );
  assert.match(html, /class="app app--shell"/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /data-nav/);
  assert.match(html, /data-nav-toggle/);
  assert.match(html, /data-nav-scrim/);
  assert.match(html, /aria-controls="primary-nav"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Principal"/);
  assert.match(html, /aria-current=/);
  assert.match(html, /href="#i-dashboard"/);
  assert.match(html, /action="\/logout"/);
});

test('escapes untrusted values in templates', async () => {
  const html = await renderer.renderPage('login', baseLocals({ email: '<script>alert(1)</script>', next: '' }));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renders error page with status and link', async () => {
  const html = await renderer.renderPage('error', baseLocals({ status: 403, message: 'Sin acceso' }));
  assert.match(html, /403/);
  assert.match(html, /Sin acceso/);
  assert.match(html, /href="\/login"/);
});

test('emission page never renders a horizontal table', async () => {
  const html = await renderer.renderPage(
    'issue',
    baseLocals({
      packages: [{ id: 'p1', siteId: 's1', name: 'Pack', duration: 60, quota: '1GB', concurrentClients: 1, status: 'active' }],
      sites: [{ id: 's1', name: 'Sitio' }],
      form: { siteId: 's1', packageId: 'p1', quantity: 1, clientReference: '' },
      localReference: 'lr-1',
    }),
  );
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /package-choices/);
});

test('resellers view renders guided quick-create and a clean row', async () => {
  const html = await renderer.renderPage(
    'resellers',
    baseLocals({
      resellers: [
        { id: 'r1', name: 'Uno', status: 'active', currency: 'COP', low_balance_threshold_minor: 0, primary_email: 'uno@test' },
      ],
      status: null,
      statuses: ['active'],
      form: { name: '', email: '' },
    }),
  );
  assert.match(html, /Alta rápida/);
  assert.match(html, /Opciones avanzadas/);
  assert.match(html, /Avisar cuando el saldo baje de/);
  assert.match(html, /uno@test/);
  assert.match(html, /Gestionar/);
  assert.match(html, /Activo/);
});

test('catalog admin renders the context band and one package list', async () => {
  const html = await renderer.renderPage(
    'catalog',
    baseLocals({
      variant: 'admin',
      resellers: [{ id: 'r1', name: 'Uno' }],
      sites: [{ id: 's1', name: 'Sitio' }],
      resellerId: 'r1',
      siteId: 's1',
      hasContext: true,
      packages: [
        { id: 'p1', siteId: 's1', name: 'Pack', duration: 60, quota: '1GB', authorized: true, price: { amountMinor: 5000 } },
      ],
      syncAvailable: true,
    }),
  );
  assert.match(html, /action="\/catalog\/sync"/);
  assert.match(html, /Selecciona un sitio/);
  assert.match(html, /Pack/);
  assert.match(html, /Autorizado/);
  assert.match(html, /name="scope" value="reseller_site"/);
  assert.match(html, /5\.000/);
});

test('catalog admin without context shows the guided empty state', async () => {
  const html = await renderer.renderPage(
    'catalog',
    baseLocals({
      variant: 'admin',
      resellers: [{ id: 'r1', name: 'Uno' }],
      sites: [],
      resellerId: null,
      siteId: null,
      hasContext: false,
      packages: [],
      syncAvailable: false,
    }),
  );
  assert.match(html, /Selecciona un revendedor y un sitio/);
  assert.doesNotMatch(html, /Paquetes del sitio/);
});

function adminSummary(overrides = {}) {
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
    ranking: [
      {
        id: 'r2',
        name: 'Revendedor Dos',
        status: 'active',
        primaryEmail: 'dos@test',
        revenueMinor: 30000,
        salesCount: 1,
        vouchersIssued: 3,
        currentBalanceMinor: 6000,
        rechargeMinor: 30000,
        lastRechargeAt: '2024-01-05T12:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function adminLocals(extra = {}) {
  return baseLocals({
    variant: 'admin',
    summary: adminSummary(),
    operation: {
      salesCount: 2,
      vouchersIssued: 5,
      activeResellers: 2,
      successPercent: '40%',
      successResolved: 5,
    },
    ranking: adminSummary().ranking,
    recentOrders: [],
    form: { email: '', amountMinor: '', reference: '', reason: '' },
    idempotencyKey: 'idem-1',
    ...extra,
  });
}

test('admin dashboard groups money and operation metrics', async () => {
  const html = await renderer.renderPage('dashboard', adminLocals());
  assert.match(html, /Resumen del negocio/);
  assert.match(html, /Últimos 30 días/);
  assert.match(html, /Ventas emitidas/);
  assert.match(html, /Recargas recibidas/);
  assert.match(html, /Saldo de revendedores/);
  assert.match(html, /\$ 40\.000/);
  assert.match(html, /\$ 50\.000/);
  assert.match(html, /\$ 13\.000/);
  assert.match(html, /Operación del período/);
  assert.match(html, /Tasa de éxito/);
  assert.match(html, /40%/);
  assert.match(html, /2 emitidas de 5 resueltas/);
  assert.match(html, /Revendedores activos/);
  assert.doesNotMatch(html, /<table/);
});

test('admin dashboard clarifies that recharge and balance are not profit', async () => {
  const html = await renderer.renderPage('dashboard', adminLocals());
  assert.match(html, /no una ganancia/);
  assert.match(html, /no son ganancia/);
  assert.match(html, /obligación con el revendedor/);
});

test('admin dashboard recharge panel posts by email with a hidden idempotency key', async () => {
  const html = await renderer.renderPage('dashboard', adminLocals());
  assert.match(html, /action="\/admin\/dashboard\/recharge-by-email"/);
  assert.match(html, /name="idempotencyKey" value="idem-1"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="amountMinor"/);
  assert.match(html, /name="reference"/);
  assert.match(html, /name="reason"[^>]*required/);
  assert.match(html, /se acreditará el saldo al revendedor asociado/);
  assert.match(html, /se confirma al enviar/);
  assert.match(html, /Agregar saldo/);
});

test('admin dashboard preserves the failed recharge attempt and shows the error', async () => {
  const html = await renderer.renderPage(
    'dashboard',
    adminLocals({
      error: 'a valid email is required',
      form: { email: 'bad@test', amountMinor: '15000', reference: 'ref-1', reason: 'carga' },
      idempotencyKey: 'idem-retry',
    }),
  );
  assert.match(html, /a valid email is required/);
  assert.match(html, /value="bad@test"/);
  assert.match(html, /value="15000"/);
  assert.match(html, /name="idempotencyKey" value="idem-retry"/);
});

test('admin dashboard ranking lists per-reseller spend with a management link', async () => {
  const html = await renderer.renderPage('dashboard', adminLocals());
  assert.match(html, /Gasto por revendedor/);
  assert.match(html, /Revendedor Dos/);
  assert.match(html, /dos@test/);
  assert.match(html, /Gasto del período/);
  assert.match(html, /Recargas del período/);
  assert.match(html, /Saldo actual/);
  assert.match(html, /Última recarga/);
  assert.match(html, /\$ 30\.000/);
  assert.match(html, /\$ 6\.000/);
  assert.match(html, /href="\/admin\/resellers\/r2"/);
  assert.match(html, />Gestionar</);
});

test('admin dashboard empty ranking is actionable', async () => {
  const html = await renderer.renderPage('dashboard', adminLocals({ ranking: [] }));
  assert.match(html, /Aún no hay gasto de revendedores/);
  assert.match(html, /href="\/admin\/resellers"/);
  assert.match(html, /Ver revendedores/);
});

// Detector at the end: the recharge flow must never be framed as profit.
test('detector: recharge money is never labelled ganancia or ingreso', async () => {
  const html = await renderer.renderPage('dashboard', adminLocals());
  const start = html.indexOf('recharge-panel');
  const end = html.indexOf('</section>', start);
  assert.ok(start > -1 && end > start, 'recharge panel rendered');
  const panel = html.slice(start, end);
  assert.doesNotMatch(panel, /ganancia/i);
  assert.doesNotMatch(panel, /ingreso/i);
  assert.doesNotMatch(panel, /ganar/i);
});
