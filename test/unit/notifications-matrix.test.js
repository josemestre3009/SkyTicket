import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_MATRIX,
  planNotification,
  buildDedupeKey,
  windowBucket,
  matrixFor,
} from '../../src/modules/notifications/matrix.js';

const HOUR = 60 * 60 * 1000;

test('notification matrix matches the email-only spec', () => {
  assert.deepEqual(NOTIFICATION_MATRIX.low_balance.channels, ['email']);
  assert.deepEqual(NOTIFICATION_MATRIX.low_balance.recipients, ['reseller']);

  assert.deepEqual(NOTIFICATION_MATRIX.topup.channels, ['email']);
  assert.deepEqual(NOTIFICATION_MATRIX.topup.recipients, ['reseller']);

  assert.deepEqual(NOTIFICATION_MATRIX.issue_completed.channels, []);
  assert.deepEqual(NOTIFICATION_MATRIX.issue_completed.recipients, []);

  assert.deepEqual(NOTIFICATION_MATRIX.issue_uncertain.channels, ['email']);
  assert.deepEqual(NOTIFICATION_MATRIX.issue_uncertain.recipients, ['admin', 'reseller']);

  assert.deepEqual(NOTIFICATION_MATRIX.suspension.channels, ['email']);
  assert.deepEqual(NOTIFICATION_MATRIX.suspension.recipients, ['reseller']);

  assert.deepEqual(NOTIFICATION_MATRIX.sync_failure.channels, ['email']);
  assert.deepEqual(NOTIFICATION_MATRIX.sync_failure.recipients, ['admin']);
});

test('unknown notification types are rejected', () => {
  assert.throws(() => matrixFor('nope'), /unknown notification type/);
  assert.throws(() => planNotification({ type: 'nope' }), /unknown notification type/);
});

test('dedupe key is stable inside a window and changes across windows', () => {
  const now = 10 * HOUR; // 10h after epoch
  const first = planNotification({ type: NOTIFICATION_TYPES.LOW_BALANCE, resourceType: 'reseller', resourceId: 'r1', now });
  const sameWindow = planNotification({ type: NOTIFICATION_TYPES.LOW_BALANCE, resourceType: 'reseller', resourceId: 'r1', now: now + HOUR });
  const nextWindow = planNotification({ type: NOTIFICATION_TYPES.LOW_BALANCE, resourceType: 'reseller', resourceId: 'r1', now: now + 24 * HOUR });

  assert.equal(first.windowMs, 24 * HOUR);
  assert.equal(first.dedupeKey, sameWindow.dedupeKey);
  assert.notEqual(first.dedupeKey, nextWindow.dedupeKey);
});

test('windowless types dedupe per resource, not per clock', () => {
  const a = buildDedupeKey({ type: NOTIFICATION_TYPES.ISSUE_COMPLETED, resourceType: 'voucher_order', resourceId: 'o1', windowMs: null, now: 1 });
  const b = buildDedupeKey({ type: NOTIFICATION_TYPES.ISSUE_COMPLETED, resourceType: 'voucher_order', resourceId: 'o1', windowMs: null, now: 9e12 });
  const c = buildDedupeKey({ type: NOTIFICATION_TYPES.ISSUE_COMPLETED, resourceType: 'voucher_order', resourceId: 'o2', windowMs: null, now: 1 });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(windowBucket(123, null), 'na');
});
