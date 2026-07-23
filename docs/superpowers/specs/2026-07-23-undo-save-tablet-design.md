# Undo/Redo/Reset + Local Save Design + Tablet Polish — Design

**Date:** 2026-07-23 · **Branch:** `feat/design-history-tablet` · **Approved by founder:** yes (design summary approved in session)

## 1. Problem

The simulator has no way to step back from a design edit, no working Reset
control (`resetAll()` exists in `src/features/configurator/model.js` but no
button calls it), and no way to keep a design — the "Saved" nav-rail item in
`index.html` is a dead placeholder with an empty `onclick`. On iPads the
≤1024px slide-over drawer works but feels like a shrunken desktop: hover-only
affordances, small touch targets, and the drawer engages even in landscape
where there is room for a persistent panel.

## 2. Founder decisions (locked)

| Question | Decision |
|---|---|
| Undo scope | **Design edits only**: fabric applies, base color, slider commits, curtain edits. Product/model switch **clears** history. Room-mode toggle is not an undo step. |
| Reset meaning | **Reset current product** to factory finish (default fabrics, sliders, curtain). Stays on the product. Reset is itself undoable. |
| Tablet | **Polish the existing drawer approach for iPad** — no new layout paradigm. |
| Save design | **Named saves + Saved panel**, stored locally (localStorage), per signed-in user. |

## 3. Core architecture — one canonical `DesignState`

Applied fabrics live imperatively on Three.js meshes
(`E.meshEntries[].appliedFabric`, material objects), not in `appStore`. The
existing `saveMaterialSnapshot()` clones live materials and is **not**
serializable. Instead of extending it, we introduce one serializable state
shape and one replay function; Undo, Redo, Reset, Save, and Load are all the
same primitive.

### 3.1 `DesignState` (JSON, versioned)

```js
{
  v: 1,
  productKey: 'chair' | 'accent_chair' | 'sofa',
  // part group name (entry.name, stable per model) → fabric reference or null
  parts: { [partName]: FabricRef | null },
  baseColorHex: '#ffffff',
  sliders: { brightness, roughness, metalness, sheen, scale, norm },
  curtain: { shape, fabric, color, widthFactor, lengthFactor } | null,
}
```

`FabricRef` identifies a library item:

- Catalog item: `{ kind:'lib', name, group }` — resolved against
  `LIBRARY[productKey]` at apply time (names are stable in `src/lib/catalog.js`).
- Custom item: `{ kind:'custom', item }` — the **full item embedded by value**
  (name, img/diffUrl data-URLs, `_defaults`). Custom fabrics already carry
  data-URLs, so a saved design survives reload even if the finder item is gone;
  on load, missing customs are re-registered via `addCustomFabric` +
  `buildLibrary()`.

### 3.2 New module `src/lib/design-state.js`

- `captureDesignState()` — read current state from `appStore` +
  `E.meshEntries` (group entries by name as the UI does; record each group's
  applied fabric as a `FabricRef`).
- `applyDesignState(state, { silent = true })` — replay through **existing
  apply paths**: `applySwatchToEntries(item, entriesOfGroup)` per part,
  slider appliers (`updateBrightness`, `applyProp`, `updateTexScale`,
  `updateNormScale`), `setBaseColor`, curtain setters. Serialized through an
  internal queue (applies are async texture loads) so rapid undo presses
  cannot interleave. `silent` suppresses the "applied!" toasts.
- `defaultDesignState(productKey)` — factory finish for Reset.
- Resolution failures (renamed catalog item) skip that part and surface one
  toast: "Some fabrics in this design are no longer available."

Pure serialization/diff logic is unit-testable in node (no Three.js import in
capture/apply signatures beyond what's injected).

### 3.3 History `src/lib/history.js`

- Undo/redo stacks of `DesignState` snapshots, cap 50, in-memory only.
- `record()` is called **after** each committed design edit: fabric apply
  (incl. drag-drop and seamless-texture apply), base-color change, slider
  **release** (drags coalesce — record on `change`/pointerup, not per input
  tick), curtain edits, Reset.
- `undo()` / `redo()` apply the neighbouring snapshot via
  `applyDesignState`; a guard flag prevents replay from re-recording.
- Product switch and GLB upload call `clear()`. Room-mode toggle does **not**
  clear (curtain edits made in room mode remain undoable; part applies in
  room mode target the same active product and are recorded too).
- Store-connected: `canUndo()/canRedo()` drive button disabled state.

### 3.4 Reset

Canvas-CTA Reset button → `applyDesignState(defaultDesignState(currentKey))`
+ `record()`. The legacy unwired `resetAll()` stays for room-view internals it
serves; the user-facing Reset is the new path.

## 4. Save Design (local)

### 4.1 Storage `src/features/saved/saved-store.js`

- Key: `livinit_sim_designs_v1:<userEmail>` (from `auth.getSession()`).
- Record: `{ id, name, createdAt, updatedAt, productKey, thumb, state }`
  where `thumb` is a ~240px JPEG data-URL from the WebGL canvas
  (`renderer.domElement`, drawn into an offscreen canvas; requires
  `preserveDrawingBuffer` handling — capture immediately after a
  `markDirty()`-forced render).
- Quota guard: writes wrapped in try/catch; on `QuotaExceededError` show a
  toast telling the user to delete old designs. Soft cap 30 designs/user.
- **Uploaded-GLB designs cannot be saved** (geometry can't live in
  localStorage). Save button disabled with tooltip "Saving works for catalog
  products only" when the current model is a user upload.

### 4.2 UI `src/features/saved/saved-panel.js`

- **Save**: pill button in `.canvas-cta` → small dialog (name prefilled
  "Chair — 23 Jul"), saves, toast confirms.
- **Saved panel**: the existing nav-rail "Saved" item opens a panel (same
  slide-over/panel grammar as the config panel) listing cards — thumbnail,
  name, product label, relative date — with Load, Rename, Delete
  (Delete confirms inline, no browser `confirm()`).
- **Load**: switches product if needed (await model load), then
  `applyDesignState(state)`; history is cleared then seeded with the loaded
  state.

## 5. Undo/Redo/Reset UI

- Compact icon cluster prepended to `.canvas-cta` (`index.html:278`):
  undo ↶, redo ↷, reset ⟲ — 40px hit targets, disabled state at stack ends,
  tooltips with shortcut hints.
- Keyboard: `Cmd/Ctrl+Z` undo, `Shift+Cmd/Ctrl+Z` and `Ctrl+Y` redo. Ignored
  while focus is in an input/textarea/dialog.

## 6. Tablet polish (768–1194px, `pointer: coarse`)

1. **Landscape iPad (≥1000px)**: persistent 320px config panel (no drawer) —
   adjust the current `@media (max-width:1024px)` drawer breakpoint to
   `max-width:999px`; add a `1000–1194px` tier with the narrower panel.
2. **Touch targets**: swatches, seg-chips, nav-rail items, slider thumbs ≥44px
   under `(pointer: coarse)`.
3. **Hover-dependent UI off on touch**: hover-zoom lens and
   `.vp-controls` mouse hints hidden under `(hover: none)`; drag-to-apply
   swatch path gains pointer/touch events (currently `mousedown` only in
   `library.js:151`).
4. **Safe areas**: drawer, canvas CTA, sidebar-toggle already partly handled —
   extend to the new cluster and Saved panel.
5. Verified at 768 / 834 / 1024 / 1180 widths via puppeteer viewport checks +
   Chrome device emulation.

## 7. Testing

- **Unit (node:test, like `test/admin-store.test.mjs`)**: history stack
  (record/undo/redo/cap/clear semantics), DesignState
  serialize/resolve/round-trip, saved-store CRUD + quota path (localStorage
  shim exists).
- **Smoke (puppeteer, extend `test/smoke.mjs` pattern)**: apply fabric → undo
  → redo → reset; save → reload page → load design → screenshot; viewport
  sweep at the four tablet widths asserting panel mode + no horizontal
  overflow. Note: the harness serves locally via `test/serve.mjs`; runtime
  textures fall back to public S3.
- Every check prints PASS/FAIL like existing checks.

## 8. Out of scope

- Cloud/server persistence of designs (multi-tenant backend plan covers this
  later; localStorage shape is versioned `v:1` for future migration).
- Undo for room layout (furniture placement), model switches, room-mode
  toggles.
- Saving designs for uploaded GLBs.
- Phone (<640px) rework beyond not regressing the existing pass.
- Migrating mesh/material state into `appStore` (store migration continues
  separately per the refactor spec).
