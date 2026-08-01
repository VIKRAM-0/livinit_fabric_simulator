// Backend-backed twin of saved-store.js (same CRUD surface, async) for real
// logged-in sessions. Demo/guest sessions never touch this — they stay on the
// localStorage store. Field mapping: the API speaks snake_case rows, the app
// speaks the camelCase records the localStorage store always produced.
import { SIMULATOR_API } from '../../lib/tenant.js';

const toRec = (row) => ({
  id: row.id,
  name: row.name,
  productKey: row.product_key,
  thumb: row.thumb,
  state: row.state,
  createdAt: Date.parse(row.created_at),
  updatedAt: Date.parse(row.updated_at),
});

export function createApiSavedStore(accessToken, fetchFn = (...a) => globalThis.fetch(...a)) {
  const HEADERS = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken };
  let _cache = [];

  async function call(path, init) {
    let res;
    try {
      res = await fetchFn(SIMULATOR_API + path, init);
    } catch {
      const e = new Error('Network error'); e.code = 'network'; throw e;
    }
    if (res.status === 409) {
      const e = new Error('Design limit reached'); e.code = 'full'; throw e;
    }
    if (!res.ok) {
      const e = new Error('Request failed: ' + res.status); e.code = 'api'; throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    async list() {
      const rows = await call('/designs', { headers: HEADERS });
      _cache = (rows || []).map(toRec);
      return _cache;
    },
    async get(id) {
      const hit = _cache.find((d) => d.id === id);
      if (hit) return hit;
      await this.list();
      return _cache.find((d) => d.id === id) || null;
    },
    async save({ name, productKey, thumb, state }) {
      const row = await call('/designs', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ name, product_key: productKey, thumb, state }),
      });
      const rec = toRec(row);
      _cache = [rec, ..._cache];
      return rec;
    },
    async rename(id, name) {
      const row = await call('/designs/' + id, {
        method: 'PATCH', headers: HEADERS, body: JSON.stringify({ name }),
      });
      const rec = toRec(row);
      _cache = _cache.map((d) => (d.id === id ? { ...d, ...rec } : d));
      return rec;
    },
    async remove(id) {
      await call('/designs/' + id, { method: 'DELETE', headers: HEADERS });
      _cache = _cache.filter((d) => d.id !== id);
    },
  };
}
