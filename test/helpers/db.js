import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
export const hasDb = TEST_DATABASE_URL.length > 0;

const silentLogger = { log() {}, warn() {} };

let pool;

export function getTestPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  }
  return pool;
}

export async function prepare() {
  await runMigrations({ connectionString: TEST_DATABASE_URL, logger: silentLogger });
}

export async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
