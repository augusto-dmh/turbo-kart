# Agent 1 — Engine & Kart report

Owner of: `src/core/engine.js`, `src/core/input.js`, `src/kart/kart.js`,
`src/kart/kartFactory.js` + new files under `src/core/` and `src/kart/`.

---

## 1. Files

| File | Lines | Purpose |
|---|---|---|
| `src/core/engine.js` | ~520 | Renderer, color pipeline, quality presets, lighting rig, camera, resize |
| `src/core/cameraRig.js` | ~290 | Chase camera: springs, FOV kick, look-back, shake, modes, clamps |
| `src/core/input.js` | ~570 | Keyboard + gamepad + touch → one live `InputState` |
| `src/core/mathUtils.js` | ~130 | clamp/lerp/damp/wrap/smoothDamp/SpringValue (no deps) |
| `src/core/rng.js` | ~50 | mulberry32 seeded RNG + `hashString`/`rngFor` |
| `src/kart/kart.js` | ~1180 | Kart physics, drift, boosts, surfaces, collisions, events |
| `src/kart/kartPhysics.js` | ~180 | **All** tuning constants + stat→tuning derivation |
| `src/kart/kartModels.js` | ~560 | Procedural kart/driver geometry, vertex-colour merge, number decal |
| `src/kart/kartFactory.js` | ~330 | Mesh assembly, materials, animation, quality swap, dispose |

Every file passes `node --check`. No new dependencies, no DOM/network access at
module scope (only `DataTexture`, no `document` for assets).

---

## 2. Public API (exact)

### `Engine` — `src/core/engine.js`
```js
new Engine({ canvas, quality = 'high', bus? })
engine.THREE, engine.scene, engine.camera, engine.renderer, engine.quality
engine.sun, engine.hemi, engine.rim, engine.sunTarget, engine.sunDir   // lighting handles
engine.maxAnisotropy, engine.extras                                   // { shadows, shadowMapSize, pixelRatio, rimLight, anisotropy, antialias }
engine.setQuality(q)                 // 'low'|'medium'|'high'|'ultra' (unknown → 'high'); never throws
engine.setAtmosphere({ background, fogColor, fogNear, fogFar, sunColor, sunIntensity,
                       ambientColor, ambientIntensity, rimColor, rimIntensity, exposure, sunDirection })
engine.applyAnisotropy(level?, root?)  // returns the applied level; use on your own textures
engine.updateCamera(dt, kart, { mode, lookBack, paused })   // kart may be undefined; paused = hold still
engine.updateMenuCamera(dt)
engine.resetCamera(kart?)            // snap; also auto-snaps when the kart instance changes
engine.render(postfx?)               // postfx.render() if present, else renderer.render()
engine.resize(), engine.onResize(cb) // cb({ width, height, pixelRatio, aspect }) → unsubscribe fn
engine.groundHeightAt(x, z, fallback), engine.setTrack(api?), engine.dispose()
```
* Color pipeline: `SRGBColorSpace` + `ACESFilmicToneMapping` (exposure 1.05/1.06),
  `PCFSoftShadowMap`, capped pixel ratio (low 1 / medium 1.5 / high & ultra 2),
  `antialias` decided at construction (`quality !== 'low'`).
* Shadow map sizes 512/1024/2048/4096; shadows off on `low`.
* The **shadow camera follows the player** with a ±70/90/110/130 m frustum,
  texel-snapped in light space (no swimming). Tighter than a static ±250 m and
  ~3× the effective resolution; documented deviation.
* `setAtmosphere` only touches fields you pass — it will not fight `scene.fog`
  or `scene.background` set directly by the environment agent.
* Camera shake listens to `EVENTS.CAMERA_SHAKE` on the **shared bus singleton**
  (the `Engine` constructor receives no bus from `main.js`).

### `createInput({ bus, domElement })` — `src/core/input.js`
```js
input.state            // live InputState: throttle, brake, steer, drift, useItem, lookBack
                       //   + resetRequested (1 frame), device, pauseRequested
input.update(dt, { active })   // active=false → zeroed
input.setEnabled(bool)         // false → zeroes state + hides touch layer
input.rumble(strength, duration)          // gamepad vibrationActuator + navigator.vibrate
input.isTouch, input.lastDevice, input.hasGamepad, input.pad, input.enabled
input.bindings                 // live: { keys, gamepad, touch, digitalSteerRate, analogSteerRate }
input.setBindings(partial), input.setTouchVisible(bool), input.dispose()
```
* **Steering sign: `steer > 0` = LEFT** (matches the frozen track/AI convention
  "positive lateral = left of travel"). The scaffold stub had it inverted; fixed.
* Keyboard: WASD/arrows, Space|Shift = drift/hop, E|Ctrl = item, Q = look back,
  Esc = pause (emits `UI_PAUSE`, next Esc emits `UI_RESUME`), R = respawn latch.
* Gamepad (standard mapping): RT/LT analog triggers, A/B fallback, LB|X = drift,
  RB = item, Y = look back, Start/Select = pause, L3 = reset, analog steer with
  deadzone 0.16 + rescale, hot-plug add/remove.
* Touch: own layer appended to `document.body` (`data-turbo-kart="touch-controls"`,
  never `#ui-root`), pointer-capture based, slide-between-halves steering,
  safe-area insets, auto-revealed on the first real `touchstart`.
* Input is silent on the bus except for `UI_PAUSE` / `UI_RESUME`.

### `Kart` — `src/kart/kart.js`
```js
new Kart({ THREE, bus, trackApi, isPlayer, characterId, startIndex, difficulty, quality })
kart.object3D  kart.position  kart.forward  kart.velocity  kart.speed  kart.yaw
kart.state     // KartState + driftReady (bool)
kart.lap  kart.progress  kart.finished (accessor → emits KART_FINISHED once)
kart.isPlayer  kart.characterId  kart.name  kart.character  kart.stats  kart.startIndex
kart.topSpeed  kart.accel  kart.gripRate  kart.mass  kart.input
kart.drifting  kart.onRoad  kart.draft  kart.lateral  kart.visual
kart.update(dt, input)
kart.applyBoost(power, duration, source)
kart.applyImpulse(vec, spinSeconds?)
kart.spinOut(seconds?)      kart.squash(seconds?, amount?)
kart.setFrozen(seconds)     kart.setInvincible(seconds)
kart.setScale(s)            kart.resetTo(position, quaternion?)
kart.respawn()              kart.hit({ source, kind, from, power })   // convenience for items
kart.setQuality(q)          kart.dispose()
Kart.registry               // live array of all karts (auto add/remove)
```

### `createKartMesh({ THREE, characterId, isPlayer, quality, number })` — `src/kart/kartFactory.js`
Returns `{ group, spinGroup, chassis, wheelsGroup, materials, isPlayer, update(dt, state, kart), setQuality(q), dispose() }`.
`update(dt, state, kart)` reads `kart.visual` for transient values
(`wheelAngle, driftTilt, airPitch, hopTilt, squash, spinYaw, boostGlow, brakeLight, bounce`).

---

## 3. Physics model (how the feel is produced)

Longitudinal: engine force `accel·throttle·(1 − 0.75·v/vTarget)`, quadratic drag
`0.0016·v²`, linear drag `0.06·v`, brake 30 m/s², reverse 7 m/s, slope gravity
`−g·forward.y·0.85`, soft over-speed decay after boosts.

Lateral: **momentum is rotated toward the heading** at `grip` 1/s rather than
deleted, so corners and drifts keep their speed and the slip angle is bounded
(`slip ≈ yawRate / grip`). Tyres scrub `0.16·|slip|` per second. This is the
single change that made the kart feel arcade-right instead of "ice on rails".

| situation | grip (1/s) | typical slip |
|---|---|---|
| on road (grip stat 5) | 16.8 | ~4° |
| on road (grip stat 1) | 8.0 | ~8° |
| off road | ×0.62 | ~10° |
| drifting | ×0.22 | ~20° |
| ice | ×0.16 | ~25-35° |
| floor | 1.8 | — |

Drift: press → hop (4.3 m/s up) → hold drift + steer → the drift locks the turn
direction and adds a fixed yaw rate modulated by the stick (1.35 rad/s ×0.4…×1.4).
Charge needs ground contact, ≥7.5 m/s and not counter-steering hard
(`steer·driftDir > −0.2`). Stages at **1.05 / 2.15 / 3.25 s** (speed-scaled up to
+30%) → blue/orange/purple, released as boosts of power **1.0 / 1.32 / 1.72** for
**0.95 / 1.45 / 1.95 s**. `state.driftCharge` is 0..1 *inside the current stage*
(frozen contract) and `state.driftLevel` is 0/1/2 = blue/orange/purple.

Rocket start: throttle edge inside `RACE.ROCKET_START_WINDOW + 0.08 s` before GO
gives power `0.95…1.5` (scaled by timing accuracy) + `KART_ROCKET_START`; pressing
earlier gives 0.9 s of wheelspin (no drive, spinning wheels).

Air: real ballistics (g=22), reduced grip/steer authority, nose-up/nose-down pitch,
landing squash + dust + camera shake, heavy landings scrub ≤22% speed. Ramps launch
with `7.0 + speed·0.34` m/s vertical.

Collisions: circle separation (r = 0.9·scale), mass from `weight` (1.0…1.88),
restitution 0.32, 4% speed scrub, hard hits (>6.5 m/s closing) spin out the kart
that was rammed; stars never lose the exchange. Each pair is resolved once
(`Kart.registry`, lower id wins). Drafting: a kart within 22 m in a 20° cone ahead
gives +3% top speed and +3.5 m/s².

Anti-stuck: 3 s below 3 m/s while off-road / on a wall / wrong-way → respawn;
`state.resetRequested` or a fall out of the world respawns immediately. Respawn
puts the kart back on the centreline at its current `u`, facing forward, at half
speed, with 1.6 s of invincibility.

---

## 4. Tuning constants (all in `src/kart/kartPhysics.js`)

| stat | mapping (1…5) |
|---|---|
| speed | top speed 27.5 → 34.5 m/s (99 → 124 km/h) |
| accel | engine 12.5 → 21.7 m/s² |
| grip | lateral grip 8.0 → 16.8 (1/s) |
| weight | mass 1.00 → 1.88 |

Measured (headless harness): 0–100 km/h **2.7 s** (nova), **3.0 s** (blaze),
top speed 118–126 km/h, boosts reach 150–165 km/h, braking 1 s from top speed,
drift slip ~20° with the speed held at ~115 km/h, purple mini-turbo at ~4.0 s.

Other key numbers: hop 4.3 m/s, drift min speed 7.5, off-road top-speed ×0.55 and
+3.4 rolling resistance, ice grip ×0.16, frozen top speed 4.5 m/s, star +8% speed,
boost pad power 0.8/1.15 s, gravity 22, camera FOV 63→76 (+3.5 boosting),
hood 72, far 60.

---

## 5. Integration notes

* **`main.js` needs no changes.** Every call in the integrator matches the stubs.
* **Events emitted by `Kart`** (payloads match `contracts.js`):
  `KART_BOOST {kart,source,power}`, `KART_DRIFT_START`, `KART_DRIFT_CHARGE {kart,level}`,
  `KART_DRIFT_BOOST {kart,level}`, `KART_HOP`, `KART_LAND {kart,impact}`, `KART_OFFROAD {kart,onRoad}`,
  `KART_HIT {kart,source,kind,from}`, `KART_SPIN`, `KART_SQUASH`, `KART_ROCKET_START {kart,power}`,
  `KART_WRONG_WAY {kart,wrongWay}`, `KART_FINISHED`, `CAMERA_SHAKE {amount,duration}` (player only),
  plus `FX_SPAWN`.
* **`FX_SPAWN` kinds used** (Agent 5 — please map or ignore unknown kinds):
  `dust`, `spark`, `drift-spark`, `drift-charge`, `drift-boost`, `boost-pad`,
  `ramp`, `rocket-start`, `wheelspin`, `respawn`. `opts` carries `{ level, color, scale, landing, power }`.
  Drift stage colours: `[0x3fb6ff, 0xffa63d, 0xc46bff]` (exported as `DRIFT_STAGE_COLORS`).
* **Audio (Agent 4):** the kart emits **no** `AUDIO_SFX` (to avoid double sounds);
  subscribe to `KART_HOP/LAND/HIT/SPIN/BOOST/DRIFT_*/OFFROAD/ROCKET_START/FINISHED`
  and drive the engine sound from `kart.state.speed` / `kart.state.offRoad` /
  `kart.state.boosting`.
* **UI (Agent 4):** `input.isTouch`, `input.lastDevice`, `input.bindings` (display
  key hints), `input.setTouchVisible`, `input.rumble`, `state.driftReady`
  (true when a mini-turbo is banked) and `state.driftCharge` (0..1 in the current
  stage) are there for the HUD.
* **AI / items (Agent 3):** `kart.input.useItem` is the live edge source;
  `kart.hit({source,kind,from,power})`, `spinOut/squash/setFrozen/setInvincible/
  applyImpulse/setScale/resetTo/respawn` are the damage API; setting
  `kart.finished = true` (or `lap`) is detected and emits `KART_FINISHED` once.
* **Tracks (Agent 2):** optional extra fields the kart already understands:
  `gimmicks[i].width` / `halfWidth` (lane width; otherwise ±2.8 m),
  `wallSoftLimit`, `wallHardLimit`, `wallHalfWidth` (otherwise
  `halfWidth + 7` and `halfWidth + 16`). `surfaceNormal(u, lateral)` is used for
  banking/pitch — return a normalised vector. `pointAt(u, lateral)` must be
  continuous beyond the road edges (it is used as the ground height query).
* **PostFX (Agent 5):** `engine.render(postfx)` also stores the instance and calls
  `postfx.resize(w, h, dpr)` from `engine.resize()`.

---

## 6. Known gaps / decisions

1. **No real wall geometry** — guardrails are a soft lateral limit (drag + push
   back) plus a hard clamp at `halfWidth + 16`, with spark FX and speed loss.
   Agent 2 can override with `wallSoftLimit` / `wallHardLimit`.
2. **Spin-outs are visual** (a full 360° mesh rotation + heavy speed loss + no
   control for ~1.15 s); the physics heading is untouched so the kart keeps its
   line and the player can recover immediately. Deliberate — rotating the heading
   felt punishing and triggered false wrong-way warnings.
3. **`antialias` is fixed at construction** (Three cannot toggle MSAA on a live
   context). Changing quality from `low` to `high` at runtime keeps MSAA off;
   everything else (shadows, pixel ratio, anisotropy, rim light) changes live.
4. **Shared geometry is never disposed** — `kartModels.js` caches merged
   geometries per character+quality for the app lifetime (a few hundred KB);
   `dispose()` only frees the per-instance materials/textures.
5. **`kart.forward` is a live per-kart vector** (documented read-only, same as the
   stub) — clone it if you need to keep it.
6. **Touch layout is best-effort** for phones in landscape; the buttons use
   `env(safe-area-inset-*)` and sit above `#ui-root` (z-index 40, pointer-events
   only on the controls).
7. `state.speed` is the planar speed magnitude with the sign of the forward
   component, so the HUD does not dip during a drift (the contract only asks for
   a signed m/s value).
8. Kart-vs-kart collisions are resolved by the lower-id kart, so a pair reacts
   with a half-frame offset when the two karts are updated in the same tick.

## 7. Contract deviations (all additive / documented)

| Item | Note |
|---|---|
| `steer > 0 = LEFT` | Matches `CONVENTIONS.md` + the AI stub; the input stub's mapping was inverted and was fixed here. |
| `state.driftLevel` | Kept at 0/1/2 = blue/orange/purple as frozen. Added `state.driftReady` because "level 0" alone cannot distinguish "no charge" from "blue charged". |
| `state.driftCharge` | 0..1 *within* the current stage (per the contract comment), resets when a new stage is reached. |
| `state.*` additions | `resetRequested`, `pauseRequested`, `device` (input), `driftReady` (kart). |
| `object3D` orientation | Uses `quaternion` so karts bank with the road and pitch in the air; `rotation.y` still tracks yaw (Three keeps them in sync) and `kart.yaw` is authoritative. |
| `Engine` bus | Imports the shared singleton to receive `CAMERA_SHAKE` (no bus argument exists in `main.js`). |
| Shadow frustum | Follows the player (±70…130 m, texel-snapped) instead of a static ±250 m. |

## 8. Verification performed (headless, not shipped)

* 8 karts × 90 s soak at 60 Hz with a mock `TrackApi`: no NaN, y within range,
  **0.06 ms per kart-frame** (including the mock's deliberately slow projection).
* Drift: all three stages reached, boost power/duration scale, speed preserved
  (~115 km/h) through a drift, slip ~20°.
* Gimmicks: boost pad, ramp (1.6 s air time, 7.3 m peak, landing squash + dust),
  ice (slip 4° → 22°), off-road slowdown, wall slide.
* Collisions: momentum exchange, victim spin-out, star immunity, bump events.
* Rocket start: perfect timing boost vs early wheelspin penalty.
* Frozen/invincible/squash/scale/resetTo/respawn, anti-stuck respawn.
* Camera rig: 10 s of chase/far/hood + look-back + shake, no NaN, no ground clip.
* Input: keyboard, analog gamepad (incl. hot-unplug + rumble), touch layer
  (multi-touch steering slide, per-button hold, pause, enable/disable, dispose).
* Meshes: 8 characters build, ~11–13 meshes and ~2.1k triangles per kart, 6/11
  geometries shared between same-character instances, quality swap, tint states.
