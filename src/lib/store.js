// Minimal pub/sub store — the single source of truth for UI/app state.
// Migration path (docs/superpowers/specs/2026-07-07-asset-designer-refactor-design.md §6):
// move one state domain at a time out of state.js into here (finder → active
// swatch → curtainState → sliders), with actions as the only setState callers.
// The Three.js scene graph stays imperative behind action functions — do NOT
// put meshes, materials, or textures in this store.
//
// Classic script: exposes `appStore` in the shared global scope.

export function createStore(initialState) {
  let state = structuredClone(initialState);
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    // The ONLY way to change state. Pass a function returning a partial next state.
    setState(updater) {
      const next = updater(state);
      state = { ...state, ...next };
      listeners.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const appStore = createStore({
  // Populated domain-by-domain as state migrates out of src/state.js.
  sliders: { brightness: 1.0, roughness: 0.72, metalness: 0, sheen: 0, scale: 10.0, norm: 1.0 },
  baseColorHex: '#ffffff',
  currentModelKey: 'chair',
  roomMode: false,
  curtainState: { shape: 'drape', fabric: 'linen', color: '#EDE6D8', widthFactor: 1, lengthFactor: 1 },
  // User's in-session curtain customization; survives room rebuilds. Null until first change.
  savedCurtainState: null,
  // Fabric-finder modal state (photo upload + Gemini-vision AI analysis only
  // — the PolyHaven/AmbientCG search tab has been removed).
  finder: {
    imgData: null,              // base64 of the uploaded image
    analyzed: null,             // last AI analysis (before save)
    pendingUploadPreview: null, // preview pending confirm-bar decision
  },
  // Library swatch highlight: "<groupIndex>:<itemIndex>" into
  // LIBRARY[currentModelKey], or null. Cleared on model load/reset, so a key
  // never outlives the library it indexes into.
  activeFabricKey: null,
});
