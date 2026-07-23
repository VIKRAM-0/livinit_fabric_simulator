// Canonical serializable design snapshot (spec §3.1) — PURE helpers only.
// Browser capture/apply live in design-state-live.js; this file must stay
// importable under node (no Three.js, no DOM) for unit tests — import ONLY
// from design-constants.js, never actions.js (its chain reaches engine.js).
import { SLIDER_DEFAULTS, CURTAIN_STATE_DEFAULTS } from './design-constants.js';

export const DESIGN_STATE_V = 1;

// appliedName (entry.appliedFabric.name / userData._fabricName) → FabricRef.
// Custom items are embedded by value so a saved design survives the finder
// item being gone.
export function findFabricRef(appliedName, library, customItems) {
  if (!appliedName) return null;
  const custom = (customItems || []).find(i => i.name === appliedName);
  if (custom) return { kind: 'custom', item: JSON.parse(JSON.stringify(custom)) };
  for (const g of library || []) {
    if ((g.items || []).some(i => i.name === appliedName)) {
      return { kind: 'lib', name: appliedName, group: g.group };
    }
  }
  return null;
}

// FabricRef → live item, or null when the catalog no longer has it.
export function resolveFabricRef(ref, library, customItems) {
  if (!ref) return null;
  if (ref.kind === 'custom') {
    return (customItems || []).find(i => i.name === ref.item.name) || ref.item;
  }
  const grp = (library || []).find(g => g.group === ref.group);
  const inGroup = grp && (grp.items || []).find(i => i.name === ref.name);
  if (inGroup) return inGroup;
  for (const g of library || []) {
    const it = (g.items || []).find(i => i.name === ref.name);
    if (it) return it;
  }
  return null;
}

// Cheap equality key. Custom items collapse to their name — a multi-hundred-KB
// data-URL must not be stringified on every record() (spec §3.3).
export function fingerprintDesignState(state) {
  if (!state) return 'null';
  const parts = Object.keys(state.parts || {}).sort().map(k => {
    const r = state.parts[k];
    return k + '=' + (r ? (r.kind === 'custom' ? 'c:' + r.item.name : 'l:' + r.name) : '-');
  }).join('|');
  return [state.productKey, parts, state.baseColorHex, JSON.stringify(state.sliders), JSON.stringify(state.curtain)].join('§');
}

export function defaultDesignState(productKey, partNames = []) {
  return {
    v: DESIGN_STATE_V,
    productKey,
    parts: Object.fromEntries(partNames.map(n => [n, null])),
    baseColorHex: '#ffffff',
    sliders: { ...SLIDER_DEFAULTS },
    curtain: { ...CURTAIN_STATE_DEFAULTS },
  };
}
