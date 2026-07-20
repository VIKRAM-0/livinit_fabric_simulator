// Headless smoke test: boots the real app in system Chrome and asserts the
// core flow works. Gate for every refactor commit.
//
// Usage: node test/smoke.mjs [--shot /path/out.png]
// Requires: python3 -m http.server started by this script (port 8123).

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const PORT = 8123;
const URL = `http://localhost:${PORT}/index.html`;
const shotIdx = process.argv.indexOf('--shot');
const SHOT = shotIdx > -1 ? process.argv[shotIdx + 1] : null;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, why) {
  console.log(`SKIP  ${name} — ${why}`);
}

// Is the asset pipeline reachable (upstream or disk cache)?
async function assetsAvailable() {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/s3proxy?key=fabric_assets_v2/glbs/chair.glb`, {
      method: 'GET', headers: { range: 'bytes=0-10' }, signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}

// Errors we tolerate: local /api/* endpoints don't exist, and external
// CDNs/texture hosts can be flaky. Anything else is a real defect.
const TOLERATED = [
  /\/api\//,
  /Failed to fetch/i,
  /ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET|TIMED_OUT|ABORTED)/,
  /net::/,
  /404/,
  /CORS/i,
  /polyhaven|ambientcg|mityinc|supabase/i,
];
const tolerated = (msg) => TOLERATED.some((re) => re.test(msg));

const server = spawn('node', [new globalThis.URL('./serve.mjs', import.meta.url).pathname, String(PORT)], {
  stdio: 'ignore',
});
await sleep(800);

let browser;
let exitCode = 1;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !tolerated(m.text())) {
      // console.error is informational; only uncaught pageerror fails the run,
      // but log it so regressions are visible.
      console.log('  [console.error]', m.text().slice(0, 200));
    }
  });

  const hasAssets = await assetsAvailable();
  if (!hasAssets) console.log('WARN  asset upstream unreachable — model-dependent checks will be SKIPPED');

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('page loads', true);

  // Dismiss the onboarding tour if it appears (blocks the viewport).
  await sleep(3000);
  await page.evaluate(() => window._tourSkip?.()).catch(() => {});

  // Network-independent UI checks: library bar built from in-memory catalog,
  // finder modal opens/closes, product tabs wired. The library builds only
  // after the CDN loader scripts finish, so wait for swatches instead of
  // sampling at a fixed delay (was flaky under slow CDN).
  await page.waitForFunction(
    () => document.querySelectorAll('.bar-sw').length >= 50,
    { timeout: 30000, polling: 500 },
  ).catch(() => {});
  const uiOk = await page.evaluate(() => {
    const out = {};
    out.swatches = document.querySelectorAll('.bar-sw').length;
    out.gridChildren = document.getElementById('fabric-grid')?.children.length || 0;
    window.openFabricFinder();
    out.finderOpen = getComputedStyle(document.getElementById('finder-overlay')).display !== 'none';
    window.closeFabricFinder();
    out.finderClosed = getComputedStyle(document.getElementById('finder-overlay')).display === 'none';
    return out;
  }).catch((e) => ({ error: e.message }));
  check('fabric library builds (>=50 swatches)', (uiOk.swatches || 0) >= 50 && (uiOk.gridChildren || 0) > 0,
    `got ${uiOk.swatches} in sidebar grid (${uiOk.gridChildren} nodes)`);
  check('fabric finder opens and closes', !!(uiOk.finderOpen && uiOk.finderClosed), uiOk.error || '');

  // Model load signal: loading overlay off AND mesh/zone list populated.
  // (`let` globals aren't on window, so DOM is the observable surface.)
  let modelLoaded = false;
  if (hasAssets) {
    try {
      await page.waitForFunction(
        () => {
          const loading = document.getElementById('loading');
          const zones = document.querySelectorAll('#mesh-list .mesh-item, #mesh-list [data-eid], #mesh-list > *').length;
          return loading && !loading.classList.contains('on') && zones > 0;
        },
        { timeout: 60000, polling: 500 }
      );
      modelLoaded = true;
    } catch { /* fallthrough */ }
    check('model loads (loading clears, zone list populated)', modelLoaded);
  } else {
    skip('model loads', 'asset upstream down');
  }

  // Swatch apply: click the first fabric swatch in the bar.
  if (modelLoaded) {
    let swatchOk = false;
    try {
      await page.waitForSelector('.bar-sw', { timeout: 10000 });
      await page.evaluate(() => document.querySelector('.bar-sw')?.click());
      await sleep(2500);
      swatchOk = true;
    } catch { /* fallthrough */ }
    check('first swatch click executes', swatchOk);
  } else {
    skip('swatch apply', 'requires loaded model');
  }

  // Room view round-trip. Observable: appStore.roomMode flips (the tab bar was
  // removed in the guided-flow redesign; room mode is the store's source of truth).
  if (modelLoaded) {
    let roomOk = false;
    try {
      await page.evaluate(() => window.toggleRoomView());
      await page.waitForFunction(() => window.appStore?.getState().roomMode === true, { timeout: 45000, polling: 500 });
      await sleep(2000);
      await page.evaluate(() => window.toggleRoomView());
      await page.waitForFunction(
        () => window.appStore?.getState().roomMode === false,
        { timeout: 30000, polling: 500 }
      );
      roomOk = true;
    } catch { /* fallthrough */ }
    check('room view enter/exit', roomOk);
  } else {
    skip('room view enter/exit', 'requires loaded model');
  }

  const realErrors = pageErrors.filter((e) => !tolerated(e));
  check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  if (SHOT) {
    await page.screenshot({ path: SHOT });
    console.log('screenshot:', SHOT);
  }

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log('FAIL  harness error —', e.message);
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
process.exit(exitCode);
