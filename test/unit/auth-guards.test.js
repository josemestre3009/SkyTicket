import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuards } from '../../src/auth/guards.js';
import { hashCsrfToken } from '../../src/auth/tokens.js';

const COOKIE = 'skyticket_sid';

function guardsWith(resolve = async () => null) {
  return createGuards({ service: { resolve }, cookieName: COOKIE });
}

function request(overrides = {}) {
  return { method: 'POST', headers: {}, ...overrides };
}

test('requireAuth rejects requests without a session', async () => {
  const { requireAuth } = guardsWith();
  await assert.rejects(() => requireAuth(request()), /Authentication required/);
});

test('requireRole rejects the wrong role without side effects', async () => {
  const { requireRole } = guardsWith();
  const req = request({ auth: { user: { id: 'u1', role: 'reseller' }, session: {} } });
  await assert.rejects(() => requireRole('admin')(req), /Access denied/);
});

test('requireCsrf skips safe methods and enforces mutations', async () => {
  const { requireCsrf } = guardsWith();
  const csrf = 'csrf-token';
  const session = { csrf_hash: hashCsrfToken(csrf) };

  await requireCsrf(request({ method: 'GET', auth: { user: {}, session } }));

  await assert.rejects(
    () => requireCsrf(request({ auth: { user: {}, session } })),
    /Missing CSRF token/,
  );
  await assert.rejects(
    () => requireCsrf(request({ headers: { 'x-csrf-token': 'wrong' }, auth: { user: {}, session } })),
    /Invalid CSRF token/,
  );
  await requireCsrf(request({ headers: { 'x-csrf-token': csrf }, auth: { user: {}, session } }));
});
