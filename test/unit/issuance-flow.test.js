import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCreateError,
  isTerminalOrderState,
  toVoucherDto,
  ISSUE_OUTCOME,
} from '../../src/modules/issuance/service.js';

test('issuance failure classification never confirms ambiguous outcomes', async (t) => {
  await t.test('timeout and Ruijie codes 3/4/7/25 require reconciliation', () => {
    for (const code of [3, 4, 7, 25]) {
      const out = classifyCreateError({ code, kind: 'auth' });
      assert.equal(out.outcome, 'needs_reconciliation');
      assert.equal(out.reason, `ruijie_code_${code}`);
    }
    const timeout = new Error('boom');
    timeout.name = 'AbortError';
    assert.equal(classifyCreateError(timeout).outcome, 'needs_reconciliation');
    assert.equal(classifyCreateError({ kind: 'network' }).outcome, 'needs_reconciliation');
    assert.equal(classifyCreateError({ kind: 'recoverable' }).outcome, 'needs_reconciliation');
    assert.equal(classifyCreateError({ needsReconciliation: true }).outcome, 'needs_reconciliation');
  });

  await t.test('explicit rejection and open circuit are confirmed failures', () => {
    assert.deepEqual(classifyCreateError({ kind: 'non_recoverable', code: 'ruijie_live_disabled' }), {
      outcome: 'failed',
      reason: 'emission_disabled',
    });
    assert.deepEqual(classifyCreateError({ kind: 'non_recoverable', code: 2 }), {
      outcome: 'failed',
      reason: 'ruijie_rejected',
    });
    assert.deepEqual(classifyCreateError({ kind: 'circuit_open' }), {
      outcome: 'failed',
      reason: 'circuit_open',
    });
  });

  await t.test('unknown errors default to reconciliation', () => {
    assert.equal(classifyCreateError(null).outcome, 'needs_reconciliation');
    assert.equal(classifyCreateError(new Error('weird')).outcome, 'needs_reconciliation');
  });

  await t.test('outcome constants are stable', () => {
    assert.equal(ISSUE_OUTCOME.ISSUED, 'issued');
    assert.equal(ISSUE_OUTCOME.NEEDS_RECONCILIATION, 'needs_reconciliation');
  });
});

test('terminal order states replay without re-issuing', () => {
  for (const state of ['issuing', 'issued', 'partially_issued', 'needs_reconciliation', 'failed', 'canceled']) {
    assert.equal(isTerminalOrderState(state), true, `${state} is terminal`);
  }
  for (const state of ['draft', 'reserved']) {
    assert.equal(isTerminalOrderState(state), false, `${state} is not terminal`);
  }
});

test('voucher DTO never exposes the encrypted code', () => {
  const dto = toVoucherDto({
    id: 'v1',
    order_id: 'o1',
    ruijie_uuid: 'uuid-1',
    code_masked: 'ab****yz',
    code_encrypted: 'SECRET',
    alias: 'room',
    normalized_status: 'issued',
    raw_status: '1',
    created_at: new Date(),
  });
  assert.equal(dto.codeMasked, 'ab****yz');
  assert.equal('code' in dto, false);
  assert.equal('codeEncrypted' in dto, false);
  assert.equal(JSON.stringify(dto).includes('SECRET'), false);
});
