# Asset Designer Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 7 identified bugs and restructure the 6,640-line `index.html` into tokens + ES modules with a UI-state store, keeping the app runnable (smoke-tested) and committed after every task.

**Architecture:** Single-page vanilla-JS + Three.js r128 app, no build step. Extraction order: bugs → tokens → CSS files → data catalog module → store/actions → remaining modules → dedupe. Inline `onclick=` handlers keep working via a `window.*` shim in `src/main.js`.

**Tech Stack:** Vanilla JS ES modules, Three.js r128 (global `THREE`), puppeteer-core + system Chrome for smoke tests, python http.server for local static serving.

## Global Constraints

- **ZERO FEATURE LOSS.** Every feature in FEATURES.md (18: model switching, library browse/search/filter, part selection, click-apply, drag-drop apply, sliders, texture replace, fabric finder search + AI analysis, my-fabrics, GLB upload, room view, room element toggles, curtains/blinds config, explode view, AI render, view-in-my-room, export GLB, viewport nav + move mode, onboarding tour) must work identically after every task. Refactors move code; they never remove behavior. Deletions are allowed ONLY for code proven unreachable (grep shows zero callers AND markup hidden with undefined handlers).
- No bundler, no TypeScript on frontend, no framework (spec §2).
- App must boot and pass the smoke test after every task; commit after every task.
- Branch: `refactor/architecture`. NEVER push. No Co-Authored-By trailer in commits.
- No file over ~300 lines for NEW files where practical; never re-merge split files.
- Store governs UI/app state only; Three.js scene stays imperative behind actions (spec §3).
- If headless Chrome is unavailable, stop after Task 4 (tokens) and report (spec §6.1).

---

### Task 1: Smoke-test harness

**Files:**
- Create: `test/smoke.mjs`
- Create: `test/serve.sh` (optional convenience)

**Interfaces:**
- Produces: `node test/smoke.mjs` → exit 0 on pass; prints PASS/FAIL lines. All later tasks run this as their gate.

- [ ] **Step 1: Write smoke test** — puppeteer-core against system Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`), `npm i -D puppeteer-core` (lockfile change ok). Serve repo root with `python3 -m http.server 8123`. Assertions: (1) page load, (2) zero uncaught page errors (`pageerror`) excluding failed `/api/*` fetches and CDN hiccups, (3) `#loading` overlay gains then loses `.on` within 60s (model loaded), (4) clicking first `.bar-sw` swatch does not throw, (5) `window.meshEntries === undefined` is NOT asserted (globals allowed until Task 7).
- [ ] **Step 2: Run it against unmodified app** — Expected: PASS (baseline). If Chrome missing → try `puppeteer` full install; if still failing, STOP per global constraints.
- [ ] **Step 3: Commit** `test: headless smoke test harness`

### Task 2: Bug fixes B1–B7 (one commit each, smoke test between)

**Files:** Modify: `index.html` only.

- [ ] B1 `resetAll` (~line 2979): replace `modelMaterialSnapshots = { chair:null, sofa:null }` with per-key nulling of all four keys (`chair, sofa, bed_wooden, bed_fabric`). Commit `fix: reset no longer drops bed material snapshots`.
- [ ] B2 XSS: add `function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}` near `showToast`; wrap every interpolation in `_showFinderAnalysis` (~6121) and the `_vimrGenerate` error branch (~5065). Commit `fix: escape API-derived strings before innerHTML (XSS)`.
- [ ] B3 delete `roomFurnitureMeshEntries` decl (~1631) + its dead read in `handleDiffuseUpload` (~2213), letting the existing fallback path stand. Commit `fix: remove dead roomFurnitureMeshEntries and misleading branch`.
- [ ] B4 delete dead tour markup lines ~6308–6468 (`tut-slides` block wired to undefined `_tut*` fns). Commit `fix: remove dead legacy tour markup with undefined handlers`.
- [ ] B5 race guard: add `let _applyGen = 0;` near state decls; in `applySwatchToEntries` capture `const gen = ++_applyGen;` at entry and bail (`if (gen !== _applyGen) return;`) after each `await` before mutating materials; same pattern in `handleDiffuseUpload`. Commit `fix: generation guard on fabric apply pipeline (race)`.
- [ ] B6 `toggleRoomEl` (~4238): null-guard `btn`. Commit `fix: null-guard room element chip`.
- [ ] B7 delete `selectedPieceId`, `captureExplodeOrigins`/`explodeOrigins`, stale bed comment in `switchModel`, hidden legacy DOM nodes `#lib-title #lib-sub #btn-room-view #fab-scroll` **only after** grepping JS for references (`btn-room-view` has an inline onclick — check callers; if referenced, keep node, note why). Commit `chore: remove dead code`.
- [ ] Run smoke test after each fix; `git commit` only on PASS.

### Task 3: Design tokens

**Files:** Modify: `index.html` (CSS block 10–586 only).

- [ ] Add to `:root`: `--fs-2xs:9px; --fs-xs:10px; --fs-sm:11px; --fs-md:12px; --fs-base:13px; --fs-lg:18px;` and `--space-1:4px --space-2:8px --space-3:12px --space-4:16px`; `--shadow-color:rgba(15,23,42` family decision: standardize scrims/shadows on `rgba(15,23,42,.X)`.
- [ ] Mechanical replacements within the style block: literal `border-radius:8px` → `var(--r-lg)` after changing `--r-lg:10px→8px` **only if** grep shows `--r-lg` genuinely unused (map agent says yes — verify with grep); `rgba(124,58,237,` stays raw where alpha-composited (CSS `color-mix` unavailable without modern target — keep raw but add comment `/* --accent @ alpha */`), font-size literals → tokens.
- [ ] Visual check: screenshot via smoke harness before/after, eyeball diff. Smoke PASS → commit `refactor: font-size/spacing/radius tokens, unify scrim color`.

### Task 4: Extract CSS

**Files:** Create: `styles/tokens.css`, `styles/app.css`. Modify: `index.html`.

- [ ] Move `:root` block → `styles/tokens.css`; rest of `<style>` → `styles/app.css`; replace with two `<link rel="stylesheet">` tags. Keep exact rule order.
- [ ] Smoke PASS + screenshot compare → commit `refactor: extract CSS to styles/`.

### Task 5: Extract data catalogs

**Files:** Create: `src/data/catalog.js`. Modify: `index.html`.

**Interfaces:**
- Produces: named exports `CHAIR_GLB…BEDROOM_SLOTS, MITY_IMG, POLY_API, POLY_IDS, SB, MATERIAL_MAPS, MF, WF, CHAIR_WOOD, CHAIR_FABRICS, SOFA_*, LIBRARY, CUSTOM_FABRIC_ITEMS, BASE_TILE, CURTAIN_FABRICS, CURTAIN_COLORS, CURTAIN_COLOR_GROUPS, FURNITURE_SLOTS, BLINDS_TILT, SHADE_VCOVER, SHADE_VRISE, getGLBUrl` — plus a temporary bridge: main script (still classic) reads them from `window.__catalog` set by a tiny module script `<script type="module">import * as c from './src/data/catalog.js'; window.__catalog=c; window.dispatchEvent(new Event('catalog-ready'))</script>`; classic script waits for it in its bootstrap.

  **Simpler alternative (preferred if workable):** convert the ENTIRE main script to `<script type="module" src="src/main.js">` in ONE move at this task, with the window-shim (Task 7's shim) created NOW, and skip the bridge. Decide at execution: if the main-script cut-over smoke-tests clean, do that; the bridge exists only as fallback.
- [ ] `node --input-type=module --check < src/data/catalog.js` → OK.
- [ ] Smoke PASS → commit `refactor: extract data catalogs to src/data/catalog.js`.

### Task 6: Store + actions for UI state

**Files:** Create: `src/state/store.js` (spec's ~30-line pub/sub, verbatim from target doc §2), `src/state/actions.js`. Modify: main script.

**Interfaces:**
- Produces: `store.getState().{currentModelKey, roomMode, activeRoomSection, curtainState, sliders:{brightness,roughness,metalness,sheen,scale,norm}, baseColorHex, finder:{tab,imgData,analyzed,selectedResult,pendingResult,searchCustomImg}, customFabrics}`; actions: `setModelKey, setRoomMode, setRoomSection, setCurtain(patch), setSlider(name,v), addCustomFabric(item), setFinder(patch), resetSliders(defaults)`.
- [ ] Move the listed globals into the store; replace direct writes with actions; DOM stays event-source only. Kill state-from-DOM: finder handlers (`saveAsMaterial`, `_analyzeImageAndAdd`, `addSearchCustomToLibrary`, `doFinderSearch`) read inputs ONCE at event time into action payloads; `activeBtnEl` dual-tracking replaced by `state.activeFabricId` + render pass that sets `.active`.
- [ ] Dedupe: one `saveSnapshot(modelKey)` helper replaces the 5 copy-pasted snapshot blocks (lines ~1975, 2077, 2276, 2779, 3264).
- [ ] Smoke PASS after each sub-move (store intro / finder / active-swatch / snapshots), commit each: `refactor: introduce store`, `refactor: finder state via actions`, `refactor: single-source active swatch`, `refactor: dedupe snapshot helper`.

### Task 7: Extract remaining JS to modules

**Files:** Create per spec §5: `src/lib/utils.js`, `src/services/textures.js`, `src/services/api.js`, `src/three/engine.js`, `src/three/model.js`, `src/three/materials.js`, `src/three/room.js`, `src/three/curtains.js`, `src/features/libraryBar.js`, `src/features/panels.js`, `src/features/finder.js`, `src/features/render.js`, `src/features/tour.js`, `src/main.js`. Modify: `index.html` (script tags only).

- [ ] Generate the required shim list mechanically: `grep -o 'on[a-z]*="[^"]*"' index.html | grep -o '[A-Za-z_]*(' | sort -u` → every named function goes in `src/main.js`: `Object.assign(window, { switchModel, toggleRoomView, ... })`.
- [ ] Extract in dependency order (utils → services → three → features → main), ONE module per commit, `node --check` + smoke PASS each. Cross-module mutable state (meshEntries, currentModel, roomGroup, curtain internals) moves to the module that owns its writers; other modules import accessor/action functions, never the raw variable binding.
- [ ] Tour: `src/features/tour.js` as module; keep `window._tour*` exports for its inline onclicks.
- [ ] Final: `index.html` contains no inline `<script>` logic beyond the CDN three.js tag + `<script type="module" src="src/main.js">`.

### Task 8: Dedupe passes (each own commit + smoke)

- [ ] `classifyMesh(mesh, box, modelKey)` shared by `processGLTF` + `_rebuildMeshEntries` (identical KNOWN map + bed classification).
- [ ] Unify `_buildCurtainEntries` / `_buildBedroomCurtainEntries` into `buildCurtainEntries(opts)`.
- [ ] Merge `applySwatchToEntries` wood/main duplicated material-assembly + snapshot code paths.
- [ ] Shared capture helper for renderScene/captureSingleAssetScene/captureDesignedScene camera save-restore.

### Task 9: Design-consistency pass

- [ ] Shared `.btn` base + variants; shared `.label` utility replacing ~10 duplicated uppercase-label rules; collapse duplicated product/room slider + applied-material markup by rendering both panels from one template function. Icon unification deferred (spec §8).
- [ ] Smoke + screenshots → commit `refactor: shared button/label primitives, deduped panel blocks`.

## Verification per task
`python3 -m http.server 8123` (background) → `node test/smoke.mjs` → expect `PASS` lines, exit 0. Screenshot saved to scratchpad for visual tasks.
