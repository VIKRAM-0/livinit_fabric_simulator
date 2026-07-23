import { E, showToast, markDirty, setSliderVal, tryLoadTex, enhanceCache, BASE_TILE, saveMaterialSnapshot, getPolyMaps, raycaster, mouse } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { setSlider, setBaseColor } from '../../lib/actions.js';
import { MATERIAL_MAPS, POLY_IDS, loadTexFirstSuccess, LIBRARY } from '../../lib/catalog.js';
// Fabric apply pipeline, diffuse upload, seamless blend, drag&drop, sliders
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── Wood-zone exclusivity ─────────────────────────────────────────────────
// The wood finish may only be applied to the exposed structural part of each
// product, and those parts take ONLY wood (fabric is blocked there too):
//   chair        → Frame        (exposed wooden armchair frame)
//   accent_chair → Legs / Base  (upholstered frame, wooden legs)
//   sofa         → Legs / Base
// Zone display names come from classifyMesh() in model.js. Products not in this
// map (e.g. an uploaded custom GLB) are left unrestricted.
export const WOOD_ZONE_NAMES = {
  chair:        ['Frame'],
  accent_chair: ['Legs / Base'],
  sofa:         ['Legs / Base'],
};
function _isWoodZone(entry) {
  const zones = WOOD_ZONE_NAMES[appStore.getState().currentModelKey];
  return !!zones && zones.includes(entry.name);
}
// Split target entries into those an item is ALLOWED on and those it isn't:
// wood items only on wood zones, fabric/vinyl items only on non-wood zones.
// Unrestricted products (not in WOOD_ZONE_NAMES) pass everything through.
function _filterEntriesForItem(item, entries) {
  if (!WOOD_ZONE_NAMES[appStore.getState().currentModelKey]) return { valid: entries, rejected: [] };
  const wantWood = item.type === 'wood';
  const valid = [], rejected = [];
  entries.forEach(e => ((_isWoodZone(e) === wantWood) ? valid : rejected).push(e));
  return { valid, rejected };
}

// ── Apply swatch logic (shared between click and drop) ────────────────────
export function texToDataUrl(tex) {
  const img = tex.image;
  if(!img) return null;
  const w = img.naturalWidth||img.width||(img instanceof ImageBitmap?img.width:0)||512;
  const h = img.naturalHeight||img.height||(img instanceof ImageBitmap?img.height:0)||512;
  if(w===0||h===0) return null;
  const c = document.createElement('canvas');
  c.width=w; c.height=h;
  const ctx=c.getContext('2d');
  if(!ctx) return null;
  ctx.drawImage(img,0,0,w,h);
  return c.toDataURL('image/jpeg',0.93);
}

export async function enhanceTexture(dataUrl, cacheKey) {
  if(enhanceCache[cacheKey]) return enhanceCache[cacheKey];
  try {
    const resp = await fetch('/api/enhance-texture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: dataUrl }),
    });
    if(!resp.ok) throw new Error('enhance ' + resp.status);
    const { imageData } = await resp.json();
    if(imageData) { enhanceCache[cacheKey] = imageData; return imageData; }
  } catch(e) { console.warn('[enhance-texture] failed, using original:', e.message); }
  return null;
}

// Generation token shared by the material-apply pipelines. Each user apply
// (swatch click or diffuse upload) bumps it; any in-flight older apply bails
// after its awaits so the LAST action wins, not the last network response.
// Same pattern as E._roomLoadGen for room loads.
export let _applyGen = 0;

// Clone a loaded (shared, cached) texture with per-entry tiling — every mesh
// entry needs its own repeat, so the cached texture is never mutated directly.
export function _tiledClone(tex, physRepeat) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(physRepeat, physRepeat);
  t.needsUpdate = true;
  return t;
}

// Per-product default pattern scale — overrides the per-type default below.
//
// Since uvScaleFactor became a measured UV density (see metersPerUvUnit in
// model.js), this number has a physical meaning: the pattern repeats every
// BASE_TILE / scale metres, i.e. every 30cm at 1.0. That is uniform across
// every mesh and every product, so all three products share one value now —
// the old 2.0 / 2.5 / 2.0 spread existed only to compensate for the
// bounding-box tiling this replaced. 1.0 keeps the pattern at the size the
// (correctly unwrapped) chair cushion rendered at before this change.
export const PRODUCT_SCALE_DEFAULTS = { chair: 1.0, accent_chair: 1.0, sofa: 1.0 };

// Swap the assembled material onto the entry's mesh (array-aware) and, when the
// entry is the curtain representative, propagate it to every curtain panel.
export function _commitEntryMaterial(entry, mat) {
  if (Array.isArray(entry.mesh.material)) {
    const arr = [...entry.mesh.material];
    arr[entry.matIndex] = mat;
    entry.mesh.material = arr;
  } else {
    entry.mesh.material = mat;
  }
  if (entry._isCurtain) {
    E.curtainMeshEntries.forEach(ce => { if (ce !== entry) ce.mesh.material = mat; });
  }
}

export async function applySwatchToEntries(item, targetEntries, opts = {}) {
  if(!targetEntries || !targetEntries.length) { if(!opts.silent) showToast('Select a part →'); return; }

  // Enforce wood-zone exclusivity (see WOOD_ZONE_NAMES). Wood only lands on the
  // legs/frame; fabric only on upholstered parts. Reject or trim accordingly.
  {
    const woodZones = WOOD_ZONE_NAMES[appStore.getState().currentModelKey] || [];
    const { valid, rejected } = _filterEntriesForItem(item, targetEntries);
    if (!valid.length) {
      if(!opts.silent) showToast(item.type === 'wood'
        ? `Wood finish only applies to: ${woodZones.join(', ')}`
        : `${[...new Set(rejected.map(e => e.name))].join(', ')} takes a wood finish only`);
      return;
    }
    if (rejected.length) {
      const skipped = [...new Set(rejected.map(e => e.name))].join(', ');
      if(!opts.silent) showToast(item.type === 'wood'
        ? `Wood applies to ${woodZones.join(', ')} only — skipped ${skipped}`
        : `Skipped ${skipped} — wood-only part`);
      targetEntries = valid;
    }
  }

  const _gen = ++_applyGen;
  document.getElementById('loading').classList.add('on');
  document.getElementById('load-txt').textContent = 'Loading Texture…';

  const defaults = {
    wood:   { roughness:0.55, sheen:0.00, metalness:0.0, scale:1.5, norm:0.8 },
    vinyl:  { roughness:0.45, sheen:0.05, metalness:0.0, scale:4.0, norm:0.6 },
    fabric: { roughness:0.72, sheen:0.10, metalness:0.0, scale:3.5, norm:1.0 }, // Crypton performance fabric; also the default/fallback
  };
  const defs = { ...(item._defaults || defaults[item.type] || defaults.fabric) };
  // Per-product calibrated pattern-scale defaults win over the per-type
  // table above. Finder-analyzed custom items that already carry their own
  // _defaults.scale (from AI analysis / a manual edit) keep it.
  if (!item._defaults?.scale) {
    const productScale = PRODUCT_SCALE_DEFAULTS[appStore.getState().currentModelKey];
    if (productScale != null) defs.scale = productScale;
  }
  window._currentAppliedDiffUrl = (item._defaults && item._defaults.diffUrl) || item.img || null;
  setSlider('roughness', defs.roughness); setSlider('metalness', defs.metalness);
  setSlider('sheen', defs.sheen); setSlider('scale', defs.scale); setSlider('norm', defs.norm);
  ['brightness','roughness','metalness','sheen','scale','norm',
   'brightness-r','roughness-r','scale-r'].forEach(id=>{
    const el = document.getElementById('s-'+id);
    if(!el) return;
    if(id.startsWith('bright')) el.value=1;
    else if(id.includes('rough')||id==='s-roughness') el.value=defs.roughness;
    else if(id.includes('scale')) el.value=defs.scale;
    else if(id.includes('norm')) el.value=defs.norm;
  });
  setSliderVal('brightness',1); setSliderVal('roughness',defs.roughness);
  setSliderVal('metalness',defs.metalness); setSliderVal('sheen',defs.sheen,2);
  setSliderVal('scale',defs.scale,1); setSliderVal('norm',defs.norm,1);
  setSliderVal('brightness-r',1); setSliderVal('roughness-r',defs.roughness);
  setSliderVal('scale-r',defs.scale,1);

  // Update applied preview (both panels)
  const vendorLabel = item.series || (item.vendor==='mity' ? 'Wood Finish' : 'My Fabrics');
  // Remember what each part is wearing so the render captions can name the
  // fabric + colour per part (series = "Kimono", name = "Aragon"). isWood lets
  // the render label the upholstery only when summarising the whole piece.
  targetEntries.forEach(e => { e.appliedFabric = { name: item.name, series: vendorLabel, isWood: item.type === 'wood' }; });
  ['','room'].forEach(sfx=>{
    const n=document.getElementById('app-name'+(sfx?'-'+sfx:''));
    const v=document.getElementById('app-vend'+(sfx?'-'+sfx:''));
    const sw=document.getElementById('app-sw'+(sfx?'-'+sfx:''));
    if(n) n.textContent=item.name;
    if(v) v.textContent=vendorLabel;
    if(sw){
      sw.innerHTML=''; sw.style.background=item.hex||'#ccc';
      if(item.img){const ig=document.createElement('img');ig.src=item.img;ig.alt=item.name;ig.onerror=()=>{ig.remove();sw.style.background=item.hex||'#ccc'};sw.appendChild(ig);}
    }
    const rb=document.getElementById('app-replace-btn'+(sfx?'-'+sfx:''));
    if(rb) rb.style.display='flex';
  });

  try {
    if(item.type==='wood') {
      // Fetch PolyHaven metadata and diffuse in parallel
      const woodMaps = MATERIAL_MAPS.wood;
      const [{normUrl,roughUrl}, diffTex] = await Promise.all([
        getPolyMaps(POLY_IDS.wood),
        item.img ? tryLoadTex(item.img, true).catch(()=>null) : Promise.resolve(null),
      ]);
      // Load normal + roughness in parallel
      let [normTex, roughTex] = await Promise.all([
        normUrl  ? tryLoadTex(normUrl,  false).catch(()=>null) : Promise.resolve(null),
        roughUrl ? tryLoadTex(roughUrl, false).catch(()=>null) : Promise.resolve(null),
      ]);
      if(!normTex)  normTex  = await loadTexFirstSuccess(woodMaps.norm,  false);
      if(!roughTex) roughTex = await loadTexFirstSuccess(woodMaps.rough, false);
      if(_gen !== _applyGen) return; // superseded by a newer apply
      setBaseColor(item.hex);
      const S = appStore.getState().sliders;
      targetEntries.forEach(entry => {
        const mat = entry.greyMat;
        const physRepeat = S.scale*(entry.uvScaleFactor/BASE_TILE);
        if(diffTex){mat.map=_tiledClone(diffTex,physRepeat);mat.color.setRGB(Math.max(0.01,S.brightness),Math.max(0.01,S.brightness),Math.max(0.01,S.brightness));}
        else{mat.map=null;mat.color.copy(new THREE.Color(item.hex)).multiplyScalar(Math.max(0.01,S.brightness));}
        if(normTex){mat.normalMap=_tiledClone(normTex,physRepeat);mat.normalScale.set(S.norm,S.norm);}else{mat.normalMap=null;}
        if(roughTex){mat.roughnessMap=_tiledClone(roughTex,physRepeat);}else{mat.roughnessMap=null;}
        mat.roughness=S.roughness;mat.metalness=S.metalness;mat.sheen=S.sheen;mat.needsUpdate=true;
        _commitEntryMaterial(entry, mat);
        entry.mesh.userData._fabricName = item.name;
      });
      markDirty(); if(!opts.silent) showToast(item.name+' applied!');
      // Auto-save material snapshot so room view retains changes
      saveMaterialSnapshot();
      window._historyRecord?.();
      return;
    }

    const diffSrc = item._defaults?.diffUrl || item.img || null;

    // Resolve normal/roughness sources — our own Gemini-generated maps, one
    // pair per fabric series (reused across every color in that series), no
    // PolyHaven/AmbientCG involved. Finder-analyzed custom items may carry a
    // pre-resolved URL in _defaults; catalog items resolve by series, falling
    // back to type, then a generic fabric bucket.
    const matMaps = MATERIAL_MAPS[item.series] || MATERIAL_MAPS[item.type] || MATERIAL_MAPS.fabric;
    const normUrls  = item._defaults?.normUrl  ? [item._defaults.normUrl]  : matMaps.norm;
    const roughUrls = item._defaults?.roughUrl ? [item._defaults.roughUrl] : matMaps.rough;

    // Start loading norm/rough in the background — they don't depend on diffuse
    const normRoughPromise = Promise.all([
      loadTexFirstSuccess(normUrls,  false),
      loadTexFirstSuccess(roughUrls, false),
    ]);

    // Load diffuse, then run AI enhancement (Gemini image-to-image — cleans up
    // vendor swatch photos: seamless edges, neutral lighting, sharper weave)
    let diffTex = diffSrc ? await tryLoadTex(diffSrc, true).catch(()=>null) : null;

    // Fast replay (undo/redo): reuse the session's enhanced texture if it
    // exists; never re-run the enhancement pipeline (staff review M2).
    if (opts.fast && diffSrc && enhanceCache[diffSrc]) {
      const cachedTex = await tryLoadTex(enhanceCache[diffSrc], true).catch(() => null);
      if (cachedTex) diffTex = cachedTex;
    }

    if(diffTex && diffSrc && !opts.fast) {
      document.getElementById('load-txt').textContent = 'Enhancing Texture…';
      try {
        const currentDataUrl = texToDataUrl(diffTex);
        if(currentDataUrl) {
          let enhancedDataUrl = await enhanceTexture(currentDataUrl, diffSrc);
          if(enhancedDataUrl) {
            // Pin the enhanced colour back to the source swatch. The prompt asks
            // for colour accuracy but does not reliably deliver it: "remove
            // shadows, evenly lit" reads as "brighten" on a pale fabric.
            // Measured on Parlour "Seabreeze" (a light teal plaid) the enhanced
            // texture came back +4.2pp luminance and +6.5pp saturation, which is
            // what made the rendered cushion look washed out next to its swatch.
            // A dark fabric like Chaise "Persimmon" barely moved, so this cannot
            // be caught by spot-checking one swatch — hence a deterministic
            // correction rather than more prompt wording.
            enhancedDataUrl = await matchMeanColor(enhancedDataUrl, currentDataUrl);
            const enhancedTex = await tryLoadTex(enhancedDataUrl, true).catch(()=>null);
            if(enhancedTex) diffTex = enhancedTex;
          }
        }
      } catch(_) {}

      // Make the swatch tileable. Catalog swatches are vendor PHOTOS (550-900px)
      // whose opposite edges don't match, and they get tiled several times across
      // a cushion — so every tile boundary showed as a hard line, reading as a
      // regular grid of "patches" over the part. Until now this step only ran for
      // user uploads (handleDiffuseUpload), never for the catalog.
      //
      // Runs AFTER the AI enhancement, not before: this is a deterministic edge
      // cross-fade, so doing it last guarantees the edges actually match. Letting
      // Gemini run afterwards could reintroduce a mismatch.
      document.getElementById('load-txt').textContent = 'Making Seamless…';
      try {
        const seamlessKey = 'seamless-' + diffSrc;
        let seamlessUrl = enhanceCache[seamlessKey];
        if(!seamlessUrl) {
          const preUrl = texToDataUrl(diffTex);
          if(preUrl) {
            seamlessUrl = await makeSeamlessTexture(preUrl);
            if(seamlessUrl) enhanceCache[seamlessKey] = seamlessUrl;
          }
        }
        if(seamlessUrl) {
          const seamlessTex = await tryLoadTex(seamlessUrl, true).catch(()=>null);
          if(seamlessTex) diffTex = seamlessTex;
        }
      } catch(e) { console.warn('[seamless] failed, tiling raw:', e.message); }

      document.getElementById('load-txt').textContent = 'Applying…';
    }

    // Norm/rough should be done by now (ran during AI enhancement)
    const [normTex, roughTex] = await normRoughPromise;
    if(_gen !== _applyGen) return; // superseded by a newer apply

    setBaseColor(item.hex||'#ffffff');
    const S = appStore.getState().sliders;
    const baseColor = new THREE.Color(item.hex||'#ffffff');

    targetEntries.forEach(entry => {
      const mat = entry.greyMat;
      const physRepeat = S.scale*(entry.uvScaleFactor/BASE_TILE);
      mat.color.setRGB(1,1,1); mat.map=null;
      if(diffTex){mat.map=_tiledClone(diffTex,physRepeat);mat.color.setRGB(S.brightness,S.brightness,S.brightness);}
      else if(item.hex){mat.map=null;mat.color.copy(baseColor).multiplyScalar(Math.max(0.01,S.brightness));}
      else{mat.map=null;mat.color.setRGB(0.83*S.brightness,0.82*S.brightness,0.80*S.brightness);}
      if(normTex){mat.normalMap=_tiledClone(normTex,physRepeat);mat.normalScale.set(S.norm,S.norm);}else{mat.normalMap=null;}
      if(roughTex){mat.roughnessMap=_tiledClone(roughTex,physRepeat);}else{mat.roughnessMap=null;}
      mat.aoMap=null;
      mat.roughness=S.roughness;mat.metalness=S.metalness;mat.sheen=S.sheen;mat.needsUpdate=true;
      _commitEntryMaterial(entry, mat);
      entry.mesh.userData._fabricName = item.name;
    });
    markDirty(); if(!opts.silent) showToast(item.name+' applied!');
    // Auto-save material snapshot so room view retains changes
    saveMaterialSnapshot();
    window._historyRecord?.();
  } catch(e) {
    console.error(e); showToast('Failed to apply material');
  } finally {
    // Only the newest apply may clear the loading overlay
    if(_gen === _applyGen) document.getElementById('loading').classList.remove('on');
  }
}

// ── Custom diffuse image upload ─────────────────────────────────────────────
export function openDiffuseUpload() {
  document.getElementById('diffuse-upload-input').click();
}

(function() {
  // Deferred so the DOM element is guaranteed to exist
  document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('diffuse-upload-input');
    if (!inp) return;
    inp.addEventListener('change', async function() {
      const file = this.files?.[0];
      this.value = '';
      if (!file) return;
      await handleDiffuseUpload(file);
    });
  });
})();

// ── Seamless texture via canvas cross-fade blend ──────────────────────────
// `overlap` is how much of the image the two ends share when the min-error cut
// searches for its path (see minErrorCutTile below). Bigger gives the cut more
// room to find a well-matching route; smaller keeps more of the original image.
export async function makeSeamlessTexture(dataUrl, overlap = 0.18) {
  // Step 1: Remove directional lighting gradients (de-light)
  // Blur the image to get the local illumination field, then divide each pixel
  // by it so the result has uniform brightness throughout — eliminates the
  // dark-edge / bright-centre patches that make the cross-fade look blotchy.
  const normC = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      // 1024, not 512: this now runs on catalog swatches too, and the AI
      // enhancement upscales them to 1024 — capping at 512 would throw that
      // resolution away on every fabric in the library.
      const MAX = 1024;
      const sc = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const W = Math.round(img.naturalWidth * sc);
      const H = Math.round(img.naturalHeight * sc);

      const src = document.createElement('canvas');
      src.width = W; src.height = H;
      const srcCtx = src.getContext('2d');
      srcCtx.drawImage(img, 0, 0, W, H);

      // Large-radius blur = low-freq illumination field
      const blurR = Math.round(Math.max(W, H) * 0.13);
      const blurC = document.createElement('canvas');
      blurC.width = W; blurC.height = H;
      const blurCtx = blurC.getContext('2d');
      blurCtx.filter = `blur(${blurR}px)`;
      blurCtx.drawImage(src, 0, 0);

      const origD = srcCtx.getImageData(0, 0, W, H);
      const blurD = blurCtx.getImageData(0, 0, W, H);

      // Global mean luminance — target brightness after normalization
      let sumLum = 0;
      for (let i = 0; i < blurD.data.length; i += 4)
        sumLum += 0.299 * blurD.data[i] + 0.587 * blurD.data[i+1] + 0.114 * blurD.data[i+2];
      const meanLum = sumLum / (W * H) || 128;

      // Divide each pixel by local illumination to flatten shading
      const out = srcCtx.createImageData(W, H);
      for (let i = 0; i < origD.data.length; i += 4) {
        const bL = 0.299 * blurD.data[i] + 0.587 * blurD.data[i+1] + 0.114 * blurD.data[i+2];
        const f  = bL > 4 ? meanLum / bL : 1;
        out.data[i]   = Math.min(255, Math.max(0, Math.round(origD.data[i]   * f)));
        out.data[i+1] = Math.min(255, Math.max(0, Math.round(origD.data[i+1] * f)));
        out.data[i+2] = Math.min(255, Math.max(0, Math.round(origD.data[i+2] * f)));
        out.data[i+3] = origD.data[i+3];
      }
      srcCtx.putImageData(out, 0, 0);
      resolve(src);
    };
    img.crossOrigin = 'anonymous';
    img.src = dataUrl;
  });

  // Step 2: make it tile with a MIN-ERROR CUT, not a cross-fade.
  //
  // The previous approach blended the image with a half-offset copy of itself.
  // It tiled (edge mismatch 30.4 -> 10.0 on Chaise "Persimmon") but every pixel
  // in the blend band was a mix of two different parts of the fabric, so each
  // motif gained a translucent ghost twin. Narrowing the band shrank the
  // affected area but could not remove the effect — averaging two displaced
  // images always ghosts. An AI inpainting attempt was also tried and failed
  // (see git history; it left the seam intact and repainted the pattern).
  //
  // This instead uses the image-quilting min-error boundary cut (Efros &
  // Freeman): overlap the two ends, find the path through the overlap where
  // they disagree least, and hard-switch along it. Every output pixel comes
  // from exactly ONE source, so nothing is ever averaged and nothing ghosts.
  // The cut is invisible because it is routed through pixels that already
  // match. The tile ends up slightly smaller (by the overlap), which is
  // irrelevant here — it is tiled by UV repeat, not used at a fixed size.
  const cut = minErrorCutTile(normC, overlap);
  return cut.toDataURL('image/jpeg', 0.95);
}



// Rescale `imgUrl` per channel so its mean RGB matches `refUrl`. Used to undo
// the brightness/saturation drift the AI enhancement introduces while keeping
// the detail it adds. Gains are clamped so a pathological result can't blow the
// texture out; a well-behaved enhancement lands near 1.0 and is left alone.
async function matchMeanColor(imgUrl, refUrl) {
  try {
    const [img, ref] = await Promise.all([_loadImg(imgUrl), _loadImg(refUrl)]);
    const mi = _meanRGB(img), mr = _meanRGB(ref);
    const gain = [0, 1, 2].map(c => {
      if (mi[c] < 1) return 1;
      return Math.max(0.7, Math.min(1.4, mr[c] / mi[c]));
    });
    if (gain.every(g => Math.abs(g - 1) < 0.01)) return imgUrl; // already matched

    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i]   = Math.min(255, d.data[i]   * gain[0]);
      d.data[i+1] = Math.min(255, d.data[i+1] * gain[1]);
      d.data[i+2] = Math.min(255, d.data[i+2] * gain[2]);
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL('image/jpeg', 0.95);
  } catch (e) {
    console.warn('[colour-match] skipped:', e.message);
    return imgUrl;
  }
}

function _loadImg(src) {
  return new Promise((ok, err) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => ok(im);
    im.onerror = () => err(new Error('image load failed'));
    im.src = src;
  });
}

function _meanRGB(img) {
  const c = document.createElement('canvas');
  const W = Math.min(256, img.naturalWidth), H = Math.min(256, img.naturalHeight);
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; }
  const n = d.length / 4;
  return [r/n, g/n, b/n];
}

// ── Min-error boundary cut (image quilting) ────────────────────────────────
// Makes a texture tile by overlapping its two ends and cutting along the path
// where they disagree least. Output is (W-o) x (H-o). Every pixel comes from a
// single source — no averaging, hence no ghosting.

// Least-cost monotonic path through an overlap band, one cut position per row.
// cost[y][x] is how badly the two sources disagree at that pixel; the path may
// step at most one column per row so the cut stays connected.
function _minCostPath(cost, rows, cols) {
  const acc = new Float64Array(rows * cols);
  acc.set(cost.subarray(0, cols), 0);
  for (let y = 1; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let best = acc[(y - 1) * cols + x];
      if (x > 0)        best = Math.min(best, acc[(y - 1) * cols + x - 1]);
      if (x < cols - 1) best = Math.min(best, acc[(y - 1) * cols + x + 1]);
      acc[y * cols + x] = cost[y * cols + x] + best;
    }
  }
  // Walk back from the cheapest end cell.
  const path = new Int32Array(rows);
  let bx = 0;
  for (let x = 1; x < cols; x++)
    if (acc[(rows - 1) * cols + x] < acc[(rows - 1) * cols + bx]) bx = x;
  path[rows - 1] = bx;
  for (let y = rows - 2; y >= 0; y--) {
    let best = bx;
    for (const nx of [bx - 1, bx, bx + 1]) {
      if (nx < 0 || nx >= cols) continue;
      if (acc[y * cols + nx] < acc[y * cols + best]) best = nx;
    }
    bx = best;
    path[y] = bx;
  }
  return path;
}

// Seam one axis: returns ImageData of width (W-o), cutting between the image's
// left end and its right end. Run once, transpose, run again for the other axis.
function _cutAxis(src, W, H, o) {
  const outW = W - o;
  const out = new Uint8ClampedArray(outW * H * 4);

  // In the overlap (output x in [0, o)), two candidates exist:
  //   A = src[x]          — the image's left end
  //   B = src[x + outW]   — its right end, wrapped round
  // Left of the cut we take B (so the left edge continues from the right edge),
  // right of the cut we take A.
  const cost = new Float64Array(H * o);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < o; x++) {
      const ia = (y * W + x) * 4;
      const ib = (y * W + x + outW) * 4;
      cost[y * o + x] =
        Math.abs(src[ia] - src[ib]) +
        Math.abs(src[ia + 1] - src[ib + 1]) +
        Math.abs(src[ia + 2] - src[ib + 2]);
    }
  }
  const path = _minCostPath(cost, H, o);

  for (let y = 0; y < H; y++) {
    const cutX = path[y];
    for (let x = 0; x < outW; x++) {
      const useB = x < cutX;
      const si = (y * W + (useB ? x + outW : x)) * 4;
      const di = (y * outW + x) * 4;
      out[di] = src[si]; out[di+1] = src[si+1]; out[di+2] = src[si+2]; out[di+3] = src[si+3];
    }
  }
  return { data: out, w: outW, h: H };
}

function _transpose(data, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = (x * h + y) * 4;
      out[di] = data[si]; out[di+1] = data[si+1]; out[di+2] = data[si+2]; out[di+3] = data[si+3];
    }
  return { data: out, w: h, h: w };
}

export function minErrorCutTile(canvas, overlap = 0.18) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const src = ctx.getImageData(0, 0, W, H).data;
  const o = Math.max(8, Math.round(Math.min(W, H) * overlap));

  const h1 = _cutAxis(src, W, H, o);                        // seam left↔right
  const t1 = _transpose(h1.data, h1.w, h1.h);               // now rows are columns
  const h2 = _cutAxis(t1.data, t1.w, t1.h, o);              // seam top↔bottom
  const fin = _transpose(h2.data, h2.w, h2.h);

  const out = document.createElement('canvas');
  out.width = fin.w; out.height = fin.h;
  const oc = out.getContext('2d');
  const img = oc.createImageData(fin.w, fin.h);
  img.data.set(fin.data);
  oc.putImageData(img, 0, 0);
  return out;
}

export async function handleDiffuseUpload(file) {
  // Use checked parts if any are selected, otherwise fall back to all parts.
  // E.meshEntries is rebuilt on room enter (_rebuildMeshEntries), so it is the
  // correct source in both modes.
  const all = E.meshEntries;
  const checked = all.filter(e => e.checked);
  const entries = checked.length ? checked : all.filter(e => !e._isCurtain);
  if (!entries.length) { showToast('Load a model first'); return; }
  const _gen = ++_applyGen; // shares the apply generation with applySwatchToEntries

  // Show processing state on the replace button
  const replBtn = document.getElementById('app-replace-btn');
  if (replBtn) replBtn.classList.add('processing');

  const rawUrl = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = ev => resolve(ev.target.result);
    reader.readAsDataURL(file);
  });

  showToast('Making seamless…');
  let dataUrl = rawUrl;
  try { dataUrl = await makeSeamlessTexture(rawUrl); } catch(_) {}

  showToast('Enhancing texture…');
  try {
    const cacheKey = 'upload-' + file.name + '-' + file.size;
    const enhanced = await enhanceTexture(dataUrl, cacheKey);
    if (enhanced) dataUrl = enhanced;
  } catch(_) {}

  if (replBtn) replBtn.classList.remove('processing');
  window._currentAppliedDiffUrl = dataUrl;

  const tex = await tryLoadTex(dataUrl, true).catch(() => null);
  if (!tex) { showToast('Could not load image'); return; }
  if (_gen !== _applyGen) return; // superseded by a newer apply

  // Replace diffuse only — keep existing normal/roughness maps intact
  const S = appStore.getState().sliders;
  entries.forEach(entry => {
    const mat = entry.greyMat;
    const physRepeat = S.scale * (entry.uvScaleFactor / BASE_TILE);
    mat.map = _tiledClone(tex, physRepeat);
    mat.color.setRGB(Math.max(0.01, S.brightness), Math.max(0.01, S.brightness), Math.max(0.01, S.brightness));
    mat.needsUpdate = true;
    if (Array.isArray(entry.mesh.material)) {
      const arr = [...entry.mesh.material];
      arr[entry.matIndex] = mat;
      entry.mesh.material = arr;
    }
    entry.mesh.userData._fabricName = 'Custom Image';
  });

  // Update app-sw preview in both panels
  ['', 'room'].forEach(sfx => {
    const sw = document.getElementById('app-sw' + (sfx ? '-' + sfx : ''));
    if (!sw) return;
    sw.innerHTML = '';
    sw.style.background = 'transparent';
    const img = document.createElement('img');
    img.src = dataUrl; img.alt = 'Custom';
    sw.appendChild(img);
  });

  markDirty();
  showToast('Seamless texture applied!');
  saveMaterialSnapshot();
  window._historyRecord?.();
}

// ── Drag & Drop ────────────────────────────────────────────────────────────
export function initDragDrop() {
  const vwrap = document.getElementById('viewport-wrap');

  document.addEventListener('pointermove', e => {
    if(!E.dragActive) return;
    E.ghost.style.left = e.clientX + 'px';
    E.ghost.style.top  = e.clientY + 'px';
    // Check if over canvas
    const rect = vwrap.getBoundingClientRect();
    if(e.clientX>=rect.left && e.clientX<=rect.right && e.clientY>=rect.top && e.clientY<=rect.bottom) {
      vwrap.classList.add('drag-over');
      document.getElementById('drop-hint').classList.add('show');
      highlightHoveredMesh(e, rect);
    } else {
      vwrap.classList.remove('drag-over');
      document.getElementById('drop-hint').classList.remove('show');
      clearMeshHighlight();
    }
  });

  document.addEventListener('pointerup', e => {
    if(!E.dragActive) return;
    E.dragActive = false;
    E.ghost.style.display = 'none';
    vwrap.classList.remove('drag-over');
    document.getElementById('drop-hint').classList.remove('show');

    const rect = vwrap.getBoundingClientRect();
    if(e.clientX>=rect.left && e.clientX<=rect.right && e.clientY>=rect.top && e.clientY<=rect.bottom) {
      dropFabricOnCanvas(e, rect);
    }
    clearMeshHighlight();
    E.dragItem = null;
  });
}

let hoveredEntry = null;
export function screenToNDC(e, rect) {
  return {
    x: ((e.clientX - rect.left) / rect.width)  * 2 - 1,
    y: -((e.clientY - rect.top)  / rect.height) * 2 + 1,
  };
}
export function getHitEntry(e, rect) {
  const ndc = screenToNDC(e, rect);
  mouse.set(ndc.x, ndc.y);
  raycaster.setFromCamera(mouse, E.camera);

  // Build target mesh list: furniture + all curtain meshes in room mode
  const allEntries = appStore.getState().roomMode
    ? [...E.meshEntries, ...E.curtainMeshEntries.filter(c => !E.meshEntries.includes(c))]
    : E.meshEntries;
  const meshes = allEntries.map(en=>en.mesh).filter(Boolean);
  const hits = raycaster.intersectObjects(meshes, true);
  if(!hits.length) return null;
  const hitMesh = hits[0].object;

  // Walk up parent chain to find matching entry (handles deep GLB hierarchies)
  let obj = hitMesh;
  while (obj) {
    const found = allEntries.find(en => en.mesh === obj);
    if (found) {
      // If it's a non-representative curtain mesh, return the representative instead
      if (found._isCurtain && E.curtainMeshEntries[0] && found !== E.curtainMeshEntries[0]) {
        return E.meshEntries.find(en => en._isCurtain) || E.curtainMeshEntries[0];
      }
      return found;
    }
    obj = obj.parent;
  }
  return null;
}
// A mesh split across many material slots (e.g. chair.glb's Frame) has one
// meshEntry per slot, all sharing the same display name — treat them as one
// real part for hover/apply feedback, not just whichever slot the ray hit.
export function entryGroup(entry) {
  if (!entry) return [];
  return E.meshEntries.filter(en => en.name === entry.name);
}

let hoveredGroup = [];
export function highlightHoveredMesh(e, rect) {
  const entry = getHitEntry(e, rect);
  if(entry === hoveredEntry) return;
  clearMeshHighlight();
  hoveredEntry = entry;
  hoveredGroup = entryGroup(entry);
  hoveredGroup.forEach(en => {
    en.greyMat.emissive = new THREE.Color(0x2d4a3e);
    en.greyMat.emissiveIntensity = 0.35;
    en.greyMat.needsUpdate = true;
  });
  if (hoveredGroup.length) markDirty();
}
export function clearMeshHighlight() {
  if(hoveredGroup.length) {
    hoveredGroup.forEach(en => {
      en.greyMat.emissive = new THREE.Color(0);
      en.greyMat.emissiveIntensity = 0;
      en.greyMat.needsUpdate = true;
    });
    markDirty();
    hoveredGroup = [];
  }
  hoveredEntry = null;
}
export async function dropFabricOnCanvas(e, rect) {
  if(!E.dragItem) return;

  if(appStore.getState().roomMode) {
    // In room mode: prefer the piece(s) the user explicitly selected in the piece list.
    // Fall back to raycast hit (expanded to its full name-group) so direct-drop-on-mesh still works.
    const selectedEntries = E.meshEntries.filter(en => en.pieceSelected);
    const targets = selectedEntries.length ? selectedEntries : entryGroup(getHitEntry(e, rect));
    if(!targets.length) { showToast('Select a part in the list, then drop'); return; }
    await applySwatchToEntries(E.dragItem.item, targets);
    return;
  }

  const entry = getHitEntry(e, rect);
  if(!entry) { showToast('Drop on a furniture part'); return; }
  const targets = entryGroup(entry);
  // Select only the dropped-on part (its whole name-group) — leave other entries' materials intact
  E.meshEntries.forEach(en => { en.checked = false; });
  targets.forEach(en => {
    en.checked = true;
    if(Array.isArray(en.mesh.material)){const matArr=[...en.mesh.material];if(en.matIndex>=0&&en.matIndex<matArr.length){matArr[en.matIndex]=en.greyMat;en.mesh.material=matArr;}}else{en.mesh.material=en.greyMat;}
  });
  window.buildMeshList();
  window._refreshZoneLabelStates();
  await applySwatchToEntries(E.dragItem.item, targets);
}

export function startDrag(e, gi, ii) {
  const item = LIBRARY[appStore.getState().currentModelKey][gi].items[ii];
  E.dragItem = {gi, ii, item};
  E.dragActive = true;
  E.ghost.style.display = 'block';
  E.ghost.style.left = e.clientX + 'px';
  E.ghost.style.top  = e.clientY + 'px';
  if(item.img) {
    E.ghostImg.src = item.img;
    E.ghostImg.style.display = 'block';
    E.ghost.style.background = 'none';
  } else {
    E.ghostImg.style.display = 'none';
    E.ghost.style.background = item.hex || '#aaa';
  }
}

// ── Slider handlers ───────────────────────────────────────────────────────
export function updateBrightness(val) {
  setSlider('brightness', val);
  ['v-brightness','v-brightness-r'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=val.toFixed(2); });
  E.meshEntries.forEach(entry => {
    if(!entry.checked && !entry.pieceSelected) return;
    const mat = entry.greyMat;
    const safeVal = Math.max(0.01, val);
    if(mat.map) mat.color.setRGB(safeVal,safeVal,safeVal);
    else { const c=new THREE.Color(appStore.getState().baseColorHex||'#ffffff'); mat.color.copy(c).multiplyScalar(safeVal); }
    mat.needsUpdate = true;
  });
  markDirty();
}
export function applyProp(prop, val) {
  const valEl = document.getElementById('v-'+prop);
  if(valEl) valEl.textContent = val.toFixed(2);
  setSlider(prop, val); // prop is only ever roughness/metalness/sheen (see oninput handlers)
  E.meshEntries.forEach(entry => {
    if(!entry.checked && !entry.pieceSelected) return;
    if(prop==='sheen') entry.greyMat.sheen=val;
    else entry.greyMat[prop]=val;
    entry.greyMat.needsUpdate=true;
  });
  markDirty();
}
export function updateTexScale(val) {
  setSlider('scale', val);
  ['v-scale','v-scale-r'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=val.toFixed(1); });
  E.meshEntries.forEach(entry => {
    if(!entry.checked && !entry.pieceSelected) return;
    const physRepeat = val*(entry.uvScaleFactor/BASE_TILE);
    const mat = entry.greyMat;
    if(mat.map)         { mat.map.repeat.set(physRepeat,physRepeat); mat.map.needsUpdate=true; }
    if(mat.normalMap)   { mat.normalMap.repeat.set(physRepeat,physRepeat); mat.normalMap.needsUpdate=true; }
    if(mat.roughnessMap){ mat.roughnessMap.repeat.set(physRepeat,physRepeat); mat.roughnessMap.needsUpdate=true; }
    if(mat.aoMap)       { mat.aoMap.repeat.set(physRepeat,physRepeat); mat.aoMap.needsUpdate=true; }
    mat.needsUpdate=true;
  });
  markDirty();
}
export function updateNormScale(val) {
  setSlider('norm', val);
  const el = document.getElementById('v-norm'); if(el) el.textContent=val.toFixed(1);
  E.meshEntries.forEach(entry => {
    if(!entry.checked && !entry.pieceSelected) return;
    if(entry.greyMat.normalMap){ entry.greyMat.normalScale.set(val,val); entry.greyMat.needsUpdate=true; }
  });
  markDirty();
}

