# Tenant Workspace Setup (Sub-project 1 of the Self-Service Onboarding Flow) — Design

**Date:** 2026-07-30 · **Branch:** created during planning · **Approved by founder:** no (approved by user in-session, not yet by founder)

## 1. Problem

This is the first of five sub-projects decomposed from a larger self-service onboarding
flow the user provided as a flowchart (`Create tenant workspace → Choose business goal →
What are you adding? → choose data source → extract → review → publish`). The full flow
is a large, multi-subsystem project (web scraping, AI extraction, a review/correction UI,
an asset pipeline, a mapping/preview/approval workbench) and is being built incrementally,
not as one spec. This document covers only the first two boxes: **workspace setup** and
**business goal selection**.

**Reconciling with the same day's staff-account-creation design:** that design
(`2026-07-29-staff-account-creation-design.md`, in `backend-livinit`) already locked staff
as the ones creating a tenant row and inviting its first login — self-serve signup was
explicitly rejected. This sub-project does **not** reverse that: "Create tenant workspace"
here means the invited tenant admin's **first-login finishing step** on a tenant row staff
already created — not tenant-initiated account creation from scratch. The tenant row
exists before this flow ever runs.

## 2. Decisions locked this session

| Question | Decision |
|---|---|
| Who triggers this | The tenant's `client_admin` user, on their first real login, after staff has already created the tenant + invited them (prior session's work). |
| What "workspace setup" captures | Confirm/edit the workspace display name and branding, then pick a business goal. |
| Business goal purpose | Informational/marketing context only — recorded, does **not** gate or pre-select anything in the next sub-project ("What are you adding?"). |
| Business goal options | Fixed set of 4 + freeform "Other": *Sell configured furniture online* / *In-store or live sales consultation tool* / *Reduce returns from fabric/color mismatch* / *Showcase catalog to trade/designers*. |
| Completion signal | No separate boolean flag — `tenants.business_goal IS NOT NULL` **is** "setup complete." Nothing to keep in sync. |

## 3. Architecture

**Backend (`backend-livinit`), migration `0008_workspace_setup.sql`:**
- `alter table simulator.tenants add column business_goal text;` — nullable, no CHECK
  constraint (the "Other" freeform option means arbitrary text is valid, not just the 4
  fixed values).
- New RLS policy, additive to the existing `tenants_client_select`
  (`0006_rls.sql`) — clients currently have SELECT-only on their own tenant row:
  ```sql
  create policy tenants_client_admin_update on simulator.tenants
    for update to authenticated
    using (
      id = any (simulator.accessible_tenant_ids())
      and exists (
        select 1 from simulator.memberships m
        where m.tenant_id = simulator.tenants.id
          and m.user_id = simulator.uid()
          and m.role = 'client_admin'
          and m.revoked_at is null
      )
    )
    with check (
      id = any (simulator.accessible_tenant_ids())
      and exists (
        select 1 from simulator.memberships m
        where m.tenant_id = simulator.tenants.id
          and m.user_id = simulator.uid()
          and m.role = 'client_admin'
          and m.revoked_at is null
      )
    );
  ```
  Plain `client` role (non-admin) members do not get UPDATE — only `client_admin`.

**Backend, new route** — `src/simulator/routes/tenant_self_service.py`:
- `PATCH /simulator/tenant` — body `{business_goal: str, branding: dict | None}`. Uses
  the caller's own RLS-scoped client (`get_simulator_db()`, already exists) — the new RLS
  policy is what actually enforces "only your own tenant, only if you're client_admin";
  the endpoint itself does not re-derive tenant_id from the request (there's no
  `tenant_id` in the body — it always targets the caller's own tenant via
  `accessible_tenant_ids()`, so there's no path for a client to target someone else's
  tenant id even by mistake). A plain `client` role gets a `403` at the RLS layer,
  surfaced through the existing generic `APIError` handler in `src/main.py` (no new
  exception handling needed — same pattern already used elsewhere in `src/simulator`).

**Backend, existing route change** — `src/simulator/routes/me.py`'s tenant payload gains
`business_goal` (straight passthrough of the column, already selecting `tenant.*`-style
fields — one field added to the existing `select(...)` list and the returned dict).

**Frontend (`livinit_fabric_simulator`):**
- `src/app/boot.js`'s `main()` — after a `real` + `live` tenant result, before calling
  `bootWithSession`, check `result.business_goal`. If `null`, render the setup wizard
  instead of booting the app.
- New file `src/features/onboarding/workspace-setup.js` — two-screen wizard (workspace
  name/branding confirm → business goal picker, 4 radio options + "Other" text input),
  reusing the existing `#auth-gate`-style full-screen overlay visual pattern (new
  container, not the literal `#auth-gate` element — that's login-specific) for
  consistency with the rest of the app's chrome. On submit, `PATCH /simulator/tenant`,
  then call `bootWithSession` directly (no reload needed — the wizard already has the
  tenant object in memory from the `/me` call `main()` already made).

## 4. Data flow

1. Tenant signs in (existing real-login flow) → `GET /simulator/me` →
   `tenant.status === 'live' && tenant.business_goal === null`. A staff-created tenant
   is `'live'` immediately on creation (see §5 — amended in
   `2026-07-29-staff-account-creation-design.md`), so this is always reachable right
   after the invited user accepts and logs in — never blocked behind the draft gate.
2. Wizard renders instead of the app.
3. Tenant confirms workspace name/branding, picks a business goal, submits.
4. `PATCH /simulator/tenant` → `200` → wizard calls `bootWithSession` with the
   now-updated tenant object → normal app.
5. Any later login: `business_goal` is set → wizard never shows → straight to the app.

## 5. Cross-spec amendment this sub-project required

A freshly staff-created tenant would have defaulted to `lifecycle_status: 'lead'`
(schema default), and `tenant.js`'s current gating only treats `'live'` as bootable —
every other status shows the generic draft gate, which would have made this wizard
unreachable for a brand-new tenant. Resolved (2026-07-30, this session): a staff-created
tenant is set to `'live'` immediately on creation. This required amending the already-
committed `2026-07-29-staff-account-creation-design.md` (§3, `POST /simulator/staff/tenants`)
— see that file's 2026-07-30 amendment note. Both documents now agree.

## 6. Error handling

- Non-`client_admin` member hitting `PATCH /simulator/tenant` → `403` (RLS-enforced).
- Empty/missing `business_goal` in the request body → `422` (Pydantic, required field).
- Network failure on submit → inline retry, same visual pattern as the existing
  `#auth-neterr` state — does not sign the user out (unlike the login-gate's net-error
  state) since they're already authenticated; only the save failed.

## 7. Testing

No local Supabase credentials in this environment, same constraint as all prior work
this session. Plan tasks: code + a manual verification checklist (does the RLS policy
actually reject a plain `client` role, does `business_goal` actually persist and
suppress the wizard on next login) — deferred to a human with real backend access,
consistent with how every other real-backend-dependent piece has been handled so far.
