import { createAuthService } from './service.js';

/**
 * Idempotent admin bootstrap. Re-running with the same email reports the
 * existing admin without touching its password.
 */
export async function bootstrapAdmin({ email, password, ...options }) {
  const service = createAuthService(options);
  return service.ensureAdmin({ email, password });
}
