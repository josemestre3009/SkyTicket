import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOrderTransition, ORDER_TRANSITIONS } from '../../src/modules/orders/service.js';
import { assertResellerTransition, RESELLER_TRANSITIONS } from '../../src/modules/resellers/service.js';

test('order state machine', () => {
  const allowed = [
    ['draft', 'reserved'],
    ['draft', 'canceled'],
    ['reserved', 'issuing'],
    ['reserved', 'needs_reconciliation'],
    ['issuing', 'issued'],
    ['issuing', 'partially_issued'],
    ['issuing', 'needs_reconciliation'],
    ['needs_reconciliation', 'issued'],
    ['needs_reconciliation', 'partially_issued'],
    ['partially_issued', 'needs_reconciliation'],
  ];
  for (const [from, to] of allowed) {
    assert.doesNotThrow(() => assertOrderTransition(from, to), `${from} -> ${to} should be allowed`);
  }

  const rejected = [
    ['draft', 'issued'],
    ['draft', 'issuing'],
    ['reserved', 'issued'],
    ['issued', 'reserved'],
    ['failed', 'draft'],
    ['canceled', 'reserved'],
    ['reserved', 'reserved'],
  ];
  for (const [from, to] of rejected) {
    assert.throws(
      () => assertOrderTransition(from, to),
      (err) => err.code === 'invalid_transition',
      `${from} -> ${to} should be rejected`,
    );
  }

  assert.deepEqual(ORDER_TRANSITIONS.issued, []);
  assert.deepEqual(ORDER_TRANSITIONS.failed, []);
  assert.deepEqual(ORDER_TRANSITIONS.canceled, []);
});

test('reseller state machine', () => {
  assert.doesNotThrow(() => assertResellerTransition('pending', 'active'));
  assert.doesNotThrow(() => assertResellerTransition('active', 'suspended'));
  assert.doesNotThrow(() => assertResellerTransition('suspended', 'active'));
  assert.doesNotThrow(() => assertResellerTransition('active', 'closed'));
  assert.throws(
    () => assertResellerTransition('closed', 'active'),
    (err) => err.code === 'invalid_transition',
  );
  assert.throws(
    () => assertResellerTransition('pending', 'restricted'),
    (err) => err.code === 'invalid_transition',
  );
  assert.deepEqual(RESELLER_TRANSITIONS.closed, []);
});
