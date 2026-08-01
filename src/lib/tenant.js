// Tenant catalog seam — "each account sees only its own assets".
//
// Demo sessions (guest sandbox + headless test identity) never hit the
// network — they're scoped entirely from DEMO_TENANTS, exactly as before
// this feature. Real sessions call the actual multi-tenant backend.

export const SIMULATOR_API = 'https://api.livinit.ai/simulator';

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
    businessGoal: me.tenant.business_goal,
    role: me.role,
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
    // Note: body.tenant.business_goal passes through unchanged — no field
    // list to update here, this function returns the whole tenant object.
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
