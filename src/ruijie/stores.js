import { getPool } from '../db/index.js';

export function createMemoryTokenStore() {
  const records = new Map();
  const locks = new Map();

  function read(connectionId) {
    const record = records.get(String(connectionId));
    return record ? { ...record } : null;
  }

  function write(connectionId, record) {
    if (record === null) records.delete(String(connectionId));
    else records.set(String(connectionId), { ...record });
  }

  function withLock(connectionId, fn) {
    const key = String(connectionId);
    const previous = locks.get(key) || Promise.resolve();
    const run = previous.then(() => fn());
    locks.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  return { read, write, withLock };
}

export function createPgTokenStore(pool = getPool()) {
  async function read(connectionId, client = pool) {
    const { rows } = await client.query(
      `SELECT access_token_encrypted AS encrypted, token_expires_at AS "expiresAt", token_last_used_at AS "updatedAt"
       FROM ruijie_connections WHERE id = $1`,
      [connectionId],
    );
    const row = rows[0];
    if (!row || !row.encrypted) return null;
    return row;
  }

  async function write(connectionId, record, client = pool) {
    if (record === null) {
      await client.query(
        `UPDATE ruijie_connections
         SET access_token_encrypted = NULL, token_expires_at = NULL, token_last_used_at = now()
         WHERE id = $1`,
        [connectionId],
      );
      return;
    }
    await client.query(
      `UPDATE ruijie_connections
       SET access_token_encrypted = $2, token_expires_at = $3, token_last_used_at = now()
       WHERE id = $1`,
      [connectionId, record.encrypted, record.expiresAt],
    );
  }

  async function withLock(connectionId, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(connectionId)]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { read, write, withLock };
}

export function createMemoryCircuitStore() {
  const records = new Map();
  return {
    read(connectionId) {
      const record = records.get(String(connectionId));
      return record ? { ...record } : { state: 'closed', failures: 0, openedAt: null, halfOpenAt: null };
    },
    write(connectionId, record) {
      records.set(String(connectionId), { ...record });
    },
  };
}

export function createPgCircuitStore(pool = getPool()) {
  return {
    async read(connectionId, client = pool) {
      const { rows } = await client.query(
        `SELECT circuit_state AS state, consecutive_failures AS failures,
                circuit_opened_at AS "openedAt", circuit_half_open_at AS "halfOpenAt"
         FROM ruijie_connections WHERE id = $1`,
        [connectionId],
      );
      const row = rows[0];
      if (!row) return { state: 'closed', failures: 0, openedAt: null, halfOpenAt: null };
      return row;
    },
    async write(connectionId, record, client = pool) {
      await client.query(
        `UPDATE ruijie_connections
         SET circuit_state = $2, consecutive_failures = $3,
             circuit_opened_at = $4, circuit_half_open_at = $5
         WHERE id = $1`,
        [connectionId, record.state, record.failures, record.openedAt, record.halfOpenAt],
      );
    },
  };
}
