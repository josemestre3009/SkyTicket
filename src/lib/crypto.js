import crypto from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function decodeKey(raw, label = 'encryption key') {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`Missing ${label}`);
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const candidate = Buffer.from(raw, 'base64');
  const isCanonicalBase64 =
    candidate.length === KEY_BYTES && candidate.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '');
  if (isCanonicalBase64) {
    return candidate;
  }
  // Deterministic fallback for passphrase-style values.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function keyIdFor(key, suffix = '') {
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return suffix ? `${suffix}.${fingerprint}` : fingerprint;
}

function parseRotationKeys(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    throw new Error('APP_ENCRYPTION_KEYS must be a JSON object mapping keyId -> key');
  }
}

function b64url(buf) {
  return buf.toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * Build a keyring: keyId -> Buffer.
 * Ciphertext embeds the keyId so older keys can still decrypt during rotation.
 */
export function buildKeyring({ primaryKey, primaryKeyId, rotationKeys } = {}) {
  const keyring = new Map();

  const primary = decodeKey(primaryKey, 'APP_ENCRYPTION_KEY');
  const primaryId = primaryKeyId && primaryKeyId !== 'primary' ? keyIdFor(primary, primaryKeyId) : keyIdFor(primary);
  keyring.set(primaryId, primary);

  const rotation = parseRotationKeys(rotationKeys);
  for (const [id, value] of Object.entries(rotation)) {
    keyring.set(id, decodeKey(value, `rotation key ${id}`));
  }

  return { keyring, primaryId };
}

let cached = null;

function defaultKeyring() {
  if (!cached) {
    cached = buildKeyring({
      primaryKey: config.encryption.primaryKey,
      primaryKeyId: config.encryption.primaryKeyId,
      rotationKeys: config.encryption.rotationKeys,
    });
  }
  return cached;
}

export function resetKeyringCache() {
  cached = null;
}

export class Cipher {
  constructor({ keyring, primaryId }) {
    this.keyring = keyring;
    this.primaryId = primaryId;
  }

  static fromConfig() {
    const { keyring, primaryId } = defaultKeyring();
    return new Cipher({ keyring, primaryId });
  }

  static fromKey(rawKey) {
    return new Cipher(buildKeyring({ primaryKey: rawKey }));
  }

  encrypt(plaintext, { aad } = {}) {
    if (plaintext === undefined || plaintext === null) {
      throw new Error('Cannot encrypt null or undefined');
    }
    const key = this.keyring.get(this.primaryId);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
    if (aad !== undefined) {
      cipher.setAAD(Buffer.from(aad));
    }
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.primaryId, b64url(nonce), b64url(tag), b64url(ciphertext)].join('.');
  }

  decrypt(token, { aad } = {}) {
    if (typeof token !== 'string') {
      throw new Error('Invalid ciphertext');
    }
    const parts = token.split('.');
    if (parts.length !== 5) {
      throw new Error('Invalid ciphertext format');
    }
    const [version, keyId, nonceRaw, tagRaw, dataRaw] = parts;
    if (version !== VERSION) {
      throw new Error(`Unsupported ciphertext version: ${version}`);
    }
    const key = this.keyring.get(keyId);
    if (!key) {
      throw new Error(`Unknown encryption key id: ${keyId}`);
    }
    const nonce = fromB64url(nonceRaw);
    const tag = fromB64url(tagRaw);
    const data = fromB64url(dataRaw);
    if (nonce.length !== NONCE_BYTES || tag.length !== AUTH_TAG_BYTES) {
      throw new Error('Invalid ciphertext parameters');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad));
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  encryptJson(value, options) {
    return this.encrypt(JSON.stringify(value), options);
  }

  decryptJson(token, options) {
    return JSON.parse(this.decrypt(token, options));
  }
}

export function encrypt(plaintext, options) {
  return Cipher.fromConfig().encrypt(plaintext, options);
}

export function decrypt(token, options) {
  return Cipher.fromConfig().decrypt(token, options);
}
