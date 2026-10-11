import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSessionToken,
  generateCsrfToken,
  hashToken,
  hashCsrfToken,
  timingSafeEqualHex,
} from '../../src/auth/tokens.js';

test('session and csrf tokens are unique and URL-safe', () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(generateCsrfToken(), generateCsrfToken());
});

test('token hashing is deterministic and peppered', () => {
  assert.equal(hashToken('abc', 'pepper'), hashToken('abc', 'pepper'));
  assert.notEqual(hashToken('abc', 'pepper'), hashToken('abc', 'other'));
  assert.notEqual(hashToken('abc', 'pepper'), hashCsrfToken('abc'));
});

test('constant-time hex comparison rejects length and value mismatches', () => {
  const h = hashCsrfToken('token');
  assert.equal(timingSafeEqualHex(h, h), true);
  assert.equal(timingSafeEqualHex(h, hashCsrfToken('other')), false);
  assert.equal(timingSafeEqualHex(h, 'deadbeef'), false);
});
