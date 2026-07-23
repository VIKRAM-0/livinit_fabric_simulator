// Browser-side capture/replay of DesignState (spec §3.2). Reads the imperative
// Three.js side (E.meshEntries) and replays through the EXISTING apply paths so
// the scene, store, and panel UI all update the same way a user action would.
// Cross-feature calls go through window.* per the boot.js shim convention —
// src/lib must not import from src/features.
import { E, markDirty, setSliderVal, showToast } from './engine.js';
import { appStore } from './store.js';
import { setBaseColor, setCurtain, saveCurtainState, addCustomFabric } from './actions.js';
import { SLIDER_DEFAULTS } from './design-constants.js';
import { LIBRARY, CUSTOM_FABRIC_ITEMS } from './catalog.js';
import { DESIGN_STATE_V, findFabricRef, resolveFabricRef } from './design-state.js';

export { fingerprintDesignState, defaultDesignState, findFabricRef, resolveFabricRef } from './design-state.js';

export function captureDesignState() {
  const s = appStore.getState();
  const lib = LIBRARY[s.currentModelKey] || [];
  const parts = {};
  for (const e of E.meshEntries) {
    if (e._isCurtain || parts[e.name] !== undefined) continue;
    // After a product-switch round-trip the snapshot restore paths repopulate
    // userData._fabricName but NOT entry.appliedFabric — capture must accept
    // either, or Save records blank designs.
    const worn = e.appliedFabric?.name ?? e.mesh?.userData?._fabricName ?? null;
    parts[e.name] = worn ? findFabricRef(worn, lib, CUSTOM_FABRIC_ITEMS) : null;
  }
  return {
    v: DESIGN_STATE_V,
    productKey: s.currentModelKey,
    parts,
    baseColorHex: s.baseColorHex,
    sliders: { ...s.sliders },
    curtain: { ...s.curtainState },
  };
}

// Factory finish for one part — mirrors the greyMat recipe in
// model.js processGLTF/_rebuildMeshEntries (color 0xd4d0cc, no maps).
function _restoreFactoryPart(entry) {
  const mat = entry.greyMat;
  mat.color.set(0xd4d0cc);
  mat.map = null; mat.normalMap = null; mat.roughnessMap = null; mat.aoMap = null;
  mat.roughness = 0.75; mat.metalness = 0;
  if ('sheen' in mat) mat.sheen = 0;
  mat.emissive?.set(0); mat.needsUpdate = true;
  window._commitEntryMaterial(entry, mat);
  entry.appliedFabric = null;
  delete entry.mesh.userData._fabricName;
}

let _chain = Promise.resolve();

// Serialized replay queue — rapid undo presses can't interleave (spec §3.2).
// opts.fast: skip the Gemini enhance/seamless pipeline and reuse cached
// textures — undo/redo must be responsive, not re-run network image work.
// Saved-design loads pass fast:false for full visual fidelity.
export function applyDesignState(state, opts = {}) {
  const run = () => _applyNow(state, opts).catch(e => console.error('applyDesignState:', e));
  _chain = _chain.then(run, run);
  return _chain;
}

async function _applyNow(state, { silent = true, fast = true } = {}) {
  if (!state || state.productKey !== appStore.getState().currentModelKey) return false;
  window.__replayingDesign = true;
  try {
    const lib = LIBRARY[state.productKey] || [];
    // 1 · Per-part fabrics (grouped by name, mirroring groupEntriesByName)
    const groups = new Map();
    E.meshEntries.filter(e => !e._isCurtain).forEach(e => {
      if (!groups.has(e.name)) groups.set(e.name, []);
      groups.get(e.name).push(e);
    });
    let missing = false;
    for (const [name, entries] of groups) {
      const ref = state.parts[name] ?? null;
      if (!ref) { entries.forEach(_restoreFactoryPart); continue; }
      const item = resolveFabricRef(ref, lib, CUSTOM_FABRIC_ITEMS);
      if (!item) { missing = true; continue; }
      // Re-register an embedded custom fabric that no longer exists locally
      if (ref.kind === 'custom' && !CUSTOM_FABRIC_ITEMS.some(i => i.name === item.name)) {
        addCustomFabric(item);
        window.buildLibrary();
      }
      await window.applySwatchToEntries(item, entries, { silent: true, fast });
    }
    // 2 · Global sliders + base color → parts wearing fabric.
    //     The slider appliers act on checked/pieceSelected entries, so borrow
    //     the checked flags for the duration and restore them after.
    const flags = E.meshEntries.map(e => [e, e.checked, e.pieceSelected]);
    E.meshEntries.forEach(e => { e.checked = !e._isCurtain && !!e.appliedFabric; e.pieceSelected = false; });
    setBaseColor(state.baseColorHex || '#ffffff');
    const S = { ...SLIDER_DEFAULTS, ...state.sliders };
    window.updateBrightness(+S.brightness);
    window.applyProp('roughness', +S.roughness);
    window.applyProp('metalness', +S.metalness);
    window.applyProp('sheen', +S.sheen);
    window.updateTexScale(+S.scale);
    window.updateNormScale(+S.norm);
    flags.forEach(([e, c, p]) => { e.checked = c; e.pieceSelected = p; });
    // Sync slider inputs (updateBrightness et al. update the value text only)
    setSliderVal('brightness', S.brightness); setSliderVal('brightness-r', S.brightness);
    setSliderVal('roughness', S.roughness); setSliderVal('roughness-r', S.roughness);
    setSliderVal('metalness', S.metalness); setSliderVal('sheen', S.sheen, 2);
    setSliderVal('scale', S.scale, 1); setSliderVal('scale-r', S.scale, 1);
    setSliderVal('norm', S.norm, 1);
    // 3 · Curtain — store always; live rebuild only when the room is up
    if (state.curtain) {
      setCurtain({ ...state.curtain });
      saveCurtainState();
      if (appStore.getState().roomMode && E.curtainMeshEntries.length) {
        window.setCurtainShape(state.curtain.shape);
        window.setCurtainFabric(state.curtain.fabric);
        window.setCurtainColor(state.curtain.color);
        window.setCurtainSize('width', state.curtain.widthFactor);
        window.setCurtainSize('length', state.curtain.lengthFactor);
      }
    }
    if (missing && !silent) showToast('Some fabrics in this design are no longer available');
    markDirty();
    return true;
  } finally {
    window.__replayingDesign = false;
  }
}
