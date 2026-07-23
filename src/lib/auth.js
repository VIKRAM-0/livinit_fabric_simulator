// Auth/session layer — multi-tenant gate for the simulator.
//
// MODE: 'demo' — sessions are validated against DEMO_ACCOUNTS and persisted in
// localStorage. The public surface (getSession/signIn/signOut) is deliberately
// shaped like the Supabase flow so the swap is a drop-in:
//   signIn()  → supabase.auth.signInWithPassword() + read tenant_id/role claims
//   getSession() → supabase.auth.getSession()
//   signOut() → supabase.auth.signOut()
// Nothing outside this file should know which mode is active.

const SESSION_KEY = 'livinit_sim_session_v1';

// Demo directory — mirrors the simulator.memberships shape (user → tenant → role).
// Passwords are demo-only; the real flow never stores one client-side.
export const DEMO_ACCOUNTS = [
  { email: 'priya@acme.com',   pw: 'demo', name: 'Priya',  tenantId: 'acme',   role: 'client' },
  { email: 'buyer@bhavya.com', pw: 'demo', name: 'Rohan',  tenantId: 'bhavya', role: 'client' },
  { email: 'dana@cove.co',     pw: 'demo', name: 'Dana',   tenantId: 'cove',   role: 'client' },
];

export function getSession() {
  // Headless test runs (puppeteer sets navigator.webdriver) auto-login as the
  // full-catalog tenant so test/smoke.mjs keeps exercising the real boot path.
  if (navigator.webdriver) {
    return { user: { name: 'Priya', email: 'priya@acme.com' }, tenantId: 'acme', role: 'client' };
  }
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
  catch { return null; }
}

export function signIn(email, pw) {
  const acc = DEMO_ACCOUNTS.find(a => a.email === email.trim().toLowerCase());
  if (!acc || acc.pw !== pw) return { error: 'Wrong email or password. Try a demo account below.' };
  const session = { user: { name: acc.name, email: acc.email }, tenantId: acc.tenantId, role: acc.role };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  return { session };
}

export function signOut() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  location.reload();
}

// ── Gate UI wiring ────────────────────────────────────────────────────────
// The gate markup lives in index.html (#auth-gate). This wires its behavior:
// sign-in form, password visibility, demo-account quick-fill, error state,
// and the draft-tenant "being set up" variant.
export function initAuthUI(onSignedIn) {
  const gate  = document.getElementById('auth-gate');
  const form  = document.getElementById('auth-form');
  const email = document.getElementById('auth-email');
  const pw    = document.getElementById('auth-pw');
  const err   = document.getElementById('auth-err');
  if (!gate || !form) return;

  gate.style.display = 'grid';

  document.getElementById('auth-pw-eye')?.addEventListener('click', () => {
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });

  // Demo quick-fill chips
  document.querySelectorAll('[data-demo-acc]').forEach(chip => {
    chip.addEventListener('click', () => {
      email.value = chip.dataset.demoAcc; pw.value = 'demo';
      err.style.display = 'none';
    });
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const res = signIn(email.value, pw.value);
    if (res.error) {
      err.textContent = res.error; err.style.display = 'block';
      form.classList.remove('auth-shake'); void form.offsetWidth; form.classList.add('auth-shake');
      return;
    }
    onSignedIn(res.session);
  });
}

export function hideGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.style.display = 'none';
}

// Draft tenants land here instead of the workspace — no half-built catalog is
// ever shown in front of a customer.
export function showDraftGate(tenant) {
  const gate = document.getElementById('auth-gate');
  const login = document.getElementById('auth-login');
  const draft = document.getElementById('auth-draft');
  if (!gate) return;
  gate.style.display = 'grid';
  if (login) login.style.display = 'none';
  gate.querySelector('.auth-brand')?.style.setProperty('display', 'none');
  if (draft) {
    draft.style.display = 'block';
    const nm = document.getElementById('auth-draft-name');
    if (nm) nm.textContent = tenant?.name || 'Your workspace';
  }
  document.getElementById('auth-draft-signout')?.addEventListener('click', signOut, { once: true });
}
