# Left-Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the fabric configurator from the right-sidebar layout into a left-side dashboard — a 72px left icon nav rail + one ~360px tabbed tool panel (Fabrics/Room/Parts) + edge-to-edge clean canvas + floating CTA cluster — with zero feature change.

**Architecture:** Vanilla classic-script JS + hand CSS (unchanged). Work is markup re-parenting + CSS + small boot.js wiring. Reuses the existing Livinit design system (tokens, Eudoxus, `.seg`/`.pill-btn`/`.glass-pill`, card grammar) and the store/actions untouched. The current `.topbar` and floating `#room-tray` are deleted; their controls move into the rail and the Room tab.

**Tech Stack:** CSS custom properties (`--md-*` role tokens), Eudoxus Sans, inline SVG icons, the existing smoke harness (`node test/smoke.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-08-left-dashboard-design.md` — read first; it holds the shell diagram, the 7 frontend-design principles, and the full control-inventory table.

## Global Constraints

- ZERO FEATURE LOSS — all 18 FEATURES.md features work identically after every task.
- Smoke gate after EVERY task: `node test/smoke.mjs` → 7 PASS, 0 FAIL, 0 SKIP. `node --check` every edited JS file.
- Per-task scripted drive (temp `test/tN-drive.mjs`, reuse the `test/smoke.mjs` puppeteer pattern, own server on a free port, DELETE before commit) + before/after screenshots to scratchpad, eyeballed via Read.
- Reuse existing primitives — `.seg/.seg-chip`, `.pill-btn/--primary/--ghost`, `.glass-pill`, card grammar (`.cp-section,.room-section-block` rule), `--md-*`/`--elev-*`/`--r-*`/`--dur-*` tokens. Do NOT reinvent.
- Store/actions (`appStore`, `src/actions.js`) untouched. Re-parented markup keeps its ids + onclick attributes verbatim.
- Periwinkle (`--md-primary` fill) is reserved for the ONE primary element in context (active nav item, active tab, primary CTA). All other controls are ghost/outline on neutral surfaces.
- Smoke selectors stay stable or `test/smoke.mjs` updates in the SAME commit: `.bar-sw`, `#fabric-grid`, `#finder-overlay`, `#loading` (+`.on`), `#mesh-list`, `#panel-room`.
- One source of truth for mode/tab: the store's `roomMode` (via `toggleRoomView`) + a single `activePanelTab` variable. Rail nav and tab bar RENDER from these; they never hold independent state.
- Branch `refactor/architecture`. NEVER push. NO Co-Authored-By trailer. Commit per task. Split `git add` / `git commit` into separate short Bash calls with explicit timeouts.

---

### Task 1: Left nav rail + delete top bar + floating CTA cluster

**Files:**
- Modify: `index.html` (the `.topbar` header at line ~20; add a rail element; add a floating cluster in `#viewport-wrap` at ~line 56)
- Modify: `styles/app.css`
- Modify: `src/boot.js` (rail-nav wiring)

**Interfaces:**
- Produces: `.nav-rail` (left rail element), `.nav-rail-item` / `.nav-rail-item.active` (icon+label nav buttons with left accent bar), `.canvas-cta` (floating glass CTA cluster). The overall page flex row becomes `rail | main-column`.

- [ ] **Step 1: Read current chrome.** Read `index.html` lines 15–140 (the `.topbar` + the start of the layout row) and the `.topbar`/`.seg--view`/`.seg--models` rules in `styles/app.css`. Note every id + onclick that must survive: `nav-simulator`, `nav-room` (view toggle → `toggleRoomView`), `tab-chair/sofa/bed_fabric` (`switchModel`), `zone-count-badge`, `nav-saved`, `btn-view-in-my-room` (`openViewInMyRoom`), GLB upload trigger, Settings, Get A Quote, and the hidden legacy nodes `#lib-title #lib-sub #btn-room-view`.
- [ ] **Step 2: Add the rail markup.** As the FIRST child of the top-level layout row (before the main column), add:

```html
<nav class="nav-rail" aria-label="Primary">
  <div class="nav-rail-logo" title="livinit"><!-- inline livinit dot + mark --></div>
  <button class="nav-rail-item active" id="nav-simulator" onclick="if(appStore.getState().roomMode)toggleRoomView()">
    <span class="nav-rail-ico"><!-- monitor SVG --></span><span class="nav-rail-lbl">Product</span></button>
  <button class="nav-rail-item" id="nav-room" onclick="if(!appStore.getState().roomMode)toggleRoomView()">
    <span class="nav-rail-ico"><!-- home SVG --></span><span class="nav-rail-lbl">Room</span></button>
  <button class="nav-rail-item" id="nav-saved" onclick="" title="Saved">
    <span class="nav-rail-ico"><!-- bookmark SVG --></span><span class="nav-rail-lbl">Saved</span></button>
  <div class="nav-rail-spacer"></div>
  <button class="nav-rail-item" onclick="document.getElementById('glb-input').click()" title="Upload GLB">
    <span class="nav-rail-ico"><!-- upload SVG --></span><span class="nav-rail-lbl">Upload</span></button>
  <button class="nav-rail-item" onclick="" title="Settings">
    <span class="nav-rail-ico"><!-- gear SVG --></span><span class="nav-rail-lbl">Settings</span></button>
  <div class="nav-rail-avatar">AR</div>
</nav>
```

  Use inline 24-grid SVGs (stroke 2.2, currentColor) matching the Task 7 sweep style. Keep `nav-simulator`/`nav-room`/`nav-saved` ids + onclicks verbatim (room.js:11 syncs `.active` on the nav-items via those ids — grep-confirm the selector it uses and keep the class it toggles).
- [ ] **Step 3: Add the floating CTA cluster** inside `#viewport-wrap`, top-right:

```html
<div class="canvas-cta">
  <button class="pill-btn" id="btn-view-in-my-room" onclick="openViewInMyRoom()"><!-- home ico -->View in My Room</button>
  <button class="pill-btn pill-btn--primary" onclick="">Get A Quote →</button>
</div>
```

  Move `btn-view-in-my-room` here verbatim (its id/onclick are referenced elsewhere — keep them).
- [ ] **Step 4: Delete the `.topbar`.** Remove the `<header class="topbar">…</header>` block. The `.seg--models` model picker and `#zone-count-badge` are NOT deleted — temporarily relocate them into the top of the tool panel (`#right-panel`, before `#panel-scroll`) as a plain holding spot so they stay functional; Task 4 gives the model picker its real home in the Parts tab. Keep the hidden legacy nodes `#lib-title #lib-sub #btn-room-view` (JS refs them) — park them just inside the main column, still `display:none`.
- [ ] **Step 5: CSS.** Layout row = `display:flex`. `.nav-rail{width:72px;flex:none;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:12px 8px;background:rgb(var(--md-surface));border-right:1px solid rgb(var(--md-outline-variant));}`. `.nav-rail-item{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;border:0;background:transparent;color:rgb(var(--md-on-surface-variant));font:500 10px/12px var(--font-sans);border-radius:var(--r-md);cursor:pointer;transition:all var(--dur-fast) var(--ease-motion);}` `.nav-rail-item:hover{color:rgb(var(--md-on-surface));background:rgb(var(--md-on-surface) / .05);}` `.nav-rail-item.active{color:rgb(var(--md-primary));background:rgb(var(--md-primary-container));}` `.nav-rail-item.active::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:var(--r-full);background:rgb(var(--md-primary));}` `.nav-rail-spacer{flex:1;}`. `.canvas-cta{position:absolute;top:16px;right:16px;z-index:20;display:flex;gap:8px;}`. Delete the `.topbar`, `.seg--view` rules (the view toggle is now the rail). Keep `.seg--models` styling for now.
- [ ] **Step 6: Verify view-mode sync.** `grep -n "nav-simulator\|nav-room\|nav-item" src/*.js` — room.js toggles `.active`/some class on those ids when `roomMode` changes. Confirm it still targets the (now rail) buttons by id and the class it toggles matches `.nav-rail-item.active`; adjust the CSS class name if room.js toggles a different class, so the rail reflects mode.
- [ ] **Step 7: Gate.** `node --check src/boot.js`; `node test/smoke.mjs` → 7 PASS. Scripted drive: Product/Room rail items switch mode and reflect `.active`; Get A Quote + View-in-My-Room present (modal opens); GLB upload picker opens. Screenshots t1 product+room. Confirm no `.topbar` remains and the canvas is wider.
- [ ] **Step 8: Commit** `redesign: left nav rail, drop top bar, float CTAs`

### Task 2: Tabbed tool panel scaffold (panel already left-adjacent)

**Files:**
- Modify: `index.html` (`#right-panel`/`#panel-scroll` at ~198; add tab bar + pinned Applied card + tab-body wrappers)
- Modify: `styles/app.css`
- Modify: `src/boot.js` (add `showPanelTab`)

**Interfaces:**
- Consumes: Task 1 rail.
- Produces: `window.showPanelTab(name)` where name ∈ `'fabrics'|'room'|'parts'`; `.panel-tabs` (segmented tab bar), `.panel-tab-body[data-tab]` (three body wrappers), `.applied-card` (pinned). A module-level `activePanelTab` string in boot.js is the single tab source of truth.

**REQUIRED visual order (the whole point of this redesign):** `rail (72px) | tool panel (~360px) | canvas (rest)`. The tool panel `#right-panel` currently sits at the END of the row (right of the canvas). It MUST move to physically sit between the rail and the canvas. Do this by reordering the DOM (move the `#right-panel`/`aside` node to immediately after the `.nav-rail` and before the `#viewport-wrap` main column) OR via CSS flex `order` on the row's flex children — DOM reorder is preferred (cleaner, no order-vs-source confusion). The canvas takes all remaining width. Remove/replace the Task-7 narrow-drawer rule that assumed a right-anchored panel (`right:0; translateX(100%)`) with a left-anchored equivalent (`left:72px; translateX(-100%)`) in the same task so the mobile drawer still works from the correct side.

- [ ] **Step 1: Read** `index.html` 198–370 (the `#right-panel` → `#panel-scroll` → `#lib-pane` → `#panel-product` → `#panel-room` → `.side-footer` structure) and note what lives in `#panel-product` (mesh-list, product info, `#cp-sliders`) vs `#panel-room` (curtain config, piece-list, applied/sliders blocks).
- [ ] **Step 2: Add tab bar** at the top of `#right-panel`, above `#panel-scroll`:

```html
<div class="panel-tabs seg" role="tablist">
  <button class="seg-chip active" id="ptab-fabrics" onclick="showPanelTab('fabrics')">Fabrics</button>
  <button class="seg-chip" id="ptab-room" onclick="showPanelTab('room')">Room</button>
  <button class="seg-chip" id="ptab-parts" onclick="showPanelTab('parts')">Parts</button>
</div>
<div class="panel-context" id="panel-context"></div>
```

  Move `#zone-count-badge` content into `#panel-context` (or keep the badge element there) so the context line shows model + zones.
- [ ] **Step 3: Wrap tab bodies.** Inside `#panel-scroll`, group the existing blocks under three `<div class="panel-tab-body" data-tab="...">` wrappers WITHOUT moving their inner nodes across tabs yet: `#lib-pane` → `data-tab="fabrics"`; `#panel-room` content → `data-tab="room"`; `#panel-product` (mesh-list etc.) → `data-tab="parts"`. The pinned **Applied card** (the applied-material + `#cp-sliders`) is lifted OUT of the scroll into a `.applied-card` between the context line and `#panel-scroll` so it's always visible on Fabrics/Parts. `.side-footer` stays pinned at panel bottom.
- [ ] **Step 4: `showPanelTab` in boot.js:**

```javascript
let activePanelTab = 'fabrics';
function showPanelTab(name){
  activePanelTab = name;
  document.querySelectorAll('.panel-tab-body').forEach(b=>b.classList.toggle('on', b.dataset.tab===name));
  ['fabrics','room','parts'].forEach(n=>document.getElementById('ptab-'+n)?.classList.toggle('active', n===name));
  // Applied card hidden on the Room tab (room has no per-fabric adjust context)
  document.querySelector('.applied-card')?.classList.toggle('hidden', name==='room');
}
window.showPanelTab = showPanelTab;
```

  CSS: `.panel-tab-body{display:none;}` `.panel-tab-body.on{display:flex;flex-direction:column;gap:12px;}` `.applied-card.hidden{display:none;}`.
- [ ] **Step 5: Wire Room-mode → Room tab.** In room.js where `roomMode` flips on, call `window.showPanelTab && showPanelTab('room')`; where it flips off, `showPanelTab('fabrics')`. Read room.js's toggleRoomView first; add these calls alongside the existing `#panel-room` show/hide (do not remove that yet — Task 3 deletes the old panel-swap once the Room tab fully owns it).
- [ ] **Step 6: CSS for tabs + panel** — `.panel-tabs{margin:12px;}`, `.panel-context{padding:0 16px 8px;font:500 12px/16px var(--font-sans);color:rgb(var(--md-on-surface-variant));}`, `.applied-card` uses card grammar. Panel surface `--md-surface`.
- [ ] **Step 7: Gate.** `node --check src/boot.js src/room.js`; smoke 7/7. Drive: click each tab → correct body shows; enter room → Room tab auto-activates; applied card hides on Room tab, shows on Fabrics; sliders still adjust material; swatch click applies. Screenshots. **Commit** `redesign: tabbed tool panel scaffold (Fabrics/Room/Parts)`

### Task 3: Room tab owns room controls — delete the floating tray (HIGHEST RISK)

**Files:**
- Modify: `index.html` (`#room-tray` at ~142 → contents into the Room tab body; delete tray)
- Modify: `src/room.js`, `styles/app.css`, `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 `showPanelTab`, `data-tab="room"` body.
- Produces: room controls (Living/Bedroom `.seg`, element chips, curtain config, bed-style) all inside `data-tab="room"`; `#room-tray` gone.

- [ ] **Step 1: Read** `#room-tray` (index.html ~142) and the Task-5 wiring in `src/room.js` that toggles `#room-tray.on` in `toggleRoomView`. Inventory the tray's children: Living/Bedroom switch (`rsec-living/rsec-bedroom`), element chips (`chip-walls/floor/windows/doors/rug/ceiling/curtains-living/curtains-bedroom`), bed-style (`chip-bed-wooden/fabric`), and the `#rsec-living-content`/`#rsec-bedroom-content` wrappers.
- [ ] **Step 2: Move tray contents into the Room tab body** (`data-tab="room"`), preserving every id + onclick + the `#rsec-*-content` show/hide structure. The curtain config (`#curtain-config-panel`) already lives in `#panel-room` → now the Room tab; keep it. Result: the Room tab contains section switch + element chips + curtains + bed-style, all in the sidebar panel, nothing floating.
- [ ] **Step 3: Delete `#room-tray`** markup and its CSS rules (`#room-tray`, `.room-tray*`). In room.js, delete the `#room-tray.classList.toggle('on', roomMode)` line (from Task 5) — the Room tab activation from Task 2 now handles room-mode surfacing.
- [ ] **Step 4: Collapse the old panel-swap.** Now that Task 2 routes room mode to the Room tab, remove the legacy `#panel-product`/`#panel-room` `display` swap in room.js IF it is now redundant with the tab system — but the smoke test asserts `#panel-room` visibility. Update `test/smoke.mjs`'s `roomPaneVisible`/exit checks to instead assert the Room tab is active (`document.getElementById('ptab-room')?.classList.contains('active')`) on enter and inactive on exit, in THIS commit. Keep `#panel-room` as the `data-tab="room"` body's id if convenient so less churn — decide during implementation and make the smoke assertion match reality.
- [ ] **Step 5: Restyle** the moved controls with periwinkle discipline: Living/Bedroom `.seg`; element chips as quiet outline pills that fill `--md-primary-container` (not solid primary) when `.on`; bed-style `.seg`.
- [ ] **Step 6: Gate.** `node --check src/room.js`; smoke 7/7 (0 SKIP). Full room drive: enter room → Room tab shows controls, NOTHING floats over canvas; toggle walls/floor/curtains (meshes hide/show); Living↔Bedroom switch; bed-style switch; curtain shape change; exit room → Product view, canvas fully clean. Screenshots product+room — verify the 3D scene is unobstructed. **Commit** `redesign: room controls into Room tab, delete floating tray`

### Task 4: Parts tab + model picker relocation

**Files:**
- Modify: `index.html` (model picker `.seg--models` from its Task-1 holding spot → Parts tab; ensure mesh-list/piece-list/move-mode in Parts body), `styles/app.css`, possibly `src/room.js`/`src/boot.js` if they query the picker location

**Interfaces:**
- Consumes: Task 2/3 tabs.
- Produces: Parts tab (`data-tab="parts"`) containing model picker + zone list + move mode.

- [ ] **Step 1: Move the model picker** (`.seg--models` with `tab-chair`/`tab-sofa`/`tab-bed_fabric`, `switchModel` onclicks verbatim) from the Task-1 holding spot into the top of the Parts tab body. Restyle as a full-width `.seg` or a stacked selectable list — periwinkle fill only on the active model.
- [ ] **Step 2: Confirm** `#mesh-list`, `#piece-list`, `#move-mode-bar` sit in the Parts body (`data-tab="parts"`). Keep ids (smoke asserts `#mesh-list`; render logic depends on the item nodes — restyle only).
- [ ] **Step 3: Verify JS.** `grep -n "tab-chair\|seg--models\|querySelector.*prod-tab" src/*.js` — nothing should depend on the picker's DOM location; `switchModel` toggles `.active` by id. Fix any location-coupled query.
- [ ] **Step 4: Context line** (`#panel-context`) shows the current model name + zone count on all tabs (already wired to `#zone-count-badge` content in Task 2 — extend to include model name from the active `switchModel`).
- [ ] **Step 5: Gate.** `node --check`; smoke 7/7. Drive: Parts tab shows model picker + zones; switch chair→sofa→bed (viewport + library update, applied materials remembered); zone select; move mode. Screenshots. **Commit** `redesign: Parts tab with model picker + zone list`

### Task 5: Periwinkle discipline + 3-across grid + motion + dead-CSS + full drive

**Files:**
- Modify: `styles/app.css`, `index.html`, possibly `src/library.js` (confirm grid), `src/boot.js`

- [ ] **Step 1: Periwinkle audit + discipline.** `grep -n "md-primary)" styles/app.css` — for every control that fills solid `--md-primary`, decide: is it THE primary in its context (active nav, active tab, primary CTA, active model, selected swatch ring)? If not, demote to ghost/outline (`--md-surface`/`--md-outline-variant` border, `--md-on-surface` text, `--md-primary-container` for a soft "on/selected" state). Element chips, filter chips, secondary buttons all become quiet. List the demotions in the commit body.
- [ ] **Step 2: 3-across grid.** `.lib-grid{grid-template-columns:repeat(3,1fr);}` (was 4). Ensure each `.bar-sw` shows its fabric name label (add the name span in `buildLibrary` if the 4-across variant hid it — read library.js; if names already render, CSS-only). Larger swatch min-height, `--space` gaps.
- [ ] **Step 3: Muted chrome.** Panel + rail surfaces confirmed `--md-surface`/`--md-surface-container-low` (not pure bright white where it competes with the model); canvas `--md-surface-dim`.
- [ ] **Step 4: Motion.** Tab body cross-fade (`.panel-tab-body.on{animation:fadeIn var(--dur-base) var(--ease-motion);}` + keyframes opacity/translateY 4px→0); nav accent bar already transitions; swatch apply confirm pulse (a brief `--md-primary` ring scale on the just-applied `.bar-sw`, added in the apply handler or via a transient class — keep it CSS/one-line, no behavior change). All ≤220ms.
- [ ] **Step 5: Dead-CSS sweep.** Grep every remaining selector/var in `styles/*.css` against `index.html`+`src/*.js`; delete zero-match rules (the old `.topbar`, `.seg--view`, `.room-tray*`, `#room-tray` rules must be gone). List deletions in commit body.
- [ ] **Step 6: FULL 18-FEATURE DRIVE** (zero-feature-loss guarantee for the whole restructure): temp `test/t5-drive.mjs`, exercise each FEATURES.md feature once (model switch, library browse/search/filter, zone select, click-apply, drag-drop apply, sliders, texture replace, finder search, finder AI chrome, my-fabrics, GLB upload picker, room enter/exit, room element toggles, curtains/blinds, explode [internal — note], AI render fires 402-tolerated, export GLB, viewport nav + move mode, tour). Report a 18-item checklist. DELETE the temp script before commit.
- [ ] **Step 7: Gate.** `node --check`; smoke 7/7; the 18-drive; screenshots product+room+narrow (drawer). **Commit** `redesign: periwinkle discipline, 3-across grid, motion, dead-CSS purge`

## Verification per task
`node test/smoke.mjs` (7 PASS / 0 FAIL / 0 SKIP) + `node --check` on edited JS + the task-specific scripted drive + before/after screenshots to scratchpad. Server for drives: `node test/serve.mjs <port>` (S3 fallback active; AI endpoints 402 until Vercel re-enabled).
