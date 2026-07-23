import { E, markDirty, showToast, saveMaterialSnapshot, roomFurnitureModels, roomElements, roomVisible, CURTAIN_FABRICS, CURTAIN_COLOR_GROUPS } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { setRoomMode, restoreCurtainState, setCurtain, saveCurtainState } from '../../lib/actions.js';
import { ROOM_GLB, loadTexFirstSuccess } from '../../lib/catalog.js';
// Room view (single Living Room, single active piece), curtains & blinds,
// placement, move mode, explode
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── Room View ─────────────────────────────────────────────────────────────
export function toggleRoomView() {
  setRoomMode(!appStore.getState().roomMode);
  const btn = document.getElementById('btn-room-view');
  if(btn){ btn.classList.toggle('active-view', appStore.getState().roomMode); btn.textContent = appStore.getState().roomMode ? '× Exit Room' : '🏠 Room View'; }
  // "View in My Room" stays visible in both product and room views
  // Sidebar nav state
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const activeNav = document.getElementById(appStore.getState().roomMode ? 'nav-room' : 'nav-simulator');
  if(activeNav) activeNav.classList.add('active');
  // Zone overlay visibility
  const zoneOverlay = document.getElementById('zone-overlay');
  if(zoneOverlay) zoneOverlay.style.display = appStore.getState().roomMode ? 'none' : '';
  // 360° spin is a product-view-only affordance — Room View shows the whole
  // staged room, not one focused piece.
  const spinBtn = document.getElementById('btn-spin-360');
  if(spinBtn) spinBtn.style.display = appStore.getState().roomMode ? 'none' : '';
  // Keep the Settings → Viewpoint state label in sync with room/product mode.
  window.refreshViewpointUI?.();

  // Tool-panel tabs own body visibility: room mode → Room tab, product → Fabrics.
  // (Room controls now live inside the Room tab — the floating canvas tray is gone.)
  if(window.showPanelTab) window.showPanelTab(appStore.getState().roomMode ? 'room' : 'fabrics');

  if(appStore.getState().roomMode) {
    // Save snapshot of current model's fabric state before entering room
    if (E.meshEntries.length > 0) {
      saveMaterialSnapshot();
    }
    buildRoom(() => {
      // Look INTO the room interior from the open front-right corner.
      E.sph = {theta: 0.05 + Math.PI, phi: 1.15, r: 7.0};
      E.tgt.set(0, -0.3, 0);
      window.camUpdate();
    });
    window.buildPieceList();
  } else {
    removeRoom();
    // Restore the active model to clean centered product-view position
    if (E.currentModel) {
      E.currentModel.rotation.set(0, 0, 0);
      // Reset scale to normalised base (undo room slot scale)
      if (E.currentModel._baseScale) {
        E.currentModel.scale.copy(E.currentModel._baseScale);
        E.currentModel._baseScale = null;
      }
      E.currentModel.position.set(0, 0, 0);
      E.currentModel.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(E.currentModel);
      const ctr = box.getCenter(new THREE.Vector3());
      E.currentModel.position.sub(ctr);
      E.currentModel.updateMatrixWorld(true);
    }
    // Restore product-view E.camera
    E.sph = {theta: 0.4, phi: 1.15, r: 2.2};
    E.tgt.set(0, 0, 0);
    window.camUpdate();
    // Re-apply any locked viewpoint (overrides the default pose + restores the
    // zoom-in floor that was relaxed to 0.3 while in room mode).
    window.applyLockedViewpoint?.(appStore.getState().currentModelKey);
    // Re-apply environment to restore correct lighting after room session
    if (E.pmremGen) {
      E.scene.environment = E.pmremGen.fromScene(new THREE.RoomEnvironment(), 1.0).texture;
    }
    markDirty();
  }
}

// ── Room geometry ─────────────────────────────────────────────────────────
export function buildRoom(onReadyCallback) {
  removeRoom();
  const _gen = ++E._roomLoadGen;
  E.roomGroup = new THREE.Group();
  E.scene.add(E.roomGroup);

  // Load the room.glb as the environment
  document.getElementById('loading').classList.add('on');
  document.getElementById('load-txt').textContent = 'Loading Room…';

  E.gltfLoader.load(ROOM_GLB, gltf => {
    if (E._roomLoadGen !== _gen) return; // superseded by a newer room build
    const roomScene = gltf.scene;

    // ── Scale room to ~6 units wide ──────────────────────────────────────
    const rawBox  = new THREE.Box3().setFromObject(roomScene);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const roomScale = 6.0 / Math.max(rawSize.x, rawSize.z, 0.001);
    roomScene.scale.setScalar(roomScale);
    roomScene.updateMatrixWorld(true);

    // ── Centre horizontally, pin bottom of room to y = -1.6 ─────────────
    const scaledBox    = new THREE.Box3().setFromObject(roomScene);
    const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
    roomScene.position.x = -scaledCenter.x;
    roomScene.position.z = -scaledCenter.z;
    roomScene.position.y = -1.6 - scaledBox.min.y;
    roomScene.updateMatrixWorld(true);

    // ── Detect actual floor surface Y in world space ─────────────────────
    // Walk meshes, find the one with the largest XZ footprint → that's the floor
    let bestArea = 0, detectedFloorY = -1.6;
    roomScene.traverse(child => {
      if (!child.isMesh) return;
      const b = new THREE.Box3().setFromObject(child);
      const sz = b.getSize(new THREE.Vector3());
      // Floor candidates: flat (height < 15% of the larger of width/depth)
      const maxHoriz = Math.max(sz.x, sz.z);
      if (sz.y < maxHoriz * 0.15) {
        const area = sz.x * sz.z;
        if (area > bestArea) { bestArea = area; detectedFloorY = b.max.y; }
      }
    });
    // If nothing flat found, fall back to scaled box bottom + small offset
    if (bestArea === 0) detectedFloorY = scaledBox.min.y + 0.02;
    roomFloorY = detectedFloorY;
    window.roomFloorY = roomFloorY;
    console.log('[Room] detectedFloorY =', roomFloorY, 'bestArea =', bestArea);

    E.roomGroup.add(roomScene);

    // ── Tag room sub-objects for chip toggles ────────────────────────────
    roomScene.traverse(child => {
      const n = (child.name || '').toLowerCase();
      if (n.includes('wall') || n.includes('arch')) roomElements.walls = roomElements.walls || child;
      if (n.includes('floor') || n.includes('ground')) roomElements.floor = roomElements.floor || child;
      if (n.includes('window') || n.includes('glass')) roomElements.windows = roomElements.windows || child;
      if (n.includes('door')) roomElements.doors = roomElements.doors || child;
      if (n.includes('rug') || n.includes('carpet')) roomElements.rug = roomElements.rug || child;
      if (n.includes('ceiling') || n.includes('ceil')) roomElements.ceiling = roomElements.ceiling || child;
    });

    // ── Detect curtain meshes and add to piece system ────────────────────
    buildCurtainEntries(roomScene, {
      // Living room: single curtain group (New6.002); panels share its pivot.
      findNodes: (s) => { let g = null; s.traverse(c => { if (c.name === 'New6.002') g = c; }); return g ? [g] : []; },
      missMsg: '[Room] curtain group New6.002 not found, skipping curtain entries',
      builtMsg: (n) => `[Room] built ${n} curtain mesh entries`,
      uvScaleFactor: 1,
      inheritRoughness: true,
      bailIfNoMeshes: true,
    });
    // Inject curtain representative entry into E.meshEntries so piece list + fabric drop works
    if (E.curtainMeshEntries.length > 0) {
      E.meshEntries = E.meshEntries.filter(e => !e._isCurtain);
      E.meshEntries.push(E.curtainMeshEntries[0]); // show single "Curtains" entry

      // Restore prior in-session customization if any; otherwise defaults. Without
      // this the curtains reset to a flat placeholder grey on every rebuild
      // (toggling Room View, switching products) even though curtainState/the
      // fabric bar still show the user's last selection as active.
      restoreCurtainState();
      E.curtainsVisible = true;
      const _ccl = document.getElementById('chip-curtains-living');
      if (_ccl) _ccl.classList.add('on');
      _initCurtainFabricSwatches();
      _showCurtainConfigPanel(true);
      _applyCurtainMaterial();
    }

    _placeFurnitureInRoom();
    document.getElementById('loading').classList.remove('on');
    if (onReadyCallback) onReadyCallback();
    window.buildPieceList();
    markDirty();
  }, undefined, err => {
    if (E._roomLoadGen !== _gen) return;
    console.error('Room GLB load error:', err);
    document.getElementById('loading').classList.remove('on');
    showToast('Room GLB failed — using fallback');
    _buildProceduralRoom();
    _placeFurnitureInRoom();
    if (onReadyCallback) onReadyCallback();
    markDirty();
  });
}

export function _buildProceduralRoom() {
  const W=6, H=3.2, D=6;
  roomFloorY = -1.6 + 0.01; // floor surface is the plane surface + tiny offset
  window.roomFloorY = roomFloorY;
  const wallMat = new THREE.MeshStandardMaterial({color:0xf5f0ea, roughness:0.9, side:THREE.BackSide});
  const floorMat= new THREE.MeshStandardMaterial({color:0xd4c4a8, roughness:0.8, metalness:0.02});
  const roomBox = new THREE.Mesh(new THREE.BoxGeometry(W,H,D), wallMat);
  roomElements.walls=roomBox; E.roomGroup.add(roomBox);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W,D), floorMat);
  floor.rotation.x=-Math.PI/2; floor.position.y=-1.6;
  roomElements.floor=floor; E.roomGroup.add(floor);
}

// ── Curtain configurator functions ────────────────────────────────────────

export function _showCurtainConfigPanel(show) {
  const panel = document.getElementById('curtain-config-panel');
  if (panel) panel.style.display = show ? 'block' : 'none';
}

export function _initCurtainFabricSwatches() {
  const row = document.getElementById('curtain-fabric-row');
  if (row) {
    row.innerHTML = '';
    const FAB_DESC = { linen:'natural slub', cotton:'soft matte', velvet:'luxe pile', silk:'lustrous',
      voile:'sheer airy', 'cotton-blend':'easy care', wool:'warm dense', jacquard:'woven pattern', blackout:'room-darkening' };
    CURTAIN_FABRICS.forEach(f => {
      const card = document.createElement('button');
      card.className = 'curtain-fab-card' + (f.id === appStore.getState().curtainState.fabric ? ' active' : '');
      card.id = 'cfab-' + f.id;
      card.title = f.label;
      card.onclick = () => setCurtainFabric(f.id);
      const dot = document.createElement('span');
      dot.className = 'curtain-fab-dot';
      dot.style.background = f.swatch;
      const txt = document.createElement('span');
      txt.className = 'curtain-fab-text';
      const nm = document.createElement('span');
      nm.className = 'curtain-fab-name';
      nm.textContent = f.label;
      const ds = document.createElement('span');
      ds.className = 'curtain-fab-desc';
      ds.textContent = FAB_DESC[f.id] || '';
      txt.appendChild(nm); txt.appendChild(ds);
      card.appendChild(dot); card.appendChild(txt);
      row.appendChild(card);
    });
  }
  renderCurtainColorGroups();
  // Sync active shape button to current/restored state
  document.querySelectorAll('.curtain-shape-btn').forEach(b => b.classList.remove('active'));
  const shapeBtn = document.getElementById('cshape-' + appStore.getState().curtainState.shape);
  if (shapeBtn) shapeBtn.classList.add('active');
  // Sync size sliders to current/restored state
  const wf = appStore.getState().curtainState.widthFactor || 1, lf = appStore.getState().curtainState.lengthFactor || 1;
  const wEl = document.getElementById('curtain-width'),  wVal = document.getElementById('curtain-width-val');
  const lEl = document.getElementById('curtain-length'), lVal = document.getElementById('curtain-length-val');
  if (wEl)  wEl.value = wf;
  if (wVal) wVal.textContent = Math.round(wf * 100) + '%';
  if (lEl)  lEl.value = lf;
  if (lVal) lVal.textContent = Math.round(lf * 100) + '%';
}

// Renders the grouped colour palettes into the side panel. Highlights the active
// fabric's recommended colours.
export function renderCurtainColorGroups() {
  const host = document.getElementById('curtain-color-presets');
  if (!host) return;
  host.innerHTML = '';
  const preset = CURTAIN_FABRICS.find(f => f.id === appStore.getState().curtainState.fabric);
  const rec = new Set((preset && preset.recommend) ? preset.recommend.map(h => h.toUpperCase()) : []);
  CURTAIN_COLOR_GROUPS.forEach(g => {
    const lbl = document.createElement('div');
    lbl.className = 'curtain-color-group-label';
    lbl.textContent = g.group;
    host.appendChild(lbl);
    const rowEl = document.createElement('div');
    rowEl.className = 'curtain-color-group-row';
    g.colors.forEach(c => {
      const btn = document.createElement('button');
      const isRec = rec.has(c.hex.toUpperCase());
      btn.className = 'curtain-color-chip'
        + (c.hex.toLowerCase() === (appStore.getState().curtainState.color || '').toLowerCase() ? ' active' : '')
        + (isRec ? ' recommended' : '');
      btn.id = 'cclr-' + c.hex.replace('#','');
      btn.title = c.label + (isRec ? ' · recommended' : '');
      btn.style.background = c.hex;
      btn.onclick = () => setCurtainColor(c.hex);
      rowEl.appendChild(btn);
    });
    host.appendChild(rowEl);
  });
}

export function _buildCurtainMat(normTex, roughTex) {
  const preset = CURTAIN_FABRICS.find(f => f.id === appStore.getState().curtainState.fabric) || CURTAIN_FABRICS[0];
  const shape  = appStore.getState().curtainState.shape;

  let roughness  = preset.roughness;
  let opacity    = preset.opacity;
  const baseCol  = E._curtainLinColor(appStore.getState().curtainState.color);

  if (shape === 'sheer') {
    roughness = Math.min(preset.roughness + 0.04, 1.0);
    opacity   = 0.42;
  } else if (shape === 'blinds') {
    // Vertical fabric blinds read off the pleat geometry. Matte woven fabric with
    // the full texture set — not shiny metal, which looked like wet plastic.
    roughness = 0.7;
  } else if (shape === 'pleated') {
    roughness = Math.min(preset.roughness + 0.10, 1.0);
    baseCol.multiplyScalar(0.78);
  }

  const matOpts = {
    color: baseCol,
    roughness,
    metalness: 0,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: opacity >= 1,
  };
  // Velvet uses MeshPhysicalMaterial for its retroreflective sheen rim.
  // r128: sheen is a THREE.Color (null disables it) — not a float, and there is
  // no sheenColor/sheenRoughness (those are r133+).
  const mat = preset.physical
    ? new THREE.MeshPhysicalMaterial(matOpts)
    : new THREE.MeshStandardMaterial(matOpts);
  if (preset.physical) {
    mat.sheen = E._curtainLinColor(appStore.getState().curtainState.color, 0.7);
  }

  // Texture repeat scales with curtain size so the weave density stays constant.
  const repX = 4 * (appStore.getState().curtainState.widthFactor  || 1);
  const repY = 4 * (appStore.getState().curtainState.lengthFactor || 1);

  if (normTex) {
    const nt = normTex.clone();
    nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    nt.repeat.set(repX, repY);
    nt.needsUpdate = true;
    mat.normalMap = nt;
    const ns = preset.normalScale ?? 0.8;
    mat.normalScale = new THREE.Vector2(ns, ns);
  }
  if (roughTex) {
    const rt = roughTex.clone();
    rt.wrapS = rt.wrapT = THREE.RepeatWrapping;
    rt.repeat.set(repX, repY);
    rt.needsUpdate = true;
    mat.roughnessMap = rt;
  }

  // Fabric should barely reflect the RoomEnvironment — full intensity made it look
  // like satin/vinyl (the blue interior HDRI reflecting as bright specular streaks).
  mat.envMapIntensity = (preset.envMapIntensity ?? 1.0) * 0.25;

  return mat;
}

export async function _applyCurtainMaterial() {
  if (!E.curtainMeshEntries.length) return;
  if (E._blindsGroup) E._blindsGroup.visible = false; // default hidden; blinds branch re-shows
  if (appStore.getState().curtainState.shape === 'none') {
    E.curtainMeshEntries.forEach(e => { e.mesh.visible = false; });
    markDirty();
    return;
  }
  if (appStore.getState().curtainState.shape === 'blinds') {
    // Procedural slats replace the drape mesh entirely.
    E.curtainMeshEntries.forEach(e => { e.mesh.visible = false; });
    _applyBlinds();
    return;
  }
  E.curtainMeshEntries.forEach(e => { e.mesh.visible = E.curtainsVisible; });

  const _gen = E._roomLoadGen;
  const preset = CURTAIN_FABRICS.find(f => f.id === appStore.getState().curtainState.fabric) || CURTAIN_FABRICS[0];
  // No diffuse source — curtains render as flat color (the chip hue) with the
  // shared Crypton-fabric normal/roughness maps for weave texture.
  let normTex = null, roughTex = null;
  try {
    if (preset.normFallback)  normTex  = await loadTexFirstSuccess(preset.normFallback,  false).catch(() => null);
    if (preset.roughFallback) roughTex = await loadTexFirstSuccess(preset.roughFallback, false).catch(() => null);
  } catch (_) {}

  if (E._roomLoadGen !== _gen) return; // room was switched while textures loaded
  E._curtainNormTex  = normTex;
  E._curtainRoughTex = roughTex;

  const mat = _buildCurtainMat(normTex, roughTex);
  E.curtainMeshEntries.forEach(e => { e.mesh.material = mat; });
  _applyCurtainSize(); // re-apply node scale + UV repeat (fresh meshes after room load)
}

export function _applyCurtainColor() {
  if (!E.curtainMeshEntries.length) return;
  if (appStore.getState().curtainState.shape === 'none') return;
  if (appStore.getState().curtainState.shape === 'blinds') {
    if (E._blindsGroup) {
      E._blindsGroup.userData.slatMat.color.copy(E._curtainLinColor(appStore.getState().curtainState.color));
      E._blindsGroup.userData.railMat.color.copy(E._curtainLinColor(appStore.getState().curtainState.color, 0.7));
      E._blindsGroup.userData.slatMat.needsUpdate = true;
    }
    markDirty();
    return;
  }
  const preset  = CURTAIN_FABRICS.find(f => f.id === appStore.getState().curtainState.fabric) || CURTAIN_FABRICS[0];
  const shape   = appStore.getState().curtainState.shape;
  const baseCol = E._curtainLinColor(appStore.getState().curtainState.color);
  let opacity   = preset.opacity;
  if (shape === 'sheer') {
    opacity = 0.42;
  } else if (shape === 'pleated') {
    baseCol.multiplyScalar(0.78);
  }
  E.curtainMeshEntries.forEach(e => {
    if (!e.mesh.material) return;
    const mats = Array.isArray(e.mesh.material) ? e.mesh.material : [e.mesh.material];
    mats.forEach(m => {
      if (!m || !m.color) return;
      m.color.set(baseCol);
      m.opacity = opacity;
      m.transparent = opacity < 1;
      // Velvet (MeshPhysicalMaterial): keep the r128 sheen Color tracking the chip color
      if (m.sheen instanceof THREE.Color) m.sheen.copy(baseCol).multiplyScalar(0.7);
      m.needsUpdate = true;
    });
  });
  markDirty();
}

export function setCurtainShape(id) {
  setCurtain({ shape: id });
  saveCurtainState();
  document.querySelectorAll('.curtain-shape-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('cshape-' + id);
  if (btn) btn.classList.add('active');
  _applyCurtainMaterial();
  window._historyRecord?.();
}

export function setCurtainFabric(id) {
  setCurtain({ fabric: id });
  saveCurtainState();
  document.querySelectorAll('.curtain-fab-card').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('cfab-' + id);
  if (btn) btn.classList.add('active');
  // Sync bar swatches
  document.querySelectorAll('[data-cfab]').forEach(b => b.classList.toggle('active', b.dataset.cfab === id));
  renderCurtainColorGroups(); // refresh recommended-colour highlight for the new fabric
  _applyCurtainMaterial();
  window._historyRecord?.();
}

export function setCurtainColor(hex) {
  setCurtain({ color: hex });
  saveCurtainState();
  document.querySelectorAll('.curtain-color-chip').forEach(b => b.classList.remove('active'));
  const chip = document.getElementById('cclr-' + hex.replace('#',''));
  if (chip) chip.classList.add('active');
  // Sync bar color chips
  document.querySelectorAll('[data-cclr]').forEach(b => b.classList.toggle('active', b.dataset.cclr === hex));
  _applyCurtainColor();
  window._historyRecord?.();
}

// Scales curtain nodes (width=X, length=Y) and rescales texture repeat so the
// fabric weave keeps its density instead of stretching. Folds are baked into the
// GLB geometry, so large factors still distort folds — hence the 0.7–1.4 clamp.
export function _applyCurtainSize() {
  const wf = appStore.getState().curtainState.widthFactor  || 1;
  const lf = appStore.getState().curtainState.lengthFactor || 1;
  if (appStore.getState().curtainState.shape === 'blinds') { _applyBlinds(); return; } // slats rebuild to new dims
  E._curtainNodes.forEach(n => {
    const base = n.userData._curtainBaseScale;
    if (!base) return;
    n.scale.set(base.x * wf, base.y * lf, base.z);
    n.updateMatrixWorld(true);
  });
  E.curtainMeshEntries.forEach(e => {
    if (!e.mesh.material) return;
    const mats = Array.isArray(e.mesh.material) ? e.mesh.material : [e.mesh.material];
    mats.forEach(m => {
      if (!m) return;
      [m.map, m.normalMap, m.roughnessMap].forEach(tex => {
        if (tex) { tex.repeat.set(4 * wf, 4 * lf); tex.needsUpdate = true; }
      });
    });
  });
  markDirty();
}

export function setCurtainSize(dim, value) {
  const v = Math.max(0.7, Math.min(1.4, parseFloat(value) || 1));
  setCurtain(dim === 'width' ? { widthFactor: v } : { lengthFactor: v });
  saveCurtainState();
  const valEl = document.getElementById('curtain-' + dim + '-val');
  if (valEl) valEl.textContent = Math.round(v * 100) + '%';
  _applyCurtainSize();
}

// Compute a node's average world-space normal by sampling its meshes' normals.
export function _avgWorldNormal(node) {
  const acc = new THREE.Vector3();
  node.updateWorldMatrix(true, true);
  node.traverse(c => {
    if (!c.isMesh || !c.geometry || !c.geometry.attributes.normal) return;
    const na = c.geometry.attributes.normal;
    const nm = new THREE.Matrix3().getNormalMatrix(c.matrixWorld);
    const step = Math.max(1, (na.count / 200) | 0);
    const v = new THREE.Vector3();
    for (let k = 0; k < na.count; k += step) {
      v.set(na.getX(k), na.getY(k), na.getZ(k)).applyMatrix3(nm);
      acc.add(v);
    }
  });
  return acc.lengthSq() ? acc.normalize() : acc.set(0, 0, 1);
}

// Detect & repair mirror-flipped panel normals for multi-panel curtain setups
// (e.g. two panels where one is a mirror of the other, so its baked vertex
// normals point INTO the wall instead of toward the room — it then lights as
// if from behind, reading a different colour than its twin even though they
// share one material). Only acts when panels genuinely OPPOSE each other,
// then flips whichever faces away from the room interior — a no-op on the
// room's actual single-node curtain case (guarded by curtainNodes.length<2
// below), kept for any future multi-panel curtain node structure.
export function _fixCurtainNormals(curtainNodes, roomScene) {
  if (curtainNodes.length < 2) return;
  const n0 = _avgWorldNormal(curtainNodes[0]);
  const n1 = _avgWorldNormal(curtainNodes[1]);
  if (n0.dot(n1) >= -0.3) return; // panels already face the same way → nothing to fix

  const curtainBox = new THREE.Box3();
  curtainNodes.forEach(n => curtainBox.expandByObject(n));
  const curtainCenter = curtainBox.getCenter(new THREE.Vector3());
  const roomCenter = new THREE.Box3().setFromObject(roomScene).getCenter(new THREE.Vector3());
  const toRoom = roomCenter.clone().sub(curtainCenter); toRoom.y = 0;
  if (!toRoom.lengthSq()) return;
  toRoom.normalize();

  const flippedGeoms = new Set();
  curtainNodes.forEach(node => {
    if (_avgWorldNormal(node).dot(toRoom) >= 0) return; // faces the room → correct
    node.traverse(c => {
      if (!c.isMesh || !c.geometry || !c.geometry.attributes.normal) return;
      if (flippedGeoms.has(c.geometry.uuid)) return; // don't double-flip shared geometry
      const na = c.geometry.attributes.normal;
      for (let k = 0; k < na.count; k++) na.setXYZ(k, -na.getX(k), -na.getY(k), -na.getZ(k));
      na.needsUpdate = true;
      flippedGeoms.add(c.geometry.uuid);
    });
    console.log(`[Curtains] fixed inverted normals on ${node.name}`);
  });
}

// ── Procedural Venetian blinds ────────────────────────────────────────────
// The "Blinds" style swaps the drape mesh for real horizontal slat geometry.
const BLINDS_TILT = THREE.MathUtils.degToRad(32); // half-open venetian angle

// Blinds mount AT the window, but the only anchor is the drape footprint
// (E._curtainBaseBox), which spans the full floor-to-rod drape — the rod sits well
// above the window head and the panels puddle to the floor. Reusing it raw makes
// the shade ride up the bare wall above the window (and overshoot the sill below).
// Confine the shade to the window band: cover ~72% of the drape height, biased
// slightly upward so the top drops below the rod and the bottom lifts off the floor.
const SHADE_VCOVER = 0.72; // shade height as a fraction of the drape footprint height
const SHADE_VRISE  = 0.04; // shade centre lifted above the drape-box centre (× footprint height)

export function _disposeBlinds() {
  if (!E._blindsGroup) return;
  E._blindsGroup.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }
  });
  if (E._blindsGroup.parent) E._blindsGroup.parent.remove(E._blindsGroup);
  E._blindsGroup = null;
}

// Shared orientation + position for the rigid blind panel. The drape's averaged
// normal (E._curtainFace) is noisy because the drape is wavy; feeding that straight in
// skews the flat panel a few degrees, swinging its far edge back through the window
// glass → z-fighting. Snap the facing axis to the nearest world cardinal so the panel
// stays parallel to the glass, then stand it off toward the room.
export function _curtainPanelFrame(offset) {
  const zAxis = E._curtainFace.clone(); zAxis.y = 0;
  if (zAxis.lengthSq() < 1e-6) zAxis.set(-1, 0, 0);
  zAxis.normalize();
  if (Math.abs(zAxis.x) >= Math.abs(zAxis.z)) zAxis.set(Math.sign(zAxis.x) || -1, 0, 0);
  else                                        zAxis.set(0, 0, Math.sign(zAxis.z) || 1);
  const up = new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  const position = E._curtainBaseBox.center.clone().add(zAxis.clone().multiplyScalar(offset));
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);
  return { position, quaternion };
}

export function _buildBlindsGeometry() {
  _disposeBlinds();
  if (!E._curtainBaseBox || !E._curtainFace || !E.scene) return;
  const wf = appStore.getState().curtainState.widthFactor || 1;
  const lf = appStore.getState().curtainState.lengthFactor || 1;
  const sz = E._curtainBaseBox.size;
  const fullH  = sz.y * lf;                          // full drape footprint height
  const width  = Math.max(sz.x, sz.z) * wf * 0.98;
  const height = fullH * SHADE_VCOVER * 0.98;        // confined to the window band
  if (width <= 0 || height <= 0) return;

  const grp = new THREE.Group();
  const frame = _curtainPanelFrame(0.05); // stand off the glass; snapped square to it
  grp.position.copy(frame.position);
  grp.position.y += fullH * SHADE_VRISE;             // lift off the floor / below the rod
  grp.quaternion.copy(frame.quaternion);

  // Faux-wood louvers: solid boxes (real thickness) so edges catch light.
  const slatMat = new THREE.MeshStandardMaterial({
    color: E._curtainLinColor(appStore.getState().curtainState.color), roughness: 0.62, metalness: 0,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: E._curtainLinColor(appStore.getState().curtainState.color, 0.7), roughness: 0.7, metalness: 0,
  });

  const tilt      = BLINDS_TILT;
  const slatDepth = 0.05;                         // 2" louver (front-to-back when flat)
  const thickness = 0.004;                        // ~3-4 mm
  const projPitch = Math.max(0.02, slatDepth * Math.cos(tilt)); // visible vertical pitch when tilted
  const count     = Math.min(60, Math.max(16, Math.round(height / projPitch)));
  const pitch     = height / count;

  // Box local axes: X = louver length (window width), Y = thickness, Z = louver depth.
  const slatGeo = new THREE.BoxGeometry(width, thickness, slatDepth);
  for (let i = 0; i < count; i++) {
    const slat = new THREE.Mesh(slatGeo, slatMat);
    slat.position.y = height / 2 - pitch * (i + 0.5);
    slat.rotation.x = tilt;                        // tilt about the louver's long axis
    slat.castShadow = true; slat.receiveShadow = true;
    grp.add(slat);
  }

  // Slim headrail (top) + heavier bottom rail — both solid boxes, depth kept small to stay clear of glass.
  const headrail = new THREE.Mesh(new THREE.BoxGeometry(width * 1.02, 0.05, 0.06), railMat);
  headrail.position.y = height / 2 + 0.03;
  headrail.castShadow = true; headrail.receiveShadow = true;
  grp.add(headrail);

  const bottomrail = new THREE.Mesh(new THREE.BoxGeometry(width * 1.02, 0.03, slatDepth * 0.7), railMat);
  bottomrail.position.y = -height / 2 - 0.015;
  bottomrail.castShadow = true; bottomrail.receiveShadow = true;
  grp.add(bottomrail);

  // Ladder cords down the face (toward the room) — the detail that sells "real blinds".
  const cordMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0xeae6dc), roughness: 0.8, metalness: 0 });
  const cordLen = height + 0.06;
  const cordGeo = new THREE.CylinderGeometry(0.004, 0.004, cordLen, 6); // axis = local Y (vertical)
  for (const xf of [-0.28, 0.28]) {
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.position.set(width * xf, 0, slatDepth * 0.5 + 0.005); // +Z = toward room, in front of louvers
    grp.add(cord);
  }
  grp.userData.cordMat = cordMat;

  grp.userData.slatMat = slatMat;
  grp.userData.railMat = railMat;
  E._blindsGroup = grp;
  E.scene.add(grp);
}

// Show blinds (rebuilds with current colour + size), hiding the drape meshes.
export function _applyBlinds() {
  _buildBlindsGeometry();
  if (E._blindsGroup) E._blindsGroup.visible = E.curtainsVisible;
  markDirty();
}

export function toggleCurtains() {
  E.curtainsVisible = !E.curtainsVisible;
  const btn = document.getElementById('chip-curtains-living');
  if (btn) btn.classList.toggle('on', E.curtainsVisible);
  if (E.curtainsVisible) {
    _applyCurtainMaterial(); // respects shape='none'/'blinds' internally
  } else {
    E.curtainMeshEntries.forEach(e => { e.mesh.visible = false; });
    if (E._blindsGroup) E._blindsGroup.visible = false;
    markDirty();
  }
  _showCurtainConfigPanel(E.curtainsVisible);
}

// Unified curtain entry builder for both room sections. The per-room deltas
// ride in opts; everything else (shared grey material so fabric applies to all
// panels at once, base-scale capture for the size sliders, base-box capture
// anchoring procedural blinds, entry shape) is common.
//   findNodes(roomScene) → top-level curtain nodes ([] when absent)
//   missMsg / builtMsg(n)  → the section's log strings (kept verbatim)
//   uvScaleFactor          → fabric tiling for the section's curtain UVs
//   inheritRoughness       → copy first panel material's roughness (living room)
//   bailIfNoMeshes         → living room returns before touching curtain state
//                            when the group exists but holds no meshes
export function buildCurtainEntries(roomScene, opts) {
  const curtainNodes = opts.findNodes(roomScene);
  if (!curtainNodes.length) { console.log(opts.missMsg); return; }

  const meshes = [];
  curtainNodes.forEach(node => {
    node.traverse(child => {
      if (child.isMesh && child.material) meshes.push(child);
    });
  });
  if (opts.bailIfNoMeshes && !meshes.length) return;

  // Keep the top-level curtain nodes and their base scale for sizing (scaling the
  // node about its own pivot keeps the curtain anchored, unlike scaling child meshes).
  E._curtainNodes = curtainNodes;
  curtainNodes.forEach(n => { n.userData._curtainBaseScale = n.scale.clone(); });

  // Fix inverted panel normals — see _fixCurtainNormals for why this can happen.
  _fixCurtainNormals(curtainNodes, roomScene);

  // Capture the curtain footprint at BASE scale (nodes un-sized here) — anchors the
  // procedural blinds geometry independently of drape scaling.
  {
    const bb = new THREE.Box3();
    curtainNodes.forEach(n => bb.expandByObject(n));
    if (!bb.isEmpty()) {
      E._curtainBaseBox = { center: bb.getCenter(new THREE.Vector3()), size: bb.getSize(new THREE.Vector3()) };
      E._curtainFace = _avgWorldNormal(curtainNodes[0]).clone();
    }
  }

  const sharedGreyMat = new THREE.MeshStandardMaterial({
    color: 0xd4c8b8, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
  });
  if (opts.inheritRoughness) {
    const firstMat = meshes.length ? (Array.isArray(meshes[0].material) ? meshes[0].material[0] : meshes[0].material) : null;
    if (firstMat) sharedGreyMat.roughness = firstMat.roughness ?? 0.8;
    sharedGreyMat.needsUpdate = true;
  }

  let idx = 0;
  meshes.forEach(child => {
    const origMat = Array.isArray(child.material) ? child.material[0] : child.material;
    // Apply sharedGreyMat to the mesh NOW so highlights and drag feedback are visible
    child.material = sharedGreyMat;
    E.curtainMeshEntries.push({
      id: `curtain-${idx++}`,
      name: idx === 1 ? 'Curtains' : null,
      mesh: child,
      matIndex: 0,
      origMat: origMat || sharedGreyMat,
      greyMat: sharedGreyMat,   // shared — mutating this updates all panels
      checked: false,
      pieceSelected: false,
      uvScaleFactor: opts.uvScaleFactor,
      _isCurtain: true,
    });
  });
  if (E.curtainMeshEntries.length > 0) {
    E.curtainMeshEntries[0].name = 'Curtains';
    console.log(opts.builtMsg(E.curtainMeshEntries.length));
  }
}

// ── Furniture placement ──────────────────────────────────────────────────
//
//  DESIGN:
//  - roomFloorY is detected dynamically from the room.glb bounding box min.y
//  - Room View shows a SINGLE active piece at a time (chair, accent chair, or
//    sofa) — no companion duo. All 3 share one center-of-room hero slot; only
//    rotY/scale differ per product so each faces the camera at a sensible size.
//  - _seatOnFloor resets to origin, measures bbox, then positions precisely
//  - Rotation 0 = model faces its natural forward (+Z in GLB convention)
//    If a model loads facing wrong way, flip FURNITURE_SLOTS rotY by PI.
//
// chair/sofa rotY+scale values carried over from the old chair_split.glb/
// sofa.glb calibration (same asset lineage). accent_chair is a brand-new
// asset with no prior calibration — rotY:0/scale:1.0 is a starting guess,
// verify facing/size live in the dev server and adjust here if it's off.
export const FURNITURE_SLOTS = {
  chair:        { x: 0, z: 0, rotY: 3.93,    scale: 0.7 },
  accent_chair: { x: 0, z: 0, rotY: 0,       scale: 1.0 },
  sofa:         { x: 0, z: 0, rotY: Math.PI, scale: 1.2 },
};

window.FURNITURE_SLOTS = FURNITURE_SLOTS;

export let roomFloorY = -1.6; // updated dynamically after room.glb loads
window.roomFloorY = roomFloorY;

export function _seatOnFloor(model, slotX, slotZ, rotY, slotScale) {
  if (!model) return;

  // 1. Zero out transform
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.updateMatrixWorld(true);

  // 2. Apply slot-specific scale on top of the normalised scale
  // model.scale was already set to 1.6/maxDim by processGLTF
  // We multiply by slotScale to fine-tune per-slot size
  if (slotScale && slotScale !== 1.0) {
    model.scale.multiplyScalar(slotScale);
    // Prevent accumulation: store base scale and recompute
    if (!model._baseScale) model._baseScale = model.scale.clone().divideScalar(slotScale);
    model.scale.copy(model._baseScale).multiplyScalar(slotScale);
  }
  model.updateMatrixWorld(true);

  // 3. Measure bbox after scale applied
  const box = new THREE.Box3().setFromObject(model);
  const ctr = box.getCenter(new THREE.Vector3());
  const minY = box.min.y;

  // 4. Apply rotation then translate
  model.rotation.y = rotY;
  model.position.set(slotX - ctr.x, roomFloorY - minY, slotZ - ctr.z);

  model.updateMatrixWorld(true);
  markDirty();
}

// Called after room.glb loads AND after any model reload inside room mode.
// Single active piece — positions only E.currentModel; switchModel() is
// responsible for removing whichever other product was previously visible.
export function _placeFurnitureInRoom() {
  if (!E.currentModel) return;
  const s = FURNITURE_SLOTS[appStore.getState().currentModelKey];
  if (s) _seatOnFloor(E.currentModel, s.x, s.z, s.rotY, s.scale || 1.0);
  roomFurnitureModels[appStore.getState().currentModelKey] = E.currentModel;
  if (!E.scene.getObjectById(E.currentModel.id)) E.scene.add(E.currentModel);
}

// Apply a saved material snapshot to a raw gltf E.scene (companion model)
export function _applySnapshotToModel(model, key) {
  const snap = E.modelMaterialSnapshots[key];
  if (!snap || !snap.length) return;
  let si = 0;
  model.traverse(child => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((_, idx) => {
      if (si < snap.length) {
        const arr = Array.isArray(child.material) ? [...child.material] : [child.material];
        arr[idx] = snap[si].matClone.clone();
        arr[idx].needsUpdate = true;
        child.material = arr;
        // Keep the worn-fabric identity — captureDesignState reads it, and
        // this path never repopulates entry.appliedFabric (staff review M1).
        if (snap[si].fabricName) child.userData._fabricName = snap[si].fabricName;
        si++;
      }
    });
  });
  markDirty();
}

export function removeRoom() {
  // Exit move mode first
  if (E.furnitureMoveMode) {
    E.furnitureMoveMode = false;
    if (E.transformControls) { E.transformControls.detach(); E.transformControls.visible = false; }
    const bar = document.getElementById('move-mode-bar');
    if (bar) bar.classList.remove('active');
    const hud = document.getElementById('move-hud');
    if (hud) hud.classList.remove('active');
  }

  // Clean up curtain entries
  _removeCurtainEntries();

  if (E.roomGroup) { E.scene.remove(E.roomGroup); E.roomGroup = null; }
  Object.keys(roomElements).forEach(k => roomElements[k] = null);

  // Safety net: single active piece means only the current product should ever
  // be in E.scene, but remove any stray cached model from another product key
  // (KEEP E.currentModel itself so product-view can still use it). Keep all
  // refs in roomFurnitureModels for fast re-entry.
  Object.keys(roomFurnitureModels).forEach(k => {
    if (k !== appStore.getState().currentModelKey && roomFurnitureModels[k]) {
      E.scene.remove(roomFurnitureModels[k]);
    }
  });

  // Reset roomFloorY back to default
  roomFloorY = -1.6;
  window.roomFloorY = roomFloorY;
}

export function toggleRoomEl(key) {
  const btn = document.getElementById('chip-'+key);
  roomVisible[key] = !roomVisible[key];
  if(btn) btn.classList.toggle('on', roomVisible[key]);
  const el = roomElements[key];
  if(el) { el.visible = roomVisible[key]; markDirty(); }
}

// ── Furniture Move Mode ──────────────────────────────────────────────────
export function toggleMoveMode() {
  E.furnitureMoveMode = !E.furnitureMoveMode;
  const bar = document.getElementById('move-mode-bar');
  if (bar) bar.classList.toggle('active', E.furnitureMoveMode);
  const hud = document.getElementById('move-hud');
  if (hud) hud.classList.toggle('active', E.furnitureMoveMode);
  // Keep TC detached/hidden — we use the custom HUD instead
  if (E.transformControls) { E.transformControls.detach(); E.transformControls.visible = false; }
  markDirty();
}

export function setMoveMode(mode) {
  E.tcMode = mode;
  ['translate','rotate'].forEach(m => {
    const el = document.getElementById('mm-'+m);
    if (el) el.classList.toggle('active', m===mode);
  });
  markDirty();
}

// ── Furniture nudge / rotate helpers (used by Move HUD buttons) ───────────
export function nudgeFurniture(dx, dz) {
  const model = roomFurnitureModels[appStore.getState().currentModelKey];
  if (!model) return;
  model.position.x += dx;
  model.position.z += dz;
  model.updateMatrixWorld(true);
  markDirty();
}
export function rotateFurnitureY(deg) {
  const model = roomFurnitureModels[appStore.getState().currentModelKey];
  if (!model) return;
  model.rotation.y += deg * Math.PI / 180;
  model.updateMatrixWorld(true);
  markDirty();
}

// ── Curtain mesh helpers ─────────────────────────────────────────────────
export function _removeCurtainEntries() {
  // Restore original materials on curtain meshes
  E.curtainMeshEntries.forEach(e => {
    const arr = Array.isArray(e.mesh.material) ? [...e.mesh.material] : [e.mesh.material];
    arr[e.matIndex] = e.origMat;
    e.mesh.material = arr;
  });
  E.curtainMeshEntries = [];
  E._curtainNodes = [];
  _disposeBlinds(); E._curtainBaseBox = null; E._curtainFace = null;
  // Remove curtain entries from E.meshEntries
  E.meshEntries = E.meshEntries.filter(e => !e._isCurtain);
  _showCurtainConfigPanel(false);
}

// ── Explode ───────────────────────────────────────────────────────────────
export function updateExplode(val) {
  E.explodeVal = val;
  const el = document.getElementById('v-explode'); if(el) el.textContent=val.toFixed(1);
  const slider = document.getElementById('s-explode'); if(slider) slider.value=val;
  if(!E.currentModel || !E.meshEntries.length) return;

  // compute model center
  const modelBox = new THREE.Box3().setFromObject(E.currentModel);
  const center = modelBox.getCenter(new THREE.Vector3());

  E.meshEntries.forEach((entry,i)=>{
    // Direction = mesh center relative to model center
    const mBox = new THREE.Box3().setFromObject(entry.mesh);
    const mc = mBox.getCenter(new THREE.Vector3());
    const dir = mc.clone().sub(center).normalize();
    if(dir.length()===0) dir.set(0,1,0);
    // Apply in local space: move mesh by dir * E.explodeVal * scale
    const offset = dir.multiplyScalar(val*0.8);
    // We store original local position
    if(!entry._origLocalPos) entry._origLocalPos = entry.mesh.position.clone();
    entry.mesh.position.copy(entry._origLocalPos).add(offset);
  });
  markDirty();
}

export function animateExplode() {
  if(E.explodeAnim) return;
  const start = E.explodeVal;
  const target = start < 0.5 ? 1.0 : 0.0;
  const duration = 1200;
  const startTime = performance.now();
  E.explodeAnim = requestAnimationFrame(function tick(now) {
    const t = Math.min((now-startTime)/duration, 1);
    const ease = t<0.5 ? 2*t*t : -1+(4-2*t)*t;
    const val = start + (target-start)*ease;
    updateExplode(val);
    if(t<1) { E.explodeAnim=requestAnimationFrame(tick); }
    else { E.explodeAnim=null; }
  });
}

