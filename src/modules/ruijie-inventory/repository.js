import * as resellerRepo from '../resellers/repository.js';

/**
 * Thin persistence seam for the read-only inventory. It reuses the tenancy
 * repository so `sites` and `ruijie_connections` keep a single writer, while the
 * service stays testable by injecting an alternative `repository`.
 */
export function transaction(runner, fn) {
  return resellerRepo.transaction(runner, fn);
}

export function findSiteById(id, runner) {
  return resellerRepo.findSiteById(id, runner);
}

export function findConnectionById(id, runner) {
  return resellerRepo.findConnectionById(id, runner);
}

export function createConnection(params, runner) {
  return resellerRepo.createConnection(params, runner);
}

export function upsertSite(params, runner) {
  return resellerRepo.upsertSite(params, runner);
}

export function deactivateMissingSites(connectionId, seenGroupIds, runner) {
  return resellerRepo.deactivateMissingSites(connectionId, seenGroupIds, runner);
}
