/**
 * Notification channel/recipient matrix and dedupe planning.
 *
 * Source of truth for "quien recibe que por donde" is the notifications spec
 * (openspec .../specs/notifications/spec.md), requirement "Canales por evento".
 * Kept dependency-free so it can be unit tested without a database.
 */

export const NOTIFICATION_TYPES = Object.freeze({
  LOW_BALANCE: 'low_balance',
  TOPUP: 'topup',
  ISSUE_COMPLETED: 'issue_completed',
  ISSUE_UNCERTAIN: 'issue_uncertain',
  SUSPENSION: 'suspension',
  SYNC_FAILURE: 'sync_failure',
});

export const NOTIFICATION_CHANNELS = Object.freeze({
  EMAIL: 'email',
});

export const RECIPIENT_TYPES = Object.freeze({
  ADMIN: 'admin',
  RESELLER: 'reseller',
});

const HOUR_MS = 60 * 60 * 1000;

/**
 * `windowMs` collapses repeated occurrences of the same type+resource into a
 * single notification. `null` means the resource id (or absence of one) is the
 * whole window, so distinct resources never dedupe against each other.
 */
export const NOTIFICATION_MATRIX = Object.freeze({
  [NOTIFICATION_TYPES.LOW_BALANCE]: Object.freeze({
    channels: Object.freeze([NOTIFICATION_CHANNELS.EMAIL]),
    recipients: Object.freeze([RECIPIENT_TYPES.RESELLER]),
    windowMs: 24 * HOUR_MS,
  }),
  [NOTIFICATION_TYPES.TOPUP]: Object.freeze({
    channels: Object.freeze([NOTIFICATION_CHANNELS.EMAIL]),
    recipients: Object.freeze([RECIPIENT_TYPES.RESELLER]),
    windowMs: null,
  }),
  [NOTIFICATION_TYPES.ISSUE_COMPLETED]: Object.freeze({
    channels: Object.freeze([]),
    recipients: Object.freeze([]),
    windowMs: null,
  }),
  [NOTIFICATION_TYPES.ISSUE_UNCERTAIN]: Object.freeze({
    channels: Object.freeze([NOTIFICATION_CHANNELS.EMAIL]),
    recipients: Object.freeze([RECIPIENT_TYPES.ADMIN, RECIPIENT_TYPES.RESELLER]),
    windowMs: null,
  }),
  [NOTIFICATION_TYPES.SUSPENSION]: Object.freeze({
    channels: Object.freeze([NOTIFICATION_CHANNELS.EMAIL]),
    recipients: Object.freeze([RECIPIENT_TYPES.RESELLER]),
    windowMs: null,
  }),
  [NOTIFICATION_TYPES.SYNC_FAILURE]: Object.freeze({
    channels: Object.freeze([NOTIFICATION_CHANNELS.EMAIL]),
    recipients: Object.freeze([RECIPIENT_TYPES.ADMIN]),
    windowMs: 6 * HOUR_MS,
  }),
});

export const NOTIFICATION_TYPE_LIST = Object.freeze(Object.keys(NOTIFICATION_MATRIX));

export function matrixFor(type) {
  const entry = NOTIFICATION_MATRIX[type];
  if (!entry) throw new Error(`unknown notification type ${type}`);
  return entry;
}

export function windowBucket(now, windowMs) {
  if (!windowMs || windowMs <= 0) return 'na';
  return String(Math.floor(now / windowMs));
}

/**
 * Dedupe key = type + resource + window. The physical unique index also folds
 * in recipient and channel, so a reseller still gets exactly one email row per
 * window while an email retry can never mint a second event.
 */
export function buildDedupeKey({ type, resourceType = null, resourceId = null, windowMs = null, now = Date.now() }) {
  matrixFor(type);
  return [
    type,
    resourceType ?? '-',
    resourceId != null ? String(resourceId) : '-',
    windowBucket(now, windowMs),
  ].join(':');
}

export function planNotification({ type, resourceType = null, resourceId = null, now = Date.now() }) {
  const entry = matrixFor(type);
  return {
    type,
    channels: entry.channels,
    recipientTypes: entry.recipients,
    windowMs: entry.windowMs,
    dedupeKey: buildDedupeKey({ type, resourceType, resourceId, windowMs: entry.windowMs, now }),
  };
}
