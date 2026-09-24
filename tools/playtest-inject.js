/**
 * Turbo Kart — browser-side autopilot + telemetry injector.
 *
 * Usage (orchestrator): paste the body of `run()` into a browser.evaluate call
 * (or wrap: `(() => { ... })()`), then read the JSON result.
 *
 * It drives the game with synthetic key events, samples gameplay telemetry and
 * reports errors collected on window.__TK_ERRORS__ (installed by the runbook).
 */
export function autopilot(opts = {}) {
  const seconds = opts.seconds ?? 12;
  const keys = opts.keys ?? ['ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowUp'];
  const game = window.__TURBO_KART__;
  if (!game) return { ok: false, error: 'window.__TURBO_KART__ missing' };

  const press = (code, down) =>
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));

  const samples = [];
  let frames = 0;
  let last = performance.now();
  const t0 = performance.now();
  const held = new Set(keys);

  const sample = () => {
    frames++;
    const now = performance.now();
    if (now - last > 250) {
      const r = game.race;
      const p = r?.karts?.find?.((k) => k.isPlayer);
      samples.push({
        t: +((now - t0) / 1000).toFixed(1),
        state: game.state,
        fps: +((frames * 1000) / (now - t0)).toFixed(1),
        speed: +(p?.state?.speed ?? 0).toFixed(1),
        lap: p?.lap ?? null,
        place: r?.raceManager?.playerPlace ?? null,
        u: +(p?.progress ?? 0).toFixed(3),
        offRoad: !!p?.state?.offRoad,
        drifting: !!p?.state?.drifting,
        boosting: !!p?.state?.boosting,
        karts: r?.karts?.length ?? 0,
        items: r?.itemSystem ? 'yes' : 'no',
      });
      last = now;
    }
    if (now - t0 < seconds * 1000) requestAnimationFrame(sample);
    else finish();
  };

  const finish = () => {
    for (const k of held) press(k, false);
    const r = game.race;
    const final = {
      ok: true,
      seconds,
      samples,
      fpsAvg: samples.length ? +(samples.reduce((a, s) => a + s.fps, 0) / samples.length).toFixed(1) : 0,
      karts: r?.karts?.length ?? 0,
      standings: (r?.raceManager?.standings ?? []).map((s) => ({
        name: s.kart?.name, place: s.place, lap: s.lap, progress: +(s.progress ?? 0).toFixed(3),
      })),
      renderer: {
        calls: game.engine?.renderer?.info?.render?.calls,
        triangles: game.engine?.renderer?.info?.render?.triangles,
        programs: game.engine?.renderer?.info?.programs?.length,
      },
      errors: window.__TK_ERRORS__ ?? [],
    };
    window.__TK_RESULT__ = final;
    return final;
  };

  for (const k of held) press(k, true);
  requestAnimationFrame(sample);
  return { ok: true, started: true, note: 'poll window.__TK_RESULT__ for the report' };
}
