// Tenant catalog seam — "each account sees only its own assets".
//
// loadTenantCatalog() first tries the real backend (GET /api/catalog with the
// session bearer). Until that endpoint ships, it falls back to DEMO_TENANTS,
// which scope the existing built-in catalog per tenant. The UI-facing shape is
// identical in both modes, so wiring the real API later touches nothing else.

// Demo tenants — different product sets prove the isolation visually:
// switching accounts changes which products (and therefore which fabric
// libraries) exist at all.
const DEMO_TENANTS = {
  // Guest-mode default (login gate disabled): full catalog, neutral branding.
  guest:  { name: 'Livinit Simulator', status: 'live', products: ['chair', 'accent_chair', 'sofa'], credits: 480 },
  acme:   { name: 'Acme Furniture', status: 'live',  products: ['chair', 'accent_chair', 'sofa'], credits: 480 },
  cove:   { name: 'Cove & Co.',     status: 'live',  products: ['chair', 'sofa'],                 credits: 120 },
  bhavya: { name: 'Bhavya Interiors', status: 'draft', products: [], credits: 0 },
};

export async function loadTenantCatalog(session) {
  // Real backend first — silently fall back if it isn't deployed yet.
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch('/api/catalog', {
      headers: { Authorization: 'Bearer ' + (session.token || 'demo') },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (r.ok) return await r.json(); // { name, status, products[], credits }
  } catch { /* endpoint not live yet — demo mode */ }
  return DEMO_TENANTS[session.tenantId] || DEMO_TENANTS.acme;
}

// Scope the existing UI to the tenant: hide product tabs outside their
// catalog, stamp the tenant chrome (badge, credits, avatar initials).
export function applyTenantToUI(tenant, session) {
  // Product picker — hide models this tenant doesn't own.
  const tabs = { chair: 'tab-chair', accent_chair: 'tab-accent_chair', sofa: 'tab-sofa' };
  let firstAllowed = null;
  Object.entries(tabs).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const allowed = tenant.products.includes(key);
    el.style.display = allowed ? '' : 'none';
    if (allowed && !firstAllowed) firstAllowed = key;
  });

  // Tenant badge (floating, top-right of the canvas)
  const badge = document.getElementById('tenant-badge');
  if (badge) {
    badge.style.display = 'flex';
    document.getElementById('tenant-badge-name').textContent = tenant.name;
    document.getElementById('tenant-credits-n').textContent = tenant.credits;
    const initials = (session.user.name || 'U').slice(0, 1).toUpperCase();
    const av = document.getElementById('tenant-avatar');
    if (av) av.textContent = initials;
    // Rail avatar mirrors the signed-in user
    const rail = document.querySelector('.nav-rail-avatar');
    if (rail) { rail.textContent = initials; rail.title = session.user.name + ' · ' + tenant.name; }
  }
  return firstAllowed;
}

// Demo credit meter — decrements the badge when a render fires. The real
// counter comes from GET /api/billing once the credits contract is wired.
export function spendRenderCredit() {
  const el = document.getElementById('tenant-credits-n');
  if (!el) return;
  const n = parseInt(el.textContent, 10);
  if (!isNaN(n) && n > 0) el.textContent = n - 1;
}
