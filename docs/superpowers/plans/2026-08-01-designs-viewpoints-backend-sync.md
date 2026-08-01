# Per-Account Saved Designs + Per-Tenant Viewpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved designs move from device-local localStorage to backend per-user storage, and camera viewpoint locks become per-tenant instead of one global S3 JSON.

**Architecture:** Extend the existing `/simulator/*` FastAPI sub-app in `backend-livinit` (new `simulator.designs` + `simulator.viewpoints` tables with RLS, CRUD routes). In the simulator frontend, an API-backed store with the same CRUD surface as the localStorage store replaces it for real sessions (demo/guest keep localStorage), with a one-time auto-migration of local designs and a tenant-first viewpoint resolution chain.

**Tech Stack:** FastAPI + supabase-py (RLS-scoped per-request client), Postgres RLS, vanilla-JS ES modules, `node:test` for frontend units, pytest for backend.

**Spec:** `docs/superpowers/specs/2026-08-01-designs-viewpoints-backend-sync-design.md` (in `livinit_fabric_simulator`).

## Global Constraints

- Two repos: Tasks 1–4 run in `/Users/bhartendukodes/Livi/backend-livinit`, Tasks 5–9 in `/Users/bhartendukodes/Livi/livinit_fabric_simulator`. Every Bash step below states its cwd.
- `product_key` is free text, 1–64 chars, NO allowlist (per-tenant catalogs come later; do not hardcode chair/accent_chair/sofa in DB or route validation).
- Server-side design limit is exactly 30 (`MAX_DESIGNS`); exceeding returns HTTP 409 with detail `"limit"`.
- All backend routes use `get_simulator_db` (RLS-scoped per-request client) — NEVER `get_simulator_supabase()` (cached anon) or the service client.
- Frontend: no optimistic writes — UI updates only after the server confirms.
- Demo/guest sessions (`session.source === 'demo'`) keep today's localStorage behavior exactly.
- Git commits: NO Co-Authored-By trailer (founder preference).
- Frontend exports from `src/features/*/index.js` barrels auto-attach to `window` via `Object.assign(window, ...)` in `src/app/boot.js:23` — new cross-feature/onclick functions just need to be exported from the feature barrel.
- Viewpoint bounds (same clamps in SQL-free Python and existing TS): theta ∈ [−4π, 4π], phi ∈ (0.05, π−0.05), r ∈ [0.3, 30], tgt components ∈ [−50, 50].

---

### Task 1: Backend migration `0011_designs_viewpoints.sql`

**Files:**
- Create: `src/simulator/sql/migrations/0011_designs_viewpoints.sql` (in backend-livinit)

**Interfaces:**
- Consumes: helpers from earlier migrations — `simulator.uid()`, `simulator.accessible_tenant_ids()`, `simulator.is_staff()`; tables `simulator.tenants`, `simulator.memberships`.
- Produces: tables `simulator.designs`, `simulator.viewpoints` that Tasks 2–3's routes query via PostgREST.

There is no local Postgres to run this against — the file is applied manually to Supabase at deploy time (same as 0001–0010). Verification here is review-only; the RLS behavior is additionally guarded by route tests (Tasks 2–3) and by the deploy checklist step.

- [ ] **Step 1: Write the migration**

```sql
-- 0011: per-user saved designs + per-tenant camera viewpoint locks.
-- Designs are personal (owner-only RLS); tenant_id is stored from day one so
-- tenant-level sharing can be added later without a data migration.
-- Viewpoints replace the single global S3 JSON: one row per (tenant, product),
-- readable by any member of the tenant, writable only by client_admin.

create table simulator.designs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references simulator.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  product_key text not null check (char_length(product_key) between 1 and 64),
  thumb text,              -- small JPEG data-URL from captureThumb(); move to S3 only if these grow
  state jsonb not null,    -- DesignState snapshot, same shape localStorage holds today
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index designs_user_updated_idx on simulator.designs (user_id, updated_at desc);

alter table simulator.designs enable row level security;

create policy designs_owner_all on simulator.designs
  for all to authenticated
  using (user_id = simulator.uid())
  with check (user_id = simulator.uid()
              and tenant_id = any (simulator.accessible_tenant_ids()));

create policy designs_staff_all on simulator.designs
  for all to authenticated
  using (simulator.is_staff())
  with check (simulator.is_staff());

grant select, insert, update, delete on simulator.designs to authenticated;

create table simulator.viewpoints (
  tenant_id uuid not null references simulator.tenants(id) on delete cascade,
  product_key text not null check (char_length(product_key) between 1 and 64),
  viewpoint jsonb not null,   -- {theta, phi, r, tgt:[x,y,z]} — same shape as the S3 JSON
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_key)
);

alter table simulator.viewpoints enable row level security;

create policy viewpoints_member_select on simulator.viewpoints
  for select to authenticated
  using (tenant_id = any (simulator.accessible_tenant_ids()));

create policy viewpoints_admin_write on simulator.viewpoints
  for all to authenticated
  using (exists (select 1 from simulator.memberships m
                 where m.tenant_id = viewpoints.tenant_id
                   and m.user_id = simulator.uid()
                   and m.role = 'client_admin'
                   and m.revoked_at is null))
  with check (exists (select 1 from simulator.memberships m
                      where m.tenant_id = viewpoints.tenant_id
                        and m.user_id = simulator.uid()
                        and m.role = 'client_admin'
                        and m.revoked_at is null));

create policy viewpoints_staff_all on simulator.viewpoints
  for all to authenticated
  using (simulator.is_staff())
  with check (simulator.is_staff());

grant select, insert, update, delete on simulator.viewpoints to authenticated;
```

- [ ] **Step 2: Review against neighboring migrations**

Read `src/simulator/sql/migrations/0002_tenancy.sql` and `0006_rls.sql` side-by-side with the new file. Confirm: schema-qualified names, `to authenticated` on every policy, grants present (0001 grants schema USAGE only — table grants are per-migration), helper functions spelled exactly `simulator.uid()` / `simulator.accessible_tenant_ids()` / `simulator.is_staff()`.

- [ ] **Step 3: Commit**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
git add src/simulator/sql/migrations/0011_designs_viewpoints.sql
git commit -m "feat(simulator): designs + viewpoints tables with RLS (0011)"
```

---

### Task 2: Backend designs routes

**Files:**
- Create: `src/simulator/routes/designs.py` (in backend-livinit)
- Create: `tests/simulator_fakes.py`
- Test: `tests/test_simulator_designs.py`

**Interfaces:**
- Consumes: `SimulatorPrincipal`, `get_current_principal`, `get_simulator_db` from `src/simulator/auth.py` (exact import: `from ..auth import SimulatorPrincipal, get_current_principal, get_simulator_db`).
- Produces: `router` (APIRouter) with `GET/POST /designs`, `PATCH/DELETE /designs/{design_id}`; `MAX_DESIGNS = 30`. Task 4 registers `designs.router`. Rows returned as PostgREST dicts: `{id, name, product_key, thumb, state, created_at, updated_at}` — Task 5's frontend mapper relies on these snake_case names.

- [ ] **Step 1: Write the shared fake Supabase client for tests**

`tests/simulator_fakes.py`:

```python
"""In-memory stand-in for the supabase-py client, shaped for the query
chains the simulator routes actually use. RLS is NOT simulated — route
tests assert the routes' own filters and status codes; RLS is enforced by
migration 0011 in the real database."""
from types import SimpleNamespace


class FakeQuery:
    def __init__(self, db, name):
        self._db, self._name = db, name
        self._filters, self._count = [], None
        self._insert = self._update = None
        self._delete = False

    # chain builders — all return self
    def select(self, *_cols, count=None):
        self._count = count
        return self

    def insert(self, row):
        self._insert = row
        return self

    def upsert(self, row, on_conflict=None):
        self._insert = row
        self._upsert_conflict = on_conflict
        return self

    def update(self, patch):
        self._update = patch
        return self

    def delete(self):
        self._delete = True
        return self

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def is_(self, col, val):   # only used as .is_("revoked_at", "null")
        self._filters.append((col, None))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, _n):
        return self

    def _matches(self, row):
        return all(row.get(c) == v for c, v in self._filters)

    def execute(self):
        rows = self._db.tables.setdefault(self._name, [])
        if self._insert is not None:
            row = dict(self._insert)
            row.setdefault("id", f"fake-{len(rows) + 1}")
            row.setdefault("created_at", "2026-08-01T00:00:00+00:00")
            row.setdefault("updated_at", "2026-08-01T00:00:00+00:00")
            rows.append(row)
            return SimpleNamespace(data=[row], count=None)
        if self._update is not None:
            hit = [r for r in rows if self._matches(r)]
            for r in hit:
                r.update(self._update)
            return SimpleNamespace(data=hit, count=None)
        if self._delete:
            hit = [r for r in rows if self._matches(r)]
            self._db.tables[self._name] = [r for r in rows if not self._matches(r)]
            return SimpleNamespace(data=hit, count=None)
        hit = [r for r in rows if self._matches(r)]
        count = len(hit) if self._count == "exact" else None
        return SimpleNamespace(data=hit, count=count)


class FakeDb:
    def __init__(self, tables=None):
        self.tables = tables or {}

    def table(self, name):
        return FakeQuery(self, name)
```

- [ ] **Step 2: Write the failing tests**

`tests/test_simulator_designs.py`:

```python
from fastapi.testclient import TestClient

from src.simulator.app import simulator_app
from src.simulator.auth import SimulatorPrincipal, get_current_principal, get_simulator_db
from src.simulator.routes.designs import MAX_DESIGNS
from tests.simulator_fakes import FakeDb

PRINCIPAL = SimulatorPrincipal(user_id="user-1", email="p@acme.com", access_token="tok")
STATE = {"v": 1, "productKey": "chair", "parts": {}}


def client_with(db):
    simulator_app.dependency_overrides[get_current_principal] = lambda: PRINCIPAL
    simulator_app.dependency_overrides[get_simulator_db] = lambda: db
    return TestClient(simulator_app)


def teardown_function():
    simulator_app.dependency_overrides.clear()


def test_create_then_list_roundtrip():
    db = FakeDb({"tenants": [{"id": "t-1"}]})
    c = client_with(db)
    r = c.post("/designs", json={"name": "A", "product_key": "chair", "thumb": None, "state": STATE})
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "A" and body["product_key"] == "chair"
    assert body["user_id"] == "user-1" and body["tenant_id"] == "t-1"
    listing = c.get("/designs")
    assert listing.status_code == 200
    assert [d["name"] for d in listing.json()] == ["A"]


def test_create_limit_409():
    rows = [{"id": f"d{i}", "user_id": "user-1"} for i in range(MAX_DESIGNS)]
    db = FakeDb({"tenants": [{"id": "t-1"}], "designs": rows})
    c = client_with(db)
    r = c.post("/designs", json={"name": "X", "product_key": "sofa", "thumb": None, "state": STATE})
    assert r.status_code == 409
    assert r.json()["detail"] == "limit"


def test_create_without_tenant_403():
    c = client_with(FakeDb({"tenants": []}))
    r = c.post("/designs", json={"name": "X", "product_key": "sofa", "thumb": None, "state": STATE})
    assert r.status_code == 403


def test_rename_own_design():
    db = FakeDb({"designs": [{"id": "d1", "user_id": "user-1", "name": "Old"}]})
    c = client_with(db)
    r = c.patch("/designs/d1", json={"name": "New"})
    assert r.status_code == 200
    assert r.json()["name"] == "New"


def test_rename_missing_404():
    c = client_with(FakeDb({"designs": []}))
    assert c.patch("/designs/nope", json={"name": "New"}).status_code == 404


def test_delete_scopes_to_owner():
    db = FakeDb({"designs": [
        {"id": "d1", "user_id": "user-1"},
        {"id": "d2", "user_id": "someone-else"},
    ]})
    c = client_with(db)
    assert c.delete("/designs/d1").status_code == 204
    assert c.delete("/designs/d2").status_code == 204  # no-op: owner filter excludes it
    remaining = {r["id"] for r in db.tables["designs"]}
    assert remaining == {"d2"}


def test_product_key_free_text_but_bounded():
    db = FakeDb({"tenants": [{"id": "t-1"}]})
    c = client_with(db)
    ok = c.post("/designs", json={"name": "N", "product_key": "tenant_custom_chaise", "thumb": None, "state": STATE})
    assert ok.status_code == 201
    too_long = c.post("/designs", json={"name": "N", "product_key": "x" * 65, "thumb": None, "state": STATE})
    assert too_long.status_code == 422
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m pytest tests/test_simulator_designs.py -v
```
Expected: FAIL — `ModuleNotFoundError: src.simulator.routes.designs` (route file doesn't exist yet). Note: routes are NOT registered on `simulator_app` until Task 4, so after Step 4 the requests would 404 — that is why Step 4 includes a temporary local registration, removed again in Task 4.

- [ ] **Step 4: Write the implementation**

`src/simulator/routes/designs.py`:

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from ..auth import SimulatorPrincipal, get_current_principal, get_simulator_db

router = APIRouter(tags=["simulator"])

MAX_DESIGNS = 30


class DesignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    product_key: str = Field(min_length=1, max_length=64)
    thumb: str | None = None
    state: dict


class DesignRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


def _own_tenant_id(db: Client) -> str:
    """The caller's tenant, through their own RLS-scoped client — same
    resolution me.py uses. A real client sees exactly one tenant row."""
    result = db.table("tenants").select("id").limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=403, detail="no tenant")
    return result.data[0]["id"]


@router.get("/designs")
async def list_designs(
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> list[dict]:
    result = (
        db.table("designs")
        .select("id, name, product_key, thumb, state, created_at, updated_at")
        .eq("user_id", principal.user_id)  # defense in depth; RLS is the authority
        .order("updated_at", desc=True)
        .execute()
    )
    return result.data or []


@router.post("/designs", status_code=201)
async def create_design(
    body: DesignCreate,
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> dict:
    count_result = (
        db.table("designs").select("id", count="exact").eq("user_id", principal.user_id).execute()
    )
    existing = count_result.count if count_result.count is not None else len(count_result.data or [])
    if existing >= MAX_DESIGNS:
        raise HTTPException(status_code=409, detail="limit")

    row = {
        "tenant_id": _own_tenant_id(db),
        "user_id": principal.user_id,
        "name": body.name,
        "product_key": body.product_key,
        "thumb": body.thumb,
        "state": body.state,
    }
    result = db.table("designs").insert(row).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="insert failed")
    return result.data[0]


@router.patch("/designs/{design_id}")
async def rename_design(
    design_id: str,
    body: DesignRename,
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> dict:
    result = (
        db.table("designs")
        .update({"name": body.name, "updated_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", design_id)
        .eq("user_id", principal.user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="not found")
    return result.data[0]


@router.delete("/designs/{design_id}", status_code=204)
async def delete_design(
    design_id: str,
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> None:
    db.table("designs").delete().eq("id", design_id).eq("user_id", principal.user_id).execute()
```

Then add the TEMPORARY registration at the bottom of `src/simulator/app.py` so the tests can reach the routes (Task 4 replaces this with the real registration):

```python
from .routes import designs  # TEMP (Task 2) — made permanent in Task 4
simulator_app.include_router(designs.router)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m pytest tests/test_simulator_designs.py -v
```
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
git add src/simulator/routes/designs.py tests/simulator_fakes.py tests/test_simulator_designs.py src/simulator/app.py
git commit -m "feat(simulator): per-user designs CRUD with server-side 30-limit"
```

---

### Task 3: Backend viewpoints routes

**Files:**
- Create: `src/simulator/routes/viewpoints.py` (in backend-livinit)
- Test: `tests/test_simulator_viewpoints.py`

**Interfaces:**
- Consumes: `SimulatorPrincipal`, `get_current_principal`, `get_simulator_db` from `..auth`; `FakeDb` from `tests/simulator_fakes.py` (Task 2).
- Produces: `router` with `GET /viewpoints`, `PUT/DELETE /viewpoints/{product_key}`; pure function `sanitize_viewpoint(v: dict) -> dict | None`. `GET` returns `{product_key: viewpoint}` map — Task 8's frontend loader relies on exactly that shape. `PUT` returns `{"ok": True, "product_key": ..., "viewpoint": <clamped dict>}`.

- [ ] **Step 1: Write the failing tests**

`tests/test_simulator_viewpoints.py`:

```python
import math

from fastapi.testclient import TestClient

from src.simulator.app import simulator_app
from src.simulator.auth import SimulatorPrincipal, get_current_principal, get_simulator_db
from src.simulator.routes.viewpoints import sanitize_viewpoint
from tests.simulator_fakes import FakeDb

ADMIN = SimulatorPrincipal(user_id="admin-1", email="a@acme.com", access_token="tok")
MEMBER = SimulatorPrincipal(user_id="member-1", email="m@acme.com", access_token="tok")
VP = {"theta": 0.4, "phi": 1.1, "r": 1.9, "tgt": [0, 0.1, 0]}


def client_with(db, principal):
    simulator_app.dependency_overrides[get_current_principal] = lambda: principal
    simulator_app.dependency_overrides[get_simulator_db] = lambda: db
    return TestClient(simulator_app)


def teardown_function():
    simulator_app.dependency_overrides.clear()


def admin_db(extra=None):
    tables = {
        "memberships": [
            {"tenant_id": "t-1", "user_id": "admin-1", "role": "client_admin", "revoked_at": None},
            {"tenant_id": "t-1", "user_id": "member-1", "role": "client", "revoked_at": None},
        ],
    }
    tables.update(extra or {})
    return FakeDb(tables)


def test_get_returns_product_map():
    db = admin_db({"viewpoints": [
        {"tenant_id": "t-1", "product_key": "chair", "viewpoint": VP},
    ]})
    r = client_with(db, MEMBER).get("/viewpoints")
    assert r.status_code == 200
    assert r.json() == {"chair": VP}


def test_put_requires_client_admin():
    r = client_with(admin_db(), MEMBER).put("/viewpoints/chair", json=VP)
    assert r.status_code == 403


def test_put_upserts_and_returns_clamped():
    db = admin_db()
    wild = {"theta": 0.4, "phi": 9.9, "r": 999, "tgt": [0, 0.1, 0]}
    r = client_with(db, ADMIN).put("/viewpoints/chair", json=wild)
    assert r.status_code == 200
    vp = r.json()["viewpoint"]
    assert vp["r"] == 30 and vp["phi"] == math.pi - 0.05
    assert db.tables["viewpoints"][0]["product_key"] == "chair"


def test_put_rejects_garbage_400():
    r = client_with(admin_db(), ADMIN).put("/viewpoints/chair", json={"theta": "nope"})
    assert r.status_code == 400


def test_delete_requires_admin_and_removes():
    db = admin_db({"viewpoints": [
        {"tenant_id": "t-1", "product_key": "chair", "viewpoint": VP},
    ]})
    assert client_with(db, MEMBER).delete("/viewpoints/chair").status_code == 403
    teardown_function()
    assert client_with(db, ADMIN).delete("/viewpoints/chair").status_code == 204
    assert db.tables["viewpoints"] == []


def test_sanitize_viewpoint_pure():
    assert sanitize_viewpoint({"theta": 0, "phi": 1, "r": 2, "tgt": [1, 2, 3]}) == {
        "theta": 0.0, "phi": 1.0, "r": 2.0, "tgt": [1.0, 2.0, 3.0]
    }
    assert sanitize_viewpoint({"theta": float("nan"), "phi": 1, "r": 2, "tgt": [0, 0, 0]}) is None
    assert sanitize_viewpoint({}) is None
    clamped = sanitize_viewpoint({"theta": 99, "phi": 0, "r": 0, "tgt": [99, -99, 0]})
    assert clamped["theta"] == 4 * math.pi and clamped["phi"] == 0.05
    assert clamped["r"] == 0.3 and clamped["tgt"][:2] == [50.0, -50.0]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m pytest tests/test_simulator_viewpoints.py -v
```
Expected: FAIL — `ModuleNotFoundError: src.simulator.routes.viewpoints`.

- [ ] **Step 3: Write the implementation**

`src/simulator/routes/viewpoints.py`:

```python
import math
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from supabase import Client

from ..auth import SimulatorPrincipal, get_current_principal, get_simulator_db

router = APIRouter(tags=["simulator"])


def sanitize_viewpoint(v: dict) -> dict | None:
    """Bounds-clamp a client-supplied viewpoint; None if unusable. Same
    clamps as the legacy global endpoint (api/viewpoints.ts in the
    simulator repo): theta ±4π, phi (0.05, π−0.05), r [0.3, 30], tgt ±50."""
    def num(x, lo, hi):
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
            return None
        return min(hi, max(lo, float(x)))

    theta = num(v.get("theta"), -4 * math.pi, 4 * math.pi)
    phi = num(v.get("phi"), 0.05, math.pi - 0.05)
    r = num(v.get("r"), 0.3, 30)
    raw_tgt = v.get("tgt") if isinstance(v.get("tgt"), list) else [0, 0, 0]
    raw_tgt = (raw_tgt + [0, 0, 0])[:3]
    tgt = [num(c, -50, 50) for c in raw_tgt]
    if theta is None or phi is None or r is None or any(c is None for c in tgt):
        return None
    return {"theta": theta, "phi": phi, "r": r, "tgt": tgt}


def _require_client_admin(principal: SimulatorPrincipal, db: Client) -> str:
    """Returns the caller's tenant_id iff their live membership role is
    client_admin. Live-table check via the caller's own RLS-scoped client —
    never the JWT claim (same rationale as require_staff in auth.py)."""
    result = (
        db.table("memberships")
        .select("tenant_id, role")
        .eq("user_id", principal.user_id)
        .is_("revoked_at", "null")
        .limit(1)
        .execute()
    )
    if not result.data or result.data[0]["role"] != "client_admin":
        raise HTTPException(status_code=403, detail="client_admin required")
    return result.data[0]["tenant_id"]


@router.get("/viewpoints")
async def get_viewpoints(
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> dict:
    result = db.table("viewpoints").select("product_key, viewpoint").execute()
    return {row["product_key"]: row["viewpoint"] for row in (result.data or [])}


@router.put("/viewpoints/{product_key}")
async def put_viewpoint(
    product_key: str,
    viewpoint: dict = Body(...),
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> dict:
    if not 1 <= len(product_key) <= 64:
        raise HTTPException(status_code=400, detail="invalid product_key")
    clean = sanitize_viewpoint(viewpoint)
    if clean is None:
        raise HTTPException(status_code=400, detail="invalid viewpoint")
    tenant_id = _require_client_admin(principal, db)
    db.table("viewpoints").upsert(
        {
            "tenant_id": tenant_id,
            "product_key": product_key,
            "viewpoint": clean,
            "updated_by": principal.user_id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="tenant_id,product_key",
    ).execute()
    return {"ok": True, "product_key": product_key, "viewpoint": clean}


@router.delete("/viewpoints/{product_key}", status_code=204)
async def delete_viewpoint(
    product_key: str,
    principal: SimulatorPrincipal = Depends(get_current_principal),
    db: Client = Depends(get_simulator_db),
) -> None:
    tenant_id = _require_client_admin(principal, db)
    (
        db.table("viewpoints")
        .delete()
        .eq("tenant_id", tenant_id)
        .eq("product_key", product_key)
        .execute()
    )
```

Add the TEMPORARY registration in `src/simulator/app.py` next to Task 2's (both replaced in Task 4):

```python
from .routes import viewpoints  # TEMP (Task 3) — made permanent in Task 4
simulator_app.include_router(viewpoints.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m pytest tests/test_simulator_viewpoints.py -v
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
git add src/simulator/routes/viewpoints.py tests/test_simulator_viewpoints.py src/simulator/app.py
git commit -m "feat(simulator): per-tenant viewpoint locks, client_admin-gated"
```

---

### Task 4: Register routers properly + OpenAPI check

**Files:**
- Modify: `src/simulator/app.py` (in backend-livinit)
- Test: `tests/test_simulator_openapi.py`

**Interfaces:**
- Consumes: `designs.router`, `viewpoints.router` (Tasks 2–3).
- Produces: routes reachable at `/simulator/designs` and `/simulator/viewpoints` in production; visible at `api.livinit.ai/simulator/docs` (the simulator sub-app's own swagger).

- [ ] **Step 1: Write the failing test**

`tests/test_simulator_openapi.py`:

```python
from src.simulator.app import simulator_app


def test_new_routes_in_openapi():
    paths = simulator_app.openapi()["paths"]
    assert "/designs" in paths
    assert "/designs/{design_id}" in paths
    assert "/viewpoints" in paths
    assert "/viewpoints/{product_key}" in paths
```

- [ ] **Step 2: Clean up app.py registration**

Replace the two TEMP blocks in `src/simulator/app.py` by extending the existing import and registration lines to their final form:

```python
from .routes import designs, health, me, staff_accounts, tenant_self_service, viewpoints
```

```python
simulator_app.include_router(health.router)
simulator_app.include_router(me.router)
simulator_app.include_router(staff_accounts.router)
simulator_app.include_router(tenant_self_service.router)
simulator_app.include_router(designs.router)
simulator_app.include_router(viewpoints.router)
```

- [ ] **Step 3: Run the full backend suite**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m pytest tests/ -v
```
Expected: all pass (new openapi test + Tasks 2–3 tests + pre-existing `test_products_query_placement.py`).

- [ ] **Step 4: Commit**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
git add src/simulator/app.py tests/test_simulator_openapi.py
git commit -m "feat(simulator): register designs + viewpoints routers"
```

---

### Task 5: Frontend API-backed saved store

**Files:**
- Modify: `src/lib/tenant.js:7` (export the existing const: `export const SIMULATOR_API = 'https://api.livinit.ai/simulator';`)
- Create: `src/features/saved/saved-store-api.js` (in livinit_fabric_simulator)
- Test: `test/saved-store-api.test.mjs`

**Interfaces:**
- Consumes: `SIMULATOR_API` from `../../lib/tenant.js`; backend rows `{id, name, product_key, thumb, state, created_at, updated_at}` (Task 2).
- Produces: `createApiSavedStore(accessToken, fetchFn?)` returning `{list, get, save, rename, remove}` — all async. Records are camelCase: `{id, name, productKey, thumb, state, createdAt, updatedAt}` (numbers for the dates, matching what `renderSavedPanel` already formats). Errors carry `e.code`: `'full'` (409), `'network'` (fetch threw), `'api'` (other non-OK). Task 6 consumes this surface; Task 7's migration calls `list` + `save`.

- [ ] **Step 1: Write the failing tests**

`test/saved-store-api.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiSavedStore } from '../src/features/saved/saved-store-api.js';

const ROW = {
  id: 'd1', name: 'A', product_key: 'chair', thumb: null,
  state: { v: 1 }, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

function fetchStub(plan) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = plan.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status < 400, status: next.status,
      json: async () => next.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('list maps snake_case rows to camelCase records', async () => {
  const f = fetchStub([{ status: 200, body: [ROW] }]);
  const s = createApiSavedStore('tok', f);
  const list = await s.list();
  assert.equal(list[0].productKey, 'chair');
  assert.equal(typeof list[0].updatedAt, 'number');
  assert.match(f.calls[0].url, /\/simulator\/designs$/);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('save posts snake_case body and returns mapped record', async () => {
  const f = fetchStub([{ status: 201, body: ROW }]);
  const s = createApiSavedStore('tok', f);
  const rec = await s.save({ name: 'A', productKey: 'chair', thumb: null, state: { v: 1 } });
  assert.equal(rec.id, 'd1');
  assert.equal(JSON.parse(f.calls[0].init.body).product_key, 'chair');
});

test('409 becomes code full', async () => {
  const f = fetchStub([{ status: 409, body: { detail: 'limit' } }]);
  const s = createApiSavedStore('tok', f);
  await assert.rejects(() => s.save({ name: 'A', productKey: 'chair', thumb: null, state: {} }),
    (e) => e.code === 'full');
});

test('fetch throw becomes code network', async () => {
  const f = fetchStub([new Error('offline')]);
  const s = createApiSavedStore('tok', f);
  await assert.rejects(() => s.list(), (e) => e.code === 'network');
});

test('get serves from last list, refetching once on miss', async () => {
  const f = fetchStub([{ status: 200, body: [ROW] }, { status: 200, body: [ROW] }]);
  const s = createApiSavedStore('tok', f);
  await s.list();
  assert.equal((await s.get('d1')).name, 'A');
  assert.equal(f.calls.length, 1);           // cache hit, no refetch
  assert.equal(await s.get('nope'), null);   // miss → one refetch
  assert.equal(f.calls.length, 2);
});

test('remove issues DELETE and drops from cache', async () => {
  const f = fetchStub([
    { status: 200, body: [ROW] },   // list
    { status: 204, body: null },    // delete
    { status: 200, body: [] },      // get('d1') cache-misses → one refetch
  ]);
  const s = createApiSavedStore('tok', f);
  await s.list();
  await s.remove('d1');
  assert.equal(f.calls[1].init.method, 'DELETE');
  assert.equal(await s.get('d1'), null);
  assert.equal(f.calls.length, 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/saved-store-api.test.mjs
```
Expected: FAIL — cannot find module `saved-store-api.js`.

- [ ] **Step 3: Write the implementation**

`src/features/saved/saved-store-api.js`:

```js
// Backend-backed twin of saved-store.js (same CRUD surface, async) for real
// logged-in sessions. Demo/guest sessions never touch this — they stay on the
// localStorage store. Field mapping: the API speaks snake_case rows, the app
// speaks the camelCase records the localStorage store always produced.
import { SIMULATOR_API } from '../../lib/tenant.js';

const toRec = (row) => ({
  id: row.id,
  name: row.name,
  productKey: row.product_key,
  thumb: row.thumb,
  state: row.state,
  createdAt: Date.parse(row.created_at),
  updatedAt: Date.parse(row.updated_at),
});

export function createApiSavedStore(accessToken, fetchFn = (...a) => globalThis.fetch(...a)) {
  const HEADERS = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken };
  let _cache = [];

  async function call(path, init) {
    let res;
    try {
      res = await fetchFn(SIMULATOR_API + path, init);
    } catch {
      const e = new Error('Network error'); e.code = 'network'; throw e;
    }
    if (res.status === 409) {
      const e = new Error('Design limit reached'); e.code = 'full'; throw e;
    }
    if (!res.ok) {
      const e = new Error('Request failed: ' + res.status); e.code = 'api'; throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    async list() {
      const rows = await call('/designs', { headers: HEADERS });
      _cache = (rows || []).map(toRec);
      return _cache;
    },
    async get(id) {
      const hit = _cache.find((d) => d.id === id);
      if (hit) return hit;
      await this.list();
      return _cache.find((d) => d.id === id) || null;
    },
    async save({ name, productKey, thumb, state }) {
      const row = await call('/designs', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ name, product_key: productKey, thumb, state }),
      });
      const rec = toRec(row);
      _cache = [rec, ..._cache];
      return rec;
    },
    async rename(id, name) {
      const row = await call('/designs/' + id, {
        method: 'PATCH', headers: HEADERS, body: JSON.stringify({ name }),
      });
      const rec = toRec(row);
      _cache = _cache.map((d) => (d.id === id ? { ...d, ...rec } : d));
      return rec;
    },
    async remove(id) {
      await call('/designs/' + id, { method: 'DELETE', headers: HEADERS });
      _cache = _cache.filter((d) => d.id !== id);
    },
  };
}
```

And in `src/lib/tenant.js` change line 7 from `const SIMULATOR_API = ...` to `export const SIMULATOR_API = ...` (call sites inside tenant.js are unaffected).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/saved-store-api.test.mjs
```
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
git add src/features/saved/saved-store-api.js test/saved-store-api.test.mjs src/lib/tenant.js
git commit -m "feat(saved): API-backed saved store for real sessions"
```

---

### Task 6: Saved panel goes async + store selection

**Files:**
- Modify: `src/features/saved/saved-store.js` (add `asAsyncStore`)
- Modify: `src/features/saved/saved-panel.js` (store init + 7 async call sites)
- Test: `test/saved-store.test.mjs` (extend), then full existing suite

**Interfaces:**
- Consumes: `createApiSavedStore` (Task 5), `createSavedStore` (existing), `getCachedSession` from `../../lib/auth.js` (session shape: `{source: 'demo'|'real', user: {email}, accessToken?}`).
- Produces: `initSavedStore(session)` exported from `saved-panel.js` (auto-lands on `window` via the barrel) — Task 7's boot wiring calls it. All panel functions keep their existing names (inline `onclick=` handlers in index.html depend on them).

- [ ] **Step 1: Write the failing test for the async wrapper**

Append to `test/saved-store.test.mjs`:

```js
test('asAsyncStore preserves behavior behind an async surface', async () => {
  const { asAsyncStore } = await import('../src/features/saved/saved-store.js');
  const s = asAsyncStore(createSavedStore('priya@acme.com', storage));
  const d = await s.save({ name: 'A', productKey: 'chair', thumb: null, state: STATE });
  assert.equal((await s.list()).length, 1);
  assert.equal((await s.get(d.id)).name, 'A');
  await s.rename(d.id, 'B');
  assert.equal((await s.get(d.id)).name, 'B');
  await s.remove(d.id);
  assert.equal((await s.list()).length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/saved-store.test.mjs
```
Expected: the new test FAILS (`asAsyncStore` not exported); existing tests pass.

- [ ] **Step 3: Implement `asAsyncStore`**

Append to `src/features/saved/saved-store.js`:

```js
// Async-shaped wrapper so saved-panel.js has ONE call convention whether the
// store is this localStorage one (demo/guest) or the API one (real sessions).
export function asAsyncStore(store) {
  return {
    list: async () => store.list(),
    get: async (id) => store.get(id),
    save: async (rec) => store.save(rec),
    rename: async (id, name) => store.rename(id, name),
    remove: async (id) => store.remove(id),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Same command as Step 2. Expected: all pass.

- [ ] **Step 5: Convert saved-panel.js**

In `src/features/saved/saved-panel.js`:

(a) Replace the store head (imports + `savedStore`):

```js
import { createSavedStore, asAsyncStore } from './saved-store.js';
import { createApiSavedStore } from './saved-store-api.js';

let _store = null;
// Boot calls this once the session is known; anything earlier (or demo/guest)
// falls back to the localStorage store via savedStore()'s lazy init.
export function initSavedStore(session) {
  _store = session?.source === 'real' && session.accessToken
    ? createApiSavedStore(session.accessToken)
    : asAsyncStore(createSavedStore(session?.user?.email || 'anon'));
  return _store;
}
export function savedStore() {
  if (!_store) initSavedStore(getCachedSession());
  return _store;
}
```

(b) `confirmSaveDesign` becomes async; the `try` block awaits and the error map gains `'network'`:

```js
export async function confirmSaveDesign() {
  const name = document.getElementById('save-name-input').value.trim();
  if (!name) { document.getElementById('save-name-input').focus(); return; }
  const btn = document.querySelector('#save-dialog .btn-primary');
  if (btn) btn.disabled = true;
  try {
    const state = captureDesignState();
    await savedStore().save({ name, productKey: state.productKey, thumb: captureThumb(), state });
    closeSaveDesignDialog();
    showToast('“' + name + '” saved');
    window.renderSavedPanel?.();
  } catch (e) {
    showToast(e.code === 'full' ? 'Design limit reached — delete old designs first'
      : e.code === 'quota' ? 'Storage full — delete old designs first'
      : e.code === 'network' ? 'No connection — design not saved'
      : 'Could not save design');
  } finally { if (btn) btn.disabled = false; }
}
```

(Check index.html for the save dialog's confirm button selector; if it has an id, prefer the id over `.btn-primary`.)

(c) `renderSavedPanel` becomes async with loading + retry states:

```js
export async function renderSavedPanel() {
  const body = document.getElementById('saved-panel-body');
  body.innerHTML = '<div class="saved-empty">Loading…</div>';
  let list;
  try { list = await savedStore().list(); }
  catch {
    body.innerHTML = '<div class="saved-empty">Couldn’t load designs.<br>'
      + '<button class="saved-act" onclick="renderSavedPanel()">Retry</button></div>';
    return;
  }
  if (!list.length) { /* existing empty-state markup, unchanged */ }
  /* existing list-rendering markup, unchanged */
}
```

(d) `loadSavedDesign`: change `const rec = savedStore().get(id);` to `const rec = await savedStore().get(id);` (function is already async).

(e) `deleteSavedDesign` becomes async; the confirmed branch:

```js
try { await savedStore().remove(id); }
catch { showToast('Could not delete design'); return; }
renderSavedPanel();
showToast('Design deleted');
```

(f) `renameSavedDesign` becomes async (`const rec = await savedStore().get(id);`) and its `commit` closure:

```js
const commit = async () => {
  const v = input.value.trim();
  if (v) {
    try { await savedStore().rename(id, v); }
    catch (e) { showToast(e.code === 'network' ? 'No connection — not renamed' : 'Could not rename'); }
  }
  renderSavedPanel();
};
```

- [ ] **Step 6: Run the full frontend suite**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/
```
Expected: all pass (`design-state`, `history`, `saved-store`, `saved-store-api` and any other suites). If `test/design-check.mjs` or `test/smoke.mjs` are not `node --test` files, run whichever of them `package.json` scripts name, the same way the repo already runs them.

- [ ] **Step 7: Manual smoke via local server**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node test/serve.mjs
```
Open `http://localhost:8123` (server always binds 8123 — it ignores `PORT`). Headless runs identify as `navigator.webdriver` → demo session → localStorage store, so: save a design, reload, confirm it lists/loads/renames/deletes. This proves the async conversion didn't regress the demo path. Stop the server after.

- [ ] **Step 8: Commit**

```bash
git add src/features/saved/saved-store.js src/features/saved/saved-panel.js test/saved-store.test.mjs
git commit -m "feat(saved): async store surface, API store for real sessions"
```

---

### Task 7: One-time localStorage migration + boot wiring

**Files:**
- Create: `src/features/saved/migrate-local-designs.js` (in livinit_fabric_simulator)
- Modify: `src/app/boot.js` (`main()`, after the blocked/workspace checks, before `bootWithSession`)
- Test: `test/migrate-local-designs.test.mjs`

**Interfaces:**
- Consumes: an apiStore with `list()` / `save()` (Task 5's surface); localStorage keys `livinit_sim_designs_v1:<email>` (existing) and `livinit_sim_migrated_v1:<email>` (new marker).
- Produces: `migrateLocalDesigns(email, apiStore, storage?) -> Promise<{migrated: number, limitHit: boolean}>`. Boot calls it fire-and-forget for real sessions.

- [ ] **Step 1: Write the failing tests**

`test/migrate-local-designs.test.mjs`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLocalDesigns } from '../src/features/saved/migrate-local-designs.js';

const mem = new Map();
const storage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
beforeEach(() => mem.clear());

const KEY = 'livinit_sim_designs_v1:p@acme.com';
const MARK = 'livinit_sim_migrated_v1:p@acme.com';
const local = (names) => JSON.stringify(names.map((n, i) => (
  { id: 'l' + i, name: n, productKey: 'chair', thumb: null, state: { v: 1 }, createdAt: i, updatedAt: i }
)));

function apiStub({ existing = [], failOn = null, limitOn = null } = {}) {
  const saved = [];
  return {
    saved,
    list: async () => existing,
    save: async (rec) => {
      if (rec.name === failOn) { const e = new Error('net'); e.code = 'network'; throw e; }
      if (rec.name === limitOn) { const e = new Error('limit'); e.code = 'full'; throw e; }
      saved.push(rec);
      return { id: 's' + saved.length, ...rec };
    },
  };
}

test('uploads all local designs, clears key, sets marker', async () => {
  mem.set(KEY, local(['A', 'B']));
  const api = apiStub();
  const res = await migrateLocalDesigns('P@acme.com', api, storage);   // case-insensitive email
  assert.deepEqual(res, { migrated: 2, limitHit: false });
  assert.deepEqual(api.saved.map((d) => d.name), ['A', 'B']);
  assert.equal(mem.has(KEY), false);
  assert.equal(mem.get(MARK), '1');
});

test('marker short-circuits a second run', async () => {
  mem.set(MARK, '1');
  mem.set(KEY, local(['A']));
  const api = apiStub();
  const res = await migrateLocalDesigns('p@acme.com', api, storage);
  assert.equal(res.migrated, 0);
  assert.equal(api.saved.length, 0);
  assert.equal(mem.has(KEY), true);   // untouched — marker wins
});

test('network failure mid-run keeps key and no marker (retry next login)', async () => {
  mem.set(KEY, local(['A', 'B', 'C']));
  const api = apiStub({ failOn: 'B' });
  await assert.rejects(() => migrateLocalDesigns('p@acme.com', api, storage));
  assert.equal(mem.has(KEY), true);
  assert.equal(mem.has(MARK), false);
});

test('retry skips designs already on the server (name+productKey dedupe)', async () => {
  mem.set(KEY, local(['A', 'B']));
  const api = apiStub({ existing: [{ id: 's1', name: 'A', productKey: 'chair' }] });
  const res = await migrateLocalDesigns('p@acme.com', api, storage);
  assert.equal(res.migrated, 1);
  assert.deepEqual(api.saved.map((d) => d.name), ['B']);
});

test('limit stops the run but still clears and marks (leftovers can never fit)', async () => {
  mem.set(KEY, local(['A', 'B', 'C']));
  const api = apiStub({ limitOn: 'B' });
  const res = await migrateLocalDesigns('p@acme.com', api, storage);
  assert.deepEqual(res, { migrated: 1, limitHit: true });
  assert.equal(mem.has(KEY), false);
  assert.equal(mem.get(MARK), '1');
});

test('empty local list just sets the marker', async () => {
  const res = await migrateLocalDesigns('p@acme.com', apiStub(), storage);
  assert.deepEqual(res, { migrated: 0, limitHit: false });
  assert.equal(mem.get(MARK), '1');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/migrate-local-designs.test.mjs
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/features/saved/migrate-local-designs.js`:

```js
// One-time move of a user's localStorage designs to their account (spec:
// migration section). Ordering that makes it safe to retry:
//   - the local KEY is removed only after the loop finishes without a
//     network/api error — a mid-run failure keeps it, so next login retries;
//   - retries dedupe against the server by (name, productKey), so designs
//     uploaded in an earlier partial run are never duplicated;
//   - hitting the 30-limit still clears+marks: the leftovers could never
//     upload anyway, and the caller shows a toast for them.
export async function migrateLocalDesigns(email, apiStore, storage = globalThis.localStorage) {
  const norm = String(email || '').toLowerCase();
  const KEY = 'livinit_sim_designs_v1:' + norm;
  const MARK = 'livinit_sim_migrated_v1:' + norm;
  if (storage.getItem(MARK)) return { migrated: 0, limitHit: false };

  let local = [];
  try { local = JSON.parse(storage.getItem(KEY)) || []; } catch { local = []; }
  if (!local.length) {
    storage.setItem(MARK, '1');
    return { migrated: 0, limitHit: false };
  }

  const remote = await apiStore.list();   // throws on network error → nothing changed
  const seen = new Set(remote.map((d) => d.name + ' ' + d.productKey));

  let migrated = 0;
  let limitHit = false;
  for (const d of local) {
    if (seen.has(d.name + ' ' + d.productKey)) continue;
    try {
      await apiStore.save({ name: d.name, productKey: d.productKey, thumb: d.thumb, state: d.state });
      migrated++;
    } catch (e) {
      if (e.code === 'full') { limitHit = true; break; }
      throw e;   // network/api → keep KEY, no MARK; retried next login
    }
  }

  storage.removeItem(KEY);
  storage.setItem(MARK, '1');
  return { migrated, limitHit };
}
```

- [ ] **Step 4: Run to verify they pass**

Same command as Step 2. Expected: 6 pass.

- [ ] **Step 5: Wire into boot**

In `src/app/boot.js` `main()`, immediately before the final `hideGate(); await bootWithSession(session, result);` lines, add (imports at top: `import { initSavedStore } from '../features/saved/saved-panel.js';` and `import { migrateLocalDesigns } from '../features/saved/migrate-local-designs.js';` — note boot.js already imports `showToast` from `../lib/engine.js`):

```js
  const store = initSavedStore(session);
  if (session.source === 'real') {
    // Fire-and-forget: a failed migration retries next login; never blocks boot.
    migrateLocalDesigns(session.user.email, store).then(({ migrated, limitHit }) => {
      if (migrated) showToast(migrated + ' design' + (migrated > 1 ? 's' : '') + ' synced to your account');
      if (limitHit) showToast('Design limit reached — some local designs were not synced');
    }).catch(() => {});
  }
```

- [ ] **Step 6: Full suite + demo-path smoke**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/
```
Expected: all pass. Then repeat Task 6 Step 7's manual smoke (demo path must be unchanged — demo sessions never migrate because `initSavedStore` keeps them on localStorage and the migration only runs for `source === 'real'`).

- [ ] **Step 7: Commit**

```bash
git add src/features/saved/migrate-local-designs.js test/migrate-local-designs.test.mjs src/app/boot.js
git commit -m "feat(saved): one-time localStorage→account migration at boot"
```

---

### Task 8: Per-tenant viewpoints on the frontend

**Files:**
- Create: `src/features/configurator/viewpoint-resolve.js` (pure, node-testable)
- Modify: `src/features/configurator/viewport.js` (tenant layer + role-gated UI)
- Modify: `src/app/boot.js` (context + load call)
- Test: `test/viewpoint-resolve.test.mjs`

**Interfaces:**
- Consumes: `GET/PUT/DELETE /simulator/viewpoints` (Task 3; GET returns `{product_key: viewpoint}`), `SIMULATOR_API` from `../../lib/tenant.js`, session/tenant from boot (`session.accessToken`, `tenant.role`).
- Produces: pure `resolveViewpoint(key, tenantLocks, s3Locks, defaults)` and `lockSource(key, tenantLocks, s3Locks, defaults)`; stateful exports from viewport.js: `setViewpointContext({accessToken, role})`, `loadTenantViewpoints()` (both auto-land on `window` via the barrel `export * from './viewport.js'`).

- [ ] **Step 1: Write the failing test for the pure resolver**

`test/viewpoint-resolve.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewpoint, lockSource } from '../src/features/configurator/viewpoint-resolve.js';

const T = { theta: 1, phi: 1, r: 1, tgt: [0, 0, 0] };
const S = { theta: 2, phi: 1, r: 2, tgt: [0, 0, 0] };
const D = { theta: 3, phi: 1, r: 3, tgt: [0, 0, 0] };

test('tenant lock wins over global and default', () => {
  assert.equal(resolveViewpoint('chair', { chair: T }, { chair: S }, { chair: D }), T);
  assert.equal(lockSource('chair', { chair: T }, { chair: S }, { chair: D }), 'tenant');
});

test('global S3 lock wins over shipped default', () => {
  assert.equal(resolveViewpoint('chair', {}, { chair: S }, { chair: D }), S);
  assert.equal(lockSource('chair', {}, { chair: S }, { chair: D }), 'published');
});

test('falls through to shipped default, then null/none', () => {
  assert.equal(resolveViewpoint('chair', {}, {}, { chair: D }), D);
  assert.equal(lockSource('chair', {}, {}, { chair: D }), 'default');
  assert.equal(resolveViewpoint('sofa', {}, {}, {}), null);
  assert.equal(lockSource('sofa', {}, {}, {}), 'none');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/viewpoint-resolve.test.mjs
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure resolver**

`src/features/configurator/viewpoint-resolve.js`:

```js
// Viewpoint resolution order, most specific first (spec: viewpoints section):
//   tenant lock (backend, per-tenant) → global S3 lock ("Livinit default",
//   legacy api/viewpoints.ts) → PRODUCT_VIEWPOINTS shipped default → none.
export function resolveViewpoint(key, tenantLocks, s3Locks, defaults) {
  return tenantLocks[key] || s3Locks[key] || defaults[key] || null;
}

export function lockSource(key, tenantLocks, s3Locks, defaults) {
  if (tenantLocks[key]) return 'tenant';
  if (s3Locks[key]) return 'published';
  if (defaults[key]) return 'default';
  return 'none';
}
```

- [ ] **Step 4: Run to verify it passes**

Same command as Step 2. Expected: 3 pass.

- [ ] **Step 5: Rewire viewport.js onto the resolver + tenant layer**

In `src/features/configurator/viewport.js`:

(a) Import and state (near the existing `_s3Locks` at line ~169):

```js
import { resolveViewpoint, lockSource } from './viewpoint-resolve.js';
import { SIMULATOR_API } from '../../lib/tenant.js';

let _s3Locks = {};
let _tenantLocks = {};
let _vpCtx = { accessToken: null, role: null };
export function setViewpointContext(ctx) { _vpCtx = ctx || { accessToken: null, role: null }; }
```

(b) Replace the bodies of the two local helpers with delegation (all existing call sites keep working):

```js
function _resolveViewpoint(key) { return resolveViewpoint(key, _tenantLocks, _s3Locks, PRODUCT_VIEWPOINTS); }
function _lockSource(key) { return lockSource(key, _tenantLocks, _s3Locks, PRODUCT_VIEWPOINTS); }
```

(c) New tenant loader (next to `loadLockedViewpoints`):

```js
// Tenant-specific locks from the backend; global/default stay as fallback.
export async function loadTenantViewpoints() {
  if (!_vpCtx.accessToken) return;
  try {
    const res = await fetch(SIMULATOR_API + '/viewpoints', {
      headers: { Authorization: 'Bearer ' + _vpCtx.accessToken }, cache: 'no-store',
    });
    if (res.ok) _tenantLocks = await res.json() || {};
  } catch (e) { /* offline — tenant layer stays empty, fallbacks apply */ }
  applyLockedViewpoint(appStore.getState().currentModelKey);
  refreshViewpointUI();
}
```

(d) Route lock/unlock by role — top of `lockCurrentViewpoint` / `unlockCurrentViewpoint`:

```js
export async function lockCurrentViewpoint() {
  if (_vpCtx.role === 'client_admin') return _lockTenantViewpoint();
  /* existing admin-key S3 path unchanged below */
```

```js
export async function unlockCurrentViewpoint() {
  if (_vpCtx.role === 'client_admin') return _unlockTenantViewpoint();
  /* existing admin-key S3 path unchanged below */
```

(e) The tenant write pair:

```js
async function _lockTenantViewpoint() {
  const key = appStore.getState().currentModelKey;
  const viewpoint = { theta: E.sph.theta, phi: E.sph.phi, r: E.sph.r, tgt: [E.tgt.x, E.tgt.y, E.tgt.z] };
  const btn = document.getElementById('btn-vp-lock');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(SIMULATOR_API + '/viewpoints/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _vpCtx.accessToken },
      body: JSON.stringify(viewpoint),
    });
    if (!res.ok) { showToast('Could not save viewpoint'); return; }
    const data = await res.json();
    _tenantLocks[key] = data.viewpoint;
    E.minZoomR = data.viewpoint.r;
    refreshViewpointUI();
    showToast('Viewpoint locked for your workspace');
  } catch (e) { showToast('Could not save viewpoint'); }
  finally { if (btn) btn.disabled = false; }
}

async function _unlockTenantViewpoint() {
  const key = appStore.getState().currentModelKey;
  if (!_tenantLocks[key]) { showToast('No workspace viewpoint set for ' + key.replace('_', ' ')); return; }
  const btn = document.getElementById('btn-vp-unlock');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(SIMULATOR_API + '/viewpoints/' + encodeURIComponent(key), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + _vpCtx.accessToken },
    });
    if (!res.ok && res.status !== 204) { showToast('Could not clear viewpoint'); return; }
    delete _tenantLocks[key];
    applyLockedViewpoint(key);
    showToast('Workspace viewpoint cleared — back to default');
  } catch (e) { showToast('Could not clear viewpoint'); }
  finally { if (btn) btn.disabled = false; }
}
```

(f) Role-gate the lock UI in `refreshViewpointUI` (spec: lock controls visible only for client_admin; the legacy admin-key path stays code-reachable as a Livinit-internal tool but disappears from the UI). Add at the end, and extend the source label map:

```js
  const base = { tenant: 'Locked for your workspace', published: 'Published to all',
                 default: 'Using shipped default', none: 'No zoom limit set' }[src];
```

```js
  const isVpAdmin = _vpCtx.role === 'client_admin';
  const lockBtn = document.getElementById('btn-vp-lock');
  const unlockBtn = document.getElementById('btn-vp-unlock');
  if (lockBtn) lockBtn.style.display = isVpAdmin ? '' : 'none';
  if (unlockBtn) unlockBtn.style.display = isVpAdmin ? '' : 'none';
```

- [ ] **Step 6: Wire boot**

In `src/app/boot.js`:

(a) In `bootWithSession`, right after `const first = applyTenantToUI(tenant, session) || 'chair';`:

```js
  window.setViewpointContext?.({ accessToken: session.accessToken || null, role: tenant.role || null });
```

(b) In `startApp`, right after the existing `window.loadLockedViewpoints?.();` (line ~131):

```js
  window.loadTenantViewpoints?.();
```

(Context is set before `startApp` runs, so the loader sees the token. For demo/guest/staff, `accessToken` is null and `loadTenantViewpoints` returns immediately — today's behavior exactly.)

- [ ] **Step 7: Full suite + demo smoke**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node --test test/
```
Expected: all pass. Then the Task 6 Step 7 manual smoke once more — with a demo session the lock/unlock buttons must now be HIDDEN (role is null), the shipped-default zoom floor must still apply, and the state label must render.

- [ ] **Step 8: Commit**

```bash
git add src/features/configurator/viewpoint-resolve.js src/features/configurator/viewport.js src/app/boot.js test/viewpoint-resolve.test.mjs
git commit -m "feat(viewpoints): per-tenant camera locks with global/default fallback"
```

---

### Task 9: Final verification + deploy notes

**Files:**
- Modify: none (verification only), plus a short deploy note appended to the spec.

- [ ] **Step 1: Run both full suites**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit && .venv/bin/python -m pytest tests/ -v
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator && node --test test/
```
Expected: everything green. If anything fails, fix before proceeding — do not commit red.

- [ ] **Step 2: Append the deploy checklist to the spec**

Append to `docs/superpowers/specs/2026-08-01-designs-viewpoints-backend-sync-design.md`:

```markdown
## Deploy checklist (manual — Hetzner box + Supabase)

1. Apply `0011_designs_viewpoints.sql` to the Supabase project (SQL editor), same
   process as 0001–0010. The `simulator` schema is already in Exposed schemas.
2. Deploy backend-livinit to the Hetzner box (135.181.63.185) — manual pull/restart.
   Verify: `api.livinit.ai/simulator/docs` lists /designs and /viewpoints.
3. Deploy the simulator frontend to the same box (custom runner, manual pull/restart).
4. Live pass: real login on two browsers — design saved on one appears on the other;
   client_admin lock applies to that tenant only (check a second tenant unaffected).
```

- [ ] **Step 3: Commit the spec note**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
git add docs/superpowers/specs/2026-08-01-designs-viewpoints-backend-sync-design.md
git commit -m "docs: deploy checklist for designs/viewpoints sync"
```
