// Session layer — GUEST MODE ONLY.
//
// The multi-tenant sign-in gate was removed (founder call: ship undo/save/
// tablet with no login). This module now just answers "who is the user" so
// per-user features (saved designs key `livinit_sim_designs_v1:<email>`,
// tenant chrome) keep working. If real auth returns later, restore the
// Supabase-shaped signIn/signOut/initAuthUI surface from git history
// (feat/design-history-tablet, src/lib/auth.js@be11c7d).

export function getSession() {
  // Headless test runs keep the historical tester identity so design-check
  // fixtures (livinit_sim_designs_v1:priya@acme.com) stay valid.
  if (navigator.webdriver) {
    return { user: { name: 'Priya', email: 'priya@acme.com' }, tenantId: 'acme', role: 'client' };
  }
  return { user: { name: 'Guest', email: 'guest@local' }, tenantId: 'guest', role: 'client' };
}
