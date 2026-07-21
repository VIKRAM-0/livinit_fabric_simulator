# Asset Designer (Fabric Configurator) — Refactor Design

Date: 2026-07-07
Mode: autonomous (user-approved auto mode; no pushes; local commits only)
Target doc: "Web App Architecture — A Pragmatic Target" (provided by user)

## 1. Read-back — what this app actually is

**What it does:** Single-page 3D fabric configurator (`index.html`, 6,640 lines).
Users pick a product (armchair / sofa / fabric bed), apply vendor fabrics
(MityLite, Douglass, Ennis) to individual meshes via click or drag-drop, tune PBR
sliders, view the product in a staged living room or bedroom (with a procedural
curtains/blinds system), search/analyze fabrics via Poly Haven / AmbientCG /
Gemini APIs, generate AI renders (`/api/generate`, `/api/gemini-room`), and
export GLB. A separate `viewer.html` is a dev calibration tool (out of scope).

**Stack:** Vanilla JS + Three.js r128 (global `THREE` via CDN script tags,
add-ons injected dynamically), Vercel static hosting + TS serverless functions
in `api/`. No build step. No framework.

**Structure of index.html:**
- lines 10–586: CSS (has a real `:root` token block, inconsistently used)
- lines 587–1291: markup (3-panel layout + finder modal + tour overlay), heavy
  inline `onclick=` wiring
- lines 1292–6225: main script (~4,900 lines): data catalogs, material pipeline,
  model processing, room system, curtains, finder, render/export, input handling
- lines 6226–6470: tour markup (incl. a *dead* older tour, 6308–6468)
- lines 6471–6639: tour controller IIFE

**Worst structural problems, ranked by pain:**
1. **~60 mutable globals with unclear ownership** — model/selection/room/curtain/
   finder state all top-level; `activeBtnEl` dual-tracked with DOM `.active`
   classes; finder reads truth from input `.value`s in 10+ places.
2. **Copy-paste duplication of core logic** — snapshot-save block pasted 5×;
   `processGLTF` vs `_rebuildMeshEntries` duplicate mesh classification;
   living vs bedroom curtain builders near-identical; wood vs main branch of
   `applySwatchToEntries` duplicate material assembly.
3. **Real bugs** (see §4): reset drops bed state, XSS via `innerHTML`, latent
   dead-variable bug in diffuse upload, no race guard on the fabric-apply
   pipeline (room loads *are* guarded — the pattern exists, it's just not applied).
4. **One 6,640-line file** — CSS, markup, 5k lines of JS, and two onboarding
   systems (one dead) in one file.
5. **Design inconsistency** — tokens exist but ~20+ `border-radius:8px` literals
   bypass `--r`; raw `rgba(124,58,237,…)` duplicates `--accent`; no font-size
   tokens; three icon systems (inline SVG, emoji, Unicode glyphs); 15+ ad-hoc
   button classes; duplicated product/room slider + applied-material blocks.

**What WORKS and must not break:** dirty-flag render loop; `_roomLoadGen`
generation guards on room loads; texture/GLB caches + preload; per-render
listener hygiene (no leak); the whole material pipeline, curtains, finder,
render, export flows are functional in production. This is a working app —
known bugs, not broken foundations.

## 2. Goal and constraints (decided autonomously per auto mode)

- **Goal: fix bugs + make maintainable.** Not a production-ready rewrite.
- **Constraint: no build step added.** The repo deploys static files on Vercel;
  filesystem paths win over the SPA rewrite, so plain ES modules + a separate
  stylesheet deploy unchanged. No bundler, no TS on the frontend, no framework
  (target doc §8: add tooling only for felt pain).
- **App must stay runnable after every step**; local commit per step; no push.

## 3. Approaches considered

**A. In-file reorganization only** — banner sections, fix bugs, tokens, store,
all inside index.html. Lowest risk, but leaves a 6,600-line file; the "no file
over ~300 lines" goal is unmet and future work stays painful.

**B. Incremental extraction to real files, no bundler (CHOSEN)** — fix bugs
first, tokens second, then extract CSS, then move JS into `src/` ES modules in
dependency order with a `window.*` shim so the existing inline `onclick=`
attributes keep working; introduce a small store for *UI/app* state (not the
Three.js scene graph). Verifiable at each step with a headless-browser smoke
test. Risk: module-scope cutover breaks inline handlers if the shim misses a
function — mitigated by generating the shim list mechanically from the markup.

**C. Vite + TypeScript + full store rewrite** — rejected: adds three tools at
once mid-refactor, exactly the anti-pattern the target doc bans (§8).

**Deliberate deviation from the target doc:** the "single store → pure render"
model is applied to **app/UI state only** (current model key, room mode/section,
curtain config, slider values, finder state, custom fabric list). The Three.js
scene graph, materials, and caches stay imperative behind action functions —
re-rendering a WebGL scene from state on every change is neither pragmatic nor
what Three.js is designed for. Actions remain the only writers of both.

## 4. Bug list (fix first, one commit each)

| # | Bug | Fix |
|---|-----|-----|
| B1 | `resetAll` reassigns `modelMaterialSnapshots = {chair:null, sofa:null}`, silently dropping `bed_wooden`/`bed_fabric` state | reset all four keys in place |
| B2 | XSS: `_showFinderAnalysis` injects `d.description`/`d.name` etc. from `/api/find-fabric` JSON into `innerHTML`; `_vimrGenerate` error branch injects server `e.message` | add `escapeHtml()`, escape all interpolations |
| B3 | `roomFurnitureMeshEntries` declared but never populated → `handleDiffuseUpload` branch is dead and misleading | delete the variable + dead branch (falls through to `meshEntries`, which is current behavior) |
| B4 | Dead tour markup (6308–6468) wires `onclick` to undefined `_tutNext/_tutClose/_tutGoTo` → throws if ever shown | delete dead markup |
| B5 | No generation guard on fabric-apply pipeline: rapid swatch clicks race; last-*resolved* fabric wins, not last-clicked | add apply-generation token, mirroring `_roomLoadGen` |
| B6 | `toggleRoomEl` missing null guard on chip button | guard |
| B7 | Dead code: `selectedPieceId`, `captureExplodeOrigins`/`explodeOrigins`, stale comment in `switchModel`, legacy hidden DOM (`lib-title`, `lib-sub`, `btn-room-view`, `fab-scroll`) | delete |

Positional snapshot restore (index-matched materials) is fragile but load order
is deterministic per asset; noted, not fixed (behavior change risk > benefit).

## 5. Target end-state layout

```
index.html          # shell: markup + <link> styles + <script type=module src=src/main.js>
styles/
  tokens.css        # design tokens (extends existing :root block)
  app.css           # component styles (consuming tokens only)
src/
  data/catalog.js   # fabric arrays, LIBRARY, CURTAIN_*, POLY_IDS, slots, URLs
  state/store.js    # ~30-line pub/sub store (UI/app state only)
  state/actions.js  # the only setState callers; also the only scene mutators
  lib/utils.js      # escapeHtml, showToast, setSliderVal, canvas helpers
  services/textures.js  # tryLoadTex, getPolyMaps, enhanceTexture, caches
  services/api.js   # generate/find-fabric/acg fetch wrappers
  three/engine.js   # renderer/scene/camera/input/render-loop (initThree, camUpdate)
  three/model.js    # processGLTF, loadModel, switchModel, snapshots (single helper)
  three/materials.js# applySwatchToEntries + slider updates
  three/room.js     # room build/teardown, sections, furniture placement, move mode
  three/curtains.js # curtain/blinds system (single entry builder, parameterized)
  features/libraryBar.js  # buildLibrary, filters, drag-drop
  features/panels.js      # mesh/piece lists, zone overlay, product info
  features/finder.js      # fabric finder modal
  features/render.js      # renderScene, view-in-my-room, export
  features/tour.js        # tour controller
  main.js           # boot + window-shim for inline handlers
```
File count is a target, not a fetish; the hard rule is no *new* soup: each
module owns its state's writers, cross-module access goes through actions.

## 6. Migration order (each step = runnable app + local commit)

1. **Harness**: git branch `refactor/architecture`; headless smoke test
   (system Chrome via puppeteer-core; asserts: page boots, no uncaught errors,
   model loads, swatch apply works, room view enters). If headless Chrome is
   unavailable, stop after step 4 and report — do not blind-refactor the split.
2. **Bugs B1–B7**, one commit each, smoke test between.
3. **Tokens**: font-size/spacing/radius tokens added; raw rgba/hex duplicates of
   existing tokens replaced; `--accent-hover`/`--accent-light` collapse decided
   in CSS only (no visual change intended; spot-check screenshots).
4. **Extract CSS** to `styles/` (mechanical move, plus token consumption).
5. **Extract data catalogs** to `src/data/catalog.js` (pure constants — safest
   JS extraction, proves the module + shim pattern).
6. **Store + actions** for UI/app state; kill state-from-DOM violations
   (finder inputs, dual-tracked active swatch); dedupe the 5× snapshot block
   into one helper.
7. **Extract remaining JS** module-by-module in dependency order (utils →
   services → three/* → features/* → main), window-shim maintained; shim list
   generated by grepping `on*="` handlers in the markup.
8. **Dedupe passes**: curtain builders, processGLTF/_rebuildMeshEntries
   classification, applySwatchToEntries wood/main branches — each its own
   commit with smoke test.
9. **Design consistency last** (target doc §7.6): shared `.btn`/`.label`
   utilities, collapse duplicated product/room slider + applied-material blocks.
   Icon-system unification is **deferred** (visual-approval work, needs founder).

Steps 8–9 are value-adds after the structural goal; if verification friction
grows, cut from the bottom, never skip smoke tests to go faster.

## 7. Error handling & testing

- Smoke test is the gate for every commit (real app boot in headless Chrome
  against a local static server; `/api/*` endpoints absent locally — the app
  already probes and degrades, which the test tolerates by asserting only
  console *exceptions*, not failed fetches).
- `node --input-type=module --check` on every extracted module.
- No unit-test scaffold added in this pass (target doc §8: cover state/actions
  once they exist; a follow-up can add tests for `store.js` + pure helpers —
  they're the only pure surface).

## 8. Out of scope

- `viewer.html`, `api/` backend code (except reading), curtains-blinds handoff
  feature, icon-set unification, bundler/TS/framework, any push to remote.
