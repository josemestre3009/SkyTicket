const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /credential/i,
  /authorization/i,
  /api[-_]?key/i,
  /app[-_]?id/i,
  /appid/i,
  /private[-_]?key/i,
  /totp/i,
  /^code$/i,
  /voucher[-_]?code/i,
  /code[-_]?encrypted/i,
  /recovery[-_]?code/i,
];

export function isSensitiveKey(key) {
  const name = String(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Deep-clone a value, replacing sensitive-named fields with a redaction marker.
 * Strings are preserved (key-based redaction only) so operational context survives.
 */
export function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen);
  }
  return out;
}

export function maskCode(code) {
  if (code === null || code === undefined) return null;
  const value = String(code);
  if (value.length <= 4) return '*'.repeat(value.length);
  const visible = 2;
  return `${value.slice(0, visible)}${'*'.repeat(Math.min(value.length - visible * 2, 8))}${value.slice(-visible)}`;
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
