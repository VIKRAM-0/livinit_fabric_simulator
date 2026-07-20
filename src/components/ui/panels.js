// Panel templates — the product- and room-panel "Applied material" and
// "Material adjustments" blocks were duplicated markup in index.html; both
// panels now render from the shared templates below (design spec §7.6).
// Classic script (not a module): runs at load, after the markup, before boot.
// The rendered DOM must stay identical to the former static markup — same
// ids, classes, inline styles and handlers; this is dedupe, not redesign.

// One spec per material slider. The room panel has always shown only the
// `room:true` subset, with ids suffixed `-r`.
export const SLIDER_ROWS = [
  { key:'brightness', label:'Brightness',    min:'0.01', max:'2',  step:'0.05', value:'1',    txt:'1.00', handler:'updateBrightness(+this.value)',      room:true },
  { key:'roughness',  label:'Roughness',     min:'0',    max:'1',  step:'0.01', value:'0.72', txt:'0.72', handler:"applyProp('roughness',+this.value)", room:true },
  { key:'metalness',  label:'Metalness',     min:'0',    max:'1',  step:'0.01', value:'0',    txt:'0.00', handler:"applyProp('metalness',+this.value)" },
  { key:'sheen',      label:'Fabric Fuzz',   min:'0',    max:'1',  step:'0.01', value:'0',    txt:'0.00', handler:"applyProp('sheen',+this.value)" },
  // Pattern repeats every BASE_TILE/value metres (30cm at 1.0) — see
  // PRODUCT_SCALE_DEFAULTS. Range spans a ~4cm to ~1.2m repeat.
  { key:'scale',      label:'Pattern Scale', min:'0.25', max:'8',  step:'0.05', value:'1',    txt:'1.0',  handler:'updateTexScale(+this.value)',        room:true },
  { key:'norm',       label:'Bump Strength', min:'0',    max:'3',  step:'0.1',  value:'1',    txt:'1.0',  handler:'updateNormScale(+this.value)' },
];

export function sliderRowsHtml(sfx, rows) {
  return rows.map((r, i) => {
    const id = r.key + (sfx ? '-' + sfx : '');
    return '<div class="sl-row"' + (i === rows.length - 1 ? ' style="margin-bottom:0"' : '') + '>'
      + '<div class="sl-lbl">' + r.label + ' <span class="sl-val" id="v-' + id + '">' + r.txt + '</span></div>'
      + '<input type="range" id="s-' + id + '" min="' + r.min + '" max="' + r.max + '" step="' + r.step + '" value="' + r.value + '" oninput="' + r.handler + '">'
      + '</div>';
  }).join('');
}

export const _REPLACE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';

export function appliedPreviewHtml(sfx, swStyle) {
  const id = (base) => base + (sfx ? '-' + sfx : '');
  return '<div class="app-prev">'
    + '<div class="app-sw" id="' + id('app-sw') + '"' + (swStyle ? ' style="' + swStyle + '"' : '') + '></div>'
    + '<div style="flex:1;min-width:0">'
    +   '<div class="app-name" id="' + id('app-name') + '">— none —</div>'
    +   '<div class="app-vend" id="' + id('app-vend') + '"></div>'
    + '</div>'
    + '<button class="app-replace-btn" id="' + id('app-replace-btn') + '" title="Replace with your own image" onclick="openDiffuseUpload()" style="display:none">' + _REPLACE_SVG + '</button>'
    + '</div>';
}

// Render into the static shells at the exact positions the markup occupied.
document.getElementById('diffuse-upload-input')
  .insertAdjacentHTML('beforebegin', appliedPreviewHtml('', ''));
document.getElementById('cp-sliders')
  .insertAdjacentHTML('beforeend', sliderRowsHtml('', SLIDER_ROWS));
document.getElementById('room-applied-block')
  .insertAdjacentHTML('beforeend', appliedPreviewHtml('room', 'width:40px;height:40px;border-radius:6px'));
document.getElementById('room-sliders-block')
  .insertAdjacentHTML('beforeend', sliderRowsHtml('r', SLIDER_ROWS.filter(r => r.room)));
