# Client Intake Format — Fabric Simulator Onboarding

> The standardized format a client (or a Livinit salesperson filling it in on the
> client's behalf) provides so a new furniture line can be built into the simulator.
> Companion to `2026-07-29-multi-tenant-onboarding-design.md`, which defines how this
> data becomes real `intake_requests`/`intake_items` rows in the backend.

## Format: one shared folder + one shared spreadsheet — not a code artifact

A shared Google Drive folder (photos, one subfolder per product, plus a `fabrics/`
subfolder) + one shared Google Sheet (not a static CSV emailed around). Reasoning: the
person filling this out is frequently non-technical — a client contact, or a salesperson
filling it in live during a pitch — and a Sheet is editable from any browser, supports
inline comments (ops can flag "photo 2 too dark, reshoot" directly on a row), and has
native version history for later edits. A custom in-app intake form is not worth
building until submission volume actually makes this the bottleneck — it isn't yet.

Every submission gets a name (`<Client> — <date> — <batch label>`) so it can be tracked
as one `intake_requests` row even if it arrives as several emails over a few days.

---

## Tab 1 — Client / Company Info

| Field | Required | Notes |
|---|---|---|
| Company legal name | Yes | |
| Brand/display name (if different) | No | Shown in the tool's chrome to the client's own customers |
| Primary contact — name, email, phone | Yes | |
| Account-admin login email | Yes | Owns the login roster; first login created |
| Additional staff logins needed | No | Name + email per person; can be added later too |
| Billing contact (if different from primary) | No | |
| Number of products in this batch | Yes | |
| Number of fabrics in this batch | Yes | |
| Target go-live date | Yes | Sets expectations; confirmed/adjusted by Livinit ops, not a guarantee at submission time |
| Rights attestation | Yes (checkbox) | "I confirm I have rights to provide these product and fabric images for use in this tool." Shifts licensing liability to the submitting party — does not by itself resolve vendor-photo licensing questions; flag anything uncertain per-row in Tab 3 instead of leaving this unchecked. |

## Tab 2 — Products (one row per product)

| Field | Required | Notes |
|---|---|---|
| Product name | Yes | As shown to the client's customers |
| Category | Yes | chair / sofa / bed / other (freeform if "other") |
| Photo folder link | Yes | Subfolder named exactly `<product_name>/` |
| Photo count | Yes | **Minimum 6**: front, back, left profile, right profile, 3/4 front, top-down (or closest practical angle). Each customizable part whose material differs from the main body needs its own close-up. |
| Photo quality | Yes | In focus, even lighting (no harsh single-side shadow), plain/neutral background where possible, ≥2000px on the long edge. Stated explicitly because "reasonable judgment" is exactly where under-specified submissions come from. |
| Existing spec sheet / CAD / manufacturer photos | No | Speeds up modeling significantly if available, especially for exact dimensions |
| Real-world dimensions (H × W × D) | Yes | Needed for correct scale even with good photos |
| Which parts should be customizable | Yes | Plain language ("seat cushion, back cushion, both armrests") — Livinit ops translates this into the technical part map; capture client intent here, don't make ops guess |
| Notes / special instructions | No | |

## Tab 3 — Fabrics (one row per fabric)

| Field | Required | Notes |
|---|---|---|
| Fabric name | Yes | As shown to end customers |
| Vendor / series | Yes | e.g. "Ennis – Thalassa" |
| Type | Yes | One of: fabric / vinyl / pu / leather / wood / other — use this exact list, don't freeform (keeps ops from having to normalize typos) |
| Hex color | Yes, always | Required even when a photo is provided — used as the fallback swatch and for search/filter |
| Photo provided? | Yes (Yes/No) | Explicit field — a blank cell is ambiguous between "forgot" and "intentionally none." Hex-only fabrics (no photo) are fully supported, not a degraded case. |
| Photo file (if yes) | Conditional | Link into the `fabrics/` subfolder |
| Known PBR values (optional) | No | Roughness/sheen/metalness 0–1, only if the client happens to already know them — otherwise Livinit ops applies type-based defaults |
| Vendor rights confirmed | Yes (Yes/No) | Per-row — lets a client flag one specific fabric photo as uncertain without blocking the whole batch |

## Completeness pre-check (Livinit ops, before any 3D modeling starts)

Before a submission enters the build queue: every product row has ≥6 photos meeting the
quality bar and a valid folder link; every fabric row has a hex value and an explicit
Yes/No on photo; the rights attestation is checked. Anything failing this bounces back to
the client with **itemized, per-row reasons** — never a blanket rejection of the whole
submission — so a resubmission only has to fix what was actually flagged.
