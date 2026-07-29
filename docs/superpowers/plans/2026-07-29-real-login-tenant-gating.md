# Real Login + Tenant Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the guest-only demo auth in `livinit_fabric_simulator` with real Supabase email/password login, gated on tenant status from `backend-livinit`'s new `GET /simulator/me`, while leaving the default no-login guest sandbox untouched.

**Architecture:** A new `supabase-client.js` wraps `supabase-js` (loaded via CDN ESM import, no build step) for sign-in/sign-out/session-read against the shared Livinit Supabase project. `auth.js` is rewritten so `getSession()` is async and returns either a `source: 'demo'` session (guest or the existing headless-test identity — both keep using the local `DEMO_TENANTS` catalog, untouched) or a `source: 'real'` session carrying a bearer token. `tenant.js` branches on that `source`: demo sessions never hit the network (current behavior, unchanged); real sessions call `GET https://api.livinit.ai/simulator/me` and map the response into gating decisions. `boot.js`'s top-level call becomes async to await `getSession()` before deciding what to show.

**Tech Stack:** Vanilla ES modules (no bundler), `supabase-js` v2 via `https://esm.sh/@supabase/supabase-js@2`, Puppeteer-based headless smoke test (existing, unaffected).

## Global Constraints

- No build step exists in this repo (raw ES modules served as static files) — every new import must work as a native browser ESM import, no npm install.
- `navigator.webdriver` branch in `getSession()` must keep returning a `source: 'demo'` session identical in shape/values to today, so `test/smoke.mjs` and any headless run is unaffected.
- Real backend calls target `https://api.livinit.ai` only — no dev/staging API domain exists.
- Never silently fall back to guest mode on a real-session `/me` failure — show an explicit error state instead.
- No catalog/credits/onboarding/staff-console work — those are explicitly out of scope per the approved spec (`docs/superpowers/specs/2026-07-29-real-login-tenant-gating-design.md`).
- Do not touch these pre-existing, unrelated, already-uncommitted paths in this repo: `docs/superpowers/specs/Fabric-Simulator-Screens.pdf` (deleted), `docs/superpowers/plans/2026-07-27-tablet-mode-fixes.md` (untracked), `test/demo-run.mjs` (untracked). They are someone else's in-progress work.

---

## Task 0: Create the working branch

**Files:** none (git operation only)

- [ ] **Step 1: Create and check out the branch**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
git checkout -b feat/simulator-real-login
```

Expected: `Switched to a new branch 'feat/simulator-real-login'`, branched off `feat/undo-save-tablet`.

---

## Task 1: Supabase client wrapper

**Files:**
- Create: `src/lib/supabase-config.js`
- Create: `src/lib/supabase-client.js`

**Interfaces:**
- Produces: `SUPABASE_URL: string`, `SUPABASE_ANON_KEY: string` (from `supabase-config.js`); `signInWithPassword(email, password): Promise<{data, error}>`, `signOutSupabase(): Promise<void>`, `getSupabaseSession(): Promise<Session|null>` (Supabase SDK's own `Session` shape: `{ access_token, user: { id, email, user_metadata } }`), `onAuthStateChange(callback)` (from `supabase-client.js`).

- [ ] **Step 1: Write `supabase-config.js`**

```js
// Public Supabase project config — the anon key is safe to ship client-side
// by design (Postgres RLS is the real security boundary, not this key).
// Same project backend-livinit points at (src/settings.py SUPABASE_URL/KEY).
export const SUPABASE_URL = 'https://nyvlydjdvhsunqbliqru.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55dmx5ZGpkdmhzdW5xYmxpcXJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1MjcwMTMsImV4cCI6MjA3NTEwMzAxM30.mUByk0Bz7kp-w6007yJC-3w5zRGGTE0WrezL-n0QTZw';
```

- [ ] **Step 2: Write `supabase-client.js`**

```js
// Thin wrapper around supabase-js, loaded via CDN ESM import (no build step
// in this repo — see docs/superpowers/specs/2026-07-29-real-login-tenant-gating-design.md
// §3 for why this over a hand-rolled fetch client or a bundler).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOutSupabase() {
  await supabase.auth.signOut();
}

export async function getSupabaseSession() {
  const { data } = await supabase.auth.getSession();
  return data.session; // null if no persisted session
}

export function onAuthStateChange(callback) {
  supabase.auth.onAuthStateChange((event, session) => callback(event, session));
}
```

- [ ] **Step 3: Manual smoke-check the import resolves**

Run: `cd /Users/bhartendukodes/Livi/livinit_fabric_simulator && python3 -m http.server 8123 &` then open `http://localhost:8123/index.html` in a browser and check the console for `Failed to resolve module specifier` or CORS/network errors on the `esm.sh` import.
Expected: no module-resolution errors (the app itself may still be in guest mode with no visible change yet — this step only confirms the import loads). Stop the server after (`kill %1` or close the terminal).

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase-config.js src/lib/supabase-client.js
git commit -m "feat(auth): add supabase-js client wrapper for real login"
```

---

## Task 2: Rewrite `src/lib/auth.js` for real sessions

**Files:**
- Modify: `src/lib/auth.js` (full rewrite — current file is 17 lines, guest-only)

**Interfaces:**
- Consumes: `signInWithPassword`, `signOutSupabase`, `getSupabaseSession` from `src/lib/supabase-client.js` (Task 1).
- Produces:
  - `getSession(): Promise<Session>` where `Session` is either
    `{ source: 'demo', user: { name, email }, tenantId: 'guest'|'acme' }` (unchanged shape from today, plus the new `source` field), or
    `{ source: 'real', user: { name, email }, accessToken: string }`.
  - `signIn(email, password): Promise<{ error: string } | {}>` — on success, caller reloads the page (does not hot-swap state).
  - `signOut(): void` — signs out of Supabase then reloads.
  - `initAuthUI(): void` — wires the form (submit, password-eye toggle); does **not** make the gate visible.
  - `showAuthGate(): void` — makes `#auth-gate` visible (new; replaces the old behavior where `initAuthUI` itself forced the gate open).
  - `hideGate(): void` — unchanged behavior.
  - `showDraftGate(tenant): void` — unchanged behavior, still sets the gate visible itself.
  - `showAuthNetError(onRetry): void` / `hideAuthNetError(): void` — new; the `/me`-fetch-failed state (Task 4 wires the retry).
  - `watchForSignOut(): void` — new; forces a reload back to the gate if a real session's token refresh fails mid-use (called once from `boot.js`, Task 5).

- [ ] **Step 1: Replace the full file contents**

```js
// Session layer. Two session sources:
//   'demo' — guest sandbox (default, no login) or the headless-test identity
//            (navigator.webdriver) — both scope the UI via the local
//            DEMO_TENANTS catalog in tenant.js, no network call.
//   'real' — an actual signed-in Supabase user; tenant.js calls the real
//            backend (GET /simulator/me) to find their tenant + status.
import { signInWithPassword, signOutSupabase, getSupabaseSession, onAuthStateChange } from './supabase-client.js';

const GUEST_SESSION = { source: 'demo', user: { name: 'Guest', email: 'guest@local' }, tenantId: 'guest' };

// A token refresh failure (session expired/revoked mid-use) fires SIGNED_OUT
// on its own, not just on our own signOut() calls. Forces back to the gate
// rather than leaving a real client silently stuck on stale data. Guarded
// against navigator.webdriver so headless test runs never touch this.
export function watchForSignOut() {
  if (navigator.webdriver) return;
  onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload();
  });
}

export async function getSession() {
  // Headless test runs keep the historical tester identity so design-check
  // fixtures (livinit_sim_designs_v1:priya@acme.com) and test/smoke.mjs
  // keep exercising the real boot path without touching real auth at all.
  if (navigator.webdriver) {
    return { source: 'demo', user: { name: 'Priya', email: 'priya@acme.com' }, tenantId: 'acme' };
  }

  const supaSession = await getSupabaseSession();
  if (!supaSession) return GUEST_SESSION;

  return {
    source: 'real',
    user: {
      name: supaSession.user.user_metadata?.name || supaSession.user.email.split('@')[0],
      email: supaSession.user.email,
    },
    accessToken: supaSession.access_token,
  };
}

export async function signIn(email, password) {
  const { error } = await signInWithPassword(email.trim(), password);
  if (error) return { error: error.message || 'Wrong email or password.' };
  return {};
}

export function signOut() {
  signOutSupabase().finally(() => location.reload());
}

// ── Gate UI wiring ────────────────────────────────────────────────────────
// The gate markup lives in index.html (#auth-gate). This wires its behavior:
// sign-in form, password visibility, error state. Does NOT show the gate —
// callers show it explicitly (showAuthGate / showDraftGate / showAuthNetError)
// since the default boot path is guest mode, not a forced gate.
export function initAuthUI() {
  const form  = document.getElementById('auth-form');
  const email = document.getElementById('auth-email');
  const pw    = document.getElementById('auth-pw');
  const err   = document.getElementById('auth-err');
  if (!form) return;

  document.getElementById('auth-pw-eye')?.addEventListener('click', () => {
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = form.querySelector('.auth-cta');
    submitBtn.disabled = true;
    const res = await signIn(email.value, pw.value);
    submitBtn.disabled = false;
    if (res.error) {
      err.textContent = res.error; err.style.display = 'block';
      form.classList.remove('auth-shake'); void form.offsetWidth; form.classList.add('auth-shake');
      return;
    }
    location.reload(); // re-run boot.js's async gate against the new session
  });
}

export function showAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.style.display = 'grid';
}

export function hideGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.style.display = 'none';
}

// Draft/suspended tenants land here instead of the workspace — no half-built
// or paused catalog is ever shown in front of a customer.
export function showDraftGate(tenant) {
  const gate = document.getElementById('auth-gate');
  const login = document.getElementById('auth-login');
  const draft = document.getElementById('auth-draft');
  const neterr = document.getElementById('auth-neterr');
  if (!gate) return;
  gate.style.display = 'grid';
  if (login) login.style.display = 'none';
  if (neterr) neterr.style.display = 'none';
  gate.querySelector('.auth-brand')?.style.setProperty('display', 'none');
  if (draft) {
    draft.style.display = 'block';
    const nm = document.getElementById('auth-draft-name');
    if (nm) nm.textContent = tenant?.name || 'Your workspace';
  }
  document.getElementById('auth-draft-signout')?.addEventListener('click', signOut, { once: true });
}

// GET /simulator/me failed (network or 5xx) after one retry — distinct from
// "wrong password" (that's a form error) and from "draft tenant" (that's a
// known, valid state). Never silently fall back to guest here.
export function showAuthNetError(onRetry) {
  const gate = document.getElementById('auth-gate');
  const login = document.getElementById('auth-login');
  const draft = document.getElementById('auth-draft');
  const neterr = document.getElementById('auth-neterr');
  if (!gate || !neterr) return;
  gate.style.display = 'grid';
  if (login) login.style.display = 'none';
  if (draft) draft.style.display = 'none';
  gate.querySelector('.auth-brand')?.style.setProperty('display', 'none');
  neterr.style.display = 'block';
  document.getElementById('auth-neterr-retry')?.addEventListener('click', onRetry, { once: true });
}

export function hideAuthNetError() {
  const neterr = document.getElementById('auth-neterr');
  if (neterr) neterr.style.display = 'none';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/auth.js
git commit -m "feat(auth): real Supabase sessions, keep demo path for guest + headless tests"
```

---

## Task 3: Restore the login gate markup + CSS in `index.html`

**Files:**
- Modify: `index.html` (insert CSS before line 86's `</style>` close, insert markup after line 102's tenant-chrome `</style>`; restore the tenant-menu sign-out button)

**Interfaces:**
- Produces DOM elements consumed by `src/lib/auth.js` (Task 2): `#auth-gate`, `#auth-login`, `#auth-form`, `#auth-err`, `#auth-email`, `#auth-pw`, `#auth-pw-eye`, `#auth-draft`, `#auth-draft-name`, `#auth-draft-signout`, `#auth-neterr`, `#auth-neterr-retry`. Also restores `#tenant-signout` inside the existing `#tenant-menu`.

- [ ] **Step 1: Insert the auth-gate CSS**

In `index.html`, immediately before the `</style>` on line 86 (the block containing `.panel-pulse`), add:

```css
  /* z-index 800: must sit ABOVE the onboarding tour overlay (#tour-ov, z 700,
     pointer-events:all on first visit) or the tour swallows login clicks. */
  #auth-gate{position:fixed;inset:0;z-index:800;display:none;grid-template-columns:1.05fr .95fr;background:rgb(var(--md-surface));}
  @media(max-width:860px){#auth-gate{grid-template-columns:1fr}.auth-brand{display:none!important}}
  .auth-formside{display:flex;flex-direction:column;justify-content:center;padding:6vh clamp(28px,6vw,84px);}
  .auth-logo{display:flex;align-items:center;gap:10px;font:800 17px/1 var(--font-sans);letter-spacing:-.02em;color:rgb(var(--md-on-surface));margin-bottom:36px;}
  .auth-logo-mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,rgb(var(--md-primary)/.85),rgb(var(--md-primary)));display:grid;place-items:center;color:#fff;}
  .auth-h{font:800 26px/1.15 var(--font-sans);letter-spacing:-.02em;color:rgb(var(--md-on-surface));margin:0 0 6px;}
  .auth-sub{font:400 14px var(--font-sans);color:rgb(var(--md-on-surface-variant));margin:0 0 26px;}
  .auth-stack{display:flex;flex-direction:column;gap:14px;max-width:360px;}
  .auth-field label{display:block;font:600 11px var(--font-sans);color:rgb(var(--md-on-surface-variant));margin-bottom:6px;}
  .auth-inwrap{position:relative;display:flex;align-items:center;}
  .auth-inwrap>svg:first-child{position:absolute;left:12px;color:rgb(var(--md-on-surface-variant));pointer-events:none;}
  .auth-in{width:100%;border:1px solid rgb(var(--md-outline-variant));border-radius:10px;padding:12px 40px;font:500 14px var(--font-sans);color:rgb(var(--md-on-surface));background:rgb(var(--md-surface-container-lowest,255 255 255));transition:border-color .15s,box-shadow .15s;}
  .auth-in:focus{outline:none;border-color:rgb(var(--md-primary));box-shadow:0 0 0 3px rgb(var(--md-primary)/.14);}
  .auth-eye{position:absolute;right:8px;width:30px;height:30px;border:none;background:none;display:grid;place-items:center;color:rgb(var(--md-on-surface-variant));cursor:pointer;border-radius:8px;}
  .auth-eye:hover{background:rgb(var(--md-surface-container));}
  .auth-cta{width:100%;border:none;border-radius:10px;padding:13px;font:700 14px var(--font-sans);color:#fff;background:rgb(var(--md-primary));cursor:pointer;transition:transform .15s,box-shadow .15s;}
  .auth-cta:hover{transform:translateY(-1px);box-shadow:0 8px 18px -8px rgb(var(--md-primary)/.7);}
  .auth-cta:disabled{opacity:.6;cursor:default;transform:none;box-shadow:none;}
  .auth-err{display:none;font:600 12.5px var(--font-sans);color:#c0392b;background:rgba(210,40,20,.08);border:1px solid rgba(210,40,20,.25);border-radius:9px;padding:9px 12px;}
  .auth-shake{animation:authShake .3s ease-in-out;}
  @keyframes authShake{25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
  .auth-brand{background:linear-gradient(155deg,rgb(var(--md-primary)) 0%,rgb(var(--md-primary)/.82) 55%,#2c357f 100%);color:#fff;display:flex;flex-direction:column;justify-content:space-between;padding:6vh clamp(28px,4vw,56px);position:relative;overflow:hidden;}
  .auth-brand::after{content:"";position:absolute;width:440px;height:440px;border-radius:50%;background:rgba(255,255,255,.08);top:-130px;right:-150px;}
  .auth-brand-mark{width:46px;height:46px;border-radius:13px;background:rgba(255,255,255,.16);display:grid;place-items:center;position:relative;}
  .auth-brand h4{font:800 30px/1.15 var(--font-sans);letter-spacing:-.02em;margin:26px 0 12px;position:relative;}
  .auth-brand p{font:400 15px var(--font-sans);color:rgba(255,255,255,.85);margin:0;max-width:30ch;position:relative;}
  .auth-brand .bfoot{font:500 12px var(--font-sans);color:rgba(255,255,255,.6);position:relative;}
  #auth-draft,#auth-neterr{display:none;grid-column:1/-1;place-self:center;text-align:center;max-width:420px;padding:40px;}
  #auth-draft .dic,#auth-neterr .dic{width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,rgb(var(--md-primary)/.8),rgb(var(--md-primary)));display:grid;place-items:center;color:#fff;margin:0 auto 22px;}
  #auth-draft h3,#auth-neterr h3{font:800 22px var(--font-sans);letter-spacing:-.01em;margin:0 0 10px;color:rgb(var(--md-on-surface));}
  #auth-draft p,#auth-neterr p{font:400 14px var(--font-sans);color:rgb(var(--md-on-surface-variant));margin:0 0 22px;}
  #auth-draft .dprog{height:7px;border-radius:4px;background:rgb(var(--md-surface-container-high,231 235 244));overflow:hidden;max-width:280px;margin:0 auto 12px;}
  #auth-draft .dprog i{display:block;height:100%;width:62%;background:rgb(var(--md-primary));border-radius:4px;}
```

- [ ] **Step 2: Insert the auth-gate markup**

In `index.html`, immediately after the tenant-chrome `</style>` (line 102) and before the `<!-- Tenant chrome: floating badge -->` comment, add:

```html
<div id="auth-gate" role="dialog" aria-label="Sign in">
  <div class="auth-formside" id="auth-login">
    <div class="auth-logo"><span class="auth-logo-mark"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l9 5.5v9L12 22l-9-5.5v-9z"/></svg></span> Simulator</div>
    <h3 class="auth-h">Sign in</h3>
    <p class="auth-sub">Use your work account to start a consultation session.</p>
    <form class="auth-stack" id="auth-form" novalidate>
      <div class="auth-err" id="auth-err" role="alert"></div>
      <div class="auth-field"><label for="auth-email">Email</label>
        <div class="auth-inwrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
          <input class="auth-in" id="auth-email" type="email" autocomplete="username" placeholder="you@company.com">
        </div>
      </div>
      <div class="auth-field"><label for="auth-pw">Password</label>
        <div class="auth-inwrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input class="auth-in" id="auth-pw" type="password" autocomplete="current-password" placeholder="Your password">
          <button type="button" class="auth-eye" id="auth-pw-eye" aria-label="Show password"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
      </div>
      <button class="auth-cta" type="submit">Sign in</button>
    </form>
  </div>
  <div class="auth-brand" aria-hidden="true">
    <div class="auth-brand-mark"><svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M12 2l9 5.5v9L12 22l-9-5.5v-9z"/></svg></div>
    <div>
      <h4>Show fabrics in 3D,<br>live with your customer.</h4>
      <p>Your furniture, your finishes — configured in real time during the consultation.</p>
    </div>
    <div class="bfoot">Powered by Livinit</div>
  </div>
  <div id="auth-draft">
    <div class="dic"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l9 5.5v9L12 22l-9-5.5v-9z"/></svg></div>
    <h3><span id="auth-draft-name">Your workspace</span> is being set up</h3>
    <p>Our team is building your 3D furniture catalog and fabric library. You'll get access the moment it's ready.</p>
    <div class="dprog"><i></i></div>
    <p style="font-size:12px;margin-bottom:26px">Modelling &amp; segmentation in progress</p>
    <button class="auth-cta" id="auth-draft-signout" style="max-width:220px">Back to sign in</button>
  </div>
  <div id="auth-neterr">
    <div class="dic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
    <h3>Couldn't reach the simulator</h3>
    <p>Check your connection and try again.</p>
    <button class="auth-cta" id="auth-neterr-retry" style="max-width:220px">Retry</button>
  </div>
</div>
```

- [ ] **Step 3: Add a "Sign in" entry point + restore "Sign out" in `#tenant-menu`**

Find the current `#tenant-menu` block (around line 131):

```html
<div id="tenant-menu">
  <div class="tm-hd" id="tenant-menu-user"></div>
</div>
```

Replace with:

```html
<div id="tenant-menu">
  <div class="tm-hd" id="tenant-menu-user"></div>
  <button id="tenant-signin" style="display:none"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Sign in</button>
  <button id="tenant-signout" style="display:none"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Sign out</button>
</div>
```

Both buttons start hidden — Task 4/5 shows exactly one of them depending on `session.source`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(auth): restore login gate markup/CSS, add sign-in/out to tenant menu"
```

---

## Task 4: Real `/simulator/me` call in `src/lib/tenant.js`

**Files:**
- Modify: `src/lib/tenant.js` (full rewrite of `loadTenantCatalog`; `applyTenantToUI`/`spendRenderCredit` keep their current bodies, `applyTenantToUI` gets a few added lines)

**Interfaces:**
- Consumes: `Session` shape from `src/lib/auth.js` (Task 2).
- Produces: `loadTenantCatalog(session): Promise<TenantResult>` where `TenantResult` is one of:
  - `{ name, status: 'live', slug, products: string[], credits: number }` (normal — passed to `applyTenantToUI` as before)
  - `{ blocked: true, tenant: { name, status: 'draft'|'suspended' } }`
  - `{ staffNotSupported: true }`
  - `{ networkError: true }`
- `applyTenantToUI(tenant, session): string|null` — unchanged return contract (first allowed product key), now also toggles `#tenant-signin`/`#tenant-signout` visibility based on `session.source`.

- [ ] **Step 1: Replace `tenant.js`**

```js
// Tenant catalog seam — "each account sees only its own assets".
//
// Demo sessions (guest sandbox + headless test identity) never hit the
// network — they're scoped entirely from DEMO_TENANTS, exactly as before
// this feature. Real sessions call the actual multi-tenant backend.

const SIMULATOR_API = 'https://api.livinit.ai/simulator';

// The full product catalog every 'live' real tenant gets today — the
// backend doesn't expose a per-tenant catalog yet (see design doc §1,
// "products/credits stay client-side-derived for now"). Matches the demo
// tenants' full set below.
const ALL_PRODUCTS = ['chair', 'accent_chair', 'sofa'];
// Pre-existing fabricated number (was already fake before this feature —
// see src/lib/tenant.js history and the design doc's "credits" decision).
// Not fixed here; out of scope for this pass.
const PLACEHOLDER_CREDITS = 480;

const DEMO_TENANTS = {
  guest:  { name: 'Livinit Simulator', status: 'live', products: ['chair', 'accent_chair', 'sofa'], credits: 480 },
  acme:   { name: 'Acme Furniture', status: 'live',  products: ['chair', 'accent_chair', 'sofa'], credits: 480 },
  cove:   { name: 'Cove & Co.',     status: 'live',  products: ['chair', 'sofa'],                 credits: 120 },
  bhavya: { name: 'Bhavya Interiors', status: 'draft', products: [], credits: 0 },
};

export async function loadTenantCatalog(session) {
  if (session.source === 'demo') {
    return DEMO_TENANTS[session.tenantId] || DEMO_TENANTS.guest;
  }

  const me = await fetchMe(session.accessToken);
  if (me === null) return { networkError: true };

  if (me.role === 'livinit_staff') return { staffNotSupported: true };

  if (!me.tenant) return { networkError: true }; // client role with no tenant row: not a valid state, treat as an error rather than guessing

  if (me.tenant.status !== 'live') {
    return { blocked: true, tenant: { name: me.tenant.name, status: me.tenant.status } };
  }

  return {
    name: me.tenant.name,
    status: 'live',
    slug: me.tenant.slug,
    products: ALL_PRODUCTS,
    credits: PLACEHOLDER_CREDITS,
  };
}

async function fetchMe(accessToken, { retried = false } = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${SIMULATOR_API}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`me: ${r.status}`);
    const body = await r.json();
    return { role: body.role, tenant: body.tenant };
  } catch (e) {
    if (!retried) return fetchMe(accessToken, { retried: true });
    console.error('GET /simulator/me failed after retry', e);
    return null;
  }
}

// Scope the existing UI to the tenant: hide product tabs outside their
// catalog, stamp the tenant chrome (badge, credits, avatar initials), and
// show the correct sign-in/sign-out entry point.
export function applyTenantToUI(tenant, session) {
  const tabs = { chair: 'tab-chair', accent_chair: 'tab-accent_chair', sofa: 'tab-sofa' };
  let firstAllowed = null;
  Object.entries(tabs).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const allowed = tenant.products.includes(key);
    el.style.display = allowed ? '' : 'none';
    if (allowed && !firstAllowed) firstAllowed = key;
  });

  const badge = document.getElementById('tenant-badge');
  if (badge) {
    badge.style.display = 'flex';
    document.getElementById('tenant-badge-name').textContent = tenant.name;
    document.getElementById('tenant-credits-n').textContent = tenant.credits;
    const initials = (session.user.name || 'U').slice(0, 1).toUpperCase();
    const av = document.getElementById('tenant-avatar');
    if (av) av.textContent = initials;
    const rail = document.querySelector('.nav-rail-avatar');
    if (rail) { rail.textContent = initials; rail.title = session.user.name + ' · ' + tenant.name; }
  }

  const signin = document.getElementById('tenant-signin');
  const signout = document.getElementById('tenant-signout');
  if (signin) signin.style.display = session.source === 'demo' ? 'flex' : 'none';
  if (signout) signout.style.display = session.source === 'real' ? 'flex' : 'none';

  return firstAllowed;
}

export function spendRenderCredit() {
  const el = document.getElementById('tenant-credits-n');
  if (!el) return;
  const n = parseInt(el.textContent, 10);
  if (!isNaN(n) && n > 0) el.textContent = n - 1;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tenant.js
git commit -m "feat(auth): wire tenant.js to real GET /simulator/me for real sessions"
```

---

## Task 5: Async boot gate in `src/app/boot.js`

**Files:**
- Modify: `src/app/boot.js` (imports at top; replace the `bootWithSession(getSession())` call at the bottom; extend `bootWithSession`; wire the new menu buttons)

**Interfaces:**
- Consumes: `getSession` (auth.js, Task 2), `initAuthUI`, `showAuthGate`, `hideGate`, `showDraftGate`, `showAuthNetError`, `hideAuthNetError`, `signOut`, `watchForSignOut` (auth.js, Task 2), `loadTenantCatalog`, `applyTenantToUI`, `spendRenderCredit` (tenant.js, Task 4).

- [ ] **Step 1: Update the import line**

Find (current line 9-10):

```js
import { getSession } from '../lib/auth.js';
import { loadTenantCatalog, applyTenantToUI, spendRenderCredit } from '../lib/tenant.js';
```

Replace with:

```js
import { getSession, initAuthUI, showAuthGate, hideGate, showDraftGate, showAuthNetError, hideAuthNetError, signOut, watchForSignOut } from '../lib/auth.js';
import { loadTenantCatalog, applyTenantToUI, spendRenderCredit } from '../lib/tenant.js';
```

- [ ] **Step 2: Replace `bootWithSession` and the bottom-of-file bootstrap**

Find (current, around line 156-186):

```js
// ── Boot (guest mode — the login gate was removed) ────────────────────────
// Scope the UI to the tenant catalog, wire the account chrome, then boot.
async function bootWithSession(session){
  const scriptsReady = window.loadScripts([
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/environments/RoomEnvironment.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js',
  ]);
  const tenant = await loadTenantCatalog(session);
  const first = applyTenantToUI(tenant, session) || 'chair';
  _wireTenantMenu(session, tenant);
  startApp(tenant.products.length ? tenant.products : ['chair'], scriptsReady);
  // Demo credit meter: count each render against the badge. Real counter
  // comes from GET /api/billing once the credits contract is wired.
  const _render = window.renderScene;
  window.renderScene = (...a) => { spendRenderCredit(); return _render(...a); };
  void first;
}

function _wireTenantMenu(session, tenant){
  const av = document.getElementById('tenant-avatar');
  const menu = document.getElementById('tenant-menu');
  if (!av || !menu) return;
  document.getElementById('tenant-menu-user').textContent =
    `${session.user.name} · ${tenant.name}`;
  av.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

bootWithSession(getSession());
```

Replace with:

```js
// ── Boot ────────────────────────────────────────────────────────────────
// Guest sandbox stays the default, no-login landing (see design doc §1).
// A real session gates on the tenant's live status via GET /simulator/me.
async function bootWithSession(session, tenant){
  const scriptsReady = window.loadScripts([
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/environments/RoomEnvironment.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js',
  ]);
  const first = applyTenantToUI(tenant, session) || 'chair';
  _wireTenantMenu(session, tenant);
  startApp(tenant.products.length ? tenant.products : ['chair'], scriptsReady);
  const _render = window.renderScene;
  window.renderScene = (...a) => { spendRenderCredit(); return _render(...a); };
  void first;
}

function _wireTenantMenu(session, tenant){
  const av = document.getElementById('tenant-avatar');
  const menu = document.getElementById('tenant-menu');
  if (!av || !menu) return;
  document.getElementById('tenant-menu-user').textContent =
    `${session.user.name} · ${tenant.name}`;
  av.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
  document.getElementById('tenant-signin')?.addEventListener('click', e => { e.stopPropagation(); showAuthGate(); }, { once: true });
  document.getElementById('tenant-signout')?.addEventListener('click', e => { e.stopPropagation(); signOut(); }, { once: true });
}

// Entry point: resolve the session, then either boot straight in (demo, or
// a real 'live' tenant) or show the appropriate gate state. initAuthUI()
// wires the form once up front regardless of path — cheap, and needed
// before showAuthGate() can be meaningfully shown from the tenant menu.
async function main(){
  initAuthUI();
  hideGate();
  watchForSignOut();

  const session = await getSession();
  const result = await loadTenantCatalog(session);

  if (result.networkError) {
    showAuthNetError(() => { hideAuthNetError(); main(); });
    return;
  }
  if (result.staffNotSupported) {
    showToast('Staff console not built yet — sign in with a client account.');
    signOut();
    return;
  }
  if (result.blocked) {
    showDraftGate(result.tenant);
    return;
  }

  hideGate();
  await bootWithSession(session, result);
}

main();
```

- [ ] **Step 3: Commit**

```bash
git add src/app/boot.js
git commit -m "feat(auth): async boot gate — route demo/live/draft/staff/error sessions"
```

---

## Task 6: CORS — allow the frontend origin in `backend-livinit`

**Files:**
- Modify: `/Users/bhartendukodes/Livi/backend-livinit/src/settings.py:35-42` (`ALLOWED_ORIGINS`)

**Interfaces:** none (config-only change).

- [ ] **Step 1: Add the frontend's deployed origin**

In `backend-livinit/src/settings.py`, find:

```python
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:3010",
        "https://livinit.ai",
        "https://www.livinit.ai",
        "https://web.dev.livinit.ai",
        "https://web.livinit.ai",
    ]
```

Replace with:

```python
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:3010",
        "http://localhost:8123",
        "https://livinit.ai",
        "https://www.livinit.ai",
        "https://web.dev.livinit.ai",
        "https://web.livinit.ai",
        "https://asset-designer-dev.vercel.app",
    ]
```

(`localhost:8123` added too — that's the port `test/smoke.mjs`'s local static server and Task 1 Step 3's manual check both use, matching the pattern of the other two localhost entries already in the list.)

- [ ] **Step 2: Verify the backend still compiles**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
.venv/bin/python -m compileall src -q && echo COMPILE_OK
.venv/bin/python -m ruff check src
```

Expected: `COMPILE_OK` and `All checks passed!`.

- [ ] **Step 3: Commit (in the backend-livinit repo, separate from the frontend commits)**

```bash
cd /Users/bhartendukodes/Livi/backend-livinit
git checkout -b feat/simulator-frontend-cors
git add src/settings.py
git commit -m "feat(simulator): allow the fabric-simulator frontend origin in CORS"
```

Leave this on its own branch — pushing/merging it is a decision for whoever reviews the frontend work, not bundled silently into the frontend PR.

---

## Task 7: Manual verification pass

**Files:** none (verification only — per the approved spec, automated login test coverage is explicitly deferred).

- [ ] **Step 1: Confirm the headless smoke test still passes (demo path untouched)**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
node test/smoke.mjs
```

Expected: all checks pass, same as before this feature (confirms the `navigator.webdriver` / demo path is unaffected).

- [ ] **Step 2: Manual guest-mode check**

Run `python3 -m http.server 8123` in the repo root, open `http://localhost:8123/index.html`.
Expected: boots straight into guest mode exactly as before (no gate shown), "Sign in" now visible in the account menu (click the avatar top area).

- [ ] **Step 3: Manual real-login check (needs a real seeded Supabase user)**

Ask staff to create one test user in the shared Supabase project's `auth.users` with a `simulator.memberships` row pointing at a `live` tenant (per the onboarding design doc — staff-entered, no self-serve signup). Click "Sign in", enter that user's email/password.
Expected: redirects into the app scoped to that tenant's name in the badge; wrong password shows the inline error + shake; a `draft`-status tenant account shows the "workspace is being set up" screen; "Sign out" from the account menu returns to guest mode.

- [ ] **Step 4: Manual CORS check**

With `backend-livinit`'s CORS change from Task 6 deployed (or running locally against `http://localhost:8000` with `ALLOWED_ORIGINS` temporarily including `http://localhost:8123` — already added in Task 6), confirm the `GET /simulator/me` call in the browser Network tab returns 200, not a CORS-blocked failure.

- [ ] **Step 5: Final full-repo status check**

```bash
cd /Users/bhartendukodes/Livi/livinit_fabric_simulator
git status --short
git log --oneline feat/undo-save-tablet..feat/simulator-real-login
```

Expected: working tree clean except the three pre-existing unrelated paths called out in Global Constraints (still present, still untouched); the commit list shows exactly this plan's commits.
