# Feature: Brand watermark baked into rendered images

## What it does

Composites the LIVINIT house-mark logo (bottom-right corner) onto every image the
render window produces, so that when a user **downloads** a shot the brand travels
with the file. The logo asset in S3 is white line-art, which disappears on the
white studio-capture backgrounds, so the watermark draws a **translucent dark
plate** behind the mark. That plate makes it read on *both*:

- the **AI hero** shot (full-colour living-room composite), and
- the **white-background** studio captures (backrest / seat / alternate angle).

## Status

**Removed** from the shipped build (per owner request "remove the watermarking
fully"). This doc is the recipe to bring it back.

## Design notes / gotchas learned last time

- The logo (`LOGO_URL`) is **white** → invisible on white. A translucent dark
  plate `rgba(17,15,13,.40)` behind it was measured to render the white mark at
  ~rgb(160,159,158) on a white background — visible but not harsh.
- Canvas cannot resolve CSS custom properties in `ctx.font` — use a literal
  family (`system-ui`), never `var(--font-…)`.
- Watermark the **captures**, not the live canvas — you want the raw shot clean
  for the AI round-trip, then stamp the returned/final images.

---

## Files touched

### 1. `src/features/render/render.js` — add the watermark helper

The logo is already imported at the top of this file:

```js
import { LOGO_URL } from '../../lib/catalog.js';
```

There is already an image loader `_loadImg(url)` in this file (used by the
"Download all" composer). Add this helper near `_captureFrame` /
`_captureCleanScene` (top third of the file):

```js
// Stamp the LIVINIT mark into the bottom-right of a captured data-URL image.
// A translucent dark plate sits behind the white logo so it reads on both the
// full-colour AI hero and the white studio-capture backgrounds.
async function _watermarkImage(dataUrl) {
  try {
    const [base, logo] = await Promise.all([_loadImg(dataUrl), _loadImg(LOGO_URL)]);
    const c = document.createElement('canvas');
    c.width = base.naturalWidth || base.width;
    c.height = base.naturalHeight || base.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(base, 0, 0, c.width, c.height);

    // Mark size scales with the image; clamp so it's never tiny/huge.
    const mark = Math.round(Math.min(c.width, c.height) * 0.11);
    const pad  = Math.round(mark * 0.5);
    const plateW = mark + pad * 1.6;
    const plateH = mark + pad * 0.9;
    const px = c.width  - plateW - pad;
    const py = c.height - plateH - pad;

    // Rounded translucent dark plate.
    const r = Math.round(plateH * 0.28);
    ctx.fillStyle = 'rgba(17,15,13,.40)';
    ctx.beginPath();
    ctx.moveTo(px + r, py);
    ctx.arcTo(px + plateW, py, px + plateW, py + plateH, r);
    ctx.arcTo(px + plateW, py + plateH, px, py + plateH, r);
    ctx.arcTo(px, py + plateH, px, py, r);
    ctx.arcTo(px, py, px + plateW, py, r);
    ctx.closePath();
    ctx.fill();

    // White logo centred in the plate.
    const lx = px + (plateW - mark) / 2;
    const ly = py + (plateH - mark) / 2 - pad * 0.05;
    ctx.drawImage(logo, lx, ly, mark, mark);

    // Wordmark to the plate's left (optional — comment out for logo-only).
    ctx.font = `600 ${Math.round(mark * 0.34)}px system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('livinit', px - pad * 0.6, py + plateH / 2);

    return c.toDataURL('image/jpeg', 0.94);
  } catch (e) {
    return dataUrl; // never block a render on a watermark failure
  }
}
```

> `_loadImg` must set `crossOrigin = 'anonymous'` (it already does) or the canvas
> becomes tainted and `toDataURL` throws — that's why the try/catch returns the
> original.

### 2. `src/features/render/render.js` — stamp the slide sources

Find where the slides array is built (search `const slides = [`, ~line 288) and
wrap each `src` with the watermark. Because it's async, build the sources first:

```js
// BEFORE (shipped): raw captures
const slides = [
  { src: heroFinal, fabric: overall, view: 'In a living room' },
  { src: backShot,  fabric: backF,   view: 'Backrest' },
  { src: seatShot,  fabric: seatF,   view: 'Seat cushion' },
  { src: angleShot, fabric: overall, view: 'Alternate angle' },
];

// AFTER (watermarked): stamp every source in parallel
const [heroW, backW, seatW, angleW] = await Promise.all([
  _watermarkImage(heroFinal),
  _watermarkImage(backShot),
  _watermarkImage(seatShot),
  _watermarkImage(angleShot),
]);
const slides = [
  { src: heroW,  fabric: overall, view: 'In a living room' },
  { src: backW,  fabric: backF,   view: 'Backrest' },
  { src: seatW,  fabric: seatF,   view: 'Seat cushion' },
  { src: angleW, fabric: overall, view: 'Alternate angle' },
];
```

That's it — the carousel's per-slide **Download** and the **Download all** sheet
composer both read from `slides[i].src`, so both downloads inherit the watermark
with no further change.

### 3. (Optional) Watermark the "Download all" sheet as a whole

If you'd rather stamp the composed contact-sheet once (instead of each panel),
leave step 2 out and instead wrap the return of `_composeCollage(...)`:

```js
// end of _composeCollage, replace:  return c.toDataURL('image/jpeg', 0.94);
const sheet = c.toDataURL('image/jpeg', 0.94);
return _watermarkImage(sheet);   // note: caller must `await` it now
```

Prefer step 2 (per-slide) — it covers single-image downloads too.

---

## How to remove (current shipped state)

- Delete the `_watermarkImage` helper.
- Revert the slides array to raw `heroFinal` / `backShot` / `seatShot` /
  `angleShot` sources (the "BEFORE" block above).
- `LOGO_URL` stays imported — it's still used for the carousel's brand header.
