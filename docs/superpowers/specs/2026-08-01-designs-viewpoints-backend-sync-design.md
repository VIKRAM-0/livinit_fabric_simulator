# Per-Account Saved Designs + Per-Tenant Viewpoints — Design

**Date:** 2026-08-01
**Status:** Approved (approach + sections reviewed in conversation)
**Repos touched:** `backend-livinit` (schema + routes), `livinit_fabric_simulator` (frontend)

## Problem

The simulator has real Supabase accounts and tenant identity (`GET /simulator/me`), but the
two most user-visible data sets are not account-aligned:

1. **Saved designs** live only in browser `localStorage`, keyed by email
   (`livinit_sim_designs_v1:<email>`). Same account on another device/browser sees nothing.
2. **Camera viewpoint locks** are one global JSON in S3 shared by every visitor of every
   tenant. One tenant's admin locking a pose changes it for all tenants — wrong for
   multi-tenant SaaS, and a blocker for the tenant-catalog intake vision (each tenant's own
   products will need their own locks).

## Decisions (made during brainstorming)

- **Approach:** backend routes as source of truth (extend the existing `/simulator/*`
  FastAPI pattern). Rejected: Supabase-direct-from-frontend (client-side limit enforcement,
  pattern split) and offline-first sync (conflict-resolution complexity, YAGNI).
- **Ownership:** designs are personal per-user. `tenant_id` is stored from day one so
  tenant-level sharing can be added later without migration.
- **Migration:** one-time auto-migrate of existing localStorage designs on first login;
  demo/guest sessions stay on localStorage forever (no account exists).
- **`product_key` is free text everywhere** (no enum, no hardcoded 3-product list in DB or
  route validation). Today's products are chair/accent_chair/sofa, but the tenant intake
  pipeline (workspace → data source → extract → review → publish) will introduce per-tenant
  products. Today routes accept any non-empty `product_key` ≤ 64 chars (no allowlist);
  when per-tenant catalogs exist, validation tightens to the tenant's catalog.

## Backend (`backend-livinit`)

### Migration `src/simulator/sql/migrations/0006_designs_viewpoints.sql`

```sql
create table simulator.designs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references simulator.tenants(id),
  user_id uuid not null,          -- auth.uid()
  name text not null,
  product_key text not null,      -- free text; today: chair | accent_chair | sofa
  thumb text,                     -- small JPEG data-URL (existing captureThumb output)
  state jsonb not null,           -- DesignState snapshot, same shape localStorage holds today
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on simulator.designs (user_id, updated_at desc);
-- RLS: select/insert/update/delete require user_id = auth.uid()

create table simulator.viewpoints (
  tenant_id uuid not null references simulator.tenants(id),
  product_key text not null,
  viewpoint jsonb not null,       -- {theta, phi, r, tgt} — same shape as the S3 JSON
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_key)
);
-- RLS: read = any member of the tenant; write = membership role 'client_admin' only
```

`thumb` stays a data-URL in the DB — 30 designs max per user, simplest thing that works.
Move to S3 later only if thumbnails grow.

### Routes

`src/simulator/routes/designs.py` and `viewpoints.py`, wired like the existing `me.py`.
All handlers use `get_simulator_supabase_as(access_token)` (per-request RLS-scoped client,
never the cached anon/service clients).

| Route | Behavior |
|---|---|
| `GET /simulator/designs` | Caller's designs, `updated_at` desc |
| `POST /simulator/designs` | Create. **Server-side limit 30** → `409 {"error":"limit"}` |
| `PATCH /simulator/designs/{id}` | Rename (`name` only) |
| `DELETE /simulator/designs/{id}` | Delete |
| `GET /simulator/viewpoints` | Caller's tenant's locks as `{product_key: viewpoint}` map |
| `PUT /simulator/viewpoints/{product}` | client_admin only. Bounds-sanitize viewpoint (same clamps as `api/viewpoints.ts`: phi (0.05, π−0.05), r [0.3, 30], tgt ±50, theta ±4π) |
| `DELETE /simulator/viewpoints/{product}` | client_admin only |

These appear automatically in the FastAPI swagger at `api.livinit.ai/docs`.

## Frontend (`livinit_fabric_simulator`)

### Designs store (`src/features/saved/`)

- New `saved-store-api.js`: `createApiSavedStore(accessToken)` with the same CRUD surface
  as `createSavedStore` but async, calling `api.livinit.ai/simulator/designs`.
- The existing localStorage store gets an async-shaped wrapper (sync work inside) so
  `saved-panel.js` has **one code path** — no `if (api)` branching at call sites.
- Store selection in `saved-panel.js` (where `createSavedStore(email)` is built today):
  demo/guest session → localStorage store; real live session → API store.
- `saved-panel.js`'s 7 call sites (`list/get/save/remove/rename`) become `await`ed.
  Loading: existing skeleton pattern during list fetch; disable buttons during save/delete.

### One-time migration

After the boot gate resolves a live tenant session (end of the `tenant.js` flow), once:

1. Read `livinit_sim_designs_v1:<email>`; empty → done.
2. Upload each design via `POST /simulator/designs`. On `409 limit`: keep what uploaded,
   skip the rest, show one toast.
3. Delete the local key **only after every upload succeeded** — a mid-way network failure
   leaves the key in place, so the next login retries.
4. Marker key `livinit_sim_migrated_v1:<email>` prevents re-upload after success.

### Viewpoints

Load order at configurator boot (today it only does `GET /api/viewpoints` → global S3):

1. Live tenant session → `GET api.livinit.ai/simulator/viewpoints` (Bearer). Locked
   products use the tenant lock.
2. Per-product fallback: no tenant lock → global S3 value (which becomes the
   "Livinit default").
3. Demo/guest/staff → global only, exactly today's behavior.

Lock icon (write path): shown when session role is `client_admin`; writes via
`PUT /simulator/viewpoints/{product}`. The old `x-admin-key` global S3 write path remains
only as a Livinit-internal tool for setting defaults — removed from the UI.

## Error handling

- No optimistic writes: save/rename/delete confirm on server response; failures toast and
  leave prior state.
- Boot-time `GET /simulator/designs` failure → "couldn't load designs, retry" state in the
  panel; the rest of the app keeps working.
- Migration partial failure → local key preserved, retried next login (step 3 above).

## Testing

- `saved-store-api` unit tests with a fetch mock (same Node-runnable pattern as
  `saved-store.test.mjs`).
- Migration tests: success path clears key; partial failure preserves key; marker prevents
  re-run.
- Backend: route tests for RLS scoping, the 30-limit 409, client_admin gate on viewpoint
  writes, viewpoint bounds sanitization.
- Headless: `test/serve.mjs` + demo session regression-checks the localStorage path. The
  live API path can only be verified end-to-end after backend deploy; until then fetch-mock
  coverage is the honest ceiling.

## Deploy reality (out of scope but load-bearing)

- Backend deploys to the Hetzner box (135.181.63.185) are manual; the Supabase migration
  additionally needs the `simulator` schema steps from `database.py`'s notes.
- The simulator frontend on `web.simulator.livinit.ai` is served from the same box by a
  custom runner (not Vercel); frontend changes also need a manual pull/restart there.

## Relationship to the tenant intake pipeline

The intake flow (create workspace → business goal → add fabrics/products → data source →
extract → review → publish to simulator) covers how a tenant's catalog gets INTO the
simulator. This spec covers end-user data AFTER publish. No overlap; per-tenant viewpoints
is a prerequisite for that vision, and free-text `product_key` keeps both compatible.
