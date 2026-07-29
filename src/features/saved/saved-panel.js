// Save flow + Saved panel UI (spec §4.2).
import { E, showToast } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { getCachedSession } from '../../lib/auth.js';
import { captureDesignState } from '../../lib/design-state-live.js';
import { createSavedStore } from './saved-store.js';

let _store = null;
export function savedStore() {
  if (!_store) _store = createSavedStore(getCachedSession()?.user?.email || 'anon');
  return _store;
}

// Downscaled JPEG of the current frame. The renderer is created with
// preserveDrawingBuffer:true (viewport.js initThree), so the last frame is
// always readable without forcing an extra render.
export function captureThumb() {
  const src = E.renderer && E.renderer.domElement;
  if (!src || !src.width) return null;
  const w = 240, h = Math.max(1, Math.round(w * src.height / src.width));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  try { return c.toDataURL('image/jpeg', 0.7); } catch { return null; }
}

const PRODUCT_LABELS = { chair: 'Chair', accent_chair: 'Accent Chair', sofa: 'Sofa' };

export function openSaveDesignDialog() {
  if (E._uploadedModel) { showToast('Saving works for catalog products only'); return; }
  const dlg = document.getElementById('save-dialog');
  const input = document.getElementById('save-name-input');
  const key = appStore.getState().currentModelKey;
  const d = new Date();
  input.value = (PRODUCT_LABELS[key] || key) + ' — ' + d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' });
  dlg.style.display = 'flex';
  input.focus(); input.select();
}

export function closeSaveDesignDialog() {
  document.getElementById('save-dialog').style.display = 'none';
}

export function confirmSaveDesign() {
  const name = document.getElementById('save-name-input').value.trim();
  if (!name) { document.getElementById('save-name-input').focus(); return; }
  try {
    const state = captureDesignState();
    savedStore().save({ name, productKey: state.productKey, thumb: captureThumb(), state });
    closeSaveDesignDialog();
    showToast('“' + name + '” saved');
    window.renderSavedPanel?.();   // refresh the list if the panel is open
  } catch (e) {
    showToast(e.code === 'full' ? 'Design limit reached — delete old designs first'
      : e.code === 'quota' ? 'Storage full — delete old designs first'
      : 'Could not save design');
  }
}

// ── Saved panel (list/load/rename/delete) ─────────────────────────────────
export function toggleSavedPanel(force) {
  const p = document.getElementById('saved-panel');
  const open = force !== undefined ? force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  document.getElementById('nav-saved')?.classList.toggle('active', open);
  if (open) renderSavedPanel();
}

function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

export function renderSavedPanel() {
  const list = savedStore().list();
  const body = document.getElementById('saved-panel-body');
  if (!list.length) {
    body.innerHTML = '<div class="saved-empty">No saved designs yet.<br>Style a product, then hit <b>Save</b>.</div>';
    return;
  }
  body.innerHTML = list.map(d => {
    const date = new Date(d.updatedAt).toLocaleDateString('en', { day: 'numeric', month: 'short' });
    return '<div class="saved-card" data-id="' + d.id + '">'
      + (d.thumb ? '<img class="saved-thumb" src="' + d.thumb + '" alt="">' : '<div class="saved-thumb saved-thumb--ph"></div>')
      + '<div class="saved-meta">'
      +   '<div class="saved-name">' + _esc(d.name) + '</div>'
      +   '<div class="saved-sub">' + (PRODUCT_LABELS[d.productKey] || d.productKey) + ' · ' + date + '</div>'
      + '</div>'
      + '<div class="saved-actions">'
      +   '<button class="saved-act" onclick="loadSavedDesign(\'' + d.id + '\')" title="Load">Load</button>'
      +   '<button class="saved-act" onclick="renameSavedDesign(\'' + d.id + '\')" title="Rename">✎</button>'
      +   '<button class="saved-act saved-act--danger" onclick="deleteSavedDesign(\'' + d.id + '\')" title="Delete">✕</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

export async function loadSavedDesign(id) {
  const rec = savedStore().get(id);
  if (!rec) return;
  toggleSavedPanel(false);
  const { applyDesignState } = await import('../../lib/design-state-live.js');
  const finish = async () => {
    // fast:false — a load may run in a fresh session with cold caches, and it
    // must reproduce the enhanced texture the design was saved with.
    await applyDesignState(rec.state, { silent: false, fast: false });
    window._historySeed?.();          // loaded design becomes the new baseline
    showToast('“' + rec.name + '” loaded');
  };
  if (rec.state.productKey !== appStore.getState().currentModelKey) {
    window._onModelReady = finish;    // one-shot: runs after switchModel settles
    window.switchModel(rec.state.productKey);
  } else {
    await finish();
  }
}

export function deleteSavedDesign(id) {
  const card = document.querySelector('.saved-card[data-id="' + id + '"]');
  if (card && !card.classList.contains('confirm-del')) {
    card.classList.add('confirm-del');   // first tap arms, second confirms
    setTimeout(() => card.classList.remove('confirm-del'), 2500);
    return;
  }
  savedStore().remove(id);
  renderSavedPanel();
  showToast('Design deleted');
}

export function renameSavedDesign(id) {
  const card = document.querySelector('.saved-card[data-id="' + id + '"]');
  const rec = savedStore().get(id);
  if (!card || !rec) return;
  const nameEl = card.querySelector('.saved-name');
  nameEl.innerHTML = '<input class="saved-rename-in" maxlength="60" value="' + _esc(rec.name) + '">';
  const input = nameEl.querySelector('input');
  input.focus(); input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) { try { savedStore().rename(id, v); } catch { showToast('Storage full'); } }
    renderSavedPanel();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.removeEventListener('blur', commit); renderSavedPanel(); }
  });
}
