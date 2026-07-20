import { E, showToast, CURTAIN_FABRICS, CURTAIN_COLORS } from '../../lib/engine.js';
import { appStore } from '../../lib/store.js';
import { setActiveFabric } from '../../lib/actions.js';
import { LIBRARY } from '../../lib/catalog.js';
// Fabric library bar + curtain library + filters
// Classic script (not a module): top-level let/const/function share the
// global scope across all src/*.js files, preserving original semantics.
// ── Build fabric library UI ───────────────────────────────────────────────
export function buildLibrary() {
  if (appStore.getState().roomMode && E.meshEntries.find(e => e._isCurtain && e.pieceSelected)) {
    buildCurtainLibrary();
    return;
  }

  const lt = document.getElementById('lib-title');
  const _ltMap={chair:'Chair Fabrics',accent_chair:'Accent Chair Fabrics',sofa:'Sofa Fabrics'};
  if(lt) lt.textContent = _ltMap[appStore.getState().currentModelKey] || 'Fabrics';

  const tabsEl = document.getElementById('fabric-tabs');
  const swatchesEl = document.getElementById('fabric-grid');
  if(!tabsEl || !swatchesEl) return;

  tabsEl.querySelectorAll('.fab-tab, .fab-tab-add').forEach(el => el.remove());
  swatchesEl.innerHTML = '';

  // Clear search box
  const searchInput = document.getElementById('fab-search-input');
  if(searchInput) searchInput.value = '';

  const groups = LIBRARY[appStore.getState().currentModelKey];

  // Flatten all items with their group indices (for startDrag compat)
  const allSwatches = [];
  groups.forEach((group, gi) => {
    if(group.items.length === 0) return;
    const typeKey = group.vclass === 'custom' ? 'custom'
                  : (group.items[0] && group.items[0].type ? group.items[0].type : 'fabric');
    group.items.forEach((item, ii) => {
      const itemType = group.vclass === 'custom' ? 'custom' : (item.type || 'fabric');
      allSwatches.push({ item, gi, ii, typeKey: itemType, seriesName: group.group });
    });
  });

  // Type tab definitions — only show tabs that have items
  const TYPE_DEFS = [
    { key: 'all',    label: 'All Fabrics' },
    { key: 'fabric', label: 'Fabric' },
    { key: 'vinyl',  label: 'Vinyl' },
    { key: 'pu',     label: 'PU / Leather' },
    { key: 'wood',   label: 'Wood' },
    { key: 'custom', label: 'My Fabrics' },
  ];
  const presentTypes = new Set(allSwatches.map(s => s.typeKey));

  // Active type state
  window._fabActiveType = 'all';

  window._fabFilterTab = function(key) {
    window._fabActiveType = key;
    tabsEl.querySelectorAll('.fab-tab[data-tk]').forEach(t =>
      t.classList.toggle('active', t.dataset.tk === key));
    const q = (document.getElementById('fab-search-input') || {}).value || '';
    _applyFabricFilters(key, q);
  };

  function mkTab(label, key) {
    const btn = document.createElement('button');
    btn.className = 'fab-tab' + (key === 'all' ? ' active' : '');
    btn.textContent = label;
    btn.dataset.tk = key;
    btn.onclick = () => window._fabFilterTab(key);
    return btn;
  }

  TYPE_DEFS.forEach(({ key, label }) => {
    if (key === 'all' || presentTypes.has(key)) {
      tabsEl.appendChild(mkTab(label, key));
    }
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'fab-tab-add';
  addBtn.textContent = '+ Add Fabric';
  addBtn.onclick = window.openFabricFinder;
  tabsEl.appendChild(addBtn);

  // Build swatches with a sticky header per collection (series)
  let _lastSeries = null;
  allSwatches.forEach(({ item, gi, ii, typeKey, seriesName }) => {
    if (seriesName !== _lastSeries) {
      _lastSeries = seriesName;
      const head = document.createElement('div');
      head.className = 'lib-group-head';
      head.dataset.series = seriesName.toLowerCase();
      head.textContent = seriesName;
      swatchesEl.appendChild(head);
    }
    const sw = document.createElement('div');
    sw.className = 'bar-sw';
    sw.dataset.type = typeKey;
    sw.dataset.series = seriesName.toLowerCase();
    sw.dataset.name = item.name.toLowerCase();
    sw.dataset.fabricKey = gi + ':' + ii;
    sw.title = item.name + ' · ' + seriesName;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'bar-sw-img';
    const src = item.img || null;
    if (src) {
      // Shimmer skeleton until the thumbnail resolves (either way it clears)
      sw.classList.add('loading');
      const img = document.createElement('img');
      img.src = src; img.alt = item.name; img.loading = 'lazy'; img.crossOrigin = 'anonymous';
      img.onload = () => sw.classList.remove('loading');
      img.onerror = () => { sw.classList.remove('loading'); img.remove(); imgWrap.style.background = item.hex || '#ccc'; };
      imgWrap.appendChild(img);
    } else {
      imgWrap.style.background = item.hex || '#ccc';
    }

    // Strip series prefix from name so label is shorter ("Bark" not "Abilene Bark")
    const shortName = item.name.startsWith(seriesName + ' ')
      ? item.name.slice(seriesName.length + 1) : item.name;

    const nameEl = document.createElement('div');
    nameEl.className = 'bar-sw-name';
    nameEl.textContent = shortName;

    const seriesEl = document.createElement('div');
    seriesEl.className = 'bar-sw-series';
    seriesEl.textContent = seriesName;

    sw.appendChild(imgWrap);
    sw.appendChild(nameEl);
    sw.appendChild(seriesEl);

    sw.addEventListener('click', () => {
      if (appStore.getState().roomMode) {
        const selected = E.meshEntries.filter(e => e.pieceSelected);
        if (!selected.length) { showToast('Click a piece in the list →'); return; }
        setActiveFabric(gi + ':' + ii); renderActiveSwatch();
        window.applySwatchToEntries(item, selected);
      } else {
        const checked = E.meshEntries.filter(e => e.checked);
        if (!checked.length) { showToast('Select a zone first →'); return; }
        setActiveFabric(gi + ':' + ii); renderActiveSwatch();
        window.applySwatchToEntries(item, checked);
      }
    });

    sw.addEventListener('mousedown', e => { e.preventDefault(); window.startDrag(e, gi, ii); });
    swatchesEl.appendChild(sw);
  });

  window._updateZoneCountBadge();
}

// Sync the .active highlight from appStore.activeFabricKey — the single source
// of truth (replaces the old captured-element `activeBtnEl` tracking). Called
// from the sites that change the active fabric, NOT from buildLibrary: a
// rebuild has always dropped the highlight, and that behavior is preserved.
export function renderActiveSwatch() {
  const key = appStore.getState().activeFabricKey;
  document.querySelectorAll('.bar-sw').forEach(sw => {
    sw.classList.toggle('active', key !== null && sw.dataset.fabricKey === key);
  });
}

export function buildCurtainLibrary() {
  const lt = document.getElementById('lib-title');
  if (lt) lt.textContent = 'Curtain Fabrics';

  const tabsEl     = document.getElementById('fabric-tabs');
  const swatchesEl = document.getElementById('fabric-grid');
  if (!tabsEl || !swatchesEl) return;

  tabsEl.querySelectorAll('.fab-tab, .fab-tab-add').forEach(el => el.remove());
  swatchesEl.innerHTML = '';

  const searchInput = document.getElementById('fab-search-input');
  if (searchInput) searchInput.value = '';

  // Fabric type label (full grid row, same style as collection headers)
  const fabLabel = document.createElement('div');
  fabLabel.className = 'lib-group-head';
  fabLabel.textContent = 'Fabric Type';
  swatchesEl.appendChild(fabLabel);

  CURTAIN_FABRICS.forEach(f => {
    const sw = document.createElement('div');
    sw.className = 'bar-sw' + (f.id === appStore.getState().curtainState.fabric ? ' active' : '');
    sw.dataset.cfab = f.id;
    sw.title = f.label;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'bar-sw-img';
    imgWrap.style.background = f.swatch;

    const nameEl = document.createElement('div');
    nameEl.className = 'bar-sw-name';
    nameEl.textContent = f.label;

    const seriesEl = document.createElement('div');
    seriesEl.className = 'bar-sw-series';
    seriesEl.textContent = 'Curtain';

    sw.appendChild(imgWrap);
    sw.appendChild(nameEl);
    sw.appendChild(seriesEl);

    sw.addEventListener('click', () => {
      swatchesEl.querySelectorAll('.bar-sw[data-cfab]').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      window.setCurtainFabric(f.id);
    });
    swatchesEl.appendChild(sw);
  });

  // Color label (full grid row)
  const colLabel = document.createElement('div');
  colLabel.className = 'lib-group-head';
  colLabel.textContent = 'Color';
  swatchesEl.appendChild(colLabel);

  // Round color chips keep their intrinsic size inside a full-row rail
  const chipRow = document.createElement('div');
  chipRow.className = 'curtain-chip-row';
  CURTAIN_COLORS.forEach(c => {
    const chip = document.createElement('button');
    chip.className = 'curtain-color-chip' + (c.hex === appStore.getState().curtainState.color ? ' active' : '');
    chip.dataset.cclr = c.hex;
    chip.style.background = c.hex;
    chip.title = c.label;
    chip.addEventListener('click', () => {
      window.setCurtainColor(c.hex);
    });
    chipRow.appendChild(chip);
  });
  swatchesEl.appendChild(chipRow);

  window._updateZoneCountBadge();
}

export function _applyFabricFilters(typeKey, query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#fabric-grid .bar-sw').forEach(sw => {
    const typeMatch = (typeKey === 'all' || sw.dataset.type === typeKey);
    const textMatch = !q || sw.dataset.name.includes(q) || sw.dataset.series.includes(q);
    sw.classList.toggle('hidden', !(typeMatch && textMatch));
  });
  // Hide a collection header when the filter leaves it with no visible swatches
  document.querySelectorAll('#fabric-grid .lib-group-head[data-series]').forEach(head => {
    const any = document.querySelector(
      '#fabric-grid .bar-sw[data-series="' + head.dataset.series + '"]:not(.hidden)');
    head.classList.toggle('hidden', !any);
  });
  // Empty state: nothing matches → show a message instead of a blank grid.
  const grid = document.getElementById('fabric-grid');
  const anyVisible = grid && grid.querySelector('.bar-sw:not(.hidden)');
  let empty = grid && grid.querySelector('.lib-empty');
  if (grid && !anyVisible) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'lib-empty';
      grid.appendChild(empty);
    }
    empty.textContent = q ? 'No fabrics match “' + query.trim() + '”' : 'No fabrics in this filter';
  } else if (empty) {
    empty.remove();
  }
}

export function filterFabricSearch(value) {
  _applyFabricFilters(window._fabActiveType || 'all', value);
}

