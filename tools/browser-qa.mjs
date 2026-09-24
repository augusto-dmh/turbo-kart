#!/usr/bin/env node
/**
 * Turbo Kart — headless browser QA harness (orchestrator tool, dev-only).
 *
 * Usage:
 *   node tools/browser-qa.mjs --auto --seconds 20 --out /tmp/opencode/tk-qa
 *   node tools/browser-qa.mjs --url http://127.0.0.1:5173/ --eval-file tools/probe.js
 *
 * It boots the game in headless Chrome (software WebGL), drives the menus with
 * keyboard events, runs an autopilot while sampling telemetry, takes screenshots
 * and writes `report.json` + `*.png` into --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : def;
};
const has = (name) => argv.includes(`--${name}`);

const URL_ = arg('url', 'http://127.0.0.1:5173/');
const OUT = arg('out', '/tmp/opencode/tk-qa');
const SECONDS = Number(arg('seconds', 20));
const QUALITY = arg('quality', null);
const EVAL_FILE = arg('eval-file', null);
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 900));
const AUTO = has('auto');
const GPU = has('gpu');
const TRACK = arg('track', null);
const MODE = arg('mode', null);

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(GPU
      ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
      : ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']),
    '--window-size=' + WIDTH + ',' + HEIGHT,
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

const consoleLog = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') consoleLog.push({ type: t, text: m.text().slice(0, 500) });
});
page.on('pageerror', (e) => pageErrors.push({ message: String(e.message).slice(0, 800), stack: String(e.stack || '').slice(0, 1200) }));
page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));

const report = { url: URL_, startedAt: new Date().toISOString(), quality: QUALITY, errors: [], screenshots: [], telemetry: [], notes: [] };
const shot = async (name) => {
  const file = path.join(OUT, `${name}.png`);
  try { await page.screenshot({ path: file }); report.screenshots.push(file); } catch (e) { report.notes.push(`screenshot ${name} failed: ${e.message}`); }
};

const state = () => page.evaluate(() => {
  const g = window.__TURBO_KART__;
  const r = g?.race;
  const p = r?.karts?.find?.((k) => k.isPlayer);
  return {
    hasGame: !!g,
    state: g?.state ?? null,
    paused: g?.paused ?? null,
    karts: r?.karts?.length ?? 0,
    aiDrivers: r?.aiDrivers?.length ?? 0,
    player: p ? { speed: +(p.state?.speed ?? 0).toFixed(2), lap: p.lap, u: +(p.progress ?? 0).toFixed(3), offRoad: !!p.state?.offRoad, drifting: !!p.state?.drifting } : null,
    standings: (r?.raceManager?.standings ?? []).slice(0, 8).map((s) => ({ name: s?.kart?.name ?? '?', place: s?.place, lap: s?.lap, progress: +(s?.progress ?? 0).toFixed(3), finished: !!s?.finished })),
    countdown: r?.raceManager?.countdownValue ?? null,
    uiVisible: !!document.querySelector('#ui-root')?.children?.length,
    bootHidden: !!document.getElementById('boot-overlay')?.classList.contains('hidden'),
    renderer: g?.engine?.renderer?.info?.render ?? null,
    sceneChildren: g?.engine?.scene?.children?.length ?? 0,
    hasAudioCtx: !!g?.audio?.ctx,
    window: { w: innerWidth, h: innerHeight },
  };
});

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // wait for the game object
  await page.waitForFunction('!!window.__TURBO_KART__', { timeout: 20000 }).catch(() => report.notes.push('window.__TURBO_KART__ never appeared'));
  await sleep(1500);
  report.boot = await state();
  await shot('01-boot');

  if (QUALITY) {
    await page.evaluate((q) => window.__TURBO_KART__?.applySettings?.({ quality: q }), QUALITY);
    await sleep(500);
  }

  if (EVAL_FILE) {
    const code = fs.readFileSync(EVAL_FILE, 'utf8');
    report.evalResult = await page.evaluate(code).catch((e) => ({ error: e.message }));
    await sleep(500);
    report.final = await state();
    await shot('07-final');
  } else if (AUTO) {
    // ---- direct race start (skip menus) when a track/mode is forced ----------
    if (TRACK || MODE) {
      await page.evaluate((trackId, mode) => {
        const g = window.__TURBO_KART__;
        g.startRace({ ...g.config, ...(trackId ? { trackId } : {}), ...(mode ? { mode } : {}) });
      }, TRACK, MODE);
      await sleep(2500);
      report.forced = await state();
      await shot('03-race-start');
    }
    // ---- walk the menus with the keyboard -----------------------------------
    const menuSteps = [];
    for (let i = 0; i < 14; i++) {
      if (TRACK || MODE) break;
      const s = await state();
      if (s.state === 'countdown' || s.state === 'racing') break;
      const visible = await page.evaluate(() => {
        const root = document.querySelector('#ui-root');
        const btns = [...(root?.querySelectorAll('button, [data-click], [role="button"]') ?? [])]
          .filter((b) => b.offsetParent !== null).map((b) => (b.textContent || '').trim().slice(0, 40));
        return { text: (root?.innerText || '').replace(/\s+/g, ' ').slice(0, 160), buttons: btns };
      });
      menuSteps.push({ step: i, state: s.state, screen: visible.text, buttons: visible.buttons });
      await shot(`02-menu-${String(i).padStart(2, '0')}`);
      // Prefer clicking the primary action if it looks like a start/continue button.
      const clicked = await page.evaluate(() => {
        const root = document.querySelector('#ui-root');
        const btns = [...(root?.querySelectorAll('button, [data-click], [role="button"]') ?? [])].filter((b) => b.offsetParent !== null);
        const rank = (t) => (/start|race|continue|next|go\b|play|ok|select|confirm/i.test(t) ? 2 : /character|track|mode|difficulty|gp|versus|time/i.test(t) ? 1 : 0);
        btns.sort((a, b) => rank(b.textContent) - rank(a.textContent));
        if (!btns.length) return false;
        btns[0].click();
        return (btns[0].textContent || '').trim().slice(0, 40);
      });
      if (!clicked) await page.keyboard.press('Enter');
      await sleep(700);
    }
    report.menuSteps = menuSteps;
    report.afterMenus = await state();
    await shot('03-race-start');

    // ---- autopilot ----------------------------------------------------------
    const keysDown = async (codes) => { for (const c of codes) await page.keyboard.down(c); };
    const keysUp = async (codes) => { for (const c of codes) await page.keyboard.up(c); };
    await keysDown(['ArrowUp']);
    const t0 = Date.now();
    let frames = 0;
    await page.evaluate(() => {
      window.__TK_FRAMES__ = 0;
      const tick = () => { window.__TK_FRAMES__++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    let i = 0;
    let drifted = false;
    let usedItem = false;
    while ((Date.now() - t0) / 1000 < SECONDS) {
      const elapsed = (Date.now() - t0) / 1000;
      // simple driving pattern: straight, then drift through alternating corners
      if (elapsed % 6 > 4.2) {
        await keysDown(['Space', i % 2 ? 'ArrowLeft' : 'ArrowRight']);
        drifted = true;
      } else {
        await keysUp(['Space', 'ArrowLeft', 'ArrowRight']);
      }
      if (!usedItem && elapsed > 5) { await page.keyboard.press('KeyE'); usedItem = true; }
      const s = await state();
      const f = await page.evaluate(() => window.__TK_FRAMES__);
      report.telemetry.push({ t: +elapsed.toFixed(1), fps: +(f / elapsed).toFixed(1), ...s });
      if (i % 4 === 0) await shot(`04-race-${String(i).padStart(2, '0')}`);
      i++;
      await sleep(1000);
    }
    await keysUp(['ArrowUp', 'Space', 'ArrowLeft', 'ArrowRight']);
    report.telemetry_summary = {
      samples: report.telemetry.length,
      fpsAvg: +(report.telemetry.reduce((a, s) => a + (s.fps || 0), 0) / Math.max(1, report.telemetry.length)).toFixed(1),
      fpsMin: Math.min(...report.telemetry.map((s) => s.fps || 0)),
      maxSpeed: Math.max(...report.telemetry.map((s) => s.player?.speed || 0)),
      lapsSeen: Math.max(...report.telemetry.map((s) => s.player?.lap || 0)),
      drifted,
      usedItem,
      standingsMoved: new Set(report.telemetry.map((s) => JSON.stringify((s.standings || []).map((x) => x.place)))).size > 1,
    };

    // ---- pause + resize -----------------------------------------------------
    report.pauseSteps = [];
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press('Escape');
      await sleep(600);
      const s = await state();
      report.pauseSteps.push({ press: k + 1, paused: s.paused, menuUp: !!(await page.evaluate(() => /PAUSED|RESUME/i.test(document.querySelector('#ui-root')?.innerText || ''))) });
      if (k === 0) await shot('05-paused');
    }
    report.paused = await state();
    await page.keyboard.press('Escape');
    await sleep(500);
    report.afterPauseToggle = await state();
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await sleep(800);
    report.afterResize = await state();
    await shot('06-resized');
    report.final = await state();
  }
} catch (err) {
  report.errors.push({ phase: 'harness', message: String(err?.message || err), stack: String(err?.stack || '').slice(0, 1500) });
}

report.console = consoleLog.slice(0, 80);
report.pageErrors = pageErrors;
report.failedRequests = failedRequests;
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

await browser.close();

const s = report.telemetry_summary;
console.log(`\n=== Turbo Kart QA ===`);
console.log(`boot: ${JSON.stringify(report.boot?.state)} | karts=${report.boot?.karts} uiVisible=${report.boot?.uiVisible} bootHidden=${report.boot?.bootHidden}`);
console.log(`afterMenus: ${JSON.stringify(report.afterMenus?.state)} karts=${report.afterMenus?.karts}`);
if (s) console.log(`fps avg/min: ${s.fpsAvg}/${s.fpsMin} | maxSpeed=${s.maxSpeed} | laps=${s.lapsSeen} | drift=${s.drifted} item=${s.usedItem} standingsMoved=${s.standingsMoved}`);
console.log(`pageErrors=${report.pageErrors.length} consoleIssues=${report.console.length} failedRequests=${report.failedRequests.length}`);
for (const e of report.pageErrors.slice(0, 6)) console.log('  PAGEERROR:', e.message.split('\n')[0]);
for (const c of report.console.slice(0, 6)) console.log(`  ${c.type.toUpperCase()}:`, c.text.split('\n')[0]);
console.log(`report: ${path.join(OUT, 'report.json')}`);
