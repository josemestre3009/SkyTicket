import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../../src/worker.js';
import {
  registerAllHandlers,
  createRecoveryHandlers,
  createSyncHandlers,
  ORDERS_RECOVERY_JOB_TYPE,
  WALLET_RECONCILE_JOB_TYPE,
  RUIJIE_SYNC_JOB_TYPE,
} from '../../src/worker-handlers/index.js';
import { EMAIL_DELIVERY_JOB_TYPE } from '../../src/modules/notifications/service.js';

const silent = { log() {}, warn() {}, error() {} };

function workerConfig() {
  return {
    jobs: { leaseMs: 1000, pollIntervalMs: 10 },
    worker: { maintenanceIntervalMs: 10000 },
    ruijie: { liveEnabled: false },
    mail: { from: 'no-reply@test', smtpUrl: '' },
  };
}

test('worker wiring: importing worker.js does not start a loop', () => {
  const worker = createWorker({ jobs: {}, config: workerConfig(), logger: silent });
  assert.equal(worker.handlers.size, 0);
});

test('worker wiring: registerAllHandlers wires every production job type', () => {
  const registered = new Map();
  registerAllHandlers((type, handler) => registered.set(type, handler), {
    transport: { sendMail: async () => ({}) },
    repo: {},
    reconciliation: { recover: async () => ({}) },
    wallet: { reconcile: async () => ({}) },
    liveEnabled: false,
    logger: silent,
  });

  assert.ok(registered.has(EMAIL_DELIVERY_JOB_TYPE));
  assert.ok(registered.has(ORDERS_RECOVERY_JOB_TYPE));
  assert.ok(registered.has(WALLET_RECONCILE_JOB_TYPE));
  assert.ok(registered.has(RUIJIE_SYNC_JOB_TYPE));
});

test('worker wiring: runOnce claims, dispatches and completes a job', async () => {
  const calls = { completed: [], failed: [] };
  const jobs = {
    async claim() {
      return { id: 'j1', job_type: 'test.echo', payload: { n: 1 } };
    },
    async complete(params) {
      calls.completed.push(params);
      return params;
    },
    async fail(params) {
      calls.failed.push(params);
      return params;
    },
    async recoverExpiredLeases() {
      return [];
    },
  };
  const worker = createWorker({ jobs, config: workerConfig(), logger: silent });
  worker.registerHandler('test.echo', async (job) => ({ echoed: job.payload.n }));

  assert.equal(await worker.runOnce(), true);
  assert.equal(calls.completed.length, 1);
  assert.deepEqual(calls.completed[0].result, { echoed: 1 });
  assert.equal(calls.failed.length, 0);
});

test('worker wiring: a failing handler is failed, not completed', async () => {
  const calls = { completed: [], failed: [] };
  const jobs = {
    async claim() {
      return { id: 'j2', job_type: 'test.boom', payload: {} };
    },
    async complete(params) {
      calls.completed.push(params);
      return params;
    },
    async fail(params) {
      calls.failed.push(params);
      return params;
    },
    async recoverExpiredLeases() {
      return [];
    },
  };
  const worker = createWorker({ jobs, config: workerConfig(), logger: silent });
  worker.registerHandler('test.boom', async () => {
    throw new Error('kaboom');
  });

  await worker.runOnce();
  assert.equal(calls.completed.length, 0);
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0].error, /kaboom/);
});

test('worker wiring: order recovery delegates to the reconciliation service', async () => {
  let recovered = 0;
  const handlers = createRecoveryHandlers({ reconciliation: { recover: async () => { recovered += 1; return {}; } }, logger: silent });
  await handlers[ORDERS_RECOVERY_JOB_TYPE]();
  assert.equal(recovered, 1);
});

test('worker wiring: wallet reconciliation targets the requested reseller only', async () => {
  const targets = [];
  const handlers = createRecoveryHandlers({ wallet: { reconcile: async (params) => { targets.push(params); return {}; } }, logger: silent });

  assert.deepEqual(await handlers[WALLET_RECONCILE_JOB_TYPE]({ payload: {} }), { skipped: 'no_target' });
  await handlers[WALLET_RECONCILE_JOB_TYPE]({ payload: { resellerId: 'r1' } });
  assert.deepEqual(targets, [{ resellerId: 'r1' }]);
});

test('worker wiring: maintenance enqueues order and wallet reconciliation jobs', async () => {
  const enqueued = [];
  const jobs = { async enqueue(params) { enqueued.push(params); return params; } };
  const worker = createWorker({ jobs, config: workerConfig(), logger: silent });
  await worker.scheduleMaintenance();
  const types = enqueued.map((entry) => entry.type);
  assert.ok(types.includes(ORDERS_RECOVERY_JOB_TYPE));
  assert.ok(types.includes(WALLET_RECONCILE_JOB_TYPE));
});

test('worker wiring: an untargeted wallet job runs the full sweep', async () => {
  const handlers = createRecoveryHandlers({
    wallet: { reconcile: async () => ({}), reconcileAll: async () => ({ checked: 2, mismatches: 0 }) },
    logger: silent,
  });
  assert.deepEqual(await handlers[WALLET_RECONCILE_JOB_TYPE]({ payload: {} }), { checked: 2, mismatches: 0 });
});

test('worker wiring: a sync failure alerts the admin without masking the error', async () => {
  const emitted = [];
  const on = createSyncHandlers({
    liveEnabled: true,
    syncFn: async () => { throw new Error('ruijie down'); },
    notifications: { emit: async (event) => { emitted.push(event); } },
    logger: silent,
  });
  await assert.rejects(() => on[RUIJIE_SYNC_JOB_TYPE]({ payload: { connectionId: 'c1' } }), /ruijie down/);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'sync_failure');
  assert.equal(emitted[0].resourceId, 'c1');
});

test('worker wiring: Ruijie sync never runs the routine while the gate is off', async () => {
  let synced = 0;
  const off = createSyncHandlers({ liveEnabled: false, syncFn: async () => { synced += 1; }, logger: silent });
  assert.deepEqual(await off[RUIJIE_SYNC_JOB_TYPE](), { skipped: 'ruijie_live_disabled' });
  assert.equal(synced, 0);

  const on = createSyncHandlers({ liveEnabled: true, syncFn: async () => { synced += 1; return { ok: true }; }, logger: silent });
  assert.deepEqual(await on[RUIJIE_SYNC_JOB_TYPE](), { ok: true });
  assert.equal(synced, 1);
});
