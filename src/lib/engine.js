import { POLY_API, MATERIAL_MAPS } from './catalog.js';
import { appStore } from './store.js';
// Mutable app state, caches, Three.js refs, small utilities
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── App State ─────────────────────────────────────────────────────────────
// currentModelKey / roomMode live in appStore — see src/store.js.
// Shared mutable engine state. ES modules can't rebind imported bindings and
// 23 of these are reassigned from other modules, so they live as properties of
// one exported holder (Task 3 adds `export`). Reassign via E.x = …, read via E.x.
export const E = {
  meshEntries: [], currentModel: null, _dirty: true, roomGroup: null,
  _roomLoadGen: 0, explodeVal: 0, explodeAnim: null, _spinAnim: null, transformControls: null,
  furnitureMoveMode: false, tcMode: 'translate', curtainMeshEntries: [],
  _curtainNodes: [], _blindsGroup: null, _curtainBaseBox: null, _curtainFace: null,
  curtainsVisible: true, _curtainNormTex: null, _curtainLinColor: null,
  dragItem: null, dragActive: false,
  ghost: document.getElementById('drag-ghost'),
  ghostImg: document.getElementById('drag-ghost-img'),
  renderer: null, scene: null, camera: null, pmremGen: null, gltfLoader: null,
  sph: { theta: 0.4, phi: 1.15, r: 2.2 }, tgt: new THREE.Vector3(),
  // Closest allowed orbit radius. Default 0.3; raised to a product's locked
  // viewpoint radius when an admin has locked it (see viewport.js) so visitors
  // can't zoom in past the framed shot. Reset to 0.3 in room mode.
  minZoomR: 0.3,
  modelMaterialSnapshots: { chair: null, accent_chair: null, sofa: null },
  _curtainRoughTex: null,
};
// Pre-parsed GLB scenes keyed by URL — cloned on each use so processGLTF gets a fresh hierarchy
export const _gltfSceneCache = {};
// Room mode shows a single active piece at a time — this just caches each
// product's processed model so re-switching between chair/accent_chair/sofa
// in Room View is instant instead of a re-fetch/re-process.
export let roomFurnitureModels = { chair: null, accent_chair: null, sofa: null };
// Snapshot of mesh materials per model key — survives model switching (E.modelMaterialSnapshots)
// activeBtnEl → appStore.activeFabricKey (see src/store.js); lastAppliedItem
// was write-only (zero readers since the original upload) and was removed.

// Slider state lives in appStore (sliders.*, baseColorHex) — see src/store.js.
export const BASE_TILE = 0.3;

// Environment (IBL) contribution for furniture materials.
//
// three.js defaults envMapIntensity to 1.0, which lets the RoomEnvironment IBL
// flood the surface with white light and wash the fabric's own colour out. On
// Rivulet Pattern "Magma" (source swatch saturation 36.4%) the rendered cushion
// measured 24.1% saturation at 1.0 versus 32.5% at 0.4 — most of the gap the
// "colour looks dim compared to the swatch" reports were describing.
//
// 0.35 sits in the same band the curtain presets below already use (0.25–0.5);
// the furniture path simply never set the property at all. Lowering sheen and
// raising roughness were both measured too and moved the result by under 0.3pp,
// so they are left alone — the achromatic fill light is the lever that matters
// (see the ambient/hemisphere note in viewport.js initThree).
export const FABRIC_ENV_INTENSITY = 0.35;
export const polyCache = {};
export const texCache = {};
export const enhanceCache = {}; // diffSrc → AI-enhanced data URL (session cache)
export const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

export function markDirty(){ E._dirty = true; }

// ── Room state ─────────────────────────────────────────────────────────────
export let roomElements = {walls:null, floor:null, windows:null, doors:null, rug:null, ceiling:null};
export let roomVisible = {walls:true, floor:true, windows:true, doors:true, rug:true, ceiling:false};

// ── Curtain configurator data ─────────────────────────────────────────────
// Normal/roughness maps all reuse MATERIAL_MAPS.fabric (the Crypton-series
// Gemini-generated maps) — curtains are soft goods, no vinyl preset among
// them, and per-preset roughness/opacity/normalScale below already carry the
// visual distinction between e.g. velvet vs. voile vs. blackout; only the
// underlying weave texture is shared. No PolyHaven lookup (removed).
const CURTAIN_FABRIC_MAPS = { norm: MATERIAL_MAPS.fabric.norm, rough: MATERIAL_MAPS.fabric.rough };
export const CURTAIN_FABRICS = [
  { id:'linen',  label:'Linen',  roughness:0.90, opacity:1.00, normalScale:1.0, envMapIntensity:0.3, swatch:'linear-gradient(135deg,#efe9dc,#d9d2c2)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#EDE6D8','#D9CFC0','#B9C4A6','#D9B38C','#A89F90'] },
  { id:'cotton', label:'Cotton', roughness:0.85, opacity:1.00, normalScale:0.85, envMapIntensity:0.3, swatch:'linear-gradient(135deg,#f2f0ea,#dcdad2)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#EDE6D8','#D9CFC0','#9AA9B0','#BFC9CE','#A89F90'] },
  { id:'velvet', label:'Velvet', roughness:0.85, opacity:1.00, normalScale:0.55, envMapIntensity:0.4, swatch:'linear-gradient(135deg,#55585f,#2b2d31)',
    desaturateDiffuse:true, physical:true,
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#1F4E5F','#6A1B3A','#1C2733','#10403B','#402233'] },
  { id:'silk',   label:'Silk',   roughness:0.80, opacity:1.00, normalScale:0.45, envMapIntensity:0.5, swatch:'linear-gradient(135deg,#f6efe0,#e2d7bf)',
    desaturateDiffuse:true,
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#8C6A1F','#3B2A6B','#1F4E5F','#244B7A','#6A1B3A'] },
  { id:'voile',  label:'Voile',  roughness:0.95, opacity:0.72, normalScale:0.55, envMapIntensity:0.3, swatch:'linear-gradient(135deg,#faf9f4,#e8e6de)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#FFFFFF','#F5F2EC','#DDE3E6','#EDE6D8'] },
  { id:'cotton-blend', label:'Cotton-blend', roughness:0.78, opacity:1.00, normalScale:0.85, envMapIntensity:0.32, swatch:'linear-gradient(135deg,#f0ece2,#d6d0c4)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#EDE6D8','#D9CFC0','#9AA9B0','#A89F90'] },
  { id:'wool', label:'Wool', roughness:0.92, opacity:1.00, normalScale:1.20, envMapIntensity:0.28, swatch:'linear-gradient(135deg,#cbbfa8,#9c8e74)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#6E6960','#3A2C2A','#6B7B53','#7C4A21','#36454F'] },
  { id:'jacquard', label:'Jacquard', roughness:0.80, opacity:1.00, normalScale:1.40, envMapIntensity:0.42, swatch:'linear-gradient(135deg,#cdb98f,#9a7d4f)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#D9CFC0','#1F4E5F','#8C6A1F','#A89F90'] },
  { id:'blackout', label:'Blackout', roughness:0.86, opacity:1.00, normalScale:0.50, envMapIntensity:0.25, swatch:'linear-gradient(135deg,#3a3733,#23211e)',
    normFallback: CURTAIN_FABRIC_MAPS.norm, roughFallback: CURTAIN_FABRIC_MAPS.rough,
    recommend:['#1C2733','#2B2B2B','#36454F','#3A2C2A'] },
];
// curtainState / savedCurtainState live in appStore — see src/store.js. (E._curtainRoughTex)

export const CURTAIN_COLORS = [
  { hex:'#EDE6D8', label:'Cream'   },
  { hex:'#D9CFC0', label:'Greige'  },
  { hex:'#A89F90', label:'Taupe'   },
  { hex:'#B9C4A6', label:'Sage'    },
  { hex:'#9AA9B0', label:'Steel'   },
  { hex:'#1F4E5F', label:'Teal'    },
  { hex:'#1C2733', label:'Navy'    },
  { hex:'#2B2B2B', label:'Charcoal'},
];

// Curated palettes for the side panel (the flat CURTAIN_COLORS above stays for the bottom bar).
export const CURTAIN_COLOR_GROUPS = [
  { group:'Neutrals', colors:[
    {hex:'#F5F2EC',label:'Ivory'},{hex:'#EDE6D8',label:'Cream'},{hex:'#D9CFC0',label:'Greige'},
    {hex:'#C2B6A3',label:'Oatmeal'},{hex:'#A89F90',label:'Taupe'},{hex:'#8C8377',label:'Mushroom'},
    {hex:'#6E6960',label:'Slate Grey'},{hex:'#FFFFFF',label:'White'} ]},
  { group:'Warm / Earth', colors:[
    {hex:'#E7D3B5',label:'Sand'},{hex:'#D9B38C',label:'Camel'},{hex:'#C68A5E',label:'Terracotta'},
    {hex:'#A9602F',label:'Rust'},{hex:'#7C4A21',label:'Cognac'},{hex:'#B08D57',label:'Ochre'},{hex:'#8A5A3B',label:'Clay'} ]},
  { group:'Cool / Blue-Grey', colors:[
    {hex:'#DDE3E6',label:'Mist'},{hex:'#BFC9CE',label:'Fog Blue'},{hex:'#9AA9B0',label:'Steel'},
    {hex:'#6F7E87',label:'Slate Blue'},{hex:'#4F606B',label:'Denim'},{hex:'#36454F',label:'Charcoal Blue'},{hex:'#283845',label:'Deep Slate'} ]},
  { group:'Greens', colors:[
    {hex:'#DCE3D2',label:'Pale Sage'},{hex:'#B9C4A6',label:'Sage'},{hex:'#8FA079',label:'Moss'},
    {hex:'#6B7B53',label:'Olive'},{hex:'#46583C',label:'Fern'},{hex:'#2E4034',label:'Forest'},{hex:'#7A8B6F',label:'Eucalyptus'} ]},
  { group:'Jewel', colors:[
    {hex:'#1F4E5F',label:'Teal'},{hex:'#10403B',label:'Emerald'},{hex:'#3B2A6B',label:'Amethyst'},
    {hex:'#6A1B3A',label:'Garnet'},{hex:'#7A2E2E',label:'Ruby'},{hex:'#8C6A1F',label:'Antique Gold'},{hex:'#244B7A',label:'Sapphire'} ]},
  { group:'Deep / Dark', colors:[
    {hex:'#2B2B2B',label:'Near Black'},{hex:'#1C2733',label:'Midnight Navy'},{hex:'#3A2C2A',label:'Espresso'},
    {hex:'#402233',label:'Aubergine'},{hex:'#28332B',label:'Deep Forest'},{hex:'#4A1F22',label:'Oxblood'},{hex:'#23252A',label:'Graphite'} ]},
];

// Curtain chip colours are sRGB hex. With renderer.outputEncoding = sRGBEncoding the shader
// treats a material's .color as LINEAR, so an sRGB hex assigned raw is gamma-encoded TWICE on
// output → the fabric renders pale and desaturated. Convert sRGB→linear here so the rendered
// colour round-trips to the true chip hue. `scalar` optionally darkens (rails/pleat/sheen).
E._curtainLinColor = function(hex, scalar) {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  if (scalar !== undefined) c.multiplyScalar(scalar);
  return c;
};

// Piece system (room mode per-mesh fabric targeting)

// Raycaster for drag-drop
export const raycaster = new THREE.Raycaster();
export const mouse = new THREE.Vector2();

// ── Utilities ─────────────────────────────────────────────────────────────
// Escape untrusted strings before interpolating into innerHTML. Required for
// anything derived from API responses, error messages, or user input.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}
export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}
export function setSliderVal(id, val, decimals=2) {
  const el = document.getElementById('s-'+id);
  if(el) el.value = val;
  const vEl = document.getElementById('v-'+id);
  if(vEl) vEl.textContent = (+val).toFixed(decimals);
}
export function tryLoadTex(url, isSrgb) {
  if(texCache[url]) return Promise.resolve(texCache[url]);
  return new Promise((resolve, reject) => {
    texLoader.load(url, t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.encoding = isSrgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
      t.flipY = false;
      t.anisotropy = 16;
      texCache[url] = t;
      resolve(t);
    }, undefined, ()=>reject(new Error('404')));
  });
}
export function makeGreyscaleTex(origTex) {
  if(!origTex || !origTex.image) return null;
  try {
    const img = origTex.image;
    const w = img.naturalWidth || img.width || (img instanceof ImageBitmap ? img.width : 0) || 512;
    const h = img.naturalHeight || img.height || (img instanceof ImageBitmap ? img.height : 0) || 512;
    if(w===0 || h===0) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if(!ctx) return null;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,w,h);
    ctx.filter = 'grayscale(100%) brightness(1.8) contrast(0.85)';
    ctx.drawImage(img,0,0,w,h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = origTex.encoding || THREE.sRGBEncoding;
    t.wrapS = origTex.wrapS || THREE.RepeatWrapping;
    t.wrapT = origTex.wrapT || THREE.RepeatWrapping;
    if(origTex.repeat) t.repeat.copy(origTex.repeat);
    if(origTex.offset) t.offset.copy(origTex.offset);
    if(origTex.flipY !== undefined) t.flipY = origTex.flipY;
    t.anisotropy = origTex.anisotropy || 16;
    t.needsUpdate = true;
    return t;
  } catch(e) { return null; }
}
export const POLY_NORM_KEYS  = ['nor_gl','Normal','nor_dx','nor','Nor_GL','NormalGL'];
export const POLY_ROUGH_KEYS = ['Rough','rough','Roughness','roughness'];
export function pickPolyUrl(files, keys) {
  const norm = s => s.toLowerCase().replace(/[\s_-]/g,'');
  const fk = Object.keys(files);
  for(const key of keys) {
    const d = files[key];
    if(d) { const url = d?.['2k']?.jpg?.url || d?.['1k']?.jpg?.url; if(url) return url; }
    const nk = norm(key);
    const m = fk.find(k=>norm(k)===nk);
    if(m && files[m]) { const url = files[m]?.['2k']?.jpg?.url || files[m]?.['1k']?.jpg?.url; if(url) return url; }
  }
  return null;
}
// 'col_01'/'col_02'/'col_03' cover PolyHaven patterned fabrics that ship color
// variants instead of a single 'Diffuse' map — used by the curtain diffuse lookup.
export const POLY_DIFF_KEYS = ['diff','Diffuse','diffuse','Diff','albedo','Albedo','col_01','col_02','col_03','col','Color'];
export async function getPolyMaps(polyId) {
  if(polyCache[polyId]) return polyCache[polyId];
  try {
    const res = await fetch(POLY_API + polyId);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const files = await res.json();
    const normUrl  = pickPolyUrl(files, POLY_NORM_KEYS);
    const roughUrl = pickPolyUrl(files, POLY_ROUGH_KEYS);
    const diffUrl  = pickPolyUrl(files, POLY_DIFF_KEYS);
    polyCache[polyId] = { normUrl, roughUrl, diffUrl };
    return polyCache[polyId];
  } catch(e) {
    polyCache[polyId] = { normUrl:null, roughUrl:null, diffUrl:null };
    return polyCache[polyId];
  }
}

// Save the current model's materials so room view / model switching restores them.
// Single implementation — was copy-pasted at five call sites.
export function saveMaterialSnapshot() {
  E.modelMaterialSnapshots[appStore.getState().currentModelKey] = E.meshEntries.map(e => ({
    id: e.id, name: e.name, matClone: e.greyMat.clone(),
    fabricName: e.mesh?.userData?._fabricName || null,
  }));
}
