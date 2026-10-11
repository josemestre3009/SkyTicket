import crypto from 'node:crypto';
import { Cipher } from '../../src/lib/crypto.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createWalletService } from '../../src/modules/wallet/service.js';
import * as jobs from '../../src/jobs/repository.js';
import {
  seedTenant,
  teardownTenant,
  createSimulatedAdapter,
  authFor,
} from '../integration/issuance-fixtures.js';

/**
 * Pilot service-level budgets, not hardware benchmarks. They are deliberately
 * loose and env-overridable so a slower CI host or a future real-network pilot
 * can move the bar without editing assertions. See docs/performance.md.
 */
function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const PILOT_BUDGETS = Object.freeze({
  emissions: {
    count: envInt('LOAD_EMISSIONS', 250),
    concurrency: envInt('LOAD_EMISSION_CONCURRENCY', 25),
    unitPriceMinor: envInt('LOAD_UNIT_PRICE_MINOR', 1000),
    p95Ms: envInt('LOAD_EMISSION_P95_MS', 2000),
    p99Ms: envInt('LOAD_EMISSION_P99_MS', 5000),
    maxMs: envInt('LOAD_EMISSION_MAX_MS', 15000),
    wallMs: envInt('LOAD_EMISSIONS_WALL_MS', 90000),
  },
  jobs: {
    count: envInt('LOAD_JOBS', 200),
    workers: envInt('LOAD_JOB_WORKERS', 6),
    leaseMs: envInt('LOAD_JOB_LEASE_MS', 30000),
    p95Ms: envInt('LOAD_JOB_P95_MS', 2000),
    drainMs: envInt('LOAD_JOB_DRAIN_MS', 30000),
  },
});

const LOAD_TENANT_PREFIX = 'float-v1.load.';

function nowMs() {
  return performance.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted.length ? Math.round(sorted[0]) : 0,
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    p99Ms: Math.round(percentile(sorted, 99)),
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0,
  };
}

/**
 * Fire `count` simulated emissions with bounded concurrency against the real
 * issuance/wallet/order services on a real PostgreSQL pool. Each request uses a
 * distinct local reference, so the run is reproducible and any duplicate would
 * be a genuine defect.
 */
export async function runEmissionVolume({ pool, count, concurrency, unitPriceMinor, onProgress } = {}) {
  const cfg = PILOT_BUDGETS.emissions;
  count = count ?? cfg.count;
  concurrency = concurrency ?? cfg.concurrency;
  unitPriceMinor = unitPriceMinor ?? cfg.unitPriceMinor;

  const cipher = Cipher.fromKey('skyticket-load-test-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const svc = createIssuanceService({ runner: pool, adapter, cipher, rateLimit: async () => {} });
  const wallet = createWalletService({ runner: pool });

  const fx = await seedTenant(pool, {
    availableMinor: count * unitPriceMinor + unitPriceMinor,
    unitPriceMinor,
  });

  const latencies = [];
  const outcomes = {};
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= count) return;
      const started = nowMs();
      let result;
      try {
        result = await svc.issue({
          auth: authFor(fx.user),
          siteId: fx.site.id,
          packageId: fx.pkg.id,
          quantity: 1,
          localReference: `${LOAD_TENANT_PREFIX}${fx.reseller.id}.${i}`,
        });
      } finally {
        latencies.push(nowMs() - started);
      }
      const key = result?.outcome ?? 'error';
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      onProgress?.(i + 1, count);
    }
  }

  const wallStart = nowMs();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = nowMs() - wallStart;

  const orders = await pool.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT local_reference)::int AS refs,
            count(*) FILTER (WHERE status = 'issued')::int AS issued,
            count(*) FILTER (WHERE status IN ('failed','needs_reconciliation','partially_issued'))::int AS abnormal
     FROM voucher_orders WHERE reseller_id = $1`,
    [fx.reseller.id],
  );
  const vouchers = await pool.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT ruijie_uuid)::int AS uuids,
            count(DISTINCT code_fingerprint)::int AS fingerprints
     FROM vouchers WHERE reseller_id = $1`,
    [fx.reseller.id],
  );
  const issuedEvents = await pool.query(
    `SELECT count(*)::int AS total
     FROM order_events e JOIN voucher_orders o ON o.id = e.order_id
     WHERE o.reseller_id = $1 AND e.event_type = 'issued'`,
    [fx.reseller.id],
  );
  const balance = await wallet.getBalance(fx.reseller.id);
  const projection = await pool.query(
    `SELECT COALESCE(SUM(available_delta), 0)::bigint AS available,
            COALESCE(SUM(reserved_delta), 0)::bigint AS reserved
     FROM ledger_entries WHERE reseller_id = $1`,
    [fx.reseller.id],
  );
  const integrity = await wallet.reconcile({ resellerId: fx.reseller.id });

  const latency = summarize(latencies);
  const initialAvailable = count * unitPriceMinor + unitPriceMinor;

  const metrics = {
    requested: count,
    concurrency,
    outcomes,
    wall: {
      wallMs: Math.round(wallMs),
      throughputPerSec: Number((count / (wallMs / 1000)).toFixed(2)),
    },
    latency,
    duplicates: {
      orders: orders.rows[0].total,
      distinctLocalReferences: orders.rows[0].refs,
      issuedOrders: orders.rows[0].issued,
      abnormalOrders: orders.rows[0].abnormal,
      vouchers: vouchers.rows[0].total,
      distinctVoucherUuids: vouchers.rows[0].uuids,
      distinctCodeFingerprints: vouchers.rows[0].fingerprints,
      createCalls: adapter.calls.length,
      issuedEvents: issuedEvents.rows[0].total,
    },
    balance: {
      initialAvailableMinor: initialAvailable,
      expectedAvailableMinor: initialAvailable - count * unitPriceMinor,
      availableMinor: balance.availableMinor,
      reservedMinor: balance.reservedMinor,
      ledgerAvailableMinor: Number(projection.rows[0].available),
      ledgerReservedMinor: Number(projection.rows[0].reserved),
      nonNegative: balance.availableMinor >= 0 && balance.reservedMinor >= 0,
      consistent: integrity.consistent === true,
    },
  };

  return { fx, adapter, wallet, metrics };
}

/**
 * Drain a real job queue with several concurrent workers. Every claim uses the
 * production `FOR UPDATE SKIP LOCKED` path, so a job claimed twice or a lease
 * left behind is a genuine defect, not a test artifact.
 */
export async function runJobConcurrency({ pool, count, workers, leaseMs, type } = {}) {
  const cfg = PILOT_BUDGETS.jobs;
  count = count ?? cfg.count;
  workers = workers ?? cfg.workers;
  leaseMs = leaseMs ?? cfg.leaseMs;
  const jobType = type ?? `load.jobs.${crypto.randomUUID()}`;

  for (let i = 0; i < count; i += 1) {
    await jobs.enqueue({ type: jobType, payload: { i } }, pool);
  }

  const processed = new Map();
  let duplicates = 0;
  const latencies = [];
  let stop = false;

  async function worker(id) {
    for (;;) {
      if (stop) return;
      const job = await jobs.claim({ workerId: id, types: [jobType], leaseMs }, pool);
      if (!job) {
        const pending = await pool.query(
          "SELECT count(*)::int AS c FROM jobs WHERE job_type = $1 AND status = 'pending'",
          [jobType],
        );
        if (pending.rows[0].c === 0) return;
        await sleep(5);
        continue;
      }
      if (processed.has(job.id)) duplicates += 1;
      processed.set(job.id, id);
      const started = nowMs();
      await jobs.complete({ id: job.id, workerId: id, result: { ok: true } }, pool);
      latencies.push(nowMs() - started);
    }
  }

  const wallStart = nowMs();
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(`load-worker-${i}`)));
  const wallMs = nowMs() - wallStart;
  stop = true;

  const state = await pool.query(
    `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status IN ('failed','dead'))::int AS failed,
        COALESCE(max(attempts), 0)::int AS max_attempts
     FROM jobs WHERE job_type = $1`,
    [jobType],
  );
  const row = state.rows[0];
  const latency = summarize(latencies);

  return {
    jobType,
    metrics: {
      requested: count,
      workers,
      processedOnce: processed.size,
      duplicates,
      wall: { wallMs: Math.round(wallMs), throughputPerSec: Number((count / (wallMs / 1000)).toFixed(2)) },
      latency,
      state: {
        total: row.total,
        succeeded: row.succeeded,
        running: row.running,
        pending: row.pending,
        failed: row.failed,
        maxAttempts: row.max_attempts,
      },
    },
  };
}

/**
 * Prove a crashed worker's lease is recovered (not lost): claim, abandon the
 * lease, run the recovery sweep, and confirm a live worker finishes it with the
 * attempt counter advanced instead of the job silently disappearing.
 */
export async function runLeaseRecovery({ pool, leaseMs = 200, type } = {}) {
  const jobType = type ?? `load.lease.${crypto.randomUUID()}`;
  const job = await jobs.enqueue({ type: jobType, payload: { probe: true } }, pool);
  const claimed = await jobs.claim({ workerId: 'dead-worker', types: [jobType], leaseMs }, pool);
  await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
  const recovered = await jobs.recoverExpiredLeases(pool);
  const reclaimed = await jobs.claim({ workerId: 'live-worker', types: [jobType], leaseMs }, pool);
  const completed = reclaimed
    ? await jobs.complete({ id: reclaimed.id, workerId: 'live-worker', result: { ok: true } }, pool)
    : null;
  await pool.query('DELETE FROM jobs WHERE job_type = $1', [jobType]);
  return {
    claimedBy: claimed?.locked_by ?? null,
    recovered: recovered.includes(job.id),
    attemptsAfterRecovery: reclaimed?.attempts ?? null,
    reclaimedBy: reclaimed?.locked_by ?? null,
    finalStatus: completed?.status ?? null,
  };
}

/**
 * Evaluate every pilot invariant. Returns a list of human-readable failures;
 * empty means the run met the documented budget.
 */
export function assertPilotBudgets({ emissions, jobs: jobRun, lease }) {
  const failures = [];
  const eb = PILOT_BUDGETS.emissions;
  const jb = PILOT_BUDGETS.jobs;
  const em = emissions.metrics;
  const jm = jobRun.metrics;

  if (em.duplicates.orders !== em.requested) {
    failures.push(`orders=${em.duplicates.orders} expected ${em.requested}`);
  }
  if (em.duplicates.distinctLocalReferences !== em.requested) {
    failures.push(`distinct local references=${em.duplicates.distinctLocalReferences} expected ${em.requested}`);
  }
  if (em.duplicates.issuedOrders !== em.requested) {
    failures.push(`issued orders=${em.duplicates.issuedOrders} expected ${em.requested}`);
  }
  if (em.duplicates.abnormalOrders !== 0) {
    failures.push(`abnormal orders=${em.duplicates.abnormalOrders} expected 0`);
  }
  if (em.duplicates.vouchers !== em.requested || em.duplicates.distinctVoucherUuids !== em.requested) {
    failures.push(
      `vouchers=${em.duplicates.vouchers} distinctUuids=${em.duplicates.distinctVoucherUuids} expected ${em.requested}`,
    );
  }
  if (em.duplicates.createCalls !== em.requested) {
    failures.push(`Ruijie create calls=${em.duplicates.createCalls} expected ${em.requested} (no double-create)`);
  }
  if (em.duplicates.issuedEvents !== em.requested) {
    failures.push(`issued events=${em.duplicates.issuedEvents} expected ${em.requested}`);
  }

  const b = em.balance;
  if (b.availableMinor !== b.expectedAvailableMinor) {
    failures.push(`available=${b.availableMinor} expected ${b.expectedAvailableMinor}`);
  }
  if (b.reservedMinor !== 0) failures.push(`reserved=${b.reservedMinor} expected 0`);
  if (!b.nonNegative) failures.push('negative balance detected');
  if (b.ledgerAvailableMinor !== b.availableMinor || b.ledgerReservedMinor !== b.reservedMinor) {
    failures.push('ledger projection mismatch');
  }
  if (!b.consistent) failures.push('wallet reconciliation not consistent');

  if (em.latency.p95Ms > eb.p95Ms) failures.push(`emission p95 ${em.latency.p95Ms}ms > ${eb.p95Ms}ms`);
  if (em.latency.p99Ms > eb.p99Ms) failures.push(`emission p99 ${em.latency.p99Ms}ms > ${eb.p99Ms}ms`);
  if (em.latency.maxMs > eb.maxMs) failures.push(`emission max ${em.latency.maxMs}ms > ${eb.maxMs}ms`);
  if (em.wall.wallMs > eb.wallMs) failures.push(`emissions wall ${em.wall.wallMs}ms > ${eb.wallMs}ms`);

  if (jm.processedOnce !== jm.requested) failures.push(`jobs processed once=${jm.processedOnce} expected ${jm.requested}`);
  if (jm.duplicates !== 0) failures.push(`jobs executed twice=${jm.duplicates} expected 0`);
  if (jm.state.succeeded !== jm.requested) failures.push(`jobs succeeded=${jm.state.succeeded} expected ${jm.requested}`);
  if (jm.state.running !== 0) failures.push(`jobs left running=${jm.state.running} (lost lease)`);
  if (jm.state.pending !== 0) failures.push(`jobs left pending=${jm.state.pending}`);
  if (jm.state.failed !== 0) failures.push(`jobs failed/dead=${jm.state.failed}`);
  if (jm.state.maxAttempts !== 1) failures.push(`jobs maxAttempts=${jm.state.maxAttempts} expected 1 (lease not lost)`);
  if (jm.latency.p95Ms > jb.p95Ms) failures.push(`job p95 ${jm.latency.p95Ms}ms > ${jb.p95Ms}ms`);
  if (jm.wall.wallMs > jb.drainMs) failures.push(`job drain ${jm.wall.wallMs}ms > ${jb.drainMs}ms`);

  if (!lease.recovered) failures.push('expired lease was not recovered');
  if (lease.attemptsAfterRecovery !== 2) failures.push(`lease attempts=${lease.attemptsAfterRecovery} expected 2`);
  if (lease.finalStatus !== 'succeeded') failures.push(`lease final status=${lease.finalStatus} expected succeeded`);

  return failures;
}

export async function cleanupEmissions(pool, fx) {
  await teardownTenant(pool, fx);
}
