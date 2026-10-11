import * as repo from './repository.js';

/** MVP window: the dashboard is a fixed last-30-days view (no range picker). */
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_WINDOW_LABEL = 'Últimos 30 días';
export const CUSTOM_WINDOW_LABEL = 'Período personalizado';

function resolveWindow({ from = null, to = null } = {}, now = new Date()) {
  const toDate = to ? new Date(to) : now;
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from: fromDate, to: toDate };
}

/**
 * Financial dashboard aggregates. Defaults to the last 30 days; a caller may
 * still pass explicit bounds (used by reporting/tests). The payload contains
 * only aggregate numbers and reseller identity - never credentials or codes.
 */
export function createAdminDashboardService(options = {}) {
  const runner = options.runner;
  const now = options.now ?? (() => new Date());

  async function getSummary({ from = null, to = null } = {}, opts = {}) {
    const window = resolveWindow({ from, to }, now());
    const client = opts.runner ?? runner;
    const [summary, ranking] = await Promise.all([
      repo.collectSummary(window, client),
      repo.listResellerRanking(window, client),
    ]);
    const custom = Boolean(from || to);
    return {
      period: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        label: custom ? CUSTOM_WINDOW_LABEL : DEFAULT_WINDOW_LABEL,
      },
      ...summary,
      ranking,
    };
  }

  return { getSummary };
}
