# Multi-Tenant Backend + Client Onboarding — Design

> Supersedes/corrects `2026-07-22-multi-tenant-simulator-plan.md` Phase 1 (schema) and
> Phase 5 (onboarding) sections. Phases 2/3/4/6 of that plan are unaffected by this doc
> and remain the source of truth for later phases. This doc is the result of a technical
> review + a product/PM pass done together, against the *current* state of the repo
> (which has drifted from the 2026-07-22 docs — see §0).

## 0. What changed since the original plan was written

Three days after `2026-07-22-multi-tenant-simulator-plan.md` was written, the founder
shipped the opposite of its Phase 2: the login gate was removed entirely
(`b85be25`, `df835e7`) to ship an unrelated feature (undo/save/tablet) fast. The live app
today boots every visitor into a fake `guest` session (`src/lib/auth.js`) against a
client-side-only `DEMO_TENANTS` object (`src/lib/tenant.js`). `catalog.js` has also
drifted: bed products are gone (chair/accent_chair/sofa only), the library is now flat
and vendor-agnostic, and the Ennis series (previously the "hex-only, no photo" example)
is now image-backed. `api/viewpoints.ts` and a hardened `api/s3proxy.ts` (key-prefix
allowlist, edge caching) were added and aren't covered by the original docs.

None of this invalidates the multi-tenant goal. It means: (1) the guest/demo experience
needs an explicit, permanent place in the design rather than being treated as a bug to
revert, and (2) the schema below is grounded in the *current* code, not the 2026-07-22
snapshot.

## 1. Decisions locked this session

- **Guest tenant stays, permanently, as an isolated public sandbox.** Salespeople demo
  the product itself on `guest` before a prospect commits to onboarding. It is not
  tenant #1 of N — no real client data ever lands in it, it gets the tightest AI quota
  of any tenant, and it is excluded from the "client must log in" framing: it's a fixed,
  well-known, publicly-reachable tenant, isolated the same way every other tenant is.
- **Billing is separate/undecided.** No coupling to Livinit's main-app Stripe/Supabase.
  Phase 1 ships a per-tenant daily AI-quota cap + an append-only usage log — enough to
  stop uncapped Gemini spend — with one reserved, unused, nullable column
  (`livinit_account_ref`) in case a billing reconciliation is wanted later. The fake
  `credits` number currently shown in the UI badge (`src/lib/tenant.js`) will be relabeled
  to a real "renders today: N / quota" reading once Phase 4 wires usage tracking, or
  hidden until then — it must not keep showing a fabricated balance.
- **Standalone Supabase project**, per the original plan — separate identity/DB from
  Livinit's main consumer app. Confirmed still correct: the client population here
  (furniture businesses) is structurally different from the main app's (consumers), and
  merging isolation boundaries to save one project is the wrong trade.
- **Onboarding is staff-entered in v1** — a prospective client cannot log in to submit
  anything (their tenant/user doesn't exist yet), so intake happens via a shared
  folder + spreadsheet (see the companion doc, `2026-07-29-client-intake-format.md`),
  staff key it into the system. The schema still ships client-write RLS policies (cheap,
  and untested policies rot) but no client-facing intake UI is built in v1.
- **Staff are modeled as a separate global table** (`platform_staff`), not a nullable-
  tenant row inside `memberships` as the original plan suggested — see §3.2 for why.
- **Product/fabric status is independent of tenant status.** A `live` tenant adding a
  6th product does not go dark while that product is `in_build`. This is the difference
  between "the client's account works" and "this specific item is ready to show."

## 2. Client lifecycle

Lead → intake submission → Livinit ops builds it → QA → activation → live usage →
ongoing changes → suspension/offboarding. Full stage-by-stage detail (who does what,
what state changes, every edge case considered) lives in the PM working notes for this
session; the operationally load-bearing points are:

1. **Sales conversation** happens against the `guest` sandbox tenant — this *is* the
   sales tool, not a separate demo environment to build.
2. **Intake** produces one `intake_requests` row (kind=`onboarding`) with N
   `intake_items` (one per product/fabric-to-be-built) and attached `intake_assets`
   (the client's raw photos/spec sheets). A submission can be partial and re-submitted
   without corrupting an in-flight batch (each submission is its own tracked request).
3. **Build** (2 parallel workstreams): a builder authors each product's GLB + `part_map`;
   a builder registers each fabric (running existing photos through `find-fabric` for
   PBR seed values where a photo exists, or the per-type default table where it
   doesn't — hex-only fabrics are explicitly supported, not a degraded path).
4. **QA — a mandatory, separate stage**, distinct from the person who built it: does the
   part_map actually let you select/swap each customizable part correctly, does the
   fabric render plausibly, does the product look right in room mode. This did not exist
   in the original plan's Phase 5 acceptance gate and is added here because a broken
   part_map discovered live in front of a client's own customer is a trust failure, not a
   minor bug.
5. **Activation** — tenant `lifecycle_status → live`, client login(s) created. Multiple
   named logins per tenant are supported (schema already allows it via `memberships`);
   a client-designated "account admin" owns the roster and requests add/remove via
   Livinit ops (no client self-serve member management in v1).
6. **Ongoing changes** reuse the exact same `intake_requests`/`intake_items` machinery
   with `kind` = `product_addition` / `fabric_addition` / `revision` / `retirement` —
   this is why intake is modeled as a general work-queue, not a one-time onboarding
   artifact. A part-segmentation revision after go-live re-runs the QA stage; it's a
   production hotfix, not a lesser change.
7. **Suspension** (non-payment or otherwise) freezes catalog changes immediately, full
   usage block after a grace window (founder to set the exact number — see open items).
   Suspension must bite even against an already-issued, unexpired session token — see
   §3.4 (stale JWT mitigation).
8. **Offboarding**: catalog data (products/fabrics/GLBs — Livinit's modeling-labor
   investment) is retained/reactivatable; anything containing an end-consumer's own
   uploaded room photo ("View in My Room") gets a short, fixed retention independent of
   tenant status, since that's a third party's personal data, not the client's catalog IP.

**Fabrics and products are retired, never deleted** — both may be referenced by a
client's saved design (`livinit_sim_designs_v1:<email>` in localStorage today,
resolved by name at replay time); a hard delete would break "load my saved design."

## 3. Data model (Phase 1 scope: schema + RLS only, no app code)

### 3.1 Conventions

- `id uuid primary key default gen_random_uuid()` everywhere.
- Every tenant-scoped table: `tenant_id uuid not null`, plus `unique(tenant_id, id)` so
  every child table can use a **composite foreign key** `(tenant_id, parent_id) references
  parent(tenant_id, id)` — this makes it structurally impossible for a row to reference a
  parent in a different tenant, independent of RLS. RLS stops a malicious client;
  composite FKs stop a buggy internal tool.
- Status columns are `text` + `CHECK (...)`, not native Postgres enums — the ops
  vocabulary will change as the process is used, and enum values can't be dropped.
- S3 key columns carry a prefix `CHECK (key like 'tenants/' || tenant_id::text || '/%'
  or key like 'shared/%')` — DB-level defense in depth mirroring the Phase-4 proxy rule.
- `created_by/at`, `updated_by/at` audit columns on every authored table.

### 3.2 Entities

**`tenants`** — `id`, `slug` (unique, url-safe), `name`, `lifecycle_status` (`lead |
intake_submitted | in_build | in_review | live | suspended | offboarded`, replaces the
original plan's bare `active/suspended`), `went_live_at`, `suspended_at`,
`offboarded_at`, `branding jsonb` (reserved, unused), `daily_ai_quota int default 50`,
`livinit_account_ref text unique null` (reserved for a future billing reconciliation,
untouched in v1), `notes`.

**`platform_staff`** — `user_id` (PK, → `auth.users`), `staff_role` (`admin | builder |
reviewer`), `revoked_at`. Split out from `memberships` because staff aren't scoped to a
tenant — forcing `memberships.tenant_id` nullable to fit them in would put a nullable
column on the exact table every RLS policy depends on, and collapses two orthogonal
concerns (tenant membership vs. platform role) into one.

**`memberships`** — links `auth.users.id` → `tenant_id`, `role` (`client |
client_admin`), invite/accept/revoke timestamps. `unique(user_id) where revoked_at is
null` enforces "one active tenant per client user" (this session's v1 rule) at the
database level, not just by convention.

**`intake_requests`** — `tenant_id`, `kind` (`onboarding | product_addition |
fabric_addition | revision | retirement`), `title`, `status` (`draft | submitted |
in_triage | in_build | in_review | changes_requested | completed | cancelled`),
`submitted_via` (`staff_entry | client_portal | email`), `assigned_to` (→
`platform_staff`), `priority`, `due_at`, `completed_at`. This is the staff work queue —
onboarding and every later "add a product" request are the same kind of row.

**`intake_items`** — one deliverable per row (`item_type`: `product | fabric |
fabric_collection | part_map_revision`), `spec jsonb` (client-declared intent before
it's real — name/hex/type/dimensions/etc.), `status` (`submitted | accepted | in_build |
in_review | changes_requested | published | rejected`), `assigned_to` (builder),
`reviewer_id` (separate from builder — enforces "the QA signer isn't the builder"),
nullable `resulting_product_id` / `resulting_fabric_id` / `resulting_collection_id`
(exactly one set, matching `item_type`, checked at the DB level) — publishing an intake
item IS creating the real catalog row.

**`intake_assets`** — the client's raw photos/spec sheets, tenant-scoped S3 keys under
`tenants/<id>/intake/`, linked to a request and optionally one item.

**`fabric_collections`** (renamed from the original plan's `fabric_groups`, promoted from
optional to load-bearing) — `name`, `vendor`, `material_class`, and critically
**`normal_key`/`roughness_key` live here, not on `fabrics`** — the runtime resolves PBR
texture maps per series (`materials.js`), not per individual fabric; the original plan
had these on `fabrics`, which would have meant duplicating the same two S3 keys across
every colorway in a series with nothing preventing drift. Also carries series-level PBR
defaults (roughness/sheen/metalness/scale/norm) and `is_type_fallback` (reproduces the
current `MATERIAL_MAPS.fabric` generic-alias behavior for ungrouped/Finder-sourced
fabrics).

**`fabrics`** — `collection_id` (nullable — null means ungrouped, e.g. "My Fabrics" /
Fabric-Finder output), `name`, `material_type`, `vendor_code`, `hex`, `swatch_key`,
`diffuse_key`, and *override-only* `normal_key`/`roughness_key`/PBR values (null = inherit
from collection = inherit from material-type default). `CHECK (hex is not null or
swatch_key is not null or diffuse_key is not null)` — a fabric that can render as neither
a color nor a texture is a data bug, caught at write time. `status` (`draft | in_build |
in_review | live | retired`).

**`products`** — `key` (stable, human-readable slug — the frontend keys material
snapshots and localStorage saved-designs by this string, so it must never be a raw uuid
and must never change once live), `name`, `glb_key`, `thumbnail_key`, **`part_map jsonb`**
(see §3.3), `part_map_version`, `viewpoint jsonb` (reserved home for what
`api/viewpoints.ts` currently stores globally in S3 — migrating that endpoint is Phase
3/4 work, not Phase 1), `status` (`draft | in_build | in_review | changes_requested |
live | retired`), independent of tenant status per §1.

**`product_fabric_collections`** — join table; **zero rows for a product means every
live collection in the tenant is offered** (matches today's flat "all fabrics on all
products" behavior with no data entry needed), populating it later expresses per-product
fabric restrictions without a migration.

**`product_part_map_versions`** — append-only history of every `part_map` + `glb_key`
revision. The `part_map` is the single most expensive hand-authored artifact in the
system; a bad revision shipped to a live client needs a one-row rollback, not a re-do.

**`audit_events`** — one generic append-only table (`entity_type`, `entity_id`, `action`,
`from_status`/`to_status`, `payload jsonb`) populated by **triggers on status columns**,
not application code (a trigger can't be skipped by someone doing a manual console
UPDATE; app-level logging always eventually misses one path).

**`usage_events`** — ships in Phase 1 (table + RLS), **written starting Phase 4**,
enforces nothing in v1. `event_type`, `endpoint`, `units`, `request_id` with
`unique(tenant_id, request_id) where request_id is not null` for idempotency against
Vercel function retries. The only query Phase 4 needs: count today's events per tenant
vs. `tenants.daily_ai_quota`.

### 3.3 `part_map` jsonb contract

```json
{
  "version": 1,
  "parts": [
    {
      "label": "Seat Cushion",
      "customizable": true,
      "sort_order": 1,
      "nodes": [
        { "name": "Cushion_01", "material_index": 0 },
        { "name": "Cushion_01", "material_index": 1 }
      ],
      "default_fabric_id": null,
      "uv_scale_hint": null
    }
  ],
  "unmapped_policy": "hide"
}
```

One logical part can own multiple node/material-slot pairs (required — the existing
model.js mesh-entry format already does this). `customizable: false` lets staff expose a
part in the outliner without letting a client re-fabric it (legs, hardware).
`unmapped_policy` defaults to `"hide"`, not a silent fallback to the chair/sofa
positional heuristics — those heuristics produce confidently wrong labels on arbitrary
client furniture, which is worse than an honestly-unmapped part.

Stored as jsonb (authored/read/versioned as one unit, never queried per-part) — not a
`product_parts` table. Reversible if per-part querying is ever needed.

### 3.4 RLS design

- Helper functions in an `app` schema: `app.jwt()`, `app.uid()`,
  `app.accessible_tenant_ids()` (SECURITY DEFINER, reads live `memberships` + `tenants`
  rows — **not** the JWT's `tenant_id` claim), `app.is_staff()` / `app.staff_role()`
  (SECURITY DEFINER, reads live `platform_staff` rows).
- **The JWT claim is a hint for the frontend/gateway, never the authorization
  authority** — every policy re-derives access from current table state. This is what
  makes suspension effective immediately rather than waiting out a token's remaining
  lifetime: `accessible_tenant_ids()` excludes any tenant with `suspended_at` set or
  `lifecycle_status in ('suspended','offboarded')`, and any membership with
  `revoked_at` set, on every single query.
- Every table: `revoke all from public, anon`, `enable row level security`, **`force row
  level security`** — without FORCE, the table owner (which migrations and local test
  sessions typically run as) bypasses RLS entirely, and every isolation test would pass
  green while proving nothing. This is the single most important non-obvious detail in
  this design.
- Separate policies per command (SELECT/INSERT/UPDATE/DELETE), never one combined `FOR
  ALL` — clients are read-only on the catalog, write-capable (in a limited way) on
  intake, and those need different shapes. **Every INSERT/UPDATE policy carries a
  `WITH CHECK` that pins `tenant_id`** — a `USING`-only policy on UPDATE would let a
  client read their own row and rewrite it into another tenant.
- Append-only tables (`audit_events`, `usage_events`, `product_part_map_versions`) get
  **no** UPDATE/DELETE policy at all (stronger than a policy that denies).
- **Staff access is a bypass RLS policy** (`USING (app.is_staff())`), not routing the
  admin UI through Supabase's `service_role` key. Reasoning: `service_role` bypasses RLS
  at the connection level, which moves the isolation boundary out of the database
  (declarative, testable, always-on) and into application TypeScript (one forgotten
  check away from a breach). `service_role` stays reserved for migrations and system
  writes only (the AI gateway's `usage_events` inserts, the Phase-2 claims hook).
- **How the guest sandbox (§1) fits this model without a special-cased public policy:**
  `anon` (a request with no session at all) stays fully revoked on every table, no
  exception. A guest visitor instead gets a real, if disposable, session via Supabase's
  anonymous sign-in (`signInAnonymously()`), which creates a genuine `auth.users` row
  (`is_anonymous = true`) and authenticates as Postgres's `authenticated` role — the same
  role every real client uses. A trigger (Phase 2) auto-creates a `memberships` row for
  any such user pointing at a fixed, seeded `guest` tenant. Net effect: guest access
  flows through the exact same `accessible_tenant_ids()` path as every other tenant —
  no bypass, no second code path to keep in sync, and the guest tenant's tight
  `daily_ai_quota` applies to it exactly like any other tenant's. This is a Phase 2
  concern to implement (it needs real Supabase Auth), but it's recorded here because the
  RLS policy shape in Phase 1 has to already be correct for it — a naive "add a public
  SELECT policy for the guest tenant" alternative would have created a second,
  harder-to-audit access path for no real benefit.

### 3.5 Local verification (no cloud Supabase project required)

Local Postgres 16 is already available on this machine. Plan:

- `supabase/migrations/*.sql` — real, versioned migrations, written to run unchanged on
  actual Supabase later (they reference `auth.users`/`auth.uid()`/`auth.jwt()` as
  pre-existing, never redefine them).
- `supabase/local/00_supabase_shim.sql` — reproduces `auth.users`, `auth.jwt()`,
  `auth.uid()`, and the `anon`/`authenticated`/`service_role` Postgres roles locally,
  faithfully (this is genuinely what Supabase's own `auth.jwt()` does under the hood —
  reads the `request.jwt.claims` GUC).
- `supabase/local/10_seed.sql` — fixed-UUID fixtures: two live tenants (A, B) to prove
  cross-tenant isolation, one `in_build` tenant with an open intake request (proves the
  onboarding-lifecycle tables), one `suspended` tenant with a still-valid, unexpired
  membership (proves suspension bites despite a valid-looking session), one tenant with
  a `revoked_at` membership on an otherwise-live tenant (proves membership revocation
  bites independently of tenant status).
- `supabase/tests/*.sql` — plain SQL assertions (`raise exception` on mismatch, no
  framework needed), run via `set local role authenticated; set local
  request.jwt.claims = '...'` inside a transaction that's rolled back after each test.
  Includes a meta-test asserting **every** tenant-scoped table has RLS enabled *and*
  forced, and that no INSERT/UPDATE policy is missing a `WITH CHECK` — this is the test
  that keeps working as the schema grows over time.
- **Acceptance gate for this phase**: `npm run db:test` (wraps the runner script) exits
  non-zero on the first failed assertion; must be green before any real Supabase cloud
  project is created. Concretely proves: tenant A's query returns zero of tenant B's
  rows even when A's claims are forged to claim `tenant_id = B` (proving the claim isn't
  the authority); a suspended tenant's member sees nothing despite an unexpired token; a
  revoked staff member sees nothing despite a `role=staff`-shaped claim.

## 4. Explicitly out of scope for this phase

| Item | Belongs to |
|---|---|
| Custom-claims hook stamping `tenant_id`/`role` into real JWTs | Phase 2 |
| Cloud user seeding (Auth Admin API — can't insert `auth.users` directly in cloud) | Phase 2 |
| `GET /api/catalog` response mapping to `src/lib/tenant.js`'s existing `{name, status, products[], credits}` shape | Phase 3 |
| S3 prefix enforcement in `api/s3proxy.ts`, edge-cache/auth-header interaction fix | Phase 4 |
| `usage_events` writes + quota enforcement | Phase 4 |
| Migrating `api/viewpoints.ts` off its global S3 singleton onto `products.viewpoint` | Phase 3/4 |
| Admin/onboarding console UI over `intake_*` tables | Phase 5 |
| Scoping staff reads to assigned tenants only (v1: any staff sees all tenants, writes are audited) | Phase 5+ |

## 5. Open items — do not block Phase 1, need a founder call before the relevant later phase

- Pricing/plan tiers by catalog size (recommend: one-time per-product/fabric onboarding
  fee reflecting real modeling labor + flat monthly platform fee — commercial decision).
- Turnaround SLA per submission (no number exists anywhere today; clients need one).
- Suspension grace-period length before full usage block.
- Consumer-uploaded "View in My Room" photo retention window (recommend: short, fixed,
  independent of tenant status — this is a third party's personal data).
- Fabric-vendor image licensing — a rights-attestation checkbox at intake shifts
  liability to the submitting client but doesn't resolve the underlying legal question.
- Multi-brand-per-account (recommend: two tenants under one billing relationship until
  an actual client needs otherwise — no schema change required either way).
