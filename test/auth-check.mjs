// Verification for the multi-tenant gate (src/lib/auth.js + tenant.js).
// Masks navigator.webdriver so the real login screen shows, then walks:
//   login visible → wrong password rejected → sign in as the smaller tenant
//   (Cove & Co.) → product tabs scoped → tenant badge stamped → draft tenant
//   lands on the "being set up" gate.
// Screenshots land in test/.shots/ for visual review.
//
// Usage: node test/auth-check.mjs

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8124;
const URL = `http://localhost:${PORT}/index.html`;
const SHOTS = new globalThis.URL('./.shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const server = spawn('node', [new globalThis.URL('./serve.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'ignore' });
await sleep(800);

let browser, exitCode = 1;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  // Mask webdriver so getSession() doesn't auto-login (that path is for smoke.mjs).
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // 1 · Login gate shows
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1200);
  const gateShown = await page.evaluate(() =>
    getComputedStyle(document.getElementById('auth-gate')).display !== 'none');
  check('login gate shows when signed out', gateShown);
  await page.screenshot({ path: SHOTS + '1-login.png' });

  // 2 · Wrong password rejected
  await page.type('#auth-email', 'priya@acme.com');
  await page.type('#auth-pw', 'wrong');
  await page.click('.auth-cta');
  await sleep(300);
  const errShown = await page.evaluate(() =>
    document.getElementById('auth-err').style.display === 'block');
  check('wrong password shows error', errShown);

  // 3 · Sign in as Cove & Co. (chair + sofa only) via demo chip
  await page.click('[data-demo-acc="dana@cove.co"]');
  await page.click('.auth-cta');
  await sleep(2500);
  const afterLogin = await page.evaluate(() => ({
    gate: getComputedStyle(document.getElementById('auth-gate')).display,
    accentTab: document.getElementById('tab-accent_chair').style.display,
    chairTab: document.getElementById('tab-chair').style.display,
    badge: document.getElementById('tenant-badge-name')?.textContent,
    credits: document.getElementById('tenant-credits-n')?.textContent,
  }));
  check('gate hidden after sign-in', afterLogin.gate === 'none');
  check('accent chair hidden for Cove', afterLogin.accentTab === 'none');
  check('chair visible for Cove', afterLogin.chairTab !== 'none');
  check('tenant badge stamped', afterLogin.badge === 'Cove & Co.', afterLogin.badge);
  check('credits shown', afterLogin.credits === '120', afterLogin.credits);
  await page.screenshot({ path: SHOTS + '2-cove-workspace.png' });

  // 4 · Draft tenant lands on the being-set-up gate
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  await page.type('#auth-email', 'buyer@bhavya.com');
  await page.type('#auth-pw', 'demo');
  await page.click('.auth-cta');
  await sleep(1500);
  const draft = await page.evaluate(() => ({
    shown: document.getElementById('auth-draft').style.display === 'block',
    name: document.getElementById('auth-draft-name')?.textContent,
  }));
  check('draft tenant sees being-set-up gate', draft.shown, draft.name);
  await page.screenshot({ path: SHOTS + '3-draft-gate.png' });

  exitCode = results.every(Boolean) ? 0 : 1;
  console.log(exitCode === 0 ? '\nALL PASS' : '\nFAILURES PRESENT');
} catch (e) {
  console.error('auth-check crashed:', e.message);
} finally {
  await browser?.close();
  server.kill();
  process.exit(exitCode);
}
