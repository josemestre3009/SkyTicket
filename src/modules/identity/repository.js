import { getPool } from '../../db/index.js';

function db(runner) {
  return runner || getPool();
}

export async function findUserByEmail(email, runner) {
  const { rows } = await db(runner).query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] ?? null;
}

export async function findUserById(id, runner) {
  const { rows } = await db(runner).query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function createUser(
  { email, passwordHash, role, resellerId = null, displayName = null, mustChangePassword = false },
  runner,
) {
  const { rows } = await db(runner).query(
    `INSERT INTO users (email, password_hash, role, reseller_id, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [email, passwordHash, role, resellerId, displayName, mustChangePassword],
  );
  return rows[0];
}

export async function markLogin(userId, runner) {
  await db(runner).query(
    `UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
    [userId],
  );
}

export async function getResellerStatus(resellerId, runner) {
  if (!resellerId) return null;
  const { rows } = await db(runner).query('SELECT status FROM resellers WHERE id = $1', [resellerId]);
  return rows[0]?.status ?? null;
}

export async function createSession(
  { userId, resellerId, role, tokenHash, csrfHash, ip, userAgent, expiresAt },
  runner,
) {
  const { rows } = await db(runner).query(
    `INSERT INTO sessions
       (user_id, reseller_id, role, token_hash, csrf_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, resellerId, role, tokenHash, csrfHash, ip, userAgent, expiresAt],
  );
  return rows[0];
}

export async function findSessionByTokenHash(tokenHash, runner) {
  const { rows } = await db(runner).query(
    `SELECT s.*,
            u.email AS user_email,
            u.role AS user_role,
            u.reseller_id AS user_reseller_id,
            u.status AS user_status,
            r.status AS reseller_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN resellers r ON r.id = u.reseller_id
     WHERE s.token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function touchSession(id, runner) {
  await db(runner).query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]);
}

export async function revokeSession(id, reason, runner) {
  const { rows } = await db(runner).query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [id, reason ?? null],
  );
  return rows[0] ?? null;
}

export async function revokeAllUserSessions(userId, reason, runner) {
  const { rows } = await db(runner).query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [userId, reason ?? null],
  );
  return rows.map((row) => row.id);
}
