// test/history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/lib/history.js';

// Harness: "capture" reads a mutable value; "apply" writes it back.
function harness(cap) {
  const box = { v: 0 };
  const h = createHistory({
    capture: () => ({ v: box.v }),
    apply: async (s) => { box.v = s.v; },
    cap,
  });
  return { box, h };
}

test('record/undo/redo round-trip', async () => {
  const { box, h } = harness();
  h.seed();                     // baseline v=0
  box.v = 1; h.record();
  box.v = 2; h.record();
  assert.equal(h.canUndo(), true);
  await h.undo(); assert.equal(box.v, 1);
  await h.undo(); assert.equal(box.v, 0);
  assert.equal(h.canUndo(), false);
  await h.redo(); assert.equal(box.v, 1);
  await h.redo(); assert.equal(box.v, 2);
  assert.equal(h.canRedo(), false);
});

test('identical snapshot is not recorded', () => {
  const { h } = harness();
  h.seed();
  h.record();                   // same state as seed
  assert.equal(h.canUndo(), false);
});

test('new record clears the redo stack', async () => {
  const { box, h } = harness();
  h.seed();
  box.v = 1; h.record();
  await h.undo();
  assert.equal(h.canRedo(), true);
  box.v = 5; h.record();
  assert.equal(h.canRedo(), false);
});

test('cap drops oldest entries', async () => {
  const { box, h } = harness(3);
  h.seed();
  for (let i = 1; i <= 10; i++) { box.v = i; h.record(); }
  let undos = 0;
  while (h.canUndo()) { await h.undo(); undos++; }
  assert.equal(undos, 3);       // capped
  assert.equal(box.v, 7);       // 10 → 9 → 8 → 7
});

test('record during apply is ignored', async () => {
  const box = { v: 0 };
  let h;
  h = createHistory({
    capture: () => ({ v: box.v }),
    apply: async (s) => { box.v = s.v; h.record(); }, // replay side-effect tries to re-record
  });
  h.seed();
  box.v = 1; h.record();
  await h.undo();
  assert.equal(h.canRedo(), true);   // redo stack survived the nested record()
  await h.redo();
  assert.equal(box.v, 1);
});

test('clear empties both stacks', async () => {
  const { box, h } = harness();
  h.seed(); box.v = 1; h.record();
  h.clear();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});

test('onChange fires with the api', () => {
  const seen = [];
  const h = createHistory({ capture: () => ({}), apply: () => {}, onChange: (a) => seen.push(a.canUndo()) });
  h.seed();
  assert.equal(seen.length, 1);
});
