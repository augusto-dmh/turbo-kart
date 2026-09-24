# Turbo Kart — orchestrator QA runbook

Live verification is done in Chrome through the browser tools against the Vite dev
server on `http://127.0.0.1:5173`.

## 0. Preconditions
- `npm run build` passes (static).
- `npm run smoke` passes (Agent 5's structural checks).
- Dev server running: `npx vite --host 127.0.0.1 --port 5173 --strictPort`.

## 1. Error trap (install before load)
```js
window.__TK_ERRORS__ = [];
const push = (kind) => (e) => window.__TK_ERRORS__.push({
  kind, message: e.message ?? String(e.reason ?? e), stack: e.error?.stack ?? null,
});
window.addEventListener('error', push('error'));
window.addEventListener('unhandledrejection', push('rejection'));
const origError = console.error;
console.error = (...a) => { window.__TK_ERRORS__.push({ kind: 'console', message: a.map(String).join(' ') }); origError(...a); };
```
`browser.console` is also used to read the console directly.

## 2. Boot & menu
1. `navigate` to `/`, wait for `window.__TURBO_KART__`.
2. `screenshot` → title screen must render (no black canvas, no boot overlay stuck).
3. Check `#boot-overlay` is hidden and `#ui-root` has menu content.
4. Assert: no errors in `__TK_ERRORS__`.

## 3. Race start
1. Click `START`, walk the menu flow (mode → character → track → difficulty).
2. Assert `game.state === 'countdown'` then `'racing'`.
3. Assert `game.race.karts.length === 8`, karts are on the grid, not stacked at origin.
4. Screenshot during countdown and at GO.

## 4. Gameplay autopilot
Run `tools/playtest-inject.js` → `autopilot({ seconds: 15 })` (paste into `browser.evaluate`).
Assert:
- `fpsAvg >= 45` (target 60 at `high`),
- player speed rises above 20 m/s on track, `u` advances, lap counter increments over a long run,
- standings change (AI actually races),
- renderer calls < ~1200, triangles sane (< ~1.5M),
- no errors.

## 5. Systems spot checks (via evaluate)
- Drift: hold drift + steer for 2 s → `state.drifting`, `driftLevel` rises, `KART_DRIFT_BOOST` fires on release.
- Items: force `itemSystem.rollItem(player)` then `useItem(player)` for each item id; assert no throw and projectiles appear (`scene.children` count grows, then cleans up).
- Pause: press Escape → `game.paused === true`, menu overlay visible; resume works.
- Resize: `window.resizeTo`/viewport change → renderer + composer resize without errors.
- Results: force `raceManager` to finish (e.g. set laps to 1) → results screen shows a full 8-row table.
- Audio: assert `AudioManager` context exists after a user gesture and does not throw.

## 6. Performance
- `browser.cpu.start` / `cpu.stop` + `cpu.analyze` while autopilot runs.
- `browser.trace.start/stop/analyze` for a frame-level look if fps < 45.
- Record: avg fps per quality preset (`applySettings({quality})`).

## 7. Sign-off
- Screenshots: title, character select, track select, countdown, mid-race (drift + items),
  minimap, results, pause.
- `npm run build` + `npm run preview` sanity check on the production bundle.
- Fill in the final report: what works, what is rough, how to run it.
