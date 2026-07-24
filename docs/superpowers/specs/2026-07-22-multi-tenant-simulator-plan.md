# Implementation Prompt — Multi-Tenant Fabric Simulator (web.simulator.livinit.ai)

> **How to use this doc:** it is written to be handed to a fresh Claude Code / engineer
> session as the source-of-truth prompt. Read `CODEBASE_UNDERSTANDING.md` first, then
> execute the phases in order. Each phase ends with an acceptance gate — do not proceed
> until it passes.

---

## 0. Context — what exists today (verified facts, not assumptions)

This repo is a **single-tenant, no-auth 3D fabric configurator** (vanilla JS + Three.js
r128, Vercel static + TypeScript serverless functions in `api/`). To turn it into the
product described below we are adding the platform layer it was never built with.

Hard facts that shape everything:

- **No auth, no database, no user/tenant concept exists anywhere in the repo.**
- **All assets are hardcoded** in `src/lib/catalog.js` — product GLB URLs (`CHAIR_GLB`,
  `SOFA_GLB`, …), the ~14 fabric series (`LIBRARY`), and the PBR map table
  (`MATERIAL_MAPS`). This file is the thing we replace with a per-tenant, server-delivered
  catalog.
- **`/api/s3proxy` serves any S3 key to anyone** (`api/s3proxy.ts` — no auth check). This
  is the isolation hole. It MUST become tenant-scoped and session-verified.
- **Every `/api/*` endpoint is open**, including the Gemini render endpoints
  (`generate.ts`, `gemini-room.ts`, `find-fabric.ts`, `enhance-texture.ts`) that cost real
  money per call. All must be auth-gated.
- Part segmentation in `src/features/configurator/model.js` uses hardcoded `RENAME` tables
  + positional heuristics tuned for chair/sofa/bed. Arbitrary client furniture will NOT
  auto-classify — the mesh→part mapping must be **authored per product at onboarding and
  stored in the DB**, then applied at load time. This is the real work behind "our team
  segments the customizable sections."

## Product requirement (from founder)

- Each client provides their own furniture assets + fabric options; each account sees
  **only its own** library.
- Client logs in and uses the simulator live during customer consultations.
- Onboarding inputs from each client: (1) 2D images of furniture → **Livinit team manually
  builds the 3D models and segments customizable sections**; (2) a list of fabrics/finishes.
- Hosted as a dedicated web experience at **web.simulator.livinit.ai**.

## Locked decisions

- **Backend:** Standalone **Supabase** (Auth + Postgres + Row-Level Security) added directly
  to this Vercel app. Tenant isolation is enforced by RLS keyed on a `tenant_id` JWT claim,
  AND re-checked server-side in the asset/AI proxies. Do not rely on UI hiding for isolation.
- **Onboarding v1:** an **internal, Livinit-staff-only admin UI** in this same app to create
  tenants, create client logins, register products (GLB + part-segmentation map) and fabrics
  (with PBR maps). The 2D→3D conversion itself stays a manual human step outside the app.

## Non-negotiable principles

1. **Isolation is server-side.** Every asset byte and every AI call is authorized against the
   caller's verified `tenant_id`. A tenant must never be able to read another tenant's GLB,
   fabric, texture, or render — even by guessing keys/IDs.
2. **Keep the rendering engine untouched where possible.** The Three.js pipeline
   (`viewport.js`, `materials.js`, `room.js`) is high-quality and hard-won. We change *where
   the catalog data comes from*, not how meshes/materials are rendered.
3. **Fail closed.** No session → no app, no assets, no AI. No `tenant_id` claim → 403.

---

## Phase 1 — Data model & tenant backbone (Supabase)

Create the schema + RLS. This is the isolation boundary; get it right first.

**Tables** (all tenant-scoped tables carry `tenant_id uuid not null`):

- `tenants` — `id`, `name`, `slug`, `status` (active/suspended), `branding` jsonb (logo key,
  optional — flagged out of scope for v1 UI but reserve the column), `created_at`.
- `memberships` — links `auth.users.id` → `tenant_id` + `role` (`client` | `livinit_staff`).
  `livinit_staff` is the admin role; a client user maps to exactly one tenant in v1.
- `products` — `id`, `tenant_id`, `name`, `glb_key` (S3 key under the tenant prefix),
  `thumbnail_key`, `sort_order`, `status`. Plus **`part_map` jsonb** = the authored
  mesh-node-name → friendly-part-name mapping + which parts are customizable (replaces the
  hardcoded `RENAME`/heuristics for client furniture).
- `fabrics` — `id`, `tenant_id`, `name`, `series`, `type` (fabric/vinyl/pu/leather/wood/…),
  `hex`, `swatch_key`, `diffuse_key`, `normal_key`, `roughness_key`, and PBR defaults
  (`roughness`, `sheen`, `metalness`, `scale`, `norm`) mirroring the shape `find-fabric.ts`
  already returns.
- `fabric_groups` (optional) — `id`, `tenant_id`, `group`, `vendor`, `vclass` to reproduce
  `LIBRARY`'s grouped/vendor headers.

**RLS policies:** on every tenant-scoped table, `USING (tenant_id = (auth.jwt() ->>
'tenant_id')::uuid)`. `livinit_staff` gets a bypass policy (or a service-role admin path)
for the admin UI. Add a Postgres custom-claims hook (or an Edge Function on sign-in) that
stamps `tenant_id` + `role` into the JWT from `memberships`.

**Acceptance gate:** with two seeded tenants, a query authenticated as tenant A returns
zero of tenant B's `products`/`fabrics` rows. Verified in the Supabase SQL editor with
`set request.jwt.claims`.

---

## Phase 2 — Auth + gated app shell

- Add Supabase JS client (via CDN `<script>` to match the no-bundler convention, or a small
  ES module in `src/lib/`). Store nothing sensitive client-side beyond the Supabase session.
- **Login page** (`login.html` or a gated view in `index.html`): email/password or magic
  link. On success, redirect into the simulator.
- **Boot guard:** `src/app/boot.js` must block app initialization until a session exists.
  No session → redirect to login. Read `tenant_id` from the session, not from any client
  input.
- Update `vercel.json` so unauthenticated deep links resolve to login (the SPA rewrite
  already sends `/(.*) → /index.html`; add the client-side guard).

**Acceptance gate:** visiting the app logged-out shows login; logging in as a tenant-A user
lands in the simulator; no `/api/*` call succeeds before login (see Phase 4).

---

## Phase 3 — Replace the static catalog with a tenant catalog

This is the largest frontend change. `catalog.js` stops being static data and becomes a
loader.

- New endpoint **`GET /api/catalog`**: reads `tenant_id` from the **verified** JWT
  (server-side — never trust a client-supplied tenant id), returns that tenant's `products`
  + `fabrics` (+ groups), with asset URLs pointing at the secured proxy (Phase 4).
- Refactor `src/lib/catalog.js`: keep the pipeline-shaped exports (`LIBRARY`,
  `MATERIAL_MAPS`, `getGLBUrl`, `SB`) but **populate them at runtime** from `/api/catalog`
  instead of literals. Expose an `await loadCatalog()` that boot.js calls before
  `buildLibrary()` / first `loadModel()`.
- `boot.js` must `await loadCatalog()` after auth and before wiring the library/model UI.
- **Dynamic product switcher:** the chair/sofa/bed tabs are hardcoded in `index.html` +
  `switchModel()`. Make the product list data-driven (N products per tenant, rendered from
  the catalog), not three fixed buttons.
- **Part segmentation:** in `model.js`, when a product has a stored `part_map`, apply it
  instead of the positional heuristics. Keep the heuristics only as a fallback for legacy
  demo assets.

**Acceptance gate:** tenant A logs in and sees only tenant A's products + fabrics; tenant B
sees a different set; applying a fabric, entering room mode, and rendering all still work
end-to-end with the dynamic catalog.

---

## Phase 4 — Secure the asset + AI proxies (critical, do not skip)

- **`api/s3proxy.ts`:** require a valid Supabase session; extract `tenant_id` from the
  verified JWT; **reject any key whose prefix is not `tenants/<tenant_id>/`.** Move all
  tenant assets under that prefix at upload time (Phase 5). Shared/legacy read-only assets
  (room GLB, wood textures) can live under a `shared/` prefix that all authenticated tenants
  may read.
- **AI endpoints** (`generate.ts`, `gemini-room.ts`, `find-fabric.ts`,
  `enhance-texture.ts`, `acg-search.ts`, `acg-map.ts`): require a valid session; attribute
  the call to `tenant_id`; add **per-tenant rate limiting / daily quota** on the Gemini
  endpoints to cap cost and abuse. Log usage per tenant.
- Add a small server helper (`api/_lib/auth.ts`) that verifies the Supabase JWT and returns
  `{ userId, tenantId, role }`, used by every protected handler.

**Acceptance gate:** a request to `/api/s3proxy` for a key under tenant B's prefix, made
with tenant A's session, returns 403. An unauthenticated call to `/api/generate` returns
401. Rate limit trips after the configured quota.

---

## Phase 5 — Internal onboarding / admin UI (Livinit staff only)

Gated to `role = livinit_staff`. Minimal but complete enough that a non-engineer on the
Livinit team can onboard a client end-to-end after the 3D models are built.

Admin capabilities:
1. **Create tenant** (name, slug) + **create the client login** (invite/email + membership
   row with `role = client`).
2. **Register a product:** upload the finished GLB (stored to `tenants/<id>/glbs/…`), upload
   a thumbnail, and author the **`part_map`** — pick the mesh nodes that are customizable and
   name them. (Reuse the loader from `viewer.html` to preview the GLB and list its mesh node
   names while authoring the map.)
3. **Register fabrics:** name/type/hex + upload diffuse/normal/roughness (or run the existing
   `find-fabric` → PBR-JSON flow to seed the values), stored under
   `tenants/<id>/fabric_maps/…`, written to the `fabrics` table.

Server writes go through a **service-role** admin endpoint that itself checks
`role = livinit_staff` from the caller's JWT (never expose the service key to the browser).

**Acceptance gate:** a staff user can create tenant "Acme", create `buyer@acme.com`,
register one product with a 2-part segmentation and two fabrics — then `buyer@acme.com` logs
in and sees exactly that product + those two fabrics, and can customize them.

---

## Phase 6 — Deployment (web.simulator.livinit.ai)

- New Vercel project (or new domain on the existing one) mapped to
  `web.simulator.livinit.ai`.
- Env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only),
  existing `AWS_*` / `S3_BUCKET`, `GEMINI`/`GOOGLE_*` key.
- Confirm the SPA rewrite + auth guard behave on the real domain; confirm Supabase Auth
  redirect URLs include the production domain.

**Acceptance gate:** production smoke — log in as a real seeded tenant, load a product,
apply a fabric, render, and confirm cross-tenant asset access is 403 in prod.

---

## Cross-cutting risks to keep visible (do not let these get lost)

1. **Scope honesty:** this is auth + DB + tenancy + secured proxies + admin — the platform
   layer, not "a few features." Estimate accordingly.
2. **Security > UI hiding:** isolation must hold at the proxy and RLS even if the frontend
   is bypassed. The Phase-4 gate is the one that actually protects clients from each other.
3. **AI cost/abuse:** open Gemini endpoints in a multi-tenant world = uncapped spend.
   Per-tenant quotas are part of v1, not a later nicety.
4. **Segmentation is authored, not inferred** for client furniture — the `part_map` is the
   deliverable of "our team segments the sections," and the app must consume it.
5. **Per-tenant branding** (client logo/theme) is implied by "dedicated experience" but is
   NOT in the stated requirement — reserve the `branding` column, leave the UI for a later
   phase unless the founder asks.

## Suggested order & rough sizing (independent of exact estimates)

Phase 1 → 2 → 4 (security early, alongside auth) → 3 → 5 → 6. Phases 1–4 are the
platform core; 3 is the biggest single frontend refactor; 5 is what makes onboarding
repeatable without an engineer.
