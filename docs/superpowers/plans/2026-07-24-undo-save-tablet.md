# Undo/Redo/Reset + Local Save Design + Tablet Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undo/Redo/Reset for design edits, named local Save Design (localStorage + Saved panel), and an iPad polish pass — all driven by one serializable `DesignState`.

**Architecture:** One canonical JSON `DesignState` (product, per-part fabric refs, sliders, color, curtain) with `captureDesignState()` / `applyDesignState()` replaying through the existing apply paths. Undo/redo = snapshot stacks of DesignStates; Reset = apply factory state; Save/Load = persist the same JSON per user. Spec: `docs/superpowers/specs/2026-07-23-undo-save-tablet-design.md`.

**Tech Stack:** Vanilla ES modules + window.* shim (established convention — `src/lib` is an acyclic leaf; cross-feature calls go through `window`), Three.js r128, node:test for unit tests, puppeteer-core smoke checks (`test/serve.mjs` + system Chrome).

## Global Constraints

- Undo tracks design edits only: fabric applies, slider commits, curtain edits, reset. Product switch **clears** history. Room-mode toggle is NOT an undo step. (Spec §2)
- History cap 50, in-memory only. (Spec §3.3)
- Reset = factory finish of the **current** product; reset is itself undoable. (Spec §2)
- Saves are per-signed-in-user in localStorage, key `livinit_sim_designs_v1:<email>`, soft cap 30. (Spec §4.1)
- Designs on user-uploaded GLBs cannot be saved. (Spec §4.1)
- No browser `confirm()`/`prompt()`/`alert()` — inline dialogs only.
- Style with existing token classes/vars in `styles/app.css`; no new hand-rolled color hex (use `--md-*` / existing vars).
- Every new `.js` file follows the module conventions in `src/app/boot.js` (ES module, window shim for inline handlers).
- Commit after each task; commit messages `feat:`/`fix:`/`test:` style, **no Co-Authored-By trailer**.
- Run unit tests with `node --test test/<file>` (node ≥ 20).

---

### Task 1: History core (`src/lib/history.js`)

**Files:**
- Create: `src/lib/history.js`
- Test: `test/history.test.mjs`

**Interfaces:**
- Produces: `createHistory({ capture, apply, fingerprint?, cap?, onChange? })` returning `{ canUndo(), canRedo(), busy, seed(), clear(), record(), undo(), redo() }`. `apply` may be async; `record()` is a no-op while an `undo/redo` apply is in flight.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/history.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/history.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/history.js
// Undo/redo stacks of serializable design snapshots (spec §3.3).
// Pure factory — capture/apply/fingerprint are injected so node tests run
// without Three.js or the DOM. The app singleton is wired in src/app/boot.js.

export function createHistory({ capture, apply, fingerprint = JSON.stringify, cap = 50, onChange = () => {} }) {
  let past = [];      // oldest → newest
  let present = null; // snapshot matching what's on screen (null until seed/record)
  let future = [];    // redo stack, nearest last
  let busy = false;   // true while apply() replays — record() is a no-op

  const api = {
    get busy() { return busy; },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    // Baseline after model load / design load. Clears both stacks.
    seed() { present = capture(); past = []; future = []; onChange(api); },
    clear() { present = null; past = []; future = []; onChange(api); },
    // Call after each committed design edit.
    record() {
      if (busy) return;
      const snap = capture();
      if (present && fingerprint(snap) === fingerprint(present)) return;
      if (present) { past.push(present); if (past.length > cap) past.shift(); }
      present = snap; future = []; onChange(api);
    },
    async undo() {
      if (busy || !past.length) return;
      busy = true; onChange(api);
      try { future.push(present); present = past.pop(); await apply(present); }
      finally { busy = false; onChange(api); }
    },
    async redo() {
      if (busy || !future.length) return;
      busy = true; onChange(api);
      try { past.push(present); present = future.pop(); await apply(present); }
      finally { busy = false; onChange(api); }
    },
  };
  return api;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/history.test.mjs`
Expected: 7 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/lib/history.js test/history.test.mjs
git commit -m "feat: undo/redo history core (pure, injectable)"
```

---

### Task 2: DesignState pure helpers (`src/lib/design-state.js`)

**Files:**
- Create: `src/lib/design-state.js`
- Test: `test/design-state.test.mjs`

**Interfaces:**
- Consumes: `SLIDER_DEFAULTS`, `CURTAIN_STATE_DEFAULTS` from `src/lib/actions.js` (already exported).
- Produces (used by Tasks 3/6/7):
  - `findFabricRef(appliedName, library, customItems)` → `{kind:'custom', item}` | `{kind:'lib', name, group}` | `null`
  - `resolveFabricRef(ref, library, customItems)` → library/custom item object | `null`
  - `fingerprintDesignState(state)` → string (custom items collapsed to their name — no data-URL churn)
  - `defaultDesignState(productKey, partNames)` → DesignState with every part `null`
  - DesignState shape (spec §3.1): `{ v:1, productKey, parts:{[partName]: ref|null}, baseColorHex, sliders, curtain }`

- [ ] **Step 1: Write the failing test**

```js
// test/design-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// localStorage shim — actions.js → store.js chain is DOM-free, but keep parity
// with test/admin-store.test.mjs in case that changes.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};

const ds = await import('../src/lib/design-state.js');

const LIB = [
  { group: 'My Fabrics', vendor: 'Uploaded', items: [] },
  { group: 'Kimono', vendor: '', items: [{ name: 'Aragon', hex: '#803020', series: 'Kimono' }] },
];
const CUSTOMS = [{ name: 'Navy Linen', vendor: 'custom', series: 'My Fabrics', img: 'data:image/jpeg;base64,xx', _defaults: { diffUrl: 'data:image/jpeg;base64,xx' } }];

test('findFabricRef prefers custom items, embeds by value', () => {
  const ref = ds.findFabricRef('Navy Linen', LIB, CUSTOMS);
  assert.equal(ref.kind, 'custom');
  assert.equal(ref.item.name, 'Navy Linen');
  assert.notEqual(ref.item, CUSTOMS[0]); // copied, not aliased
});

test('findFabricRef resolves catalog items by name+group', () => {
  assert.deepEqual(ds.findFabricRef('Aragon', LIB, CUSTOMS), { kind: 'lib', name: 'Aragon', group: 'Kimono' });
  assert.equal(ds.findFabricRef('Nope', LIB, CUSTOMS), null);
});

test('resolveFabricRef round-trips both kinds', () => {
  const libRef = ds.findFabricRef('Aragon', LIB, CUSTOMS);
  assert.equal(ds.resolveFabricRef(libRef, LIB, CUSTOMS).hex, '#803020');
  const cusRef = ds.findFabricRef('Navy Linen', LIB, CUSTOMS);
  assert.equal(ds.resolveFabricRef(cusRef, LIB, []).name, 'Navy Linen'); // resolves from the embedded copy
  assert.equal(ds.resolveFabricRef({ kind: 'lib', name: 'Gone', group: 'X' }, LIB, CUSTOMS), null);
});

test('defaultDesignState nulls every part and uses factory sliders', () => {
  const s = ds.defaultDesignState('chair', ['Frame', 'Seat']);
  assert.equal(s.v, 1);
  assert.deepEqual(s.parts, { Frame: null, Seat: null });
  assert.equal(s.sliders.roughness, 0.72);
  assert.equal(s.baseColorHex, '#ffffff');
  assert.equal(s.curtain.shape, 'drape');
});

test('fingerprint ignores custom-item payload churn but sees real changes', () => {
  const a = ds.defaultDesignState('chair', ['Seat']);
  const b = ds.defaultDesignState('chair', ['Seat']);
  a.parts.Seat = { kind: 'custom', item: { ...CUSTOMS[0] } };
  b.parts.Seat = { kind: 'custom', item: { ...CUSTOMS[0], img: 'data:image/jpeg;base64,DIFFERENT' } };
  assert.equal(ds.fingerprintDesignState(a), ds.fingerprintDesignState(b)); // same name → same design
  b.parts.Seat = { kind: 'lib', name: 'Aragon', group: 'Kimono' };
  assert.notEqual(ds.fingerprintDesignState(a), ds.fingerprintDesignState(b));
  b.parts.Seat = a.parts.Seat; b.sliders = { ...b.sliders, roughness: 0.1 };
  assert.notEqual(ds.fingerprintDesignState(a), ds.fingerprintDesignState(b));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/design-state.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/design-state.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/design-state.js
// Canonical serializable design snapshot (spec §3.1) — PURE helpers only.
// Browser capture/apply live in design-state-live.js; this file must stay
// importable under node (no Three.js, no DOM) for unit tests.
import { SLIDER_DEFAULTS, CURTAIN_STATE_DEFAULTS } from './actions.js';

export const DESIGN_STATE_V = 1;

// appliedName (entry.appliedFabric.name) → FabricRef. Custom items are
// embedded by value so a saved design survives the finder item being gone.
export function findFabricRef(appliedName, library, customItems) {
  if (!appliedName) return null;
  const custom = (customItems || []).find(i => i.name === appliedName);
  if (custom) return { kind: 'custom', item: JSON.parse(JSON.stringify(custom)) };
  for (const g of library || []) {
    if ((g.items || []).some(i => i.name === appliedName)) {
      return { kind: 'lib', name: appliedName, group: g.group };
    }
  }
  return null;
}

// FabricRef → live item, or null when the catalog no longer has it.
export function resolveFabricRef(ref, library, customItems) {
  if (!ref) return null;
  if (ref.kind === 'custom') {
    return (customItems || []).find(i => i.name === ref.item.name) || ref.item;
  }
  const grp = (library || []).find(g => g.group === ref.group);
  const inGroup = grp && (grp.items || []).find(i => i.name === ref.name);
  if (inGroup) return inGroup;
  for (const g of library || []) {
    const it = (g.items || []).find(i => i.name === ref.name);
    if (it) return it;
  }
  return null;
}

// Cheap equality key. Custom items collapse to their name — a multi-hundred-KB
// data-URL must not be stringified on every record() (spec §3.3).
export function fingerprintDesignState(state) {
  if (!state) return 'null';
  const parts = Object.keys(state.parts || {}).sort().map(k => {
    const r = state.parts[k];
    return k + '=' + (r ? (r.kind === 'custom' ? 'c:' + r.item.name : 'l:' + r.name) : '-');
  }).join('|');
  return [state.productKey, parts, state.baseColorHex, JSON.stringify(state.sliders), JSON.stringify(state.curtain)].join('§');
}

export function defaultDesignState(productKey, partNames = []) {
  return {
    v: DESIGN_STATE_V,
    productKey,
    parts: Object.fromEntries(partNames.map(n => [n, null])),
    baseColorHex: '#ffffff',
    sliders: { ...SLIDER_DEFAULTS },
    curtain: { ...CURTAIN_STATE_DEFAULTS },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/design-state.test.mjs`
Expected: 5 pass, 0 fail. (If the import chain fails under node because `src/lib/catalog.js` touches the DOM at top level, stub with `globalThis.document = { getElementById: () => null }` in the test header — do NOT edit catalog.js for this.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-state.js test/design-state.test.mjs
git commit -m "feat: serializable DesignState helpers (refs, fingerprint, defaults)"
```

---

### Task 3: Capture/apply (`src/lib/design-state-live.js`) + silent applies + model-ready hooks

**Files:**
- Create: `src/lib/design-state-live.js`
- Modify: `src/features/configurator/materials.js` (applySwatchToEntries signature ~line 108; toasts at ~109, 117–119, 215, 316; record hooks after `saveMaterialSnapshot()` at ~217, ~318, ~653)
- Modify: `src/features/configurator/model.js` (model-ready hook helper; call sites: end of `processGLTF` where `_tourOnReady` fires ~line 421, and the two room-mode `_applySnapshotToModel` sites ~lines 502, 525)
- Modify: `src/features/room/room.js` (append record hook to `setCurtainShape` ~413, `setCurtainFabric` ~422, `setCurtainColor` ~434)

**Interfaces:**
- Consumes: Task 2 helpers; `E`, `markDirty`, `setSliderVal` from `engine.js`; `appStore`; `setBaseColor`, `setCurtain`, `saveCurtainState`, `addCustomFabric`, `SLIDER_DEFAULTS` from `actions.js`/`catalog.js`; `window.applySwatchToEntries`, `window.updateBrightness`, `window.applyProp`, `window.updateTexScale`, `window.updateNormScale`, `window.buildLibrary`, `window.setCurtainShape/Fabric/Color/Size` (window shim).
- Produces (used by Tasks 4/6/7):
  - `captureDesignState()` → DesignState
  - `applyDesignState(state, {silent=true})` → Promise (internally queued; concurrent calls serialize)
  - `window.__replayingDesign` — true while a replay runs; `window._historyRecord` (Task 4) checks it
  - `window._historyRecord?.()` called at every design-edit commit site
  - Model-ready hooks: persistent `window._historyOnModelReady?.()` then one-shot `window._onModelReady` (both fired whenever a product model finishes loading, in that order)
  - `applySwatchToEntries(item, targetEntries, opts?)` — new optional `{silent:true}` suppresses all its toasts

- [ ] **Step 1: Write `src/lib/design-state-live.js`**

```js
// src/lib/design-state-live.js
// Browser-side capture/replay of DesignState (spec §3.2). Reads the imperative
// Three.js side (E.meshEntries) and replays through the EXISTING apply paths so
// the scene, store, and panel UI all update the same way a user action would.
// Cross-feature calls go through window.* per the boot.js shim convention —
// src/lib must not import from src/features.
import { E, markDirty, setSliderVal, showToast } from './engine.js';
import { appStore } from './store.js';
import { setBaseColor, setCurtain, saveCurtainState, addCustomFabric, SLIDER_DEFAULTS } from './actions.js';
import { LIBRARY, CUSTOM_FABRIC_ITEMS } from './catalog.js';
import { DESIGN_STATE_V, findFabricRef, resolveFabricRef } from './design-state.js';

export { fingerprintDesignState, defaultDesignState, findFabricRef, resolveFabricRef } from './design-state.js';

export function captureDesignState() {
  const s = appStore.getState();
  const lib = LIBRARY[s.currentModelKey] || [];
  const parts = {};
  for (const e of E.meshEntries) {
    if (e._isCurtain || parts[e.name] !== undefined) continue;
    parts[e.name] = e.appliedFabric ? findFabricRef(e.appliedFabric.name, lib, CUSTOM_FABRIC_ITEMS) : null;
  }
  return {
    v: DESIGN_STATE_V,
    productKey: s.currentModelKey,
    parts,
    baseColorHex: s.baseColorHex,
    sliders: { ...s.sliders },
    curtain: { ...s.curtainState },
  };
}

// Factory finish for one part — mirrors the greyMat recipe in
// model.js processGLTF/_rebuildMeshEntries (color 0xd4d0cc, no maps).
function _restoreFactoryPart(entry) {
  const mat = entry.greyMat;
  mat.color.set(0xd4d0cc);
  mat.map = null; mat.normalMap = null; mat.roughnessMap = null; mat.aoMap = null;
  mat.roughness = 0.75; mat.metalness = 0;
  if ('sheen' in mat) mat.sheen = 0;
  mat.emissive?.set(0); mat.needsUpdate = true;
  window._commitEntryMaterial(entry, mat);
  entry.appliedFabric = null;
  delete entry.mesh.userData._fabricName;
}

let _chain = Promise.resolve();

// Serialized replay queue — rapid undo presses can't interleave (spec §3.2).
export function applyDesignState(state, opts = {}) {
  const run = () => _applyNow(state, opts).catch(e => console.error('applyDesignState:', e));
  _chain = _chain.then(run, run);
  return _chain;
}

async function _applyNow(state, { silent = true } = {}) {
  if (!state || state.productKey !== appStore.getState().currentModelKey) return false;
  window.__replayingDesign = true;
  try {
    const lib = LIBRARY[state.productKey] || [];
    // 1 · Per-part fabrics (grouped by name, mirroring groupEntriesByName)
    const groups = new Map();
    E.meshEntries.filter(e => !e._isCurtain).forEach(e => {
      if (!groups.has(e.name)) groups.set(e.name, []);
      groups.get(e.name).push(e);
    });
    let missing = false;
    for (const [name, entries] of groups) {
      const ref = state.parts[name] ?? null;
      if (!ref) { entries.forEach(_restoreFactoryPart); continue; }
      const item = resolveFabricRef(ref, lib, CUSTOM_FABRIC_ITEMS);
      if (!item) { missing = true; continue; }
      // Re-register an embedded custom fabric that no longer exists locally
      if (ref.kind === 'custom' && !CUSTOM_FABRIC_ITEMS.some(i => i.name === item.name)) {
        addCustomFabric(item);
        window.buildLibrary();
      }
      await window.applySwatchToEntries(item, entries, { silent: true });
    }
    // 2 · Global sliders + base color → parts wearing fabric.
    //     The slider appliers act on checked/pieceSelected entries, so borrow
    //     the checked flags for the duration and restore them after.
    const flags = E.meshEntries.map(e => [e, e.checked, e.pieceSelected]);
    E.meshEntries.forEach(e => { e.checked = !e._isCurtain && !!e.appliedFabric; e.pieceSelected = false; });
    setBaseColor(state.baseColorHex || '#ffffff');
    const S = { ...SLIDER_DEFAULTS, ...state.sliders };
    window.updateBrightness(+S.brightness);
    window.applyProp('roughness', +S.roughness);
    window.applyProp('metalness', +S.metalness);
    window.applyProp('sheen', +S.sheen);
    window.updateTexScale(+S.scale);
    window.updateNormScale(+S.norm);
    flags.forEach(([e, c, p]) => { e.checked = c; e.pieceSelected = p; });
    // Sync slider inputs (updateBrightness et al. update the value text only)
    setSliderVal('brightness', S.brightness); setSliderVal('brightness-r', S.brightness);
    setSliderVal('roughness', S.roughness); setSliderVal('roughness-r', S.roughness);
    setSliderVal('metalness', S.metalness); setSliderVal('sheen', S.sheen, 2);
    setSliderVal('scale', S.scale, 1); setSliderVal('scale-r', S.scale, 1);
    setSliderVal('norm', S.norm, 1);
    // 3 · Curtain — store always; live rebuild only when the room is up
    if (state.curtain) {
      setCurtain({ ...state.curtain });
      saveCurtainState();
      if (appStore.getState().roomMode && E.curtainMeshEntries.length) {
        window.setCurtainShape(state.curtain.shape);
        window.setCurtainFabric(state.curtain.fabric);
        window.setCurtainColor(state.curtain.color);
        window.setCurtainSize('width', state.curtain.widthFactor);
        window.setCurtainSize('length', state.curtain.lengthFactor);
      }
    }
    if (missing && !silent) showToast('Some fabrics in this design are no longer available');
    markDirty();
    return true;
  } finally {
    window.__replayingDesign = false;
  }
}
```

- [ ] **Step 2: Thread `opts` through `applySwatchToEntries` (materials.js ~108)**

Change the signature and the four toast sites (leave the catch-block "Failed to apply material" toast as-is — real errors must stay visible):

```js
export async function applySwatchToEntries(item, targetEntries, opts = {}) {
  if(!targetEntries || !targetEntries.length) { if(!opts.silent) showToast('Select a part →'); return; }
```

In the wood-zone rejection block (~117–119), wrap the two `showToast(...)` calls: `if(!opts.silent) showToast(...)` (keep the early `return`s).
At the two success sites (~215 `markDirty(); showToast(item.name+' applied!');` and ~316 same), change to:

```js
      markDirty(); if(!opts.silent) showToast(item.name+' applied!');
      saveMaterialSnapshot();
      window._historyRecord?.();
```

(The existing `// Auto-save material snapshot…` comment can stay.) In the seamless-texture apply (~650–654), after `saveMaterialSnapshot();` add `window._historyRecord?.();`.

- [ ] **Step 3: Model-ready hooks (model.js)**

Add a module-local helper near the top of `model.js` (below the imports):

```js
// Fired whenever a product model is ready (fresh processGLTF or cached room
// switch): history re-baselines first, then any one-shot continuation
// (e.g. Saved-panel load) runs against the settled scene.
function _modelReadyHooks() {
  window._historyOnModelReady?.();
  if (typeof window._onModelReady === 'function') {
    const f = window._onModelReady; window._onModelReady = null; f();
  }
}
```

Call it at the three ready points:
1. In `processGLTF`, immediately after the `_tourOnReady` invocation (~line 421): `_modelReadyHooks();`
2. In `switchModel`'s room-mode **cached** branch, after `markDirty();` that follows `window._applySnapshotToModel(...)` (~line 503): `_modelReadyHooks();`
3. In `switchModel`'s room-mode **loader** callback, after the same pair (~line 526): `_modelReadyHooks();`

- [ ] **Step 4: Curtain record hooks (room.js)**

Append `window._historyRecord?.();` as the last line of `setCurtainShape` (~413), `setCurtainFabric` (~422), and `setCurtainColor` (~434). (`setCurtainSize` drags are coalesced by the `change`-event delegation added in Task 4 — do not hook it here.)

- [ ] **Step 5: Syntax check + unit tests still pass**

Run: `node --check src/lib/design-state-live.js && node --check src/features/configurator/materials.js && node --check src/features/configurator/model.js && node --check src/features/room/room.js && node --test test/history.test.mjs test/design-state.test.mjs`
Expected: no syntax errors; 12 tests pass. (Browser behavior is exercised by the Task 9 smoke test.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/design-state-live.js src/features/configurator/materials.js src/features/configurator/model.js src/features/room/room.js
git commit -m "feat: DesignState capture/replay with silent applies and model-ready hooks"
```

---

### Task 4: Wire history — boot, keyboard, Undo/Redo/Reset buttons

**Files:**
- Modify: `src/app/boot.js` (history singleton + window shims + keyboard + slider `change` delegation)
- Modify: `src/features/configurator/model.js` (`switchModel` ~470: clear history)
- Modify: `src/features/configurator/viewport.js` (`handleGLBUpload` ~472: mark uploaded model)
- Modify: `index.html` (canvas-cta cluster ~line 278)
- Modify: `styles/app.css` (`.icon-pill` styles, appended near `.pill-btn` styles)

**Interfaces:**
- Consumes: Task 1 `createHistory`, Task 3 `captureDesignState`/`applyDesignState`/`fingerprintDesignState`/`defaultDesignState`, `window.__replayingDesign`.
- Produces: `window.undoDesign()`, `window.redoDesign()`, `window.resetDesign()`, `window._historyRecord()`, `window._historyClear()`, `window._historySeed()`, `window._historyOnModelReady()`; `E._uploadedModel` flag (true after a GLB upload, cleared on `switchModel`) used by Task 6; buttons `#btn-undo`, `#btn-redo`, `#btn-reset`.

- [ ] **Step 1: boot.js — create the singleton and shims**

After the existing `Object.assign(window, ...)` block, add:

```js
// ── Design history (undo/redo/reset — spec §3.3, §5) ─────────────────────
import { createHistory } from '../lib/history.js';
import { captureDesignState, applyDesignState, fingerprintDesignState, defaultDesignState } from '../lib/design-state-live.js';
```

(Move both `import` lines up to the import block at the top of the file — ES imports must be top-level.) Then, after the `Object.assign(window, ...)` call:

```js
const designHistory = createHistory({
  capture: captureDesignState,
  apply: (s) => applyDesignState(s, { silent: true }),
  fingerprint: fingerprintDesignState,
  onChange: (h) => {
    const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
    if (u) u.disabled = h.busy || !h.canUndo();
    if (r) r.disabled = h.busy || !h.canRedo();
  },
});
window._historyRecord = () => { if (!window.__replayingDesign) designHistory.record(); };
window._historyClear = () => designHistory.clear();
window._historySeed = () => designHistory.seed();
window._historyOnModelReady = () => designHistory.seed();
window.undoDesign = () => designHistory.undo();
window.redoDesign = () => designHistory.redo();
window.resetDesign = async () => {
  const names = [...new Set(E.meshEntries.filter(e => !e._isCurtain).map(e => e.name))];
  await applyDesignState(defaultDesignState(appStore.getState().currentModelKey, names), { silent: true });
  window._historyRecord();
  showToast('Design reset');
};

// Slider commits: 'change' fires on release — drags coalesce to one record.
document.addEventListener('change', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') window._historyRecord();
});
```

- [ ] **Step 2: boot.js — keyboard shortcuts**

Replace the existing Escape-only keydown listener:

```js
document.addEventListener('keydown', e => {
  if (e.key==='Escape') window.closeFabricFinder();
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); window.undoDesign(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); window.redoDesign(); }
});
```

- [ ] **Step 3: switchModel clears; uploads flagged**

In `switchModel(key)` (model.js ~470), immediately after `const prevKey = appStore.getState().currentModelKey;` add:

```js
  E._uploadedModel = false;
  window._historyClear?.();   // design-edit history never crosses products (spec §2)
```

In `handleGLBUpload(input)` (viewport.js ~472), as the first statement of the function body add:

```js
  E._uploadedModel = true;    // uploads can't be saved (spec §4.1) and reset history
  window._historyClear?.();
```

(`processGLTF` fires `_modelReadyHooks()` → fresh seed once the upload finishes loading.)

- [ ] **Step 4: index.html — the button cluster**

Inside `<div class="canvas-cta">` (~line 278), **before** the View-in-My-Room button, insert:

```html
          <div class="cta-history" role="group" aria-label="Design history">
            <button class="icon-pill" id="btn-undo" onclick="undoDesign()" disabled title="Undo (⌘Z)" aria-label="Undo">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
            </button>
            <button class="icon-pill" id="btn-redo" onclick="redoDesign()" disabled title="Redo (⇧⌘Z)" aria-label="Redo">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>
            </button>
            <button class="icon-pill" id="btn-reset" onclick="resetDesign()" title="Reset design" aria-label="Reset design">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v5h5"/></svg>
            </button>
          </div>
```

- [ ] **Step 5: app.css — icon-pill styles**

Append next to the existing `.pill-btn` rules:

```css
/* ── Canvas history cluster (undo/redo/reset — spec §5) ─────────────────── */
.cta-history{display:inline-flex;gap:6px;margin-right:4px}
.icon-pill{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:var(--r-full);border:1px solid rgb(var(--md-outline-variant));background:rgb(var(--md-surface));color:rgb(var(--md-on-surface));cursor:pointer;box-shadow:var(--elev-1);transition:opacity var(--dur-base) var(--ease-motion),background var(--dur-base) var(--ease-motion)}
.icon-pill:hover:not(:disabled){background:rgb(var(--md-surface-container))}
.icon-pill:disabled{opacity:.35;cursor:default;box-shadow:none}
```

- [ ] **Step 6: Verify in browser (manual quick pass — full automation in Task 9)**

Run: `node test/serve.mjs 8123 & open http://localhost:8123/index.html` — apply two fabrics to the chair, press ⌘Z (fabric reverts), ⇧⌘Z (returns), click Reset (grey chair, toast "Design reset"), ⌘Z after reset restores the fabric. Buttons enable/disable correctly. Kill the server after.
Expected: all four behaviors work; no console errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/boot.js src/features/configurator/model.js src/features/configurator/viewport.js index.html styles/app.css
git commit -m "feat: wire undo/redo/reset — buttons, shortcuts, history lifecycle"
```

---

### Task 5: Saved-designs store (`src/features/saved/saved-store.js`)

**Files:**
- Create: `src/features/saved/saved-store.js`
- Test: `test/saved-store.test.mjs`

**Interfaces:**
- Produces (used by Tasks 6/7): `createSavedStore(email, storage?)` → `{ list(), get(id), save({name, productKey, thumb, state}), rename(id, name), remove(id) }`; `MAX_DESIGNS = 30`. `save`/`rename` throw `Error` with `.code = 'quota'` on storage overflow; `save` throws `.code = 'full'` at the cap. `list()` is newest-first.

- [ ] **Step 1: Write the failing test**

```js
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
  b.updatedAt = a.updatedAt + 1; s.rename(b.id, 'B'); // force distinct order
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/saved-store.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// src/features/saved/saved-store.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/saved-store.test.mjs`
Expected: 6 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/features/saved/saved-store.js test/saved-store.test.mjs
git commit -m "feat: per-user saved-designs store with cap and quota handling"
```

---

### Task 6: Save flow — button, name dialog, thumbnail

**Files:**
- Create: `src/features/saved/saved-panel.js` (this task: save half), `src/features/saved/index.js`
- Modify: `src/app/boot.js` (import + shim the saved feature)
- Modify: `index.html` (Save button in canvas-cta; dialog markup)
- Modify: `styles/app.css` (dialog styles)

**Interfaces:**
- Consumes: Task 5 `createSavedStore`; Task 3 `captureDesignState`; `getSession` from `auth.js`; `E` (renderer, `_uploadedModel`), `showToast`.
- Produces: `window.openSaveDesignDialog()`, `window.confirmSaveDesign()`, `window.closeSaveDesignDialog()`; `captureThumb()` and `savedStore()` (module exports reused in Task 7); `#btn-save-design`, `#save-dialog` DOM.

- [ ] **Step 1: saved-panel.js (save half)**

```js
// src/features/saved/saved-panel.js
// Save flow + Saved panel UI (spec §4.2). List half arrives in the next task.
import { E, showToast } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { getSession } from '../../lib/auth.js';
import { captureDesignState } from '../../lib/design-state-live.js';
import { createSavedStore } from './saved-store.js';

let _store = null;
export function savedStore() {
  if (!_store) _store = createSavedStore(getSession()?.user?.email || 'anon');
  return _store;
}

// Downscaled JPEG of the current frame. The renderer is created with
// preserveDrawingBuffer:true (viewport.js initThree), so the last frame is
// always readable without forcing an extra render.
export function captureThumb() {
  const src = E.renderer && E.renderer.domElement;
  if (!src || !src.width) return null;
  const w = 240, h = Math.max(1, Math.round(w * src.height / src.width));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  try { return c.toDataURL('image/jpeg', 0.7); } catch { return null; }
}

const PRODUCT_LABELS = { chair: 'Chair', accent_chair: 'Accent Chair', sofa: 'Sofa' };

export function openSaveDesignDialog() {
  if (E._uploadedModel) { showToast('Saving works for catalog products only'); return; }
  const dlg = document.getElementById('save-dialog');
  const input = document.getElementById('save-name-input');
  const key = appStore.getState().currentModelKey;
  const d = new Date();
  input.value = (PRODUCT_LABELS[key] || key) + ' — ' + d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' });
  dlg.style.display = 'flex';
  input.focus(); input.select();
}

export function closeSaveDesignDialog() {
  document.getElementById('save-dialog').style.display = 'none';
}

export function confirmSaveDesign() {
  const name = document.getElementById('save-name-input').value.trim();
  if (!name) { document.getElementById('save-name-input').focus(); return; }
  try {
    const state = captureDesignState();
    savedStore().save({ name, productKey: state.productKey, thumb: captureThumb(), state });
    closeSaveDesignDialog();
    showToast('“' + name + '” saved');
    window.renderSavedPanel?.();   // list half (next task) refreshes if open
  } catch (e) {
    showToast(e.code === 'full' ? 'Design limit reached — delete old designs first'
      : e.code === 'quota' ? 'Storage full — delete old designs first'
      : 'Could not save design');
  }
}
```

And the barrel:

```js
// src/features/saved/index.js
export * from './saved-panel.js';
```

- [ ] **Step 2: boot.js — shim it**

Add to the import block: `import * as saved from '../features/saved/index.js';` and include `saved` in the existing `Object.assign(window, configurator, library, room, render, finder, …)` call (before the trailing object literal).

- [ ] **Step 3: index.html — Save button + dialog**

In `.canvas-cta`, after the `.cta-history` cluster (before View-in-My-Room), add:

```html
          <button class="pill-btn" id="btn-save-design" onclick="openSaveDesignDialog()" title="Save design">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            <span class="pill-label">Save</span>
          </button>
```

Before the closing `</body>` (near the other overlay divs like `#tenant-menu`), add:

```html
<div id="save-dialog" role="dialog" aria-label="Save design">
  <div class="save-dialog-card">
    <h4>Save design</h4>
    <input type="text" id="save-name-input" maxlength="60" placeholder="Design name"
           onkeydown="if(event.key==='Enter')confirmSaveDesign();if(event.key==='Escape')closeSaveDesignDialog()">
    <div class="save-dialog-actions">
      <button class="pill-btn" onclick="closeSaveDesignDialog()">Cancel</button>
      <button class="pill-btn pill-btn--primary" onclick="confirmSaveDesign()">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: app.css — dialog styles**

```css
/* ── Save-design dialog (spec §4.2) ─────────────────────────────────────── */
#save-dialog{display:none;position:fixed;inset:0;z-index:400;align-items:center;justify-content:center;background:rgb(var(--md-scrim,0 0 0)/.32)}
.save-dialog-card{width:min(92vw,360px);background:rgb(var(--md-surface));border:1px solid rgb(var(--md-outline-variant));border-radius:var(--r-lg);box-shadow:var(--elev-3);padding:20px;display:flex;flex-direction:column;gap:14px}
.save-dialog-card h4{font:var(--type-title-md,600 16px/1.3 var(--font-sans));color:rgb(var(--md-on-surface));margin:0}
.save-dialog-card input{height:42px;padding:0 12px;border:1px solid rgb(var(--md-outline-variant));border-radius:var(--r-sm);background:rgb(var(--md-surface));color:rgb(var(--md-on-surface));font:500 14px/1 var(--font-sans)}
.save-dialog-card input:focus{outline:2px solid rgb(var(--md-primary)/.6)}
.save-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
```

(If `--md-scrim` is not defined in `styles/tokens.css`, use `rgba(16,28,45,.32)` to match the existing overlay pattern in the file.)

- [ ] **Step 5: Verify**

Run: `node --check src/features/saved/saved-panel.js && node --test test/saved-store.test.mjs` then the browser pass: serve, apply a fabric, click Save → dialog with prefilled name → Save → toast; `localStorage` key `livinit_sim_designs_v1:priya@acme.com` contains one record with a `thumb` data-URL. Upload a GLB → Save shows "catalog products only" toast.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/saved src/app/boot.js index.html styles/app.css
git commit -m "feat: save design — dialog, thumbnail capture, per-user store"
```

---

### Task 7: Saved panel — list, load, rename, delete

**Files:**
- Modify: `src/features/saved/saved-panel.js` (list half)
- Modify: `index.html` (panel shell + nav wiring at ~line 229)
- Modify: `styles/app.css` (panel + card styles)

**Interfaces:**
- Consumes: Task 6 `savedStore()`; Task 3 `applyDesignState`, one-shot `window._onModelReady`, `window._historySeed`; `window.switchModel`.
- Produces: `window.toggleSavedPanel()`, `window.renderSavedPanel()`, `window.loadSavedDesign(id)`, `window.deleteSavedDesign(id)`, `window.renameSavedDesign(id)`; `#saved-panel` DOM.

- [ ] **Step 1: saved-panel.js — append the list half**

```js
// ── Saved panel (list/load/rename/delete) ─────────────────────────────────
export function toggleSavedPanel(force) {
  const p = document.getElementById('saved-panel');
  const open = force !== undefined ? force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  document.getElementById('nav-saved')?.classList.toggle('active', open);
  if (open) renderSavedPanel();
}

function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

export function renderSavedPanel() {
  const list = savedStore().list();
  const body = document.getElementById('saved-panel-body');
  if (!list.length) {
    body.innerHTML = '<div class="saved-empty">No saved designs yet.<br>Style a product, then hit <b>Save</b>.</div>';
    return;
  }
  const PRODUCT_LABELS_L = { chair: 'Chair', accent_chair: 'Accent Chair', sofa: 'Sofa' };
  body.innerHTML = list.map(d => {
    const date = new Date(d.updatedAt).toLocaleDateString('en', { day: 'numeric', month: 'short' });
    return '<div class="saved-card" data-id="' + d.id + '">'
      + (d.thumb ? '<img class="saved-thumb" src="' + d.thumb + '" alt="">' : '<div class="saved-thumb saved-thumb--ph"></div>')
      + '<div class="saved-meta">'
      +   '<div class="saved-name">' + _esc(d.name) + '</div>'
      +   '<div class="saved-sub">' + (PRODUCT_LABELS_L[d.productKey] || d.productKey) + ' · ' + date + '</div>'
      + '</div>'
      + '<div class="saved-actions">'
      +   '<button class="saved-act" onclick="loadSavedDesign(\'' + d.id + '\')" title="Load">Load</button>'
      +   '<button class="saved-act" onclick="renameSavedDesign(\'' + d.id + '\')" title="Rename">✎</button>'
      +   '<button class="saved-act saved-act--danger" onclick="deleteSavedDesign(\'' + d.id + '\')" title="Delete">✕</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

export async function loadSavedDesign(id) {
  const rec = savedStore().get(id);
  if (!rec) return;
  toggleSavedPanel(false);
  const { applyDesignState } = await import('../../lib/design-state-live.js');
  const finish = async () => {
    await applyDesignState(rec.state, { silent: false });
    window._historySeed?.();          // loaded design becomes the new baseline
    showToast('“' + rec.name + '” loaded');
  };
  if (rec.state.productKey !== appStore.getState().currentModelKey) {
    window._onModelReady = finish;    // one-shot: runs after switchModel settles
    window.switchModel(rec.state.productKey);
  } else {
    await finish();
  }
}

export function deleteSavedDesign(id) {
  const card = document.querySelector('.saved-card[data-id="' + id + '"]');
  if (card && !card.classList.contains('confirm-del')) {
    card.classList.add('confirm-del');   // first tap arms, second confirms
    setTimeout(() => card.classList.remove('confirm-del'), 2500);
    return;
  }
  savedStore().remove(id);
  renderSavedPanel();
  showToast('Design deleted');
}

export function renameSavedDesign(id) {
  const card = document.querySelector('.saved-card[data-id="' + id + '"]');
  const rec = savedStore().get(id);
  if (!card || !rec) return;
  const nameEl = card.querySelector('.saved-name');
  nameEl.innerHTML = '<input class="saved-rename-in" maxlength="60" value="' + _esc(rec.name) + '">';
  const input = nameEl.querySelector('input');
  input.focus(); input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) { try { savedStore().rename(id, v); } catch { showToast('Storage full'); } }
    renderSavedPanel();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.removeEventListener('blur', commit); renderSavedPanel(); }
  });
}
```

Add the needed static import at the top of the file: `import { appStore } from '../../lib/store.js';` is already there from Task 6 — nothing more (the `applyDesignState` dynamic import avoids widening the static graph; `switchModel` resolves off `window`).

- [ ] **Step 2: index.html — panel shell + nav item**

Change the dead nav button (~line 229) to: `onclick="toggleSavedPanel()"`.
Next to `#save-dialog`, add:

```html
<div id="saved-panel" aria-label="Saved designs">
  <div class="saved-panel-hd">
    <h4>Saved designs</h4>
    <button class="icon-pill" onclick="toggleSavedPanel(false)" aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="saved-panel-body" id="saved-panel-body"></div>
</div>
```

- [ ] **Step 3: app.css — panel styles**

```css
/* ── Saved-designs panel (spec §4.2) ────────────────────────────────────── */
#saved-panel{position:fixed;top:0;right:0;bottom:0;z-index:120;width:340px;max-width:88vw;background:rgb(var(--md-surface));border-left:1px solid rgb(var(--md-outline-variant));box-shadow:var(--elev-3);display:flex;flex-direction:column;transform:translateX(110%);transition:transform var(--dur-base) var(--ease-motion)}
#saved-panel.open{transform:none}
.saved-panel-hd{display:flex;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid rgb(var(--md-outline-variant))}
.saved-panel-hd h4{margin:0;font:var(--type-title-md,600 16px/1.3 var(--font-sans));color:rgb(var(--md-on-surface))}
.saved-panel-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.saved-empty{padding:32px 12px;text-align:center;font:500 13px/1.6 var(--font-sans);color:rgb(var(--md-on-surface-variant))}
.saved-card{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid rgb(var(--md-outline-variant));border-radius:var(--r-md);background:rgb(var(--md-surface))}
.saved-thumb{width:64px;height:48px;border-radius:var(--r-sm);object-fit:cover;background:rgb(var(--md-surface-container));flex-shrink:0}
.saved-thumb--ph{display:block}
.saved-meta{flex:1;min-width:0}
.saved-name{font:600 13px/1.3 var(--font-sans);color:rgb(var(--md-on-surface));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.saved-sub{font:500 11px/1.4 var(--font-sans);color:rgb(var(--md-on-surface-variant))}
.saved-actions{display:flex;gap:4px;flex-shrink:0}
.saved-act{height:30px;min-width:30px;padding:0 8px;border:1px solid rgb(var(--md-outline-variant));border-radius:var(--r-sm);background:rgb(var(--md-surface));color:rgb(var(--md-on-surface));font:600 12px/1 var(--font-sans);cursor:pointer}
.saved-act:hover{background:rgb(var(--md-surface-container))}
.saved-card.confirm-del .saved-act--danger{background:rgb(var(--md-error,179 38 30));color:#fff;border-color:transparent}
.saved-rename-in{width:100%;height:26px;padding:0 6px;border:1px solid rgb(var(--md-primary));border-radius:var(--r-xs);font:600 13px/1 var(--font-sans)}
```

(If `--md-error` is missing from tokens.css, reuse the error color already used by `.auth-err`.)

- [ ] **Step 4: Verify in browser**

Serve; save two designs on different products; open Saved via nav rail → both cards with thumbnails; Load the other product's design → model switches, fabrics/sliders restore, toast; rename inline; delete arms then removes; reload the page → designs persist; undo right after load does nothing (fresh baseline).
Expected: all behaviors correct; no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/saved/saved-panel.js index.html styles/app.css
git commit -m "feat: saved panel — list, load, rename, delete"
```

---

### Task 8: Tablet polish (768–1194px, coarse pointers)

**Files:**
- Modify: `styles/app.css` (breakpoint change at line 633; new blocks appended)
- Modify: `src/features/library/library.js` (swatch drag: `mousedown` → `pointerdown`, ~line 151)
- Modify: `src/features/configurator/materials.js` (`initDragDrop` ~657: `mousemove`/`mouseup` → `pointermove`/`pointerup`)

**Interfaces:**
- Consumes: existing drawer CSS (`.config-panel` slide-over) and `startDrag`/`dropFabricOnCanvas` flow.
- Produces: persistent 320px panel at 1000–1194px; drawer only <1000px; touch-friendly targets; hover-only UI suppressed on touch; working touch drag-to-apply.

- [ ] **Step 1: Breakpoint split**

In `styles/app.css` line 633 change `@media (max-width:1024px){` to `@media (max-width:999px){`. Then append:

```css
/* ── Tablet (spec §6) ───────────────────────────────────────────────────── */
/* iPad landscape (1000–1194px): keep a persistent, narrower panel — the
   slide-over drawer is for portrait/phone widths only. */
@media (min-width:1000px) and (max-width:1194px){
  .config-panel{width:320px}
}
/* Touch: no hover affordances — the zoom lens and mouse hints are dead weight. */
@media (hover:none){
  #hover-zoom-lens{display:none !important}
  .vp-controls{display:none}
}
/* Coarse pointers: 44px-class targets (WCAG 2.5.5 / Apple HIG). */
@media (pointer:coarse){
  .nav-rail-item{min-height:48px}
  .icon-pill{width:44px;height:44px}
  .canvas-cta .pill-btn{height:44px}
  .seg-chip{min-height:40px}
  .saved-act{height:38px;min-width:38px}
  .bar-sw{touch-action:none}
  input[type=range]{height:32px}
  input[type=range]::-webkit-slider-thumb{width:22px;height:22px}
}
```

- [ ] **Step 2: Pointer-events for drag-to-apply**

`src/features/library/library.js` ~151 — change:

```js
    sw.addEventListener('mousedown', e => { e.preventDefault(); window.startDrag(e, gi, ii); });
```
to:
```js
    sw.addEventListener('pointerdown', e => { e.preventDefault(); window.startDrag(e, gi, ii); });
```

`src/features/configurator/materials.js` `initDragDrop` (~657): change `document.addEventListener('mousemove', …)` to `'pointermove'` and `document.addEventListener('mouseup', …)` to `'pointerup'`. Everything inside the handlers (`clientX/clientY`) is pointer-event compatible — no other changes.

- [ ] **Step 3: Verify — viewport sweep**

Serve; in Chrome DevTools device emulation check 768×1024 (portrait: drawer + toggle FAB), 834×1194 (portrait: drawer), 1024×768 (landscape: **persistent 320px panel, no drawer**), 1180×820 (landscape: persistent panel). With touch emulation on: no hover lens; drag a swatch onto the model with touch — fabric applies. Desktop (mouse) drag still works.
Expected: all six checks pass; no horizontal scroll anywhere.

- [ ] **Step 4: Commit**

```bash
git add styles/app.css src/features/library/library.js src/features/configurator/materials.js
git commit -m "feat: tablet polish — persistent iPad-landscape panel, touch targets, pointer-event drag"
```

---

### Task 9: Automated smoke test (`test/design-check.mjs`)

**Files:**
- Create: `test/design-check.mjs`
- Modify: `package.json` (add `"test:unit"` and `"test:design"` scripts)

**Interfaces:**
- Consumes: everything above via the browser; puppeteer auto-login (`auth.js getSession` returns priya@acme.com when `navigator.webdriver`); `test/serve.mjs`.
- Produces: PASS/FAIL lines + exit code, per the `test/admin-check.mjs` pattern.

- [ ] **Step 1: Write the check script**

```js
// test/design-check.mjs
// End-to-end checks for undo/redo/reset, save/load, tablet layout.
// Usage: node test/design-check.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8126;
const BASE = `http://localhost:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn('node', [new globalThis.URL('./serve.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'ignore' });
await sleep(800);

let browser, exitCode = 1;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  // Wait for the model to load (loading overlay off) — history seeds on model ready
  await page.waitForFunction(() => document.getElementById('loading') && !document.getElementById('loading').classList.contains('on'), { timeout: 30000 });
  await sleep(1200);

  const applied = () => page.evaluate(async () => {
    // Apply the first non-custom library fabric to every part
    const { LIBRARY } = await import('/src/lib/catalog.js');
    const { E } = await import('/src/lib/engine.js');
    const key = window.appStore.getState().currentModelKey;
    const grp = LIBRARY[key].find(g => g.items.length && g.items[0].type !== 'wood');
    const targets = E.meshEntries.filter(e => !e._isCurtain);
    await window.applySwatchToEntries(grp.items[0], targets, {});
    return { name: grp.items[0].name, worn: targets.filter(e => e.appliedFabric).length };
  });

  // 1 · apply → undo → redo → reset
  const a = await applied();
  check('fabric applies to parts', a.worn > 0, `${a.worn} entries wear ${a.name}`);
  const canUndo = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo enables after apply', canUndo);
  await page.evaluate(() => window.undoDesign());
  await sleep(800);
  const afterUndo = await page.evaluate(async () => {
    const { E } = await import('/src/lib/engine.js');
    return E.meshEntries.filter(e => !e._isCurtain && e.appliedFabric).length;
  });
  check('undo removes the fabric', afterUndo === 0, `${afterUndo} still worn`);
  await page.evaluate(() => window.redoDesign());
  await sleep(800);
  const afterRedo = await page.evaluate(async () => {
    const { E } = await import('/src/lib/engine.js');
    return E.meshEntries.filter(e => !e._isCurtain && e.appliedFabric).length;
  });
  check('redo restores the fabric', afterRedo > 0);
  await page.evaluate(() => window.resetDesign());
  await sleep(800);
  const afterReset = await page.evaluate(async () => {
    const { E } = await import('/src/lib/engine.js');
    return E.meshEntries.filter(e => !e._isCurtain && e.appliedFabric).length;
  });
  check('reset returns to factory', afterReset === 0);

  // 2 · save → reload → load
  await page.evaluate(() => window.undoDesign());            // back to fabric-applied state
  await sleep(800);
  await page.evaluate(() => {
    window.openSaveDesignDialog();
    document.getElementById('save-name-input').value = 'Smoke Design';
    window.confirmSaveDesign();
  });
  const savedCount = await page.evaluate(() => JSON.parse(localStorage.getItem('livinit_sim_designs_v1:priya@acme.com') || '[]').length);
  check('design persists to localStorage', savedCount === 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading') && !document.getElementById('loading').classList.contains('on'), { timeout: 30000 });
  await sleep(1200);
  await page.evaluate(() => window.toggleSavedPanel(true));
  const cardCount = await page.evaluate(() => document.querySelectorAll('.saved-card').length);
  check('saved panel lists the design after reload', cardCount === 1);
  const recId = await page.evaluate(() => document.querySelector('.saved-card')?.dataset.id);
  await page.evaluate(id => window.loadSavedDesign(id), recId);
  await sleep(2500);
  const afterLoad = await page.evaluate(async () => {
    const { E } = await import('/src/lib/engine.js');
    return E.meshEntries.filter(e => !e._isCurtain && e.appliedFabric).length;
  });
  check('loading the design re-applies fabrics', afterLoad > 0);

  // 3 · tablet layout sweep
  for (const [w, h, drawer] of [[768, 1024, true], [834, 1194, true], [1024, 768, false], [1180, 820, false]]) {
    await page.setViewport({ width: w, height: h });
    await sleep(400);
    const r = await page.evaluate(() => {
      const p = document.querySelector('.config-panel');
      const cs = getComputedStyle(p);
      return { fixed: cs.position === 'fixed', width: p.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    check(`${w}×${h}: ${drawer ? 'drawer' : 'persistent panel'}`, r.fixed === drawer && !r.overflow, `fixed=${r.fixed} w=${Math.round(r.width)}`);
  }

  exitCode = results.every(Boolean) ? 0 : 1;
} catch (e) {
  console.error('design-check crashed:', e);
} finally {
  await browser?.close();
  server.kill();
  console.log(results.every(Boolean) && results.length ? 'ALL PASS' : 'FAILURES');
  process.exit(exitCode);
}
```

- [ ] **Step 2: package.json scripts**

Add to `"scripts"`:

```json
    "test:unit": "node --test test/history.test.mjs test/design-state.test.mjs test/saved-store.test.mjs test/admin-store.test.mjs test/csv-parse.test.mjs",
    "test:design": "node test/design-check.mjs"
```

- [ ] **Step 3: Run everything**

Run: `npm run test:unit && npm run test:design`
Expected: all unit tests pass; design-check prints PASS for all ~13 checks and `ALL PASS`. Fix regressions before committing — check the page console for errors if a step fails (assets fall back to public S3; if the network is down, note which checks were skipped rather than faking a pass).

- [ ] **Step 4: Commit**

```bash
git add test/design-check.mjs package.json
git commit -m "test: end-to-end design-check — history, save/load, tablet sweep"
```

---

### Task 10: Final verification + docs touch

**Files:**
- Modify: `CODEBASE_UNDERSTANDING.md` (add a short "Design history & saved designs" paragraph pointing at `src/lib/history.js`, `src/lib/design-state*.js`, `src/features/saved/`)

- [ ] **Step 1: Full test suite**

Run: `npm run test:unit && node test/smoke.mjs && node test/admin-check.mjs && npm run test:design`
Expected: no regressions anywhere (smoke + admin checks still pass).

- [ ] **Step 2: Manual pass against spec §2 decisions**

Serve and confirm each locked decision: product switch clears history; reset is undoable; room-mode toggle doesn't create history entries; curtain edits are undoable; upload disables Save; ⌘Z ignored while typing in the save-name input.
Expected: all six hold.

- [ ] **Step 3: Docs + commit**

```bash
git add CODEBASE_UNDERSTANDING.md
git commit -m "docs: note design history + saved designs subsystem"
```

## Known accepted limitations (from spec §3.2/§8 — do not "fix" in this plan)

- Per-part slider divergence is not captured: DesignState stores one global slider set (matches the store's model). Undoing a slider tweak re-applies globally to fabric-wearing parts.
- A direct diffuse-upload (Replace-image button) that bypasses `CUSTOM_FABRIC_ITEMS` replays as the previously applied fabric.
- Designs on uploaded GLBs cannot be saved; room furniture layout is not part of DesignState.
