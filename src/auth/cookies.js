export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    if (!name) continue;
    const value = pair.slice(index + 1).trim();
    out[name] = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return out;
}

function encode(value) {
  return encodeURIComponent(value);
}

export function serializeCookie(name, value, options = {}) {
  const {
    maxAgeMs,
    expiresAt,
    path = '/',
    httpOnly = true,
    secure = false,
    sameSite = 'Lax',
  } = options;

  const parts = [`${name}=${encode(value)}`];
  if (path) parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);

  if (maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
  }
  if (expiresAt instanceof Date) {
    parts.push(`Expires=${expiresAt.toUTCString()}`);
  }
  return parts.join('; ');
}

function appendSetCookie(reply, cookie) {
  const existing = reply.getHeader('set-cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(cookie);
  reply.header('set-cookie', list);
}

export function setCookie(reply, name, value, options) {
  appendSetCookie(reply, serializeCookie(name, value, options));
}

export function clearCookie(reply, name, options = {}) {
  appendSetCookie(
    reply,
    serializeCookie(name, '', { ...options, maxAgeMs: 0, expiresAt: new Date(0) }),
  );
}
