// One-time move of a user's localStorage designs to their account (spec:
// migration section). Ordering that makes it safe to retry:
//   - the local KEY is removed only after the loop finishes without a
//     network/api error — a mid-run failure keeps it, so next login retries;
//   - retries dedupe against the server by (name, productKey), so designs
//     uploaded in an earlier partial run are never duplicated;
//   - hitting the 30-limit still clears+marks: the leftovers could never
//     upload anyway, and the caller shows a toast for them.
export async function migrateLocalDesigns(email, apiStore, storage = globalThis.localStorage) {
  const norm = String(email || '').toLowerCase();
  const KEY = 'livinit_sim_designs_v1:' + norm;
  const MARK = 'livinit_sim_migrated_v1:' + norm;
  if (storage.getItem(MARK)) return { migrated: 0, limitHit: false };

  let local = [];
  try { local = JSON.parse(storage.getItem(KEY)) || []; } catch { local = []; }
  if (!local.length) {
    storage.setItem(MARK, '1');
    return { migrated: 0, limitHit: false };
  }

  const remote = await apiStore.list();   // throws on network error → nothing changed
  const seen = new Set(remote.map((d) => d.name + '|' + d.productKey));

  let migrated = 0;
  let limitHit = false;
  for (const d of local) {
    if (seen.has(d.name + '|' + d.productKey)) continue;
    try {
      await apiStore.save({ name: d.name, productKey: d.productKey, thumb: d.thumb, state: d.state });
      migrated++;
    } catch (e) {
      if (e.code === 'full') { limitHit = true; break; }
      throw e;   // network/api → keep KEY, no MARK; retried next login
    }
  }

  storage.removeItem(KEY);
  storage.setItem(MARK, '1');
  return { migrated, limitHit };
}
