// Perf evidence probe (systematic-debugging Phase 1). Measures whether the app
// churns style/layout AT REST, counts stuck shimmer swatches, and times a scroll.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8231;
const server = spawn('node', [new URL('./serve.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'ignore' });
await sleep(800);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--window-size=1440,900'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await page.evaluate(() => window._tourSkip?.()).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('.bar-sw').length >= 50, { timeout: 30000 }).catch(() => {});
  await sleep(4000); // let images settle

  const counts = await page.evaluate(() => ({
    swatches: document.querySelectorAll('.bar-sw').length,
    stuckLoading: document.querySelectorAll('.bar-sw.loading').length,
    stickyBlurHeaders: document.querySelectorAll('.lib-group-head').length,
    animatingNow: [...document.querySelectorAll('*')].filter(el => {
      const a = getComputedStyle(el).animationName;
      return a && a !== 'none';
    }).length,
  }));

  // AT-REST churn: sample Chrome metrics twice, 3s apart, no interaction.
  const m1 = await page.metrics();
  await sleep(3000);
  const m2 = await page.metrics();
  const perSec = (k) => ((m2[k] - m1[k]) / 3).toFixed(1);
  const restChurn = {
    recalcStylePerSec: perSec('RecalcStyleCount'),
    layoutPerSec: perSec('LayoutCount'),
    recalcMsPerSec: (((m2.RecalcStyleDuration - m1.RecalcStyleDuration) / 3) * 1000).toFixed(1),
    layoutMsPerSec: (((m2.LayoutDuration - m1.LayoutDuration) / 3) * 1000).toFixed(1),
    scriptMsPerSec: (((m2.ScriptDuration - m1.ScriptDuration) / 3) * 1000).toFixed(1),
    taskMsPerSec: (((m2.TaskDuration - m1.TaskDuration) / 3) * 1000).toFixed(1),
    nodes: m2.Nodes,
  };

  // SCROLL cost: scroll the library grid, time the frames.
  const scroll = await page.evaluate(async () => {
    const grid = document.getElementById('panel-scroll') || document.getElementById('fabric-grid');
    if (!grid) return { error: 'no scroll container' };
    const t0 = performance.now();
    let frames = 0;
    for (let i = 0; i < 30; i++) {
      grid.scrollTop += 40;
      await new Promise(r => requestAnimationFrame(() => { frames++; r(); }));
    }
    return { ms: +(performance.now() - t0).toFixed(1), frames, avgFrameMs: +((performance.now() - t0) / 30).toFixed(2) };
  });

  console.log(JSON.stringify({ counts, restChurn, scroll }, null, 2));
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
