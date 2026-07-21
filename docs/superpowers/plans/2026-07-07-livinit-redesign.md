# Livinit Studio Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relayout + reskin the fabric configurator to the Livinit studio grammar ("Sidebar-everything"): frosted top bar with segmented model control, 380px right sidebar hosting the fabric grid + panels, clean canvas with glass overlay pills — with zero feature change.

**Architecture:** Vanilla classic scripts + hand CSS (unchanged). Work is markup/CSS/render-target only: `index.html` regions restructure, `styles/tokens.css` becomes the Livinit role layer, `styles/app.css` rules migrate stage-by-stage, `src/library.js` re-targets the swatch render into the sidebar. Store/actions and all three.js code untouched.

**Tech Stack:** CSS custom properties (RGB-triple roles), Eudoxus Sans woff2 (self-hosted), inline SVG icons, existing smoke harness (`node test/smoke.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-07-livinit-redesign-design.md` — read it first; §3 holds the full extracted design grammar (colors, shadows, type roles, glass recipes, control specs).

## Global Constraints

- ZERO FEATURE LOSS — all 18 features (FEATURES.md) work identically after every task.
- Smoke gate after EVERY task: `node test/smoke.mjs` → 7 PASS, no FAIL, no SKIP. `node --check` every edited JS file.
- Screenshot pair per task (before/after) via the scratchpad puppeteer pattern (reuse `task9-shots.mjs` from scratchpad if present, else pattern-match test/smoke.mjs); eyeball via Read.
- Branch `refactor/architecture`. NEVER push. NO Co-Authored-By trailer. Commit per task.
- Light mode only. No bundler/framework. No external hosts (fonts/icons are local).
- Functional primary is `#5870D6` (RGB `88 112 214`); brand periwinkle `#7A91EE` is decorative only.
- Shadows are navy-tinted `16 28 45`, never black.
- Smoke-test DOM anchors (`.bar-sw`, `#finder-overlay`, `#loading`, `#mesh-list`) stay stable, or `test/smoke.mjs` updates in the SAME commit.
- Inline `onclick=` handlers keep working — moved markup keeps its handler attributes verbatim.

---

### Task 1: Token layer + Eudoxus Sans

**Files:**
- Copy: `~/Livi/web-pipeline/public/fonts/EudoxusSans-{Regular,Medium,Bold,ExtraBold}.woff2` → `fonts/`
- Rewrite: `styles/tokens.css`
- Modify: `styles/app.css` (font stack + base color consumption only)

**Interfaces:**
- Produces: CSS custom properties `--md-primary`, `--md-on-primary`, `--md-primary-container`, `--md-on-primary-container`, `--md-surface`, `--md-on-surface`, `--md-surface-variant`, `--md-on-surface-variant`, `--md-surface-dim`, `--md-surface-container-low`, `--md-surface-container`, `--md-surface-container-high`, `--md-surface-container-highest`, `--md-outline`, `--md-outline-variant`, `--md-scrim`, `--md-success`, `--md-warning`, `--md-error` (ALL as space-separated RGB triples, consumed as `rgb(var(--md-primary) / 0.06)`), plus `--brand-periwinkle: #7A91EE`, `--elev-1/2/3`, `--r-xs/sm/md/lg/xl/full` (4/8/12/16/24/9999px), `--dur-fast/base/slow` (140/220/420ms), `--ease-motion: cubic-bezier(0.2,0.8,0.2,1)`, `--font-sans`. Every later task consumes these names.

- [ ] **Step 1: Copy fonts** — `mkdir -p fonts && cp ~/Livi/web-pipeline/public/fonts/EudoxusSans-*.woff2 fonts/` (4 files, weights 400/500/700/800).
- [ ] **Step 2: Rewrite `styles/tokens.css`** — replace the whole file:

```css
/* Livinit design tokens — ported from web-pipeline lib/design-system (2026-07-07).
   Color roles are space-separated RGB triples so alpha compositing works:
   color: rgb(var(--md-primary) / 0.06). Do not add hex role tokens. */
@font-face { font-family:'Eudoxus Sans'; src:url('../fonts/EudoxusSans-Regular.woff2') format('woff2'); font-weight:400; font-display:swap; }
@font-face { font-family:'Eudoxus Sans'; src:url('../fonts/EudoxusSans-Medium.woff2') format('woff2'); font-weight:500; font-display:swap; }
@font-face { font-family:'Eudoxus Sans'; src:url('../fonts/EudoxusSans-Bold.woff2') format('woff2'); font-weight:700; font-display:swap; }
@font-face { font-family:'Eudoxus Sans'; src:url('../fonts/EudoxusSans-ExtraBold.woff2') format('woff2'); font-weight:800; font-display:swap; }

:root {
  /* type */
  --font-sans: 'Eudoxus Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  /* primary (functional #5870D6; brand #7A91EE decorative only) */
  --md-primary: 88 112 214;
  --md-on-primary: 255 255 255;
  --md-primary-container: 236 239 253;
  --md-on-primary-container: 5 22 75;
  --brand-periwinkle: #7A91EE;
  /* surfaces / neutrals (brand navy #101C2D) */
  --md-surface: 255 255 255;
  --md-on-surface: 16 28 45;
  --md-surface-variant: 241 244 249;
  --md-on-surface-variant: 102 118 142;
  --md-surface-dim: 249 250 251;
  --md-surface-container-low: 249 250 251;
  --md-surface-container: 241 244 249;
  --md-surface-container-high: 234 238 245;
  --md-surface-container-highest: 221 228 238;
  --md-outline: 204 212 224;
  --md-outline-variant: 221 228 238;
  --md-scrim: 16 28 45;
  /* status */
  --md-success: 21 128 61;
  --md-warning: 194 85 12;
  --md-error: 243 64 64;
  /* elevation — navy-tinted, dual-layer */
  --elev-1: 0 1px 2px rgb(16 28 45 / .06), 0 1px 3px rgb(16 28 45 / .04);
  --elev-2: 0 2px 6px rgb(16 28 45 / .08), 0 1px 2px rgb(16 28 45 / .05);
  --elev-3: 0 6px 16px rgb(16 28 45 / .10), 0 2px 6px rgb(16 28 45 / .06);
  /* radius */
  --r-xs: 4px; --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-xl: 24px; --r-full: 9999px;
  /* motion */
  --dur-fast: 140ms; --dur-base: 220ms; --dur-slow: 420ms;
  --ease-motion: cubic-bezier(0.2, 0.8, 0.2, 1);
}
```

  Then KEEP the app's existing legacy token names (`--fs-*`, `--space-*`, old color vars from the current tokens.css) at the bottom of the file as an "LEGACY — migrating out, do not add consumers" block, re-pointed at the new roles where a sane mapping exists (e.g. old accent → `rgb(var(--md-primary))`, old panel bg → `rgb(var(--md-surface))`, old border → `rgb(var(--md-outline-variant))`, old text → `rgb(var(--md-on-surface))`, old muted text → `rgb(var(--md-on-surface-variant))`). Read the current tokens.css first and map every var; anything with no sane role mapping keeps its literal value. This makes Task 1 restyle the whole app (font + palette) with zero markup change.
- [ ] **Step 3: Font consumption** — in `styles/app.css`, set the body/root font-family to `var(--font-sans)`; base size stays as-is this task.
- [ ] **Step 4: Gate** — `node test/smoke.mjs` → 7 PASS. Screenshots before/after: global font + palette shift, layout identical.
- [ ] **Step 5: Commit** `redesign: Livinit role tokens + Eudoxus Sans (global reskin, layout unchanged)`

### Task 2: Frosted top bar + segmented model control

**Files:**
- Modify: `index.html` (the header region: current `.nav-item` cluster ~line 20-28, `#btn-view-in-my-room` ~65, `.prod-tab` tabs ~79-93, zone badge ~104)
- Modify: `styles/app.css`

**Interfaces:**
- Consumes: Task 1 tokens.
- Produces: `.topbar` (frosted), `.seg` / `.seg-chip` / `.seg-chip.active` (segmented control classes — Task 5 reuses them for Living/Bedroom), `.pill-btn` / `.pill-btn--primary` / `.pill-btn--ghost` (pill button classes — every later task reuses these).

- [ ] **Step 1: Read the current header region** in index.html (lines 15–115) and app.css rules for `.nav-item`, `.prod-tab`, `.btn-topbar*`, noting every id + onclick that must survive.
- [ ] **Step 2: Restructure markup.** One `<header class="topbar">`: left `◉ Livinit` mark (brand periwinkle dot + `Fabric Studio` wordmark, label-lg 700); center-left segmented control replacing `.prod-tab`s — SAME ids (`tab-chair`, `tab-sofa`, `tab-bed_fabric`) and SAME onclicks, new classes `seg-chip`; right cluster: Room View toggle (`nav-room` semantics preserved — keep both `nav-simulator`/`nav-room` behaviors by making Room View a single toggle pill calling `toggleRoomView()` and reflecting `.active` exactly as the old pair did — read `room.js`'s btn sync code first: it targets `#btn-room-view`; keep that hidden node untouched), `#btn-view-in-my-room` as `pill-btn`, overflow: GLB upload + Reset as small ghost pills (same onclicks). Zone badge moves next to the wordmark as a `label-sm` chip. The hidden legacy nodes (`#lib-title #lib-sub #btn-room-view`) stay verbatim (JS references them).
- [ ] **Step 3: CSS.** `.topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:16px;padding:12px 20px;background:rgb(var(--md-surface) / .88);backdrop-filter:blur(18px);border-bottom:1px solid rgb(var(--md-outline-variant));}`. Segmented: `.seg{display:inline-flex;gap:4px;background:rgb(var(--md-surface-container));border-radius:var(--r-full);padding:4px;}` `.seg-chip{height:32px;padding:0 14px;border-radius:var(--r-full);font:500 14px/20px var(--font-sans);color:rgb(var(--md-on-surface-variant));background:transparent;border:0;cursor:pointer;transition:all var(--dur-fast) var(--ease-motion);}` `.seg-chip:hover{color:rgb(var(--md-on-surface));}` `.seg-chip.active{background:rgb(var(--md-primary));color:rgb(var(--md-on-primary));font-weight:600;box-shadow:var(--elev-1);}`. Pills: `.pill-btn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:var(--r-full);font:600 14px/20px var(--font-sans);border:1px solid rgb(var(--md-outline-variant));background:rgb(var(--md-surface));color:rgb(var(--md-on-surface));cursor:pointer;transition:all var(--dur-fast) var(--ease-motion);}` `.pill-btn:hover{border-color:rgb(var(--md-primary));background:rgb(var(--md-primary) / .06);}` `.pill-btn--primary{background:rgb(var(--md-primary));color:rgb(var(--md-on-primary));border:0;box-shadow:var(--elev-1);}` `.pill-btn--primary:hover{box-shadow:var(--elev-3);transform:translateY(-2px);filter:brightness(1.05);}` `.pill-btn--primary:active{transform:scale(.97);}` `.pill-btn--ghost{border:0;background:transparent;}` `.pill-btn--ghost:hover{background:rgb(var(--md-on-surface) / .08);}`. Delete the replaced `.nav-item`/`.prod-tab` rules.
- [ ] **Step 4: Verify tab-switch JS.** `grep -n "prod-tab\|classList" src/*.js` — `room.js`/`boot.js` toggle `.active` on `#tab-*`; that still works (`.active` class name unchanged). Fix any code that queries `.prod-tab` by class to query the new class.
- [ ] **Step 5: Gate + screenshots + commit** `redesign: frosted top bar with segmented model control`

### Task 3: Fabric library → sidebar grid (HIGHEST RISK)

**Files:**
- Modify: `index.html` (bottom strip `#fabric-tabs` ~401 + `.fabric-swatches-row` region ~405-423 moves into `#right-panel` ~184; `#fab-scroll-left/right` buttons deleted)
- Modify: `src/library.js` (render target + group markup)
- Modify: `styles/app.css`
- Modify: `test/smoke.mjs` (bar assertion → grid assertion, same `.bar-sw` class)

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 `.pill-btn`.
- Produces: `#fabric-grid` (the sidebar swatch container `buildLibrary` renders into), `.lib-group-head` (sticky headers), `.bar-sw` UNCHANGED as the swatch class + `data-fabric-key` contract.

- [ ] **Step 1: Map the current library DOM flow.** Read `src/library.js` fully: `buildLibrary()` targets `#fabric-swatches-row`; filter strip `#fabric-tabs`; search `#fab-search-input` + `filterFabricSearch`; scroll buttons (`scrollSwatches`) become obsolete. Read the drag-drop code path (`drag-ghost` is `position:fixed` — verify, then leave alone).
- [ ] **Step 2: Sidebar markup.** Inside `#right-panel`, ABOVE `#panel-product`, add:

```html
<div class="lib-pane" id="lib-pane">
  <div class="lib-head">
    <div class="lib-head-row"><span class="lib-title">Fabrics</span></div>
    <input type="text" id="fab-search-input" class="lib-search" placeholder="Search fabrics…" oninput="filterFabricSearch(this.value)">
    <div class="lib-filter-chips" id="fabric-tabs"></div>
  </div>
  <div class="lib-grid" id="fabric-grid"></div>
</div>
```

  Keeping ids `fab-search-input` and `fabric-tabs` (JS builds filter tabs into it). Delete the whole bottom strip section and the `fab-scroll-*` buttons + their `scrollSwatches` onclicks; delete `scrollSwatches` ONLY if grep shows no other caller.
- [ ] **Step 3: Re-target `buildLibrary`.** Change its container query from `fabric-swatches-row` to `fabric-grid`; group headers become `<div class="lib-group-head">` sticky rows; swatches keep class `bar-sw` + `data-fabric-key` + existing click/drag handlers verbatim. "My Fabrics"/"+ Finder" entries render as leading tiles.
- [ ] **Step 4: CSS.** `#right-panel` becomes the studio panel skeleton: `width:380px;display:flex;flex-direction:column;min-height:0;background:rgb(var(--md-surface));border-left:1px solid rgb(var(--md-outline-variant));`. `.lib-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;overflow-y:auto;min-height:0;flex:1;padding:0 16px 16px;}` `.bar-sw{width:100%;aspect-ratio:1;border-radius:var(--r-md);border:2px solid transparent;overflow:hidden;}` `.bar-sw.active{border-color:rgb(var(--md-primary));box-shadow:var(--elev-1);}` `.lib-group-head{position:sticky;top:0;background:rgb(var(--md-surface) / .95);backdrop-filter:blur(8px);font:800 11px/16px var(--font-sans);letter-spacing:.12em;text-transform:uppercase;color:rgb(var(--md-on-surface-variant));padding:10px 0 6px;grid-column:1/-1;}` `.lib-search` = pill input (`height:36px;border-radius:var(--r-full);border:1px solid rgb(var(--md-outline-variant));padding:0 14px;background:rgb(var(--md-surface-container-low));`). Filter chips reuse `.seg`/`.seg-chip` or pill-chip style. Shimmer skeleton class per spec §3 for tiles pre-thumbnail: `.bar-sw.loading{background:linear-gradient(100deg,rgb(var(--md-surface-container-high)) 30%,rgb(var(--md-surface-container-highest)) 50%,rgb(var(--md-surface-container-high)) 70%);background-size:200% 100%;animation:shimmer 1.5s ease-in-out infinite;}` `@keyframes shimmer{to{background-position:-200% 0;}}` — apply `loading` until each thumbnail `img.onload` fires (small library.js addition; on error keep placeholder).
- [ ] **Step 5: Delete dead bottom-bar CSS** (`.fabric-tabs-strip`, `.fabric-swatches-row`, `.fab-scroll-btn`, old `.bar-sw` sizing).
- [ ] **Step 6: Smoke update (same commit).** In test/smoke.mjs the library check counts `.bar-sw` — unchanged. Add one assertion after the swatch count: `document.getElementById('fabric-grid').children.length > 0` folded into the same check's detail. Manually drive on the running server: click a swatch (applies), drag one onto the model (applies), search filters, filter tabs work, My-Fabrics tile opens finder.
- [ ] **Step 7: Gate + screenshots + commit** `redesign: fabric library moves to sidebar grid`

### Task 4: Panels + footer tray in sidebar

**Files:**
- Modify: `index.html` (`#panel-product` ~187, `#panel-room` ~245 content reflow; footer tray added at `#right-panel` bottom)
- Modify: `src/panels.js` (templates get card classes), `styles/app.css`

**Interfaces:**
- Consumes: Task 3 sidebar skeleton, Task 2 pills.
- Produces: `.side-card` (card grammar class used by Task 6 finder panels too), `.side-footer` tray.

- [ ] **Step 1:** Applied-material + sliders (rendered by `src/panels.js`) become collapsible `.side-card`s below the lib grid: `background:rgb(var(--md-surface-container-low));border:1px solid rgb(var(--md-outline-variant));border-radius:var(--r-lg);box-shadow:var(--elev-1);padding:16px;`. Card title = 16/24 600; eyebrow labels = 11/16 800 uppercase tracking .12em. Product info block (`#cp-product-*`) restyles to card grammar. Collapse behavior: a `<details>`/summary OR the existing show/hide logic — read `panels.js`/`room.js` first and reuse whatever visibility mechanism exists (do not invent parallel state).
- [ ] **Step 2:** Curtain config (`#curtain-config-panel`) becomes a `.side-card` that keeps its show/hide logic; curtain shape buttons restyle to `.seg-chip`-like pills (ids `cshape-*` + onclicks verbatim).
- [ ] **Step 3:** Footer tray `<div class="side-footer">` at panel bottom: AI Render (`pill-btn--primary`, wired to the existing render button's onclick — grep for `renderScene(` trigger id in current markup) + Export GLB (`pill-btn`). `.side-footer{border-top:1px solid rgb(var(--md-outline-variant));background:rgb(var(--md-surface-container-low));padding:12px 16px 16px;display:flex;gap:10px;box-shadow:var(--elev-2);}`. Remove the buttons' old homes.
- [ ] **Step 4:** `#mesh-list`/`#piece-list` (zone/part lists) restyle to card rows; keep ids (smoke asserts `#mesh-list` populated).
- [ ] **Step 5: Gate + screenshots + commit** `redesign: sidebar cards, curtain section, CTA footer tray`

### Task 5: Canvas glass overlays (room tray, viewport pills, move HUD)

**Files:**
- Modify: `index.html` (`#rsec-living/bedroom` buttons ~249-253 + room chips ~267-297 relocate into a canvas tray; `#move-hud` ~133; explode control)
- Modify: `styles/app.css`; possibly `src/room.js` if it queries moved containers

**Interfaces:**
- Consumes: `.seg`, glass pill recipe.
- Produces: `.glass-pill` utility (`background:rgb(var(--md-surface) / .70);backdrop-filter:blur(20px);border:1px solid rgb(var(--md-outline-variant) / .60);border-radius:var(--r-full);box-shadow:var(--elev-2);`).

- [ ] **Step 1:** Room tray: floating top-center over canvas (`position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:20;`), a `.glass-pill` row holding the Living/Bedroom `.seg` (ids `rsec-living/bedroom` + onclicks verbatim) and the room-element chips (`chip-*` ids verbatim, restyled as small pills with inline-SVG icons replacing 🧱⬛🪟🚪🟫▫). Tray visible only in room mode — reuse the exact show/hide mechanism that shows `#panel-room` today (read `room.js` toggleRoomView DOM sync first). The `#rsec-*-content` blocks STAY in the sidebar (bed variant picker, curtain entry) — only section switcher + element chips float.
- [ ] **Step 2:** Viewport controls + `#v-hint` + `#drop-hint` restyle as `.glass-pill`s top-left; `#move-hud` restyles to a bottom-center glass tray (ids `mm-translate/mm-rotate` etc. verbatim).
- [ ] **Step 3:** Explode slider → slim glass pill bottom-left (existing input id + oninput verbatim).
- [ ] **Step 4:** Loading overlay `#loading` restyles: scrim `rgb(var(--md-scrim) / .5)` + blur, spinner in primary, `#load-txt` label-md. Id + `.on` class contract unchanged (smoke depends on it).
- [ ] **Step 5: Gate** — room view enter/exit check exercises the tray; ALSO manually drive: enter room, toggle walls/floor/curtains chips, switch Living/Bedroom, move mode, explode. Screenshots product + room. **Commit** `redesign: canvas glass overlays for room controls and HUDs`

### Task 6: Finder modal + tour reskin

**Files:**
- Modify: `index.html` (finder markup ~433-643, tour markup ~700s), `styles/app.css`

- [ ] **Step 1:** `#finder-overlay` backdrop → `background:rgb(var(--md-scrim) / .5);backdrop-filter:blur(12px);`. `#finder-modal` → `border-radius:var(--r-xl);background:rgb(var(--md-surface));box-shadow:var(--elev-3);border:1px solid rgb(var(--md-outline-variant));`. Tabs `ftab-*` → `.seg`; inputs → pill inputs; `finder-footer-save/generate`, drawer buttons, cust-btns → `.pill-btn`/`.pill-btn--primary`. ALL ids/onclicks/display-toggled blocks verbatim — this is class + CSS work only.
- [ ] **Step 2:** Tour tooltip cards → card grammar + elevation-3, buttons → pills. `window._tour*` contract untouched.
- [ ] **Step 3: Gate** (finder open/close check) + manual drive: open finder, switch tabs, quick-filter search renders result grid (API will 402 — chrome states still render), close. Screenshots. **Commit** `redesign: finder modal + tour reskin`

### Task 7: Polish — icons, motion, narrow drawer, dead-CSS sweep

**Files:**
- Modify: `index.html`, `styles/app.css`, possibly `src/boot.js` (drawer toggle)

- [ ] **Step 1: Icon sweep.** Every remaining emoji glyph in chrome (🛋 in `#cp-product-thumb`, 🪵🛏 bed chips, ✕ closes, etc.) → inline `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">` glyphs. Fabric-swatch content and 3D canvas untouched.
- [ ] **Step 2: Motion + focus.** Interactive elements get `transition: all var(--dur-fast) var(--ease-motion)` where missing; visible focus ring `outline:2px solid rgb(var(--md-primary) / .6);outline-offset:2px` on keyboard focus (`:focus-visible`).
- [ ] **Step 3: Narrow drawer.** `@media (max-width:1024px)`: `#right-panel{position:absolute;top:0;right:0;bottom:0;z-index:30;width:340px;max-width:85vw;box-shadow:var(--elev-3);transform:translateX(100%);transition:transform var(--dur-base) var(--ease-motion);}` `#right-panel.open{transform:none;}` plus a floating `.glass-pill` "Fabrics" toggle button bottom-right (new small `toggleSidebar()` in boot.js flipping the class; hidden ≥1024px).
- [ ] **Step 4: Dead-CSS sweep.** For each remaining rule in app.css, grep its selector's class/id against index.html + src/*.js; delete rules with zero matches. List deletions in the commit body.
- [ ] **Step 5: Full manual pass** on the running server: every feature in FEATURES.md exercised once (18 items — check them off in the report). Gate + screenshots. **Commit** `redesign: icon sweep, motion, narrow drawer, dead CSS purge`

## Verification per task
`node test/smoke.mjs` (7 PASS / 0 FAIL / 0 SKIP) + `node --check` on edited JS + before/after screenshots to scratchpad + the task-specific manual drives listed above. Server for manual drives: `node test/serve.mjs 8123` (S3 fallback active; AI endpoints 402 until Vercel re-enabled).
