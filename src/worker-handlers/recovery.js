export const ORDERS_RECOVERY_JOB_TYPE = 'orders.recovery';
export const WALLET_RECONCILE_JOB_TYPE = 'wallet.reconciliation';

/**
 * Order/hold recovery and wallet projection reconciliation. Both are pure
 * delegations to the reconciliation/wallet services so the safe defaults
 * (never release balance on an uncertain emission) live in one place.
 */
export function createRecoveryHandlers({ reconciliation = null, wallet = null, logger = console } = {}) {
  async function recoverOrders() {
    if (!reconciliation?.recover) {
      logger.warn?.('[recovery] reconciliation service unavailable; skipping');
      return { skipped: 'reconciliation_unavailable' };
    }
    return reconciliation.recover({});
  }

  async function reconcileWallet(job) {
    const resellerId = job?.payload?.resellerId ?? job?.payload?.reseller_id ?? null;
    if (!wallet?.reconcile) {
      logger.warn?.('[recovery] wallet service unavailable; skipping');
      return { skipped: 'wallet_unavailable' };
    }
    // No explicit target means the periodic maintenance sweep over all wallets.
    if (!resellerId) {
      if (typeof wallet.reconcileAll === 'function') return wallet.reconcileAll();
      return { skipped: 'no_target' };
    }
    return wallet.reconcile({ resellerId });
  }

  return {
    [ORDERS_RECOVERY_JOB_TYPE]: recoverOrders,
    [WALLET_RECONCILE_JOB_TYPE]: reconcileWallet,
  };
}

export function registerRecoveryHandlers(register, options) {
  const handlers = createRecoveryHandlers(options);
  for (const [type, handler] of Object.entries(handlers)) register(type, handler);
  return handlers;
}
