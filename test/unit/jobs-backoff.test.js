import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs } from '../../src/jobs/repository.js';

test('grows exponentially and stays within cap', () => {
  const fixed = { baseMs: 1000, capMs: 300000, jitter: () => 0.5 };
  assert.equal(backoffMs(1, fixed), 1000);
  assert.equal(backoffMs(2, fixed), 2000);
  assert.equal(backoffMs(3, fixed), 4000);
  assert.equal(backoffMs(20, fixed), 300000);
});

test('applies jitter between 0.5x and 1.5x', () => {
  const base = { baseMs: 1000, capMs: 300000 };
  const low = backoffMs(2, { ...base, jitter: () => 0 });
  const high = backoffMs(2, { ...base, jitter: () => 1 });
  assert.equal(low, 1000);
  assert.equal(high, 3000);
});

test('treats non-positive attempts as the first attempt', () => {
  const fixed = { baseMs: 1000, capMs: 300000, jitter: () => 0.5 };
  assert.equal(backoffMs(0, fixed), backoffMs(1, fixed));
});
