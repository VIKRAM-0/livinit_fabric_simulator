// Global key handlers + bootstrap: load three.js addons, init, preload
// ES-module entry: import side-effect + shim modules in dependency order,
// assemble the window.* shim, THEN run the bootstrap below. Inline onclick=
// handlers and cross-feature calls resolve off window.
import '../components/ui/panels.js';   // side-effect: injects slider/applied markup
import { E, markDirty, showToast, _gltfSceneCache, roomFurnitureModels } from '../lib/engine.js';
import { appStore } from '../lib/store.js';
import { CHAIR_GLB, ACCENT_CHAIR_GLB, SOFA_GLB } from '../lib/catalog.js';
import * as configurator from '../features/configurator/index.js';
import * as library from '../features/library/index.js';
import * as room from '../features/room/index.js';
import * as render from '../features/render/index.js';
import * as finder from '../features/finder/index.js';
import '../features/tour/tour.js';      // self-wires window._tour*

// Inline onclick= handlers + cross-feature window.* calls resolve here.
Object.assign(window, configurator, library, room, render, finder,
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

document.addEventListener('keydown', e => {
  if (e.key==='Escape') window.closeFabricFinder();
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

window.loadScripts([
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/environments/RoomEnvironment.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js',
]).then(()=>{
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
  window.loadModel(CHAIR_GLB);
  window.updateProductInfo();
  // Pull the shared per-product locked viewpoints from S3 and apply to whatever
  // is showing. Owner sets these via the lock icon (admin); everyone else just
  // inherits the framed pose + zoom-in floor.
  window.loadLockedViewpoints?.();

  // Background preload — furniture models cached so every tab switch is instant
  [
    { url: ACCENT_CHAIR_GLB, roomKey: 'accent_chair' },
    { url: SOFA_GLB,         roomKey: 'sofa' },
  ].forEach(({ url, roomKey }) => {
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
