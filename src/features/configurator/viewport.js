import { E, markDirty, showToast, roomFurnitureModels, raycaster, mouse } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { getHitEntry, entryGroup } from './materials.js';
import { groupEntriesByName } from './model.js';
// Product info, zone overlay, Three.js init, script loader, GLB upload
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── Product info updater ────────────────────────────────────────────────────
export function updateProductInfo() {
  const MODELS = {
    chair:        { name: 'Chair',        dims: 'Exposed-frame armchair' },
    accent_chair: { name: 'Accent Chair', dims: 'Upholstered wingback chair' },
    sofa:         { name: 'Sofa',         dims: 'Upholstered sofa' },
  };
  const info = MODELS[appStore.getState().currentModelKey] || MODELS.chair;
  const nameEl = document.getElementById('cp-product-name');
  const dimsEl = document.getElementById('cp-product-dims');
  if(nameEl) nameEl.textContent = info.name;
  if(dimsEl) dimsEl.textContent = info.dims;
  const ctxEl = document.getElementById('context-model');
  if(ctxEl) ctxEl.textContent = info.name;
}

export function _updateZoneCountBadge() {
  const el = document.getElementById('zone-count-badge');
  if(el) el.textContent = E.meshEntries.length + ' configurable zone' + (E.meshEntries.length !== 1 ? 's' : '');
}

// ── Scene lighting (environment) — separate from the per-fabric "Brightness"
// slider, which only scales the applied material's own color. This scales
// the renderer's overall exposure, i.e. every light + the IBL environment
// map uniformly, without touching any material.
export function toggleSettingsPanel() {
  const el = document.getElementById('settings-popover');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
export function updateEnvBrightness(val) {
  if (E.renderer) E.renderer.toneMappingExposure = +val;
  const v = document.getElementById('v-env-brightness');
  if (v) v.textContent = (+val).toFixed(2);
  markDirty();
}

// ── Zone overlay (floating labels on viewport) ──────────────────────────────
let _zoneLabelsReady = false;

// One floating label per real PART (grouped by name — a mesh split across
// many material slots, e.g. chair.glb's Frame, gets one label, not one per
// slot). label.dataset.eid is the group's first entry's id, used only as a
// stable key to look the group back up.
export function rebuildZoneOverlay() {
  const overlay = document.getElementById('zone-overlay');
  if(!overlay) return;
  overlay.innerHTML = '';
  _zoneLabelsReady = false;
  if(!E.meshEntries.length) { _updateZoneCountBadge(); return; }

  groupEntriesByName(E.meshEntries).forEach(group => {
    const rep = group[0];
    const label = document.createElement('div');
    label.className = 'zone-label';
    label.dataset.eid = rep.id;
    label.textContent = rep.name;
    label.title = 'Click to select ' + rep.name;
    label.onclick = () => _zoneClick(rep.id);
    overlay.appendChild(label);
  });

  _zoneLabelsReady = true;
  _updateZoneCountBadge();
  markDirty();
}

export function _zoneClick(entryId) {
  const target = E.meshEntries.find(e => e.id === entryId);
  if(!target) return;
  const group = entryGroup(target);
  const wasSoleSelected = target.checked && E.meshEntries.filter(e => e.checked).length === group.length
    && group.every(e => e.checked);
  // Deselect all — leave mesh.material untouched so applied fabrics stay visible
  E.meshEntries.forEach(entry => { entry.checked = false; });
  if(!wasSoleSelected) {
    // Select just this part (its whole name-group)
    group.forEach(en => {
      en.checked = true;
      const matArr = Array.isArray(en.mesh.material)?[...en.mesh.material]:[en.mesh.material];
      if(en.matIndex>=0&&en.matIndex<matArr.length){matArr[en.matIndex]=en.greyMat;en.mesh.material=matArr;}
    });
    // Flash
    group.forEach(en => { en.greyMat.emissive=new THREE.Color(0x666600);en.greyMat.emissiveIntensity=0.3;en.greyMat.needsUpdate=true; });
    setTimeout(()=>{ group.forEach(en => { en.greyMat.emissive=new THREE.Color(0);en.greyMat.emissiveIntensity=0;en.greyMat.needsUpdate=true; }); markDirty(); },600);
  }
  window.buildMeshList();
  markDirty();
  _refreshZoneLabelStates();
}

export function _refreshZoneLabelStates() {
  document.querySelectorAll('#zone-overlay .zone-label').forEach(l => {
    const entry = E.meshEntries.find(e => e.id === l.dataset.eid);
    l.classList.toggle('active', !!(entry && entry.checked));
  });
}

export function updateZoneLabelPositions() {
  if(!_zoneLabelsReady || !E.camera || !E.renderer) return;
  const overlay = document.getElementById('zone-overlay');
  if(!overlay || overlay.style.display === 'none') return;
  const canvas = document.getElementById('viewer');
  if(!canvas) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if(W === 0 || H === 0) return;

  groupEntriesByName(E.meshEntries).forEach((group) => {
    const entry = group[0];
    const label = overlay.querySelector(`.zone-label[data-eid="${entry.id}"]`);
    if(!label) return;
    try {
      const box = new THREE.Box3().setFromObject(entry.mesh);
      const center = box.getCenter(new THREE.Vector3());
      const projected = center.clone().project(E.camera);
      if(projected.z >= 1) { label.style.opacity = '0'; return; }

      const sx = (projected.x * 0.5 + 0.5) * W;
      const sy = (-projected.y * 0.5 + 0.5) * H;

      // Push label outward from viewport center
      const cx = W * 0.5, cy = H * 0.45;
      let dx = sx - cx, dy = sy - cy;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      dx /= len; dy /= len;
      let lx = sx + dx * 85;
      let ly = sy + dy * 70;

      // Clamp within viewport with padding
      const lw = 120, lh = 28;
      lx = Math.max(lw/2 + 8, Math.min(W - lw/2 - 8, lx));
      ly = Math.max(lh/2 + 8, Math.min(H - lh/2 - 44, ly));

      label.style.left = (lx - lw/2) + 'px';
      label.style.top  = (ly - lh/2) + 'px';
      label.style.opacity = '1';
    } catch(e) {
      label.style.opacity = '0';
    }
  });
}


// ── Three.js Init ─────────────────────────────────────────────────────────
export function camUpdate() {
  E.camera.position.set(
    E.tgt.x + E.sph.r*Math.sin(E.sph.phi)*Math.sin(E.sph.theta),
    E.tgt.y + E.sph.r*Math.cos(E.sph.phi),
    E.tgt.z + E.sph.r*Math.sin(E.sph.phi)*Math.cos(E.sph.theta)
  );
  E.camera.lookAt(E.tgt);
  markDirty();
}

// ── 360° turntable spin ──────────────────────────────────────────────────
// Rotates the model itself (not the camera) a full right-to-left turn at
// constant speed over SPIN_DURATION ms. A full 2π turn lands exactly back on
// the starting orientation, so there's nothing to restore afterward — safe
// to call in room mode too (doesn't touch room-slot positioning).
const SPIN_DURATION = 5000;
export function spinModel360() {
  if (!E.currentModel || E._spinAnim) return;
  const btn = document.getElementById('btn-spin-360');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  const startRotY = E.currentModel.rotation.y;
  const startTime = performance.now();
  const direction = -1; // right-to-left
  function tick(now) {
    const t = Math.min((now - startTime) / SPIN_DURATION, 1);
    E.currentModel.rotation.y = startRotY + direction * Math.PI * 2 * t;
    E.currentModel.updateMatrixWorld(true);
    markDirty();
    if (t < 1) {
      E._spinAnim = requestAnimationFrame(tick);
    } else {
      E.currentModel.rotation.y = startRotY;
      E.currentModel.updateMatrixWorld(true);
      E._spinAnim = null;
      markDirty();
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  }
  E._spinAnim = requestAnimationFrame(tick);
}

export function initThree() {
  const canvas = document.getElementById('viewer');
  E.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,preserveDrawingBuffer:true});
  E.renderer.setPixelRatio(window.devicePixelRatio);
  E.renderer.outputEncoding=THREE.sRGBEncoding;
  E.renderer.physicallyCorrectLights=true;
  E.renderer.toneMapping=THREE.ACESFilmicToneMapping;
  E.renderer.toneMappingExposure=1.0;
  E.renderer.shadowMap.enabled=true;

  E.scene=new THREE.Scene();
  E.camera=new THREE.PerspectiveCamera(42,1,0.01,1000);

  E.pmremGen=new THREE.PMREMGenerator(E.renderer);
  E.pmremGen.compileEquirectangularShader();
  E.scene.environment=E.pmremGen.fromScene(new THREE.RoomEnvironment(),1.0).texture;

  // Flat fill light is kept low on purpose. Ambient and hemisphere add
  // achromatic light to every surface, which washes a fabric's own colour out —
  // the effect that made pale swatches like Parlour "Seabreeze" render far
  // lighter than the swatch beside them. Measured on that fabric, dropping
  // ambient 0.3 -> 0.10 and hemisphere 0.6 -> 0.30 pulled the cushion from
  // +6.4pp luminance over the swatch down to +2.9pp, while the white frame only
  // went 88% -> 85% so the piece still reads bright and airy.
  // Raising roughness and removing sheen were also tried and moved the result
  // by under 0.3pp, so the fill light is the lever that matters here.
  const amb=new THREE.AmbientLight(0xffffff,0.10);
  const dir=new THREE.DirectionalLight(0xfff8f0,1.8);
  dir.position.set(3,5,4);
  const hemi=new THREE.HemisphereLight(0xfff8f0,0x8090a0,0.30);
  const fill=new THREE.DirectionalLight(0xd0e8ff,0.8);
  fill.position.set(-3,3,-4);
  E.scene.add(amb,dir,hemi,fill);

  camUpdate();

  let isDrag=false,isRight=false,prev={x:0,y:0};
  // ── Floor-plane drag for move mode ──────────────────────────────────────
  let floorDragging=false;
  const _floorPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0); // updated at drag-start
  const _floorHit=new THREE.Vector3();
  const _floorOffset=new THREE.Vector3(); // offset from model centre to hit point

  canvas.addEventListener('mousedown',e=>{
    if(E.dragActive) return;
    if(E.furnitureMoveMode && e.button===0) {
      // Custom floor-drag: check if we hit the active furniture model
      const rect=canvas.getBoundingClientRect();
      const ndc=window.screenToNDC(e,rect);
      mouse.set(ndc.x,ndc.y);
      raycaster.setFromCamera(mouse,E.camera);
      const model=roomFurnitureModels[appStore.getState().currentModelKey];
      if(model){
        const hits=raycaster.intersectObject(model,true);
        if(hits.length){
          // Pin floor plane at detected floor Y
          _floorPlane.constant=-window.roomFloorY;
          raycaster.ray.intersectPlane(_floorPlane,_floorHit);
          _floorOffset.set(model.position.x-_floorHit.x,0,model.position.z-_floorHit.z);
          floorDragging=true;
          e.stopPropagation();
          return;
        }
      }
      return; // click in move mode on non-furniture — don't orbit
    }
    isDrag=true; isRight=e.button===2; prev={x:e.clientX,y:e.clientY};
  });

  window.addEventListener('mousemove',e=>{
    if(floorDragging){
      const rect=canvas.getBoundingClientRect();
      const ndc=window.screenToNDC(e,rect);
      mouse.set(ndc.x,ndc.y);
      raycaster.setFromCamera(mouse,E.camera);
      if(raycaster.ray.intersectPlane(_floorPlane,_floorHit)){
        const model=roomFurnitureModels[appStore.getState().currentModelKey];
        if(model){
          model.position.x=_floorHit.x+_floorOffset.x;
          model.position.z=_floorHit.z+_floorOffset.z;
          // Keep Y pinned
          const box=new THREE.Box3().setFromObject(model);
          model.position.y+=window.roomFloorY-box.min.y;
          model.updateMatrixWorld(true);
          markDirty();
        }
      }
      return;
    }
    if(!isDrag) return;
    const dx=e.clientX-prev.x,dy=e.clientY-prev.y;
    prev={x:e.clientX,y:e.clientY};
    if(isRight){
      const spd=0.002*E.sph.r;
      const right=new THREE.Vector3().crossVectors(E.camera.getWorldDirection(new THREE.Vector3()),E.camera.up).normalize();
      E.tgt.addScaledVector(right,-dx*spd); E.tgt.addScaledVector(E.camera.up,dy*spd);
    } else {
      E.sph.theta-=dx*0.007;
      E.sph.phi=Math.max(0.1,Math.min(Math.PI-0.1,E.sph.phi-dy*0.007));
    }
    camUpdate();
  });
  window.addEventListener('mouseup',()=>{ isDrag=false; floorDragging=false; });

  // Double-click on furniture to enter/exit move mode
  canvas.addEventListener('dblclick', e => {
    if (!appStore.getState().roomMode) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = window.screenToNDC(e, rect);
    mouse.set(ndc.x, ndc.y);
    raycaster.setFromCamera(mouse, E.camera);

    if (E.furnitureMoveMode) {
      // Second double-click anywhere exits move mode
      E.furnitureMoveMode = false;
      if (E.transformControls) { E.transformControls.detach(); E.transformControls.visible = false; }
      const bar = document.getElementById('move-mode-bar');
      if (bar) bar.classList.remove('active');
      const hud = document.getElementById('move-hud');
      if (hud) hud.classList.remove('active');
      floorDragging = false;
      markDirty();
      return;
    }

    // Single active piece in Room View — only E.currentModel is ever present.
    const furnitureModels = E.currentModel ? [E.currentModel] : [];
    const hits = raycaster.intersectObjects(furnitureModels, true);
    if (!hits.length) return;

    // Walk up to find the root furniture model
    let hitObj = hits[0].object;
    let hitRoot = null;
    while (hitObj) {
      if (furnitureModels.includes(hitObj)) { hitRoot = hitObj; break; }
      hitObj = hitObj.parent;
    }
    if (!hitRoot) return;

    const hitKey = Object.keys(roomFurnitureModels).find(k => roomFurnitureModels[k] === hitRoot);
    if (!hitKey) return;

    // Switch to the hit furniture if it's not already active
    if (hitKey !== appStore.getState().currentModelKey) window.switchModel(hitKey);

    // Enter move mode — use custom HUD, no TC gizmo
    E.furnitureMoveMode = true;
    const bar = document.getElementById('move-mode-bar');
    if (bar) bar.classList.add('active');
    const hud = document.getElementById('move-hud');
    if (hud) hud.classList.add('active');
    if (E.transformControls) { E.transformControls.detach(); E.transformControls.visible = false; }
    markDirty();
  });

  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('wheel',e=>{E.sph.r=Math.max(0.3,Math.min(30,E.sph.r+e.deltaY*0.004));camUpdate();e.preventDefault();},{passive:false});

  // ── Hover-to-zoom fabric preview ─────────────────────────────────────────
  // Dwell on a part for HOVER_ZOOM_DELAY ms → show a magnified lens of the
  // fabric texture actually applied to that mesh, read live off the mesh's
  // current material so it's always correct after model switches/room entry.
  const HOVER_ZOOM_DELAY = 500;
  let hoverEntry = null, hoverTimer = null, lensShownFor = null;

  function hideHoverLens() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    lensShownFor = null;
    const lens = document.getElementById('hover-zoom-lens');
    if (lens) lens.classList.remove('show');
  }

  function setHoverCursor(on) {
    canvas.style.cursor = on ? 'zoom-in' : '';
  }

  function positionHoverLens(x, y) {
    const lens = document.getElementById('hover-zoom-lens');
    if (!lens) return;
    const LW = 220, LH = 218, PAD = 20;
    let lx = x + PAD, ly = y + PAD;
    if (lx + LW > window.innerWidth)  lx = x - LW - PAD;
    if (ly + LH > window.innerHeight) ly = y - LH - PAD;
    lx = Math.max(8, lx); ly = Math.max(8, ly);
    lens.style.left = lx + 'px';
    lens.style.top  = ly + 'px';
  }

  function showHoverLens(entry) {
    let lens = document.getElementById('hover-zoom-lens');
    if (!lens) {
      lens = document.createElement('div');
      lens.id = 'hover-zoom-lens';
      // Real <img> + object-fit:cover (not a background-size percentage trick) —
      // that previous approach stretched non-square source images unevenly,
      // which read as "messy"/warped once magnified. This preserves the
      // source's aspect ratio; the zoom comes from a CSS transform on top.
      lens.innerHTML = '<div class="hzl-viewport"><img class="hzl-img" alt=""></div><div class="hzl-label"></div>';
      document.body.appendChild(lens);
    }
    const matArr = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
    const mat = matArr[entry.matIndex >= 0 ? entry.matIndex : 0] || matArr[0];
    const viewport = lens.querySelector('.hzl-viewport');
    const img = lens.querySelector('.hzl-img');
    const label = lens.querySelector('.hzl-label');
    const texImg = mat && mat.map && mat.map.image;
    const srcUrl = texImg && (texImg.currentSrc || texImg.src);
    if (srcUrl) {
      img.src = srcUrl;
      img.style.display = 'block';
      viewport.style.background = '';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      viewport.style.background = (mat && mat.color) ? '#' + mat.color.getHexString() : '#ccc';
    }
    const fabricName = entry.mesh.userData && entry.mesh.userData._fabricName;
    label.textContent = fabricName ? (entry.name + ' — ' + fabricName) : entry.name;
    lens.classList.add('show');
  }

  canvas.addEventListener('mousemove', e => {
    if (isDrag || floorDragging || E.dragActive || E.furnitureMoveMode) { hideHoverLens(); setHoverCursor(false); hoverEntry = null; return; }
    const rect = canvas.getBoundingClientRect();
    const entry = getHitEntry(e, rect);

    if (!entry) {
      if (hoverEntry) { hoverEntry = null; hideHoverLens(); setHoverCursor(false); }
      return;
    }
    setHoverCursor(true);
    if (entry !== hoverEntry) {
      hoverEntry = entry;
      hideHoverLens();
      hoverTimer = setTimeout(() => {
        if (hoverEntry === entry) {
          showHoverLens(entry);
          lensShownFor = entry;
          positionHoverLens(e.clientX, e.clientY);
        }
      }, HOVER_ZOOM_DELAY);
    } else if (lensShownFor === entry) {
      positionHoverLens(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('mouseleave', () => { hoverEntry = null; hideHoverLens(); setHoverCursor(false); });
  canvas.addEventListener('mousedown', () => { hideHoverLens(); setHoverCursor(false); });
  canvas.addEventListener('wheel', hideHoverLens, {passive:true});

  const ro=new ResizeObserver(()=>{
    const w=canvas.clientWidth,h=canvas.clientHeight;
    E.renderer.setSize(w,h,false);
    E.camera.aspect=w/h; E.camera.updateProjectionMatrix(); markDirty();
  });
  ro.observe(canvas);

  (function loop(){
    requestAnimationFrame(loop);
    if(!E._dirty)return;
    E._dirty=false;
    E.renderer.render(E.scene,E.camera);
    updateZoneLabelPositions();
  })();

  const dracoLoader=new THREE.DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  E.gltfLoader=new THREE.GLTFLoader();
  E.gltfLoader.setDRACOLoader(dracoLoader);
}

export function loadScripts(urls){
  // All four extras (DRACOLoader, GLTFLoader, RoomEnvironment, TransformControls)
  // only need THREE which is already synchronously loaded — fetch them in parallel.
  return Promise.all(urls.map(url=>new Promise((res,rej)=>{
    const s=document.createElement('script');s.src=url;s.onload=res;s.onerror=rej;document.head.appendChild(s);
  })));
}

// ── GLB Upload ────────────────────────────────────────────────────────────
export function handleGLBUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext !== 'glb' && ext !== 'gltf') { showToast('Please select a .glb or .gltf file'); return; }
  if (window._customGLBUrl) URL.revokeObjectURL(window._customGLBUrl);
  window._customGLBUrl = URL.createObjectURL(file);
  const label = file.name.replace(/\.(glb|gltf)$/i, '');
  showToast('Loading ' + label + '…');
  window.loadModel(window._customGLBUrl);
  // Tag active tab with "Custom"
  ['tab-chair','tab-sofa'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.querySelectorAll('.custom-model-tag').forEach(t => t.remove());
  });
  const activeTab = document.getElementById('tab-' + appStore.getState().currentModelKey);
  if (activeTab) {
    const tag = document.createElement('span');
    tag.className = 'custom-model-tag';
    tag.textContent = 'Custom';
    activeTab.appendChild(tag);
  }
  input.value = '';
}

