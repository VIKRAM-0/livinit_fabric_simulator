import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiSavedStore } from '../src/features/saved/saved-store-api.js';

const ROW = {
  id: 'd1', name: 'A', product_key: 'chair', thumb: null,
  state: { v: 1 }, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

function fetchStub(plan) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = plan.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status < 400, status: next.status,
      json: async () => next.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('list maps snake_case rows to camelCase records', async () => {
  const f = fetchStub([{ status: 200, body: [ROW] }]);
  const s = createApiSavedStore('tok', f);
  const list = await s.list();
  assert.equal(list[0].productKey, 'chair');
  assert.equal(typeof list[0].updatedAt, 'number');
  assert.match(f.calls[0].url, /\/simulator\/designs$/);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('save posts snake_case body and returns mapped record', async () => {
  const f = fetchStub([{ status: 201, body: ROW }]);
  const s = createApiSavedStore('tok', f);
  const rec = await s.save({ name: 'A', productKey: 'chair', thumb: null, state: { v: 1 } });
  assert.equal(rec.id, 'd1');
  assert.equal(JSON.parse(f.calls[0].init.body).product_key, 'chair');
});

test('409 becomes code full', async () => {
  const f = fetchStub([{ status: 409, body: { detail: 'limit' } }]);
  const s = createApiSavedStore('tok', f);
  await assert.rejects(() => s.save({ name: 'A', productKey: 'chair', thumb: null, state: {} }),
    (e) => e.code === 'full');
});

test('fetch throw becomes code network', async () => {
  const f = fetchStub([new Error('offline')]);
  const s = createApiSavedStore('tok', f);
  await assert.rejects(() => s.list(), (e) => e.code === 'network');
});

test('get serves from last list, refetching once on miss', async () => {
  const f = fetchStub([{ status: 200, body: [ROW] }, { status: 200, body: [ROW] }]);
  const s = createApiSavedStore('tok', f);
  await s.list();
  assert.equal((await s.get('d1')).name, 'A');
  assert.equal(f.calls.length, 1);           // cache hit, no refetch
  assert.equal(await s.get('nope'), null);   // miss → one refetch
  assert.equal(f.calls.length, 2);
});

test('remove issues DELETE and drops from cache', async () => {
  const f = fetchStub([
    { status: 200, body: [ROW] },   // list
    { status: 204, body: null },    // delete
    { status: 200, body: [] },      // get('d1') cache-misses → one refetch
  ]);
  const s = createApiSavedStore('tok', f);
  await s.list();
  await s.remove('d1');
  assert.equal(f.calls[1].init.method, 'DELETE');
  assert.equal(await s.get('d1'), null);
  assert.equal(f.calls.length, 3);
});
