import crypto from 'node:crypto';

const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export function hashPassword(password, params = DEFAULT_PARAMS) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') {
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}
