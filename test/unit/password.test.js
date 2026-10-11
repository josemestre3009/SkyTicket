import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

const FAST = { N: 1024, r: 8, p: 1 };

test('hashes and verifies a password', () => {
  const stored = hashPassword('correct horse battery staple', FAST);
  assert.match(stored, /^scrypt\$/);
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
});

test('rejects a wrong password', () => {
  const stored = hashPassword('right-password', FAST);
  assert.equal(verifyPassword('wrong-password', stored), false);
});

test('produces a unique salt per hash', () => {
  const a = hashPassword('same', FAST);
  const b = hashPassword('same', FAST);
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('rejects malformed stored values', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$1$2$3'), false);
});
