import { appStore } from './store.js';
import { CUSTOM_FABRIC_ITEMS } from './catalog.js';
import { SLIDER_DEFAULTS, CURTAIN_STATE_DEFAULTS } from './design-constants.js';
// Defaults live in design-constants.js (a dependency-free leaf) so the pure
// design-state.js module can import them without pulling in engine.js/THREE.
export { SLIDER_DEFAULTS, CURTAIN_STATE_DEFAULTS };
// Actions — the ONLY setState callers (docs/superpowers/specs §5).
// Modules read via appStore.getState() and mutate via these functions;
// nothing else may call appStore.setState.
//
// Classic script: exposes action functions in the shared global scope.

export function setSlider(name, v) {
  appStore.setState(s => ({ sliders: { ...s.sliders, [name]: v } }));
}

export function resetSliders() {
  appStore.setState(() => ({ sliders: { ...SLIDER_DEFAULTS } }));
}

export function setBaseColor(hex) {
  appStore.setState(() => ({ baseColorHex: hex }));
}

export function setModelKey(key) {
  appStore.setState(() => ({ currentModelKey: key }));
}

export function setRoomMode(on) {
  appStore.setState(() => ({ roomMode: on }));
}

export function setCurtain(patch) {
  appStore.setState(s => ({ curtainState: { ...s.curtainState, ...patch } }));
}

// Persists curtain customization across in-session room navigation — room
// rebuilds hard-reset curtainState to defaults. Null until the user changes
// anything.
export function saveCurtainState() {
  appStore.setState(s => ({ savedCurtainState: { ...s.curtainState } }));
}

// Room-rebuild reset: defaults overlaid with any saved customization.
export function restoreCurtainState() {
  appStore.setState(s => ({
    curtainState: s.savedCurtainState
      ? { ...CURTAIN_STATE_DEFAULTS, ...s.savedCurtainState }
      : { ...CURTAIN_STATE_DEFAULTS },
  }));
}

// key is "<gi>:<ii>" into LIBRARY[currentModelKey], or null to clear.
// renderActiveSwatch() (library.js) syncs the .active class from this.
export function setActiveFabric(key) {
  appStore.setState(() => ({ activeFabricKey: key }));
}

export function setFinder(patch) {
  appStore.setState(s => ({ finder: { ...s.finder, ...patch } }));
}

// Single mutation entry point for the user's My Fabrics collection. The array
// itself stays in src/catalog.js (CUSTOM_FABRIC_ITEMS) because four LIBRARY
// groups capture it by reference — replacing it immutably would strand them.
// Callers re-render via buildLibrary() after adding.
export function addCustomFabric(item) {
  CUSTOM_FABRIC_ITEMS.push(item);
}
