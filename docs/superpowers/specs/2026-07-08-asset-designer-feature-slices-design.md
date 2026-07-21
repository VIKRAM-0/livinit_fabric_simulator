# Asset Designer — Feature-Slice Module Refactor (Design)

Date: 2026-07-08
Supersedes the *layout* of §5 in `2026-07-07-asset-designer-refactor-design.md` (layer-based `three/ services/ data/`) with a **feature-slice** structure requested by the founder. Everything else in that prior spec (bug list, store philosophy, no-build-step constraint, smoke-test gate) still holds and is inherited here.

## 1. Context — where the code actually is

The 2026-07-07 refactor already ran partway: the 6,640-line `index.html` was split into a **flat** `src/` of 14 files, a UI/app store (`store.js` + `actions.js`) was introduced, bugs B1–B7 were fixed, and CSS was extracted to `styles/`. What was **never done** is the module split itself (prior plan Task 7): the 14 files are still **classic scripts sharing one global scope** — the file comments say so verbatim ("top-level let/const/function share the global scope across all src/\*.js files"). They communicate through ~60 globals and are wired to the markup by inline `onclick=` handlers.

Only `index.html` loads `src/*.js` (15 `<script src>` tags, order-dependent). `viewer.html` is standalone and out of scope. `api/*.ts` (Vercel functions) are out of scope.

**Baseline verified green (2026-07-08):** `node test/smoke.mjs` → 7/7 PASS (page load, library ≥50 swatches, finder open/close, model load, swatch apply, room enter/exit, no uncaught errors), assets reachable. System Chrome + puppeteer-core both present. The prior plan's stop-condition ("if headless Chrome unavailable, stop — do not blind-refactor") is cleared.

## 2. Goal & constraints

- **Goal:** reorganize the flat `src/` into a feature-slice architecture AND convert classic scripts → ES modules with real per-feature public APIs (barrels). "Adapt the spirit" of the founder's Next.js DDD target — this is a vanilla-JS + Three.js static app, not Next.js/React; no `page.tsx`, no Server Actions, no Prisma.
- **ZERO FEATURE LOSS.** All 18 features in FEATURES.md work identically after every step. Refactors move code; they never remove behavior.
- **No build step, no bundler, no TS on frontend, no framework** (inherited constraint). Plain ES modules deploy unchanged on Vercel static hosting.
- **App boots + smoke-test PASS after every module extraction; one module per commit; commit only on PASS.** No push. No Co-Authored-By trailer (founder preference).

## 3. Target structure

```
src/
├── app/
│   └── boot.js                 # entry/bootstrap — the "routing layer" analog
├── lib/                        # platform substrate (acyclic; features depend on it, it depends on nothing above)
│   ├── store.js                # pub/sub store (UI/app state only)
│   ├── actions.js              # the only setState callers
│   ├── catalog.js              # data: fabric arrays, LIBRARY, CURTAIN_*, URLs, slots
│   └── engine.js               # (renamed from state.js) Three.js singletons: renderer/scene/camera/caches + ~60 shared globals
├── components/ui/
│   └── panels.js               # dumb shared UI: slider-row + applied-preview templates
└── features/
    ├── configurator/           # core product + material configurator
    │   ├── model.js            # processGLTF, loadModel, switchModel, snapshots, mesh/piece lists
    │   ├── materials.js        # swatch apply, slider updates, drag-drop, diffuse upload
    │   ├── viewport.js         # initThree, camUpdate, product info, zone overlay, GLB upload
    │   └── index.js            # barrel
    ├── room/
    │   ├── room.js             # room build/teardown, sections, furniture, move mode, curtains/blinds
    │   └── index.js
    ├── library/
    │   ├── library.js          # fabric library bar, filter, active-swatch render, curtain library
    │   └── index.js
    ├── finder/
    │   ├── finder.js           # fabric finder modal (search + AI analyze)
    │   └── index.js
    ├── render/
    │   ├── render.js           # AI render, view-in-my-room, export GLB
    │   └── index.js
    └── tour/
        ├── tour.js             # onboarding tour controller
        └── index.js
```

`index.html` ends with a single module entry: `<script type="module" src="src/app/boot.js">` (plus the CDN three.js tag). File count is a target, not a fetish; `room.js` (1,211 lines) may later split `curtains.js` out, but that is a *dedupe* follow-up, not this pass.

### Deliberate deviations (defended, not accidental)

- **Three.js engine → `lib/`, not a feature.** `engine.js` (renamed `state.js`) holds `renderer/scene/camera/gltfLoader`, texture/GLB caches, and the ~60 interlinked scene globals. This is a shared substrate every feature stands on, not a domain slice. Forcing it into a "feature" would invent fake boundaries worse than none. The founder's DDD target has no `three/` concept, so `lib/` (its "core platform / global utilities" layer) is the honest home.
- **No `actions.ts`/`hooks.ts`/`services.ts` per feature.** Those are React/Next artifacts. This app's mutations already live in `lib/actions.js` (store) and imperative scene functions. Splitting each feature into the full DDD file set would create empty ceremony. Each feature is one implementation file + one barrel.

## 4. The coupling problem and how it's handled

The measured cross-file global dependency graph is mostly a clean hub-and-spoke into `lib` (room→lib: 42 symbols, configurator→lib: 37, render→lib: 15). Two problems block naive one-way barrels:

1. **Feature↔feature cycles:** `configurator ↔ room` (6 + 5 symbols), `library ↔ room` (2 + 1), `library ↔ configurator` (2 + 2).
2. **UI→feature:** `panels.js` calls `applyProp`, `updateBrightness`, etc.

> **`lib` is already acyclic.** The raw dependency matrix appeared to show `lib→feature` backedges (`actions.js`→`setRoomSection`, store callbacks→`buildLibrary`, `processGLTF`), but verification (grep excluding comments, 2026-07-08) found **zero executable references** — every one is a comment mention (`// Callers re-render via buildLibrary()`), and `setRoomSectionState` was deliberately named to *avoid* calling the feature handler. The prior refactor already made the substrate pure. No `store.subscribe` remediation is needed; `lib` imports nothing from `features/` or `components/` today, and the module conversion keeps it that way.

ES modules tolerate circular imports, but this code runs **side effects at load time** (`panels.js` injects DOM on load; `boot.js` inits Three.js), so import cycles risk temporal-dead-zone / init-order failures.

**Resolution:**

- **The `window.*` shim is the cross-feature mediator, not just inline-handler glue.** Every cross-feature function is already exposed on `window` (for `onclick=`). Cross-feature calls resolve **late** through `window.foo()` instead of a static import, which breaks the static cycle. Concretely: `configurator↔room`, `library↔room`, and `library↔configurator` calls stay late-bound via the shim; the feature boundaries are preserved without fragile static import cycles. The barrels are real for `lib` and leaf features, and late-bound (documented) across the feature↔feature knots.
- **`panels.js` (ui)→configurator** stays late-bound via shim (the slider `oninput=` handlers are already inline strings referencing globals; the shim keeps them working).

### Dependency direction (target)

```
app ─▶ features/* ─▶ components/ui ─▶ lib      (static imports, one way; lib is a pure leaf)
       features/* ◀────────────────── window.* shim (late-bound, for cross-feature + inline handlers)
```

## 5. The `window.*` shim

Generated **mechanically** from the markup, never hand-curated:

```
grep -oE 'on[a-z]+="[^"]*"' index.html | grep -oE '[A-Za-z_][A-Za-z0-9_]*\(' | sort -u
```

Verified list (2026-07-08) is **42 real handler functions** after filtering grep noise (`if`, `click`, `max`, `getElementById`, `getState`): `_tourBack, _tourNext, _tourSkip, addSearchCustomToLibrary, addSelectedResult, analyzeAndAddFabric, camUpdate, clearFinderImage, clearSearchCustomImage, closeFabricFinder, confirmAddFromBar, deselectAll, doFinderSearch, exportGLB, filterFabricSearch, handleFinderImage, handleGLBUpload, handleSearchCustomImage, hideConfirmBar, makeSearchImageSeamless, nudgeFurniture, openViewInMyRoom, previewAnalyzedOnModel, quickSearch, renderScene, rotateFurnitureY, saveAsMaterial, selectAll, setCurtainShape, setCurtainSize, setMoveMode, setRoomSection, showPanelTab, switchFinderTab, switchModel, toggleCurtains, toggleMoveMode, toggleRoomEl, toggleRoomView, toggleSidebar, trySelectedOnModel, updateFinderMode`.

`boot.js` (or a small `app/shim.js`) does `Object.assign(window, {...})` importing each feature's barrel. **A missed shim entry = a dead button**; the smoke test exercises finder open/close, swatch click, room enter/exit, and asserts no uncaught page errors, catching the common breakages. The shim list is regenerated and diffed against the assembled `window` assignment at the final step.

## 6. Migration order (each step = runnable app + smoke PASS + one commit)

Dependency order: leaves first, hub-callers last, so each step's imports already exist.

1. **`tour`** — reads **0 foreign globals**; the clean proof-of-pattern. Extract to `features/tour/` as a module, keep `window._tour*` for its inline handlers. Smoke PASS → commit.
2. **`lib/` substrate** — move `store.js`, `actions.js`, `catalog.js` into `lib/`; rename `state.js`→`lib/engine.js`. Convert to modules with named exports. `lib` is already acyclic (verified — no executable feature calls), so this is a pure move + export conversion; no callback refactor needed. Smoke PASS → commit per file.
3. **`components/ui/panels.js`** — module; imports the slider config from `lib`; its `oninput=`-referenced functions stay on the shim. Smoke PASS → commit.
4. **Leaf features** `library`, `finder`, `render` — each imports statically from `lib`; cross-feature calls via shim; add barrel. One commit each, smoke PASS each.
5. **`configurator`** (`model`, `materials`, `viewport`) — the big hub. Static imports from `lib`; `configurator↔room` via shim. One commit per file, smoke PASS each.
6. **`room`** — reads 49 foreign globals; last feature. Static from `lib`; `room↔configurator`/`room↔library` via shim. Smoke PASS → commit.
7. **`app/boot.js`** — becomes the module entry: imports every feature barrel, assembles the `window.*` shim, runs bootstrap. Update `index.html` to a single `<script type="module" src="src/app/boot.js">`, removing the 15 ordered tags. Regenerate + diff the shim list. Smoke PASS → commit.

If verification friction grows at any step, stop and report — never skip the smoke test to go faster (inherited rule).

## 7. Error handling & testing

- **Smoke test (`test/smoke.mjs`) is the gate for every commit** — real app boot in headless system Chrome against `test/serve.mjs` on :8123. Tolerates absent `/api/*` and flaky CDNs (asserts only uncaught `pageerror`, not failed fetches).
- **`node --input-type=module --check < <file>`** on every extracted module before wiring.
- Screenshot via `--shot` on any step that could shift layout (should be none — this is pure code movement).
- No new unit-test scaffold this pass; `lib/store.js` + pure helpers remain the only unit-testable surface for a later follow-up.

## 8. Out of scope

- `viewer.html`, `api/` backend code, curtains-blinds handoff feature, icon-set unification, bundler/TS/framework, any push to remote.
- The `curtains.js` split out of `room.js` and other dedupe passes (prior plan Tasks 8–9) — separate follow-up.
- Any visual/design change. This pass moves code and enforces module boundaries; it does not restyle.
