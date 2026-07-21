# Asset Designer — Feature-Slice Module Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the flat `src/` of 14 classic-script files into a feature-slice folder structure AND convert them to ES modules with real per-feature public-API barrels, with zero feature loss and the smoke test green after every task.

**Architecture:** Vanilla-JS + Three.js r128 static app, no build step. Files move into `src/{app,lib,components/ui,features/*}/`. Classic global scope is replaced by ES module scope: shared **mutable** state lives on one exported holder object `E` (because ES imports can't be rebound and 23 mutables are reassigned cross-file); shared **constants/functions** become named exports/imports; cross-feature calls and inline `onclick=` handlers resolve late through a `window.*` shim assembled in `app/boot.js`. Because ES modules are *deferred* (run after classic scripts), the `index.html` script-tag flip is inherently one atomic step; it is preceded by two green de-risking steps and gated by `node --check` + the smoke test.

**Tech Stack:** Vanilla JS ES modules, Three.js r128 (global `THREE` from CDN classic tag), puppeteer-core + system Chrome smoke test (`test/smoke.mjs`), `test/serve.mjs` static server on :8123.

## Global Constraints

- **ZERO FEATURE LOSS.** All 18 FEATURES.md features work identically after every task. Refactors move code; they never change behavior. No visual/style changes in this pass.
- **No build step, no bundler, no TypeScript on frontend, no framework.** Plain ES modules only.
- **Smoke test PASS + commit after every task.** Gate command: `node test/smoke.mjs` → expect 7 `PASS` lines, no `FAIL`. Baseline is green (verified 2026-07-08: page load, library ≥50 swatches, finder open/close, model load, swatch apply, room enter/exit, no uncaught errors).
- **`node --input-type=module --check < <file>`** must pass for every module before wiring it into `index.html`.
- Branch: current branch (repo has no remote pushes in this workflow). **NEVER push.** **No `Co-Authored-By` trailer** in commits (founder preference).
- **Out of scope:** `viewer.html`, `api/`, styling, dedupe passes (curtains split, classifyMesh merge), icon unification.
- **`window.THREE`** is a global set by the CDN classic tag; module code references bare `THREE` (resolves via globalThis) — never import or rebind it. Same for `document`, `window`, `fetch`.

### The module-conversion recipe (applied in Task 3)

For each file `F`:
1. **Add named exports:** prefix each top-level declaration other modules or the shim need with `export` (exact per-file export lists are in Task 3).
2. **Shared mutable state → `E`:** every binding that is reassigned (`name = …`) in more than its declaring scope is a property of the holder `E` (defined in Task 2). References read/write `E.name`.
3. **Static imports from `lib` only:** `F` imports the constants/functions it reads that are owned by `lib/` (`catalog.js`, `store.js`, `actions.js`, `engine.js`). `lib` is a verified-acyclic leaf — safe to import statically.
4. **Cross-feature refs via `window.*`:** any symbol `F` reads that is owned by *another feature* (`configurator↔room`, `library↔room`, `library↔configurator`, `ui→configurator`) is called as `window.name(...)`, NOT statically imported — this breaks the import cycles.
5. **Barrel:** each `features/<slice>/index.js` re-exports its slice's public API.

---

## Task 1: Relocate files into feature-slice folders (classic scripts, no code change)

Pure file moves + `<script src>` path updates. Classic scripts share one global scope regardless of path, so behavior is unchanged. This delivers the visible folder structure with near-zero risk.

**Files:**
- Move: `src/store.js` `src/actions.js` `src/catalog.js` → `src/lib/`; `src/state.js` → `src/lib/engine.js`
- Move: `src/panels.js` → `src/components/ui/panels.js`
- Move: `src/model.js` `src/materials.js` `src/viewport.js` → `src/features/configurator/`
- Move: `src/room.js` → `src/features/room/`; `src/library.js` → `src/features/library/`; `src/finder.js` → `src/features/finder/`; `src/render.js` → `src/features/render/`; `src/tour.js` → `src/features/tour/`; `src/boot.js` → `src/app/boot.js`
- Modify: `index.html` (script `src` paths, lines 623–635 + 719)

**Interfaces:**
- Produces: the target directory tree; no symbol/scope changes; app still loads via 14 classic `<script src>` tags in the same order.

- [ ] **Step 1: Create dirs and move files with git**

```bash
cd asset_designer_dev
mkdir -p src/lib src/components/ui src/features/configurator src/features/room src/features/library src/features/finder src/features/render src/features/tour src/app
git mv src/store.js src/actions.js src/catalog.js src/lib/
git mv src/state.js src/lib/engine.js
git mv src/panels.js src/components/ui/panels.js
git mv src/model.js src/materials.js src/viewport.js src/features/configurator/
git mv src/room.js src/features/room/room.js
git mv src/library.js src/features/library/library.js
git mv src/finder.js src/features/finder/finder.js
git mv src/render.js src/features/render/render.js
git mv src/tour.js src/features/tour/tour.js
git mv src/boot.js src/app/boot.js
```

- [ ] **Step 2: Update the 15 script tags in `index.html`** (preserve exact order; only paths change)

Replace lines 623–635:
```html
<script src="src/lib/store.js"></script>
<script src="src/lib/actions.js"></script>
<script src="src/lib/catalog.js"></script>
<script src="src/lib/engine.js"></script>
<script src="src/components/ui/panels.js"></script>
<script src="src/features/configurator/materials.js"></script>
<script src="src/features/configurator/model.js"></script>
<script src="src/features/library/library.js"></script>
<script src="src/features/room/room.js"></script>
<script src="src/features/render/render.js"></script>
<script src="src/features/configurator/viewport.js"></script>
<script src="src/features/finder/finder.js"></script>
<script src="src/app/boot.js"></script>
```
Replace line 719: `<script src="src/features/tour/tour.js"></script>`

- [ ] **Step 3: Run smoke test**

Run: `node test/smoke.mjs`
Expected: 7 `PASS` lines, no `FAIL`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: relocate src/ into feature-slice folders (classic scripts, no behavior change)"
```

---

## Task 2: Introduce the shared mutable-state holder `E` (classic scripts, green)

De-risk the scariest part — converting reassigned globals — in isolation, while still classic-script so scope is unchanged. Create one holder object in `lib/engine.js` and mechanically rewrite every reassigned shared mutable to a property of it.

**Files:**
- Modify: `src/lib/engine.js` (define `E`, move reassigned `let`s into it)
- Modify: every file that reads/writes those mutables (`configurator/*`, `room/room.js`, `library/library.js`, `finder/finder.js`, `render/render.js`, `components/ui/panels.js`, `app/boot.js`)

**Interfaces:**
- Produces: global `E` (classic-scope object) holding all reassigned engine mutables. Still classic scope; no imports yet.
- Consumes: nothing new.

**The `E` members** (every `let` in `engine.js` reassigned anywhere — confirmed set):
`meshEntries, currentModel, _dirty, roomGroup, _roomLoadGen, explodeVal, explodeAnim, transformControls, furnitureMoveMode, tcMode, curtainMeshEntries, _curtainNodes, _blindsGroup, _curtainBaseBox, _curtainFace, curtainsVisible, _curtainNormTex, _curtainLinColor, dragItem, dragActive, ghost, ghostImg, renderer, scene, camera, pmremGen, gltfLoader, sph, tgt`.
Const objects/arrays that are only *mutated in place* (`_gltfSceneCache, polyCache, texCache, enhanceCache, roomElements, roomVisible, roomFurnitureModels, modelMaterialSnapshots`) stay as `const` (Task 3 makes them named exports; in-place mutation works across live imports — do NOT move these to `E`).

- [ ] **Step 1: Define `E` in `engine.js`**

Replace the individual `let` declarations of the members above with:
```javascript
// Shared mutable engine state. ES modules can't rebind imported bindings and
// 23 of these are reassigned from other modules, so they live as properties of
// one exported holder (Task 3 adds `export`). Reassign via E.x = …, read via E.x.
const E = {
  meshEntries: [], currentModel: null, _dirty: false, roomGroup: null,
  _roomLoadGen: 0, explodeVal: 0, explodeAnim: null, transformControls: null,
  furnitureMoveMode: false, tcMode: 'translate', curtainMeshEntries: [],
  _curtainNodes: null, _blindsGroup: null, _curtainBaseBox: null, _curtainFace: null,
  curtainsVisible: true, _curtainNormTex: null, _curtainLinColor: null,
  dragItem: null, dragActive: false, ghost: null, ghostImg: null,
  renderer: null, scene: null, camera: null, pmremGen: null, gltfLoader: null,
  sph: { theta: 0.4, phi: 1.15, r: 2.2 }, tgt: new THREE.Vector3(),
};
```
(Copy each member's exact initial value from the current `engine.js` declaration; the values above mirror the current defaults — verify each against the file before replacing.) Keep `markDirty()` but change its body to `E._dirty = true;`.

- [ ] **Step 2: Mechanically rewrite references across all files**

For each member `m`, replace bare `m` reads/writes with `E.m`. Derive and verify with grep per file, e.g.:
```bash
grep -rnE '(^|[^.A-Za-z0-9_])(meshEntries|currentModel|roomGroup|renderer|scene|camera|gltfLoader|curtainMeshEntries|transformControls|furnitureMoveMode|tcMode|explodeVal|explodeAnim|_dirty|_roomLoadGen|_blindsGroup|_curtainNodes|_curtainBaseBox|_curtainFace|curtainsVisible|_curtainNormTex|_curtainLinColor|dragItem|dragActive|ghost|ghostImg|pmremGen|sph|tgt)([^A-Za-z0-9_]|$)' src/ | grep -v 'E\.'
```
Rewrite each hit to `E.<name>`. Watch for false matches inside longer identifiers (word-boundary only) and inside strings/ids — the regex above is word-bounded; still eyeball each replacement. `ghost`/`ghostImg` also appear as element ids in some markup handlers — only rewrite JS identifier references, not DOM id strings.

- [ ] **Step 3: `node --check` the touched files**

Run: `for f in src/lib/engine.js src/features/configurator/*.js src/features/room/room.js src/features/render/render.js; do node --input-type=module --check < "$f" || echo "SYNTAX $f"; done`
Expected: no `SYNTAX` lines. (These are still classic files but must be syntactically valid.)

- [ ] **Step 4: Run smoke test**

Run: `node test/smoke.mjs`
Expected: 7 `PASS`, no `FAIL`. If a swatch/room check fails, a mutable reference was missed — grep for the bare name and fix.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: route reassigned engine mutables through shared holder E"
```

---

## Task 3: Atomic ES-module flip (imports/exports/barrels/shim + single module entry)

The one unavoidably-coordinated step: convert all 14 files to ES modules and flip `index.html` to a single deferred module entry. Cannot be split green because ES modules are deferred (mixing module + classic tags inverts load order and breaks `panels.js` DOM injection and `boot.js` init). Gated by `node --check` per file + smoke test; a single revertable commit.

**Files:** Modify all 14 `src/**/*.js`; Create 6 barrels `src/features/*/index.js`; Modify `index.html` (script tags).

**Interfaces:**
- Consumes: `E` holder from Task 2.
- Produces: `lib/` named exports; feature barrels; `app/boot.js` default entry that imports all and assembles `window.*` shim.

**Per-file export lists** (prefix these declarations with `export`):
- `lib/store.js`: `createStore, appStore`
- `lib/actions.js`: `SLIDER_DEFAULTS, setSlider, resetSliders, setBaseColor, setModelKey, setRoomMode, setRoomSectionState, CURTAIN_STATE_DEFAULTS, setCurtain, saveCurtainState, restoreCurtainState, setActiveFabric, setFinder, addCustomFabric`
- `lib/catalog.js`: `CHAIR_GLB, SOFA_GLB, BED_WOODEN_GLB, BED_FABRIC_GLB, ROOM_GLB, BEDROOM_ROOM_GLB, BEDROOM_SLOTS, getGLBUrl, MITY_IMG, POLY_API, POLY_IDS, SB, MATERIAL_MAPS, MF, WF, CHAIR_WOOD, CHAIR_FABRICS, D, SOFA_KALEID, SOFA_TWIST, SOFA_LINUM, SOFA_CHALLENGER, CUSTOM_FABRIC_ITEMS, LIBRARY`
- `lib/engine.js`: `E` (holder — includes `modelMaterialSnapshots` and `_curtainRoughTex`, folded in during Task 2 as they are rebound cross-file) + `BASE_TILE, texLoader, escapeHtml, showToast, setSliderVal, tryLoadTex, makeGreyscaleTex, POLY_NORM_KEYS, POLY_ROUGH_KEYS, POLY_DIFF_KEYS, pickPolyUrl, saveMaterialSnapshot, markDirty, roomElements, roomVisible, roomFurnitureModels, _gltfSceneCache, polyCache, texCache, enhanceCache, CURTAIN_FABRICS, CURTAIN_COLORS, CURTAIN_COLOR_GROUPS, raycaster, mouse` (`roomElements`/`roomVisible`/`roomFurnitureModels` stay `const` — property-mutated only, no rebind. Export every remaining top-level binding read by another module — verify with the derivation grep in Step 2)
- `components/ui/panels.js`: `SLIDER_ROWS, sliderRowsHtml, appliedPreviewHtml`
- `configurator/materials.js`: `texToDataUrl, _applyGen, openDiffuseUpload, initDragDrop, screenToNDC, getHitEntry, highlightHoveredMesh, clearMeshHighlight, startDrag, updateBrightness, applyProp, updateTexScale, updateNormScale`
- `configurator/model.js`: `dotColors, buildMeshList, buildPieceList, toggleCheck, selectAll, deselectAll, classifyMesh, processGLTF, loadModel, switchModel, _rebuildMeshEntries, resetAll`
- `configurator/viewport.js`: `updateProductInfo, _updateZoneCountBadge, rebuildZoneOverlay, updateZoneLabelPositions, camUpdate, initThree, loadScripts, handleGLBUpload`
- `features/library/library.js`: `buildLibrary, renderActiveSwatch, buildCurtainLibrary, filterFabricSearch`
- `features/finder/finder.js`: `switchFinderTab, openFabricFinder, closeFabricFinder, updateFinderMode, handleFinderImage, clearFinderImage, handleSearchCustomImage, clearSearchCustomImage, quickSearch, showConfirmBar, hideConfirmBar` (+ `saveAsMaterial, addSelectedResult, addSearchCustomToLibrary, analyzeAndAddFabric, doFinderSearch, makeSearchImageSeamless, previewAnalyzedOnModel, trySelectedOnModel, confirmAddFromBar, addCustomToLibrary` if declared here — export every function named in the shim list §below that lives in this file)
- `features/render/render.js`: `openViewInMyRoom, showRenderedImage, renderScene, exportGLB` (export every shim-list function declared here)
- `features/room/room.js`: `toggleRoomView, buildRoom, buildBedroomRoom, renderCurtainColorGroups, setCurtainShape, setCurtainFabric, setCurtainColor, setCurtainSize, buildCurtainEntries, FURNITURE_SLOTS, roomFloorY, removeRoom, toggleRoomEl, setRoomSection, toggleMoveMode, setMoveMode, nudgeFurniture, rotateFurnitureY, updateExplode, animateExplode, toggleCurtains, _seatOnFloor, _placeFurnitureInRoom, _applySnapshotToModel, _syncRoomSectionLock` (export every binding read by another module or in the shim list)
- `features/tour/tour.js`: exports none required (self-contained; assigns its own `window._tour*` — keep those assignments).
- `app/boot.js`: `toggleSidebar, showPanelTab` + the boot routine.

- [ ] **Step 1: Add `export` keywords per the lists above**

For each file, prefix the listed declarations with `export`. Leave bodies unchanged. `tour.js` keeps its `window._tour* = …` assignments as-is (its inline handlers use them).

- [ ] **Step 2: Add import headers (from `lib` only; cross-feature stays on `window`)**

For each non-lib file, derive the exact `lib` symbols it reads and add one import block at the top. Derivation per file `F`:
```bash
# names owned by lib that F references:
grep -oE '\b[A-Za-z_$][A-Za-z0-9_$]*\b' F | sort -u > /tmp/uses.txt
# intersect with lib exports (catalog + actions + store + engine export lists) → import those.
```
Example header for `features/configurator/materials.js`:
```javascript
import { E, escapeHtml, showToast, setSliderVal, tryLoadTex, makeGreyscaleTex,
         POLY_DIFF_KEYS, pickPolyUrl, saveMaterialSnapshot, markDirty, BASE_TILE,
         texCache, roomFurnitureModels } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { setActiveFabric, setSlider } from '../../lib/actions.js';
import { LIBRARY, MATERIAL_MAPS, SB } from '../../lib/catalog.js';
```
Rules: import ONLY from `../../lib/*.js` (or `../lib` depth as appropriate) and `../../components/ui/panels.js`. For any symbol owned by another **feature** (per spec §4 cycles: `configurator↔room`, `library↔room`, `library↔configurator`, `ui→configurator`), do NOT import — rewrite the call site to `window.name(...)`. `lib/*` files import only from other `lib/*` files (store/actions/engine/catalog among themselves), never from features.

- [ ] **Step 3: Create the 6 feature barrels**

`src/features/configurator/index.js`:
```javascript
export * from './model.js';
export * from './materials.js';
export * from './viewport.js';
```
`src/features/room/index.js`: `export * from './room.js';`
`src/features/library/index.js`: `export * from './library.js';`
`src/features/finder/index.js`: `export * from './finder.js';`
`src/features/render/index.js`: `export * from './render.js';`
`src/features/tour/index.js`: `export * from './tour.js';`

- [ ] **Step 4: Make `app/boot.js` the entry that assembles the `window.*` shim**

At the top of `boot.js`, import everything the shim needs and every module with load-time side effects (`panels.js` injects DOM; feature modules define handlers), in the original dependency order, then assign the shim BEFORE the bootstrap runs:
```javascript
import './../components/ui/panels.js';          // side-effect: injects slider/applied markup
import * as engine from '../lib/engine.js';
import * as store from '../lib/store.js';
import * as actions from '../lib/actions.js';
import * as catalog from '../lib/catalog.js';
import * as configurator from '../features/configurator/index.js';
import * as library from '../features/library/index.js';
import * as room from '../features/room/index.js';
import * as render from '../features/render/index.js';
import * as finder from '../features/finder/index.js';
import './../features/tour/tour.js';             // self-wires window._tour*

// Inline onclick= handlers + cross-feature calls resolve here.
Object.assign(window, configurator, library, room, render, finder,
  { showPanelTab, toggleSidebar });
```
Keep the existing `boot.js` bootstrap (loadScripts→initThree→…) below the shim. Verify the assembled `window` contains every one of the 42 shim functions (Step 6 diff).

- [ ] **Step 5: Flip `index.html` to a single module entry**

Delete the 14 `<script src="src/...">` tags (lines ~623–635 and ~719). Keep the CDN three.js classic tag (line 622). After it, add:
```html
<script type="module" src="src/app/boot.js"></script>
```

- [ ] **Step 6: `node --check` all modules + regenerate and diff the shim list**

```bash
for f in $(find src -name '*.js'); do node --input-type=module --check < "$f" || echo "SYNTAX $f"; done
# Required handlers from markup:
grep -oE 'on[a-z]+="[^"]*"' index.html | grep -oE '[A-Za-z_][A-Za-z0-9_]*\(' | sed 's/(//' | sort -u \
  | grep -vE '^(if|click|max|getElementById|getState)$' > /tmp/required.txt
```
Expected: no `SYNTAX` lines. Confirm every name in `/tmp/required.txt` is either assigned onto `window` by `boot.js`'s `Object.assign` (via a barrel) or a `window._tour*`/`window.showPanelTab` self-assignment. Any missing name = a dead button; add it to the barrel/shim.

- [ ] **Step 7: Run smoke test**

Run: `node test/smoke.mjs`
Expected: 7 `PASS`, no `FAIL`. Common failures and causes: `finder opens/closes` fail → finder fn not on `window`; `room enter/exit` fail → `toggleRoomView` not shimmed or a `room↔configurator` call still a static import (cycle) — change it to `window.*`; `no uncaught page errors` fail → a `let`-import rebind attempt or a missing import (read the error, it names the symbol).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: convert src/ to ES modules with per-feature barrels and window shim"
```

---

## Task 4: Verify boundaries and capture proof

Confirm the architecture's invariants actually hold and capture a visual baseline.

**Files:** none modified (verification only); optional Modify: `README.md` architecture note.

- [ ] **Step 1: Assert `lib` imports nothing upward**

Run: `grep -rnE "^import" src/lib | grep -E "features|components"`
Expected: no output (lib is a pure leaf).

- [ ] **Step 2: Assert no static cross-feature imports (cycles broken)**

Run: `grep -rnE "^import .* from '\.\./(configurator|room|library|finder|render)" src/features`
Expected: no output — cross-feature refs go through `window.*`, not static imports. (Imports of a slice's *own* sibling files and `../../lib`/`../../components` are fine; this grep only flags cross-*feature* paths.)

- [ ] **Step 3: Full smoke + screenshot**

Run: `node test/smoke.mjs --shot /private/tmp/claude-501/-Users-bhartendukodes-Livi/994f58b5-6a25-40be-b220-50d378b181df/scratchpad/after-refactor.png`
Expected: 7 `PASS`; open the screenshot and confirm the UI matches the pre-refactor app (no layout/visual change — this pass moved code only).

- [ ] **Step 4: (Optional) Add an architecture note to `README.md`** describing `src/{app,lib,components/ui,features/*}` and the `window.*` shim contract, then commit `docs: note feature-slice module layout`.

---

## Self-Review (completed by plan author)

- **Spec coverage:** target structure §3 → Task 1; `E` holder for mutables §4 → Task 2; module flip + barrels + shim §3/§5 → Task 3; cycle handling via `window.*` §4 → Task 3 Step 2 + Task 4 Step 2; `lib` acyclic §4 → Task 4 Step 1; smoke gate §7 → every task. Covered.
- **Placeholder scan:** export lists and shim list are concrete; import lists are derived by a documented, reproducible grep (the dependency edges are enumerated in the spec matrix, not left vague). No TBD/TODO.
- **Type consistency:** holder is `E` throughout; barrel filename `index.js` throughout; `markDirty` sets `E._dirty` (Task 2) and is exported (Task 3) consistently.
- **Known risk owned:** Task 3 is atomic by necessity (module deferral). Mitigations: preceded by two green de-risking tasks, `node --check` + smoke gate, single revertable commit, explicit failure→cause table in Step 7.
