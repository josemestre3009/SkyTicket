import { createNotificationHandlers } from './notifications.js';
import { createRecoveryHandlers } from './recovery.js';
import { createSyncHandlers } from './sync.js';

export * from './notifications.js';
export * from './recovery.js';
export * from './sync.js';

/** Every handler the worker knows how to run, keyed by job type. */
export function createAllHandlers(options = {}) {
  return {
    ...createNotificationHandlers(options),
    ...createRecoveryHandlers(options),
    ...createSyncHandlers(options),
  };
}

export function registerAllHandlers(register, options = {}) {
  const handlers = createAllHandlers(options);
  for (const [type, handler] of Object.entries(handlers)) register(type, handler);
  return handlers;
}
