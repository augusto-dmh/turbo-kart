/**
 * ============================================================================
 * TURBO KART — headless FX behaviour test (owned by Agent 5)
 * ============================================================================
 * Runs with plain Node (no browser, no WebGL, no extra dependencies beyond the
 * project's own `three`). It exercises the real `Effects` implementation:
 *
 *   - every bus event the FX layer listens to, including malformed payloads,
 *   - per-quality live-particle budgets (low ≈ 400, high ≈ 1200, ultra ≈ 1800),
 *   - `setQuality()` taking effect immediately without leaking,
 *   - `dispose()` making the instance inert,
 *   - `PostFX.render()` never leaving a black screen when the composer fails
 *     (a stub renderer forces the fallback path).
 *
 * Exit code 0 = pass, 1 = fail.
 */
import * as THREE from 'three';
import { EventBus } from '../src/core/events.js';
import { EVENTS, createKartState } from '../src/contracts.js';
import { Effects } from '../src/fx/effects.js';
import { PostFX } from '../src/fx/postprocessing.js';
import { fxState } from '../src/fx/fxState.js';

const failures = [];
const notes = [];

function check(name, condition, detail = '') {
  if (condition) {
    notes.push(`  ok   ${name}`);
  } else {
    failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** @returns {any} a kart-shaped object good enough for the FX layer */
function makeKart(index, isPlayer) {
  const object3D = new THREE.Object3D();
  object3D.position.set(index * 3 - 3, 0, index * 2);
  object3D.rotation.y = 0.2 * index;
  return { index, isPlayer, object3D, state: createKartState(), forward: new THREE.Vector3(0, 0, 1) };
}

function makeTrack() {
  return {
    id: 'test-track',
    theme: 'desert',
    startU: 0.5,
    pointAt: (u, lateral = 0) => new THREE.Vector3(10 * Math.cos(u * 6.28) + lateral, 0, 10 * Math.sin(u * 6.28)),
    project: () => ({ u: 0, lateral: 0, onRoad: true }),
  };
}

function main() {
  // ---------------------------------------------------------------- setup ---
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 3000);
  camera.position.set(0, 5, -9);
  camera.updateMatrixWorld(true);

  const track = makeTrack();
  const karts = [makeKart(0, false), makeKart(1, true), makeKart(2, false)];

  const effects = new Effects({ bus, THREE, scene, camera });
  effects.setTrack(track);
  check('Effects constructs + setTrack()', true);

  const sceneChildrenAfterBuild = scene.children.length;
  check('Effects attaches pooled objects to the scene', sceneChildrenAfterBuild >= 6, `children=${sceneChildrenAfterBuild}`);

  // ------------------------------------------------------- event coverage ---
  const player = karts[1];
  player.state.speed = 38;
  player.state.drifting = true;
  player.state.driftLevel = 2;
  player.state.driftCharge = 0.7;
  karts[0].state.speed = 20;
  karts[0].state.offRoad = true;
  karts[0].state.boosting = true;
  karts[0].state.invincible = true;
  karts[2].state.speed = 10;
  karts[2].state.spinning = true;
  karts[2].state.frozen = true;

  const eventCases = [
    [EVENTS.KART_BOOST, { kart: player, source: 'mushroom', power: 0.9 }],
    [EVENTS.KART_ROCKET_START, { kart: player, power: 1 }],
    [EVENTS.KART_DRIFT_START, { kart: player }],
    [EVENTS.KART_DRIFT_CHARGE, { kart: player, level: 2 }],
    [EVENTS.KART_DRIFT_BOOST, { kart: player, level: 2 }],
    [EVENTS.KART_HOP, { kart: player }],
    [EVENTS.KART_LAND, { kart: player, impact: 14 }],
    [EVENTS.KART_LAND, { kart: player, impact: { force: 3 } }],
    [EVENTS.KART_OFFROAD, { kart: player, onRoad: false }],
    [EVENTS.KART_OFFROAD, { kart: player, onRoad: true }],
    [EVENTS.KART_HIT, { kart: player, source: { kind: 'shell' }, kind: 'shell', from: karts[0].object3D }],
    [EVENTS.KART_HIT, { kart: player, kind: 'banana' }],
    [EVENTS.KART_SPIN, { kart: player }],
    [EVENTS.ITEM_BOX, { kart: player }],
    [EVENTS.ITEM_ROLL, { kart: player, item: 'star' }],
    [EVENTS.ITEM_ROLL, { kart: player, item: { id: 'red-shell', color: 0xe74c3c } }],
    [EVENTS.ITEM_USE, { kart: player, item: 'mushroom' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'green-shell' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'red-shell' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'triple-shell' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'star' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'lightning' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'banana' }],
    [EVENTS.ITEM_USE, { kart: player, item: 'unknown-item' }],
    [EVENTS.ITEM_HIT, { kart: player, item: 'red-shell', from: karts[2].object3D }],
    [EVENTS.ITEM_EXPIRE, { kart: player, item: 'banana' }],
    [EVENTS.RACE_COUNTDOWN, { value: 0 }],
    [EVENTS.RACE_FINISH, { kart: player, place: 1, time: 91.2 }],
    [EVENTS.RACE_FINISH, { kart: karts[0], place: 5, time: 95.0 }],
    [EVENTS.RACE_COMPLETE, { standings: [{ kart: player, place: 1 }, { kart: karts[0], place: 2 }] }],
    [EVENTS.FX_SPAWN, { kind: 'boost', position: { x: 1, y: 0, z: 2 }, opts: { scale: 1.2 } }],
    [EVENTS.FX_SPAWN, { kind: 'explosion', position: player.object3D.position, opts: {} }],
    [EVENTS.FX_SPAWN, { kind: 'lightning', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'confetti', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'firework', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'shell-trail', position: player.object3D.position, opts: { color: 0x2ecc71 } }],
    [EVENTS.FX_SPAWN, { kind: 'ring', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'landing', position: player.object3D.position, opts: { impact: 12 } }],
    [EVENTS.FX_SPAWN, { kind: 'dust', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'smoke', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'spin', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'hit', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'star', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'itembox', position: player.object3D.position }],
    [EVENTS.FX_SPAWN, { kind: 'nonsense-kind', position: player.object3D.position }],
    // malformed payloads must not throw
    [EVENTS.KART_BOOST, undefined],
    [EVENTS.KART_LAND, {}],
    [EVENTS.KART_HIT, { kart: null, source: null }],
    [EVENTS.ITEM_USE, {}],
    [EVENTS.ITEM_HIT, { kart: { state: {} } }],
    [EVENTS.RACE_FINISH, {}],
    [EVENTS.RACE_COMPLETE, {}],
    [EVENTS.FX_SPAWN, {}],
    [EVENTS.FX_SPAWN, undefined],
  ];

  let emitted = 0;
  for (const [event, payload] of eventCases) {
    try {
      bus.emit(event, payload);
      emitted++;
    } catch (err) {
      failures.push(`  FAIL bus.emit(${event}) threw: ${err?.message || err}`);
    }
  }
  check(`all ${eventCases.length} event payloads handled (${emitted} emitted)`, emitted === eventCases.length);

  // ----------------------------------------------------------- frame loop ---
  let maxUltra = 0;
  let loopError = null;
  try {
    for (let frame = 0; frame < 400; frame++) {
      effects.update(1 / 60, karts, track);
      maxUltra = Math.max(maxUltra, effects.getStats().particles);
    }
  } catch (err) {
    loopError = err;
  }
  check('400 update() frames at ultra without throwing', !loopError, loopError?.message);
  check('ultra particle budget respected (<= 1800)', maxUltra <= 1800, `peak=${maxUltra}`);
  check('ultra actually produces particles', maxUltra > 50, `peak=${maxUltra}`);
  check('fxState is written for PostFX', fxState.particles >= 0 && typeof fxState.speedNorm === 'number');

  // ------------------------------------------------------- quality change ---
  effects.setQuality('low');
  for (let frame = 0; frame < 60; frame++) effects.update(1 / 60, karts, track);
  const lowLive = effects.getStats().particles;
  check('low quality drops the live budget (<= 400)', lowLive <= 400, `live=${lowLive}`);

  effects.setQuality('medium');
  for (let frame = 0; frame < 60; frame++) effects.update(1 / 60, karts, track);
  const medLive = effects.getStats().particles;
  check('medium quality stays under 700', medLive <= 700, `live=${medLive}`);

  effects.setQuality('ultra');
  for (let frame = 0; frame < 60; frame++) effects.update(1 / 60, karts, track);
  const ultraLive = effects.getStats().particles;
  check('ultra quality stays under 1800', ultraLive <= 1800, `live=${ultraLive}`);

  // lights must not leak when leaving ultra
  effects.setQuality('low');
  const visibleLights = effects._lights.filter((l) => l.light.visible && l.light.intensity > 0).length;
  check('point lights released on low quality', visibleLights === 0, `visible=${visibleLights}`);
  effects.setQuality('ultra');

  // --------------------------------------------------------------- dispose --
  let disposeError = null;
  try {
    effects.dispose();
    effects.update(1 / 60, karts, track);
    effects.spawn('explosion', { x: 0, y: 0, z: 0 });
    effects.setQuality('high');
  } catch (err) {
    disposeError = err;
  }
  check('dispose() leaves an inert, non-throwing instance', !disposeError, disposeError?.message);

  // ----------------------------------------------------------------- PostFX --
  check('PostFX is exported as a class', typeof PostFX === 'function');
  let directRenderCalls = 0;
  const stubRenderer = {
    getPixelRatio: () => 1,
    getSize: (v) => { v.set(1280, 720); return v; },
    getDrawingBufferSize: (v) => { v.set(1280, 720); return v; },
    render: () => { directRenderCalls++; },
    setRenderTarget: () => {},
    clear: () => {},
  };
  let postfx = null;
  let postfxError = null;
  try {
    postfx = new PostFX({ THREE, renderer: stubRenderer, scene, camera, quality: 'high' });
    postfx.render();
    postfx.setSpeed(42);
    postfx.render(1 / 60);
    postfx.resize();
  } catch (err) {
    postfxError = err;
  }
  check('PostFX survives a stub renderer without throwing', !postfxError, postfxError?.message);
  check(
    'PostFX never leaves a black screen (direct render fallback used)',
    directRenderCalls >= 1 || postfx?.enabled === true,
    `directRenderCalls=${directRenderCalls} enabled=${postfx?.enabled}`,
  );
  if (postfx) {
    try {
      postfx.setQuality('low');
      check('PostFX low quality disables the composer', postfx.enabled === false);
      postfx.render();
      postfx.dispose();
    } catch (err) {
      failures.push(`  FAIL PostFX quality/dispose threw: ${err?.message || err}`);
    }
  }

  // ---------------------------------------------------------------- report --
  const ok = failures.length === 0;
  console.log('Turbo Kart — headless FX test');
  console.log(notes.join('\n'));
  if (failures.length) console.log(failures.join('\n'));
  console.log(ok ? 'RESULT: PASS' : `RESULT: FAIL (${failures.length})`);
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error('headless FX test crashed:', err);
  process.exit(1);
}
