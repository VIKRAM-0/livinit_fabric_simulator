# Multi-Tenant Phase 1 — Data Model + RLS Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally verify the Postgres schema + Row-Level-Security backbone for the multi-tenant fabric simulator (tenants, staff, catalog, onboarding intake, audit/usage) so cross-tenant isolation is provably correct before any cloud Supabase project or application code exists.

**Architecture:** Versioned SQL migrations under `supabase/migrations/` (must run unchanged on real Supabase later), a local-only shim (`supabase/local/00_supabase_shim.sql`) that reproduces `auth.users`/`auth.jwt()`/`auth.uid()`/Postgres roles so RLS can be tested against the Postgres already running on this machine, fixed-UUID seed fixtures, and a plain-SQL assertion suite run via a shell script. No application code, no API endpoints, no UI — see `docs/superpowers/specs/2026-07-29-multi-tenant-onboarding-design.md` for what's deliberately out of scope.

**Tech Stack:** PostgreSQL 16 (local, Homebrew — already running and confirmed reachable via `psql`), plain SQL + plpgsql, bash runner, no ORM, no test framework.

## Global Constraints

- Migrations in `supabase/migrations/*.sql` must contain **only** syntax valid on real Supabase — never `create schema auth`, never redefine `auth.users`/`auth.jwt()`/`auth.uid()` (those exist in the cloud; the local shim supplies them and lives outside `migrations/`).
- Every tenant-scoped table: `tenant_id uuid not null`, plus `unique (tenant_id, id)` so child tables can use composite foreign keys `(tenant_id, parent_id) references parent(tenant_id, id)`.
- Status columns are `text` + `CHECK (...)`, never native Postgres `enum` types.
- Every tenant-scoped table gets `enable row level security` **and** `force row level security` — without FORCE, table owners (which local test sessions run as by default) bypass RLS silently.
- Every INSERT/UPDATE RLS policy must carry an explicit `WITH CHECK` — a `USING`-only policy lets a client rewrite a row's `tenant_id` on UPDATE.
- `gen_random_uuid()` is used directly (built into Postgres core since v13 — confirmed working on this machine, no `pgcrypto` extension load needed).
- The acceptance gate for this entire phase is `npm run db:test` exiting 0. It must be run after every task from Task 6 onward, and must stay green — never leave it red between tasks.
- Local-only seeding of `auth.users` (Task 7) is impossible on real cloud Supabase (you can't insert into `auth.users` directly there) — this is expected and documented, not a bug to fix; cloud seeding is explicitly Phase 2 scope.

---

## Task 1: Repo scaffold + local Supabase shim + runner skeleton

Proves the local test harness itself works — creates the local DB, loads the shim (fake `auth.users`, `auth.jwt()`, `auth.uid()`, the three Postgres roles), and confirms claim-reading works — before any real schema exists.

**Files:**
- Create: `supabase/local/00_supabase_shim.sql`
- Create: `supabase/run-local.sh`
- Modify: `package.json` (add `db:test` script)

**Interfaces:**
- Produces: schema `auth` with table `auth.users(id uuid, email text)`; functions `auth.jwt() returns jsonb`, `auth.uid() returns uuid`; roles `anon`, `authenticated`, `service_role` (the last with `BYPASSRLS`), all grantable to the connecting superuser via `SET ROLE`.

- [ ] **Step 1: Write the local shim**

```sql
-- supabase/local/00_supabase_shim.sql
-- Reproduces the pieces of a real Supabase project that migrations assume
-- already exist: auth.users, auth.jwt()/auth.uid(), and the Postgres roles
-- PostgREST uses. NEVER applied to a real cloud project — local dev only.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);

create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb)
$$;

create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

do $$ begin
  create role anon          nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role  nologin noinherit bypassrls;
exception when duplicate_object then null; end $$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Lets the connecting superuser SET ROLE into any of these for testing.
grant anon, authenticated, service_role to current_user;
```

- [ ] **Step 2: Write the runner script**

```bash
#!/usr/bin/env bash
# supabase/run-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB=sim_local

dropdb --if-exists "$DB"
createdb "$DB"

psql -v ON_ERROR_STOP=1 -d "$DB" -f supabase/local/00_supabase_shim.sql

shopt -s nullglob
for f in supabase/migrations/*.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done

if [ -f supabase/local/10_seed.sql ]; then
  psql -v ON_ERROR_STOP=1 -d "$DB" -f supabase/local/10_seed.sql
fi

if [ -f supabase/tests/00_assert.sql ]; then
  psql -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/00_assert.sql
  for f in supabase/tests/[1-9]*.sql; do
    echo "running $f"
    psql -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
  done
fi

echo "RLS suite passed"
```

```bash
chmod +x supabase/run-local.sh
```

- [ ] **Step 3: Wire the package.json script**

Modify `package.json`'s `"scripts"` block — add:

```json
"db:test": "bash supabase/run-local.sh"
```

- [ ] **Step 4: Run it and verify the shim works end-to-end**

Run: `npm run db:test`
Expected: `dropdb`/`createdb` succeed, the shim applies with no errors (no migrations or tests exist yet, so those loops no-op), output ends with `RLS suite passed`.

Then verify the shim's claim-reading directly:

```bash
psql -d sim_local -c "
  begin;
  set local role authenticated;
  set local request.jwt.claims = '{\"sub\":\"11111111-1111-1111-1111-111111111111\"}';
  select auth.uid();
  rollback;
"
```
Expected: returns `11111111-1111-1111-1111-111111111111`.

- [ ] **Step 5: Commit**

```bash
git add supabase/local/00_supabase_shim.sql supabase/run-local.sh package.json
git commit -m "chore: local Supabase shim + db:test runner scaffold"
```

---

## Task 2: Helper functions + tenancy tables (tenants, platform_staff, memberships)

**Files:**
- Create: `supabase/migrations/0001_app_helpers.sql`
- Create: `supabase/migrations/0002_tenancy.sql`

**Interfaces:**
- Consumes: `auth.users`, `auth.jwt()`, `auth.uid()` (Task 1's shim locally; real Supabase in the cloud).
- Produces: schema `app` with `app.jwt()`, `app.uid()`, `app.claim_tenant_id()`, `app.accessible_tenant_ids() returns uuid[]`, `app.is_staff() returns boolean`, `app.staff_role() returns text`. Tables `public.tenants`, `public.platform_staff`, `public.memberships` (no RLS enabled yet — Task 6 does that for every table at once).

- [ ] **Step 1: Write the helper-functions migration**

```sql
-- supabase/migrations/0001_app_helpers.sql
create schema if not exists app;

create or replace function app.jwt() returns jsonb
  language sql stable as $$
  select auth.jwt()
$$;

create or replace function app.uid() returns uuid
  language sql stable as $$
  select auth.uid()
$$;

-- A HINT for the frontend/gateway only — never the authorization authority.
-- Every RLS policy re-derives access from live table rows, not this claim.
create or replace function app.claim_tenant_id() returns uuid
  language sql stable as $$
  select nullif(app.jwt() ->> 'tenant_id', '')::uuid
$$;

create or replace function app.accessible_tenant_ids() returns uuid[]
  language sql stable security definer
  set search_path = public, pg_temp as $$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = app.uid()
    and m.revoked_at is null
    and t.lifecycle_status not in ('suspended','offboarded')
    and t.suspended_at is null
$$;

create or replace function app.is_staff() returns boolean
  language sql stable security definer
  set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.platform_staff s
    where s.user_id = app.uid() and s.revoked_at is null
  )
$$;

create or replace function app.staff_role() returns text
  language sql stable security definer
  set search_path = public, pg_temp as $$
  select s.staff_role from public.platform_staff s
  where s.user_id = app.uid() and s.revoked_at is null
  limit 1
$$;
```

- [ ] **Step 2: Write the tenancy migration**

```sql
-- supabase/migrations/0002_tenancy.sql
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  lifecycle_status text not null default 'lead'
    check (lifecycle_status in ('lead','intake_submitted','in_build','in_review','live','suspended','offboarded')),
  went_live_at timestamptz,
  suspended_at timestamptz,
  offboarded_at timestamptz,
  branding jsonb not null default '{}'::jsonb,
  daily_ai_quota int not null default 50 check (daily_ai_quota >= 0),
  livinit_account_ref text unique,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint tenants_slug_format
    check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);
create index tenants_lifecycle_status_idx on public.tenants(lifecycle_status);

create table public.platform_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  staff_role text not null check (staff_role in ('admin','builder','reviewer')),
  revoked_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'client' check (role in ('client','client_admin')),
  invited_by uuid references auth.users(id),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  unique (tenant_id, user_id)
);
-- Enforces "one active tenant per client user" (v1 rule) at the DB level,
-- not just by convention — makes the single tenant_id JWT claim unambiguous.
create unique index memberships_one_active_tenant_per_user
  on public.memberships(user_id) where revoked_at is null;
create index memberships_user_active_idx on public.memberships(user_id) where revoked_at is null;
```

- [ ] **Step 3: Apply and verify manually (no RLS yet, so plain queries as the connecting superuser)**

Run: `npm run db:test` — should still pass (no seed/tests yet, migrations apply cleanly).

Then verify the helpers directly:

```bash
psql -d sim_local -c "
  insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001','t@test.com');
  insert into public.tenants (id, slug, name, lifecycle_status) values
    ('11111111-1111-1111-1111-111111111111','acme-check','Acme Check','live');
  insert into public.memberships (tenant_id, user_id) values
    ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001');
  begin;
  set local role authenticated;
  set local request.jwt.claims = '{\"sub\":\"aaaaaaaa-0000-0000-0000-000000000001\"}';
  select app.accessible_tenant_ids();
  rollback;
  delete from public.memberships; delete from public.tenants; delete from auth.users;
"
```
Expected: `app.accessible_tenant_ids()` returns `{11111111-1111-1111-1111-111111111111}`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_app_helpers.sql supabase/migrations/0002_tenancy.sql
git commit -m "feat: app helper functions + tenants/platform_staff/memberships"
```

---

## Task 3: Catalog tables (fabric_collections, fabrics, products, product_fabric_collections, product_part_map_versions)

**Files:**
- Create: `supabase/migrations/0003_catalog.sql`

**Interfaces:**
- Consumes: `public.tenants(id)`.
- Produces: `public.fabric_collections`, `public.fabrics`, `public.products`, `public.product_fabric_collections`, `public.product_part_map_versions`. Each carries a plain `source_intake_item_id uuid` column (no FK yet — `intake_items` doesn't exist until Task 4, which adds the FK via `ALTER TABLE` after creating it, resolving the circular dependency).

- [ ] **Step 1: Write the catalog migration**

```sql
-- supabase/migrations/0003_catalog.sql

-- Renamed from the original plan's "fabric_groups": promoted from optional
-- to load-bearing. normal_key/roughness_key live HERE, not on fabrics,
-- because the renderer resolves PBR maps per series (materials.js:
-- MATERIAL_MAPS[item.series] || MATERIAL_MAPS[item.type] || MATERIAL_MAPS.fabric),
-- not per individual fabric.
create table public.fabric_collections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  vendor text,
  material_class text not null check (material_class in ('fabric','vinyl','pu','leather','wood','custom')),
  normal_key text
    check (normal_key like 'tenants/' || tenant_id::text || '/%' or normal_key like 'shared/%'),
  roughness_key text
    check (roughness_key like 'tenants/' || tenant_id::text || '/%' or roughness_key like 'shared/%'),
  default_roughness numeric(4,3) check (default_roughness between 0 and 1),
  default_sheen numeric(4,3) check (default_sheen between 0 and 1),
  default_metalness numeric(4,3) check (default_metalness between 0 and 1),
  default_scale numeric(6,2) check (default_scale > 0),
  default_norm numeric(4,2) check (default_norm >= 0),
  is_type_fallback boolean not null default false,
  status text not null default 'draft' check (status in ('draft','in_build','in_review','live','retired')),
  sort_order int not null default 0,
  source_intake_item_id uuid,
  retired_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create unique index fabric_collections_type_fallback_uniq
  on public.fabric_collections(tenant_id, material_class) where is_type_fallback;
create index fabric_collections_tenant_status_idx on public.fabric_collections(tenant_id, status);

create table public.fabrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  collection_id uuid,
  name text not null,
  material_type text not null check (material_type in ('fabric','vinyl','pu','leather','wood','other')),
  vendor_code text,
  hex text check (hex ~ '^#[0-9a-fA-F]{6}$'),
  swatch_key text
    check (swatch_key like 'tenants/' || tenant_id::text || '/%' or swatch_key like 'shared/%'),
  diffuse_key text
    check (diffuse_key like 'tenants/' || tenant_id::text || '/%' or diffuse_key like 'shared/%'),
  -- Override-only: null means "inherit from the collection". This is the
  -- fix for the original plan putting these on every fabric row (would
  -- have meant duplicating identical S3 keys across every colorway in a
  -- series with nothing preventing drift).
  normal_key text
    check (normal_key like 'tenants/' || tenant_id::text || '/%' or normal_key like 'shared/%'),
  roughness_key text
    check (roughness_key like 'tenants/' || tenant_id::text || '/%' or roughness_key like 'shared/%'),
  roughness numeric(4,3) check (roughness between 0 and 1),
  sheen numeric(4,3) check (sheen between 0 and 1),
  metalness numeric(4,3) check (metalness between 0 and 1),
  scale numeric(6,2) check (scale > 0),
  norm numeric(4,2) check (norm >= 0),
  status text not null default 'draft' check (status in ('draft','in_build','in_review','live','retired')),
  sort_order int not null default 0,
  source_intake_item_id uuid,
  retired_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, collection_id) references public.fabric_collections(tenant_id, id),
  constraint fabrics_has_visual
    check (hex is not null or swatch_key is not null or diffuse_key is not null),
  constraint fabrics_retired_at_consistency
    check ((status = 'retired') = (retired_at is not null))
);
create index fabrics_tenant_status_idx on public.fabrics(tenant_id, status);
create index fabrics_tenant_collection_idx on public.fabrics(tenant_id, collection_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Stable, human-readable slug — the frontend keys material snapshots and
  -- localStorage saved-designs by this string. Must never be a raw uuid,
  -- must never change once live.
  key text not null check (key ~ '^[a-z0-9][a-z0-9_]{0,49}$'),
  name text not null,
  glb_key text not null
    check (glb_key like 'tenants/' || tenant_id::text || '/%' or glb_key like 'shared/%'),
  thumbnail_key text
    check (thumbnail_key like 'tenants/' || tenant_id::text || '/%' or thumbnail_key like 'shared/%'),
  part_map jsonb not null default '{"version":1,"parts":[],"unmapped_policy":"hide"}'::jsonb,
  part_map_version int not null default 1,
  viewpoint jsonb,
  status text not null default 'draft'
    check (status in ('draft','in_build','in_review','changes_requested','live','retired')),
  sort_order int not null default 0,
  source_intake_item_id uuid,
  published_at timestamptz,
  retired_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);
create index products_tenant_status_idx on public.products(tenant_id, status, sort_order);

create table public.product_fabric_collections (
  tenant_id uuid not null,
  product_id uuid not null,
  collection_id uuid not null,
  sort_order int not null default 0,
  primary key (product_id, collection_id),
  foreign key (tenant_id, product_id) references public.products(tenant_id, id) on delete cascade,
  foreign key (tenant_id, collection_id) references public.fabric_collections(tenant_id, id) on delete cascade
);

create table public.product_part_map_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  version int not null,
  part_map jsonb not null,
  glb_key text not null,
  note text,
  authored_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (product_id, version),
  foreign key (tenant_id, product_id) references public.products(tenant_id, id) on delete cascade
);
```

- [ ] **Step 2: Apply and verify the constraints actually bite**

Run: `npm run db:test` (migrations apply cleanly).

Then verify the two hand-written constraints deliberately fail as designed:

```bash
psql -d sim_local -c "
  insert into public.tenants (id, slug, name, lifecycle_status) values
    ('22222222-2222-2222-2222-222222222222','constraint-check','Constraint Check','live');
  -- must fail: no hex, no swatch_key, no diffuse_key
  insert into public.fabrics (tenant_id, name, material_type) values
    ('22222222-2222-2222-2222-222222222222','No Visual','fabric');
"
```
Expected: fails with `new row for relation "fabrics" violates check constraint "fabrics_has_visual"`.

```bash
psql -d sim_local -c "
  -- must fail: retired status without retired_at
  insert into public.fabrics (tenant_id, name, material_type, hex, status) values
    ('22222222-2222-2222-2222-222222222222','Bad Retire','fabric','#112233','retired');
  delete from public.tenants where id = '22222222-2222-2222-2222-222222222222';
"
```
Expected: fails with `violates check constraint "fabrics_retired_at_consistency"`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_catalog.sql
git commit -m "feat: catalog tables — fabric_collections, fabrics, products"
```

---

## Task 4: Intake tables (intake_requests, intake_items, intake_assets) + resolve the circular FK

**Files:**
- Create: `supabase/migrations/0004_intake.sql`

**Interfaces:**
- Consumes: `public.tenants`, `public.platform_staff`, `public.products`, `public.fabrics`, `public.fabric_collections`.
- Produces: `public.intake_requests`, `public.intake_items`, `public.intake_assets`; adds `source_intake_item_id` foreign keys onto the three catalog tables from Task 3 (resolving the circular dependency — those tables were created first with a plain column, this migration adds the FK now that `intake_items` exists).

- [ ] **Step 1: Write the intake migration**

```sql
-- supabase/migrations/0004_intake.sql

-- The onboarding work-queue. Onboarding and every later "add one product" /
-- "add one fabric" / "revise a part map" request are the same kind of row —
-- this is deliberate: it's why intake is a general queue, not a one-time
-- onboarding-only artifact.
create table public.intake_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
    default app.claim_tenant_id(),
  kind text not null check (kind in ('onboarding','product_addition','fabric_addition','revision','retirement')),
  title text not null,
  status text not null default 'draft'
    check (status in ('draft','submitted','in_triage','in_build','in_review','changes_requested','completed','cancelled')),
  submitted_via text not null default 'staff_entry' check (submitted_via in ('staff_entry','client_portal','email')),
  submitted_by uuid references auth.users(id),
  submitted_at timestamptz,
  assigned_to uuid references public.platform_staff(user_id),
  priority smallint not null default 3 check (priority between 1 and 5),
  due_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index intake_requests_queue_idx on public.intake_requests(status, priority, due_at);
create index intake_requests_assigned_idx on public.intake_requests(assigned_to) where completed_at is null;

create table public.intake_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.claim_tenant_id(),
  intake_request_id uuid not null,
  item_type text not null check (item_type in ('product','fabric','fabric_collection','part_map_revision')),
  title text not null,
  -- Client-declared intent before it's real: name/hex/type/dimensions/etc.
  -- Deliberately loose jsonb — this is raw client input, not our data model.
  spec jsonb not null default '{}'::jsonb,
  status text not null default 'submitted'
    check (status in ('submitted','accepted','in_build','in_review','changes_requested','published','rejected')),
  assigned_to uuid references public.platform_staff(user_id),
  reviewer_id uuid references public.platform_staff(user_id),
  review_notes text,
  resulting_product_id uuid,
  resulting_fabric_id uuid,
  resulting_collection_id uuid,
  published_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, intake_request_id) references public.intake_requests(tenant_id, id) on delete cascade,
  foreign key (tenant_id, resulting_product_id) references public.products(tenant_id, id),
  foreign key (tenant_id, resulting_fabric_id) references public.fabrics(tenant_id, id),
  foreign key (tenant_id, resulting_collection_id) references public.fabric_collections(tenant_id, id),
  constraint intake_items_reviewer_not_builder
    check (reviewer_id is null or assigned_to is null or reviewer_id <> assigned_to),
  constraint intake_items_resulting_matches_type check (
    (item_type = 'product'           and resulting_fabric_id is null and resulting_collection_id is null) or
    (item_type = 'fabric'            and resulting_product_id is null and resulting_collection_id is null) or
    (item_type = 'fabric_collection' and resulting_product_id is null and resulting_fabric_id is null) or
    (item_type = 'part_map_revision' and resulting_fabric_id is null and resulting_collection_id is null)
  ),
  constraint intake_items_published_has_result check (
    (status = 'published') = (
      resulting_product_id is not null or
      resulting_fabric_id is not null or
      resulting_collection_id is not null
    )
  )
);
create index intake_items_request_idx on public.intake_items(tenant_id, intake_request_id);

create table public.intake_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.claim_tenant_id(),
  intake_request_id uuid not null,
  intake_item_id uuid,
  kind text not null check (kind in ('product_photo','fabric_photo','spec_sheet','reference','other')),
  s3_key text not null check (s3_key like 'tenants/' || tenant_id::text || '/intake/%'),
  original_filename text,
  mime_type text,
  byte_size bigint check (byte_size >= 0),
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, s3_key),
  foreign key (tenant_id, intake_request_id) references public.intake_requests(tenant_id, id) on delete cascade,
  foreign key (tenant_id, intake_item_id) references public.intake_items(tenant_id, id) on delete cascade
);

-- Resolve the circular reference now that intake_items exists: a catalog
-- row can point back at the intake item that produced it.
alter table public.fabric_collections
  add constraint fabric_collections_source_item_fk
  foreign key (tenant_id, source_intake_item_id) references public.intake_items(tenant_id, id);
alter table public.fabrics
  add constraint fabrics_source_item_fk
  foreign key (tenant_id, source_intake_item_id) references public.intake_items(tenant_id, id);
alter table public.products
  add constraint products_source_item_fk
  foreign key (tenant_id, source_intake_item_id) references public.intake_items(tenant_id, id);
```

- [ ] **Step 2: Apply and verify the two behavioral constraints**

Run: `npm run db:test` (migrations apply cleanly, circular FK resolves without error).

```bash
psql -d sim_local -c "
  insert into public.tenants (id, slug, name, lifecycle_status) values
    ('33333333-3333-3333-3333-333333333333','intake-check','Intake Check','live');
  insert into public.intake_requests (tenant_id, kind, title, status) values
    ('33333333-3333-3333-3333-333333333333','onboarding','Check batch','draft')
    returning id;
"
```
Note the returned `id`, then:

```bash
psql -d sim_local -c "
  -- must fail: item_type='product' but resulting_fabric_id is set
  insert into public.intake_items (tenant_id, intake_request_id, item_type, title, resulting_fabric_id) values
    ('33333333-3333-3333-3333-333333333333', '<id from above>', 'product', 'Bad Item', gen_random_uuid());
"
```
Expected: fails with `violates check constraint "intake_items_resulting_matches_type"`.

```bash
psql -d sim_local -c "
  delete from public.intake_requests where tenant_id = '33333333-3333-3333-3333-333333333333';
  delete from public.tenants where id = '33333333-3333-3333-3333-333333333333';
"
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_intake.sql
git commit -m "feat: intake work-queue tables (requests/items/assets)"
```

---

## Task 5: Audit + usage tables and status-change triggers

**Files:**
- Create: `supabase/migrations/0005_audit_usage.sql`

**Interfaces:**
- Consumes: every table with a `status` or `lifecycle_status` column from Tasks 2–4.
- Produces: `public.audit_events`, `public.usage_events`; triggers `app.audit_tenant_lifecycle()` on `tenants`, `app.audit_entity_status('<type>')` on `products`/`fabrics`/`fabric_collections`/`intake_requests`/`intake_items`.

- [ ] **Step 1: Write the audit/usage migration**

```sql
-- supabase/migrations/0005_audit_usage.sql

create table public.audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  actor_user_id uuid references auth.users(id),
  actor_kind text not null check (actor_kind in ('client','staff','system')),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  from_status text,
  to_status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_tenant_idx on public.audit_events(tenant_id, created_at desc);
create index audit_events_entity_idx on public.audit_events(entity_type, entity_id, created_at desc);

-- Ships now (Phase 1). Written starting Phase 4. Enforces nothing in v1 —
-- Phase 4 caps spend by counting rows here against tenants.daily_ai_quota.
create table public.usage_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id),
  event_type text not null check (event_type in ('ai_product_render','ai_room_render','ai_vision','ai_enhance','glb_export')),
  endpoint text not null,
  units int not null default 1 check (units > 0),
  cost_micros bigint,
  request_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Plain UNIQUE already permits unlimited NULLs (Postgres never treats
  -- NULL = NULL for uniqueness) — this is the idempotency guard for
  -- non-null request_id retries only, no partial index needed.
  unique (tenant_id, request_id)
);
create index usage_events_tenant_created_idx on public.usage_events(tenant_id, created_at desc);

-- SECURITY DEFINER so these succeed regardless of the calling session's
-- RLS restrictions — audit_events has NO insert policy for anyone (Task 6),
-- only these triggers write to it. This relies on the trigger functions
-- being owned by a privileged role (the migration-applying role locally /
-- Supabase's migration runner in the cloud), which is the standard pattern
-- for audit triggers under RLS.
create or replace function app.audit_tenant_lifecycle() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := app.uid();
  v_actor_kind text := case when app.is_staff() then 'staff' when v_actor is not null then 'client' else 'system' end;
begin
  if TG_OP = 'INSERT' then
    insert into public.audit_events(tenant_id, actor_user_id, actor_kind, entity_type, entity_id, action, from_status, to_status)
    values (new.id, v_actor, v_actor_kind, 'tenant', new.id, 'created', null, new.lifecycle_status);
  elsif TG_OP = 'UPDATE' and new.lifecycle_status is distinct from old.lifecycle_status then
    insert into public.audit_events(tenant_id, actor_user_id, actor_kind, entity_type, entity_id, action, from_status, to_status)
    values (new.id, v_actor, v_actor_kind, 'tenant', new.id, 'status_changed', old.lifecycle_status, new.lifecycle_status);
  end if;
  return new;
end;
$$;
create trigger tenants_audit after insert or update on public.tenants
  for each row execute function app.audit_tenant_lifecycle();

create or replace function app.audit_entity_status() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := app.uid();
  v_actor_kind text := case when app.is_staff() then 'staff' when v_actor is not null then 'client' else 'system' end;
  v_entity_type text := TG_ARGV[0];
begin
  if TG_OP = 'INSERT' then
    insert into public.audit_events(tenant_id, actor_user_id, actor_kind, entity_type, entity_id, action, from_status, to_status)
    values (new.tenant_id, v_actor, v_actor_kind, v_entity_type, new.id, 'created', null, new.status);
  elsif TG_OP = 'UPDATE' and new.status is distinct from old.status then
    insert into public.audit_events(tenant_id, actor_user_id, actor_kind, entity_type, entity_id, action, from_status, to_status)
    values (new.tenant_id, v_actor, v_actor_kind, v_entity_type, new.id, 'status_changed', old.status, new.status);
  end if;
  return new;
end;
$$;

create trigger products_audit after insert or update on public.products
  for each row execute function app.audit_entity_status('product');
create trigger fabrics_audit after insert or update on public.fabrics
  for each row execute function app.audit_entity_status('fabric');
create trigger fabric_collections_audit after insert or update on public.fabric_collections
  for each row execute function app.audit_entity_status('fabric_collection');
create trigger intake_requests_audit after insert or update on public.intake_requests
  for each row execute function app.audit_entity_status('intake_request');
create trigger intake_items_audit after insert or update on public.intake_items
  for each row execute function app.audit_entity_status('intake_item');
```

- [ ] **Step 2: Apply and verify a status change actually produces an audit row**

Run: `npm run db:test` (migrations apply, triggers install cleanly).

```bash
psql -d sim_local -c "
  insert into public.tenants (id, slug, name, lifecycle_status) values
    ('44444444-4444-4444-4444-444444444444','audit-check','Audit Check','lead');
  update public.tenants set lifecycle_status = 'live' where id = '44444444-4444-4444-4444-444444444444';
  select entity_type, action, from_status, to_status from public.audit_events
    where entity_id = '44444444-4444-4444-4444-444444444444' order by created_at;
  delete from public.tenants where id = '44444444-4444-4444-4444-444444444444';
"
```
Expected: two rows — `(tenant, created, NULL, lead)` and `(tenant, status_changed, lead, live)`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_audit_usage.sql
git commit -m "feat: audit_events + usage_events tables with status-change triggers"
```

---

## Task 6: RLS — grants + enable/force + policies on every table

The core isolation gate. Every table from Tasks 2–5 gets locked down here in one migration so the acceptance-gate tests in Task 8 have something real to check.

**Files:**
- Create: `supabase/migrations/0006_rls.sql`

**Interfaces:**
- Consumes: all tables from Tasks 2–5, all `app.*` helper functions from Task 2.
- Produces: no new tables/functions — this migration only grants, enables, forces, and defines policies.

- [ ] **Step 1: Write the RLS migration**

```sql
-- supabase/migrations/0006_rls.sql

revoke all on all tables in schema public from public, anon;

-- ============ tenants ============
grant select, insert, update on public.tenants to authenticated;
alter table public.tenants enable row level security;
alter table public.tenants force row level security;

create policy tenants_client_select on public.tenants
  for select to authenticated
  using (id = any (app.accessible_tenant_ids()));

create policy tenants_staff_all on public.tenants
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ platform_staff ============
grant select, insert, update on public.platform_staff to authenticated;
alter table public.platform_staff enable row level security;
alter table public.platform_staff force row level security;

create policy platform_staff_select on public.platform_staff
  for select to authenticated
  using (app.is_staff());

create policy platform_staff_admin_insert on public.platform_staff
  for insert to authenticated
  with check (app.staff_role() = 'admin');

create policy platform_staff_admin_update on public.platform_staff
  for update to authenticated
  using (app.staff_role() = 'admin')
  with check (app.staff_role() = 'admin');

-- ============ memberships ============
grant select, insert, update, delete on public.memberships to authenticated;
alter table public.memberships enable row level security;
alter table public.memberships force row level security;

create policy memberships_self_select on public.memberships
  for select to authenticated
  using (user_id = app.uid() and revoked_at is null);

create policy memberships_staff_all on public.memberships
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ fabric_collections ============
grant select, insert, update, delete on public.fabric_collections to authenticated;
alter table public.fabric_collections enable row level security;
alter table public.fabric_collections force row level security;

create policy fabric_collections_client_select on public.fabric_collections
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()) and status = 'live');

create policy fabric_collections_staff_all on public.fabric_collections
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ fabrics ============
grant select, insert, update, delete on public.fabrics to authenticated;
alter table public.fabrics enable row level security;
alter table public.fabrics force row level security;

create policy fabrics_client_select on public.fabrics
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()) and status in ('live','retired'));

create policy fabrics_staff_all on public.fabrics
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ products ============
grant select, insert, update, delete on public.products to authenticated;
alter table public.products enable row level security;
alter table public.products force row level security;

create policy products_client_select on public.products
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()) and status = 'live');

create policy products_staff_all on public.products
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ product_fabric_collections ============
grant select, insert, update, delete on public.product_fabric_collections to authenticated;
alter table public.product_fabric_collections enable row level security;
alter table public.product_fabric_collections force row level security;

create policy pfc_client_select on public.product_fabric_collections
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()));

create policy pfc_staff_all on public.product_fabric_collections
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ product_part_map_versions (append-only) ============
grant select, insert on public.product_part_map_versions to authenticated;
alter table public.product_part_map_versions enable row level security;
alter table public.product_part_map_versions force row level security;

create policy ppmv_staff_select on public.product_part_map_versions
  for select to authenticated
  using (app.is_staff());

create policy ppmv_staff_insert on public.product_part_map_versions
  for insert to authenticated
  with check (app.is_staff());
-- No update/delete policy anywhere — append-only by omission, not by a
-- policy that denies (stronger and simpler).

-- ============ intake_requests ============
grant select, insert, update, delete on public.intake_requests to authenticated;
alter table public.intake_requests enable row level security;
alter table public.intake_requests force row level security;

create policy intake_requests_client_select on public.intake_requests
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()));

create policy intake_requests_client_insert on public.intake_requests
  for insert to authenticated
  with check (tenant_id = any (app.accessible_tenant_ids()) and status = 'draft');

create policy intake_requests_client_update on public.intake_requests
  for update to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()) and status = 'draft')
  with check (tenant_id = any (app.accessible_tenant_ids()) and status in ('draft','submitted'));

create policy intake_requests_staff_all on public.intake_requests
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ intake_items ============
grant select, insert, update, delete on public.intake_items to authenticated;
alter table public.intake_items enable row level security;
alter table public.intake_items force row level security;

create policy intake_items_client_select on public.intake_items
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()));

create policy intake_items_client_insert on public.intake_items
  for insert to authenticated
  with check (
    tenant_id = any (app.accessible_tenant_ids())
    and exists (
      select 1 from public.intake_requests r
      where r.tenant_id = intake_items.tenant_id
        and r.id = intake_items.intake_request_id
        and r.status = 'draft'
    )
  );

create policy intake_items_client_update on public.intake_items
  for update to authenticated
  using (
    tenant_id = any (app.accessible_tenant_ids())
    and exists (
      select 1 from public.intake_requests r
      where r.tenant_id = intake_items.tenant_id
        and r.id = intake_items.intake_request_id
        and r.status = 'draft'
    )
  )
  with check (tenant_id = any (app.accessible_tenant_ids()));

create policy intake_items_staff_all on public.intake_items
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ intake_assets ============
grant select, insert, delete on public.intake_assets to authenticated;
alter table public.intake_assets enable row level security;
alter table public.intake_assets force row level security;

create policy intake_assets_client_select on public.intake_assets
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()));

create policy intake_assets_client_insert on public.intake_assets
  for insert to authenticated
  with check (tenant_id = any (app.accessible_tenant_ids()) and uploaded_by = app.uid());

create policy intake_assets_staff_all on public.intake_assets
  for all to authenticated
  using (app.is_staff())
  with check (app.is_staff());

-- ============ audit_events (append-only, staff-read-only) ============
grant select on public.audit_events to authenticated;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy audit_events_staff_select on public.audit_events
  for select to authenticated
  using (app.is_staff());
-- No insert/update/delete policy for anyone — only the SECURITY DEFINER
-- triggers from Task 5 write here.

-- ============ usage_events ============
grant select on public.usage_events to authenticated;
grant select, insert on public.usage_events to service_role;
alter table public.usage_events enable row level security;
alter table public.usage_events force row level security;

create policy usage_events_client_select on public.usage_events
  for select to authenticated
  using (tenant_id = any (app.accessible_tenant_ids()));

create policy usage_events_staff_select on public.usage_events
  for select to authenticated
  using (app.is_staff());
-- No insert policy for `authenticated` — writes happen via service_role,
-- wired up in Phase 4.
```

- [ ] **Step 2: Apply**

Run: `npm run db:test`. Expected: all six migrations apply cleanly (no seed/tests yet, so the loops still no-op past this point — Task 7/8 add those). If any `CREATE POLICY` fails, read the error — it's almost always a typo'd table/column name; fix and rerun.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_rls.sql
git commit -m "feat: RLS — grants, enable+force, and policies on every table"
```

---

## Task 7: Seed fixtures

Fixed-UUID fixtures covering every isolation scenario Task 8 needs to assert against: two ordinary live tenants (cross-tenant read/write isolation), one `in_build` tenant with an open intake request (onboarding-lifecycle fixture), one suspended tenant with a still-valid membership (proves suspension bites despite a valid-looking session), one live tenant with one revoked membership (proves membership revocation bites independently), plus staff (one active, one revoked) and a seeded guest-sandbox tenant row.

**Files:**
- Create: `supabase/local/10_seed.sql`

**Interfaces:**
- Consumes: every table from Tasks 2–5.
- Produces: no schema — data only. Fixed IDs referenced directly by Task 8's tests (documented here so there's one source of truth):
  - Tenants: Acme `a1000000-0000-0000-0000-000000000001` (live), Cove `...002` (live), Bhavya `...003` (in_build), Suspended Ltd `...004` (suspended), Tenant E `...005` (live, one revoked member), Guest `...009` (live, quota 20).
  - Users: `b2000000-…0001` buyer@acme, `…0002` ops@acme (client_admin), `…0003` buyer@cove, `…0004` user_d@suspended (active membership on suspended tenant), `…0005` user_e@e (revoked membership on live tenant).
  - Staff: `c3000000-…0001` builder@livinit (active, `builder`), `…0002` revoked@livinit (revoked, `admin`).

- [ ] **Step 1: Write the seed file**

```sql
-- supabase/local/10_seed.sql — LOCAL ONLY. Inserting directly into
-- auth.users is not possible on real cloud Supabase (that goes through the
-- Auth Admin API) — cloud seeding is Phase 2's problem, by design.

insert into auth.users (id, email) values
  ('b2000000-0000-0000-0000-000000000001','buyer@acme.test'),
  ('b2000000-0000-0000-0000-000000000002','ops@acme.test'),
  ('b2000000-0000-0000-0000-000000000003','buyer@cove.test'),
  ('b2000000-0000-0000-0000-000000000004','user_d@suspended.test'),
  ('b2000000-0000-0000-0000-000000000005','user_e@e.test'),
  ('c3000000-0000-0000-0000-000000000001','builder@livinit.test'),
  ('c3000000-0000-0000-0000-000000000002','revoked@livinit.test');

insert into public.platform_staff (user_id, staff_role, revoked_at) values
  ('c3000000-0000-0000-0000-000000000001','builder', null),
  ('c3000000-0000-0000-0000-000000000002','admin', now());

insert into public.tenants (id, slug, name, lifecycle_status, suspended_at, daily_ai_quota) values
  ('a1000000-0000-0000-0000-000000000001','acme','Acme Furniture','live', null, 50),
  ('a1000000-0000-0000-0000-000000000002','cove','Cove & Co.','live', null, 50),
  ('a1000000-0000-0000-0000-000000000003','bhavya','Bhavya Interiors','in_build', null, 50),
  ('a1000000-0000-0000-0000-000000000004','suspended-ltd','Suspended Ltd','suspended', now(), 50),
  ('a1000000-0000-0000-0000-000000000005','tenant-e','Tenant E','live', null, 50),
  ('a1000000-0000-0000-0000-000000000009','guest','Livinit Guest Sandbox','live', null, 20);

insert into public.memberships (tenant_id, user_id, role, revoked_at) values
  ('a1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','client', null),
  ('a1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002','client_admin', null),
  ('a1000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000003','client', null),
  ('a1000000-0000-0000-0000-000000000004','b2000000-0000-0000-0000-000000000004','client', null),
  ('a1000000-0000-0000-0000-000000000005','b2000000-0000-0000-0000-000000000005','client', now());

-- Tenant A (Acme): 2 collections, 6 fabrics (5 live + 1 retired), 2 products (1 live + 1 in_build)
insert into public.fabric_collections (id, tenant_id, name, vendor, material_class, status) values
  ('d4000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','Allante','MityLite Sierra','vinyl','live'),
  ('d4000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000001','Thalassa','Ennis','fabric','live');

insert into public.fabrics (id, tenant_id, collection_id, name, material_type, hex, swatch_key, status, retired_at) values
  ('d5000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000001','Autumn Rain','vinyl','#8a7d6e','shared/fabric_maps/allante/autumn_rain.jpg','live', null),
  ('d5000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000001','Birch','vinyl','#d8cdb8','shared/fabric_maps/allante/birch.jpg','live', null),
  ('d5000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000001','Bleached Sand','vinyl','#e0d6c3','shared/fabric_maps/allante/bleached_sand.jpg','live', null),
  ('d5000000-0000-0000-0000-000000000004','a1000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000002','Coastal Weave','fabric','#c4b8a0','shared/fabric_maps/thalassa/coastal_weave.jpg','live', null),
  ('d5000000-0000-0000-0000-000000000005','a1000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000002','Harbor Mist','fabric','#a9b0ad','shared/fabric_maps/thalassa/harbor_mist.jpg','live', null),
  ('d5000000-0000-0000-0000-000000000006','a1000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000002','Old Rope','fabric','#8f7a5c','shared/fabric_maps/thalassa/old_rope.jpg','retired', now());

insert into public.products (id, tenant_id, key, name, glb_key, status) values
  ('e6000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','chair','Sierra Chair','tenants/a1000000-0000-0000-0000-000000000001/glbs/chair.glb','live'),
  ('e6000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000001','sofa','Harbour Sofa','tenants/a1000000-0000-0000-0000-000000000001/glbs/sofa.glb','in_build');

-- Tenant B (Cove & Co.): 1 collection, 3 live fabrics, 1 live product
insert into public.fabric_collections (id, tenant_id, name, vendor, material_class, status) values
  ('d4000000-0000-0000-0000-000000000010','a1000000-0000-0000-0000-000000000002','Bali','Douglass','fabric','live');

insert into public.fabrics (id, tenant_id, collection_id, name, material_type, hex, swatch_key, status) values
  ('d5000000-0000-0000-0000-000000000011','a1000000-0000-0000-0000-000000000002','d4000000-0000-0000-0000-000000000010','Lagoon','fabric','#5f8f8a','shared/fabric_maps/bali/lagoon.jpg','live'),
  ('d5000000-0000-0000-0000-000000000012','a1000000-0000-0000-0000-000000000002','d4000000-0000-0000-0000-000000000010','Palm','fabric','#6f8f5a','shared/fabric_maps/bali/palm.jpg','live'),
  ('d5000000-0000-0000-0000-000000000013','a1000000-0000-0000-0000-000000000002','d4000000-0000-0000-0000-000000000010','Reef','fabric','#3f6f8a','shared/fabric_maps/bali/reef.jpg','live');

insert into public.products (id, tenant_id, key, name, glb_key, status) values
  ('e6000000-0000-0000-0000-000000000010','a1000000-0000-0000-0000-000000000002','sofa','Cove Sofa','tenants/a1000000-0000-0000-0000-000000000002/glbs/sofa.glb','live');

-- Tenant C (Bhavya): onboarding in progress — the intake-lifecycle fixture
insert into public.intake_requests (id, tenant_id, kind, title, status) values
  ('f7000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','onboarding','Bhavya Interiors — initial catalog','in_build');

insert into public.intake_items (id, tenant_id, intake_request_id, item_type, title, status, assigned_to) values
  ('f8000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','f7000000-0000-0000-0000-000000000001','product','Lounge Chair','submitted', null),
  ('f8000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','f7000000-0000-0000-0000-000000000001','product','3-Seater Sofa','in_build','c3000000-0000-0000-0000-000000000001'),
  ('f8000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000003','f7000000-0000-0000-0000-000000000001','fabric_collection','Signature Weaves','changes_requested','c3000000-0000-0000-0000-000000000001');

insert into public.intake_assets (id, tenant_id, intake_request_id, intake_item_id, kind, s3_key) values
  ('f9000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','f7000000-0000-0000-0000-000000000001','f8000000-0000-0000-0000-000000000001','product_photo','tenants/a1000000-0000-0000-0000-000000000003/intake/lounge_chair/front.jpg'),
  ('f9000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','f7000000-0000-0000-0000-000000000001', null,'spec_sheet','tenants/a1000000-0000-0000-0000-000000000003/intake/spec_sheet.pdf');

-- Tenant D (suspended) — one live product, to prove it becomes invisible
insert into public.products (id, tenant_id, key, name, glb_key, status) values
  ('e6000000-0000-0000-0000-000000000020','a1000000-0000-0000-0000-000000000004','chair','Suspended Chair','tenants/a1000000-0000-0000-0000-000000000004/glbs/chair.glb','live');

-- Tenant E (live, but its one member is revoked) — one live product
insert into public.products (id, tenant_id, key, name, glb_key, status) values
  ('e6000000-0000-0000-0000-000000000030','a1000000-0000-0000-0000-000000000005','chair','Tenant E Chair','tenants/a1000000-0000-0000-0000-000000000005/glbs/chair.glb','live');
```

- [ ] **Step 2: Apply and spot-check counts**

Run: `npm run db:test`.

```bash
psql -d sim_local -c "
  select (select count(*) from public.tenants) as tenants,
         (select count(*) from public.products) as products,
         (select count(*) from public.fabrics) as fabrics,
         (select count(*) from public.audit_events) as audit_rows;
"
```
Expected: `tenants=6, products=5, fabrics=9, audit_rows > 0` (the triggers from Task 5 fire on every insert above — a non-zero count confirms they're wired correctly against real seed data, not just the single manual test from Task 5).

- [ ] **Step 3: Commit**

```bash
git add supabase/local/10_seed.sql
git commit -m "test: seed fixtures for RLS isolation suite"
```

---

## Task 8: Assertion helpers + isolation test suite (the Phase 1 acceptance gate)

**Files:**
- Create: `supabase/tests/00_assert.sql`
- Create: `supabase/tests/10_meta_coverage.sql`
- Create: `supabase/tests/20_isolation_read.sql`
- Create: `supabase/tests/30_isolation_write.sql`
- Create: `supabase/tests/40_suspension_revocation.sql`
- Create: `supabase/tests/50_staff_access.sql`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: nothing further downstream — this is the terminal deliverable of Phase 1. `npm run db:test` exiting 0 is the acceptance gate referenced by the design doc and by Phase 2's kickoff.

- [ ] **Step 1: Write the assertion helpers**

```sql
-- supabase/tests/00_assert.sql
create schema if not exists tests;

create or replace function tests.assert_eq(actual bigint, expected bigint, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL % — expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok  %', label;
end $$;

create or replace function tests.assert_raises(sql text, sqlstate_expected text, label text)
returns void language plpgsql as $$
begin
  begin
    execute sql;
    raise exception 'FAIL % — expected SQLSTATE %, statement succeeded', label, sqlstate_expected;
  exception when others then
    if SQLSTATE <> sqlstate_expected then
      raise exception 'FAIL % — expected %, got % (%)', label, sqlstate_expected, SQLSTATE, SQLERRM;
    end if;
    raise notice 'ok  %', label;
  end;
end $$;

-- Catches the exact trap that makes RLS tests lie: running as a superuser
-- or a BYPASSRLS role silently passes every assertion without proving
-- anything. Call this right after every `set local role authenticated;`.
create or replace function tests.assert_session_is_sandboxed(label text)
returns void language plpgsql as $$
declare
  v_super boolean;
  v_bypass boolean;
begin
  select rolsuper, rolbypassrls into v_super, v_bypass from pg_roles where rolname = current_user;
  if v_super then
    raise exception 'FAIL % — current_user % is a superuser, RLS is bypassed', label, current_user;
  end if;
  if v_bypass then
    raise exception 'FAIL % — current_user % has BYPASSRLS, RLS is bypassed', label, current_user;
  end if;
  raise notice 'ok  % — session sandboxed (%)', label, current_user;
end $$;
```

- [ ] **Step 2: Write the meta-coverage test**

```sql
-- supabase/tests/10_meta_coverage.sql
-- Structural checks, run as the connecting (superuser) role deliberately —
-- these query catalog metadata, not row data, so superuser status doesn't
-- invalidate them.

select tests.assert_eq(
  (select count(*)
     from information_schema.columns c
     join pg_class rel on rel.relname = c.table_name and rel.relnamespace = 'public'::regnamespace
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
      and (rel.relrowsecurity = false or rel.relforcerowsecurity = false)),
  0, 'every tenant_id table has RLS enabled AND forced');

select tests.assert_eq(
  (select count(*) from pg_policies
    where schemaname = 'public' and cmd in ('INSERT','UPDATE') and with_check is null),
  0, 'every INSERT/UPDATE policy has a WITH CHECK');

select tests.assert_eq(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'),
  0, 'anon has zero table-level grants anywhere in public');
```

- [ ] **Step 3: Write the isolation-read test**

```sql
-- supabase/tests/20_isolation_read.sql

begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('isolation-read suite');
  set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000001","role":"client","tenant_id":"a1000000-0000-0000-0000-000000000001"}';

  select tests.assert_eq((select count(*) from public.products where tenant_id = 'a1000000-0000-0000-0000-000000000002'), 0, 'A sees zero of B''s products');
  select tests.assert_eq((select count(*) from public.fabrics where tenant_id = 'a1000000-0000-0000-0000-000000000002'), 0, 'A sees zero of B''s fabrics');
  select tests.assert_eq((select count(*) from public.products), 1, 'A sees only its LIVE product (in_build hidden)');
  select tests.assert_eq((select count(*) from public.fabrics where status = 'live'), 5, 'A sees its 5 live fabrics');
  select tests.assert_eq((select count(*) from public.fabrics), 6, 'A sees live+retired (6), draft/in_build hidden');
  select tests.assert_eq((select count(*) from public.tenants), 1, 'A sees only its own tenant row');
  select tests.assert_eq((select count(*) from public.intake_requests where tenant_id = 'a1000000-0000-0000-0000-000000000003'), 0, 'A sees zero of C''s intake requests');
rollback;

-- Forged claim: sub is still A's user, but the tenant_id CLAIM says B.
-- Must still resolve to only A's data — proves the claim is a hint, not
-- the authority (accessible_tenant_ids() re-derives from memberships).
begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('forged-claim check');
  set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000001","role":"client","tenant_id":"a1000000-0000-0000-0000-000000000002"}';

  select tests.assert_eq((select count(*) from public.products where tenant_id = 'a1000000-0000-0000-0000-000000000002'), 0, 'forged tenant_id claim grants nothing of B''s');
  select tests.assert_eq((select count(*) from public.products), 1, 'forged claim: A still sees only A''s own live product');
rollback;
```

- [ ] **Step 4: Write the isolation-write test**

```sql
-- supabase/tests/30_isolation_write.sql

begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('isolation-write suite');
  set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000001","role":"client","tenant_id":"a1000000-0000-0000-0000-000000000001"}';

  select tests.assert_raises(
    $q$ insert into public.intake_requests (tenant_id, kind, title)
        values ('a1000000-0000-0000-0000-000000000002', 'product_addition', 'evil') $q$,
    '42501', 'A cannot insert an intake request into B''s tenant');

  select tests.assert_raises(
    $q$ insert into public.products (tenant_id, key, name, glb_key)
        values ('a1000000-0000-0000-0000-000000000001','x','X','tenants/a1000000-0000-0000-0000-000000000001/glbs/x.glb') $q$,
    '42501', 'client cannot create products directly (staff-only table)');

  insert into public.intake_requests (tenant_id, kind, title, status)
    values ('a1000000-0000-0000-0000-000000000001','product_addition','New rug line','draft');

  select tests.assert_raises(
    $q$ update public.intake_requests set tenant_id = 'a1000000-0000-0000-0000-000000000002'
        where tenant_id = 'a1000000-0000-0000-0000-000000000001' and kind = 'product_addition' $q$,
    '42501', 'client cannot re-tenant a row it owns (WITH CHECK catches it)');
rollback;
```

- [ ] **Step 5: Write the suspension/revocation test**

```sql
-- supabase/tests/40_suspension_revocation.sql

begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('suspension check');
  set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000004","role":"client","tenant_id":"a1000000-0000-0000-0000-000000000004"}';
  select tests.assert_eq((select count(*) from public.products), 0, 'suspended tenant''s member sees nothing despite a valid-looking, unexpired session');
rollback;

begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('revocation check');
  set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000005","role":"client","tenant_id":"a1000000-0000-0000-0000-000000000005"}';
  select tests.assert_eq((select count(*) from public.products), 0, 'revoked membership sees nothing even though the tenant itself is live');
rollback;

begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('revoked-staff check');
  set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000002","role":"livinit_staff"}';
  select tests.assert_eq((select count(*) from public.tenants), 0, 'revoked staff sees nothing despite a staff-shaped claim');
rollback;
```

- [ ] **Step 6: Write the staff-access test**

```sql
-- supabase/tests/50_staff_access.sql

begin;
  set local role authenticated;
  select tests.assert_session_is_sandboxed('staff-access suite');
  set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000001","role":"livinit_staff"}';

  select tests.assert_eq((select count(*) from public.products), 5, 'active staff sees every product across every tenant, including in_build');
  select tests.assert_eq((select count(*) from public.tenants), 6, 'active staff sees every tenant');

  insert into public.products (tenant_id, key, name, glb_key, status)
    values ('a1000000-0000-0000-0000-000000000002','loveseat','Cove Loveseat','tenants/a1000000-0000-0000-0000-000000000002/glbs/loveseat.glb','draft');
  select tests.assert_eq((select count(*) from public.products where key = 'loveseat'), 1, 'staff can insert a product for any tenant');

  select tests.assert_raises(
    $q$ insert into public.platform_staff (user_id, staff_role) values ('b2000000-0000-0000-0000-000000000001','admin') $q$,
    '42501', 'a builder (not admin) cannot grant platform_staff rows');
rollback;

begin;
  set local role anon;
  select tests.assert_raises('select count(*) from public.tenants', '42501', 'anon has no SELECT grant on tenants at all');
  select tests.assert_raises('select count(*) from public.products', '42501', 'anon has no SELECT grant on products at all');
rollback;
```

- [ ] **Step 7: Run the full suite — this is the Phase 1 acceptance gate**

Run: `npm run db:test`

Expected: every migration applies, seed loads, every `tests.assert_*` call prints `ok  <label>`, script prints `RLS suite passed`, exit code 0. If anything fails, the `raise exception` message names exactly which assertion and why — fix the migration/policy/seed row it points at and rerun `npm run db:test` from scratch (the script drops and recreates `sim_local` every time, so there's no stale-state risk).

- [ ] **Step 8: Commit**

```bash
git add supabase/tests/
git commit -m "test: RLS isolation acceptance suite — phase 1 gate green"
```

---

## Done condition for this plan

`npm run db:test` exits 0, covering: cross-tenant read isolation (including a forged JWT claim), cross-tenant write rejection (including the tenant-reassignment/WITH-CHECK case), suspension and membership-revocation both biting immediately regardless of an unexpired session, staff seeing and writing across all tenants while non-admin staff can't grant platform_staff rows, and anon having zero access anywhere. This is the schema and isolation boundary Phase 2 (real Supabase Auth + the claims hook) builds on top of — no further Phase 1 work follows this.
