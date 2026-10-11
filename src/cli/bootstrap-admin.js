import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { closePool } from '../db/index.js';
import { bootstrapAdmin } from '../modules/identity/bootstrap.js';
import { promptSecret } from './prompt.js';

function isEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

/**
 * Create the initial administrator once. Password comes from ADMIN_PASSWORD
 * or, on a TTY, a secure prompt. Re-runs are a no-op.
 */
export async function runBootstrap({
  email = config.adminEmail,
  password = process.env.ADMIN_PASSWORD,
  log = console.log,
  ...options
} = {}) {
  if (!email) throw new Error('ADMIN_EMAIL is not set');

  let secret = password;
  if (!secret) {
    if (!process.stdin.isTTY) {
      throw new Error('ADMIN_PASSWORD is not set and no TTY is available for a secure prompt');
    }
    secret = await promptSecret(`Admin password for ${email}: `);
  }

  const result = await bootstrapAdmin({ email, password: secret, ...options });
  if (result.created) {
    log(`[bootstrap] created admin ${email}`);
  } else {
    log(`[bootstrap] admin ${email} already exists; no changes`);
  }
  return result;
}

if (isEntrypoint()) {
  runBootstrap()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(`[bootstrap] failed: ${err.message}`);
      await closePool().catch(() => {});
      process.exitCode = 1;
    });
}
