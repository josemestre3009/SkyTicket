import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, isSensitiveKey, maskCode, maskEmail } from '../../src/lib/redact.js';

test('redacts sensitive-named fields deeply', () => {
  const input = {
    username: 'admin',
    password: 'hunter2',
    nested: {
      app_secret: 'abc',
      access_token: 'tok',
      public: 'keep-me',
      list: [{ code: '12345678' }],
    },
  };
  const out = redact(input);
  assert.equal(out.username, 'admin');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.nested.app_secret, '[REDACTED]');
  assert.equal(out.nested.access_token, '[REDACTED]');
  assert.equal(out.nested.public, 'keep-me');
  assert.equal(out.nested.list[0].code, '[REDACTED]');
});

test('does not mutate the original value', () => {
  const input = { secret: 'x', ok: true };
  redact(input);
  assert.equal(input.secret, 'x');
});

test('handles errors and circular refs safely', () => {
  const circular = { name: 'a' };
  circular.self = circular;
  const out = redact(circular);
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
  assert.deepEqual(redact(new Error('boom')), { name: 'Error', message: 'boom' });
});

test('classifies sensitive keys', () => {
  assert.equal(isSensitiveKey('access_token'), true);
  assert.equal(isSensitiveKey('voucherCode'), true);
  assert.equal(isSensitiveKey('username'), false);
});

test('masks codes and emails', () => {
  assert.equal(maskCode('12345678'), '12****78');
  assert.equal(maskCode('ab'), '**');
  assert.equal(maskEmail('reseller@example.com'), 'r*******@example.com');
});
