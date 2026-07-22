# Feature: Per-product camera viewpoint (lock / publish)

## What it does

Sets a **zoom-in limit** for each product (chair / accent chair / sofa):

- The scene **loads normally** at the default framing — the lock does **not**
  reposition the camera.
- Visitors **cannot zoom in** closer than the locked radius (the S3 `r` value is
  the closest allowed orbit). Zooming out and orbiting stay free.
- Each product has its **own** limit.

> Only the radius `r` constrains the camera (as the zoom-in floor). The full pose
> (`theta`/`phi`/`tgt`) is still stored when you Lock, but it is not applied to the
> camera — kept for reference / a possible future "snap to framed shot" option.

Controlled from **Settings → Viewpoint** (same popover as Environment Brightness):
**Lock** publishes the current shot to everyone, **Unlock** clears it. A live `r`
readout and a state label show what's active.

## Status

**Live, with publishing enabled.** Whoever holds the **admin key** can change the
viewpoint for all visitors from the UI; the change persists in S3 and is picked up
on every subsequent load — no redeploy needed.

## Resolution order

For each product, the effective viewpoint is the first of:

1. **S3 published** — `fabric_assets_v2/config/viewpoints.json`, written by anyone
   with the key via **Lock**. This is the live source.
2. **`PRODUCT_VIEWPOINTS[key]`** (`src/lib/catalog.js`) — the baked-in default
   that ships with the app; used when S3 has no entry (or is unreachable).
3. **none** — free framing, zoom floor `0.3`.

State label: *Published to all* / *Using shipped default* / *No viewpoint set*.

The shipped defaults and the current S3 values are the same three shots:
```js
chair:        { theta: 0.043, phi: 1.066, r: 1.111, tgt: [0, 0, 0] },
accent_chair: { theta: 0.449, phi: 0.947, r: 1.327, tgt: [0, 0, 0] },
sofa:         { theta: 0.092, phi: 1.29,  r: 0.891, tgt: [0, 0, 0] },
```

## The admin key

- Stored **only** as the Vercel env var **`ADMIN_KEY`** (and `.env` for local
  `test/serve.mjs`). It is the secret the server compares against — never put it
  in S3 (that file is world-readable through the GET proxy).
- The client prompts for it once on the first Lock/Unlock and caches it in
  `localStorage.livinit_admin_key`. A rejected key (401) is cleared for retry.
- Change/rotate it by updating `ADMIN_KEY` in Vercel (redeploy) — the stored
  values in S3 are unaffected.

## Using it

1. Open **Settings → Viewpoint**, pick a product, orbit/zoom to the shot.
2. Click **Lock** → enter the admin key (first time only) → it publishes to S3 and
   applies to every visitor. A matching `PRODUCT_VIEWPOINTS` snippet is shown +
   copied so you can keep the shipped default in `catalog.js` in sync.
3. **Unlock** clears that product's published shot and reverts to the shipped
   default.

## Files

- **`api/viewpoints.ts`** — `GET` (public) reads the map; `POST`/`DELETE` require
  the `x-admin-key` header to equal `process.env.ADMIN_KEY`, read-modify-write one
  product, values sanitised/clamped. Only ever touches `config/viewpoints.json`.
- **`src/features/configurator/viewport.js`** — `_resolveViewpoint` (S3 →
  default), `applyLockedViewpoint` (snap + set `E.minZoomR`), `lockCurrentViewpoint`
  (key-gated `POST`), `unlockCurrentViewpoint` (key-gated `DELETE`),
  `loadLockedViewpoints` (`GET` on boot), `refreshViewpointUI`, `zoomStep`, and the
  wheel-handler zoom clamp.
- **`src/lib/catalog.js`** — `PRODUCT_VIEWPOINTS` shipped defaults.
- **`src/lib/engine.js`** — `minZoomR: 0.3` (current zoom-in floor).
- **`src/features/configurator/model.js`** — applies after default framing.
- **`src/features/room/room.js`** — re-applies on room exit; syncs the label.
- **`index.html`** — the Viewpoint block in `#settings-popover`; Zoom-In uses `zoomStep`.
- **`styles/app.css`** — `.vp-btn`.
- **`src/app/boot.js`** — calls `loadLockedViewpoints()` after first load.

## Deploy checklist

1. Set **`ADMIN_KEY`** in the Vercel project env (Production + Preview).
2. Deploy. The three defaults already live in S3 and in `PRODUCT_VIEWPOINTS`, so
   visitors get the framed shots immediately.
3. To hide the controls from ordinary shoppers, gate the Settings → Viewpoint
   block behind `isAdmin()` (`?admin=1` sets it, `?admin=0` clears) — the helper is
   already in `viewport.js`. Not required; the key already gates all changes.

## How to remove

Delete `PRODUCT_VIEWPOINTS` (catalog.js), the viewpoint block in `viewport.js`,
`E.minZoomR` (engine.js), the `applyLockedViewpoint` calls (model.js/room.js), the
`loadLockedViewpoints()` call (boot.js), the Settings block + `zoomStep` on the
Zoom-In button (index.html), the `.vp-btn` CSS, and `api/viewpoints.ts`.
Optionally delete `fabric_assets_v2/config/viewpoints.json` from S3.
