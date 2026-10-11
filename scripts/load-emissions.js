#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import {
  PILOT_BUDGETS,
  runEmissionVolume,
  runJobConcurrency,
  runLeaseRecovery,
  assertPilotBudgets,
  cleanupEmissions,
} from '../test/load/load-harness.js';

const POSTGRES_IMAGE = process.env.LOAD_POSTGRES_IMAGE ?? 'postgres:17-alpine';
const PG_USER = 'skyticket';
const PG_PASSWORD = 'skyticket';
const PG_DB = 'skyticket_load';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTemporaryPostgres() {
  const name = `skyticket-load-db-${crypto.randomBytes(4).toString('hex')}`;
  run('docker', [
    'run', '-d', '--name', name,
    '-e', `POSTGRES_USER=${PG_USER}`,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e', `POSTGRES_DB=${PG_DB}`,
    '-p', '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);
  return name;
}

async function waitForPostgres(name) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = spawnSync(
      'docker',
      ['exec', name, 'pg_isready', '-U', PG_USER, '-d', PG_DB],
      { encoding: 'utf8' },
    );
    if (result.status === 0) return;
    await sleep(1000);
  }
  throw new Error('temporary PostgreSQL did not become ready in time');
}

function hostPort(name) {
  const binding = run('docker', ['port', name, '5432']);
  const match = binding.match(/:(\d+)\s*$/);
  if (!match) throw new Error(`could not resolve host port from "${binding}"`);
  return match[1];
}

async function stopTemporaryPostgres(name) {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
}

async function main() {
  const silent = { log() {}, warn() {} };
  let container = null;
  let connectionString = process.env.LOAD_DATABASE_URL || '';

  if (!connectionString) {
    if (spawnSync('docker', ['version'], { encoding: 'utf8' }).status !== 0) {
      throw new Error('Docker is required to spin a temporary PostgreSQL (or set LOAD_DATABASE_URL)');
    }
    container = await startTemporaryPostgres();
    console.log(`[load] temporary PostgreSQL container: ${container} (${POSTGRES_IMAGE})`);
    await waitForPostgres(container);
    connectionString = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${hostPort(container)}/${PG_DB}`;
  } else {
    console.log('[load] using LOAD_DATABASE_URL (no container)');
  }

  const pool = new pg.Pool({
    connectionString,
    max: PILOT_BUDGETS.emissions.concurrency + PILOT_BUDGETS.jobs.workers + 10,
  });

  try {
    console.log('[load] applying migrations...');
    await runMigrations({ connectionString, logger: silent });

    console.log(
      `[load] running ${PILOT_BUDGETS.emissions.count} emissions (concurrency ${PILOT_BUDGETS.emissions.concurrency}) ` +
        `with ${PILOT_BUDGETS.jobs.count} simultaneous jobs (${PILOT_BUDGETS.jobs.workers} workers)...`,
    );

    const [emissions, jobRun] = await Promise.all([
      runEmissionVolume({ pool }),
      runJobConcurrency({ pool }),
    ]);
    const lease = await runLeaseRecovery({ pool });

    const failures = assertPilotBudgets({ emissions, jobs: jobRun, lease });

    console.log('\n[load] emission metrics');
    console.log(JSON.stringify(emissions.metrics, null, 2));
    console.log('\n[load] job metrics');
    console.log(JSON.stringify(jobRun.metrics, null, 2));
    console.log('\n[load] lease recovery');
    console.log(JSON.stringify(lease, null, 2));
    console.log('\n[load] pilot budgets');
    console.log(JSON.stringify(PILOT_BUDGETS, null, 2));

    if (failures.length > 0) {
      console.error('\n[load] FAILED pilot budgets:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\n[load] PASS: no duplicates, no negative balance, no lost leases, lag within pilot budget');
    }

    await cleanupEmissions(pool, emissions.fx);
    await pool.query("DELETE FROM jobs WHERE job_type LIKE 'load.%'");
  } finally {
    await pool.end();
    if (container) {
      await stopTemporaryPostgres(container);
      console.log(`[load] removed container ${container}`);
    }
  }
}

main().catch((err) => {
  console.error(`[load] error: ${err.message}`);
  process.exitCode = 1;
});
