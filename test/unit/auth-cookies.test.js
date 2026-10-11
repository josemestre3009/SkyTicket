import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, serializeCookie } from '../../src/auth/cookies.js';

test('parses multiple cookies and quoted values', () => {
  const parsed = parseCookies('a=1; skyticket_sid=xyz.123; quoted="hello"');
  assert.equal(parsed.a, '1');
  assert.equal(parsed.skyticket_sid, 'xyz.123');
  assert.equal(parsed.quoted, 'hello');
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('serializes a hardened session cookie', () => {
  const cookie = serializeCookie('sid', 'tok en', { maxAgeMs: 60000, secure: true });
  assert.match(cookie, /^sid=tok%20en/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=60/);
});

test('insecure local cookie omits Secure and supports same-site override', () => {
  const cookie = serializeCookie('sid', 'x', { secure: false, sameSite: 'Strict' });
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

test('clearing a cookie expires it immediately', () => {
  const cookie = serializeCookie('sid', '', { maxAgeMs: 0, expiresAt: new Date(0) });
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
});
