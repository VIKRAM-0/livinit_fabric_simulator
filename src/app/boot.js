// Global key handlers + bootstrap: load three.js addons, init, preload
// ES-module entry: import side-effect + shim modules in dependency order,
// assemble the window.* shim, THEN run the bootstrap below. Inline onclick=
// handlers and cross-feature calls resolve off window.
import '../components/ui/panels.js';   // side-effect: injects slider/applied markup
import { E, markDirty, showToast, _gltfSceneCache, roomFurnitureModels } from '../lib/engine.js';
import { appStore } from '../lib/store.js';
import { CHAIR_GLB, ACCENT_CHAIR_GLB, SOFA_GLB, getGLBUrl } from '../lib/catalog.js';
import { getSession, initAuthUI, showAuthGate, hideGate, showDraftGate, showAuthNetError, signOut, watchForSignOut } from '../lib/auth.js';
import { showWorkspaceSetup } from '../features/onboarding/workspace-setup.js';
import { loadTenantCatalog, applyTenantToUI, spendRenderCredit } from '../lib/tenant.js';
import { createHistory } from '../lib/history.js';
import { captureDesignState, applyDesignState, fingerprintDesignState, defaultDesignState } from '../lib/design-state-live.js';
import * as configurator from '../features/configurator/index.js';
import * as library from '../features/library/index.js';
import * as room from '../features/room/index.js';
import * as render from '../features/render/index.js';
import * as finder from '../features/finder/index.js';
import * as saved from '../features/saved/index.js';
import '../features/tour/tour.js';      // self-wires window._tour*
import { initSavedStore } from '../features/saved/saved-panel.js';
import { migrateLocalDesigns } from '../features/saved/migrate-local-designs.js';

// Inline onclick= handlers + cross-feature window.* calls resolve here.
Object.assign(window, configurator, library, room, render, finder, saved,
  { showPanelTab, toggleSidebar, focusProductPicker });

// Non-function globals that inline onclick= handlers reference in GLOBAL scope
// (module bindings are invisible to inline handlers, so they must be shimmed):
//   - appStore: nav-rail Product/Room items call appStore.getState().roomMode
//   - sph:      the zoom-in control mutates sph.r
// appStore is a stable singleton (direct assign). E.sph is REASSIGNED across
// room/render/model, so alias it via a live getter — a one-time `window.sph =
// E.sph` would go stale after the first rebind and silently break zoom.
window.appStore = appStore;
Object.defineProperty(window, 'sph', { get: () => E.sph, configurable: true });

// ── Design history (undo/redo/reset — spec §3.3, §5) ─────────────────────
const designHistory = createHistory({
  capture: captureDesignState,
  apply: (s) => applyDesignState(s, { silent: true, fast: true }),
  fingerprint: fingerprintDesignState,
  onChange: (h) => {
    const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
    if (u) u.disabled = h.busy || !h.canUndo();
    if (r) r.disabled = h.busy || !h.canRedo();
  },
});
window._historyRecord = () => { if (!window.__replayingDesign) designHistory.record(); };
window._historyClear = () => designHistory.clear();
window._historySeed = () => designHistory.seed();
window._historyOnModelReady = () => designHistory.seed();
window.undoDesign = () => designHistory.undo();
window.redoDesign = () => designHistory.redo();
window.resetDesign = async () => {
  const names = [...new Set(E.meshEntries.filter(e => !e._isCurtain).map(e => e.name))];
  await applyDesignState(defaultDesignState(appStore.getState().currentModelKey, names), { silent: true });
  window._historyRecord();
  showToast('Design reset');
};

// Slider commits: 'change' fires on release — drags coalesce to one record.
// s-env-brightness is scene lighting, not part of DesignState — exclude it
// explicitly rather than leaning on fingerprint dedupe.
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type === 'range' && t.id !== 's-env-brightness') window._historyRecord();
});

document.addEventListener('keydown', e => {
  if (e.key==='Escape') window.closeFabricFinder();
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); window.undoDesign(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); window.redoDesign(); }
});

// Dismiss the Settings popover on any click outside it. The gear button keeps
// its own toggle (excluded here so opening it doesn't immediately re-close);
// clicks INSIDE the popover (sliders, Lock/Unlock, snippet) are ignored.
document.addEventListener('click', e => {
  const pop = document.getElementById('settings-popover');
  if (!pop || pop.style.display === 'none') return;
  if (pop.contains(e.target) || e.target.closest('#nav-settings')) return;
  pop.style.display = 'none';
});

// App bootstrap — runs only after a session exists and the tenant catalog is
// applied (multi-tenant gate at the bottom of this file). `allowed` is the
// tenant's product-key list; the initial load + preload respect it.
function startApp(allowed, scriptsReady){
scriptsReady.then(()=>{
  window.initThree();

  // Init TransformControls for furniture move mode
  if (THREE.TransformControls) {
    E.transformControls = new THREE.TransformControls(E.camera, E.renderer.domElement);
    E.transformControls.visible = false;
    E.transformControls.setMode('translate');
    E.transformControls.setTranslationSnap(null);
    E.transformControls.setRotationSnap(null);
    E.scene.add(E.transformControls);

    // Constrain translation to XZ plane (floor plane only)
    E.transformControls.addEventListener('objectChange', () => {
      if (E.tcMode === 'translate') {
        const model = roomFurnitureModels[appStore.getState().currentModelKey];
        if (model) {
          // Keep Y pinned to floor (furniture shouldn't float)
          const box = new THREE.Box3().setFromObject(model);
          const floorOffset = box.min.y;
          model.position.y += (window.roomFloorY - floorOffset);
          model.updateMatrixWorld(true);
        }
      }
      markDirty();
    });

    E.transformControls.addEventListener('mouseUp', () => { markDirty(); });
  }

  window.initDragDrop();
  window.buildLibrary();
  // First model = the tenant's first allowed product (falls back to chair).
  window.loadModel(getGLBUrl(allowed[0]) || CHAIR_GLB);
  window.updateProductInfo();
  // Pull the shared per-product locked viewpoints from S3 and apply to whatever
  // is showing. Owner sets these via the lock icon (admin); everyone else just
  // inherits the framed pose + zoom-in floor.
  window.loadLockedViewpoints?.();

  // Background preload — only the tenant's own models, cached so every tab
  // switch is instant. Other tenants' products are never fetched.
  // Defer until the FIRST model is on screen — these are 7-9 MB each and were
  // competing with the visible model for bandwidth. model.js fires
  // _onModelReady once, after processGLTF completes, then nulls it.
  window._onModelReady = () => [
    { url: ACCENT_CHAIR_GLB, roomKey: 'accent_chair' },
    { url: SOFA_GLB,         roomKey: 'sofa' },
  ].filter(({ roomKey }) => allowed.includes(roomKey)).forEach(({ url, roomKey }) => {
    E.gltfLoader.load(url, gltf => {
      if (!_gltfSceneCache[url]) _gltfSceneCache[url] = gltf.scene;
      if (roomKey && !roomFurnitureModels[roomKey]) {
        const m = gltf.scene.clone(true);
        const b = new THREE.Box3().setFromObject(m);
        const sz = b.getSize(new THREE.Vector3());
        m.scale.setScalar(1.6 / Math.max(sz.x, sz.y, sz.z));
        m.updateMatrixWorld(true);
        roomFurnitureModels[roomKey] = m;
      }
    }, undefined, () => { /* silent fail — user can still load on demand */ });
  });
}).catch(e=>{console.error('Script load failed',e);showToast('Failed to load Three.js loaders');});
}

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
  document.getElementById('tenant-signin')?.addEventListener('click', e => { e.stopPropagation(); showAuthGate(); });
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
    showAuthNetError(() => location.reload());
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

  if (session.source === 'real' && !result.businessGoal) {
    if (result.role !== 'client_admin') {
      showDraftGate(result);
      return;
    }
    showWorkspaceSetup(result, (updatedTenant) => bootWithSession(session, updatedTenant));
    return;
  }

  const store = initSavedStore(session);
  if (session.source === 'real') {
    // Fire-and-forget: a failed migration retries next login; never blocks boot.
    migrateLocalDesigns(session.user.email, store).then(({ migrated, limitHit }) => {
      if (migrated) showToast(migrated + ' design' + (migrated > 1 ? 's' : '') + ' synced to your account');
      if (limitHit) showToast('Design limit reached — some local designs were not synced');
    }).catch(() => {});
  }

  hideGate();
  await bootWithSession(session, result);
}

main();

// Narrow-window sidebar drawer toggle (floating "Fabrics" pill; no-op >=1024px)
function toggleSidebar(){ document.getElementById('right-panel')?.classList.toggle('open'); }

// Products nav-rail item. For now a shortcut: leave room mode (so the design
// flow is showing — toggleRoomView also fixes the nav active state), then reveal
// and briefly pulse the Chair/Accent Chair/Sofa picker. When the catalog grows,
// replace this with a dedicated Products gallery panel (see nav-products comment
// in index.html).
function focusProductPicker(){
  if (appStore.getState().roomMode) window.toggleRoomView();
  window.showPanelTab('parts');
  const el = document.getElementById('panel-product');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('panel-pulse'); void el.offsetWidth; // restart animation
    el.classList.add('panel-pulse');
    setTimeout(() => el.classList.remove('panel-pulse'), 1400);
  }
}

// Guided single flow: the panel shows either the DESIGN bodies (product+part and
// fabric, stacked and ordered via CSS) or the ROOM staging body. room.js calls
// showPanelTab('room') on entering room mode and showPanelTab('fabrics') on exit;
// 'fabrics'/'parts'/anything-not-'room' all mean "show the design flow".
let activePanelTab = 'design';
function showPanelTab(name){
  const roomMode = name === 'room';
  activePanelTab = roomMode ? 'room' : 'design';
  document.querySelectorAll('.panel-tab-body').forEach(b => {
    const t = b.dataset.tab;
    b.classList.toggle('on', roomMode ? t === 'room' : (t === 'parts' || t === 'fabrics'));
  });
  // The pinned Applied card is fabric-editing context — hide it in room staging.
  document.getElementById('applied-card')?.classList.toggle('hidden', roomMode);
}
window.showPanelTab = showPanelTab;
