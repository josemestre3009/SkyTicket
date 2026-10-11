export async function syncPaginated({
  fetchPage,
  persist,
  pageSize = 200,
  maxPages = Number.POSITIVE_INFINITY,
  onProgress,
} = {}) {
  if (typeof fetchPage !== 'function') throw new Error('fetchPage is required');
  let offset = 0;
  let received = 0;
  let total = null;
  let pages = 0;

  for (;;) {
    const page = await fetchPage({ offset, pageSize });
    const list = Array.isArray(page?.list) ? page.list : [];
    if (total === null && page && Number.isFinite(page.count)) total = page.count;
    if (list.length === 0) break;

    if (persist) await persist(list, { offset, page: pages });
    offset += list.length;
    received += list.length;
    pages += 1;
    if (onProgress) await onProgress({ offset, received, total, pages });

    if (total !== null && offset >= total) break;
    if (pages >= maxPages) break;
  }

  return { offset, received, total, pages, complete: total === null || offset >= total };
}

export function syncUserGroups(client, groupId, options = {}) {
  return syncPaginated({
    ...options,
    fetchPage: ({ offset, pageSize }) => client.listUserGroups(groupId, { offset, pageSize }),
  });
}

export function syncVouchers(client, groupId, options = {}) {
  return syncPaginated({
    ...options,
    fetchPage: ({ offset, pageSize }) => client.listVouchers(groupId, { offset, pageSize }),
  });
}

export function createPackageUpserter(pool) {
  return async function upsertPackages(siteId, groups) {
    let upserted = 0;
    for (const group of groups) {
      await pool.query(
        `INSERT INTO packages
           (site_id, ruijie_user_group_id, ruijie_profile_id, name, duration, quota,
            up_speed, down_speed, bind_mac, raw_json, status, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',now())
         ON CONFLICT (site_id, ruijie_user_group_id) DO UPDATE SET
           ruijie_profile_id = EXCLUDED.ruijie_profile_id,
           name = EXCLUDED.name,
           duration = EXCLUDED.duration,
           quota = EXCLUDED.quota,
           up_speed = EXCLUDED.up_speed,
           down_speed = EXCLUDED.down_speed,
           bind_mac = EXCLUDED.bind_mac,
           raw_json = EXCLUDED.raw_json,
           status = 'active',
           last_synced_at = now()`,
        [
          siteId,
          group.userGroupId,
          group.profileId,
          group.name,
          group.timePeriod,
          group.quota,
          group.uploadRateLimit,
          group.downloadRateLimit,
          group.bindMac === 1 || group.bindMac === '1',
          group.raw ? JSON.stringify(group.raw) : null,
        ],
      );
      upserted += 1;
    }
    return { upserted };
  };
}
