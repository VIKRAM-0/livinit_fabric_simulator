// Session layer. Two session sources:
//   'demo' — guest sandbox (default, no login) or the headless-test identity
//            (navigator.webdriver) — both scope the UI via the local
//            DEMO_TENANTS catalog in tenant.js, no network call.
//   'real' — an actual signed-in Supabase user; tenant.js calls the real
//            backend (GET /simulator/me) to find their tenant + status.
import { signInWithPassword, signOutSupabase, getSupabaseSession, onAuthStateChange } from './supabase-client.js';

const GUEST_SESSION = { source: 'demo', user: { name: 'Guest', email: 'guest@local' }, tenantId: 'guest' };

// getSession() is async (it awaits Supabase's persisted-session lookup), but
// several UI modules (e.g. saved-panel.js) need a session synchronously at
// call time — they run well after boot.js's own `await getSession()` has
// resolved once, so a cache is safe. Seeded with the guest shape so any
// edge-case caller that somehow runs before boot.js's first resolution still
// gets a sensible, well-shaped session instead of undefined.
let _cachedSession = GUEST_SESSION;

// Sync reader for callers that can't await (see comment above). Do NOT use
// this inside auth.js/tenant.js/boot.js's own session-resolution path — those
// call the real async getSession().
export function getCachedSession() {
  return _cachedSession;
}

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
    return (_cachedSession = { source: 'demo', user: { name: 'Priya', email: 'priya@acme.com' }, tenantId: 'acme' });
  }

  const supaSession = await getSupabaseSession();
  if (!supaSession) return (_cachedSession = GUEST_SESSION);

  return (_cachedSession = {
    source: 'real',
    user: {
      name: supaSession.user.user_metadata?.name || supaSession.user.email.split('@')[0],
      email: supaSession.user.email,
    },
    accessToken: supaSession.access_token,
  });
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

  document.getElementById('auth-gate-close')?.addEventListener('click', hideGate);

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

// Always leaves the gate in the plain "sign in form" state, regardless of
// what showDraftGate()/showAuthNetError() left hidden/shown before — the gate
// can be reopened multiple times in one page lifetime (tenant menu "Sign in",
// gate close/back button), so nothing from a prior draft/network-error visit
// may leak into a later plain sign-in visit.
export function showAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;
  const login = document.getElementById('auth-login');
  const draft = document.getElementById('auth-draft');
  const neterr = document.getElementById('auth-neterr');
  if (login) login.style.display = '';
  gate.querySelector('.auth-brand')?.style.removeProperty('display');
  if (draft) draft.style.display = 'none';
  if (neterr) neterr.style.display = 'none';
  gate.style.display = 'grid';
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
  document.getElementById('auth-neterr-signout')?.addEventListener('click', signOut, { once: true });
}

export function hideAuthNetError() {
  const neterr = document.getElementById('auth-neterr');
  if (neterr) neterr.style.display = 'none';
}
