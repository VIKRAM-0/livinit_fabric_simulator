# Fabric Configurator — Livinit Redesign Design

**Date:** 2026-07-07
**Decided with founder:** full relayout to the Livinit *studio editor* grammar, stay vanilla (no build step), pure redesign (zero feature change), "Sidebar-everything" layout.

## 1. Goal

Make the configurator look and feel like part of the Livinit product family — specifically the `/studio` editing surface of web-pipeline — while preserving every existing feature and mechanic. The previous refactor (Tasks 1–9, complete) was deliberately invisible; this pass is the visible one. The deliverable is the look: after this ships, the app must be *obviously* different.

## 2. Constraints

- Vanilla JS classic scripts + hand CSS, no bundler, no framework (unchanged from refactor).
- ZERO FEATURE LOSS: all 18 features in FEATURES.md work identically. Mechanics (drag-drop, click-apply, finder flows, sliders, room mode, export) unchanged; only markup structure, CSS, and render targets move.
- Store/actions architecture untouched.
- Smoke gate (`node test/smoke.mjs`, 7 checks) green after every commit; DOM anchors the tests use (`.bar-sw`, `#finder-overlay`, `#loading`, zone list) either stay stable or the test updates in the same commit.
- No external hosts for fonts/icons: Eudoxus Sans woff2 copied into the repo; icons are inline SVG.
- Light mode only this pass (dark roles are defined in the token source and can follow later).
- Branch: continue on `refactor/architecture`. NEVER push. No Co-Authored-By trailer.

## 3. Design language (ported from web-pipeline, verified 2026-07-07)

Source of truth: `web-pipeline/lib/design-system/tokens/*` and studio components. Key values (see the extraction in this spec's history for file:line refs):

**Color roles (light), stored as RGB triples for alpha compositing** (`rgb(var(--md-primary) / 0.06)` pattern):
- primary `#5870D6` (88 112 214) — functional primary (AA with white text). Brand periwinkle `#7A91EE` kept as `--primary-400` for decorative use only. on-primary white; primary-container `#ECEFFD`; on-primary-container `#05164B`.
- background/surface `#FFFFFF`; on-surface `#101C2D` (brand navy); surface-variant `#F1F4F9`; on-surface-variant `#66768E`; surface-container-low `#F9FAFB`; surface-container `#F1F4F9`; surface-container-high `#EAEEF5`; surface-container-highest `#DDE4EE`; outline `#CCD4E0`; outline-variant `#DDE4EE`.
- Status: success `#15803D`, warning `#C2550C`, error `#F34040`.

**Shadows** — navy-tinted (`16 28 45`), never black. Elevation 1: `0 1px 2px /.06, 0 1px 3px /.04`; 2: `0 2px 6px /.08, 0 1px 2px /.05`; 3: `0 6px 16px /.10, 0 2px 6px /.06`.

**Radius:** 4/8/12/16/24/9999. Everything interactive is a pill (`border-radius:9999px`); cards/panels 16–24px.

**Type:** Eudoxus Sans (400/500/700/800 woff2 copied from `web-pipeline/public/fonts/`), body base 14px. Roles used: title-lg 22/28 (panel headings), title-md 16/24 (card titles), body-md 14/20 (buttons/descriptions), label-lg 14/20 (button text), label-md 12/16 +.04em (chips/prices), label-sm 11/16 +.04em (eyebrows, uppercase tracking .12em).

**Glass recipes:** top bar `rgba(255,255,255,.88)` + `backdrop-filter: blur(18px)` + bottom border outline-variant; canvas overlay pills `surface/70` + `blur(20px)` + border `outline-variant/60` + elevation-2 + full radius, padding ~14×8; modal scrim `rgba(16,28,45,.5)` + `blur` with `rounded-3xl` surface + elevation-3.

**Controls:** segmented control = `surface-container` full-radius track, `p-1`, gap 4; chips full-radius, label-lg medium, on-surface-variant; active chip = primary fill, on-primary, semibold, elevation-1. Primary button = primary fill pill, elevation-1→3 on hover, translate-y -0.5, active scale .97; heights 36/44/52.

**Skeletons:** `surface-container-high → highest` shimmer, 200% background-size, ~1.5s ease-in-out infinite.

**Motion:** 140/220/420ms, `cubic-bezier(0.2,0.8,0.2,1)`.

**Icons:** inline 24-grid SVG, `fill:none; stroke:currentColor; stroke-width:2.2; round caps/joins`, rendered 16px in chrome. Replaces all emoji glyphs.

## 4. Layout spec

```
┌──────────────────────────────────────────────┐
│ ◉ Livinit  [Chair|Sofa|Bed]       (Room View)│  frosted top bar
├────────────────────────────┬─────────────────┤
│  (zoom)(reset) overlay     │ Fabrics    ⌕    │
│      pills only            │ ▦ ▦ ▦ ▦         │  380px sidebar:
│        3D VIEWPORT         │ ▦ ▦ ▦ ▦  grid   │  swatch grid +
│      (clean canvas)        │ ─────────────   │  applied/sliders +
│                            │ Applied ▸ sliders│  curtains (room) +
│                            │ [ AI Render ]   │  CTA footer tray
└────────────────────────────┴─────────────────┘
```

**Top bar** (fixed, frosted): brand mark + "Fabric Studio" wordmark left; model segmented control (Chair / Sofa / Bed — bed variant picker appears contextually as today); right cluster: Room View toggle pill, View-in-My-Room pill, overflow menu (pill icon button) for GLB upload + Reset.

**Right sidebar, 380px** (`surface`, `border-left: outline-variant`), studio panel skeleton (header / scroll body / footer tray):
- Header: "Fabrics" title-lg + label-md subtitle; search input; horizontally scrollable filter chips (existing category filters).
- Scroll body: swatch grid, 4 per row, sticky collection headers (`surface/95` + blur), each swatch a rounded-12 tile with shimmer skeleton until its thumbnail loads. Swatches keep class `.bar-sw` and `data-fabric-key` (smoke + active-state contract). "My Fabrics" and "+ Fabric Finder" entries live at the top of the grid as tiles.
- Below grid (collapsible cards, card grammar `surface-container-low`, rounded-16, outline-variant border, elevation-1): **Applied material** block + **Material adjustments** sliders (rendered by `src/panels.js` templates, one instance — the product/room duplication collapses since there is now a single sidebar); **Curtains** section (shape/fabric/color/size) mounts in room mode.
- Footer tray (`surface-container-low`, top border, elevation-2): AI Render (primary pill) + Export GLB (secondary pill).

**Canvas**: edge-to-edge. Overlay pills (glass recipe): viewport controls top-left; move-mode HUD bottom-center (existing controls, restyled); room mode adds a floating tray top-center with Living/Bedroom segmented control + room-element chips. Explode slider becomes a slim glass pill bottom-left.

**Room mode**: entering Room View keeps the same sidebar (fabrics still apply per-piece); curtain section appears; room-element toggles live on the canvas tray, not the sidebar.

**Finder modal**: same flows/ids, reskinned — `rounded-3xl` surface, elevation-3, scrim+blur backdrop, segmented tabs, pill buttons, label typography.

**Tour**: same steps, restyled tooltip cards (card grammar + elevation-3).

**Narrow (<1024px)**: sidebar becomes a right slide-over drawer (340px, max-width 85vw, elevation-3) toggled by a floating "Fabrics" glass pill bottom-right; canvas otherwise unchanged. No mobile-specific feature changes.

## 5. What does NOT change

Feature list and mechanics (all 18), store/actions, three.js pipeline, API endpoints, test harness architecture, catalog data. `buildLibrary` keeps building the same swatch elements — only its container, grouping markup, and CSS change. Drag ghost keeps `position:fixed` coordinates (container-agnostic; verify).

## 6. Staging & verification

One commit per stage, each `node --check` + full smoke gate + screenshot pair (before/after per stage, saved to scratchpad):

1. **Tokens + fonts**: rewrite `styles/tokens.css` to role tokens (RGB-triple custom properties), add `fonts/` + `@font-face`, map existing rules' consumption. App restyles globally (font/colors) but layout unchanged. Update legacy token references in `app.css`.
2. **Top bar**: new frosted bar markup + segmented model control (replaces current tabs); wire to existing `switchModel`/room handlers.
3. **Sidebar + library migration** (highest risk, most careful gate): move library render target into sidebar grid, sticky headers, search/filter chips, skeletons; delete bottom bar; verify drag-drop + click-apply + active swatch + smoke selectors.
4. **Panels into sidebar**: applied/sliders cards via `panels.js` single instance; curtain section relocation; footer tray CTAs.
5. **Canvas overlays**: viewport pills, room tray (Living/Bedroom + element chips), move HUD, explode pill.
6. **Finder + modals + tour reskin.**
7. **Polish pass**: icons swept to inline SVG, motion, focus rings, narrow-window drawer.

Smoke additions in stage 3: assert sidebar grid populated (replaces bar assertion), drag-ghost element exists, sliders present. Keep 7-check contract shape.

## 7. Risks

- **Library migration** (stage 3): `buildLibrary` DOM assumptions, drag ghost math, filter logic. Mitigation: own commit, expanded smoke checks, manual click-through on the running app.
- **Smoke selector drift**: every stage runs the gate; selectors updated in the same commit as the markup they anchor.
- **CSS scope bleed**: old `app.css` rules target current markup; stages that move markup must migrate/delete the matching rules to avoid zombie styles. Final polish includes a dead-CSS sweep.
- **AI endpoints still 402**: finder analysis/AI render can't be end-to-end verified until Vercel is re-enabled; their *chrome* is still verifiable (modal opens, states render).
