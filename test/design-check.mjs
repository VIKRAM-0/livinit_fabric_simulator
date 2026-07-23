// End-to-end checks for undo/redo/reset, save/load, tablet layout.
// Usage: node test/design-check.mjs
//
// Asset dependency: the chair GLB comes from /api/s3proxy, which needs AWS
// credentials in .env (test/serve.mjs loads them). Without credentials the
// model can't load, so — following the smoke.mjs precedent — this script
// falls back to a DEGRADED mode: it injects two synthetic mesh entries and a
// hex-only custom fabric, which exercises the real history/save/load
// machinery entirely offline. Only GLB/texture fetching goes untested then.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8126;
const BASE = `http://localhost:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn('node', [new globalThis.URL('./serve.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'ignore' });
await sleep(800);

async function assetsAvailable() {
  try {
    const r = await fetch(`${BASE}/api/s3proxy?key=fabric_assets_v2/glbs/chair.glb`, {
      method: 'GET', headers: { range: 'bytes=0-10' }, signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}

const REAL_ASSETS = await assetsAvailable();
console.log(REAL_ASSETS
  ? 'MODE  real assets (S3 reachable)'
  : 'MODE  DEGRADED — no S3 credentials; using synthetic model (GLB/texture loading untested)');

// Injects two synthetic parts when the GLB could not load, then re-baselines
// history. No-op when a real model is present.
const ensureModel = (page) => page.evaluate(async () => {
  const { E } = await import('/src/lib/engine.js');
  if (E.meshEntries.length) return 'real';
  const mk = (name) => {
    const grey = new THREE.MeshPhysicalMaterial({ color: 0xd4d0cc, roughness: 0.75, metalness: 0 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), grey);
    mesh.name = name;
    if (E.scene) E.scene.add(mesh);
    return { id: name, name, mesh, greyMat: grey, matIndex: -1, checked: true, pieceSelected: false, uvScaleFactor: 1 };
  };
  E.meshEntries = [mk('Seat'), mk('Back')];
  window._historySeed?.();
  return 'synthetic';
});

let browser, exitCode = 1;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading') && !document.getElementById('loading').classList.contains('on'), { timeout: 30000 });
  await sleep(1500);
  const mode = await ensureModel(page);
  console.log(`INFO  model: ${mode}`);

  // Hex-only custom fabric — applies with zero network (no diffuse to fetch).
  const applied = () => page.evaluate(async () => {
    const { E } = await import('/src/lib/engine.js');
    const { CUSTOM_FABRIC_ITEMS } = await import('/src/lib/catalog.js');
    let item = CUSTOM_FABRIC_ITEMS.find(i => i.name === 'Check Red');
    if (!item) {
      item = { name: 'Check Red', hex: '#a03434', type: 'fabric', vendor: 'custom', series: 'My Fabrics' };
      CUSTOM_FABRIC_ITEMS.push(item);
      window.buildLibrary?.();
    }
    const targets = E.meshEntries.filter(e => !e._isCurtain);
    await window.applySwatchToEntries(item, targets, {});
    return { name: item.name, worn: targets.filter(e => e.appliedFabric).length };
  });

  // Poll worn-part count instead of fixed sleeps — replay is async.
  const wornCount = () => page.evaluate(async () => {
    const { E } = await import('/src/lib/engine.js');
    return E.meshEntries.filter(e => !e._isCurtain && e.appliedFabric).length;
  });
  const waitWorn = async (pred, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const n = await wornCount();
      if (pred(n)) return n;
      if (Date.now() - t0 > ms) return n;
      await sleep(250);
    }
  };

  // 1 · apply → undo → redo → reset
  const a = await applied();
  check('fabric applies to parts', a.worn > 0, `${a.worn} entries wear ${a.name}`);
  const canUndo = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo enables after apply', canUndo);
  await page.evaluate(() => window.undoDesign());
  check('undo removes the fabric', (await waitWorn(n => n === 0)) === 0);
  await page.evaluate(() => window.redoDesign());
  check('redo restores the fabric', (await waitWorn(n => n > 0)) > 0);
  await page.evaluate(() => window.resetDesign());
  check('reset returns to factory', (await waitWorn(n => n === 0)) === 0);

  // 2 · save → reload → load
  await page.evaluate(() => window.undoDesign());            // back to fabric-applied state
  await waitWorn(n => n > 0);
  await page.evaluate(() => {
    window.openSaveDesignDialog();
    document.getElementById('save-name-input').value = 'Smoke Design';
    window.confirmSaveDesign();
  });
  const savedRec = await page.evaluate(() => (JSON.parse(localStorage.getItem('livinit_sim_designs_v1:priya@acme.com') || '[]'))[0] || null);
  check('design persists to localStorage', !!savedRec);
  check('saved state embeds the custom fabric by value',
    !!savedRec && Object.values(savedRec.state.parts).some(r => r && r.kind === 'custom' && r.item.name === 'Check Red'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading') && !document.getElementById('loading').classList.contains('on'), { timeout: 30000 });
  await sleep(1500);
  await ensureModel(page);
  await page.evaluate(() => window.toggleSavedPanel(true));
  const cardCount = await page.evaluate(() => document.querySelectorAll('.saved-card').length);
  check('saved panel lists the design after reload', cardCount === 1);
  const recId = await page.evaluate(() => document.querySelector('.saved-card')?.dataset.id);
  await page.evaluate(id => window.loadSavedDesign(id), recId);
  check('loading the design re-applies fabrics (fresh session)', (await waitWorn(n => n > 0, 45000)) > 0);
  const undoAfterLoad = await page.evaluate(() => document.getElementById('btn-undo').disabled);
  check('loaded design is a fresh baseline (undo disabled)', undoAfterLoad === true);

  // 3 · touch tap-to-apply (click must survive pointerdown+preventDefault)
  const touchPage = await browser.newPage();
  await touchPage.emulate({ viewport: { width: 834, height: 1194, hasTouch: true, isMobile: true }, userAgent: await browser.userAgent() });
  // First-visit welcome tour (#tour-ov) overlays the whole page and would
  // swallow the tap — mark it seen before the app boots.
  await touchPage.evaluateOnNewDocument(() => localStorage.setItem('livinit_tour_seen_v1', '1'));
  await touchPage.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await touchPage.waitForFunction(() => document.getElementById('loading') && !document.getElementById('loading').classList.contains('on'), { timeout: 30000 });
  await sleep(1500);
  await ensureModel(touchPage);
  await touchPage.evaluate(async () => {
    // First swatch in DOM order must be a FABRIC — the default first group with
    // items is wood finishes, which are (correctly) rejected on non-frame parts.
    const { CUSTOM_FABRIC_ITEMS } = await import('/src/lib/catalog.js');
    CUSTOM_FABRIC_ITEMS.push({ name: 'Check Red', hex: '#a03434', type: 'fabric', vendor: 'custom', series: 'My Fabrics' });
    window.buildLibrary?.();
    window.toggleSidebar?.();   // drawer open at portrait widths
    window.selectAll?.();
  });
  await sleep(600);
  await touchPage.tap('.bar-sw');
  const tapWorn = await (async () => {
    const t0 = Date.now();
    for (;;) {
      const n = await touchPage.evaluate(async () => {
        const { E } = await import('/src/lib/engine.js');
        return E.meshEntries.filter(e => !e._isCurtain && e.appliedFabric).length;
      });
      if (n > 0 || Date.now() - t0 > 20000) return n;
      await sleep(250);
    }
  })();
  check('touch tap on a swatch applies fabric', tapWorn > 0, `${tapWorn} worn`);
  await touchPage.close();

  // 4 · tablet layout sweep
  for (const [w, h, drawer] of [[768, 1024, true], [834, 1194, true], [1024, 768, false], [1180, 820, false]]) {
    await page.setViewport({ width: w, height: h });
    await sleep(400);
    const r = await page.evaluate(() => {
      const p = document.querySelector('.config-panel');
      const cs = getComputedStyle(p);
      return { fixed: cs.position === 'fixed', width: p.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    check(`${w}×${h}: ${drawer ? 'drawer' : 'persistent panel'}`, r.fixed === drawer && !r.overflow, `fixed=${r.fixed} w=${Math.round(r.width)}`);
  }

  exitCode = results.every(Boolean) ? 0 : 1;
} catch (e) {
  console.error('design-check crashed:', e);
} finally {
  await browser?.close();
  server.kill();
  console.log(results.every(Boolean) && results.length ? 'ALL PASS' : 'FAILURES');
  process.exit(exitCode);
}
