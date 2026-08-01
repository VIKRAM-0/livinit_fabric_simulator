import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLocalDesigns } from '../src/features/saved/migrate-local-designs.js';

const mem = new Map();
const storage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
beforeEach(() => mem.clear());

const KEY = 'livinit_sim_designs_v1:p@acme.com';
const MARK = 'livinit_sim_migrated_v1:p@acme.com';
const local = (names) => JSON.stringify(names.map((n, i) => (
  { id: 'l' + i, name: n, productKey: 'chair', thumb: null, state: { v: 1 }, createdAt: i, updatedAt: i }
)));

function apiStub({ existing = [], failOn = null, limitOn = null } = {}) {
  const saved = [];
  return {
    saved,
    list: async () => existing,
    save: async (rec) => {
      if (rec.name === failOn) { const e = new Error('net'); e.code = 'network'; throw e; }
      if (rec.name === limitOn) { const e = new Error('limit'); e.code = 'full'; throw e; }
      saved.push(rec);
      return { id: 's' + saved.length, ...rec };
    },
  };
}

test('uploads all local designs, clears key, sets marker', async () => {
  mem.set(KEY, local(['A', 'B']));
  const api = apiStub();
  const res = await migrateLocalDesigns('P@acme.com', api, storage);   // case-insensitive email
  assert.deepEqual(res, { migrated: 2, limitHit: false });
  assert.deepEqual(api.saved.map((d) => d.name), ['A', 'B']);
  assert.equal(mem.has(KEY), false);
  assert.equal(mem.get(MARK), '1');
});

test('marker short-circuits a second run', async () => {
  mem.set(MARK, '1');
  mem.set(KEY, local(['A']));
  const api = apiStub();
  const res = await migrateLocalDesigns('p@acme.com', api, storage);
  assert.equal(res.migrated, 0);
  assert.equal(api.saved.length, 0);
  assert.equal(mem.has(KEY), true);   // untouched — marker wins
});

test('network failure mid-run keeps key and no marker (retry next login)', async () => {
  mem.set(KEY, local(['A', 'B', 'C']));
  const api = apiStub({ failOn: 'B' });
  await assert.rejects(() => migrateLocalDesigns('p@acme.com', api, storage));
  assert.equal(mem.has(KEY), true);
  assert.equal(mem.has(MARK), false);
});

test('retry skips designs already on the server (name+productKey dedupe)', async () => {
  mem.set(KEY, local(['A', 'B']));
  const api = apiStub({ existing: [{ id: 's1', name: 'A', productKey: 'chair' }] });
  const res = await migrateLocalDesigns('p@acme.com', api, storage);
  assert.equal(res.migrated, 1);
  assert.deepEqual(api.saved.map((d) => d.name), ['B']);
});

test('limit stops the run but still clears and marks (leftovers can never fit)', async () => {
  mem.set(KEY, local(['A', 'B', 'C']));
  const api = apiStub({ limitOn: 'B' });
  const res = await migrateLocalDesigns('p@acme.com', api, storage);
  assert.deepEqual(res, { migrated: 1, limitHit: true });
  assert.equal(mem.has(KEY), false);
  assert.equal(mem.get(MARK), '1');
});

test('empty local list just sets the marker', async () => {
  const res = await migrateLocalDesigns('p@acme.com', apiStub(), storage);
  assert.deepEqual(res, { migrated: 0, limitHit: false });
  assert.equal(mem.get(MARK), '1');
});
