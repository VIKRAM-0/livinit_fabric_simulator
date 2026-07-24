// test/saved-store.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSavedStore, MAX_DESIGNS } from '../src/features/saved/saved-store.js';

const mem = new Map();
const storage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
beforeEach(() => mem.clear());

const STATE = { v: 1, productKey: 'chair', parts: { Seat: null }, baseColorHex: '#ffffff', sliders: {}, curtain: null };

test('save → list → get round-trip, newest first', () => {
  const s = createSavedStore('priya@acme.com', storage);
  const a = s.save({ name: 'A', productKey: 'chair', thumb: null, state: STATE });
  const b = s.save({ name: 'B', productKey: 'sofa', thumb: null, state: STATE });
  // Force distinct updatedAt ordering (same-ms saves are order-ambiguous)
  const raw = JSON.parse(storage.getItem('livinit_sim_designs_v1:priya@acme.com'));
  raw.find(d => d.id === b.id).updatedAt = raw.find(d => d.id === a.id).updatedAt + 10;
  storage.setItem('livinit_sim_designs_v1:priya@acme.com', JSON.stringify(raw));
  const list = s.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'B');
  assert.equal(s.get(a.id).name, 'A');
  assert.equal(s.get('nope'), null);
});

test('stores are isolated per user', () => {
  const s1 = createSavedStore('priya@acme.com', storage);
  const s2 = createSavedStore('dana@cove.co', storage);
  s1.save({ name: 'Mine', productKey: 'chair', thumb: null, state: STATE });
  assert.equal(s2.list().length, 0);
});

test('rename and remove', () => {
  const s = createSavedStore('priya@acme.com', storage);
  const d = s.save({ name: 'Old', productKey: 'chair', thumb: null, state: STATE });
  s.rename(d.id, 'New');
  assert.equal(s.get(d.id).name, 'New');
  s.remove(d.id);
  assert.equal(s.list().length, 0);
});

test('cap raises full', () => {
  const s = createSavedStore('priya@acme.com', storage);
  for (let i = 0; i < MAX_DESIGNS; i++) s.save({ name: 'D' + i, productKey: 'chair', thumb: null, state: STATE });
  assert.throws(() => s.save({ name: 'One more', productKey: 'chair', thumb: null, state: STATE }), e => e.code === 'full');
});

test('storage overflow raises quota', () => {
  const s = createSavedStore('priya@acme.com', {
    getItem: () => null,
    setItem: () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: () => {},
  });
  assert.throws(() => s.save({ name: 'X', productKey: 'chair', thumb: null, state: STATE }), e => e.code === 'quota');
});

test('corrupt JSON degrades to empty list', () => {
  storage.setItem('livinit_sim_designs_v1:priya@acme.com', '{nope');
  const s = createSavedStore('priya@acme.com', storage);
  assert.deepEqual(s.list(), []);
});
