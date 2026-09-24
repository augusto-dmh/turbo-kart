# Agent 5 — FX, post-processing & QA

**Status:** complete. All owned files implemented; `npm run smoke` covers the structural
checks, a headless FX behaviour test and a headless full-race integration test.

## Files

| file | what |
|---|---|
| `src/fx/effects.js` | `Effects` — bus-driven gameplay FX orchestrator (pooled, allocation-free hot loop) |
| `src/fx/postprocessing.js` | `PostFX` — `EffectComposer` chain with per-quality presets and a hard fallback |
| `src/fx/particles.js` | `ParticleSystem` (points), `DebrisSystem` (instanced boxes), `MeshPool` (one-shot meshes) |
| `src/fx/shaders.js` | particle/grade/speed-blur GLSL, GLSL capability probe, procedural `CanvasTexture` sprites |
| `src/fx/fxState.js` | tiny shared state written by `Effects`, read by `PostFX` (no new bus events) |
| `tests/smoke.mjs` | 11 checks, `npm run smoke`, exit 0/1, PASS/FAIL table |
| `tests/fx-headless.mjs` | FX/PostFX behaviour test in plain Node |
| `tests/integration-headless.mjs` | real track + 8 karts + AI + race + items + FX race simulation |
| `tests/README.md` | how to run them and what each check means |
| `QA_REPORT.md` | QA findings + manual browser checklist |

## `Effects` — API

```js
const effects = new Effects({ bus, THREE, scene, camera });
effects.setTrack(trackApi | null);
effects.setQuality('low' | 'medium' | 'high' | 'ultra');
effects.update(dt, karts, trackApi);          // main.js call shape
effects.spawn(kind, position, opts);          // also the FX_SPAWN handler
effects.dispose();
effects.getSpeedLines();                      // 0..1 overlay hook (currently unused)
effects.getStats();                           // { particles, meshes, quality }
```

**Bus events consumed:** `KART_BOOST`, `KART_ROCKET_START`, `KART_DRIFT_START`,
`KART_DRIFT_CHARGE`, `KART_DRIFT_BOOST`, `KART_HOP`, `KART_LAND`, `KART_OFFROAD`,
`KART_HIT`, `KART_SPIN`, `ITEM_BOX`, `ITEM_ROLL`, `ITEM_USE`, `ITEM_HIT`, `ITEM_EXPIRE`,
`RACE_START`, `RACE_COUNTDOWN`, `RACE_FINISH`, `RACE_COMPLETE`, `FX_SPAWN`.
Every handler reads its payload defensively (missing fields, `undefined`, `{kart:null}`,
string vs object items are all covered by `tests/fx-headless.mjs`).

**`spawn()` kinds:** `boost`, `flame`, `explosion`, `shell`, `lightning`, `hit`, `dust`,
`smoke`, `landing`/`land`, `spin`, `itembox`/`box`/`item`, `star`, `star-aura`, `confetti`,
`firework`, `ring`, `shell-trail`, `drift-spark`, `drift-charge`, `drift-boost`,
`rocket-start`, `boost-pad`, `wheelspin`, `ramp`, `respawn`, `spark`, and a generic
sparkle fallback for anything unknown. The `drift-*` / `rocket-start` / `dust` /
`boost-pad` kinds are intentionally drawn *smaller* than their bus-event counterparts
because `Kart` emits both for the same moment — otherwise the particle count doubles.

**Effect inventory:** drift sparks colour/intensity per `state.driftLevel`
(blue/orange/purple) with a point light at `ultra`; themed off-road dust per wheel;
boost flame cone + streaks + radial burst; landing dust ring + debris on hard impacts;
hit/spin star bursts, tyre smoke and debris; shell explosions (fireball mesh + smoke +
debris + light + flash); shell trails; star aura (rainbow sparkles); lightning
(full-screen flash via `fxState.flash` + world bolt + spark rain); item-box sparkles +
floating `?` ghost; finish confetti cannons; results fireworks.

**Quality presets** only change *live caps* and light usage — nothing is reallocated, so
`setQuality` is immediate and leak-free (verified in the headless test):

| preset | live particle budget | extras |
|---|---|---|
| low | 400 | no lights, no trails, no rings/fireballs |
| medium | 700 | + rings, debris |
| high | 1200 | + trails, flame cones |
| ultra | 1800 | + 4 pooled `PointLight`s, bigger bursts |

Systems are fixed-capacity ring buffers that recycle the **oldest** particle, so a
sustained 8-kart pile-up cannot grow the heap. Per-frame emission uses one reused spec
object (no garbage).

## `PostFX` — API

```js
const postfx = new PostFX({ THREE, renderer, scene, camera, quality });
postfx.enabled;              // false on 'low' or after a permanent fallback
postfx.render();             // main.js calls it with NO arguments — works
postfx.setQuality(q);        // rebuilds the chain + render targets
postfx.setSpeed(42);         // explicit m/s for the ultra radial blur
postfx.resize();             // also wired to window.resize internally
postfx.dispose();
```

| quality | chain |
|---|---|
| low | no composer, direct render |
| medium | RenderPass → subtle UnrealBloom → OutputPass |
| high | + grade pass (vignette, chromatic aberration, film grain, saturation) → FXAA, 2× MSAA |
| ultra | + radial speed blur & flash pass → SMAA (linear, before OutputPass), 4× MSAA |

* **Colour/tone mapping:** the scene renders into a linear `HalfFloatType` target and
  `OutputPass` applies the renderer's tone mapping + output colour space, so the composer
  matches a direct render (the engine sets ACES + sRGB).
* **Speed input:** `fxState` (written by `Effects`) is the primary source, `setSpeed()` and
  the `KART_BOOST` / `KART_DRIFT_BOOST` / `KART_ROCKET_START` bus subscriptions are
  fallbacks — the blur works even if `Effects` is absent.
* **Robustness:** every optional pass is added in its own `try/catch`; if the composer
  cannot be built or throws while rendering, PostFX permanently falls back to
  `renderer.render(scene, camera)` and warns exactly once (never a black screen).
  Changing the quality preset resets the fallback so a user can retry.
* Lightning drives `fxState.flash` → both the grade and speed passes add a white flash.

## Integration notes for the orchestrator

1. `main.js` already wires everything; **no changes needed** for FX/PostFX.
2. Optional one-liner for perf: pass `quality: this.quality` to `new Kart({...})` so kart
   model detail follows the preset (see `QA_REPORT.md` M2).
3. `Effects.spawn('shell-trail', pos, { color })` is implemented and the item system
   already uses it; any future projectile can request trails the same way.
4. `effects.getSpeedLines()` and `postfx.setSpeed()` are available but unused — wire them
   only if the HUD's own speed-line overlay is dropped.

## Measurements (headless)

- Full race sim: 8 karts + AI + items + FX, 240 s / 14400 frames in ~1.1 s of CPU,
  peak 855 live particles, no exceptions, race completes with 8 standings rows.
- FX budget test: ultra peak ≤ 1800, low ≤ 400, medium ≤ 700, lights released on downgrade.
- `node --check` clean on all five FX modules.

## Known limitations / risks

- The soft-particle shader is probed with a throwaway GLSL compile; if the probe fails
  (or there is no DOM), particle systems fall back to `PointsMaterial` (fixed sprite size,
  no per-particle size). Visual quality only, never a crash.
- `ultra`'s radial blur is a 6-tap loop in one pass; if a low-end GPU struggles, drop the
  preset rather than editing the shader.
- Rain-of-sparks for lightning scales its spread with `opts.radius` (clamped to 60 m) so a
  track-wide lightning cannot dump the whole particle budget at once.
