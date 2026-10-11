import { Cipher } from '../../lib/crypto.js';
import { createRuijieClient } from '../../ruijie/client.js';
import * as resellerRepo from '../resellers/repository.js';
import * as catalogRepo from '../catalog/repository.js';

/**
 * Production Ruijie adapter. It is deliberately thin: the issuance service only
 * depends on the narrow contract (`resolveConnection`, `createVouchers`,
 * `listVouchers`, optional `isCircuitOpen`), so tests inject a simulator.
 */
export function createRuijieAdapter({
  connectionLoader = resellerRepo.findConnectionById,
  packageLoader = catalogRepo.findPackageById,
  cipher,
  clientFactory = createRuijieClient,
  clientOptions = {},
} = {}) {
  const clients = new Map();

  function cipherOrDefault() {
    return cipher ?? Cipher.fromConfig();
  }

  function decrypt(value) {
    return cipherOrDefault().decrypt(value);
  }

  async function resolveConnection({ site }) {
    const connectionId = site?.ruijie_connection_id ?? site?.connectionId;
    if (!connectionId) throw new Error('Site has no Ruijie connection');
    const record = await connectionLoader(connectionId);
    if (!record) throw new Error('Ruijie connection not found');
    return {
      id: record.id,
      region: record.region,
      baseUrl: record.base_url ?? record.baseUrl,
      appId: record.app_id ?? record.appId,
      appSecret: decrypt(record.app_secret_encrypted),
      apiToken: record.api_token_encrypted ? decrypt(record.api_token_encrypted) : undefined,
    };
  }

  function clientFor(connection) {
    if (!clients.has(connection.id)) {
      clients.set(
        connection.id,
        clientFactory({ connection, cipher: cipherOrDefault(), ...clientOptions }),
      );
    }
    return clients.get(connection.id);
  }

  return {
    resolveConnection,
    isCircuitOpen({ connection }) {
      return clientFor(connection).breaker.isOpen();
    },
    genericCreateVouchers({ connection, groupId, body }) {
      return clientFor(connection).createVouchers(groupId, body);
    },
    async createVouchers({ connection, site, order, quantity }) {
      const pkg = await packageLoader(order.package_id);
      if (!pkg?.ruijie_profile_id || !pkg?.ruijie_user_group_id) {
        const error = new Error('Package is missing Ruijie profile or user group');
        error.kind = 'non_recoverable';
        error.code = 'package_contract_missing';
        throw error;
      }
      return clientFor(connection).createVouchers(site.ruijieGroupId, {
        quantity: quantity ?? order.quantity,
        profile: String(pkg.ruijie_profile_id),
        userGroupId: Number(pkg.ruijie_user_group_id),
        comment: order.id,
      });
    },
    listVouchers({ connection, site, offset = 0, pageSize = 200 }) {
      return clientFor(connection).listVouchers(site.ruijieGroupId, { offset, pageSize });
    },
  };
}
