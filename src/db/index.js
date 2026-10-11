import pg from 'pg';
import { requireDatabaseUrl } from '../config.js';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

/**
 * Run `fn` inside a single transaction on a dedicated connection.
 * Commits on success, rolls back on any thrown error.
 */
export async function withTransaction(fn, options = {}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    if (options.rollback) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure; original error is more relevant
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function ping() {
  await getPool().query('SELECT 1');
  return true;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
