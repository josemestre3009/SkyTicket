const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // Trust proxy headers only when explicitly enabled behind a known reverse
  // proxy; defaults to false so X-Forwarded-For cannot spoof request.ip.
  trustProxy: bool(env.TRUST_PROXY, false),

  databaseUrl: env.DATABASE_URL || '',

  session: {
    secret: env.SESSION_SECRET || '',
    cookieName: env.SESSION_COOKIE_NAME || 'skyticket_sid',
  },

  encryption: {
    primaryKey: env.APP_ENCRYPTION_KEY || '',
    primaryKeyId: env.APP_ENCRYPTION_KEY_ID || 'primary',
    rotationKeys: env.APP_ENCRYPTION_KEYS || '',
  },

  adminEmail: env.ADMIN_EMAIL || '',

  ruijie: {
    // Emission against the real Ruijie Cloud stays disabled until the sandbox
    // checklist is signed off. When false, no outbound Ruijie call is made.
    liveEnabled: bool(env.RUIJIE_LIVE_ENABLED, false),
    // Read-only inventory (group tree + voucher listing) is independent from
    // emission. It defaults to enabled only when credentials are present.
    readEnabled: bool(
      env.RUIJIE_READ_ENABLED,
      Boolean(env.RUIJIE_APP_ID && env.RUIJIE_APP_SECRET),
    ),
    baseUrl: env.RUIJIE_BASE_URL || '',
    region: env.RUIJIE_REGION || 'eu',
    appId: env.RUIJIE_APP_ID || '',
    appSecret: env.RUIJIE_APP_SECRET || '',
    apiToken: env.RUIJIE_API_TOKEN || '',
  },

  mail: {
    smtpUrl: env.SMTP_URL || '',
    from: env.MAIL_FROM || 'no-reply@skyticket.local',
  },

  jobs: {
    leaseMs: int(env.JOB_LEASE_MS, 60000),
    pollIntervalMs: int(env.JOB_POLL_INTERVAL_MS, 1000),
    maxAttempts: int(env.JOB_MAX_ATTEMPTS, 5),
    backoffBaseMs: int(env.JOB_BACKOFF_BASE_MS, 1000),
    backoffCapMs: int(env.JOB_BACKOFF_CAP_MS, 300000),
    dedupe: bool(env.JOB_DEDUPE, true),
  },

  // Reconciliation/worker operating thresholds (see design.md section 9).
  reconciliation: {
    holdGraceMs: int(env.RECONCILE_HOLD_GRACE_MS, 15 * 60_000),
    stuckOrderMs: int(env.RECONCILE_STUCK_ORDER_MS, 30 * 60_000),
  },

  worker: {
    maintenanceIntervalMs: int(env.WORKER_MAINTENANCE_INTERVAL_MS, 60_000),
  },
};

export function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  return config.databaseUrl;
}

export function requireEncryptionKey() {
  if (!config.encryption.primaryKey) {
    throw new Error('APP_ENCRYPTION_KEY is not set');
  }
  return config.encryption.primaryKey;
}
