# Tenant Workspace Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Livinit staff an API to create a client tenant + invite its first login, and give that invited tenant a one-time post-login "workspace setup" wizard (branding confirm + business-goal pick) in the fabric simulator frontend.

**Architecture:** Backend-first: a `require_staff` auth dependency, a new `staff_accounts.py` router (tenant create, user invite) built on RLS policies that already exist, then a migration adding `tenants.business_goal` + a `client_admin`-only RLS update policy, a new `tenant_self_service.py` router (`PATCH /simulator/tenant`), and a small extension to the existing `GET /simulator/me`. Frontend last: `tenant.js` passes `business_goal` through, a new wizard file gates `boot.js`'s `main()` before the app boots when `business_goal` is still null.

**Tech Stack:** FastAPI/Pydantic/Supabase-py (backend-livinit), vanilla ES modules/no build step (livinit_fabric_simulator).

## Global Constraints

- Backend: no `git add -A`/`git add .` — stage files by exact name (this repo has other in-flight work).
- Backend verification commands: `.venv/bin/python -m compileall src -q`, `.venv/bin/python -m ruff check src`, and (for any task touching `src/simulator/sql/`) `bash scripts/simulator_db_test.sh`.
- Frontend: no `git add -A`/`git add .` — this repo has pre-existing unrelated uncommitted paths (`docs/superpowers/specs/Fabric-Simulator-Screens.pdf` deleted, `docs/superpowers/plans/2026-07-27-tablet-mode-fixes.md` untracked, `test/demo-run.mjs` untracked) that must never be touched.
- Frontend verification commands: `npm run test:unit`, `node test/design-check.mjs`, `node test/smoke.mjs` (all three, every task that touches `src/`).
- A staff-created tenant is created with `lifecycle_status: 'live'` immediately (not the schema default `'lead'`) — see the 2026-07-30 amendment in `2026-07-29-staff-account-creation-design.md` §3.
- `business_goal` accepts arbitrary text (the "Other" freeform option) — no CHECK constraint, no fixed-enum validation server-side beyond "non-empty."
- No product/fabric/catalog/billing/data-source/AI-extraction work — this plan is sub-project 1 of 5 only.

---

## Task 1: Backend — create branch, `require_staff` dependency

**Files:**
- Modify: `src/simulator/auth.py`

**Interfaces:**
- Produces: `require_staff(principal: SimulatorPrincipal = Depends(get_current_principal)) -> SimulatorPrincipal` — raises `403` if not staff, otherwise passes the principal through unchanged. Later tasks depend on this by name.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
git checkout -b feat/staff-accounts-and-workspace-setup
```

- [ ] **Step 2: Add `require_staff` to `auth.py`**

Append to the end of `src/simulator/auth.py` (after the existing `get_simulator_db` function):

```python
def require_staff(principal: SimulatorPrincipal = Depends(get_current_principal)) -> SimulatorPrincipal:
    """Gate for staff-only routes. principal.role is a claims-hook HINT like
    everywhere else in this module — but staff-only ADMIN actions (creating
    a tenant, inviting a user) have no RLS row to fall back on the way
    client-facing reads do, so this check is the actual authorization
    decision here, not just UI routing. Raising early keeps that fact
    explicit rather than letting a non-staff caller reach service-role code."""
    if principal.role != "livinit_staff":
        raise HTTPException(status_code=403, detail="staff access required")
    return principal
```

- [ ] **Step 3: Verify**

```bash
.venv/bin/python -m compileall src -q && echo COMPILE_OK
.venv/bin/python -m ruff check src
```
Expected: `COMPILE_OK`, `All checks passed!`.

- [ ] **Step 4: Commit**

```bash
git add src/simulator/auth.py
git commit -m "feat(simulator): require_staff dependency for admin-only routes"
```

---

## Task 2: Backend — `POST /simulator/staff/tenants`

**Files:**
- Create: `src/simulator/routes/staff_accounts.py`
- Modify: `src/simulator/app.py`

**Interfaces:**
- Consumes: `require_staff`, `SimulatorPrincipal`, `get_simulator_db` (from `..auth`, Task 1 + pre-existing).
- Produces: `router` (APIRouter) mounted at `simulator_app` — later tasks (Task 3) add more routes to this same file/router.

- [ ] **Step 1: Create `staff_accounts.py`**

```python
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from ..auth import SimulatorPrincipal, get_simulator_db, require_staff
from ..database import get_simulator_service_supabase

router = APIRouter(prefix="/staff", tags=["simulator-staff"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")


class CreateTenantRequest(BaseModel):
    name: str = Field(min_length=1)
    slug: str

    def validate_slug(self) -> None:
        if not _SLUG_RE.match(self.slug):
            raise HTTPException(
                status_code=422,
                detail="slug must be lowercase alphanumeric with hyphens, 3-40 chars, "
                "not starting or ending with a hyphen",
            )


@router.post("/tenants")
async def create_tenant(
    body: CreateTenantRequest,
    principal: SimulatorPrincipal = Depends(require_staff),
    db: Client = Depends(get_simulator_db),
) -> dict:
    """Staff-only. Creates a new client tenant, immediately 'live' — a
    staff-created account must be usable (invited user can log in and reach
    workspace setup) even before any product/fabric catalog exists for it.
    See docs/superpowers/specs/2026-07-29-staff-account-creation-design.md
    §3 (2026-07-30 amendment)."""
    body.validate_slug()

    result = (
        db.table("tenants")
        .insert({"name": body.name, "slug": body.slug, "lifecycle_status": "live"})
        .execute()
    )
    tenant = result.data[0]

    return {
        "id": tenant["id"],
        "name": tenant["name"],
        "slug": tenant["slug"],
        "lifecycle_status": tenant["lifecycle_status"],
    }
```

- [ ] **Step 2: Mount the router in `app.py`**

Find:
```python
from .routes import health, me
```
Replace with:
```python
from .routes import health, me, staff_accounts
```

Find:
```python
simulator_app.include_router(health.router)
simulator_app.include_router(me.router)
```
Replace with:
```python
simulator_app.include_router(health.router)
simulator_app.include_router(me.router)
simulator_app.include_router(staff_accounts.router)
```

- [ ] **Step 3: Verify**

```bash
.venv/bin/python -m compileall src -q && echo COMPILE_OK
.venv/bin/python -m ruff check src
```
Expected: `COMPILE_OK`, `All checks passed!`. (The unused `get_simulator_service_supabase` import will trigger a ruff F401 — this is expected and fixed in Task 3, which is the same file; do not remove the import now, Task 3 needs it.)

Actually — to keep this task's verification genuinely clean (not "expected to fail"), do not add the `get_simulator_service_supabase` import in this task at all; Task 3 adds it when it's actually used. Remove that import line from Step 1's code before running Step 3's verification, i.e. Step 1's file should start with:

```python
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from ..auth import SimulatorPrincipal, get_simulator_db, require_staff

router = APIRouter(prefix="/staff", tags=["simulator-staff"])
```
(i.e. no `from ..database import get_simulator_service_supabase` yet).

- [ ] **Step 4: Commit**

```bash
git add src/simulator/routes/staff_accounts.py src/simulator/app.py
git commit -m "feat(simulator): POST /simulator/staff/tenants"
```

---

## Task 3: Backend — `POST /simulator/staff/tenants/{tenant_id}/users`

**Files:**
- Modify: `src/simulator/routes/staff_accounts.py`

**Interfaces:**
- Consumes: `get_simulator_service_supabase` (from `..database`, pre-existing).
- Produces: nothing new consumed by later tasks — this is the last staff-accounts route this plan needs.

- [ ] **Step 1: Add the import**

In `src/simulator/routes/staff_accounts.py`, change:
```python
from ..auth import SimulatorPrincipal, get_simulator_db, require_staff
```
to:
```python
from ..auth import SimulatorPrincipal, get_simulator_db, require_staff
from ..database import get_simulator_service_supabase
```

- [ ] **Step 2: Add the request model and route**

Append to `src/simulator/routes/staff_accounts.py`:

```python
class InviteUserRequest(BaseModel):
    email: str = Field(min_length=3)
    role: str = Field(pattern="^(client|client_admin)$")


@router.post("/tenants/{tenant_id}/users")
async def invite_user(
    tenant_id: str,
    body: InviteUserRequest,
    principal: SimulatorPrincipal = Depends(require_staff),
    db: Client = Depends(get_simulator_db),
) -> dict:
    """Staff-only. Invites a new login into an existing tenant via
    Supabase's own invite-email flow — the invited user sets their own
    password, staff never sees or transmits one. If the membership insert
    fails after the invite succeeds, the invited auth.users row is deleted
    rather than left orphaned (an invited-but-tenantless user would hit the
    frontend's networkError dead-end for 'client role with no tenant row')."""
    service_client = get_simulator_service_supabase()

    invite_result = service_client.auth.admin.invite_user_by_email(body.email)
    user_id = invite_result.user.id

    try:
        db.table("memberships").insert(
            {"tenant_id": tenant_id, "user_id": user_id, "role": body.role}
        ).execute()
    except Exception as exc:
        service_client.auth.admin.delete_user(user_id)
        raise HTTPException(
            status_code=400, detail=f"could not add membership, invite rolled back: {exc}"
        ) from exc

    return {"tenant_id": tenant_id, "user_id": user_id, "email": body.email, "role": body.role}
```

- [ ] **Step 3: Verify**

```bash
.venv/bin/python -m compileall src -q && echo COMPILE_OK
.venv/bin/python -m ruff check src
```
Expected: `COMPILE_OK`, `All checks passed!`.

- [ ] **Step 4: Commit**

```bash
git add src/simulator/routes/staff_accounts.py
git commit -m "feat(simulator): POST /simulator/staff/tenants/{tenant_id}/users"
```

---

## Task 4: Backend — migration `0008`, `business_goal` + client_admin RLS

**Files:**
- Create: `src/simulator/sql/migrations/0008_workspace_setup.sql`

**Interfaces:** none (schema-only; Task 5's endpoint consumes the new column/policy by name).

- [ ] **Step 1: Write the migration**

```sql
-- Adds tenants.business_goal (workspace-setup wizard, Task 6/7 in this
-- plan's frontend) and lets a tenant's own client_admin update their
-- tenant row — previously clients had SELECT-only (0006_rls.sql
-- tenants_client_select). Plain 'client' role members still cannot.
alter table simulator.tenants add column business_goal text;

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

- [ ] **Step 2: Run the local RLS suite**

```bash
bash scripts/simulator_db_test.sh
```
Expected: applies cleanly (migration `0008` runs after `0007` with no errors), suite ends with `simulator RLS suite passed`. This migration adds a nullable column and one new policy — it does not change any existing assertion's expected behavior, so no test file changes are needed in this task.

- [ ] **Step 3: Commit**

```bash
git add src/simulator/sql/migrations/0008_workspace_setup.sql
git commit -m "feat(simulator): business_goal column + client_admin tenant-update RLS"
```

---

## Task 5: Backend — `PATCH /simulator/tenant` + extend `GET /simulator/me`

**Files:**
- Create: `src/simulator/routes/tenant_self_service.py`
- Modify: `src/simulator/routes/me.py`
- Modify: `src/simulator/app.py`

**Interfaces:**
- Produces: `PATCH /simulator/tenant` (client_admin only). `GET /simulator/me`'s `tenant` object gains a `business_goal` field — the frontend (Task 6) reads this by name.

- [ ] **Step 1: Create `tenant_self_service.py`**

```python
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from supabase import Client

from ..auth import SimulatorPrincipal, get_current_principal, get_simulator_db

router = APIRouter(tags=["simulator"])


class UpdateTenantRequest(BaseModel):
    business_goal: str = Field(min_length=1)
    branding: dict | None = None


@router.patch("/tenant")
async def update_own_tenant(
    body: UpdateTenantRequest,
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> dict:
    """Self-service update of the caller's OWN tenant — no tenant_id in the
    request body by design, so there is no path for a client to target
    another tenant's row even by mistake. Actual authorization is the
    tenants_client_admin_update RLS policy (migration 0008): a plain
    'client' role member gets zero rows affected, surfaced as the same
    generic Supabase/PostgREST error path src/main.py already handles.

    principal.tenant_id (the claims-hook HINT, same as every other route
    in this module) is used only to narrow which row this specific request
    targets — it is not the authorization decision. If it were ever stale
    relative to the caller's live membership, RLS's own re-derivation from
    accessible_tenant_ids() still governs whether the update is actually
    permitted; a stale claim can only make this call target zero rows, it
    can never make it succeed against a tenant the caller doesn't own."""
    update_payload = {"business_goal": body.business_goal}
    if body.branding is not None:
        update_payload["branding"] = body.branding

    result = (
        db.table("tenants")
        .update(update_payload)
        .eq("id", principal.tenant_id)
        .execute()
    )
    tenant = result.data[0]

    return {
        "id": tenant["id"],
        "name": tenant["name"],
        "slug": tenant["slug"],
        "status": tenant["lifecycle_status"],
        "business_goal": tenant["business_goal"],
    }
```

- [ ] **Step 2: Extend `me.py`'s tenant select + response**

In `src/simulator/routes/me.py`, find:
```python
    result = (
        db.table("tenants")
        .select("id, name, slug, lifecycle_status")
        .limit(1)
        .execute()
    )
```
Replace with:
```python
    result = (
        db.table("tenants")
        .select("id, name, slug, lifecycle_status, business_goal")
        .limit(1)
        .execute()
    )
```

Find:
```python
        "tenant": (
            {
                "id": tenant["id"],
                "name": tenant["name"],
                "slug": tenant["slug"],
                "status": tenant["lifecycle_status"],
            }
            if tenant
            else None
        ),
```
Replace with:
```python
        "tenant": (
            {
                "id": tenant["id"],
                "name": tenant["name"],
                "slug": tenant["slug"],
                "status": tenant["lifecycle_status"],
                "business_goal": tenant["business_goal"],
            }
            if tenant
            else None
        ),
```

- [ ] **Step 3: Mount the new router in `app.py`**

Find:
```python
from .routes import health, me, staff_accounts
```
Replace with:
```python
from .routes import health, me, staff_accounts, tenant_self_service
```

Find:
```python
simulator_app.include_router(staff_accounts.router)
```
Replace with:
```python
simulator_app.include_router(staff_accounts.router)
simulator_app.include_router(tenant_self_service.router)
```

- [ ] **Step 4: Verify**

```bash
.venv/bin/python -m compileall src -q && echo COMPILE_OK
.venv/bin/python -m ruff check src
```
Expected: `COMPILE_OK`, `All checks passed!`.

- [ ] **Step 5: Commit**

```bash
git add src/simulator/routes/tenant_self_service.py src/simulator/routes/me.py src/simulator/app.py
git commit -m "feat(simulator): PATCH /simulator/tenant, business_goal on GET /me"
```

---

## Task 6: Frontend — branch, `tenant.js` passes `business_goal` through

**Files:**
- Modify: `src/lib/tenant.js`

**Interfaces:**
- Produces: the object `loadTenantCatalog` returns for a real 'live' tenant now includes `business_goal: string | null`. Task 8 (boot.js) reads this field by name.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
git checkout -b feat/tenant-workspace-setup
```

- [ ] **Step 2: Update `fetchMe`'s return and `loadTenantCatalog`'s live-tenant object**

In `src/lib/tenant.js`, find:
```js
    const body = await r.json();
    return { role: body.role, tenant: body.tenant };
```
Replace with:
```js
    const body = await r.json();
    return { role: body.role, tenant: body.tenant };
    // Note: body.tenant.business_goal passes through unchanged — no field
    // list to update here, this function returns the whole tenant object.
```

(No functional change needed in `fetchMe` itself — it already returns the full `body.tenant` object, which now includes `business_goal` from the backend. This step's actual work is the comment documenting why, so a future reader doesn't wonder if a field was missed.)

Find:
```js
  return {
    name: me.tenant.name,
    status: 'live',
    slug: me.tenant.slug,
    products: ALL_PRODUCTS,
    credits: PLACEHOLDER_CREDITS,
  };
```
Replace with:
```js
  return {
    name: me.tenant.name,
    status: 'live',
    slug: me.tenant.slug,
    products: ALL_PRODUCTS,
    credits: PLACEHOLDER_CREDITS,
    businessGoal: me.tenant.business_goal,
  };
```

- [ ] **Step 3: Verify**

```bash
npm run test:unit
node test/design-check.mjs
node test/smoke.mjs
```
Expected: all pass (this change is additive — a new field on an object, no existing behavior touched).

- [ ] **Step 4: Commit**

```bash
git add src/lib/tenant.js
git commit -m "feat(onboarding): pass business_goal through loadTenantCatalog"
```

---

## Task 7: Frontend — workspace setup wizard UI

**Files:**
- Create: `src/features/onboarding/workspace-setup.js`
- Modify: `index.html`

**Interfaces:**
- Produces: `showWorkspaceSetup(tenant, onComplete: (updatedTenant) => void): void` — Task 8 (boot.js) calls this by name, passing a callback that receives the updated tenant object after a successful `PATCH /simulator/tenant`.
- Consumes: nothing from earlier frontend tasks directly (calls the backend endpoint itself via `fetch`).

- [ ] **Step 1: Add wizard markup + CSS to `index.html`**

Insert immediately before the closing `</style>` of the CSS block that contains the `#auth-gate` rules (the block added in the real-login feature, identifiable by the `#auth-gate{position:fixed;inset:0;z-index:800...` rule):

```css
  #workspace-setup{position:fixed;inset:0;z-index:800;display:none;place-items:center;background:rgb(var(--md-surface));}
  #workspace-setup .ws-card{max-width:440px;width:92vw;padding:6vh clamp(24px,5vw,48px);}
  #workspace-setup h3{font:800 24px/1.2 var(--font-sans);letter-spacing:-.02em;color:rgb(var(--md-on-surface));margin:0 0 8px;}
  #workspace-setup .ws-sub{font:400 14px var(--font-sans);color:rgb(var(--md-on-surface-variant));margin:0 0 24px;}
  #workspace-setup .ws-field label{display:block;font:600 11px var(--font-sans);color:rgb(var(--md-on-surface-variant));margin-bottom:6px;}
  #workspace-setup .ws-in{width:100%;border:1px solid rgb(var(--md-outline-variant));border-radius:10px;padding:12px 14px;font:500 14px var(--font-sans);color:rgb(var(--md-on-surface));background:rgb(var(--md-surface-container-lowest,255 255 255));margin-bottom:18px;}
  #workspace-setup .ws-goal{display:flex;flex-direction:column;gap:8px;margin-bottom:18px;}
  #workspace-setup .ws-goal label{display:flex;align-items:center;gap:9px;font:500 13.5px var(--font-sans);color:rgb(var(--md-on-surface));padding:10px 12px;border:1px solid rgb(var(--md-outline-variant));border-radius:10px;cursor:pointer;}
  #workspace-setup .ws-goal input[type=radio]{accent-color:rgb(var(--md-primary));}
  #workspace-setup .ws-err{display:none;font:600 12.5px var(--font-sans);color:#c0392b;background:rgba(210,40,20,.08);border:1px solid rgba(210,40,20,.25);border-radius:9px;padding:9px 12px;margin-bottom:14px;}
  #workspace-setup .ws-cta{width:100%;border:none;border-radius:10px;padding:13px;font:700 14px var(--font-sans);color:#fff;background:rgb(var(--md-primary));cursor:pointer;}
  #workspace-setup .ws-cta:disabled{opacity:.6;cursor:default;}
```

Insert immediately after the `#auth-gate` markup block's closing `</div>` (the outermost `<div id="auth-gate" ...>...</div>` added by the real-login feature):

```html
<div id="workspace-setup" role="dialog" aria-label="Set up your workspace">
  <div class="ws-card">
    <h3>Set up your workspace</h3>
    <p class="ws-sub">A couple of quick details before you start.</p>
    <form id="ws-form" novalidate>
      <div class="ws-err" id="ws-err" role="alert"></div>
      <div class="ws-field">
        <label for="ws-name">Workspace name</label>
        <input class="ws-in" id="ws-name" type="text" maxlength="80">
      </div>
      <div class="ws-field">
        <label>What's your main goal?</label>
        <div class="ws-goal">
          <label><input type="radio" name="ws-goal" value="Sell configured furniture online"> Sell configured furniture online</label>
          <label><input type="radio" name="ws-goal" value="In-store or live sales consultation tool"> In-store or live sales consultation tool</label>
          <label><input type="radio" name="ws-goal" value="Reduce returns from fabric/color mismatch"> Reduce returns from fabric/color mismatch</label>
          <label><input type="radio" name="ws-goal" value="Showcase catalog to trade/designers"> Showcase catalog to trade/designers</label>
          <label><input type="radio" name="ws-goal" value="__other__"> Other: <input class="ws-in" id="ws-goal-other" type="text" style="margin:0 0 0 8px;flex:1" placeholder="Tell us"></label>
        </div>
      </div>
      <button class="ws-cta" type="submit">Continue</button>
    </form>
  </div>
</div>
```

- [ ] **Step 2: Create `workspace-setup.js`**

```js
// One-time post-invite wizard: workspace name confirm + business-goal pick.
// Shown by boot.js's main() when a real 'live' tenant's business_goal is
// still null — see docs/superpowers/specs/2026-07-30-tenant-workspace-setup-design.md.
import { getCachedSession } from '../../lib/auth.js';

export function showWorkspaceSetup(tenant, onComplete) {
  const panel = document.getElementById('workspace-setup');
  const form = document.getElementById('ws-form');
  const err = document.getElementById('ws-err');
  const nameInput = document.getElementById('ws-name');
  if (!panel || !form) return;

  nameInput.value = tenant.name || '';
  panel.style.display = 'grid';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.style.display = 'none';

    const selected = form.querySelector('input[name="ws-goal"]:checked');
    if (!selected) {
      err.textContent = 'Please choose a goal.';
      err.style.display = 'block';
      return;
    }
    const businessGoal = selected.value === '__other__'
      ? document.getElementById('ws-goal-other').value.trim()
      : selected.value;
    if (!businessGoal) {
      err.textContent = 'Please tell us your goal.';
      err.style.display = 'block';
      return;
    }

    const submitBtn = form.querySelector('.ws-cta');
    submitBtn.disabled = true;
    try {
      const session = getCachedSession();
      const r = await fetch('https://api.livinit.ai/simulator/tenant', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ business_goal: businessGoal }),
      });
      if (!r.ok) throw new Error(`tenant update: ${r.status}`);
      const updated = await r.json();
      panel.style.display = 'none';
      onComplete({ ...tenant, businessGoal: updated.business_goal, name: updated.name });
    } catch (e2) {
      err.textContent = "Couldn't save — check your connection and try again.";
      err.style.display = 'block';
      console.error('workspace setup save failed', e2);
    } finally {
      submitBtn.disabled = false;
    }
  });
}
```

- [ ] **Step 3: Verify**

```bash
node test/smoke.mjs
```
Expected: 7/7 pass (new file/markup not yet wired into boot — Task 8 wires it — so this is inert but must not break existing boot).

- [ ] **Step 4: Commit**

```bash
git add index.html src/features/onboarding/workspace-setup.js
git commit -m "feat(onboarding): workspace setup wizard UI"
```

---

## Task 8: Frontend — wire the wizard into `boot.js`

**Files:**
- Modify: `src/app/boot.js`

**Interfaces:**
- Consumes: `showWorkspaceSetup` (Task 7), `getCachedSession` (from `../lib/auth.js` — already exists post-merge, added during the real-login final-review fix wave).

- [ ] **Step 1: Add the import**

Find:
```js
import { getSession, initAuthUI, showAuthGate, hideGate, showDraftGate, showAuthNetError, hideAuthNetError, signOut, watchForSignOut } from '../lib/auth.js';
```
Replace with:
```js
import { getSession, initAuthUI, showAuthGate, hideGate, showDraftGate, showAuthNetError, hideAuthNetError, signOut, watchForSignOut } from '../lib/auth.js';
import { showWorkspaceSetup } from '../features/onboarding/workspace-setup.js';
```

- [ ] **Step 2: Gate `main()` on `businessGoal`**

Find:
```js
  if (result.blocked) {
    showDraftGate(result.tenant);
    return;
  }

  hideGate();
  await bootWithSession(session, result);
}
```
Replace with:
```js
  if (result.blocked) {
    showDraftGate(result.tenant);
    return;
  }

  if (session.source === 'real' && !result.businessGoal) {
    showWorkspaceSetup(result, (updatedTenant) => bootWithSession(session, updatedTenant));
    return;
  }

  hideGate();
  await bootWithSession(session, result);
}
```

- [ ] **Step 3: Verify**

```bash
npm run test:unit
node test/design-check.mjs
node test/smoke.mjs
```
Expected: all pass. The `navigator.webdriver` demo session has `session.source === 'demo'`, so `session.source === 'real'` is always false for it — the wizard branch is unreachable in headless tests, exactly like the login gate before it.

- [ ] **Step 4: Commit**

```bash
git add src/app/boot.js
git commit -m "feat(onboarding): gate boot on workspace setup for new real tenants"
```

---

## Task 9: Manual verification pass

**Files:** none (verification only — same constraint as every other real-backend-dependent piece this session: no local Supabase credentials here).

- [ ] **Step 1: Run the full backend verification**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m compileall src -q && echo COMPILE_OK
.venv/bin/python -m ruff check src
bash scripts/simulator_db_test.sh
```
Expected: all green.

- [ ] **Step 2: Run the full frontend verification**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
npm run test:unit
node test/design-check.mjs
node test/smoke.mjs
```
Expected: all green.

- [ ] **Step 3: Document what's NOT verifiable here**

Write to a report (not committed to either repo, just reported back): confirm neither environment has real Supabase credentials, so the following are explicitly deferred to a human with dashboard/deployment access, not silently skipped:
- `POST /simulator/staff/tenants` actually creates a `'live'` tenant against the real database.
- `POST /simulator/staff/tenants/{id}/users` actually sends a working Supabase invite email (the one open risk flagged in the account-creation spec).
- The `tenants_client_admin_update` RLS policy actually rejects a plain `client` role in production, not just in the local shim.
- The wizard actually renders and saves against a real invited user's first login.
