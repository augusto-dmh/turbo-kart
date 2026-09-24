/**
 * Orchestrator probe — full race with the game's own AI driving the player kart.
 * Loaded via: node tools/browser-qa.mjs --gpu --eval-file tools/probe-race.js
 *
 * Returns a JSON summary (puppeteer awaits the promise).
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = window.__TURBO_KART__;
  if (!g) return { ok: false, error: 'window.__TURBO_KART__ missing' };

  const errors = (window.__TK_ERRORS__ = window.__TK_ERRORS__ || []);
  const origError = console.error;
  console.error = (...a) => { errors.push({ kind: 'console', message: a.map(String).join(' ').slice(0, 400) }); origError(...a); };
  window.addEventListener('error', (e) => errors.push({ kind: 'error', message: String(e.message).slice(0, 400) }));

  // ---- walk the menus with real clicks --------------------------------------
  const menuLog = [];
  for (let i = 0; i < 14; i++) {
    if (g.state === 'countdown' || g.state === 'racing') break;
    const clicked = await (async () => {
      const root = document.querySelector('#ui-root');
      const btns = [...(root?.querySelectorAll('button, [data-click], [role="button"]') ?? [])].filter((b) => b.offsetParent !== null);
      const rank = (t) => (/start|race|continue|next|go\b|play|ok|confirm|select/i.test(t) ? 2 : /character|track|mode|difficulty|gp|versus|time|easy|normal|hard|expert/i.test(t) ? 1 : 0);
      btns.sort((a, b) => rank(b.textContent) - rank(a.textContent));
      if (!btns.length) return null;
      const label = (btns[0].textContent || '').trim().slice(0, 40);
      btns[0].click();
      return label;
    })();
    menuLog.push({ step: i, screen: (document.querySelector('#ui-root')?.innerText || '').replace(/\s+/g, ' ').slice(0, 90), clicked });
    if (!clicked) await page?.keyboard?.press?.('Enter');
    await sleep(600);
  }

  if (!g.race) return { ok: false, error: 'race never started', menuLog, state: g.state };

  // ---- drive the player with the game's own AI ------------------------------
  const { AIDriver } = await import('/src/ai/aiDriver.js');
  const { bus } = await import('/src/core/events.js');
  const player = g.race.karts.find((k) => k.isPlayer);
  const driver = new AIDriver({ THREE: g.engine.THREE, bus, kart: player, trackApi: g.race.trackApi, difficulty: 'hard', index: 0 });
  const origUpdate = g.input.update.bind(g.input);
  g.input.update = (dt, opts) => {
    origUpdate(dt, opts);
    const inp = driver.update(dt, { raceManager: g.race.raceManager, karts: g.race.karts, state: g.state });
    Object.assign(g.input.state, inp);
  };

  // ---- sample until the race finishes (or 3 minutes) ------------------------
  const samples = [];
  let frames = 0;
  const tick = () => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const t0 = performance.now();
  const hudLap = () => {
    const m = (document.querySelector('#ui-root')?.innerText || '').match(/LAP\s*(\d+)\s*\/\s*(\d+)/i);
    return m ? `${m[1]}/${m[2]}` : null;
  };
  while ((performance.now() - t0) / 1000 < 180 && g.state !== 'results') {
    await sleep(2000);
    const rm = g.race.raceManager;
    const t = (performance.now() - t0) / 1000;
    samples.push({
      t: +t.toFixed(1),
      fps: +(frames / t).toFixed(1),
      state: g.state,
      kartLap: player.lap,
      standingsLap: rm.standings.find((s) => s.kart === player)?.lap ?? null,
      hudLap: hudLap(),
      u: +(player.progress ?? 0).toFixed(3),
      place: rm.playerPlace,
      speed: +player.state.speed.toFixed(1),
      offRoad: !!player.state.offRoad,
      item: g.race.itemSystem?.getItemFor?.(player)?.id ?? null,
      order: rm.standings.map((s) => s.kart.name).join(','),
    });
  }

  const rm = g.race.raceManager;
  return {
    ok: true,
    menuLog,
    finalState: g.state,
    samples,
    summary: {
      seconds: samples.length ? samples[samples.length - 1].t : 0,
      fpsAvg: samples.length ? +(samples.reduce((a, s) => a + s.fps, 0) / samples.length).toFixed(1) : 0,
      fpsMin: samples.length ? Math.min(...samples.map((s) => s.fps)) : 0,
      maxLap: Math.max(...samples.map((s) => s.kartLap || 0)),
      maxSpeed: Math.max(...samples.map((s) => s.speed || 0)),
      offRoadPct: samples.length ? Math.round((100 * samples.filter((s) => s.offRoad).length) / samples.length) : 0,
      distinctOrders: new Set(samples.map((s) => s.order)).size,
      itemsSeen: [...new Set(samples.map((s) => s.item).filter(Boolean))],
      lapSyncOk: samples.every((s) => s.kartLap === s.standingsLap),
      hudLapOk: samples.filter((s) => s.hudLap).every((s) => s.hudLap === `${s.kartLap}/${g.race.raceManager.laps}`),
      resultsRows: (rm.results ?? rm.standings ?? []).length,
      results: (rm.results ?? []).slice(0, 8).map((s) => ({ place: s.place, name: s.kart?.name, time: s.finishTime, laps: s.lap })),
    },
    errors,
  };
})()
