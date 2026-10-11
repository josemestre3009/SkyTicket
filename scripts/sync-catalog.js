#!/usr/bin/env node
// Read-only catalog sync: discovers Ruijie sites, then their user-group
// packages, and prints a per-site summary. Secrets are never printed.
import { config } from '../src/config.js';
import { createCatalogService } from '../src/modules/catalog/service.js';
import { createRuijieInventoryService } from '../src/modules/ruijie-inventory/service.js';
import * as resellerRepo from '../src/modules/resellers/repository.js';

async function main() {
  const catalog = createCatalogService();
  const inventory = createRuijieInventoryService({ config, catalog });

  if (!inventory.isReadEnabled()) {
    console.error('Ruijie read is disabled (need RUIJIE_READ_ENABLED + RUIJIE_APP_ID/RUIJIE_APP_SECRET).');
    process.exitCode = 1;
    return;
  }

  const out = await inventory.syncCatalog({});
  console.log(`sites=${out.syncedSites} packages=${out.packageCount}`);

  for (const site of out.sites) {
    const row = await resellerRepo.findSiteById(site.siteId);
    const label = row?.name ?? site.siteId;
    const state = site.complete ? '' : ' (parcial, sin desactivar)';
    console.log(`- ${label}: ${site.received} paquetes${state}`);
    for (const pkg of site.packages ?? []) {
      console.log(`    · ${pkg.name ?? pkg.ruijie_user_group_id} [${pkg.ruijie_user_group_id}]`);
    }
  }

  if (out.errors.length) {
    console.log(`errors=${out.errors.length}`);
    for (const err of out.errors) console.log(`  ! ${err.siteId}: ${err.error}`);
  }
}

main().catch((err) => {
  console.error(`sync failed: ${err.message}`);
  process.exitCode = 1;
});
