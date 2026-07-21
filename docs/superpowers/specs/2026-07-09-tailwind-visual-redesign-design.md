# Asset Designer — Tailwind Visual-Identity Redesign (Design)

Date: 2026-07-09
Branch: refactor/architecture (local only, never pushed)

## 1. Goal

Lift the app from "generic config tool" to a distinctive, robust visual identity across all four surfaces — **Product (default), Room, Finder modal, Parts** — plus a **working mobile layout**. Founder brief: "design system looks very bad… use Tailwind… make it very robust." Adopt Tailwind (Play CDN) as the styling engine while preserving the just-completed ES-module architecture and zero-build constraint.

## 2. Approach & constraints

- **Tailwind Play CDN** (`<script src="https://cdn.tailwindcss.com">`) in `<head>` with an inline `tailwind.config` that maps the existing DS tokens (Eudoxus Sans, periwinkle `#7A91EE` primary, `--md-*` role colors, radius, spacing) into Tailwind's theme. No build step. (Caveat accepted by founder: Play CDN is "not for production" — FOUC/runtime weight; upgrade path is Tailwind CLI compiling the same classes, no rewrite.)
- **`@apply` component layer, NOT utility-soup markup.** The app builds most UI from JS (`library.js` swatches, `panels.js` sliders, `room.js`/`finder.js` panels) and JS *logic queries/toggles* class names (`.bar-sw`, `.active`, `.on`, `.panel-tab-body`). So we KEEP those semantic class hooks and redefine their appearance with Tailwind utilities via `@apply` inside a `<style type="text/tailwindcss">` block. **JS files are NOT modified.** This is the safety spine of the redesign.
- `styles/tokens.css` stays as the raw token source (CSS vars); `tailwind.config` references those vars so Tailwind utilities and tokens stay in sync. `styles/app.css` component rules are progressively replaced by the `@apply` layer (layout/structural rules that don't need redesign may remain).
- **ZERO FUNCTIONAL REGRESSION.** All 18 features work; smoke test 7/7 after every surface; JS hooks (ids, stateful classes, `.bar-sw`, `.panel-tab-body[data-tab]`, `.active`, `.on`) preserved exactly.
- No push, no Co-Authored-By trailer.

## 3. Visual language (the redesign)

Design tokens already present (keep, refine): Eudoxus Sans; primary periwinkle `#7A91EE` / functional `#5870D6`; `--md-*` role colors; navy-tinted elevations. New/enforced language:

- **Segmented controls** (`.seg`, `Living Room/Bedroom`, `Fabrics/Room/Parts`): flat gray track + white-chip active with soft shadow — NOT filled-primary+outlined. (Founder's stated DS convention.)
- **Cards** (`.cp-section`, `.room-section-block`, applied/adjust blocks): drop heavy borders+shadows → surface-container fill with hairline divider or a single subtle elevation; increase padding; remove card-in-card nesting.
- **Spacing:** 8px rhythm (`--space-*`); generous section gaps; no cramped stacks.
- **Type:** enforce the role scale (eyebrow uppercase-tracked / label / title / body) already in tokens; clear hierarchy per section header.
- **Periwinkle discipline:** solid fill only on active nav/tab/segment + primary CTA; everything else neutral/tonal. Selected chips → tonal (primary-container), not filled.
- **Motion:** subtle transitions on hover/active/press (transform + color), respecting the perf note (content-visibility on swatches stays).
- **Icons:** keep the inline-SVG set (no emoji regressions).

## 4. Responsive robustness (mobile fix — folded in)

Current mobile (390px) is broken: top CTAs clip/overflow, 72px nav rail wastes width, tool panel unreachable behind a floating pill. Target:
- **Nav rail:** collapses to a slimmer/hideable bar or bottom nav under a breakpoint.
- **Top CTAs** (`View in My Room`, `Get A Quote`): wrap/reflow with safe-area top padding; never clip.
- **Tool panel:** becomes a **bottom sheet** (drag-up) on mobile, reachable and usable, instead of hidden.
- Canvas gets usable space; controls HUD repositions.
- Verified at 390px and 768px in addition to desktop 1440px.

## 5. Execution order (each = screenshot review + smoke 7/7 + commit)

1. **Foundation:** add Tailwind CDN + inline config (token mapping) + `<style type="text/tailwindcss">` scaffold; establish the `@apply` component primitives (`.btn/.pill-btn`, `.seg/.seg-chip`, `.card`, `.chip`, type roles). Prove the pipeline: one visible element (segmented control) redesigned, smoke green.
2. **Product surface** (default screen): panel cards, applied/adjust blocks, library grid header, CTAs.
3. **Room surface:** the dense left panel — segmented control, room-element chips, furniture-parts/applied/adjust cards.
4. **Finder modal + Parts:** modal chrome, dropzone, preview, tabs, buttons; Parts tab list.
5. **Responsive pass:** nav, CTAs, bottom-sheet tool panel; verify 390/768/1440.
6. **Polish + run:** motion, final consistency sweep; run and capture all states.

## 6. Verification

- `node test/smoke.mjs` → 7/7 after every step (JS hooks preserved).
- Screenshot each surface at 1440px (and 390/768px for step 5) via the puppeteer shot harness; visual review before commit.
- Watch for: broken JS hooks (a redesigned class that dropped `.active`/`.on` styling → dead state feedback), FOUC from CDN (acceptable, note if severe), swatch perf (content-visibility must remain).

## 7. Out of scope

- No JS/logic changes (class hooks preserved). No push. No Tailwind build step. 3D scene/materials/curtains untouched. Dark mode stays dormant (light-only) unless trivially free.
