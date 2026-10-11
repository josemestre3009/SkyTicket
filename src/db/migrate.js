import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const { Client } = pg;
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const ADVISORY_LOCK_ID = 918273645;

function isEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(connectionString, { retries = 20, delayMs = 1500, logger = console } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      logger.warn(`[migrate] database not ready (attempt ${attempt}/${retries}): ${err.message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function runMigrations({ connectionString = config.databaseUrl, logger = console } = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const client = await connectWithRetry(connectionString, { logger });
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version),
    );

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedCount += 1;
        logger.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
      }
    }

    if (appliedCount === 0) {
      logger.log('[migrate] database already up to date');
    }

    return { applied: appliedCount, total: files.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    await client.end();
  }
}

if (isEntrypoint()) {
  runMigrations()
    .then(({ applied }) => {
      console.log(`[migrate] done (${applied} new migration(s))`);
    })
    .catch((err) => {
      console.error(`[migrate] failed: ${err.message}`);
      process.exitCode = 1;
    });
}
