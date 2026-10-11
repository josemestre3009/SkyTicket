import { config as defaultConfig } from './config.js';
import { buildGuards, buildServices } from './factories.js';

/**
 * Single composition root shared by the web and worker processes. Both derive
 * the same service graph, guards and config so there is exactly one place that
 * decides how real dependencies are wired.
 */
export function createRuntime(options = {}) {
  const cfg = options.config ?? defaultConfig;
  const services = options.services ?? buildServices({ ...options, config: cfg });
  const guards =
    options.guards ??
    buildGuards({
      services,
      config: cfg,
      cookieName: options.cookieName,
      csrfHeader: options.csrfHeader,
    });
  return { config: cfg, services, guards };
}

export default createRuntime;
