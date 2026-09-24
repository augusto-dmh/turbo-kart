# Turbo Kart — QA report (Agent 5)

**Scope:** structural + headless runtime QA of every subsystem, plus the FX/post-processing
modules I own. Everything below is reproducible without a browser:

```bash
npm run smoke                      # checks 1-11 (static + headless FX + headless race sim)
node tests/fx-headless.mjs         # FX/PostFX behaviour only
node tests/integration-headless.mjs# real track + karts + AI + race + items + FX, 4 min of sim
```

See `tests/README.md` for what each check means. The browser-only items are in the
[manual checklist](#manual-browser-checklist) at the bottom.

**Status legend:** `OPEN` = still broken, `FIXED` = verified fixed in a later run,
`TUNING` = works but is a gameplay-quality problem.

**Current state (final run):** `npm run smoke` → **PASS** (9 checks pass, 1 warning —
`package.json`/`package-lock.json` modified by the orchestrator for `puppeteer-core`).
`tests/integration-headless.mjs` completes a full 3-lap, 8-kart race with items and FX.
All three blockers found during the session were fixed by their owners and re-verified.

---

## 1. Blockers

### B1 — `src/ui/menus.js:165` duplicate `const s` → the whole app fails to build · FIXED
```js
120:  const s = Math.min((w - pad * 2) / 2.2, (h - pad * 2) / 2.2);  // scale
165:  const s = map[0];                                                // start point
```
`node --check` → `SyntaxError: Identifier 's' has already been declared`. Vite cannot
bundle `menus.js`, so `main.js` fails to import the module graph and **the game never
boots** (blank page + boot overlay stuck at "Building interface…").
Fixed by Agent 4 at 21:47 (`node --check src/ui/menus.js` is clean again).
Detected by smoke check 2 — keep it in the loop for future edits to `menus.js`.

### B2 — `src/track/trackBuilder.js` `_materials()` used an undefined `def` · FIXED
At 21:27 `TrackBuilder.build()` threw `ReferenceError: def is not defined`
(`trackBuilder.js:175` and `:195` used `def.…` while the local `const def = this.def`
only existed inside `build()`). Every race start would have crashed inside
`main.js → startRace()`. Re-verified fixed at 21:33 (the integration test now builds
`sunset-speedway` with 8 grid slots and a complete TrackApi).

### B3 — `src/track/trackBuilder.js:63-66` `new X.y(...)` precedence bug · FIXED
```js
out.setAttribute('position', new list[0].getAttribute('position').constructor(pos, 3));
```
`new X.y(...)` parses as `new (X.y)(...)`, so V8 threw
`TypeError: list[0].getAttribute is not a constructor` in `mergeGeos()`, called from
`_buildKerbs()` → `build()` died after the road was built. Re-verified fixed.
**Note for reviewers:** this pattern is a trap — always parenthesise:
`new (list[0].getAttribute('position').constructor)(pos, 3)`.

---

## 2. Major

### M1 — AI line-keeping · RESOLVED (was TUNING)
Earlier revisions of `AIDriver` lost the racing line constantly: at 21:30 a lone
`normal` kart spent **54 %** of a 120 s run off-road (avg 10.5 m/s, 38 % of frames in
`recover` mode, 25 excursions) while a 3-line pure-pursuit controller on the *same kart*
did 12 % off-road at 28.4 m/s — so the kart physics was fine and the AI was the bottleneck.
Agent 3 reworked it; measured at 21:52 on `sunset-speedway` (half-width 8 m), one kart,
90 s, no traffic:

| difficulty | time off-road | avg speed |
|---|---|---|
| easy | 19 % | 22.6 m/s |
| normal | 3 % | 31.0 m/s |
| hard | 9 % | 29.4 m/s |
| expert | 16 % | 26.3 m/s |

(`easy`/`expert` being worse than `normal` is expected: mistake rate rises with difficulty
and `easy` has a slower speed target.) Full-field sim: 3 laps, 18 lap events, race
completes. No action needed — listed for the record and because the numbers are the
baseline for any future AI tuning.

### M2 — Kart model detail ignores the quality preset · OPEN (perf nit)
`createKartMesh({ …, quality = 'high' })` supports detail tiers, but `main.js` constructs
karts without `quality`, so `Kart` always uses `'high'` geometry even on `low`.
**Fix (orchestrator, one line):** pass `quality: this.quality` in the `new Kart({...})` call
in `main.js` (and ideally to `AIDriver`/`ItemSystem` if they grow quality knobs).

---

## 3. Minor / nits

| # | file:line | finding | suggestion |
|---|---|---|---|
| m1 | `src/core/engine.js:307` | `_applyQuality()` resizes the renderer but never tells PostFX; a DPR-only change (moving the window to another monitor) leaves the composer at the old ratio until a `resize` event | call `this._postfx?.resize?.()` at the end of `_applyQuality()` (PostFX rebuilds its targets on quality change anyway) |
| m2 | `src/race/raceManager.js:300` | `RACE_FINISH` is emitted for the player only, so FX confetti never fires for an AI winner | acceptable by design; FX also accepts `FX_SPAWN { kind:'confetti', position }` from anyone |
| m3 | `src/fx/effects.js` (`getSpeedLines()`) | the FX speed-line hook is unused: the HUD drives its own `[data-fx="speedlines"]` overlay from `v.boosting` | either delete the hook or let the HUD read it (both are additive, no contract change) |
| m4 | `src/kart/kart.js:749` | emits `FX_SPAWN {kind:'drift-spark'}` **and** `KART_DRIFT_CHARGE`/`KART_DRIFT_BOOST`; FX deliberately draws a smaller burst for the FX_SPAWN variant to avoid doubling particles | keep in mind when tuning particle counts |
| m5 | `src/ui/menus.js` `drawTrackPreview` | builds a canvas preview per track on every menu render (it re-uses a cached canvas — verify with the browser pass) | measure in Chrome |
| m6 | `docs/reports/agent-3-ai-race-items.md`, `tools/*` | files added outside the five ownership areas (see smoke check 8 warnings) — expected for orchestrator/tooling, listed for completeness | none |

---

## 4. Verified OK (headless)

- **Contracts** — 38 events with matching keys *and* values, 8 unique characters, 3 tracks,
  `RACE.KART_COUNT === 8`; **no** `EVENTS.x` / `SFX.x` reference anywhere in `src/` points at
  a key that does not exist (smoke check 4).
- **Static health** — 43 modules parse, 86 relative imports resolve, no stub markers,
  no `fetch(`/XHR/`require(`/remote imports (smoke checks 1-7).
- **TrackBuilder** — `build()` returns a contract-complete TrackApi (all 20 fields),
  8 `{ position, heading }` grid slots, `project()` returns `{u, lateral, onRoad, tangent, up}`.
- **Kart** — drives, drifts (994 drift starts + charge stages), boosts, hops/lands, collides,
  respawns, emits the full event set; `position`/`forward`/`state` match the conventions.
- **AI** — produces a valid `InputState` every frame, recovers from being stuck, uses the
  racing line and hazards.
- **RaceManager** — countdown → racing → finished; 8 results rows, places 1..8, lap events,
  final-lap events, gap/projection math; `dispose()` unsubscribes.
- **ItemSystem** — `ITEM_BOX`/`ITEM_ROLL`/`ITEM_USE`/`ITEM_HIT`/`ITEM_EXPIRE` all fire, and it
  requests FX through `FX_SPAWN` (`shell-trail`, `star-aura`, `lightning`, `explosion`) —
  all of those kinds are handled by `Effects.spawn()`.
- **Effects** — 54 event payloads including malformed ones (`undefined`, `{}`, `{kart:null}`,
  string vs object items) never throw; budgets hold at low/medium/high/ultra
  (≤400 / ≤700 / ≤1200 / ≤1800); `setQuality` applies immediately and releases lights;
  `dispose()` is inert afterwards.
- **PostFX** — with a renderer that cannot host a composer, `render()` falls back to
  `renderer.render(scene, camera)` (no black screen) and logs once; `setQuality('low')`
  disables the composer.
- **Full race sim (headless)** — 4 minutes / 14400 frames of 8 karts + AI + items + FX:
  17-18 laps, 8 final laps, 30-50 hits, 30-58 item uses, 30-40 item boxes, 1 winner,
  complete results with 8 rows, peak 460-950 particles, no exceptions, ~1 s of CPU.

---

## 5. Manual browser checklist

Run with `tools/QA_RUNBOOK.md` (error trap first, then `http://127.0.0.1:5173`).
Everything below needs eyes on a real GPU.

**Boot & menu**
- [ ] No console errors / `__TK_ERRORS__` empty after load; no 404s.
- [ ] Title screen renders over the game canvas (no black frame, boot overlay fades out).
- [ ] Menu flow: mode → character → track → difficulty → race; keyboard + mouse both work.

**Race start**
- [ ] 8 karts on the grid in 4 rows, player in the last slot, karts facing along the track.
- [ ] Countdown 3-2-1-GO with beeps; camera snaps to the player (no fly-in from the menu orbit).
- [ ] Rocket start: hold throttle in the last 0.35 s → boost + fire burst + shake.

**Driving & feel**
- [ ] 60 fps at `high` on a mid-range laptop (measure with `browser.cpu`/`trace` if lower).
- [ ] Drift: hold drift + steer → hop, blue sparks at stage 1, orange at 2, purple at 3;
      mini-turbo burst on release (sparks + ring + light at ultra).
- [ ] Off-road dust is themed: sand on Sunset Speedway / Desert Dunes, white on Frozen Peaks.
- [ ] Hard landings: dust ring + debris; ramps and boost pads have visible feedback.
- [ ] Kart-vs-kart collisions produce sparks + shake (not just a sound).

**Items**
- [ ] Item box: sparkle burst + floating `?` ghost; roulette sound/anim; item slot fills.
- [ ] Mushroom → flame cone + streaks + speed lines; shells leave green/red trails;
      banana drops; star aura = rainbow sparkles orbiting the kart; lightning = white flash
      + world bolt + spark rain + shake; hits = orange fireball + smoke + debris.

**Presentation**
- [ ] Quality presets: `low` = no composer (flat but clean), `medium` = subtle bloom,
      `high` = bloom + vignette/aberration/grain + FXAA, `ultra` = + speed blur + SMAA.
      No washed-out or double-tone-mapped colours; no black screen when switching.
- [ ] Resize the window (and fullscreen toggle): renderer + composer follow, no stretching.
- [ ] Pause (Esc) freezes the world and camera; resume works; quit returns to the menu.
- [ ] Finish: confetti over the line, results table with 8 rows and lap times, restart works.
- [ ] Audio unlocks after the first gesture; engine pitch follows speed; music changes
      between menu/race/results; volumes from settings apply.

**Performance**
- [ ] `renderer.info.render.calls` stays sane during a full field drift/boost pile-up
      (FX adds ≤ ~20 draw calls when everything is on screen).
- [ ] Particle peak stays under the preset budget (`window.__TURBO_KART__.effects.getStats()`).
