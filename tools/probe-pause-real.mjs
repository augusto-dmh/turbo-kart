#!/usr/bin/env node
/**
 * Orchestrator probe — traces the REAL Escape key path (CDP key events) through
 * the capture listener (menus) and the bubble listener (input) while paused.
 */
import puppeteer from 'puppeteer-core';

const URL_ = 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-gpu', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__TURBO_KART__', { timeout: 20000 });
await sleep(1200);

// ---- recorder ---------------------------------------------------------------
await page.evaluate(async () => {
  const { bus } = await import('/src/core/events.js');
  const { EVENTS } = await import('/src/contracts.js');
  window.__LOG__ = [];
  const L = (...a) => window.__LOG__.push(a);
  bus.on(EVENTS.UI_PAUSE, () => L('BUS UI_PAUSE'));
  bus.on(EVENTS.UI_RESUME, () => L('BUS UI_RESUME'));
  window.addEventListener('keydown', (e) => L('keydown(capture)', e.code), true);
  window.addEventListener('keydown', (e) => L('keydown(bubble)', e.code));
  window.__SNAP__ = () => {
    const g = window.__TURBO_KART__;
    return {
      paused: g.paused,
      state: g.state,
      menusOpen: g.menus?._open ?? null,
      menusKind: g.menus?.kind ?? null,
      inputEnabled: g.input?.enabled ?? null,
      pauseShown: g.input?.pauseShown ?? null,
    };
  };
});

await page.evaluate(() => window.__TURBO_KART__.startRace({ ...window.__TURBO_KART__.config }));
await sleep(2500);

const out = [];
for (let i = 1; i <= 3; i++) {
  await page.evaluate(() => { window.__LOG__.length = 0; });
  await page.keyboard.press('Escape');
  await sleep(700);
  const snap = await page.evaluate(() => window.__SNAP__());
  const log = await page.evaluate(() => window.__LOG__.map((l) => l.join(' ')));
  out.push({ press: i, snap, log });
}

// what does the pause menu's own Resume button do?
const resumeBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#ui-root button')].find((x) => /resume/i.test(x.textContent) && x.offsetParent !== null);
  if (!b) return 'not-found';
  b.click();
  return 'clicked';
});
await sleep(600);
const afterClick = await page.evaluate(() => window.__SNAP__());

console.log(JSON.stringify({ out, resumeBtn, afterClick }, null, 2));
await browser.close();
