/**
 * ============================================================================
 * TURBO KART — headless integration test (owned by Agent 5, the QA agent)
 * ============================================================================
 * Boots the *real* gameplay stack in plain Node (no browser, no WebGL) exactly
 * the way `src/main.js` wires it, and races for a while:
 *
 *   TrackBuilder → startGrid → 8 × Kart → AIDriver × 7 → RaceManager →
 *   ItemSystem → Effects
 *
 * Assertions:
 *   - the track API exposes every field the contract promises,
 *   - karts start on the grid (not stacked at the origin) and actually drive,
 *   - lap events fire and the race reaches the results state,
 *   - no module throws during ~60 s of simulated racing,
 *   - the FX layer respects its particle budget while the race runs.
 *
 * If `TrackBuilder.build()` throws, the failure is reported and the race is
 * still simulated on a synthetic oval track, so one broken module does not hide
 * problems in the rest of the stack.
 *
 * Exit code 0 = pass, 1 = fail.
 */
import * as THREE from 'three';
import { EventBus } from '../src/core/events.js';
import { EVENTS, RACE, createInputState } from '../src/contracts.js';

const failures = [];
const notes = [];

function check(name, condition, detail = '') {
  if (condition) notes.push(`  ok   ${name}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Minimal contract-complete oval, used only when the real builder fails. */
function syntheticTrack(THREE_) {
  const length = 600;
  const halfWidth = 9;
  const pointAt = (u, lateral = 0) => {
    const a = u * Math.PI * 2;
    const r = 70 + lateral;
    return new THREE_.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  };
  const tangentAt = (u) => {
    const a = u * Math.PI * 2;
    return new THREE_.Vector3(-Math.sin(a), 0, Math.cos(a)).normalize();
  };
  const up = new THREE_.Vector3(0, 1, 0);
  return {
    id: 'synthetic-oval', name: 'Synthetic Oval', theme: 'sunset', laps: 3,
    group: new THREE_.Group(), length, halfWidth,
    pointAt,
    tangentAt,
    project: (pos) => {
      const u = ((Math.atan2(pos.z, pos.x) / (Math.PI * 2)) + 1) % 1;
      const p = pointAt(u);
      const d = Math.hypot(pos.x - p.x, pos.z - p.z);
      return { u, lateral: d, onRoad: d <= halfWidth, tangent: tangentAt(u), up };
    },
    startGrid: Array.from({ length: RACE.KART_COUNT }, (_, i) => ({
      position: pointAt(0.99 - i * 0.004, i % 2 === 0 ? -2.5 : 2.5),
      heading: Math.PI * 0.5,
    })),
    startU: 0.99,
    checkpointUs: [0.25, 0.5, 0.75, 0.99],
    itemBoxRows: [{ u: 0.2, lateral: [-4, 0, 4] }, { u: 0.6, lateral: [-4, 0, 4] }],
    gimmicks: [{ u: 0.4, lateral: 0, kind: 'boost' }],
    surfaceNormal: () => up.clone(),
    minimap: { outline: [], sample: () => ({ x: 0, z: 0 }) },
    bounds: { minX: -90, maxX: 90, minZ: -90, maxZ: 90 },
    isOffRoad: (pos) => {
      const u = ((Math.atan2(pos.z, pos.x) / (Math.PI * 2)) + 1) % 1;
      const p = pointAt(u);
      return Math.hypot(pos.x - p.x, pos.z - p.z) > halfWidth;
    },
    dispose() {},
  };
}

async function main() {
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 5000);
  camera.position.set(0, 5, -10);

  const [{ TrackBuilder }, { getTrack }, { getTrackMeta }, { Kart }, { AIDriver }, { RaceManager }, { ItemSystem }, { Effects }] = await Promise.all([
    import('../src/track/trackBuilder.js'),
    import('../src/track/trackData.js'),
    import('../src/contracts.js'),
    import('../src/kart/kart.js'),
    import('../src/ai/aiDriver.js'),
    import('../src/race/raceManager.js'),
    import('../src/items/itemSystem.js'),
    import('../src/fx/effects.js'),
  ]);

  // ------------------------------------------------------------- the track --
  let trackApi = null;
  let builder = null;
  try {
    const meta = getTrackMeta('sunset-speedway');
    builder = new TrackBuilder({ THREE, trackDef: getTrack(meta.id), meta });
    trackApi = builder.build();
    check('TrackBuilder.build() succeeds', !!trackApi);
  } catch (err) {
    const where = (err?.stack || '').split('\n').find((l) => l.includes('/src/')) || '';
    check('TrackBuilder.build() succeeds', false, `${err?.message || err} ${where.trim()}`);
    notes.push('  info falling back to a synthetic oval so the rest of the stack is still tested');
    trackApi = syntheticTrack(THREE);
  }

  const required = [
    'id', 'name', 'theme', 'laps', 'group', 'length', 'halfWidth', 'pointAt',
    'tangentAt', 'project', 'startGrid', 'startU', 'checkpointUs', 'itemBoxRows',
    'gimmicks', 'surfaceNormal', 'minimap', 'bounds', 'isOffRoad', 'dispose',
  ];
  const missing = required.filter((k) => trackApi?.[k] === undefined || trackApi[k] === null);
  check('TrackApi exposes every contract field', missing.length === 0, `missing: ${missing.join(', ')}`);
  check('startGrid has 8 slots', Array.isArray(trackApi.startGrid) && trackApi.startGrid.length >= RACE.KART_COUNT,
    `got ${trackApi.startGrid?.length}`);
  const gridOk = (trackApi.startGrid || []).every((s) => s?.position && typeof s.heading === 'number');
  check('startGrid slots are { position, heading }', gridOk);

  const projectSample = trackApi.project(trackApi.pointAt(0.25, 0));
  check('project() returns { u, lateral, onRoad, tangent, up }',
    !!projectSample && Number.isFinite(projectSample.u) && Number.isFinite(projectSample.lateral)
    && typeof projectSample.onRoad === 'boolean' && !!projectSample.tangent && !!projectSample.up);

  // ---------------------------------------------------------------- karts ---
  const karts = [];
  const aiDrivers = [];
  const characterIds = ['nova', 'bolt', 'viper', 'rosie', 'tank', 'frost', 'zumi', 'blaze'];
  let kartError = null;
  try {
    for (let i = 0; i < RACE.KART_COUNT; i++) {
      const isPlayer = i === RACE.KART_COUNT - 1;
      const kart = new Kart({
        THREE, bus, trackApi, isPlayer, characterId: characterIds[i], startIndex: i, difficulty: 'normal',
      });
      scene.add(kart.object3D);
      karts.push(kart);
      if (!isPlayer) aiDrivers.push(new AIDriver({ THREE, bus, kart, trackApi, difficulty: 'normal', index: i }));
    }
  } catch (err) {
    kartError = err;
  }
  check('8 karts + 7 AI drivers constructed', !kartError && karts.length === 8, kartError?.message || '');
  if (karts.length) {
    const spread = Math.max(...karts.map((k) => k.position.distanceTo(karts[0].position)));
    check('karts are spread over the grid (not stacked)', spread > 3, `spread=${spread.toFixed(2)}m`);
    check('karts have a state object', karts.every((k) => k.state && typeof k.state.speed === 'number'));
  }

  const raceManager = new RaceManager({ bus, THREE, karts, trackApi, laps: RACE.LAPS, playerKart: karts[7], solo: false });
  const itemSystem = new ItemSystem({ bus, THREE, scene, karts, trackApi, playerKart: karts[7], difficulty: 'normal' });
  const effects = new Effects({ bus, THREE, scene, camera });
  effects.setTrack(trackApi);

  const seen = { lap: 0, finalLap: 0, boost: 0, drift: 0, hit: 0, itemUse: 0, itemBox: 0, finish: 0, complete: 0, spawn: 0 };
  bus.on(EVENTS.RACE_LAP, () => seen.lap++);
  bus.on(EVENTS.RACE_FINAL_LAP, () => seen.finalLap++);
  bus.on(EVENTS.KART_BOOST, () => seen.boost++);
  bus.on(EVENTS.KART_DRIFT_START, () => seen.drift++);
  bus.on(EVENTS.KART_HIT, () => seen.hit++);
  bus.on(EVENTS.ITEM_USE, () => seen.itemUse++);
  bus.on(EVENTS.ITEM_BOX, () => seen.itemBox++);
  bus.on(EVENTS.RACE_FINISH, () => seen.finish++);
  bus.on(EVENTS.RACE_COMPLETE, () => seen.complete++);
  bus.on(EVENTS.FX_SPAWN, () => seen.spawn++);

  const playerInput = createInputState();
  playerInput.throttle = 1;
  // The headless harness steers the player kart with a tiny pure-pursuit
  // controller. `main.js` feeds the real player input; without *some* steering
  // the player kart drives straight off the road and the player-only
  // RACE_FINISH / results flow can never be exercised.
  const { angleToLeft, wrap01 } = await import('../src/race/progress.js');
  const drivePlayer = (kart) => {
    const pos = kart.position;
    const fwd = kart.forward;
    const p = trackApi.project(pos);
    const speed = Math.abs(kart.state.speed);
    const look = (10 + speed * 0.5) / trackApi.length;
    const tp = trackApi.pointAt(wrap01(p.u + look), 0);
    const errLeft = angleToLeft(fwd.x, fwd.z, tp.x - pos.x, tp.z - pos.z);
    playerInput.steer = Math.max(-1, Math.min(1, errLeft * 2.2 - p.lateral * 0.06));
    playerInput.throttle = 1;
    playerInput.brake = 0;
    playerInput.drift = false;
  };
  const raceState = { name: 'racing' };
  const dt = 1 / 60;
  const frames = 60 * 240; // up to 4 minutes of racing (breaks early when finished)
  let maxParticles = 0;
  let thrown = null;
  const t0 = Date.now();
  try {
    raceManager.start();
    raceState.name = 'countdown';
    for (let f = 0; f < frames; f++) {
      if (raceManager.state === 'racing') raceState.name = 'racing';
      for (const kart of karts) {
        if (kart.isPlayer) {
          drivePlayer(kart);
          kart.update(dt, playerInput);
        }
      }
      for (const ai of aiDrivers) {
        const input = ai.update(dt, { raceManager, karts, state: raceState.name });
        ai.kart.update(dt, input);
      }
      raceManager.update(dt);
      itemSystem.update(dt, { raceManager });
      effects.update(dt, karts, trackApi);
      maxParticles = Math.max(maxParticles, effects.getStats().particles);
      if (raceManager.state === 'finished') break;
    }
  } catch (err) {
    thrown = err;
  }
  const elapsed = Date.now() - t0;

  const throwSite = thrown ? (thrown.stack || '').split('\n').find((l) => l.includes('/src/')) : '';
  check('simulated racing without throwing', !thrown, `${thrown?.message || ''} ${throwSite || ''}`.trim());
  if (karts.length) {
    check('karts actually drove', karts.some((k) => Math.abs(k.state.speed) > 10),
      `max speed=${Math.max(...karts.map((k) => Math.abs(k.state.speed))).toFixed(1)} m/s`);
  }
  check('lap events fired', seen.lap > 0, `laps=${seen.lap}`);
  check('final-lap events fired', seen.finalLap > 0, `final=${seen.finalLap}`);
  check('race reached the results state', raceManager.state === 'finished' && seen.complete > 0,
    `state=${raceManager.state} complete=${seen.complete}`);
  check('standings are complete', (raceManager.results?.length ?? 0) === 8, `rows=${raceManager.results?.length}`);
  check('standings places are 1..8',
    (raceManager.results || []).map((r) => r.place).sort((a, b) => a - b).join(',') === '1,2,3,4,5,6,7,8');
  check('items fired at least once', seen.itemUse + seen.itemBox > 0, `use=${seen.itemUse} box=${seen.itemBox}`);
  check('FX spawns were requested by other subsystems', seen.spawn > 0, `fx:spawn=${seen.spawn}`);
  check('FX stayed inside the high-quality budget (<=1200)', maxParticles <= 1200, `peak=${maxParticles}`);

  notes.push(`  info laps=${seen.lap} finalLap=${seen.finalLap} boost=${seen.boost} drift=${seen.drift} hits=${seen.hit} items=${seen.itemUse}/${seen.itemBox} finish=${seen.finish} complete=${seen.complete} fx=${seen.spawn}`);
  notes.push(`  info simulated ${frames} frames in ${elapsed} ms (peak particles ${maxParticles})`);

  try {
    for (const ai of aiDrivers) ai.dispose?.();
    for (const k of karts) k.dispose?.();
    itemSystem.dispose?.();
    raceManager.dispose?.();
    effects.dispose();
    builder?.dispose?.();
    trackApi.dispose?.();
  } catch (err) {
    failures.push(`  FAIL teardown threw: ${err?.message || err}`);
  }
  check('teardown completes', true);

  const ok = failures.length === 0;
  console.log('Turbo Kart — headless integration test');
  console.log(notes.join('\n'));
  if (failures.length) console.log(failures.join('\n'));
  console.log(ok ? 'RESULT: PASS' : `RESULT: FAIL (${failures.length})`);
  process.exit(ok ? 0 : 1);
}

try {
  await main();
} catch (err) {
  console.error('headless integration test crashed:', err);
  process.exit(1);
}
