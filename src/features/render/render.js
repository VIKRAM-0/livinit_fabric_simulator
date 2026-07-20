import { E, showToast, escapeHtml, markDirty } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
// AI render + View in My Room + result modal
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── AI Render ─────────────────────────────────────────────────────────────
// Snapshot E.camera + background/clear-color state around an offscreen capture.
// Returns split restorers because renderScene and the capture paths restore in
// different orders (each preserved verbatim from the original inline blocks).
export function _saveCaptureState() {
  const savedSph = { ...E.sph };
  const savedTgt = E.tgt.clone();
  const savedBg = E.scene.background;
  const savedClear = E.renderer.getClearColor(new THREE.Color()).clone();
  const savedClearAlpha = E.renderer.getClearAlpha();
  return {
    restoreCamera() { E.sph = savedSph; E.tgt.copy(savedTgt); window.camUpdate(); },
    restoreBackground() { E.scene.background = savedBg; E.renderer.setClearColor(savedClear, savedClearAlpha); },
  };
}

// Force two fresh frames (dirty-flag loop flushed) and grab the canvas.
export async function _captureFrame(waitA, waitB, quality) {
  E.renderer.render(E.scene, E.camera);
  await new Promise(r => setTimeout(r, waitA));
  E.renderer.render(E.scene, E.camera);
  await new Promise(r => setTimeout(r, waitB));
  return E.renderer.domElement.toDataURL('image/jpeg', quality);
}

// Shared skeleton for the two "clean E.scene" captures: hide room props (keeping
// configured curtains), neutral warm-white background, position E.camera via
// `frame()`, capture, then restore everything.
export async function _captureCleanScene(frame) {
  const saved = _saveCaptureState();
  const restoreRoom = _vimrHideRoomExceptCurtains();

  const bg = new THREE.Color(0xf5f2ee);
  E.scene.background = bg;
  E.renderer.setClearColor(bg, 1);

  frame();
  window.camUpdate();

  const dataUrl = await _captureFrame(80, 40, 0.92);

  restoreRoom();
  saved.restoreBackground();
  saved.restoreCamera();
  markDirty();

  return dataUrl;
}

// ── Render collage ────────────────────────────────────────────────────────
// Four-panel e-commerce sheet: the AI-rendered hero in a living room, a close
// crop of the backrest fabric, the same for the seat cushion, and the piece
// from a second angle. Only panel 1 costs an API round-trip — the three detail
// shots are direct captures of the 3D scene, which is both faster and sharper
// than asking a model to invent close-ups it cannot see.

// Point the camera at whichever parts match `nameRe`, filling the frame.
// Returns false when the product has no such part, so the caller can substitute.
function _framePart(nameRe, theta, phi, fill = 0.85) {
  const entries = E.meshEntries.filter(e => nameRe.test(e.name) && e.mesh);
  if (!entries.length) return false;
  const box = new THREE.Box3();
  entries.forEach(e => box.expandByObject(e.mesh));
  if (box.isEmpty()) return false;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  E.tgt.copy(c);
  // Distance from the part's largest dimension — smaller `fill` crops tighter.
  E.sph = { theta, phi, r: Math.max(s.x, s.y, s.z) * fill };
  window.camUpdate();
  return true;
}

function _frameWhole(theta, phi, r) {
  const box = new THREE.Box3().setFromObject(E.currentModel);
  E.tgt.copy(box.getCenter(new THREE.Vector3()));
  const s = box.getSize(new THREE.Vector3());
  E.sph = { theta, phi, r: Math.max(s.x, s.y, s.z) * r };
  window.camUpdate();
}

// Compose the panels into one 2x2 sheet with captions.
function _composeCollage(panels, title) {
  const CELL = 640, PAD = 12, CAP = 34, HEAD = 40;
  const W = CELL * 2 + PAD * 3;
  const H = HEAD + (CELL + CAP) * 2 + PAD * 3;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f5f2';
  ctx.fillRect(0, 0, W, H);

  panels.forEach((p, i) => {
    const col = i % 2, row = (i / 2) | 0;
    const x = PAD + col * (CELL + PAD);
    const y = HEAD + PAD + row * (CELL + CAP + PAD);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, CELL, CELL + CAP);
    if (p.img) {
      // Cover-fit so every panel is square regardless of source aspect.
      const iw = p.img.naturalWidth, ih = p.img.naturalHeight;
      const sc = Math.max(CELL / iw, CELL / ih);
      const dw = iw * sc, dh = ih * sc;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, CELL, CELL); ctx.clip();
      ctx.drawImage(p.img, x + (CELL - dw) / 2, y + (CELL - dh) / 2, dw, dh);
      ctx.restore();
    }
    ctx.fillStyle = '#111';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.label, x + 14, y + CELL + CAP / 2);
  });

  if (title) {
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, PAD + 2, HEAD / 2 + 4);
  }
  return c.toDataURL('image/jpeg', 0.94);
}

function _loadImg(src) {
  return new Promise(ok => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => ok(im);
    im.onerror = () => ok(null);   // a missing panel renders blank, not a crash
    im.src = src;
  });
}

export async function renderCollage() {
  if (!E.currentModel) { showToast('Load a model first!'); return; }
  const loading = document.getElementById('loading');
  const label = document.getElementById('load-txt');
  loading.classList.add('on');

  const saved = _saveCaptureState();
  const restoreRoom = _vimrHideRoomExceptCurtains();
  const savedBg = E.scene.background;
  const bg = new THREE.Color(0xf7f5f2);
  E.scene.background = bg;
  E.renderer.setClearColor(bg, 1);

  try {
    // Panel 1 — hero, then AI-rendered into a living room.
    label.textContent = 'Capturing hero…';
    _frameWhole(0.6, 1.05, 2.0);
    const heroShot = await _captureFrame(100, 60, 0.95);

    // Panels 2 & 3 — fabric detail. Fall back to the whole piece when a product
    // has no such part (the chair has a Back Cushion, the sofa a Backrest).
    label.textContent = 'Capturing fabric detail…';
    if (!_framePart(/back\s*(cushion|rest)/i, 0.30, 1.25, 1.75)) _frameWhole(0.15, 1.20, 1.4);
    const backShot = await _captureFrame(80, 40, 0.95);

    if (!_framePart(/seat\s*cushion/i, 0.45, 0.95, 1.35)) _frameWhole(0.35, 0.95, 1.4);
    const seatShot = await _captureFrame(80, 40, 0.95);

    // Panel 4 — second angle of the whole piece.
    label.textContent = 'Capturing second angle…';
    _frameWhole(-1.15, 1.15, 2.1);
    const angleShot = await _captureFrame(80, 40, 0.95);

    // Only the hero goes through the model; the detail crops are already real.
    let heroFinal = heroShot;
    let apiAvailable = false;
    try {
      const probe = await fetch('/api/generate', { method: 'HEAD' });
      apiAvailable = probe.status !== 404;
    } catch (_) {}

    if (apiAvailable) {
      label.textContent = 'Rendering in Living Room…';
      try {
        const resp = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageData: heroShot.split(',')[1], mode: 'product' }),
          signal: AbortSignal.timeout(90000),
        });
        if (resp.ok) {
          const r = await resp.json();
          if (r.imageUrl) heroFinal = r.imageUrl;
        }
      } catch (e) { console.warn('[collage] AI hero failed, using capture:', e.message); }
    } else {
      showToast('Deploy to Vercel for AI Rendering');
    }

    label.textContent = 'Composing…';
    const imgs = await Promise.all([heroFinal, backShot, seatShot, angleShot].map(_loadImg));
    const fabric = document.getElementById('app-name')?.textContent || '';
    const product = document.getElementById('cp-product-name')?.textContent
      || appStore.getState().currentModelKey || '';
    const sheet = _composeCollage([
      { img: imgs[0], label: 'In a living room' },
      { img: imgs[1], label: 'Backrest — fabric detail' },
      { img: imgs[2], label: 'Seat cushion — fabric detail' },
      { img: imgs[3], label: 'Alternate angle' },
    ], [product, fabric].filter(Boolean).join(' · '));

    showRenderedImage(sheet, !apiAvailable);
  } catch (e) {
    console.error('Collage error:', e);
    showToast('Error generating render.');
  } finally {
    restoreRoom();
    E.scene.background = savedBg;
    saved.restoreBackground();
    saved.restoreCamera();
    markDirty();
    loading.classList.remove('on');
  }
}

export async function renderScene() {
  if(!E.currentModel) { showToast('Load a model first!'); return; }
  // Product view produces the four-panel sheet; room view keeps the single
  // whole-room render, where per-part fabric close-ups make no sense.
  if (!appStore.getState().roomMode) return renderCollage();
  document.getElementById('loading').classList.add('on');
  document.getElementById('load-txt').textContent = appStore.getState().roomMode ? 'Capturing Room…' : 'Capturing Scene…';

  const saved = _saveCaptureState();

  if (appStore.getState().roomMode) {
    // Match the default room-view E.camera so the render matches what the user sees.
    E.sph = { theta: 0.05 + Math.PI, phi: 1.15, r: 9.0 };
    E.tgt.set(0, -0.3, 0);
    E.scene.background = new THREE.Color(0xf5f2ee);
    E.renderer.setClearColor(0xf5f2ee, 1);
  } else {
    // Product mode: clean hero angle — slightly elevated front-right view
    E.sph = { theta: 0.6, phi: 1.05, r: 3.8 };
    E.tgt.set(0, 0.1, 0);
    E.scene.background = new THREE.Color(0xf7f5f2);
    E.renderer.setClearColor(0xf7f5f2, 1);
  }
  window.camUpdate();

  try {
    const dataUrl = await _captureFrame(100, 60, 0.95);

    let apiAvailable = false;
    try {
      const probe = await fetch('/api/generate', {method:'HEAD'});
      apiAvailable = probe.status !== 404;
    } catch(_) {}

    if (!apiAvailable) {
      // No API — just show the captured screenshot as a high-quality preview
      showToast(appStore.getState().roomMode ? 'Room scene captured!' : 'Deploy to Vercel for AI Rendering');
      showRenderedImage(dataUrl, true);
      return;
    }

    document.getElementById('load-txt').textContent = appStore.getState().roomMode
      ? 'Rendering Room Scene…'
      : 'Rendering in Living Room…';

    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        imageData: dataUrl.split(',')[1],
        mode: appStore.getState().roomMode ? 'room' : 'product',
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) { showToast('Error generating render.'); return; }
    const result = await response.json();
    if (result.imageUrl) showRenderedImage(result.imageUrl, false);
    else showToast('Failed to generate image.');
  } catch(e) {
    console.error('Render error:', e);
    showToast('Error generating render.');
  } finally {
    // Restore E.camera + background to where the user left off. Deliberately in
    // finally, AFTER the API round-trip — the hero angle stays on screen while
    // the render generates (original behavior).
    saved.restoreCamera();
    saved.restoreBackground();
    markDirty();
    document.getElementById('loading').classList.remove('on');
  }
}
// ── View in My Room ───────────────────────────────────────────────────────

export function _vimrAssetLabel(key) {
  return {
    chair: 'chair',
    accent_chair: 'accent chair',
    sofa: 'sofa',
  }[key] || 'furniture piece';
}

// Room View shows a single active piece at a time (no companion duo), so
// every "View in My Room" request — product view or room view — only ever
// touches the one currently active asset.
export function _vimrIsSingleAsset() {
  return true;
}

// Whether the currently configured curtains should be pulled into a "View in My
// Room" capture alongside the furniture.
export function _vimrCurtainsIncluded() {
  return E.curtainsVisible && E.curtainMeshEntries.length > 0 && appStore.getState().curtainState.shape !== 'none';
}

// Hides everything under E.roomGroup EXCEPT curtain meshes, so captures exclude room
// decor (walls, plants, bookcase) but keep the user's configured curtains visible.
// E._blindsGroup lives directly on `E.scene` (not E.roomGroup) so it's untouched either way.
// Returns a restore function.
export function _vimrHideRoomExceptCurtains() {
  if (!E.roomGroup) return () => {};
  if (!_vimrCurtainsIncluded()) {
    const wasVisible = E.roomGroup.visible;
    E.roomGroup.visible = false;
    return () => { E.roomGroup.visible = wasVisible; };
  }
  const curtainMeshSet = new Set(E.curtainMeshEntries.map(e => e.mesh));
  const hidden = [];
  E.roomGroup.traverse(child => {
    if (child.isMesh && !curtainMeshSet.has(child) && child.visible) {
      hidden.push(child);
      child.visible = false;
    }
  });
  return () => { hidden.forEach(c => { c.visible = true; }); };
}

// Capture ONLY the currently active model (chair, accent chair, or sofa) on a
// clean neutral background, auto-framed to its own bounding box so it fills
// the shot facing the E.camera — same hero-angle style as the product Render
// button. Room View shows a single active piece at a time, so this is the
// only capture path "View in My Room" ever uses. If curtains are configured
// and visible, they're included in both the visibility pass and the frame.
export async function captureSingleAssetScene() {
  if (!E.currentModel) return null;
  return _captureCleanScene(() => {
    // Auto-fit E.camera to the model's (+ curtains', if included) bounding box, using
    // the same relative viewing angle as the proven product hero shot.
    const box = new THREE.Box3().setFromObject(E.currentModel);
    if (_vimrCurtainsIncluded()) {
      E.curtainMeshEntries.forEach(e => { if (e.mesh.visible) box.expandByObject(e.mesh); });
      if (E._blindsGroup && E._blindsGroup.visible) box.expandByObject(E._blindsGroup);
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    E.tgt.set(center.x, center.y - size.y * 0.15, center.z);
    E.sph = { theta: 0.6, phi: 1.05, r: maxDim * 2.1 };
  });
}

// Resize + compress an image dataUrl so payload stays within Vercel's 4.5 MB limit
export function _vimrCompressImage(dataUrl, maxPx, quality) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fallback: send original
    img.src = dataUrl;
  });
}

export function openViewInMyRoom() {
  if (!E.currentModel) { showToast('Load a furniture piece first'); return; }

  const assetLabel = _vimrAssetLabel(appStore.getState().currentModelKey);

  // ── Overlay ──────────────────────────────────────────────────────────
  const ov = document.createElement('div');
  ov.id = 'vimr-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:2000;backdrop-filter:blur(8px)';

  const md = document.createElement('div');
  md.style.cssText = 'background:#fff;border-radius:14px;width:min(560px,95vw);max-height:92vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.4);display:flex;flex-direction:column';

  // Header
  const hd = document.createElement('div');
  hd.style.cssText = 'padding:18px 22px 14px;border-bottom:1px solid #ebebeb;display:flex;justify-content:space-between;align-items:center;flex-shrink:0';
  const ti = document.createElement('div');
  ti.innerHTML = `<div style="font-size:15px;font-weight:800;color:#111;font-family:var(--font-d)">View in My Room</div><div style="font-size:11px;color:#9ca3af;margin-top:2px">Upload your room photo — we'll place your ${assetLabel} inside it</div>`;
  const cl = document.createElement('button');
  cl.textContent = '×';
  cl.style.cssText = 'background:none;border:none;font-size:26px;cursor:pointer;color:#aaa;padding:0;line-height:1;flex-shrink:0';
  cl.onclick = () => document.body.removeChild(ov);
  hd.appendChild(ti); hd.appendChild(cl);

  // Body
  const body = document.createElement('div');
  body.style.cssText = 'padding:22px;display:flex;flex-direction:column;gap:16px';

  // Tip strip
  const tip = document.createElement('div');
  tip.style.cssText = 'background:#f0eeff;border:1px solid #c4b5fd;border-radius:8px;padding:10px 14px;font-size:11px;color:#5b21b6;line-height:1.6';
  tip.innerHTML = `<strong>Tips for best results:</strong> Take a clear photo of your room. If it already has a similar ${assetLabel}, we'll swap in just that piece — everything else in your room stays untouched.`;

  // Upload zone
  const uploadZone = document.createElement('div');
  uploadZone.id = 'vimr-upload-zone';
  uploadZone.style.cssText = 'border:2px dashed #d1d5db;border-radius:10px;padding:32px 20px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;position:relative';
  uploadZone.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5" style="margin:0 auto 10px;display:block"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:4px">Upload your room photo</div>
    <div style="font-size:11px;color:#9ca3af">Click to browse or drag & drop · JPG, PNG, HEIC</div>
    <input type="file" id="vimr-file-input" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%">
  `;
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor='#7c3aed'; uploadZone.style.background='#faf9ff'; });
  uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor='#d1d5db'; uploadZone.style.background=''; });
  uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.style.borderColor='#d1d5db'; uploadZone.style.background=''; if (e.dataTransfer.files[0]) _vimrHandleFile(e.dataTransfer.files[0]); });

  // Preview (hidden initially)
  const preview = document.createElement('div');
  preview.id = 'vimr-preview';
  preview.style.cssText = 'display:none;position:relative;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb';
  const previewImg = document.createElement('img');
  previewImg.id = 'vimr-preview-img';
  previewImg.style.cssText = 'width:100%;max-height:220px;object-fit:cover;display:block';
  const previewChange = document.createElement('button');
  previewChange.textContent = 'Change photo';
  previewChange.style.cssText = 'position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:5px;font-size:10px;padding:4px 10px;cursor:pointer';
  previewChange.onclick = () => { document.getElementById('vimr-file-input').click(); };
  preview.appendChild(previewImg); preview.appendChild(previewChange);

  // Curtains (optional) — free text and/or a reference photo. Independent of the
  // 3D curtain configurator: this lets the user steer Gemini's curtain choice for
  // the composited room even when just rendering a sofa/chair.
  _vimrCurtainImageDataUrl = null;
  const curtainSection = document.createElement('div');
  curtainSection.style.cssText = 'border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px';
  curtainSection.innerHTML = `
    <div style="font-size:12px;font-weight:700;color:#374151">Curtains <span style="font-weight:400;color:#9ca3af">(optional)</span></div>
    <div style="font-size:10.5px;color:#9ca3af;line-height:1.5">Have an idea for the curtains? Describe it and/or add a reference photo — we'll match your room's existing curtains to it, or add new ones if there are none.</div>
    <textarea id="vimr-curtain-text" placeholder="e.g. navy blue velvet drapes, floor length" style="resize:vertical;min-height:44px;padding:8px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:12px;font-family:var(--font-b);color:#111"></textarea>
  `;
  const curtainImgRow = document.createElement('div');
  curtainImgRow.style.cssText = 'display:flex;align-items:center;gap:8px';
  const curtainImgBtn = document.createElement('button');
  curtainImgBtn.type = 'button';
  curtainImgBtn.textContent = '+ Add reference photo';
  curtainImgBtn.style.cssText = 'padding:7px 12px;border:1.5px dashed #d1d5db;background:#fff;color:#6b7280;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-b)';
  const curtainImgThumb = document.createElement('img');
  curtainImgThumb.style.cssText = 'display:none;width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb';
  const curtainImgRemove = document.createElement('button');
  curtainImgRemove.type = 'button';
  curtainImgRemove.textContent = 'Remove';
  curtainImgRemove.style.cssText = 'display:none;background:none;border:none;color:#ef4444;font-size:11px;cursor:pointer;font-family:var(--font-b)';
  const curtainImgInput = document.createElement('input');
  curtainImgInput.type = 'file';
  curtainImgInput.accept = 'image/*';
  curtainImgInput.style.display = 'none';
  curtainImgInput.addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      _vimrCurtainImageDataUrl = e.target.result;
      curtainImgThumb.src = _vimrCurtainImageDataUrl;
      curtainImgThumb.style.display = 'block';
      curtainImgRemove.style.display = 'inline';
      curtainImgBtn.textContent = 'Change photo';
    };
    reader.readAsDataURL(file);
  });
  curtainImgBtn.onclick = () => curtainImgInput.click();
  curtainImgRemove.onclick = () => {
    _vimrCurtainImageDataUrl = null;
    curtainImgThumb.style.display = 'none';
    curtainImgRemove.style.display = 'none';
    curtainImgBtn.textContent = '+ Add reference photo';
    curtainImgInput.value = '';
  };
  curtainImgRow.appendChild(curtainImgBtn);
  curtainImgRow.appendChild(curtainImgThumb);
  curtainImgRow.appendChild(curtainImgRemove);
  curtainImgRow.appendChild(curtainImgInput);
  curtainSection.appendChild(curtainImgRow);

  // Generate button
  const genBtn = document.createElement('button');
  genBtn.id = 'vimr-gen-btn';
  genBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:7px;padding:12px;border-radius:var(--r-full);border:none;background:rgb(var(--md-primary));color:rgb(var(--md-on-primary));font-size:13px;font-weight:600;cursor:pointer;opacity:.4;pointer-events:none;font-family:var(--font-sans);transition:opacity .15s';
  genBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>Generate — View in My Room';
  genBtn.onclick = () => _vimrGenerate(ov, body, genBtn);

  body.appendChild(tip);
  body.appendChild(uploadZone);
  body.appendChild(preview);
  body.appendChild(curtainSection);
  body.appendChild(genBtn);
  md.appendChild(hd); md.appendChild(body);
  ov.appendChild(md);
  document.body.appendChild(ov);

  // File input handler
  document.getElementById('vimr-file-input').addEventListener('change', function() {
    if (this.files[0]) _vimrHandleFile(this.files[0]);
  });
}

let _vimrRoomPhotoDataUrl = null;
let _vimrCurtainImageDataUrl = null;

export function _vimrHandleFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    _vimrRoomPhotoDataUrl = e.target.result;
    const img = document.getElementById('vimr-preview-img');
    if (img) img.src = _vimrRoomPhotoDataUrl;
    document.getElementById('vimr-preview').style.display = 'block';
    document.getElementById('vimr-upload-zone').style.display = 'none';
    const btn = document.getElementById('vimr-gen-btn');
    if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
  };
  reader.readAsDataURL(file);
}

export async function _vimrGenerate(ov, body, genBtn) {
  if (!_vimrRoomPhotoDataUrl) return;

  // Read optional curtain inputs before wiping the body for the loading state
  const curtainTextEl = document.getElementById('vimr-curtain-text');
  const curtainText = curtainTextEl ? curtainTextEl.value.trim() : '';
  const curtainImageDataUrl = _vimrCurtainImageDataUrl;

  // Replace body content with loading state
  body.innerHTML = '';
  const loadEl = document.createElement('div');
  loadEl.style.cssText = 'text-align:center;padding:48px 20px;display:flex;flex-direction:column;align-items:center;gap:14px';
  const loadLabel = document.createElement('div');
  loadLabel.style.cssText = 'font-size:14px;font-weight:700;color:#111;font-family:var(--font-d)';
  loadLabel.textContent = 'Step 1 of 2 — Rendering furniture…';
  const loadSub = document.createElement('div');
  loadSub.style.cssText = 'font-size:11px;color:#9ca3af;line-height:1.6';
  loadSub.textContent = 'Converting your 3D design to a photorealistic render';
  loadEl.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="1.8" style="animation:spin 1.2s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
  loadEl.appendChild(loadLabel);
  loadEl.appendChild(loadSub);
  body.appendChild(loadEl);

  const isSingleAsset = _vimrIsSingleAsset();
  const assetLabel = _vimrAssetLabel(appStore.getState().currentModelKey);

  // ── Step 1: Capture Three.js E.scene (furniture only, clean bg) ────────────
  let rawCapture = null;
  try {
    const raw = await captureSingleAssetScene();
    rawCapture = await _vimrCompressImage(raw, 1200, 0.88);
  } catch (e) {
    console.error('Scene capture failed:', e);
  }
  if (!rawCapture) {
    body.innerHTML = '<div style="padding:32px;text-align:center;color:#ef4444;font-size:13px">Failed to capture your design. Please try again.</div>';
    return;
  }

  // ── Step 1 API: Convert 3D capture → photorealistic furniture render ──────
  let furnitureRender = null;
  try {
    const r1 = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: rawCapture.split(',')[1], mode: 'furniture' }),
      signal: AbortSignal.timeout(60000),
    });
    if (r1.ok) {
      const d1 = await r1.json();
      furnitureRender = d1.imageUrl || null;
    }
  } catch (e) {
    console.error('Furniture render step failed:', e);
  }
  // Fall back to raw capture if step 1 fails
  if (!furnitureRender) furnitureRender = rawCapture;

  // ── Step 2: Compress room photo + send both to gemini-room ──────────────
  loadLabel.textContent = 'Step 2 of 2 — Placing in your room…';
  loadSub.textContent = 'Compositing your furniture into the real room photo';

  const compressedRoom = await _vimrCompressImage(_vimrRoomPhotoDataUrl, 1280, 0.82);
  const compressedCurtainImage = curtainImageDataUrl
    ? await _vimrCompressImage(curtainImageDataUrl, 900, 0.85)
    : null;

  try {
    const resp = await fetch('/api/gemini-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomPhoto: compressedRoom,
        furnitureRender,
        assetLabel,
        singleAsset: isSingleAsset,
        curtainText: curtainText || undefined,
        curtainImage: compressedCurtainImage || undefined,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Server error');
    }
    const result = await resp.json();
    if (!result.imageUrl) throw new Error('No image returned');

    // ── Result UI ─────────────────────────────────────────────────────
    body.innerHTML = '';

    const resultImg = document.createElement('img');
    resultImg.src = result.imageUrl;
    resultImg.style.cssText = 'width:100%;border-radius:8px;display:block;border:1px solid #e5e7eb';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;margin-top:4px';

    const dlBtn = document.createElement('a');
    dlBtn.textContent = '⬇  Download';
    dlBtn.href = result.imageUrl;
    dlBtn.download = 'my-room-render.png';
    dlBtn.style.cssText = 'flex:1;padding:11px;background:#7c3aed;color:#fff;text-align:center;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;font-family:var(--font-b)';

    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Try Again';
    retryBtn.style.cssText = 'padding:11px 18px;border:1.5px solid #d1d5db;background:#fff;color:#374151;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-b)';
    retryBtn.onclick = () => { document.body.removeChild(ov); _vimrRoomPhotoDataUrl = null; openViewInMyRoom(); };

    actions.appendChild(dlBtn); actions.appendChild(retryBtn);
    body.appendChild(resultImg); body.appendChild(actions);

  } catch (e) {
    console.error('View in My Room error:', e);
    body.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.style.cssText = 'padding:32px;text-align:center';
    errEl.innerHTML = `<div style="color:#ef4444;font-size:13px;font-weight:600;margin-bottom:12px">Generation failed</div><div style="font-size:11px;color:#6b7280;margin-bottom:18px">${escapeHtml(e.message || 'Please try again.')}</div>`;
    const retryBtn2 = document.createElement('button');
    retryBtn2.textContent = 'Try Again';
    retryBtn2.style.cssText = 'padding:10px 24px;border:1.5px solid #d1d5db;background:#fff;color:#374151;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer';
    retryBtn2.onclick = () => { document.body.removeChild(ov); _vimrRoomPhotoDataUrl = null; openViewInMyRoom(); };
    errEl.appendChild(retryBtn2);
    body.appendChild(errEl);
  }
}

export function showRenderedImage(imageUrl, isLocal) {
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000;backdrop-filter:blur(6px)';
  const md=document.createElement('div');
  md.style.cssText='background:#fff;border-radius:8px;overflow:hidden;max-width:90vw;max-height:90vh;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column';
  const hd=document.createElement('div');
  hd.style.cssText='padding:14px 20px;border-bottom:1px solid #ebebeb;display:flex;justify-content:space-between;align-items:center;flex-shrink:0';
  const ti=document.createElement('h2');
  ti.textContent='Render';
  ti.style.cssText='margin:0;font-size:15px;font-weight:800;color:#111;font-family:var(--font-d)';
  const cb=document.createElement('button');
  cb.textContent='×';cb.style.cssText='background:none;border:none;font-size:24px;cursor:pointer;color:#888;padding:0';cb.onclick=()=>document.body.removeChild(ov);
  const iw=document.createElement('div');
  iw.style.cssText='padding:16px;display:flex;justify-content:center;overflow:auto;flex:1';
  const im=document.createElement('img');
  im.src=imageUrl;im.style.cssText='max-width:100%;max-height:70vh;object-fit:contain;border-radius:4px';
  const ft=document.createElement('div');
  ft.style.cssText='padding:14px 20px;border-top:1px solid #ebebeb;display:flex;justify-content:flex-end;align-items:center;flex-shrink:0';
  const dl=document.createElement('a');
  dl.href=imageUrl;dl.download=isLocal?'preview.png':'render.png';
  dl.style.cssText='background:var(--accent);color:#fff;padding:9px 20px;border-radius:var(--r);text-decoration:none;font-size:12px;font-family:var(--font-b)';
  dl.textContent=isLocal?'Download Preview':'Download Render';
  hd.appendChild(ti);hd.appendChild(cb);iw.appendChild(im);ft.appendChild(dl);
  md.appendChild(hd);md.appendChild(iw);md.appendChild(ft);ov.appendChild(md);
  ov.addEventListener('click',e=>{if(e.target===ov)document.body.removeChild(ov);});
  document.body.appendChild(ov);
}

export async function exportGLB() {
  if(!E.currentModel){showToast('No model loaded');return;}
  document.getElementById('loading').classList.add('on');
  document.getElementById('load-txt').textContent='Exporting…';
  try {
    if(!THREE.GLTFExporter){
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/exporters/GLTFExporter.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});
    }
    const exporter=new THREE.GLTFExporter();
    exporter.parse(E.currentModel,result=>{
      const blob=new Blob([result],{type:'application/octet-stream'});
      const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=appStore.getState().currentModelKey+'_custom.glb';link.click();
      showToast('Exported!');
    },{binary:true});
  } catch(e){showToast('Export failed: '+e.message);}
  finally{document.getElementById('loading').classList.remove('on');}
}

