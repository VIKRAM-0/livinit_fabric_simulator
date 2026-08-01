// Local persistence for saved designs (spec §4.1). Pure CRUD over an injected
// Web-Storage-shaped object — node tests pass a Map shim, the app passes
// window.localStorage. Versioned key for future migration to the backend.
export const MAX_DESIGNS = 30;

export function createSavedStore(email, storage = globalThis.localStorage) {
  const KEY = 'livinit_sim_designs_v1:' + String(email || 'anon').toLowerCase();
  const read = () => {
    try { return JSON.parse(storage.getItem(KEY)) || []; } catch { return []; }
  };
  const write = (list) => {
    try { storage.setItem(KEY, JSON.stringify(list)); }
    catch { const err = new Error('Design storage is full'); err.code = 'quota'; throw err; }
  };
  return {
    list: () => read().sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => read().find(d => d.id === id) || null,
    save({ name, productKey, thumb, state }) {
      const list = read();
      if (list.length >= MAX_DESIGNS) {
        const err = new Error('Design limit reached'); err.code = 'full'; throw err;
      }
      const now = Date.now();
      const rec = {
        id: 'd' + now.toString(36) + Math.random().toString(36).slice(2, 7),
        name, productKey, thumb, state, createdAt: now, updatedAt: now,
      };
      write([...list, rec]);
      return rec;
    },
    rename(id, name) {
      const list = read();
      const d = list.find(x => x.id === id);
      if (!d) return null;
      d.name = name; d.updatedAt = Date.now();
      write(list);
      return d;
    },
    remove(id) { write(read().filter(d => d.id !== id)); },
  };
}

// Async-shaped wrapper so saved-panel.js has ONE call convention whether the
// store is this localStorage one (demo/guest) or the API one (real sessions).
export function asAsyncStore(store) {
  return {
    list: async () => store.list(),
    get: async (id) => store.get(id),
    save: async (rec) => store.save(rec),
    rename: async (id, name) => store.rename(id, name),
    remove: async (id) => store.remove(id),
  };
}
