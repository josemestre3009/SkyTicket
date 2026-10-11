import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, getTestPool, prepare, close } from '../helpers/db.js';
import { Cipher } from '../../src/lib/crypto.js';
import { createIssuanceService } from '../../src/modules/issuance/service.js';
import { createReconciliationService } from '../../src/modules/reconciliation/service.js';
import { seedTenant, teardownTenant, createSimulatedAdapter, authFor, uniqueCode } from './issuance-fixtures.js';

const skip = hasDb ? false : 'TEST_DATABASE_URL is not set';

test('voucher reconciliation by UUID classifies missing, changed and external', { skip }, async (t) => {
  await prepare();
  const pool = getTestPool();
  const cipher = Cipher.fromKey('integration-encryption-key');
  const adapter = createSimulatedAdapter({ behavior: 'success' });
  const issuance = createIssuanceService({ runner: pool, adapter, cipher, rateLimit: async () => {} });
  const recon = createReconciliationService({ runner: pool });

  const fx = await seedTenant(pool, { availableMinor: 100000, unitPriceMinor: 1000 });
  const issued = await issuance.issue({
    auth: authFor(fx.user),
    siteId: fx.site.id,
    packageId: fx.pkg.id,
    quantity: 3,
    localReference: 'rec-vouchers',
  });

  const localRows = (
    await pool.query(
      'SELECT id, ruijie_uuid, normalized_status FROM vouchers WHERE order_id = $1 ORDER BY created_at, id',
      [issued.order.id],
    )
  ).rows;
  const [missingRow, changedRow, matchedRow] = localRows;

  const remoteAll = [
    { uuid: changedRow.ruijie_uuid, code: uniqueCode('r'), status: 'expired', alias: null },
    { uuid: matchedRow.ruijie_uuid, code: uniqueCode('r'), status: matchedRow.normalized_status, alias: null },
    { uuid: crypto.randomUUID().replace(/-/g, ''), code: uniqueCode('ext'), status: 'unused', alias: null },
    { uuid: crypto.randomUUID().replace(/-/g, ''), code: uniqueCode('ext'), status: 'unused', alias: null },
  ];
  const fetchPage = ({ offset, pageSize }) => ({
    list: remoteAll.slice(offset, offset + pageSize),
    count: remoteAll.length,
  });

  t.after(async () => {
    await teardownTenant(pool, fx);
    await close();
  });

  await t.test('classifies local-missing, status-change and external vouchers', async () => {
    const out = await recon.reconcileVouchers({ siteId: fx.site.id, fetchPage, pageSize: 2 });
    assert.deepEqual(out.missing, [missingRow.ruijie_uuid]);
    assert.deepEqual(out.changed, [changedRow.ruijie_uuid]);
    assert.equal(out.external.length, 2);
    assert.equal(out.scanned, 3);
    assert.equal(out.remote, 4, 'paginated fetch collected every remote voucher');
  });

  await t.test('opens deduplicated cases and never attributes external vouchers', async () => {
    const localCase = await pool.query(
      "SELECT * FROM reconciliation_cases WHERE voucher_id = $1 AND case_type = 'voucher_local_only'",
      [missingRow.id],
    );
    assert.equal(localCase.rowCount, 1);
    const changeCase = await pool.query(
      "SELECT * FROM reconciliation_cases WHERE voucher_id = $1 AND case_type = 'voucher_mismatch'",
      [changedRow.id],
    );
    assert.equal(changeCase.rowCount, 1);

    const external = await pool.query(
      "SELECT * FROM reconciliation_cases WHERE case_type = 'voucher_ruijie_only' AND site_id = $1",
      [fx.site.id],
    );
    assert.equal(external.rowCount, 2);
    assert.ok(external.rows.every((row) => row.reseller_id === null), 'no cross-tenant attribution');
    assert.ok(external.rows.every((row) => row.ruijie_evidence && row.ruijie_evidence.uuid));
  });

  await t.test('reprocessing is idempotent', async () => {
    const before = await pool.query(
      "SELECT count(*)::int AS c FROM reconciliation_cases WHERE site_id = $1 AND status <> 'resolved'",
      [fx.site.id],
    );
    await recon.reconcileVouchers({ siteId: fx.site.id, fetchPage, pageSize: 2 });
    const after = await pool.query(
      "SELECT count(*)::int AS c FROM reconciliation_cases WHERE site_id = $1 AND status <> 'resolved'",
      [fx.site.id],
    );
    assert.equal(after.rows[0].c, before.rows[0].c);
  });
});
