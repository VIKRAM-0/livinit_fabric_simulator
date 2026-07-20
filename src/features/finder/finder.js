import { E, showToast, escapeHtml } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { setFinder, addCustomFabric } from '../../lib/actions.js';
import { CUSTOM_FABRIC_ITEMS } from '../../lib/catalog.js';
// Fabric Finder modal: upload a fabric photo, Gemini-vision AI analysis,
// preview on model / save to "My Fabrics". The PolyHaven/AmbientCG search
// tab has been removed — the catalog covers the fixed fabric library, this
// is only for one-off custom photos.
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── Fabric Finder ─────────────────────────────────────────────────────────
// Finder modal UI state lives in appStore.getState().finder — see src/store.js.
// Currently applied diffuse URL (tracks custom uploads too). Written by
// materials.js (applySwatchToEntries / handleDiffuseUpload) — apply-pipeline
// state, not finder state, so it stays a plain global.
window._currentAppliedDiffUrl = null;

export function openFabricFinder() {
  document.getElementById('finder-overlay').classList.add('open');
  setTimeout(() => document.getElementById('finder-name').focus(), 80);
}

export function closeFabricFinder() {
  document.getElementById('finder-overlay').classList.remove('open');
  clearFinderImage({ stopPropagation:()=>{} });
  document.getElementById('finder-name').value = '';
  document.getElementById('finder-material-type').value = '';
  document.getElementById('finder-scale-val').value = '10';
  document.getElementById('finder-props-rows').style.display = 'none';
  document.getElementById('finder-props-rows').innerHTML = '';
  const ht = document.getElementById('finder-hint-text-upload');
  if (ht) ht.style.display = '';
  document.getElementById('finder-right-title').textContent = 'Preview';
}

export function updateFinderMode() {
  const hasImg = !!appStore.getState().finder.imgData;
  const t = document.getElementById('finder-btn-txt');
  if(t) t.textContent = hasImg ? 'Analyze Fabric' : 'Analyze & Add';
  const saveBtn = document.getElementById('finder-save-btn');
  if (saveBtn) saveBtn.disabled = !hasImg;
  if (!hasImg) {
    setFinder({ analyzed: null });
    const pmBtn = document.getElementById('finder-prev-model-btn');
    if (pmBtn) { pmBtn.style.display = 'none'; pmBtn.disabled = false; }
  }
}

export function handleFinderImage(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    setFinder({ imgData: e.target.result.split(',')[1] });
    const dPreview = document.getElementById('finder-img-preview');
    dPreview.src = e.target.result; dPreview.style.display = 'block';
    document.getElementById('finder-drop-content').style.display = 'none';
    document.getElementById('finder-drop-zone').classList.add('has-img');
    const fullPrev = document.getElementById('finder-preview-full');
    fullPrev.src = e.target.result; fullPrev.style.display = 'block';
    document.getElementById('finder-preview-placeholder').style.display = 'none';
    document.getElementById('finder-right-dot').classList.add('active');
    document.getElementById('finder-right-title').textContent = 'Uploaded image';
    document.getElementById('finder-props-rows').style.display = 'none';
    updateFinderMode();
  };
  reader.readAsDataURL(file);
}

export function clearFinderImage(e) {
  e.stopPropagation();
  setFinder({ imgData: null });
  const dPreview = document.getElementById('finder-img-preview');
  if(dPreview){ dPreview.src = ''; dPreview.style.display = 'none'; }
  const dc = document.getElementById('finder-drop-content');
  if(dc) dc.style.display = '';
  const dz = document.getElementById('finder-drop-zone');
  if(dz) dz.classList.remove('has-img');
  const fi = document.getElementById('finder-img-input');
  if(fi) fi.value = '';
  const fullPrev = document.getElementById('finder-preview-full');
  if(fullPrev){ fullPrev.src = ''; fullPrev.style.display = 'none'; }
  const ph = document.getElementById('finder-preview-placeholder');
  if(ph) ph.style.display = '';
  const dot = document.getElementById('finder-right-dot');
  if(dot) dot.classList.remove('active');
  const rt = document.getElementById('finder-right-title');
  if(rt) rt.textContent = 'Preview';
  const pr = document.getElementById('finder-props-rows');
  if(pr){ pr.style.display = 'none'; pr.innerHTML = ''; }
  updateFinderMode();
}

// Save without AI (image required)
export async function saveAsMaterial() {
  // Read finder state + inputs once at event time.
  const F = appStore.getState().finder;
  if (!F.imgData) return;
  let name = document.getElementById('finder-name').value.trim()
    || F.analyzed?.name
    || ('Custom Fabric ' + (CUSTOM_FABRIC_ITEMS.length + 1));
  let type = document.getElementById('finder-material-type').value
    || F.analyzed?.type
    || 'fabric';
  const scale = parseFloat(document.getElementById('finder-scale-val').value) || F.analyzed?.aiProps?.scale || 10;
  const aiProps = F.analyzed?.aiProps || { roughness:0.72, sheen:0.1, metalness:0.0, norm:1.0 };
  const diffUrl = 'data:image/jpeg;base64,' + F.imgData;
  addCustomFabric({
    name, img: diffUrl, type,
    hex: F.analyzed?.hex || '#c8c0b8', vendor:'custom', series:'My Fabrics',
    _defaults: { ...aiProps, scale, diffUrl },
  });
  window.buildLibrary();
  showToast('✓ ' + name + ' saved to My Fabrics');
  closeFabricFinder();
}

export async function previewAnalyzedOnModel() {
  // Read finder state + inputs once at event time.
  const F = appStore.getState().finder;
  if (!F.imgData) return;
  const btn = document.getElementById('finder-prev-model-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }

  const name    = document.getElementById('finder-name').value.trim() || F.analyzed?.name || 'Custom Fabric';
  const type    = document.getElementById('finder-material-type').value || F.analyzed?.type || 'fabric';
  const aiProps = F.analyzed?.aiProps || { roughness:0.72, sheen:0.1, metalness:0.0, scale:10.0, norm:1.0 };

  let dataUrl = 'data:image/jpeg;base64,' + F.imgData;
  try {
    showToast('Making seamless…');
    dataUrl = await window.makeSeamlessTexture(dataUrl);
  } catch(_) {}

  const previewItem = {
    name, img: dataUrl, type,
    hex: F.analyzed?.hex || '#c8c0b8', vendor:'custom', series:'My Fabrics',
    _defaults: { ...aiProps, diffUrl: dataUrl },
  };
  const checked = E.meshEntries.filter(e => e.checked);
  const previewTargets = checked.length ? checked : E.meshEntries.filter(e => !e._isCurtain);
  if (previewTargets.length) await window.applySwatchToEntries(previewItem, previewTargets);

  setFinder({ pendingUploadPreview: { name, type, aiProps, diffUrl: dataUrl }, pendingResult: null });
  closeFabricFinder();
  showConfirmBar(name);
}

// Entry point — requires an uploaded photo (no more search-by-keyword path)
export async function analyzeAndAddFabric() {
  if (!appStore.getState().finder.imgData) { showToast('Upload a fabric photo first'); return; }
  await _analyzeImageAndAdd();
}

// ── Image path: AI analysis ────────────────────────────────────────────────
export async function _analyzeImageAndAdd() {
  const btn = document.getElementById('finder-btn');
  btn.disabled = true;
  document.getElementById('finder-btn-txt').textContent = 'Analyzing…';

  // Read finder state + inputs once at event time.
  const imgData = appStore.getState().finder.imgData;
  try {
    let name    = document.getElementById('finder-name').value.trim();
    let type    = document.getElementById('finder-material-type').value;
    const userScale = parseFloat(document.getElementById('finder-scale-val').value) || null;
    let aiProps = { roughness:0.72, sheen:0.1, metalness:0.0, scale:userScale||10.0, norm:1.0 };
    let hex     = '#c8c0b8';

    const hasApi = await _checkEndpoint('/api/find-fabric');
    if (hasApi) {
      try {
        const r = await fetch('/api/find-fabric', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ imageData: imgData }),
          signal: AbortSignal.timeout(22000),
        });
        if (r.ok) {
          const d = await r.json();
          if (!name && d.name)            name = d.name;
          if (!type && d.type)            type = d.type;
          if (d.roughness !== undefined)  aiProps.roughness = +d.roughness;
          if (d.sheen     !== undefined)  aiProps.sheen     = +d.sheen;
          if (d.metalness !== undefined)  aiProps.metalness = +d.metalness;
          if (!userScale && d.scale !== undefined) {
            aiProps.scale = +d.scale;
            document.getElementById('finder-scale-val').value = d.scale;
          }
          if (d.norm !== undefined)       aiProps.norm = +d.norm;
          if (d.hex)                      hex = d.hex;
          _showFinderAnalysis({ ...d, name: name || d.name, type: type || d.type });
        }
      } catch(e) { console.warn('AI analysis skipped:', e.message); }
    }

    if (!name) name = 'Custom Fabric ' + (CUSTOM_FABRIC_ITEMS.length + 1);
    if (!type) type = 'fabric';

    // Store result — user clicks Save or Preview on Model to finalise
    setFinder({ analyzed: { name, type, hex, aiProps, imgData } });
    const pmBtn = document.getElementById('finder-prev-model-btn');
    if (pmBtn) { pmBtn.style.display = 'flex'; pmBtn.disabled = false; }
    showToast('AI analysis done — click Preview or Save');

  } catch(e) {
    console.error('_analyzeImageAndAdd:', e);
    showToast('Analysis failed');
  } finally {
    btn.disabled = false;
    document.getElementById('finder-btn-txt').textContent = 'Analyze Fabric';
  }
}

// ── Floating confirm bar ──────────────────────────────────────────────────
// Appears after previewAnalyzedOnModel() so the user can commit the preview
// to "My Fabrics" without reopening the modal.
export function showConfirmBar(name) {
  document.getElementById('fcb-name').textContent = name;
  document.getElementById('finder-confirm-bar').classList.add('visible');
}
export function hideConfirmBar() {
  document.getElementById('finder-confirm-bar').classList.remove('visible');
  setFinder({ pendingUploadPreview: null });
}
export async function confirmAddFromBar() {
  // Capture state before hideConfirmBar clears it
  const pu = appStore.getState().finder.pendingUploadPreview;
  if (!pu) { hideConfirmBar(); return; }
  // _currentAppliedDiffUrl tracks any custom image the user may have swapped in after previewing
  const finalDiffUrl = window._currentAppliedDiffUrl || pu.diffUrl || null;
  const name = pu.name || ('Custom Fabric ' + (CUSTOM_FABRIC_ITEMS.length + 1));
  const type = pu.type || 'fabric';

  hideConfirmBar();
  const S = appStore.getState().sliders;
  addCustomFabric({
    name, img: finalDiffUrl, type, hex: '#c8c0b8', vendor:'custom', series:'My Fabrics',
    _defaults: {
      // Save the CURRENT slider state — not the original fabric defaults
      roughness: S.roughness, sheen: S.sheen, metalness: S.metalness,
      scale: S.scale, norm: S.norm,
      diffUrl: finalDiffUrl,
    },
  });
  window.buildLibrary();
  showToast('✓ ' + name + ' saved to My Fabrics');
}

export function _showFinderAnalysis(d) {
  const el = document.getElementById('finder-props-rows');
  if (!el) return;
  const typeLabel = escapeHtml((d.type || 'fabric').replace(/_/g, ' '));
  const hex = escapeHtml(d.hex || '#c8c0b8');
  const roughness = (+d.roughness || 0.72).toFixed(2);
  const scale = (+d.scale || 10).toFixed(1);
  el.innerHTML = `
    <div class="finder-analysis-type-badge">
      <span class="finder-type-ico">◈</span>
      <span class="finder-type-lbl">${typeLabel}</span>
      <span class="finder-type-sub">AI Detected</span>
    </div>
    <div class="finder-prop-row">
      <div class="finder-prop-row-lbl">
        <div class="finder-prop-dot" style="background:${hex}"></div>Color
      </div>
      <div class="finder-prop-row-val" style="font-size:10px;letter-spacing:.04em">${hex.toUpperCase()}</div>
    </div>
    <div class="finder-prop-row">
      <div class="finder-prop-row-lbl">Roughness &amp; Normal</div>
      <div class="finder-prop-row-muted">${roughness} · Auto Generate</div>
    </div>
    <div class="finder-prop-row">
      <div class="finder-prop-row-lbl">Scale</div>
      <div class="finder-prop-row-val">${scale}</div>
    </div>
    ${d.description ? `<div style="font-size:10px;color:var(--text-muted);font-style:italic;padding:3px 2px;line-height:1.5">${escapeHtml(d.description)}</div>` : ''}
  `;
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = '5px';
  const rt = document.getElementById('finder-right-title');
  if(rt) rt.textContent = d.name || 'Detected material';
  const rdot = document.getElementById('finder-right-dot');
  if(rdot) rdot.classList.add('active');
  const ht = document.getElementById('finder-hint-text-upload');
  if(ht) ht.style.display = 'none';
}

export async function _checkEndpoint(path) {
  try {
    const r = await fetch(path, { method:'HEAD', signal: AbortSignal.timeout(3000) });
    return r.status !== 404;
  } catch(_) { return false; }
}

// Close finder on Escape
