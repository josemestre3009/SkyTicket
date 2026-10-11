import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { TEST_DATABASE_URL, hasDb } from '../helpers/db.js';
import {
  PILOT_BUDGETS,
  runEmissionVolume,
  runJobConcurrency,
  runLeaseRecovery,
  assertPilotBudgets,
  cleanupEmissions,
} from './load-harness.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

/**
 * Task 11.3 volume gate: more than 200 simulated daily emissions plus
 * simultaneous background jobs on a real PostgreSQL, asserting the pilot
 * invariants (no duplicates, no negative balance, no lost leases, acceptable
 * lag). Thresholds are documented in docs/performance.md and env-overridable.
 */
test('pilot volume: 200+ emissions with simultaneous jobs', { skip, timeout: 300000 }, async (t) => {
  const silent = { log() {}, warn() {} };
  await runMigrations({ connectionString: TEST_DATABASE_URL, logger: silent });

  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: PILOT_BUDGETS.emissions.concurrency + PILOT_BUDGETS.jobs.workers + 10,
  });

  let fx = null;
  let jobType = null;

  t.after(async () => {
    if (jobType) await pool.query('DELETE FROM jobs WHERE job_type = $1', [jobType]);
    await pool.query("DELETE FROM jobs WHERE job_type LIKE 'load.%'");
    if (fx) await cleanupEmissions(pool, fx);
    await pool.end();
  });

  const progress = [];
  const [emissions, jobRun] = await Promise.all([
    runEmissionVolume({ pool, onProgress: (done, total) => progress.push([done, total]) }),
    runJobConcurrency({ pool }).then((run) => {
      jobType = run.jobType;
      return run;
    }),
  ]);
  fx = emissions.fx;

  const lease = await runLeaseRecovery({ pool });

  const failures = assertPilotBudgets({ emissions, jobs: jobRun, lease });

  t.diagnostic(JSON.stringify({ emissions: emissions.metrics, jobs: jobRun.metrics, lease }, null, 2));

  assert.deepEqual(failures, [], `pilot budgets not met:\n${failures.join('\n')}`);
});
