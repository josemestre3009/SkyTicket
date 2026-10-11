import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { closePool } from './db/index.js';
import * as defaultJobs from './jobs/repository.js';
import { createRuntime } from './bootstrap.js';
import {
  registerAllHandlers,
  ORDERS_RECOVERY_JOB_TYPE,
  WALLET_RECONCILE_JOB_TYPE,
} from './worker-handlers/index.js';

export { ORDERS_RECOVERY_JOB_TYPE, WALLET_RECONCILE_JOB_TYPE };

/**
 * PG-backed job worker. `jobs` is injectable so the dispatch loop can be
 * exercised without a database and `start()` is never called on import.
 */
export function createWorker(options = {}) {
  const jobRepo = options.jobs ?? defaultJobs;
  const cfg = options.config ?? config;
  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  const logger = options.logger ?? console;
  const handlers = new Map();

  let running = false;
  let timer = null;
  let maintenanceTimer = null;

  function registerHandler(type, handler) {
    handlers.set(type, handler);
    return handler;
  }

  async function runOnce() {
    const types = [...handlers.keys()];
    if (types.length === 0) return false;

    const job = await jobRepo.claim({ workerId, types, leaseMs: cfg.jobs.leaseMs });
    if (!job) return false;

    try {
      const handler = handlers.get(job.job_type);
      if (!handler) throw new Error(`No handler registered for job type ${job.job_type}`);
      const result = await handler(job);
      await jobRepo.complete({ id: job.id, workerId, result });
    } catch (err) {
      logger.error(`[worker] job ${job.id} (${job.job_type}) failed: ${err.message}`);
      await jobRepo.fail({ id: job.id, workerId, error: err.message });
    }
    return true;
  }

  async function tick() {
    try {
      const didWork = await runOnce();
      if (!didWork) await jobRepo.recoverExpiredLeases();
    } catch (err) {
      logger.error(`[worker] loop error: ${err.message}`);
    }
  }

  async function scheduleMaintenance() {
    try {
      await jobRepo.enqueue({ type: ORDERS_RECOVERY_JOB_TYPE, dedupeKey: ORDERS_RECOVERY_JOB_TYPE });
      // Periodic wallet projection reconciliation sweeps every wallet.
      await jobRepo.enqueue({ type: WALLET_RECONCILE_JOB_TYPE, dedupeKey: WALLET_RECONCILE_JOB_TYPE });
    } catch (err) {
      logger.error(`[worker] failed to enqueue maintenance: ${err.message}`);
    }
  }

  function start() {
    if (running) return;
    running = true;
    scheduleMaintenance();
    maintenanceTimer = setInterval(scheduleMaintenance, cfg.worker.maintenanceIntervalMs);
    loop();
  }

  async function loop() {
    if (!running) return;
    await tick();
    if (running) timer = setTimeout(loop, cfg.jobs.pollIntervalMs);
  }

  async function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    timer = null;
    maintenanceTimer = null;
  }

  return { workerId, handlers, registerHandler, runOnce, tick, scheduleMaintenance, start, stop };
}

/**
 * Wire the production worker: build the service graph once and register every
 * handler (email, recovery, wallet reconciliation, gated Ruijie sync).
 */
export function startWorker(options = {}) {
  const cfg = options.config ?? config;
  const worker = createWorker({ ...options, config: cfg });
  const runtime = options.runtime ?? createRuntime({ ...options, config: cfg });
  registerAllHandlers((type, handler) => worker.registerHandler(type, handler), {
    ...options,
    config: cfg,
    reconciliation: runtime.services.reconciliation,
    wallet: runtime.services.wallet,
    notifications: runtime.services.notifications,
    liveEnabled: cfg.ruijie?.liveEnabled,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await worker.stop();
      await closePool();
      process.exit(0);
    });
  }

  worker.start();
  console.log(
    `[worker] started as ${worker.workerId} (handlers: ${worker.handlers.size}, ruijieLive: ${Boolean(cfg.ruijie?.liveEnabled)})`,
  );
  return worker;
}

function isEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  startWorker();
}
