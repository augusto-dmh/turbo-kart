# Agent 2 — Tracks & Environment (`src/track/**`)

Status: **complete**. Three hand-authored tracks, a full `TrackApi`, and a
theme-driven environment (sky, terrain, water, weather, props, landmarks).
Every file passes `node --check`; the whole subsystem was validated head-less
against the real three r186 build with four throwaway harnesses
(track contract, environment, integration sim, texture paths).

## 1. Files

| file | lines | what it owns |
|---|---|---|
| `src/track/trackData.js` | ~270 | `TRACK_DEFS`, `getTrack(id)`, `getTrackTheme`, `listTracks` — control points, gimmicks, item rows, AI hints, theme recipes |
| `src/track/trackBuilder.js` | ~1230 | `TrackBuilder` → geometry (road/kerb/verge/rails/gate/grid/pads/ice/ramps/tunnel/bridge) + the `TrackApi` |
| `src/track/projection.js` | ~530 | `Centerline`: closed centripetal Catmull-Rom, arc-length sample table (2048), bank/elevation, spatial-hash `project()` |
| `src/track/terrainField.js` | ~185 | analytic height field shared by the builder and the environment (corridor clamp + gorge spans) |
| `src/track/themes.js` | ~165 | `THEMES` (`sunset`/`desert`/`snow`), `getTheme(id)`: sky, fog, lights, palettes, prop recipe, weather, minimap colours |
| `src/track/textures.js` | ~520 | `CanvasTexture` factory (asphalt, kerb, sand, snow, ice, rock, banner, sponsor, chevron, grid, glow, cloud, particle, flag, water normal) + cache + `disposeTextures` |
| `src/track/environment.js` | ~215 | `createEnvironment({THREE, trackApi, scene, quality})`: fog/background/lights, terrain mesh, atmosphere + props |
| `src/track/atmosphere.js` | ~336 | sky dome (vertex-coloured gradient), sun/moon sprites, stars, aurora, clouds, water, weather particles |
| `src/track/props.js` | ~920 | mountains, trees/palms/pines/cacti, rocks, bushes, crystals, grandstands + crowd, flags, lamps/floodlights, landmarks (lighthouse, rock arch, mesas, ice cave), seagulls, balloons, buoys, sailboat |
| `src/track/themes.js` also exports nothing else — all existing stub exports were preserved. | | |

All original exports/signatures kept: `TRACK_DEFS`, `getTrack`, `TrackBuilder`
(`{THREE, trackDef, meta}` + `.build()`/`.dispose()`), `createEnvironment`
(`{THREE, trackApi, scene, quality}` → `{group, update(dt,camera), setQuality(q), dispose()}`).

## 2. `TrackApi` guarantees (exact)

Contract fields — all present and verified per track:

- `id`, `name`, `theme`, `laps` — identical to `TRACKS` in `contracts.js`.
- `group` — root `Group`, matrix-frozen, added to the scene by `main.js`.
- `length` (1040.4 / 1060.3 / 1040.2 m), `halfWidth` (8 / 7.5 / 7), `width`, `bounds` (road AABB incl. rails), `boundsY`.
- `pointAt(u, lateral=0, out?)` → `Vector3` (includes elevation **and** banking; pass `out` to avoid allocation). `lateral > 0` = **left of travel**.
- `tangentAt(u, out?)` → unit `Vector3` incl. vertical component; `surfaceNormal(u, lateral=0, out?)` → banked up vector.
- `project(pos)` → pooled object `{u, lateral, onRoad, tangent, up, y, bank, heading, curvature, distance, index}`.
  - accuracy vs brute-force nearest over the sample table: worst |Δu| ≤ **0.00024**, worst |Δlateral| ≤ **0.11 m**, worst index error ≤ 0.48 m (3000 probes/track).
  - far off-track (up to ±200 m + 60 m vertical, 300 probes): u matched brute force **299-300/300**, distance error < 0.6 m.
  - O(1)-ish: spatial hash (12 m cells, 3×3) → decimated fallback when > ~18 m away → ±40-sample refine → exact segment projection. **≈1.0 µs/call** (200 k calls measured, node).
  - allocation-free: results come from a 32-deep pool — **use `projectCopy(pos)` if you must retain one** (documented extra).
  - `onRoad` = `|lateral| ≤ halfWidth + kerbWidth` (kerb counts as road).
- `startGrid` — 8 slots (`RACE.KART_COUNT`), 2 columns @ ±3.5 m (±2.4-3.5 clamped by width), rows 7.5 + 4.6 m behind the line, slot 0 = pole, slot 7 = player (≈21 m behind the line, clear of rails). Each `{position: Vector3, heading, u, lateral, index}`; `heading = atan2(tangent.x, tangent.z)`; verified on-road and heading-aligned.
- `startU = 0`; `checkpointUs` = 12 ascending entries, last exactly `1.0` (= start/finish line, `u=0`).
- `itemBoxRows` — 3 rows each (lap thirds), all inside the road: sunset `0.252/0.585/0.925`, desert `0.055/0.39/0.575`, snow `0.075/0.63/0.90`.
- `gimmicks` — `{u, lateral, kind, …}` with resolved extras: ramps get `uStart, uEnd, lipY, angle, lipSlope`; boosts `power, width, length`; ice `radius, along, grip`.
- `minimap.outline` (120 XZ points), `minimap.sample(u)`, plus `minimap.bounds/width/theme`.
- `isOffRoad(pos)`, `dispose()` (idempotent; frees geometries, materials and generated textures; removes the group).

Documented extras (additive, nothing removed): `surfaceAt(pos)` →
`{surface:'road'|'ice'|'boost'|'grass'|'sand'|'snow', grip, onRoad, u, lateral, y}`,
`gimmickAt(u, lateral)`, `wallOffset` (rail face distance from centerline),
`railSpans` `[{u0,u1,side,lateral,i0,i1}]` (collision metadata), `structures`
(tunnel/bridge records), `terrainHeight(x,z)`, `terrainField`,
`aiRacingLine` (apex hints, same data as the def), `trackDef`, `themeRecord`,
`meta`, `curve`, `sampleCount`, `curvatureAt(u)`, `speedFactorAt(u)`, `width`,
`boundsY`, `projectCopy`, `update(dt, camera)`.

### Ramp physics hand-off (important for the kart agent)
Ramp elevation is baked into the sample table, so `project(pos).y` is the ramp
surface and a kart that follows the road surface drives up and launches off the
lip with no special case. Profile `y(t) = H·t^1.6`, `t = (u-uStart)/(uEnd-uStart)`;
`angle = atan(1.6·H/L)` (13.9° / 15.6° / 18.2° for the three ramp sizes used);
the lip is snapped to a sample boundary so `y` drops cleanly back to base on the
next sample (verified: lip rise ≈ H, clean drop, `lipY` matches `pointAt`).
The kart agent's `gimmicks[i]` entry keeps `u = uStart` (so its impulse window
starts at the ramp foot) while `uEnd`/`lipY` are also exposed; either way the
real launch comes from the surface profile, so its hop and our geometry agree.

### Wall/lateral contract
Guard-rail faces sit at `±wallOffset` (`halfWidth + kerbWidth + 0.55`), the same
lateral as the bridge railings; tunnels are slightly wider. Karts that respect
`wallOffset` never clip visible geometry.

## 3. Layout notes

Authoring method: each loop was designed as an element sequence
(straight/arc, e.g. `S(130) R(80°,85 m) …`), solved for exact closure (3-arc
Newton + uniform rescale), then resampled into **uniform ~14 m control points**
so the closed centripetal Catmull-Rom stays smooth everywhere. Metrics below are
measured on the real curve.

| | sunset-speedway | desert-dunes | frozen-peaks |
|---|---|---|---|
| theme / width | sunset / 16 m | desert / 15 m | snow / 14 m |
| length | 1040 m | 1060 m | 1040 m |
| control points | 74 | 76 | 74 |
| corners (min radius) | 20 corners, 34-76 m | 20 corners incl. **2 hairpins 13-14 m**, 30-52 m sweepers | 15 corners incl. **3 hairpins 15-20 m**, 43-65 m sweepers |
| elevation | 0.2-15 m, ≤5.8 % grade | 0.2-15.7 m, ≤6.9 % | 3.6-25.7 m (climb + descent), ≤7.3 % |
| self clearance | 26 m | 25 m | 25 m |
| off-road | grass | sand | snow |
| gimmicks | 1 ramp (u 0.755, 15 m / 2.3 m), 2 boosts (0.243 L, 0.952 R) | 3 ramps (0.072, 0.468, 0.928; 15-16 m / 2.6-2.9 m), 2 boosts (0.33, 0.80) | 1 ramp (0.835, 14 m / 2.4 m), 2 boosts (0.625, 0.955), **4 ice patches** (0.145, 0.30, 0.425, 0.715; grip 0.22) |
| structures | — | — | **tunnel** u 0.468-0.592 (rock shell, ceiling lights, rails suppressed), **bridge** u 0.695-0.775 over a 26 m gorge (trusses + piers) |
| identity | coastal plateau, sea on all sides, palms, lighthouse, floodlight pylons, seagulls, buoys + sailboat | red-rock canyon with terraced mesas, cactus, rock arch over the road (u 0.163), dust motes, balloons | alpine ladder climb, pines, ice crystals, ice cave, snow particles, stars + aurora |

`aiRacingLine` (~20-25 `{u, lateral}` apex hints, lateral = sign of the turn,
0.62·halfWidth) is **optional** for the AI agent. Validation: a pure-pursuit
driver using only these hints stayed **95-100 % on-road** for a full lap
simulation at up to 30 m/s and covered every track section.

## 4. Performance

- Build cost per race start: track 25-90 ms + environment 60-85 ms (head-less).
- Triangles: track 34 k (sunset) / 34 k (desert) / 41 k (snow); environment
  +60-70 k visible → **≈95-104 k total** (budget < 250 k).
- Draw calls: **16-21 (track) + 24-36 (environment)** ≈ 40-57 meshes total;
  rail posts and all scenery use `InstancedMesh` (7-10 per track); static
  geometry is merged per material.
- `project()` ≈1 µs; `update(dt, camera)` is allocation-free (shared scratch
  vectors; only cloud matrices ≤26, ~1/10 of the crowd, flag cloth (60×10 verts),
  weather points, and ≤12 ambient-prop matrices are touched per frame).
  Ambient animators are distance-gated (crowd skips beyond 850 m).
- Quality: `quality` selects terrain resolution (72/128/160 cells) and instance
  counts (low = 45 %, medium = 72 %); snow/dust particles are skipped on `low`;
  unknown quality strings fall back to `high`. `setQuality` only adjusts counts
  and visibility — nothing is rebuilt.
- Shadows: road/kerbs/verge/terrain receive; rails, gate, landmarks and props
  cast only where it pays (instanced foliage and crowd do not cast).

## 5. Known gaps / risks

1. **`engine.setAtmosphere` is unreachable** — `createEnvironment` receives only
   `{THREE, trackApi, scene, quality}`, so no engine handle exists. The
   environment applies the atmosphere through `scene.fog`, `scene.background`
   and the existing hemisphere/directional light colours+intensities, and
   exposes `sunDirection` so other systems can align effects with the sun.
   Wire `engine.setAtmosphere` from `main.js` if Agent 1 adds it.
2. **`main.js` never calls `environment.setQuality`** (it updates engine, postfx,
   effects and hud only). Live quality switching needs
   `r.environment?.setQuality?.(q)` in `applySettings`.
3. **No custom GLSL by design.** The sky is a vertex-coloured gradient dome with
   sprite sun/stars, and water is a standard material with a procedurally
   generated scrolling normal map. This keeps colour management, fog and the
   FX agent's post-processing identical to every other material, at the cost of
   a slightly simpler sky than a bespoke shader.
4. The ocean plane is camera-centred (infinite ocean); systems that sample its
   position see it move.
5. Ice patches / boost pads / grid paint are flat decals 0.02-0.035 m above the
   road with `polygonOffset`; they never change the collision surface, but a
   grazing camera angle can show a hairline edge.
6. `banking` is derived from signed curvature (`bankGain`/`maxBankDeg` per track,
   box-blurred, forced to 0 over ramps) instead of an authored per-control-point
   array — a deliberate simplification documented here.
7. Layout authoring is numeric, not artistic: the numbers (radii, grades,
   clearance) were verified, but the final "feel" needs a human playtest pass.
8. Observation for the integrator (not my files): the frozen `aiDriver` stub's
   `steer = -angle * 1.6` combined with the frozen `Kart` stub's
   `yaw -= steer` steers *away* from the target. The real implementations that
   now exist in the tree drive correctly (verified above), so this only matters
   if anyone falls back to the stubs.
9. `kart.js` reads ramps/boosts/ice from `trackApi.gimmicks` and identifies ice
   by `kind === 'ice'` — my records use exactly those kinds and expose
   `u`, `lateral` (number), `width`, `uStart`, `uEnd`, `lipY`, so no adapter is
   needed (verified end-to-end).

## 6. Verification harnesses (throwaway, /tmp/opencode)

- `check-track.mjs` — contract surface, projection accuracy (near + 200 m
  fly-offs), tangent/bank consistency, grid, ramp/ice/boost placement, terrain
  never above road, tri counts. **ALL PASSED** (3 tracks).
- `check-env.mjs` — env API, NaN scan, tri budget, instanced props inside the
  road corridor (0), quality switching. **ALL PASSED**.
- `check-sim.mjs` — 8 karts driving 120 s with the authored racing line:
  241/240 sections covered, 95-100 % on-road, item rows and gimmicks detected,
  `project()` benchmark. **ALL PASSED**.
- `check-textures.mjs` — all 15 procedural textures built through a canvas
  stub, sRGB/anisotropy flags, cache + dispose. **ALL PASSED**.
- `check-real-karts.mjs` — **the real `Kart` + `AIDriver` implementations**
  (from `src/kart`, `src/ai`) driving my tracks head-less for 150 s each:
  0 exceptions, 3-5 completed laps per AI kart per track, top speeds 33-50 m/s,
  terrain/props/track/items all built and disposed without leaks. **PASSED.**
- `node --check` on all 9 files: clean.

## 7. Deliberately not done

- **No fourth track.** The brief allows one only if all three are finished and
  polished; the three above are verified head-less but have never been seen in a
  browser by this agent, so adding a fourth would lower the average quality.
  `trackData.js` is structured so a fourth def (points + gimmicks + prop recipe)
  is a data-only addition.
- **No gameplay particles** (drift sparks, item trails) — that is the FX agent's
  area; the environment only owns weather (snow / dust motes) and ambient
  motion (flags, crowd, birds, balloons, buoys, water, clouds).

