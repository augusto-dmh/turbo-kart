# Turbo Kart — tests

Plain Node, no browser and no extra dependencies. `three` (a project dependency)
is used by the FX behaviour test; if it is not installed that single check is
reported as **skipped** instead of failing.

```bash
npm run smoke          # == node tests/smoke.mjs
node tests/smoke.mjs   # same thing
node tests/fx-headless.mjs   # FX behaviour test on its own
```

Exit code `0` = every check passed, `1` = at least one **FAIL**.
**WARN** results never fail the run — they are things the orchestrator should
look at (frozen files touched, changes outside an ownership area, …).

## `tests/smoke.mjs`

| # | Check | What it proves | Fails when |
|---|-------|----------------|------------|
| 1 | module inventory | every expected module exists and is non-empty | a file is missing or 0 bytes |
| 2 | syntax | `node --check` parses every `src/**/*.js` | any syntax error |
| 3 | required exports | each module exports the names `main.js` imports (`Engine`, `createInput`, `Kart`, `createKartMesh`, `getTrack`, `TRACK_DEFS`, `TrackBuilder`, `createEnvironment`, `AIDriver`, `RaceManager`, `ItemSystem`, `HUD`, `Menus`, `AudioManager`, `Effects`, `PostFX`) | a rename/typo breaks the integrator |
| 4 | contracts integrity | `EVENTS` keys **and** values match the frozen list, `CHARACTERS.length === 8` with unique ids, `TRACKS.length >= 3`, `QUALITY_PRESETS`, `RACE.KART_COUNT`, and no `EVENTS.x` / `SFX.x` reference anywhere points at a key that does not exist | the contract was edited or a module references a typo'd event |
| 5 | relative imports | every `from './x.js'`, bare `import './x.js'` and dynamic `import('./x.js')` resolves to a real file | a moved/renamed/missing module |
| 6 | stub markers | no `STUB —` / "Replace with the full implementation" left in `src/` | an agent shipped a stub |
| 7 | banned patterns | no remote `import ... from 'http(s)`, `fetch(`, `XMLHttpRequest`, `require(`, `new WebSocket(` in `src/` (comments are ignored) | network dependency or CJS in the browser bundle |
| 8 | ownership guard | changed files vs the baseline commit (`git rev-list --max-parents=0 HEAD`, override with `TK_BASELINE=<sha>`) grouped by owner; frozen/shared files and unknown paths are flagged | never (warnings only) |
| 9 | summary | counts + timing | never |
| 10 | headless FX | runs `tests/fx-headless.mjs` | a regression in `src/fx/**` |
| 11 | headless integration | runs `tests/integration-headless.mjs` | a regression in the track/kart/AI/race/item integration |

The baseline for check 8 can be overridden:

```bash
TK_BASELINE=$(git rev-parse HEAD) npm run smoke
```

## `tests/fx-headless.mjs`

Exercises the real `Effects`/`PostFX` implementations in Node (no WebGL):

- constructs `Effects` with a real `THREE.Scene`/`PerspectiveCamera`,
- emits **every** bus event the FX layer listens to, including malformed
  payloads (`undefined`, `{}`, `{ kart: null }`, string/object items) — nothing
  may throw,
- runs 400 frames at `ultra` and asserts the live-particle budget (≈1800) is
  respected while particles are actually produced,
- drops to `low` (≈400) and `medium` (≈700) and asserts the caps apply
  immediately, and that point lights are released when leaving `ultra`,
- asserts `dispose()` leaves an inert instance,
- constructs `PostFX` with a **stub renderer** that cannot host a composer and
  asserts `render()` still calls `renderer.render(scene, camera)` (the
  "never a black screen" contract) and that `setQuality('low')` disables the
  composer.

## `tests/integration-headless.mjs`

Boots the real gameplay stack the way `src/main.js` does and races it for up to four
simulated minutes (early exit when the race finishes):

```
TrackBuilder → startGrid → 8 × Kart → AIDriver × 7 → RaceManager → ItemSystem → Effects
```

- asserts the track API exposes every contract field and `startGrid` is
  `{ position, heading }` × 8,
- asserts the karts start spread over the grid and actually drive,
- asserts lap + final-lap events fire and the race reaches the results state with
  8 rows and places 1..8,
- asserts items fire and other subsystems request FX through `FX_SPAWN`,
- asserts the FX layer stays inside the high-quality particle budget,
- the player kart is steered by a tiny pure-pursuit controller (the real player input
  cannot be simulated headlessly; without steering the player kart drives off the road
  and the player-only finish/results flow could never be exercised),
- if `TrackBuilder.build()` throws, the failure is reported **and** the race still runs on
  a synthetic oval, so one broken module does not hide problems elsewhere.

## What these tests do *not* cover

WebGL/GPU behaviour, actual visuals, frame rate, audio output, DOM/UI and
gameplay. Those need the orchestrator's browser pass — see `tools/QA_RUNBOOK.md`
and the "manual browser checklist" in `QA_REPORT.md`.
