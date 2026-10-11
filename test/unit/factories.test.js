import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import { buildServices, createDisabledRuijieAdapter, createIssuanceAdapter } from '../../src/factories.js';

test('config: Ruijie live emission is off unless explicitly enabled', () => {
  if (!process.env.RUIJIE_LIVE_ENABLED) {
    assert.equal(config.ruijie.liveEnabled, false);
  }
  assert.equal(typeof config.reconciliation.holdGraceMs, 'number');
  assert.equal(typeof config.reconciliation.stuckOrderMs, 'number');
});

test('gated adapter: while live is off emission is rejected and no Ruijie client is built', async () => {
  const adapter = createIssuanceAdapter({ liveEnabled: false });
  await assert.rejects(() => adapter.createVouchers({}), (err) => err.code === 'ruijie_live_disabled');
  assert.equal(await adapter.isCircuitOpen({}), false);
  const connection = await adapter.resolveConnection({ site: { id: 's1' } });
  assert.equal(connection.liveEnabled, false);
});

test('gated adapter: an injected adapter is always honored (test/simulation seam)', () => {
  const injected = { marker: true };
  assert.equal(createIssuanceAdapter({ liveEnabled: true, adapter: injected }), injected);
  assert.equal(createIssuanceAdapter({ liveEnabled: false, adapter: injected }), injected);
});

test('buildServices wires the disabled adapter when the gate is off', async () => {
  const services = buildServices({ config: { ...config, ruijie: { ...config.ruijie, liveEnabled: false } } });
  assert.equal(typeof services.identity.login, 'function');
  assert.equal(typeof services.orders.createOrder, 'function');
  assert.equal(typeof services.vouchers.issue, 'function');
  assert.equal(typeof services.reconciliation.recover, 'function');
  await assert.rejects(() => services.adapter.createVouchers({}), (err) => err.code === 'ruijie_live_disabled');
});

test('disabled adapter shape matches the issuance contract', () => {
  const adapter = createDisabledRuijieAdapter();
  for (const method of ['resolveConnection', 'isCircuitOpen', 'createVouchers', 'listVouchers']) {
    assert.equal(typeof adapter[method], 'function');
  }
});
