// Factory defaults shared by actions.js (live) and design-state.js (pure).
// MUST stay dependency-free — design-state.js is unit-tested under node, and
// any import chain that reaches engine.js executes THREE/DOM at module scope.
export const SLIDER_DEFAULTS = { brightness: 1.0, roughness: 0.72, metalness: 0, sheen: 0, scale: 10.0, norm: 1.0 };
export const CURTAIN_STATE_DEFAULTS = { shape: 'drape', fabric: 'linen', color: '#EDE6D8', widthFactor: 1, lengthFactor: 1 };
