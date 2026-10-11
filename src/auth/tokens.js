import crypto from 'node:crypto';
import { config } from '../config.js';

const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

export function randomToken(bytes = SESSION_TOKEN_BYTES) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateSessionToken() {
  return randomToken(SESSION_TOKEN_BYTES);
}

export function generateCsrfToken() {
  return randomToken(CSRF_TOKEN_BYTES);
}

/**
 * Opaque token hash with SESSION_SECRET as pepper so a leaked session table
 * cannot be turned into live cookies without the secret.
 */
export function hashToken(token, pepper = config.session.secret) {
  if (!token) return null;
  return crypto.createHmac('sha256', pepper || '').update(String(token)).digest('hex');
}

export function hashCsrfToken(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
