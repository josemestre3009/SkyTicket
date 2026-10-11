import { NOTIFICATION_TYPES } from '../modules/notifications/matrix.js';

export const RUIJIE_SYNC_JOB_TYPE = 'ruijie.sync';

/**
 * Ruijie catalog/voucher sync entrypoint. While `RUIJIE_LIVE_ENABLED` is off
 * the handler is a no-op that never reaches the network; the sync routine is
 * injected once the sandbox checklist is approved. A failed run alerts the
 * Administrador without masking the original error.
 */
export function createSyncHandlers({ liveEnabled = false, syncFn = null, notifications = null, logger = console } = {}) {
  async function syncRuijie(job) {
    if (!liveEnabled) return { skipped: 'ruijie_live_disabled' };
    if (typeof syncFn !== 'function') {
      logger.warn?.('[sync] RUIJIE_LIVE_ENABLED is on but no sync routine is configured');
      return { skipped: 'sync_not_configured' };
    }
    try {
      return await syncFn();
    } catch (err) {
      if (notifications?.emit) {
        try {
          const resourceId = job?.payload?.connectionId ?? job?.payload?.ruijieConnectionId ?? null;
          await notifications.emit({
            type: NOTIFICATION_TYPES.SYNC_FAILURE,
            resourceType: 'ruijie_connection',
            resourceId,
            title: 'Fallo de sincronizacion',
            body: err.message ? String(err.message).slice(0, 500) : 'La sincronizacion fallo.',
          });
        } catch (notifyErr) {
          logger.warn?.(`[sync] failed to emit sync_failure notification: ${notifyErr.message}`);
        }
      }
      throw err;
    }
  }

  return { [RUIJIE_SYNC_JOB_TYPE]: syncRuijie };
}

export function registerSyncHandlers(register, options) {
  const handlers = createSyncHandlers(options);
  for (const [type, handler] of Object.entries(handlers)) register(type, handler);
  return handlers;
}
