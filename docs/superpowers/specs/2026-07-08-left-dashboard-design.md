# Left-Dashboard Redesign Design

**Date:** 2026-07-08
**Why:** Founder finds the current right-sidebar "Sidebar-everything" layout hectic — in room mode the floating room-controls tray covers the 3D scene, the top bar carries ~11 controls, and every control is a filled periwinkle pill so nothing leads the eye. Decision: restructure into a left-side dashboard shell (left icon nav rail + one tabbed tool panel + clean edge-to-edge canvas) and apply frontend-design discipline. This supersedes the layout of `2026-07-07-livinit-redesign-design.md`; the design-system foundation (tokens, fonts, primitives) from that pass is kept and reused.

## Goal

A calm, premium configurator where the 3D model is the hero and the tools are a quiet dashboard around it. Zero feature loss — this re-parents existing controls into a new shell; it does not change behavior, the store/actions, the three.js pipeline, or the catalog.

## Constraints

- Vanilla classic-script JS + hand CSS, no bundler/framework (unchanged).
- ZERO FEATURE LOSS: all 18 FEATURES.md features work identically after every task.
- Reuse the existing Livinit design system: `--md-*` role tokens (RGB triples), Eudoxus Sans, `--elev-*`, `--r-*`, `--dur-*`, and the primitives `.seg/.seg-chip`, `.pill-btn/--primary/--ghost`, `.glass-pill`, card grammar. Do NOT reinvent tokens.
- Store/actions (`appStore`, `src/actions.js`) untouched. Existing ids + onclick handlers preserved when markup is re-parented.
- Smoke gate (`node test/smoke.mjs`, 7 checks) green after every task; the smoke selectors (`.bar-sw`, `#fabric-grid`, `#finder-overlay`, `#loading`, `#mesh-list`, `#panel-room`) stay stable or the test updates in the same commit.
- Light mode only (dark roles defined, not wired). No external hosts.
- Branch `refactor/architecture`. NEVER push. No Co-Authored-By trailer.

## Design principles (frontend-design lens)

1. **Periwinkle discipline.** Filled periwinkle (`--md-primary`) is reserved for the ONE primary element in context: the active nav item, the active tab, the primary CTA (AI Render / Get A Quote). Every other control is quiet — ghost or outline on neutral surfaces (`--md-surface`, `--md-surface-container-low`, `--md-outline-variant`). This is the core fix for "hectic."
2. **Named navigation, not mystery-meat icons.** Rail items show an icon AND a label; the active item gets a left accent bar + `--md-primary-container` tint. No icon-only guessing.
3. **The model is the hero.** Chrome surfaces are muted (`surface-container-low`), never bright white, so the lit 3D model is the brightest thing on screen. Nothing ever floats over the model except tiny transient HUDs.
4. **Curated catalog, not a spreadsheet.** Fabric grid goes 4-across → **3-across** with the fabric name always visible; larger swatches, more gap, bigger tap targets.
5. **Browse vs adjust are separate zones.** Applied-material + sliders live in a pinned card ABOVE the swatch grid, visually distinct from the browse grid.
6. **No dedicated top bar.** The bar is removed. Get A Quote + View in My Room float as a small `.glass-pill` cluster top-right over the canvas; context ("Sierra Chair · 3 zones") is quiet meta text at the top of the tool panel.
7. **Motion with intent.** Tab switch = cross-fade; nav selection = animated accent bar; swatch apply = subtle confirm pulse. 150–200ms (`--dur-fast`/`--dur-base`) ease-out (`--ease-motion`). Keyboard `:focus-visible` periwinkle ring already global.

## Shell layout

```
┌──────┬──────────────────────────┬──────────────────────────────────┐
│ ▦    │ [Fabrics][Room][Parts]   │                  ╭──────────────╮ │
│livnit│ ──────────────────────── │                  │ View · Quote │ │  ← floating CTA cluster
│      │ Sierra Chair · 3 zones   │                                   │
│ 🖥    │ ┌── Applied ──────────┐  │        3D CANVAS                  │
│ Prod │ │ swatch · sliders     │  │     (edge-to-edge, clean,        │
│      │ └──────────────────────┘  │      model is the hero)          │
│ ⌂    │ Search…                  │                                   │
│ Room │ All·Fabric·Vinyl…        │                                   │
│      │ ▦ ▦ ▦   (3-across)       │                                   │
│ ▤    │ ▦ ▦ ▦   named swatches   │                  ╭──────────────╮ │
│ Save │ ▦ ▦ ▦                    │                  │ orbit · zoom │ │  ← bottom glass hint
│      │ ──────────────────────── │                                   │
│ ⚙ AR │ [ AI Render ][ Export ]  │                                   │
└──────┴──────────────────────────┴──────────────────────────────────┘
  72px       ~360px tool panel                  big canvas
```

### Left nav rail (~72px)
Vertical, `--md-surface` with right border `--md-outline-variant`. Top: `livinit` mark. Nav items (icon + label, stacked): **Product**, **Room**, **Saved**. Bottom-anchored: **Settings/theme**, **AR/avatar**. Active item = left accent bar (3px `--md-primary`) + `--md-primary-container` tint + primary-colored icon; inactive = `--md-on-surface-variant`, hover lifts to `--md-on-surface`. Product/Room switch view mode (calling the existing `toggleRoomView` path) AND auto-focus the matching panel tab. Saved keeps its current handler. Every icon is inline 24-grid SVG (stroke 2.2, currentColor) — consistent with the Task 7 sweep.

### Left tool panel (~360px)
`--md-surface`, flex column, `min-height:0`. Structure top→bottom:
- **Tab bar** (`.seg` segmented control): Fabrics · Room · Parts. Active tab = periwinkle fill. Room tab disabled/dimmed in Product mode; entering Room mode focuses it.
- **Context line:** quiet meta text — current model + zone count (moved from the old top-bar badge).
- **Applied card** (pinned, card grammar): current applied fabric thumbnail + name + the adjustment sliders. This is the "adjust" zone. Present on Fabrics and Parts tabs.
- **Tab body** (scrolls, `flex:1 overflow-y:auto`):
  - *Fabrics:* search (`.lib-search`), filter chips (`#fabric-tabs`), the 3-across swatch grid (`#fabric-grid`, `.bar-sw` + `data-fabric-key` verbatim) with sticky collection headers. `+ Add Fabric` / My-Fabrics tiles lead the grid.
  - *Room:* Living/Bedroom `.seg` switch + element toggle chips (`chip-walls/floor/windows/doors/rug/ceiling/curtains-*`, ids+onclicks verbatim) + curtain config (`#curtain-config-panel`) + bed-style picker. **This is where the floating tray content goes — the tray over the canvas is deleted.**
  - *Parts:* model picker (Sierra Chair / Haven Sofa / Fabric Bed — moved here from the top bar; ids `tab-chair/sofa/bed_fabric` + `switchModel` onclicks verbatim, restyled as a `.seg` or stacked list) + zone/part list (`#mesh-list`, `#piece-list`) + move-mode controls.
- **Pinned footer** (`.side-footer`): AI Render (`.pill-btn--primary`) + Export GLB (`.pill-btn`), verbatim handlers.

### Canvas
Edge-to-edge, `--md-surface-dim` neutral. Floating glass clusters only: top-right = View in My Room + Get A Quote (`.glass-pill`); bottom-center = orbit/zoom hint + zoom; move-mode HUD when active. Loading overlay `#loading` keeps its id + `.on` contract. **No panel or tray ever overlaps the model.**

## Control inventory (old → new home)

| Control | Old location | New home |
|---|---|---|
| Product/Room view toggle | top bar segmented | left rail nav items |
| Saved | top bar | left rail |
| Settings/theme, AR/avatar | top bar | left rail (bottom) |
| Model picker (Chair/Sofa/Bed) | top bar segmented | Parts tab |
| Zone count badge | top bar | panel context line |
| Fabric search / filters / grid | right sidebar | Fabrics tab (3-across) |
| Applied material + sliders | right sidebar cards | pinned Applied card |
| Room section + element chips + curtains | floating canvas tray | Room tab (tray deleted) |
| Zone/part list, move mode | right sidebar | Parts tab |
| AI Render, Export GLB | sidebar footer | panel footer (kept) |
| View in My Room, Get A Quote | top bar | floating glass cluster (canvas top-right) |
| GLB upload | top bar | left rail (under Product) or Parts tab overflow |

## Files touched

- `index.html` — re-parent markup into rail / panel-tabs / floating clusters; delete the old `.topbar` and the room `#room-tray`.
- `styles/app.css` — rail, tab-panel, tab-body, applied card, 3-across grid, floating clusters; delete dead top-bar/tray rules.
- `src/boot.js` — tab switching (`showPanelTab(name)`), rail-nav ↔ view-mode ↔ tab wiring, GLB-upload trigger relocation.
- `src/library.js` — grid stays `#fabric-grid`; 3-across is CSS-only (no JS change beyond confirming).
- `src/room.js` — the room-mode show/hide currently toggles `#panel-room` and (Task 5) `#room-tray`; rewire to activate the Room tab instead of the tray; delete tray toggling.
- `src/tour.js` — retarget any steps that point at the old top bar / tray to the rail / panel tabs.
- `test/smoke.mjs` — update any selector that assumed the old chrome (e.g. room-pane visibility) to the new panel/tab structure, same commit as the markup.

## Staging (each = own commit, smoke-gated + scripted-drive)

1. **Dashboard shell + left rail.** Build the rail (nav items, active states, view-mode wiring), collapse the top bar's nav into it, float View/Quote as a glass cluster. Model picker temporarily stays reachable until Task 3.
2. **Tabbed tool panel scaffold.** Move the right sidebar to the left as a tabbed panel (Fabrics/Room/Parts); wire `showPanelTab`; pinned Applied card + footer. Fabrics tab = existing grid.
3. **Room tab (delete the floating tray).** Move section switch + element chips + curtains + bed-style into the Room tab; rewire room-mode to activate the tab; delete `#room-tray`. Highest-risk — full room drive.
4. **Parts tab + model picker relocation.** Model picker (Chair/Sofa/Bed) + zone list + move mode into Parts tab; remove from old top bar.
5. **Periwinkle discipline + 3-across grid + polish.** Apply the accent-restraint rule across all controls; grid 4→3-across with names; motion (tab cross-fade, nav accent, apply pulse); dead-CSS sweep; full 18-feature drive.

## Risks

- **Room-mode rewire (Task 3):** the tray→tab move must keep room-mode show/hide wired to the same `toggleRoomView` mechanism; the smoke room-view check asserts `#panel-room` visibility — update it to the Room-tab-active signal in the same commit. Highest regression risk; own commit + full room drive.
- **Tab state vs view mode desync:** Product/Room rail nav, the Room tab, and `roomMode` must stay consistent — one source of truth (the store's `roomMode` + a panel-active-tab variable); the rail and tab bar render from it, they don't hold independent state.
- **AI endpoints still 402** until Vercel is re-enabled — finder AI / AI Render chrome verifiable, network not.
