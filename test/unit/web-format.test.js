import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCop,
  formatDate,
  formatDateTime,
  label,
  badgeClass,
  badgeTone,
  helpers,
} from '../../src/web/index.js';

test('formatCop renders whole COP pesos', () => {
  assert.equal(formatCop(100000), '$ 100.000');
  assert.equal(formatCop(0), '$ 0');
  assert.equal(formatCop(null), '—');
  assert.equal(formatCop('nope'), '—');
});

test('label humanizes snake_case tokens', () => {
  assert.equal(label('needs_reconciliation'), 'Needs reconciliation');
  assert.equal(label('active'), 'Active');
  assert.equal(label(''), '—');
  assert.equal(label(null), '—');
});

test('badgeClass maps statuses to tones', () => {
  assert.equal(badgeTone('active'), 'ok');
  assert.equal(badgeTone('needs_reconciliation'), 'warn');
  assert.equal(badgeTone('failed'), 'danger');
  assert.equal(badgeTone('unknown-xyz'), 'neutral');
  assert.equal(badgeClass('issued'), 'badge badge--ok');
});

test('date helpers tolerate empty and invalid values', () => {
  assert.equal(formatDate(null), '—');
  assert.equal(formatDateTime('not-a-date'), '—');
  assert.match(formatDate('2024-02-03T10:00:00Z'), /2024/);
});

test('helpers bundle exposes the formatters used by views', () => {
  assert.equal(helpers.formatCop, formatCop);
  assert.equal(typeof helpers.maskCode, 'function');
  assert.match(helpers.maskCode('ABCDEFGH'), /^\w{2}\*+\w{2}$/);
});
