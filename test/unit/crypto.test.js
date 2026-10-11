import test from 'node:test';
import assert from 'node:assert/strict';
import { Cipher, buildKeyring } from '../../src/lib/crypto.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

test('round-trips plaintext', () => {
  const cipher = Cipher.fromKey(KEY);
  const token = cipher.encrypt('voucher-secret-123');
  assert.notEqual(token, 'voucher-secret-123');
  assert.equal(cipher.decrypt(token), 'voucher-secret-123');
});

test('uses a unique nonce per encryption', () => {
  const cipher = Cipher.fromKey(KEY);
  const a = cipher.encrypt('same-value');
  const b = cipher.encrypt('same-value');
  assert.notEqual(a, b);
  assert.equal(cipher.decrypt(a), cipher.decrypt(b));
});

test('detects tampering with ciphertext and tag', () => {
  const cipher = Cipher.fromKey(KEY);
  const token = cipher.encrypt('integrity-value');
  const parts = token.split('.');
  const tamperedData = [...parts];
  const raw = Buffer.from(parts[4], 'base64url');
  raw[0] ^= 0x01;
  tamperedData[4] = raw.toString('base64url');
  assert.throws(() => cipher.decrypt(tamperedData.join('.')));

  const tamperedTag = [...parts];
  const tag = Buffer.from(parts[3], 'base64url');
  tag[0] ^= 0x01;
  tamperedTag[3] = tag.toString('base64url');
  assert.throws(() => cipher.decrypt(tamperedTag.join('.')));
});

test('binds optional AAD', () => {
  const cipher = Cipher.fromKey(KEY);
  const token = cipher.encrypt('aad-value', { aad: 'tenant-1' });
  assert.equal(cipher.decrypt(token, { aad: 'tenant-1' }), 'aad-value');
  assert.throws(() => cipher.decrypt(token, { aad: 'tenant-2' }));
});

test('supports decryption with a rotation keyring', () => {
  const oldKey = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').toString('base64');
  const newKey = Buffer.from('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').toString('base64');
  const oldCipher = Cipher.fromKey(oldKey);
  const token = oldCipher.encrypt('rotated-value');

  const { keyring, primaryId } = buildKeyring({ primaryKey: newKey });
  const keyId = token.split('.')[1];
  assert.notEqual(keyId, primaryId);
  const rotation = buildKeyring({ primaryKey: newKey, rotationKeys: JSON.stringify({ [keyId]: oldKey }) });
  const rotationCipher = new Cipher(rotation);
  assert.equal(rotationCipher.decrypt(token), 'rotated-value');
  assert.equal(keyring.size, 1);
});

test('rejects unknown key id', () => {
  const cipher = Cipher.fromKey(KEY);
  const token = cipher.encrypt('x').replace(/\.[^.]*\./, '.unknown-key.');
  assert.throws(() => cipher.decrypt(token), /Unknown encryption key id/);
});
