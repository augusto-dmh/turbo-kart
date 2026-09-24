# Agent 3 — AI, Race Logic & Items

Scope: believable opponents, bullet-proof lap rules, and items that read in one
glance. Owner of `src/ai/**`, `src/race/**`, `src/items/**` (plus this report).
Nothing outside those folders was modified.

---

## 1. Files

| File | Role |
| --- | --- |
| `src/ai/rng.js` | `hashString`, `mulberry32`, `Rng` (fork/weighted/pick), `createRng(...parts)` — deterministic gameplay randomness |
| `src/ai/racingLine.js` | `RacingLine` — shared, cached per track: apex-clipping offsets, corner detection, speed profile, drift zones |
| `src/ai/aiDriver.js` | `AIDriver`, `DIFFICULTY_TUNING` — pure-pursuit driving, difficulty, personality, recovery, avoidance, rubber-band, item strategy, rocket start |
| `src/race/progress.js` | Pure u/angle math (`wrap01`, `wrapDelta`, `forward01`, `angleToLeft`, `approach`, `circularBlur`, …) |
| `src/race/lapTracker.js` | `LapTracker` — ordered-checkpoint lap validation + arc-based progress metric |
| `src/race/raceManager.js` | `RaceManager` — countdown, standings, finish/results flow, wrong way, timer |
| `src/items/itemEvents.js` | Additive bus event name (`item:hazards`) shared by ItemSystem → AIDriver |
| `src/items/itemMeshes.js` | `ItemMeshLibrary` — all procedural item geometry/materials/textures |
| `src/items/projectiles.js` | `ProjectileManager` — shell/banana movement, wall bounces, collision, lifetime |
| `src/items/itemSystem.js` | `ItemSystem`, `ROULETTE_TABLE` — boxes, roulette, all 8 items, shields, FX/audio events |

Every file passes `node --check`. The sim (8 karts, AI + items + race logic)
was measured at **0.06–0.13 ms/frame** in a headless node harness.

---

## 2. Public API

### `AIDriver` — `new AIDriver({ THREE, bus, kart, trackApi, difficulty, index })`
- `update(dt, { raceManager, karts, state }) → InputState` (same object reused every frame).
  `state` is `main.js`'s game state (`'countdown' | 'racing' | 'results'`).
- `wantsItem() → boolean` — true on the frame the AI pulses `input.useItem` (rising edge, retried at most every 0.3 s).
- `dispose()` — unsubscribes from the bus.
- Fields: `input`, `debug` (`{mode, targetU, lateralTarget, targetSpeed, speed, throttle, brake, steer, drift, errLeft, place, topSpeed, item, rubber, steerSign, stuck}`), `heldItem`, `heldCount`, `heldSince`, `topSpeed`, `line`, `personality`, `rng`.
- Side effect (documented): writes `kart.input = input` each frame so the ItemSystem sees the same `InputState` object (the contract says `kart.input` is the last InputState; this is a safety net if the Kart never stores it).

### `RaceManager` — `new RaceManager({ bus, THREE, karts, trackApi, laps, playerKart, solo })`
- `start()`, `update(dt)`, `dispose()`.
- `state` (`'countdown' | 'racing' | 'finished'`), `standings[]`, `playerPlace`, `playerFinished`, `raceTime`, `laps`, `countdownValue` (3/2/1/0 then `null`), `countdownRemaining` (exact seconds), `results` (final table).
- `standings` entry: `{ kart, place, lap, progress, finished, finishTime, gap, projected, lapTimes, bestLap, isPlayer, distToGate }` — `kart` is the live kart object.
- Helpers: `entryFor(kart)`, `gapFor(kart)`.
- Events out: `RACE_COUNTDOWN {value, exact, total}` (10 Hz + every integer tick), `RACE_START`, `RACE_LAP {kart, lap, laps, lapTime, best}`, `RACE_FINAL_LAP {kart}` (once per kart), `RACE_FINISH {kart, place, time}` (**player only**), `KART_FINISHED {kart, place, time}` (every kart), `RACE_COMPLETE {standings, time, laps}`, `RACE_TIMER {time}` (4 Hz, `final: true` on the last tick), `KART_WRONG_WAY {kart, wrongWay}`, `CAMERA_SHAKE {amount, duration}` on the player's item hits.
- Events in: `KART_HIT` (only for the player shake).

### `ItemSystem` — `new ItemSystem({ bus, THREE, scene, karts, trackApi, playerKart, difficulty })`
- `update(dt, { raceManager })`, `rollItem(kart) → bool`, `useItem(kart) → bool`, `getItemFor(kart) → ItemDef|null` (null while rolling), `isRolling(kart) → bool`, `chargesFor(kart) → number`, `dispose()`, `debugInfo`.
- Events out: `ITEM_BOX {kart}`, `ITEM_ROLL {kart, item, itemId}`, `ITEM_USE {kart, item, itemId}`, `ITEM_HIT {kart, item, itemId, from, power?, position?}`, `ITEM_BLOCKED {kart, item, itemId, blocked, blockedId, from}`, `ITEM_EXPIRE {kart, item, itemId, reason, position}`, `FX_SPAWN {kind: 'explosion'|'shell-trail'|'star-aura'|'lightning', position, opts}`, `AUDIO_SFX {name, opts}` (names from `SFX`), `CAMERA_SHAKE`, `item:hazards {hazards:[{x,y,z,radius,kind,from}]}` (~8 Hz).
- Events in: none (item use is detected from `kart.input.useItem` rising edges, per the brief).

---

## 3. Difficulty tuning table (`DIFFICULTY_TUNING`)

| | easy | normal | hard | expert |
| --- | --- | --- | --- | --- |
| `topSpeed` — cruise cap on straights × observed top speed | 0.78 | 0.89 | 0.96 | 1.00 |
| `cornerScale` — corner speed vs. racing-line profile | 0.90 | 0.94 | 1.00 | 1.04 |
| `steerGain` / `steerRate` (steer units per second) | 1.38 / 3.2 | 1.45 / 3.4 | 1.60 / 4.2 | 1.70 / 5.0 |
| `reaction` — input latency (s) for steer/throttle/drift | 0.22 | 0.18 | 0.10 | 0.055 |
| `driftSkill` (0..1) / `driftLevel` waited for | 0.30 / 1 | 0.55 / 2 | 0.78 / 2 | 0.95 / 2 |
| `mistakeRate` (per second) / duration (s) | 0.16 / 0.5–1.4 | 0.09 / 0.4–1.1 | 0.04 / 0.3–0.8 | 0.012 / 0.25–0.6 |
| `itemSkill` / `itemDelay` (s after roll) / `itemHold` (s) | 0.45 / 0.55 / 13 | 0.65 / 0.35 / 10 | 0.85 / 0.22 / 7 | 1.00 / 0.12 / 5 |
| `aggression` (room given, item eagerness) | 0.65 | 0.80 | 0.95 | 1.10 |
| `rubber` (rubber-band strength) | 1.25 | 1.00 | 0.70 | 0.45 |
| `lookahead` multiplier | 1.05 | 1.00 | 1.05 | 1.10 |
| `rocketAccuracy` (0..1, how close to GO) | 0.45 | 0.65 | 0.85 | 1.00 |

Measured on the headless harness (549 m technical track, 3 laps, 6 AI karts,
7 m/s²-agnostic stub kart physics): off-road time 0.0–0.3 %, finishing times
~84–94 s (easy), ~79–84 s (normal), ~77–80 s (hard), ~74.5–76.5 s (expert).

Extras:
- **Latency buffer**: the AI emits the input it decided `reaction` seconds ago (160-slot ring); the lookahead is scaled by `1 + reaction*1.6` so a laggy driver takes calm wide lines instead of twitching off-road.
- **Milliseconds mistake**: for 0.25–1.4 s the AI runs a wide line (`wide`) or lifts (`lift`), sorted by the seeded RNG.
- **Personality** per character from `CharacterDef.stats`: `aggression` (weight/speed), `precision` (grip → line scale + steer rate), `driftLove` (accel), `itemLove` (speed), a fixed lateral bias (±0.5·maxInset·0.45), a slow sine wander (period 7–17 s) and a personal item hold limit. Easy/normal/hard/expert variants are visible as a ~110 s / ~95 s / ~81 s / ~78 s finishing spread over 3 laps of a 549 m test track.
- **Rocket start**: throttle is never pressed before `RACE.ROCKET_START_WINDOW`; the press point inside the window is a per-driver deterministic random in `[0.03, 0.35]` biased toward 0.02 by `rocketAccuracy`.
- **Self-calibrating steer sign**: the shipped `Kart` documents `steer > 0 = LEFT`,
  which is what the AI assumes (`steer = +errLeft · gain`). A conservative
  detector verifies it from the observed yaw response (two consecutive 1 s
  windows of strongly negative evidence) and a one-shot "lost" detector flips
  the sign if the AI spends > 6 s continuously failing to hold the line early in
  the race. Measured: **0 false flips** on the shipped convention, self-heals in
  ~8 s against an inverted kart.
- **Top speed**: read from `kart.topSpeed` when the kart exposes it (the shipped
  Kart does), otherwise a conservative estimate that adapts upward; the cruise
  cap and corner profile are multiplied by it.
- **Gimmick seeking**: boost pads / ramps from `trackApi.gimmicks` within ~22 m
  ahead pull the lateral target toward their offset (60 % blend), so the AI
  takes pads like a human instead of ignoring them.
- **Rubber banding** (documented, subtle, tunable): dead zone ±0.16 laps vs. the player; beyond that a linear ramp over 0.5 laps gives up to +5.5 %×`rubber` target speed and 1.5× item aggression when behind, or −5 %×`rubber` when ahead. Behind by >~0.38 laps the AI additionally gets `applyBoost(0.5, 1.3 s, 'rubber')` at most every `clamp(10 − 4·rubber, 4, 12)` s. `rubber` is 1.25 (easy) → 0.45 (expert).

---

## 4. Item probability table (`ROULETTE_TABLE`, per place band)

Weights are relative and sum to 100 per band. Only non-player karts get a ±15 % bounded nudge on the strong items (`AI_ITEM_BIAS`, easy 0.85 → expert 1.15); the player's table is never modified.

| place | banana | green | mushroom | triple-mush | red | triple-shell | star | lightning |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1st | 30 | 30 | 15 | 10 | 10 | 5 | – | – |
| 2nd | 22 | 26 | 18 | 12 | 14 | 8 | – | – |
| 3rd–4th | 15 | 20 | 20 | 14 | 16 | 10 | 5 | – |
| 5th–6th | 8 | 12 | 18 | 18 | 16 | 18 | 10 | – |
| 7th–8th | – | – | 10 | 22 | 12 | 18 | 20 | 18 |

Roulette timing: 0.7 s + 0–0.15 s jitter (`isRolling() === true`, `getItemFor() === null`), then `ITEM_ROLL`.

**Item behaviour**

| item | effect | details |
| --- | --- | --- |
| `mushroom` | `applyBoost(1.3, 1.7 s, 'mushroom')` | single charge |
| `triple-mushroom` | `applyBoost(1.2, 1.4 s)` | 3 charges, one per press |
| `banana` | dropped 2.3 m behind | 30 s life, scale fade-out over the last 2.6 s, spins whoever touches it |
| `green-shell` | straight, 23 m/s + 35 % of the kart's speed | wall bounces (real impacts only; scrapes slide), 8 s life |
| `red-shell` | homing, 27 m/s, 3 rad/s turn | targets the next kart ahead; breaks after 2 wall hits or when it misses (distance growing for 1.6 s), 12 s life |
| `triple-shell` | 3 purple shells orbiting the kart | one shell fired per press, charges consumed in order |
| `star` | `setInvincible(8 s)` + `applyBoost(1.0, 8 s)` | star-aura FX; contact within 2.4 m knocks the other kart away (`applyImpulse` 8 m/s + 1.1 s spin), 0.9 s per-victim grace |
| `lightning` | all other karts | `spinOut(1.0)` + `squash(3.2)` (shrink + slow), `ITEM_HIT` each, `<SFX.THUNDER>`, `'lightning'` FX, camera shake; star-protected karts are immune; **never the user** |

**Blocking / shields**: a held banana/green/red/triple shell absorbs an incoming
shell or banana — one charge is consumed, `ITEM_BLOCKED` is emitted and the kart
gets a 0.75 s grace instead of spinning. Star invincibility blocks everything.
Hit karts spin for 1.35 s and emit `ITEM_HIT`; the player also triggers
`CAMERA_SHAKE`.

---

## 5. Race logic guarantees

- Checkpoints must be crossed **in order**; the last `checkpointUs` entry is the
  finish line. Reversing over the line never credits anything; a teleport-sized
  `u` jump (> 0.1) resyncs the gate cursor without credit; up to one lap per
  frame is possible if a frame spans multiple gates.
- The finish line is resolved against `startU` and the gates are re-ordered by
  their forward distance from it, so tracks that express `checkpointUs` as
  `i / count` (the last value being exactly 1, which wraps to 0 = `startU`) are
  handled correctly — a naive ascending sort would pick the wrong finish gate.
- Progress = `lap − 1 + fractionOfLap` derived from **signed accumulated arc**:
  it drops while reversing (so reversing can never gain places) and cannot be
  farmed by backing up and re-covering ground.
- Tie-break: metres to the next checkpoint (then array order).
- A lap is only credited when the arc since the last lap start is ≥ 45 % of the
  track length (anti-cut / anti-line-camping safety net).
- `kart.lap` is clamped to `[1, laps]` and kept in sync; `kart.state.finished`
  and `kart.finished` are set on finish; `kart.finishTime` is stored.
- Solo/time trial: 1 kart, no items, results emitted immediately after the
  finish with lap times; `raceTime` is frozen at completion.
- Results always contain a full ordered table: unfinished karts get a
  `projected: true` finish time extrapolated from their average pace (clamped
  6–90 m/s).
- Wrong way: `dot(forward, tangent) < −0.3` for > 1 s sets `kart.state.wrongWay`
  and emits on change; clears after 0.25 s of correct heading. The AI reacts.
- Safety net: a race is force-completed after 600 s so a stuck player never
  soft-locks the session.

Manual mental tests executed against `LapTracker` (all pass in a node harness):
full 3-lap race, reverse over the line, pause exactly on a gate, unsorted
`checkpointUs`, single-checkpoint track (no instant lap at the start), frames
spanning several gates, forward teleport (respawn) across checkpoints,
finishing exactly on the checkpoint `u`, and a `RaceManager` end-to-end race
with ordering, grace period (measured 8.02 s) and projected times.

---

## 6. Known gaps / deliberate simplifications

1. **Throttle is a proportional band, not a pedal model.** `InputState.throttle`
  is 0..1 and the shipped Kart scales engine force by it, so the AI uses a
  proportional controller (full throttle below the target, 0.8 → 0 across a
  ~25 % over-speed band). The hardware "cruise cap" on straights (`topSpeed`)
  is therefore a soft lift rather than a hard limiter.
2. **Top-speed estimate is adaptive.** It starts at `14 + stats.speed·1.6`
  (deliberately low) and grows from observation; the first ~5 s of the race are
  a full-throttle probe (only on straights), after which the cruise cap applies.
3. **Reverse/U-turn steering** assumes an inverted steering response while
  backing up (`steer = −steer`). If a kart implementation disagrees, the 4 s
  stuck timer respawns the kart, so it can never get permanently stuck.
4. **Bananas fade by scale**, not opacity, because the banana material is shared
  between all instances.
5. **Hit karts keep their held item** unless they actively blocked (only
  blocking consumes). This is a deliberate choice, documented here.
6. **Green shells can miss in corners** (straight flight, as in the genre). The
  AI only fires them when the road ahead is straight-ish and the target is
  within 26 m, but a wily player can still bait a miss.
7. **No 3D roulette animation**; the roulette is exposed to the HUD through
  `isRolling()` / `getItemFor()` (HUD-side animation by Agent 4).
8. **Racing line cache** is keyed by `track.id|round(length)|round(halfWidth·10)`
  and never invalidated during normal play (the geometry is deterministic per
  track). `RacingLine.clearCache()` exists for tests.
9. **Item hazard feed** is a ~8 Hz snapshot with reused objects; it is an
  approximation (AI avoidance is a lateral bias, not a full planner).
10. **No kart-vs-kart physics** is implemented here — only AI steering/avoidance
  and item impulses; the Kart agent owns body collisions.
11. `easy` corner behaviour was tuned on a deliberately pathological track
  (curvature almost everywhere). On a normal track with straights the measured
  off-road time is 0.0–0.8 %.

---

## 7. Contract deviations — additive only

- **New bus event `item:hazards`** (`src/items/itemEvents.js`) — ItemSystem →
  AIDriver hazard feed. Nothing in the frozen contract changed.
- **New public fields** (all additive):
  - `RaceManager`: `countdownRemaining`, `playerFinished`, `results`,
    `entryFor()`, `gapFor()`. `results` entries add `projected`, `lapTimes`,
    `bestLap`, `distToGate`, `isPlayer`.
  - `AIDriver`: `wantsItem()`, `debug`, `heldItem`, `topSpeed`, `line`, `rng`,
    `difficulty`, `tuning`.
  - `ItemSystem`: `chargesFor()`, `debugInfo`.
- **Payload additions** (existing keys unchanged): `RACE_COUNTDOWN` adds
  `exact`/`total`; `RACE_LAP` adds `lapTime`/`best`; `RACE_COMPLETE` adds
  `time`/`laps`; `RACE_TIMER` adds `final` on the last tick; `KART_FINISHED`
  adds `{place, time}`; item events add `itemId` (and `position`/`reason` where
  useful).
- **`item` payloads are the `ITEMS[id]` def object** (the same object
  `getItemFor()` returns, which contains `.id`), plus an `itemId` string for
  convenience. If any consumer does `ITEMS[payload.item]`, use `payload.itemId`.
- **`RACE_FINISH` is emitted for the player only** (the brief's wording);
  every kart gets `KART_FINISHED` and the full table arrives in `RACE_COMPLETE`.
- `AIDriver` imports `runtime` helpers from `../items/itemEvents.js` and
  `../race/progress.js`; `ItemSystem` imports `createRng` from `../ai/rng.js`.
  All three are Agent 3 files, so this is intra-owner sharing, not
  cross-subsystem coupling (no gameplay logic is executed across owners).
- `AIDriver` writes `kart.input` (a contract field) to make the item rising
  edge robust. If the Kart agent stores its own copy, the write is a harmless
  same-value assignment.

## 8. For the integrator / other agents

- **`trackApi.project()` returns a pooled object** (Agent 2's `projection.js`
  rotates a small pool), so a result must be consumed immediately and never
  stored across another `project()` call. All Agent 3 consumers (AI, race
  validation, items/projectiles) read `u`/`lateral`/`tangent` right away.
- `ItemSystem` requires `kart.input.useItem` to be the last InputState
  (contract). AI karts are covered by `AIDriver`; the player by `Kart`
  (the shipped Kart assigns `this.input = input` in `update`, and it emits
  `KART_FINISHED` itself — `RaceManager` detects that and does not double-emit).
- The shipped Kart's steer convention (`steer > 0 = LEFT`) matches the AI's
  default; `kart.topSpeed` is used when present.
- Suggested de-duplication: the audio layer can listen to the item events
  *or* to `AUDIO_SFX`; ItemSystem emits both, so pick one to avoid double SFX.
  Likewise the player's camera shake arrives both from `KART_HIT`
  (RaceManager) and from the Kart's own `spinOut` — take the max, not the sum.
- `RaceManager` never touches `kart.progress` (the Kart owns the raw `u`).
- `ItemSystem` is only constructed in non-solo modes by `main.js`; the AI
  degrades gracefully when it is absent (no item use, `heldItem` stays null).

---

## 9. Verification performed (all green, newest run)

- `node tests/smoke.mjs` → **PASS** (module inventory, syntax, exports, contracts,
  imports, no stubs/banned patterns, headless FX, headless integration race sim:
  `laps=18 finalLap=8 boost=109 drift=1069 hits=28 items=40/33 finish=1 complete=1`).
- Race logic harness (in `/tmp`, not shipped): 8 scenarios incl. reverse over the
  line, pause on a gate, unsorted/single `checkpointUs`, multi-gate frames,
  teleport resync, 3-lap finish, `RaceManager` ordering + 8.02 s grace.
- Item harness: box pickup → roulette → `ITEM_ROLL`, all 8 items, triple charges,
  banana hit, green/red shell hits, star contact knockback, lightning excluding
  the user, block + grace, box respawn, determinism, full scene cleanup.
- AI harness (headless, technical 549 m track, 6 AI karts): 0.0–0.3 % off-road,
  no respawns, no NaN, 0 steer-sign flips on the shipped convention, correct
  spread over difficulties; recovery cases (spun, backwards, off-road, wedged →
  respawn after 4 s) all recover and keep lapping.
- Full integration (AI + RaceManager + ItemSystem, 8 karts, 3 laps): 5/5 races
  complete for easy/normal/hard/expert + solo, 14–28 item rolls per race,
  8 `RACE_FINAL_LAP`, 8 `KART_FINISHED`, 1 `RACE_COMPLETE`, ≤ 0.08 ms/frame.
