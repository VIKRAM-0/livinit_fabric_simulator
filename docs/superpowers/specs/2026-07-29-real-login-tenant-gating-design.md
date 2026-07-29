# Real Login + Tenant Gating — Design

**Date:** 2026-07-29 · **Branch:** TBD · **Approved by founder:** no (approved by user in-session, not yet by founder)

## 1. Problem

`backend-livinit`'s multi-tenant fabric-simulator backend (`src/simulator`) shipped
today — schema, RLS, JWT auth (`GET /simulator/me`), custom claims hook — but has
zero real caller. The frontend's login gate was removed on purpose three weeks ago
(`b85be25`, `df835e7`, "founder call: ship undo/save/tablet with no login") to ship
undo/save/tablet fast; `src/lib/auth.js` is guest-only today, and `src/lib/tenant.js`
scopes the UI against a hardcoded `DEMO_TENANTS` object, not any real backend. The
backend work has nothing to attach to until the frontend can authenticate a real user
and gate the app shell on that user's real tenant status.

This is a narrow, deliberately small scope: real login + tenant-status gating only.
Not in scope — the backend doesn't support these yet, or the product spec explicitly
defers them:
- Client-facing onboarding/intake UI (`2026-07-29-multi-tenant-onboarding-design.md`
  §1 locks this as staff-entered in v1, no client intake UI).
- Catalog/fabric/design data from the new backend (only `/simulator/health` and
  `/simulator/me` exist right now — catalog stays on the existing demo/legacy path).
- The real credits/usage badge (backend has no usage-tracking endpoint yet).
- Staff (`livinit_staff` role) login and any staff console.

## 2. Decisions locked this session

| Question | Decision |
|---|---|
| Target repo | `livinit_fabric_simulator` (the actual simulator webapp) |
| Scope | Real email/password login + tenant-status gating via `GET /simulator/me`. Nothing else. |
| Staff login | Out of scope. A staff account signing in sees a plain "staff console not built yet" message, not a crash or misrouted view. |
| Auth method | Email + password only (matches the shape of the old, always-demo `auth.js`; magic link deferred). |
| Auth implementation | `supabase-js` via CDN ESM import (`https://esm.sh/@supabase/supabase-js@2`) — no build step, matches the existing Tailwind/Three.js CDN-script convention already in `index.html`. Rejected: hand-rolled `fetch()` calls to the Auth REST API (more custom token-refresh code to get subtly wrong); a real bundler/build step (architecture change disproportionate to this task). |
| Supabase project | The shared Livinit Supabase project — same one `backend-livinit` now points at (today's `82a3fbf` refactor). Not a standalone project. |
| Config delivery | Hardcode `SUPABASE_URL` + anon key in a new `src/lib/supabase-config.js`. The anon key is public/safe by design (RLS is the real boundary) and this matches the app's zero-build static deployment — no new backend config endpoint. |
| Guest sandbox | Stays exactly as-is: default landing, no login required, unaffected by any of this (per `2026-07-29-multi-tenant-onboarding-design.md` §1, "Guest tenant stays, permanently"). Login is an added entry point, not a replacement gate. |
| `/me` fetch failure | Retry once, then show an explicit error state. Never silently fall back to guest — that would show a real signed-in client the wrong (public) catalog instead of failing loudly. |
| Automated test coverage | None for the new real-login path this pass — this repo has no local Supabase credentials to seed a real test user against. The existing `navigator.webdriver` bypass in `getSession()` is left untouched, so current headless smoke tests keep passing unaffected. Real login gets manual verification only; automated coverage is an explicit follow-up, not silently dropped. |

## 3. Architecture

```
supabase-config.js  →  supabase-client.js  →  auth.js  →  boot.js  →  tenant.js
   (URL + anon key)      (SDK wrapper)        (session,     (gate       (GET /me,
                                                gate UI)      routing)    UI scoping)
```

- **`src/lib/supabase-config.js`** (new) — exports `SUPABASE_URL`, `SUPABASE_ANON_KEY` as
  plain constants.
- **`src/lib/supabase-client.js`** (new) — `import { createClient } from
  'https://esm.sh/@supabase/supabase-js@2'`, constructs the client once, re-exports
  `signInWithPassword`, `signOut`, `getSession`, `onAuthStateChange`.
- **`src/lib/auth.js`** (rewrite) — `getSession()` becomes `async`, backed by the real
  persisted Supabase session (`supabase.auth.getSession()`). The `navigator.webdriver`
  branch at the top is unchanged — headless test runs never touch real auth. `signIn`/
  `signOut`/`initAuthUI`/`hideGate`/`showDraftGate` keep their existing public shape
  (this file was already written to make this swap a drop-in, per its own old comment)
  but `signIn` now calls the real SDK instead of matching against `DEMO_ACCOUNTS`.
- **`index.html`** — restore the login gate markup + CSS deleted in `b85be25` (based on
  the pre-removal version in git history, e.g. `df835e7`), with the demo-account
  quick-fill chips removed — there are no demo passwords once this ships.
- **`src/lib/tenant.js`** — `loadTenantCatalog(session)` replaces its speculative
  `GET /api/catalog` call with `GET {SIMULATOR_API_BASE}/simulator/me`, `Authorization:
  Bearer <access_token>`. Maps the response's `tenant.lifecycle_status` into the
  existing tenant shape (`name`, `status`, `products`, `credits`) that
  `applyTenantToUI` already consumes — `products`/`credits` stay client-side-derived
  for now (backend doesn't expose a real catalog/credits yet), only `status`/`name`
  come from the real call.
- **`src/app/boot.js`** — `bootWithSession(getSession())` (currently synchronous)
  becomes an async gate:
  1. No session → guest mode, unchanged, plus a small visible "Sign in" entry point.
  2. Session exists → call `/simulator/me` → route on `role`/`tenant.lifecycle_status`:
     - `role === 'livinit_staff'` → plain "staff console not built yet" message.
     - `tenant.lifecycle_status === 'live'` → normal app, scoped to that tenant.
     - `draft` / `suspended` → existing `showDraftGate(tenant)`.
     - fetch failed after one retry → explicit error state (new, small — reuse the
       gate container, swap in an error message + retry button).
- **`backend-livinit` side-effect (small, separate commit in that repo):** add the
  frontend's deployed origin (`https://asset-designer-dev.vercel.app`) to
  `ALLOWED_ORIGINS` in `src/settings.py`. Without this, every `/simulator/*` call
  from the deployed frontend is CORS-blocked — this is a hard dependency, not
  optional polish.

## 4. Data flow & error handling

- **Boot, no stored session:** guest mode, exactly as today. A "Sign in" link is now
  visible and opens the gate on demand.
- **Sign-in submit:** `supabase.auth.signInWithPassword(email, pw)` → on success,
  `GET /simulator/me` with the bearer token → route per §3. Wrong credentials → the
  existing inline `#auth-err` + shake animation, unchanged.
- **Boot, stored session exists:** the `/me` call runs before any UI decision — a
  stale/expired token is caught here rather than assumed valid.
- **`/me` network failure:** retry once, then the explicit error state described
  above. Never silently downgrade to guest.
- **Session expiry mid-use:** `onAuthStateChange` firing `SIGNED_OUT` triggers a
  forced reload back to the gate.
- **Sign-out:** `supabase.auth.signOut()` → reload into guest mode.

## 5. Testing

- Existing headless smoke tests (`test/demo-run.mjs`, and whatever currently depends
  on `getSession()`'s `navigator.webdriver` branch) are unaffected — that code path
  is untouched.
- `test/auth-check.mjs` (deleted in `b85be25`) is not being resurrected in this pass —
  it tested the old fake `DEMO_ACCOUNTS` flow, which no longer exists.
- Real email/password login: **manual verification only** this pass. Needs a real
  seeded Supabase user in the shared project (staff to create one, e.g. via the
  Supabase dashboard) and this machine's `.env` populated to test locally end to end.
  Automated coverage for the real login path is explicitly deferred, not silently
  dropped.
- `ruff`/lint-equivalent for this repo: none configured (plain JS, no build step) —
  verification is manual smoke-testing in a browser (guest boot still works, sign-in
  with a real account routes correctly, sign-in with wrong password shows the error,
  draft-tenant account shows the draft gate) plus confirming the existing headless
  smoke test still passes.
