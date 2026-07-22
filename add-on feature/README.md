# Add-on feature docs

Each file here is a **self-contained recipe** for one optional feature: what it
does, and the exact code + file locations to add (or remove) to turn it on/off.
These are features that are intentionally **not** in the shipped build right now,
kept documented so they can be re-added deliberately without re-deriving them.

Format of each doc:

- **What it does** — one paragraph.
- **Status** — whether it is currently live in the app.
- **Files touched** — every file, with the exact code and where it goes.
- **How to remove** — the reverse, when applicable.

## Index

| Doc | Feature | Currently live? |
|-----|---------|-----------------|
| [`watermark.md`](./watermark.md) | Brand watermark baked into rendered/downloaded images | ❌ Removed (documented for re-add) |
| [`lock-viewpoint.md`](./lock-viewpoint.md) | Per-product camera viewpoint (framed shot + zoom-in floor). Baked-in defaults now; runtime admin publish (S3) is a later phase | ✅ Live |
