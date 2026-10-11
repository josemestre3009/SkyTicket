import crypto from 'node:crypto';
import {
  createReseller,
  createConnection,
  createSite,
  assignSite,
  createPackage,
  grantPackage,
  createUser,
  authFor,
  teardownReseller,
  teardownConnection,
} from './reseller-fixtures.js';
import { createCatalogService } from '../../src/modules/catalog/service.js';
import { createWalletService } from '../../src/modules/wallet/service.js';

export function uniqueCode(prefix = 'c') {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

export async function seedTenant(pool, { availableMinor = 100000, unitPriceMinor = 1000 } = {}) {
  const connection = await createConnection(pool);
  const site = await createSite(pool, connection.id);
  const reseller = await createReseller(pool);
  await assignSite(pool, reseller.id, site.id);
  const user = await createUser(pool, { role: 'reseller', resellerId: reseller.id });

  const catalog = createCatalogService({ runner: pool });
  const pkg = await createPackage(pool, site.id);
  await grantPackage(pool, reseller.id, pkg.id);
  await catalog.setPrice({ packageId: pkg.id, scope: 'base', amountMinor: unitPriceMinor });

  const wallet = createWalletService({ runner: pool });
  await wallet.ensureWallet(reseller.id);
  if (availableMinor > 0) {
    await wallet.recharge({
      resellerId: reseller.id,
      amountMinor: availableMinor,
      reason: 'seed',
      idempotencyKey: `seed-${reseller.id}`,
    });
  }

  return { connection, site, reseller, user, pkg, catalog, wallet };
}

export async function teardownTenant(pool, fixture) {
  const resellerId = fixture.reseller?.id ?? null;
  const connectionId = fixture.connection?.id ?? null;
  if (resellerId) {
    await pool.query('UPDATE voucher_orders SET hold_id = NULL WHERE reseller_id = $1', [resellerId]);
  }
  await pool.query(
    `DELETE FROM reconciliation_cases
     WHERE ($1::uuid IS NOT NULL AND reseller_id = $1)
        OR ($2::uuid IS NOT NULL AND site_id IN (SELECT id FROM sites WHERE ruijie_connection_id = $2))`,
    [resellerId, connectionId],
  );
  if (resellerId) await teardownReseller(pool, resellerId);
  if (connectionId) await teardownConnection(pool, connectionId);
}

export function makeVouchers(count, prefix = 'v') {
  return Array.from({ length: count }, () => {
    const code = uniqueCode(prefix);
    const uuid = crypto.randomUUID().replace(/-/g, '');
    return {
      uuid,
      code,
      alias: null,
      status: 'unused',
      rawStatus: '1',
      profileId: '30113648274480073538014045592098',
      expiryTime: '2121-09-01 22:48:10',
      limitClients: 3,
      raw: { codeNo: code, uuid, status: '1' },
    };
  });
}

/**
 * Injectable Ruijie simulator. Tracks calls and can emulate every safe/unsafe
 * outcome the issuance flow must classify.
 */
export function createSimulatedAdapter({ behavior = 'success', circuitOpen = false, hooks = {} } = {}) {
  const calls = [];
  let counter = 0;

  return {
    calls,
    behavior,
    setBehavior(next) {
      this.behavior = next;
    },
    async resolveConnection({ site }) {
      return { id: site?.ruijie_connection_id ?? 'sim-connection', region: 'eu', baseUrl: 'https://example.test' };
    },
    async isCircuitOpen() {
      return circuitOpen;
    },
    async createVouchers({ site, order, quantity }) {
      calls.push({ siteId: site?.id, orderId: order?.id, quantity, at: calls.length });
      if (hooks.onCreate) await hooks.onCreate({ site, order, quantity });
      const produced = Number(quantity) || 0;
      switch (this.behavior) {
        case 'success':
          return { list: makeVouchers(produced), count: produced, code: 0, raw: { code: 0, count: produced }, partial: false };
        case 'partial':
          return {
            list: makeVouchers(Math.max(0, produced - 1)),
            count: produced,
            code: 0,
            raw: { code: 0, count: produced },
            partial: true,
          };
        case 'timeout': {
          const err = new Error('Ruijie request timed out');
          err.name = 'AbortError';
          throw err;
        }
        case 'code25': {
          const err = new Error('in progress');
          err.code = 25;
          err.kind = 'recoverable';
          throw err;
        }
        case 'code7': {
          const err = new Error('timeout');
          err.code = 7;
          err.kind = 'recoverable';
          throw err;
        }
        case 'auth3': {
          const err = new Error('token invalid');
          err.code = 3;
          err.kind = 'auth';
          throw err;
        }
        case 'rejected': {
          const err = new Error('invalid parameter');
          err.code = 2;
          err.kind = 'non_recoverable';
          throw err;
        }
        case 'circuit': {
          const err = new Error('circuit open');
          err.kind = 'circuit_open';
          throw err;
        }
        default:
          throw new Error(`unknown simulator behavior: ${this.behavior}`);
      }
    },
    async listVouchers({ offset = 0, pageSize = 200 } = {}) {
      counter += 1;
      const all = makeVouchers(3, `r${counter}`);
      return { count: all.length, list: all.slice(offset, offset + pageSize), code: 0, raw: null };
    },
  };
}

export { authFor };
