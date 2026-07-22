import { E, markDirty, showToast, saveMaterialSnapshot, setSliderVal, _gltfSceneCache, roomFurnitureModels, FABRIC_ENV_INTENSITY } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { setActiveFabric, setModelKey } from '../../lib/actions.js';
import { getGLBUrl } from '../../lib/catalog.js';
import { spinModel360 } from './viewport.js';

// ── Fabric tiling scale ───────────────────────────────────────────────────
// How many metres of surface one UV unit spans, measured from the geometry:
// sqrt(world area / UV area). This is what fabric tiling must key off.
//
// The GLBs were unwrapped with Blender's average_islands_scale(), so texel
// density is already uniform across every mesh of a product (verified: sofa
// 578,593 px/m² on all four meshes, accent chair 262,598 on all three). The
// previous approach derived tiling from each mesh's BOUNDING BOX instead,
// which threw that normalization away — and because three.js splits a glTF
// mesh into one Mesh per primitive, a single continuous part came out with
// several different pattern scales. The chair frame is one mesh (root.9) that
// arrives as 9 primitives whose bounding boxes span 0.65–1.60, so the same
// fabric tiled 2.4x differently across one frame; the sofa spanned 6.2x.
// Measuring UV density instead makes the pattern exactly BASE_TILE / scale
// metres everywhere — per primitive, per part, and across all three products.
const UV_SAMPLE_TRIS = 8000;
export function metersPerUvUnit(mesh) {
  const geo = mesh.geometry;
  const pos = geo?.attributes?.position, uv = geo?.attributes?.uv;
  if (!pos || !uv) return null;
  const idx = geo.index;
  const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
  if (triCount < 1) return null;

  // Sample rather than walk every triangle — the chair frame alone is 662k
  // faces, and a few thousand triangles pin the ratio down well past the
  // precision this needs.
  const step = Math.max(1, Math.floor(triCount / UV_SAMPLE_TRIS));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const densities = [];

  for (let t = 0; t < triCount; t += step) {
    const i0 = idx ? idx.getX(t*3)   : t*3;
    const i1 = idx ? idx.getX(t*3+1) : t*3+1;
    const i2 = idx ? idx.getX(t*3+2) : t*3+2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const gA = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5;
    const u0=uv.getX(i0), v0=uv.getY(i0);
    const u1=uv.getX(i1), v1=uv.getY(i1);
    const u2=uv.getX(i2), v2=uv.getY(i2);
    const uA = Math.abs((u1-u0)*(v2-v0) - (u2-u0)*(v1-v0)) * 0.5;
    if (gA > 1e-12 && uA > 1e-14) densities.push(Math.sqrt(gA / uA));
  }
  if (!densities.length) return null;

  // MEDIAN per-triangle density, not the total-area ratio.
  //
  // A whole-mesh ratio is only right when density is uniform, and the
  // hidden-seam unwrap breaks that: on the accent chair's seat cushion the
  // never-seen underside collapsed to 73.5 metres per UV unit against ~8.4 on
  // the visible faces, dragging the mesh average to 10.6 and tiling the visible
  // pattern ~26% too densely — while the frame and legs sat at 8.74. The user
  // sees a cushion whose pattern does not match the rest of the piece.
  //
  // The median ignores a compressed minority regardless of which direction it
  // faces, so it needs no assumption about which side is hidden. It does assume
  // the visible surface is the majority of triangles, which holds here (the
  // collapsed undersides are 35-42% of their meshes).
  densities.sort((x, y) => x - y);
  const mid = densities.length >> 1;
  const median = densities.length % 2
    ? densities[mid]
    : (densities[mid - 1] + densities[mid]) / 2;

  // densities are in the geometry's own units — scale into world metres.
  const s = mesh.getWorldScale(new THREE.Vector3());
  const uniformScale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
  return median * uniformScale;
}

// Mesh/piece lists, GLB processing, load/switch/reset model
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── Auto-spin-once ────────────────────────────────────────────────────────
// Each product (chair/accent_chair/sofa) plays one 360° reveal spin
// the first time it becomes the active model in PRODUCT view this session.
// Product view only — Room View shows the whole staged room, not one focused
// piece, so it never auto-spins there (see the sole call site in processGLTF,
// which only runs outside room mode) and the Spin 360° button itself is
// hidden while in room mode (toggleRoomView, room.js). After the one-time
// auto-spin, spinning only happens via that button.
// On a first-time visit the onboarding tour's welcome screen sits over the
// canvas (z-index 700, 82%-opaque scrim) for as long as the user takes to
// read it — if the spin plays underneath that, it finishes unseen and never
// replays (it's one-time). Defer to _tourSkip (tour.js) via
// window._pendingAutoSpins when the tour is still showing; fire immediately
// otherwise (returning visitors, or the tour's already been dismissed).
const _autoSpunModels = new Set();
function _maybeAutoSpin(modelKey) {
  if (_autoSpunModels.has(modelKey)) return;
  _autoSpunModels.add(modelKey);
  const tourOv = document.getElementById('tour-ov');
  const tourActive = tourOv && tourOv.classList.contains('on') && tourOv.style.display !== 'none';
  if (tourActive) {
    (window._pendingAutoSpins = window._pendingAutoSpins || []).push(spinModel360);
  } else {
    spinModel360();
  }
}
// ── Mesh list ─────────────────────────────────────────────────────────────
export const dotColors = ['#c84040','#c87840','#c8c840','#40c870','#4070c8','#8040c8','#c84080','#408080'];

// Some meshes (e.g. chair.glb's Frame) export as ONE physical part split across
// many material slots — each slot becomes its own meshEntry with an identical
// classifyMesh() name. Group by name so the UI presents ONE checkbox per real
// part; checking it applies to every slot together (checking only some slots
// left the rest at neutral grey, reading as fabric "patches" on an otherwise
// bare frame — the actual part is one continuous surface).
export function groupEntriesByName(entries) {
  const order = [], byName = new Map();
  entries.forEach(e => {
    if (!byName.has(e.name)) { byName.set(e.name, []); order.push(e.name); }
    byName.get(e.name).push(e);
  });
  return order.map(name => byName.get(name));
}

export function buildMeshList() {
  const list = document.getElementById('mesh-list');
  list.innerHTML = '';
  if(!E.meshEntries.length) { list.innerHTML='<div style="font-size:11px;color:var(--text-muted)">No parts found</div>'; return; }
  const groups = groupEntriesByName(E.meshEntries);
  groups.forEach((group,i) => {
    const dot = dotColors[i%dotColors.length];
    const allChecked = group.every(e=>e.checked);
    const row = document.createElement('label');
    row.className = 'mesh-item'+(allChecked?' sel':'');
    row.dataset.zone = group[0].name;   // render gate flashes missing zones by name
    const cb = document.createElement('input');
    cb.type='checkbox'; cb.checked=allChecked;
    cb.addEventListener('change',()=>{ toggleCheckGroup(group, cb.checked); window._refreshZoneLabelStates(); });
    const dotEl = document.createElement('div');
    dotEl.className='mesh-dot'; dotEl.style.backgroundColor=dot;
    const txt = document.createElement('span');
    txt.textContent = group[0].name;
    row.addEventListener('mouseenter',()=>{ group.forEach(entry=>{entry.greyMat.emissive=new THREE.Color(0x444400);entry.greyMat.emissiveIntensity=0.25;entry.greyMat.needsUpdate=true;}); markDirty(); });
    row.addEventListener('mouseleave',()=>{ group.forEach(entry=>{entry.greyMat.emissive=new THREE.Color(0);entry.greyMat.emissiveIntensity=0;entry.greyMat.needsUpdate=true;}); markDirty(); });
    row.appendChild(cb); row.appendChild(dotEl); row.appendChild(txt);
    list.appendChild(row);
  });
  window._refreshZoneLabelStates();
}

export function buildPieceList() {
  const list = document.getElementById('piece-list');
  list.innerHTML = '';
  if(!E.meshEntries.length) { list.innerHTML='<div style="font-size:11px;color:var(--text-muted)">No parts loaded</div>'; return; }

  // Separate curtain entry from furniture entries
  const curtainEntry = E.meshEntries.find(e => e._isCurtain);
  const furnitureGroups = groupEntriesByName(E.meshEntries.filter(e => !e._isCurtain));

  furnitureGroups.forEach((group,i) => {
    const dot = dotColors[i%dotColors.length];
    const allSelected = group.every(e=>e.pieceSelected);
    const row = document.createElement('div');
    row.className='piece-item'+(allSelected?' sel-piece':'');
    row.dataset.zone = group[0].name;   // render gate flashes missing zones by name
    const dotEl=document.createElement('div');
    dotEl.className='piece-dot'; dotEl.style.backgroundColor=dot;
    const txt=document.createElement('span'); txt.className='piece-item-name'; txt.textContent=group[0].name;
    const arrow=document.createElement('span'); arrow.className='piece-item-arrow'; arrow.textContent='›';
    row.appendChild(dotEl); row.appendChild(txt); row.appendChild(arrow);
    row.addEventListener('click',()=>{
      E.meshEntries.forEach(e=>{ e.pieceSelected=false; });
      group.forEach(e=>{ e.pieceSelected = true; });
      buildPieceList();
      window.buildLibrary();
      group.forEach(e=>{ e.greyMat.emissive=new THREE.Color(0x2d4a3e);e.greyMat.emissiveIntensity=0.4;e.greyMat.needsUpdate=true; });
      markDirty();
      setTimeout(()=>{ group.forEach(e=>{ e.greyMat.emissive=new THREE.Color(0);e.greyMat.emissiveIntensity=0;e.greyMat.needsUpdate=true; }); markDirty(); },700);
    });
    row.addEventListener('mouseenter',()=>{ group.forEach(e=>{ e.greyMat.emissive=new THREE.Color(0x444400);e.greyMat.emissiveIntensity=0.2;e.greyMat.needsUpdate=true; }); markDirty(); });
    row.addEventListener('mouseleave',()=>{ if(!allSelected){ group.forEach(e=>{ e.greyMat.emissive=new THREE.Color(0);e.greyMat.emissiveIntensity=0;e.greyMat.needsUpdate=true; }); markDirty(); } });
    list.appendChild(row);
  });

  // Curtain section — prominent dedicated row
  if (curtainEntry) {
    const sep = document.createElement('div');
    sep.style.cssText='margin:8px 0 4px;font-size:9px;font-weight:700;letter-spacing:.1em;color:var(--text-muted);text-transform:uppercase;padding:0 2px';
    sep.textContent='Curtains';
    list.appendChild(sep);

    const row = document.createElement('div');
    row.className='piece-item curtain-piece'+(curtainEntry.pieceSelected?' sel-piece':'');
    row.style.cssText='border:1.5px dashed var(--border);border-radius:8px;padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .15s';
    const ico = document.createElement('span'); ico.style.cssText='display:flex;color:var(--text-mid)';
    ico.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M4 8h16M4 13h16"/></svg>';
    const lbl = document.createElement('span'); lbl.style.cssText='font-size:11px;font-weight:600;color:var(--text);flex:1'; lbl.textContent='Change Curtain Fabric';
    const hint = document.createElement('span'); hint.style.cssText='font-size:9px;color:var(--text-muted)'; hint.textContent='select → pick swatch';
    row.appendChild(ico); row.appendChild(lbl); row.appendChild(hint);
    row.addEventListener('click', () => {
      E.meshEntries.forEach(e => { e.pieceSelected = false; });
      curtainEntry.pieceSelected = true;
      buildPieceList();
      window.buildLibrary();
      showToast('Curtains selected — now pick a fabric below');
    });
    list.appendChild(row);
  }
}

// Toggles every meshEntry that shares a display name together (see
// groupEntriesByName) — a checkbox row always represents one real part.
export function toggleCheckGroup(group, checked) {
  group.forEach(entry => {
    entry.checked = checked;
    // greyMat stays the displayed material regardless of checked state —
    // origMat carries the source GLB's placeholder/QA-noise texture and must
    // never be shown. "checked" only gates which parts a clicked swatch targets.
  });
  if(checked){
    group.forEach(entry=>{entry.greyMat.emissive=new THREE.Color(0x666600);entry.greyMat.emissiveIntensity=0.3;entry.greyMat.needsUpdate=true;});
    setTimeout(()=>{ group.forEach(entry=>{entry.greyMat.emissive=new THREE.Color(0);entry.greyMat.emissiveIntensity=0;entry.greyMat.needsUpdate=true;}); markDirty(); },600);
  }
  buildMeshList(); markDirty();
}
export function selectAll() {
  E.meshEntries.forEach(entry=>{ entry.checked=true; if(Array.isArray(entry.mesh.material)){const a=[...entry.mesh.material];if(entry.matIndex>=0&&entry.matIndex<a.length){a[entry.matIndex]=entry.greyMat;entry.mesh.material=a;}}else{entry.mesh.material=entry.greyMat;} });
  buildMeshList(); markDirty(); window._refreshZoneLabelStates();
}
export function deselectAll() {
  // greyMat stays displayed — origMat (raw GLB placeholder/QA-noise texture) must never be shown.
  E.meshEntries.forEach(entry=>{ entry.checked=false; });
  buildMeshList(); markDirty(); window._refreshZoneLabelStates();
}

// ── GLB Processing ────────────────────────────────────────────────────────
// Shared mesh classification for processGLTF + _rebuildMeshEntries. Fully
// hardcoded for the 3 cataloged products — no runtime bounding-box/volume
// "scanning": every node name below was confirmed by inspecting each GLB's
// QA-render images (see PLAN.md §2), so classification is a direct lookup,
// not a heuristic guess.
//   accent_chair_fabric.glb: frame, legs, seat_cushion
//   sofa.glb:                backrest, frame, legs, seat_cushion
//   chair.glb:                root.0 (seat cushion), root.2 (back cushion),
//                             root.9 (whole frame/legs/arms) — generic node
//                             names, hardcoded from the confirmed QA renders.
// Returns '' when a node name isn't in KNOWN — the only remaining caller of
// that fallback path is an arbitrary GLB loaded via "Upload your own 3D
// model," which still gets the positional heuristic in processGLTF.
export function classifyMesh(mesh) {
  const KNOWN={
    'seat_cushion':'Seat Cushion','back_cushion':'Back Cushion',
    'backrest':'Backrest','frame':'Frame','legs':'Legs / Base',
    // chair.glb — generic node names, hardcoded from confirmed QA-render
    // inspection. Runtime names are "root0"/"root2"/"root9" (no dot) — the
    // glTF JSON's node names are "root.0" etc, but Three.js's GLTFLoader
    // sanitizes node names (dots collide with animation property-path
    // syntax) and strips the "." entirely.
    'root0':'Seat Cushion','root2':'Back Cushion','root9':'Frame',
  };
  let _n=mesh;
  while(_n){const k=(_n.name||'').trim().toLowerCase();if(KNOWN[k])return KNOWN[k];_n=_n.parent;}
  return '';
}

export function processGLTF(gltf) {
  try {
    // Guard: room mode caller manages E.scene membership
    if (!appStore.getState().roomMode && E.currentModel) E.scene.remove(E.currentModel);
    E.currentModel = gltf.scene;
    const box = new THREE.Box3().setFromObject(E.currentModel);
    const sz = box.getSize(new THREE.Vector3());
    E.currentModel.scale.setScalar(1.6 / Math.max(sz.x, sz.y, sz.z));
    const box2 = new THREE.Box3().setFromObject(E.currentModel);
    const ctr = box2.getCenter(new THREE.Vector3());
    E.currentModel.position.sub(ctr);
    E.currentModel.updateMatrixWorld(true);

    // Always add to E.scene (room mode will reposition via _placeFurnitureInRoom)
    E.scene.add(E.currentModel);
    const worldBox = new THREE.Box3().setFromObject(E.currentModel);
    const worldCenter = worldBox.getCenter(new THREE.Vector3());
    const worldSize   = worldBox.getSize(new THREE.Vector3());

    const newEntries = [];
    let meshCounter = 0;

    E.currentModel.traverse(child => {
      if(!child.isMesh) return;
      const mesh = child;
      let materials;
      if(!Array.isArray(mesh.material)){
        materials = mesh.material ? [mesh.material] : [new THREE.MeshStandardMaterial({color:0xcccccc})];
        if(mesh.geometry.groups.length===0){const count=mesh.geometry.index?mesh.geometry.index.count:mesh.geometry.attributes.position.count;mesh.geometry.addGroup(0,count,0);}
      } else { materials = mesh.material; }
      mesh.material = materials;

      materials.forEach((origMat, index) => {
        if(!origMat) origMat = new THREE.MeshStandardMaterial({color:0xcccccc});
        const greyMat = origMat.clone();
        greyMat.onBeforeCompile=()=>{}; greyMat.customProgramCacheKey=()=>greyMat.uuid;
        greyMat.color.set(0xd4d0cc);
        greyMat.map=null;greyMat.normalMap=null;greyMat.roughnessMap=null;greyMat.metalnessMap=null;
        if(greyMat.emissiveMap!==undefined)greyMat.emissiveMap=null;
        if(greyMat.aoMap!==undefined)greyMat.aoMap=null;
        if(greyMat.alphaMap!==undefined)greyMat.alphaMap=null;
        if(greyMat.bumpMap!==undefined)greyMat.bumpMap=null;
        greyMat.transparent=false;greyMat.opacity=1;greyMat.alphaTest=0;
        greyMat.depthWrite=true;greyMat.visible=true;greyMat.side=THREE.DoubleSide;
        greyMat.roughness=0.75;greyMat.metalness=0;
        if(greyMat.emissive)greyMat.emissive.set(0);
        if(greyMat.emissiveIntensity!==undefined)greyMat.emissiveIntensity=0;
        if(greyMat.sheen!==undefined)greyMat.sheen=0;
        if(greyMat.clearcoat!==undefined)greyMat.clearcoat=0;
        if(greyMat.transmission!==undefined)greyMat.transmission=0;
        greyMat.envMapIntensity=FABRIC_ENV_INTENSITY; // else the IBL washes the fabric colour out
        // Deliberately NOT greyscale-converting origMat.map onto the base
        // material: these 3 GLBs don't carry legitimate baked fabric detail
        // worth previewing in "no fabric applied" mode — their baked diffuse
        // is placeholder/QA noise from the source pipeline, and greyscaling
        // it just reproduces that noise instead of a clean neutral base.
        greyMat.needsUpdate=true;
        origMat._livinitGrey = greyMat; // so _rebuildMeshEntries reuses this mat (with any applied fabric)
        greyMat._livinitGrey = greyMat; // self-ref: mesh.material == greyMat after processGLTF, so _rebuildMeshEntries finds it here
        materials[index] = greyMat; // default display is the clean neutral mat, never the raw GLB material (which carries placeholder/QA noise)

        let cleanName=classifyMesh(mesh);

        mesh.geometry.computeBoundingBox();
        const meshBox=new THREE.Box3().setFromObject(mesh);
        const mc=meshBox.getCenter(new THREE.Vector3());
        const ms=meshBox.getSize(new THREE.Vector3());
        const wc=worldCenter,ws=worldSize;
        const relY=(mc.y-wc.y)/(ws.y*0.5),relZ=(mc.z-wc.z)/(ws.z*0.5),relX=(mc.x-wc.x)/(ws.x*0.5);
        const absX=Math.abs(relX);
        const dims=[ms.x,ms.y,ms.z].sort((a,b)=>a-b);
        const flatness=dims[2]>0?dims[0]/dims[2]:1;
        const meshVol=ms.x*ms.y*ms.z,worldVol=ws.x*ws.y*ws.z,volRatio=worldVol>0?meshVol/worldVol:0;

        if(!cleanName){
          // Positional heuristic fallback — unreachable for the 3 cataloged
          // products (their node names all hit classifyMesh's KNOWN dict
          // directly); only fires for an arbitrary GLB loaded via "Upload
          // your own 3D model."
          if(relY<-0.55) cleanName='Legs / Base';
          else if(relZ<-0.35&&relY>-0.3) cleanName='Backrest';
          else if(absX>0.55&&relY>-0.4) cleanName=relX>0?'Right Armrest':'Left Armrest';
          else if(relZ>0.0&&relY>-0.3&&relY<0.4&&absX<0.5) cleanName='Seat Cushion';
          else if(flatness<0.06||volRatio<0.0008) cleanName='Stitching';
          else if(relY<-0.35&&volRatio<0.02) cleanName='Legs / Base';
          else if(volRatio>0.12) cleanName='Main Body';
          else if(relY>-0.1&&relY<0.55&&absX<0.55) cleanName='Body Panel';
          else cleanName='Frame';
        }

        // Copy UV1 → UV2 for aoMap support (Three.js requires uv2 channel for aoMap)
        if(mesh.geometry.attributes.uv && !mesh.geometry.attributes.uv2) {
          mesh.geometry.setAttribute('uv2', mesh.geometry.attributes.uv);
        }

        // Measured UV density; bounding box only as a fallback for geometry
        // with no UVs (e.g. an arbitrary user-uploaded GLB).
        const maxDim=Math.max(ms.x,ms.y,ms.z);
        const uvScaleFactor=metersPerUvUnit(mesh) ?? (maxDim>0?maxDim:1);
        newEntries.push({id:`m-${meshCounter}-${index}`,name:cleanName,mesh,matIndex:index,origMat,greyMat,checked:false,pieceSelected:false,uvScaleFactor});
        meshCounter++;
      });
    });

    // Entries deliberately KEEP duplicate names here — a mesh split across
    // many material slots (e.g. chair.glb's Frame: 9 slots, one mesh) should
    // read as ONE real part. buildMeshList/buildPieceList/rebuildZoneOverlay
    // group entries by name into a single UI row/label; toggling it drives
    // every entry in the group together (see groupEntriesByName, entryGroup).

    E.meshEntries = newEntries;
    buildMeshList();
    buildPieceList();
    window.rebuildZoneOverlay();
    window.updateProductInfo();

    if(!appStore.getState().roomMode){
      // Chair only: frame ~10% further back than the shared default — it reads
      // tighter than the sofa/beds at the same radius, so it gets its own value.
      const baseR = 2.2;
      const r = appStore.getState().currentModelKey === 'chair' ? baseR * 1.1 : baseR;
      E.sph={theta:0.4,phi:1.15,r}; E.tgt.set(0,0,0); window.camUpdate();
      // Keep the default framing on load; only set the zoom-in floor from the
      // published/default viewpoint (can't zoom closer than it). No lock → 0.3.
      window.applyLockedViewpoint?.(appStore.getState().currentModelKey);
    }
    // Room mode: E.camera stays, _placeFurnitureInRoom sets positions
    // Restore previously saved material snapshot for this model key
    const snap = E.modelMaterialSnapshots[appStore.getState().currentModelKey];
    if(snap && snap.length > 0) {
      snap.forEach((s, si) => {
        if(si < E.meshEntries.length) {
          const entry = E.meshEntries[si];
          // Copy all material properties from snapshot
          const src = s.matClone;
          entry.greyMat.color.copy(src.color);
          entry.greyMat.roughness = src.roughness;
          entry.greyMat.metalness = src.metalness;
          if(src.sheen !== undefined) entry.greyMat.sheen = src.sheen;
          if(src.map) { entry.greyMat.map = src.map; }
          if(src.normalMap) { entry.greyMat.normalMap = src.normalMap; entry.greyMat.normalScale.copy(src.normalScale); }
          if(src.roughnessMap) { entry.greyMat.roughnessMap = src.roughnessMap; }
          entry.greyMat.needsUpdate = true;
          if(s.fabricName) entry.mesh.userData._fabricName = s.fabricName;
          // Apply to mesh
          const matArr = Array.isArray(entry.mesh.material) ? [...entry.mesh.material] : [entry.mesh.material];
          if(entry.matIndex >= 0 && entry.matIndex < matArr.length) {
            matArr[entry.matIndex] = entry.greyMat;
            entry.mesh.material = matArr;
          }
        }
      });
      markDirty();
    }

    markDirty();
    document.getElementById('loading').classList.remove('on');
    document.getElementById('v-hint').style.display='flex';
    if (typeof window._tourOnReady === 'function') { window._tourOnReady(); window._tourOnReady = null; }
    setSliderVal('brightness',1);setSliderVal('roughness',0.72);setSliderVal('metalness',0);
    setSliderVal('sheen',0,2);setSliderVal('scale',10,1);setSliderVal('norm',1,1);
    _maybeAutoSpin(appStore.getState().currentModelKey);
  } catch(e) {
    console.error('processGLTF error:', e);
    document.getElementById('loading').classList.remove('on');
    showToast('Model load failed: '+e.message);
  }
}

export function loadModel(url) {
  document.getElementById('loading').classList.add('on');
  document.getElementById('load-txt').textContent = 'Loading…';
  document.getElementById('v-hint').style.display='none';
  E.meshEntries=[];
  setActiveFabric(null); window.renderActiveSwatch();
  // Reset BOTH the product and room applied-preview variants — materials.js
  // writes both via ['','room'], so reset must clear both or the room panel
  // keeps a stale swatch after reset.
  ['','room'].forEach(sfx=>{
    const s=sfx?'-'+sfx:'';
    const n=document.getElementById('app-name'+s);if(n)n.textContent='— none —';
    const v=document.getElementById('app-vend'+s);if(v)v.textContent='';
    const sw=document.getElementById('app-sw'+s);if(sw){sw.innerHTML='';sw.style.background='var(--border)';}
    const rb=document.getElementById('app-replace-btn'+s);if(rb)rb.style.display='none';
  });

  if (_gltfSceneCache[url]) {
    // Cache hit — clone so processGLTF gets a fresh unmodified hierarchy
    processGLTF({ scene: _gltfSceneCache[url].clone(true) });
    roomFurnitureModels[appStore.getState().currentModelKey] = E.currentModel;
    return;
  }

  E.gltfLoader.load(url, gltf => {
    // Store a pre-process clone so subsequent loads skip the download + re-parse
    _gltfSceneCache[url] = gltf.scene.clone(true);
    processGLTF(gltf);
    roomFurnitureModels[appStore.getState().currentModelKey] = E.currentModel;
  }, undefined, err=>{
    console.error(err);
    document.getElementById('loading').classList.remove('on');
    showToast('Failed to load model');
  });
}

export function switchModel(key) {
  // ── 1. Save snapshot of current model before switching ─────────────────
  if (E.meshEntries.length > 0) {
    saveMaterialSnapshot();
  }

  const prevKey = appStore.getState().currentModelKey;
  setModelKey(key);
  document.getElementById('tab-chair').classList.toggle('active', key === 'chair');
  document.getElementById('tab-accent_chair').classList.toggle('active', key === 'accent_chair');
  document.getElementById('tab-sofa').classList.toggle('active',  key === 'sofa');
  const _titleMap = {chair:'Chair Fabrics',accent_chair:'Accent Chair Fabrics',sofa:'Sofa Fabrics'};
  document.getElementById('lib-title').textContent = _titleMap[key] || 'Fabrics';
  window.buildLibrary();
  window.updateProductInfo();

  if (appStore.getState().roomMode) {
    // ── Room mode: single active piece — only one product is ever visible
    // in the room at a time, so the previous one is always removed from
    // E.scene (its cache entry is kept for instant re-switching later).
    if (prevKey && prevKey !== key && roomFurnitureModels[prevKey]) {
      E.scene.remove(roomFurnitureModels[prevKey]);
    }
    const cached = roomFurnitureModels[key];
    if (cached) {
      E.currentModel = cached;
      if (!E.scene.getObjectById(E.currentModel.id)) E.scene.add(E.currentModel);
      window._placeFurnitureInRoom();
      E.meshEntries = [];
      _rebuildMeshEntries(E.currentModel);
      buildMeshList();
      buildPieceList();
      window._applySnapshotToModel(E.currentModel, key);
      markDirty();
    } else {
      // Not cached yet — load fresh (avoid calling processGLTF in room mode;
      // it would re-centre the model and clobber E.meshEntries/curtain entries)
      const url = getGLBUrl(key);
      document.getElementById('loading').classList.add('on');
      document.getElementById('load-txt').textContent = 'Loading…';
      E.gltfLoader.load(url, gltf => {
        E.currentModel = gltf.scene;
        // Normalise scale the same way processGLTF does
        const b = new THREE.Box3().setFromObject(E.currentModel);
        const sz = b.getSize(new THREE.Vector3());
        E.currentModel.scale.setScalar(1.6 / Math.max(sz.x, sz.y, sz.z));
        E.currentModel.updateMatrixWorld(true);
        E.scene.add(E.currentModel);
        roomFurnitureModels[key] = E.currentModel;
        // Place in room BEFORE rebuilding entries so bbox is measured in final position
        window._placeFurnitureInRoom();
        E.meshEntries = [];
        _rebuildMeshEntries(E.currentModel);
        buildMeshList();
        buildPieceList();
        window._applySnapshotToModel(E.currentModel, key);
        markDirty();
        document.getElementById('loading').classList.remove('on');
      }, undefined, () => {
        document.getElementById('loading').classList.remove('on');
        showToast('Failed to load model');
      });
    }
  } else {
    // ── Product mode: load fresh (applies snapshot via processGLTF) ───────
    loadModel(getGLBUrl(key));
  }
}

// Rebuild E.meshEntries for a model already in E.scene (room mode tab switch)
export function _rebuildMeshEntries(model) {
  const newEntries = [];
  let meshCounter = 0;

  model.traverse(child => {
    if (!child.isMesh) return;
    const mesh = child;
    const isMaterialArray = Array.isArray(mesh.material);
    let materials = isMaterialArray ? mesh.material : (mesh.material ? [mesh.material] : [new THREE.MeshStandardMaterial({color:0xcccccc})]);

    materials.forEach((origMat, index) => {
      if (!origMat) origMat = new THREE.MeshStandardMaterial({color:0xcccccc});
      // Use existing greyMat if already processed, else clone
      let greyMat = origMat._livinitGrey || (() => {
        const g = origMat.clone();
        g.color.set(0xd4d0cc); g.map=null; g.normalMap=null; g.roughnessMap=null;
        g.roughness=0.75; g.metalness=0; g.needsUpdate=true;
        g.envMapIntensity=FABRIC_ENV_INTENSITY; // match processGLTF — see engine.js
        origMat._livinitGrey = g;
        return g;
      })();

      const meshBox = new THREE.Box3().setFromObject(mesh);
      const ms = meshBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(ms.x, ms.y, ms.z);
      // Measured UV density, bounding box as fallback — see metersPerUvUnit.
      let uvScaleFactor = metersPerUvUnit(mesh) ?? (maxDim > 0 ? maxDim : 1);
      // Normalize uvScaleFactor to processGLTF scale so fabric tiling matches product view
      // regardless of slotScale. _seatOnFloor stores _baseScale when slotScale != 1.0.
      // Both measurements are in world metres, so both take the same correction.
      if (model._baseScale && model.scale.x > 0) uvScaleFactor *= (model._baseScale.x / model.scale.x);

      // Name from node name (KNOWN dict), else raw mesh name — room-mode
      // rebuilds deliberately skip the positional heuristic in processGLTF.
      let cleanName = classifyMesh(mesh);
      if(!cleanName) cleanName = mesh.name || `Part ${meshCounter+1}`;

      // Apply greyMat — preserve single vs array form to avoid geometry-group rendering issues
      if (isMaterialArray) {
        const matArr = [...mesh.material];
        matArr[index] = greyMat;
        mesh.material = matArr;
      } else {
        mesh.material = greyMat;
      }

      newEntries.push({
        id: `m-${meshCounter}-${index}`, name: cleanName,
        mesh, matIndex: index, origMat, greyMat,
        checked: false, pieceSelected: false,
        uvScaleFactor, // already normalized above by the _baseScale/scale ratio
      });
      meshCounter++;
    });
  });

  // Duplicate names are kept deliberately — see the matching comment in
  // processGLTF above; the UI groups entries by name into one row.

  E.meshEntries = newEntries;

  // Re-inject curtain entry so piece list always shows Curtains in room mode
  if (E.curtainMeshEntries.length > 0 && !E.meshEntries.find(e => e._isCurtain)) {
    E.meshEntries.push(E.curtainMeshEntries[0]);
  }
}

export function resetAll() {
  deselectAll();
  // Clear ALL snapshots on reset — every model key
  E.modelMaterialSnapshots = { chair: null, accent_chair: null, sofa: null };
  setActiveFabric(null); window.renderActiveSwatch();
  document.getElementById('app-name').textContent='— none —';
  document.getElementById('app-vend').textContent='';
  document.getElementById('app-sw').innerHTML='';
  document.getElementById('app-sw').style.background='var(--border)';
  const _rbr=document.getElementById('app-replace-btn');if(_rbr)_rbr.style.display='none';
  // Single active piece in Room View — nothing else to reload.
  if (appStore.getState().roomMode) window._placeFurnitureInRoom();
  showToast('Reset');
}

