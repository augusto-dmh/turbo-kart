/**
 * ============================================================================
 * TURBO KART — gameplay effects / "juice" (owned by Agent 5)
 * ============================================================================
 * `Effects` listens on the shared bus and drives a small set of pooled,
 * procedural particle systems. Nothing here allocates in the hot loop:
 *  - emission uses a single reused spec object,
 *  - all systems are fixed-capacity ring buffers (oldest particle recycled),
 *  - quality presets only change *live caps* and light usage (never rebuild).
 *
 * Public API (see main.js):
 *   new Effects({ bus, THREE, scene, camera })
 *   setTrack(trackApi) | setQuality(q) | update(dt, karts, trackApi)
 *   spawn(kind, position, opts) | dispose()
 *
 * Extra (for the integrator / HUD, optional):
 *   getSpeedLines() -> 0..1, getStats() -> { particles, meshes, quality }
 *   `fxState` (src/fx/fxState.js) is written every frame and read by `PostFX`.
 */
import { EVENTS } from '../contracts.js';
import { ParticleSystem, DebrisSystem, MeshPool } from './particles.js';
import { fxState, FX_TOP_SPEED } from './fxState.js';
import {
  makeSoftTexture, makeSmokeTexture, makeFlameTexture,
  makeQuestionTexture, makeBoltTexture, makeRingTexture,
} from './shaders.js';

/** Live-particle budgets and feature flags per quality preset. */
const QUALITY = {
  low: { total: 400, rate: 0.35, lights: 0, meshBudget: 0.35, cull: 45, trails: false },
  medium: { total: 700, rate: 0.6, lights: 0, meshBudget: 0.6, cull: 75, trails: false },
  high: { total: 1200, rate: 1.0, lights: 0, meshBudget: 1.0, cull: 120, trails: true },
  ultra: { total: 1800, rate: 1.35, lights: 4, meshBudget: 1.3, cull: 165, trails: true },
};

/** System capacities are laid out for the `ultra` total (1800 particles). */
const TOTAL_CAPACITY = 1800;

/** Mini-turbo stage colours: 0 = blue, 1 = orange, 2 = purple. */
const DRIFT_COLORS = [0x59c8ff, 0xff9a2e, 0xc25bff];
const DRIFT_ENDS = [0x1e6fff, 0xff5a00, 0xff3ce0];

/** Surface colour per track theme / surface name (off-road dust). */
const SURFACE_COLORS = {
  sunset: 0xd8b483,
  desert: 0xe6c489,
  snow: 0xeef4ff,
  grass: 0x7d9a52,
  sand: 0xe0c184,
  dirt: 0x9a7b52,
  gravel: 0xa8a29a,
  ice: 0xdff2ff,
  water: 0x5fb6d9,
  default: 0x9a8f77,
};

const CONFETTI_COLORS = [0xff3b30, 0xffd400, 0x27d17f, 0x4fc3ff, 0xff6fb5, 0xffffff, 0x7b5cff];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * @param {any} value hex number | {r,g,b}
 * @returns {number|any} whatever `ParticleSystem` accepts
 */
function asColor(value, fallback) {
  if (typeof value === 'number') return value;
  if (value && typeof value.r === 'number') return value;
  return fallback;
}

export class Effects {
  /**
   * @param {Object} opts
   * @param {any} opts.bus   shared event bus
   * @param {any} opts.THREE
   * @param {any} opts.scene
   * @param {any} opts.camera
   */
  constructor({ bus, THREE, scene, camera }) {
    this.bus = bus;
    this.THREE = THREE;
    this.scene = scene;
    this.camera = camera;
    this.quality = 'high';
    this._q = QUALITY.high;
    this._time = 0;
    this._unsubs = [];
    /** @type {Array<{delay:number, kind:string, x:number,y:number,z:number, opts:any}>} */
    this._queue = [];
    this._lights = [];
    this._systems = [];
    this._disposed = false;
    this.speedLines = 0;
    this.track = null;
    this.theme = 'sunset';
    this.surfaceColor = SURFACE_COLORS.default;
    this._surfaceColor = this.surfaceColor;
    this._surfaceTimer = 0;
    this._finish = new THREE.Vector3();
    this._hasFinish = false;

    // Reused scratch (never allocated in update()).
    this._v = new THREE.Vector3();
    this._spec = {};

    this._build();
    this._wireEvents();
    this.setQuality(this.quality);
  }

  // ------------------------------------------------------------- building ---
  /** @private */
  _build() {
    const THREE = this.THREE;
    const scene = this.scene;
    const texSoft = makeSoftTexture(THREE);
    const texSmoke = makeSmokeTexture(THREE);
    const texFlame = makeFlameTexture(THREE);
    const texQuestion = makeQuestionTexture(THREE);
    const texBolt = makeBoltTexture(THREE);
    const texRing = makeRingTexture(THREE);
    this._textures = [texSoft, texSmoke, texFlame, texQuestion, texBolt, texRing].filter(Boolean);

    this.spark = this._addSystem(new ParticleSystem({
      THREE, capacity: 520, blending: 'additive', texture: texSoft,
      renderOrder: 8, softness: 0.6, name: 'spark',
    }));
    this.fire = this._addSystem(new ParticleSystem({
      THREE, capacity: 300, blending: 'additive', texture: texSoft,
      renderOrder: 9, softness: 0.5, name: 'fire',
    }));
    this.smoke = this._addSystem(new ParticleSystem({
      THREE, capacity: 340, blending: 'normal', texture: texSmoke,
      renderOrder: 6, softness: 1.4, name: 'smoke',
    }));
    this.dust = this._addSystem(new ParticleSystem({
      THREE, capacity: 380, blending: 'normal', texture: texSoft,
      renderOrder: 5, softness: 1.2, name: 'dust',
    }));
    this.trail = this._addSystem(new ParticleSystem({
      THREE, capacity: 260, blending: 'additive', texture: texSoft,
      renderOrder: 7, softness: 0.6, name: 'trail',
    }));

    this.debris = new DebrisSystem({ THREE, capacity: 96, size: 0.2, lit: true, renderOrder: 3 });
    this.confetti = new DebrisSystem({ THREE, capacity: 140, size: 0.16, lit: false, renderOrder: 4 });
    scene.add(this.debris.mesh);
    scene.add(this.confetti.mesh);

    const coneGeo = new THREE.ConeGeometry(0.34, 1.4, 8, 1, true);
    coneGeo.rotateX(-Math.PI / 2); // apex points along -Z (behind the kart)
    const ballGeo = new THREE.IcosahedronGeometry(0.5, 1);
    const ringGeo = new THREE.RingGeometry(0.55, 1, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    this._geometries = [coneGeo, ballGeo, ringGeo, planeGeo];
    this.flamePool = new MeshPool({
      THREE, count: 16, geometry: coneGeo, billboard: false,
      material: new THREE.MeshBasicMaterial({
        color: 0xffb347, map: texFlame, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
      renderOrder: 10, name: 'fx-flame',
    });
    this.ballPool = new MeshPool({
      THREE, count: 12, geometry: ballGeo,
      material: new THREE.MeshBasicMaterial({
        color: 0xff8a2b, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      renderOrder: 10, name: 'fx-fireball',
    });
    this.ringPool = new MeshPool({
      THREE, count: 10, geometry: ringGeo,
      material: new THREE.MeshBasicMaterial({
        color: 0xffffff, map: texRing, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
      renderOrder: 4, name: 'fx-ring',
    });
    this.ghostPool = new MeshPool({
      THREE, count: 6, geometry: planeGeo, billboard: true,
      material: new THREE.MeshBasicMaterial({
        color: 0xffffff, map: texQuestion, transparent: true, depthWrite: false,
      }),
      renderOrder: 11, name: 'fx-ghost',
    });
    this.boltPool = new MeshPool({
      THREE, count: 4, geometry: planeGeo, billboard: true,
      material: new THREE.MeshBasicMaterial({
        color: 0xcfe0ff, map: texBolt, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
      renderOrder: 12, name: 'fx-bolt',
    });
    this._pools = [this.flamePool, this.ballPool, this.ringPool, this.ghostPool, this.boltPool];
    for (const pool of this._pools) for (const mesh of pool.meshes) scene.add(mesh);
  }

  /** @private */
  _addSystem(system) {
    this.scene.add(system.points);
    this._systems.push(system);
    return system;
  }

  // -------------------------------------------------------------- events ----
  /** @private */
  _wireEvents() {
    const bus = this.bus;
    if (!bus?.on) return;
    const on = (event, fn) => {
      const off = bus.on(event, (payload) => {
        try {
          fn(payload || {});
        } catch (err) {
          // FX must never break the game: swallow and keep going.
          if (!this._warned) {
            this._warned = true;
            console.warn('[fx] effect handler failed:', err);
          }
        }
      });
      this._unsubs.push(off);
    };

    on(EVENTS.KART_BOOST, (p) => this._onBoost(p, 'boost'));
    on(EVENTS.KART_ROCKET_START, (p) => this._onBoost(p, 'rocket'));
    on(EVENTS.KART_DRIFT_START, (p) => this._onDriftStart(p));
    on(EVENTS.KART_DRIFT_CHARGE, (p) => this._onDriftCharge(p));
    on(EVENTS.KART_DRIFT_BOOST, (p) => this._onDriftBoost(p));
    on(EVENTS.KART_HOP, (p) => this._onHop(p));
    on(EVENTS.KART_LAND, (p) => this._onLand(p));
    on(EVENTS.KART_OFFROAD, (p) => this._onOffroad(p));
    on(EVENTS.KART_HIT, (p) => this._onHit(p));
    on(EVENTS.KART_SPIN, (p) => this._onSpin(p));
    on(EVENTS.ITEM_BOX, (p) => this._onItemBox(p));
    on(EVENTS.ITEM_ROLL, (p) => this._onItemRoll(p));
    on(EVENTS.ITEM_USE, (p) => this._onItemUse(p));
    on(EVENTS.ITEM_HIT, (p) => this._onItemHit(p));
    on(EVENTS.ITEM_EXPIRE, (p) => this._onItemExpire(p));
    on(EVENTS.RACE_COUNTDOWN, (p) => this._onCountdown(p));
    on(EVENTS.RACE_START, () => {
      fxState.active = true;
      this._queue.length = 0;
    });
    on(EVENTS.RACE_FINISH, (p) => this._onFinish(p));
    on(EVENTS.RACE_COMPLETE, (p) => this._onComplete(p));
    on(EVENTS.FX_SPAWN, (p) => this.spawn(p.kind, p.position, p.opts));
  }

  // --------------------------------------------------------------- public ---
  /**
   * Called by the integrator on race start and with `null` on teardown.
   * @param {any} trackApi
   */
  setTrack(trackApi) {
    this.track = trackApi || null;
    this.theme = trackApi?.theme || 'sunset';
    // Prefer an explicit surface from the track, then a theme name, then a default.
    const surface = trackApi?.offRoadSurface ?? trackApi?.surface;
    if (typeof surface === 'number') this.surfaceColor = surface;
    else if (typeof surface === 'string') this.surfaceColor = SURFACE_COLORS[surface] ?? SURFACE_COLORS.default;
    else this.surfaceColor = SURFACE_COLORS[this.theme] ?? SURFACE_COLORS.default;
    this._hasFinish = false;
    if (trackApi && typeof trackApi.pointAt === 'function') {
      try {
        const p = trackApi.pointAt(trackApi.startU ?? 0, 0);
        if (p && typeof p.x === 'number') {
          this._finish.set(p.x, p.y ?? 0, p.z);
          this._hasFinish = true;
        }
      } catch (err) { /* track not ready — ignore */ }
    }
  }

  /**
   * Apply a quality preset. Takes effect immediately; only live caps change,
   * so nothing is reallocated and nothing leaks.
   * @param {'low'|'medium'|'high'|'ultra'} q
   */
  setQuality(q) {
    const preset = QUALITY[q] ? q : 'high';
    this.quality = preset;
    this._q = QUALITY[preset];
    const factor = this._q.total / TOTAL_CAPACITY;
    for (const s of this._systems) s.setCap(Math.round(s.capacity * factor));
    this.debris.setCap(Math.round(96 * factor));
    this.confetti.setCap(Math.round(140 * factor));
    const budget = this._q.meshBudget;
    this.flamePool.setCap(Math.round(16 * budget));
    this.ballPool.setCap(Math.round(12 * budget));
    this.ringPool.setCap(Math.round(10 * budget));
    this.ghostPool.setCap(Math.round(6 * budget));
    this.boltPool.setCap(Math.round(4 * Math.max(0.5, budget)));
    if (this._q.lights === 0) this._releaseLights();
    fxState.quality = preset;
  }

  /**
   * Per-frame update. Safe with missing/partial arguments.
   * @param {number} dt
   * @param {any[]} [karts]
   * @param {any} [trackApi]
   */
  update(dt, karts, trackApi) {
    if (this._disposed) return;
    const step = clamp(typeof dt === 'number' && isFinite(dt) ? dt : 0.016, 0, 0.05);
    this._time += step;
    if (trackApi && trackApi !== this.track) this.setTrack(trackApi);

    this._updateScreenScale();
    this._surfaceTimer = Math.max(0, this._surfaceTimer - step);
    this._processQueue(step);

    const list = Array.isArray(karts) ? karts : null;
    let refSpeed = 0;
    let refDrift = 0;
    let refBoost = 0;
    if (list) {
      for (const kart of list) {
        const st = kart?.state;
        if (!st) continue;
        const spd = Math.abs(st.speed || 0);
        if (kart.isPlayer) {
          refSpeed = spd;
          refDrift = st.driftLevel | 0;
          if (st.boosting) refBoost = 0.9;
        } else if (spd > refSpeed) {
          refSpeed = spd;
        }
        this._kartEffects(kart, step);
      }
    }

    for (const s of this._systems) s.update(step);
    this.debris.update(step);
    this.confetti.update(step);
    for (const pool of this._pools) pool.update(step, this.camera);
    this._updateLights(step);

    // Shared presentation state consumed by PostFX.
    fxState.speed = refSpeed;
    fxState.speedNorm = clamp(refSpeed / FX_TOP_SPEED, 0, 1);
    fxState.driftLevel = refDrift;
    fxState.boost = Math.max(fxState.boost - step * 1.15, refBoost);
    fxState.flash = Math.max(0, fxState.flash - step * 3.2);
    let liveParticles = 0;
    for (const s of this._systems) liveParticles += s.live;
    fxState.particles = liveParticles;
    const targetLines = clamp(
      Math.max(fxState.boost, (fxState.speedNorm - 0.62) / 0.38) * (this.quality === 'ultra' ? 1.25 : 1),
      0, 1,
    );
    this.speedLines += (targetLines - this.speedLines) * Math.min(1, step * 6);
  }

  /**
   * Speed-line / boost overlay factor, 0..1. The HUD or a DOM overlay may use
   * it; PostFX uses `fxState.speedNorm` for its radial blur.
   * @returns {number}
   */
  getSpeedLines() {
    return this.speedLines;
  }

  /** @returns {{particles:number, meshes:number, quality:string}} */
  getStats() {
    let particles = 0;
    for (const s of this._systems) particles += s.live;
    let meshes = this.debris._live + this.confetti._live;
    for (const p of this._pools) meshes += p.live;
    return { particles, meshes, quality: this.quality };
  }

  /**
   * Spawn an effect by name (also the `FX_SPAWN` bus handler).
   * @param {string} kind
   * @param {any} [position] `{x,y,z}` or `THREE.Vector3`
   * @param {Object} [opts]
   */
  spawn(kind, position, opts = {}) {
    if (this._disposed) return;
    const p = position || opts.position;
    const x = p?.x ?? 0;
    const y = p?.y ?? 0;
    const z = p?.z ?? 0;
    const name = typeof kind === 'string' ? kind : 'sparkle';
    const scale = opts.scale ?? 1;

    switch (name) {
      case 'boost':
      case 'flame':
        this._burstFire(x, y + 0.4, z, 0.7 * scale, opts.color ?? 0xff9a3c);
        this._ring(x, y + 0.15, z, 0xffffff, 2.4 * scale, 0.35);
        break;
      // ---- kinds emitted by Kart / ItemSystem through FX_SPAWN --------------
      // (the matching bus events already draw the big version, so these stay
      //  light to avoid doubling the particle count)
      case 'drift-spark': {
        const lv = clamp((opts.level ?? 0) | 0, 0, 2);
        this._sparkBurst(x, y + 0.12, z, opts.color ?? DRIFT_COLORS[lv], 3, 1.6);
        break;
      }
      case 'drift-charge': {
        const lv = clamp((opts.level ?? 0) | 0, 0, 2);
        this._sparkBurst(x, y + 0.25, z, opts.color ?? DRIFT_COLORS[lv], 5, 1.8);
        break;
      }
      case 'drift-boost': {
        const lv = clamp((opts.level ?? 0) | 0, 0, 2);
        this._sparkBurst(x, y + 0.25, z, opts.color ?? DRIFT_COLORS[lv], 6, 2.6);
        break;
      }
      case 'rocket-start':
        this._burstFire(x, y + 0.35, z, 0.8 * scale, 0xffa63c);
        this._streaks(x, y + 0.3, z, 0, 0, 0xffd070);
        break;
      case 'boost-pad':
        this._burstFire(x, y + 0.35, z, 0.6 * scale, opts.color ?? 0x59d0ff);
        this._ring(x, y + 0.1, z, opts.color ?? 0x59d0ff, 2.2 * scale, 0.35);
        break;
      case 'wheelspin':
        this._smokeRing(x, y + 0.25, z, 1.2);
        this._smokePuff(x, y + 0.2, z, 0xd8d8d8, 0.8);
        break;
      case 'ramp':
        this._dustPuff(x, y + 0.1, z, this.surfaceColor, 0.9);
        this._ring(x, y + 0.08, z, this.surfaceColor, 2.0, 0.35);
        break;
      case 'respawn':
        this._ring(x, y + 0.15, z, 0x9fe8ff, 2.6, 0.5);
        this._sparkBurst(x, y + 0.6, z, 0x9fe8ff, 12, 3);
        break;
      case 'spark':
        this._sparkBurst(x, y + 0.35, z, 0xfff0a0, 6 * scale, 2.4);
        break;
      case 'explosion':
      case 'shell':
        this._explosion(x, y + 0.5, z, opts.color ?? 0xff8a2b, scale);
        break;
      case 'lightning':
        this._lightning(x, y, z, opts.color ?? 0xd7e4ff, opts.radius);
        break;
      case 'star-aura':
        this._starBurst(x, y + 0.7, z, 1.2 * scale);
        break;
      case 'hit':
        this._impact(x, y + 0.5, z, opts.color ?? 0xfff2a8);
        break;
      case 'dust':
        this._dustPuff(x, y + 0.1, z, opts.color ?? this.surfaceColor, (opts.landing ? 1.5 : 0.55) * scale);
        break;
      case 'smoke':
        this._smokePuff(x, y + 0.3, z, opts.color ?? 0xdddddd, 1 * scale);
        break;
      case 'landing':
      case 'land':
        this._landing(x, y, z, opts.impact ?? 6);
        break;
      case 'spin':
        this._smokeRing(x, y + 0.3, z, 1);
        break;
      case 'itembox':
      case 'box':
      case 'item':
        this._itemBox(x, y + 0.6, z);
        break;
      case 'star':
        this._starBurst(x, y + 0.7, z, 1.4 * scale);
        break;
      case 'confetti':
        this._confetti(x, y, z, scale);
        break;
      case 'firework':
        this._firework(x, y, z, opts.color ?? CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]);
        break;
      case 'ring':
        this._ring(x, y + 0.1, z, opts.color ?? 0xffffff, 2 * scale, 0.4);
        break;
      case 'shell-trail': {
        const color = opts.color ?? 0x2ecc71;
        this._spec.x = x; this._spec.y = y; this._spec.z = z;
        this._spec.vx = rand(-0.3, 0.3); this._spec.vy = rand(0.1, 0.5); this._spec.vz = rand(-0.3, 0.3);
        this._spec.spread = 0.2; this._spec.radius = 0.12;
        this._spec.color = color; this._spec.colorEnd = color;
        this._spec.size = 0.34; this._spec.sizeEnd = 0.05;
        this._spec.life = 0.3; this._spec.alpha = 0.85; this._spec.alphaEnd = 0;
        this._spec.gravity = 0; this._spec.drag = 3.2; this._spec.count = Math.max(1, Math.round(2 * scale));
        this.trail.emit(this._spec);
        break;
      }
      default:
        this._sparkBurst(x, y, z, opts.color ?? 0xffffff, 10 * scale, 2.2 * scale);
        break;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch (err) { /* ignore */ }
    }
    this._unsubs.length = 0;
    for (const s of this._systems) s.dispose();
    this.debris.dispose();
    this.confetti.dispose();
    for (const pool of this._pools) pool.dispose();
    for (const geo of this._geometries || []) geo?.dispose?.();
    for (const tex of this._textures) tex?.dispose?.();
    this._releaseLights(true);
    for (const e of this._lights) {
      e.light.removeFromParent?.();
      e.light.dispose?.();
    }
    this._lights.length = 0;
    this._systems.length = 0;
    this._pools.length = 0;
    this._queue.length = 0;
    this.track = null;
    fxState.particles = 0;
    fxState.speed = 0;
    fxState.speedNorm = 0;
    fxState.boost = 0;
    fxState.flash = 0;
  }

  // ------------------------------------------------------ per-kart effects --
  /** @private */
  _kartEffects(kart, dt) {
    const st = kart?.state;
    if (!st) return;
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const dist = this.camera ? pos.distanceTo(this.camera.position) : 0;
    if (dist > this._q.cull) return;

    const speed = Math.abs(st.speed || 0);
    const yaw = this._kartYaw(kart);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = fz;
    const rz = -fx;
    const rearX = pos.x - fx * 1.05;
    const rearZ = pos.z - fz * 1.05;
    const y = pos.y + 0.12;
    const spec = this._spec;

    // --- drift sparks ------------------------------------------------------
    if (st.drifting && !st.airborne && speed > 4) {
      const level = clamp(st.driftLevel | 0, 0, 2);
      const color = DRIFT_COLORS[level];
      const count = this._rate(level === 2 ? 62 : 40, dt);
      if (count > 0) {
        for (let side = -1; side <= 1; side += 2) {
          const half = Math.max(1, Math.round(count / 2));
          spec.x = rearX + rx * 0.44 * side;
          spec.y = y;
          spec.z = rearZ + rz * 0.44 * side;
          spec.vx = -fx * speed * 0.22 + rx * side * 1.8;
          spec.vy = rand(1.2, 3.2);
          spec.vz = -fz * speed * 0.22 + rz * side * 1.8;
          spec.spread = 1.4;
          spec.radius = 0.12;
          spec.color = color;
          spec.colorEnd = DRIFT_ENDS[level];
          spec.size = 0.17;
          spec.sizeEnd = 0.04;
          spec.life = rand(0.16, 0.34);
          spec.alpha = 1;
          spec.alphaEnd = 0;
          spec.gravity = -15;
          spec.drag = 1.8;
          spec.count = half;
          this.spark.emit(spec);
        }
      }
      if (this._q.lights > 0) {
        this._useLight(color, level === 2 ? 26 : 16, 0.16, rearX, y + 0.1, rearZ);
      }
    }

    // --- off-road dust -----------------------------------------------------
    if (st.offRoad && !st.airborne && speed > 3) {
      const count = this._rate(26, dt);
      if (count > 0) {
        const dustColor = this._dustColorAt(pos);
        spec.x = rearX;
        spec.y = y;
        spec.z = rearZ;
        spec.vx = -fx * speed * 0.1 + rand(-0.6, 0.6);
        spec.vy = rand(0.8, 2.0);
        spec.vz = -fz * speed * 0.1 + rand(-0.6, 0.6);
        spec.spread = 0.8;
        spec.radius = 0.55;
        spec.color = dustColor;
        spec.colorEnd = dustColor;
        spec.size = 0.4;
        spec.sizeEnd = 1.35;
        spec.life = rand(0.5, 0.95);
        spec.alpha = 0.55;
        spec.alphaEnd = 0;
        spec.gravity = -1.6;
        spec.drag = 2.4;
        spec.count = count;
        this.dust.emit(spec);
      }
    }

    // --- boost flames + streaks -------------------------------------------
    if (st.boosting && !st.frozen) {
      const count = this._rate(52, dt);
      if (count > 0) {
        spec.x = rearX;
        spec.y = y + 0.25;
        spec.z = rearZ;
        spec.vx = -fx * (4 + speed * 0.25) + rand(-0.5, 0.5);
        spec.vy = rand(-0.2, 0.6);
        spec.vz = -fz * (4 + speed * 0.25) + rand(-0.5, 0.5);
        spec.spread = 0.7;
        spec.radius = 0.2;
        spec.color = 0xfff0b0;
        spec.colorEnd = 0xff5a12;
        spec.size = 0.34;
        spec.sizeEnd = 0.06;
        spec.life = rand(0.14, 0.3);
        spec.alpha = 0.95;
        spec.alphaEnd = 0;
        spec.gravity = 0.6;
        spec.drag = 2.6;
        spec.count = count;
        this.fire.emit(spec);
      }
      if (this._q.trails) {
        const trailCount = this._rate(26, dt);
        if (trailCount > 0) {
          spec.x = rearX + rand(-0.3, 0.3);
          spec.y = y + rand(0.1, 0.7);
          spec.z = rearZ + rand(-0.3, 0.3);
          spec.vx = -fx * speed * 0.4;
          spec.vy = 0;
          spec.vz = -fz * speed * 0.4;
          spec.spread = 0.2;
          spec.radius = 0.1;
          spec.color = 0xffd070;
          spec.colorEnd = 0xff7b1a;
          spec.size = 0.5;
          spec.sizeEnd = 0.06;
          spec.life = rand(0.2, 0.4);
          spec.alpha = 0.7;
          spec.alphaEnd = 0;
          spec.gravity = 0;
          spec.drag = 1.2;
          spec.count = trailCount;
          this.trail.emit(spec);
        }
      }
      // Short flame cone right at the exhaust (pooled mesh, cheap).
      if (this._q.meshBudget >= 0.6 && Math.random() < Math.min(1, dt * 14)) {
        this.flamePool.spawn({
          x: rearX - fx * 0.15, y: y + 0.3, z: rearZ - fz * 0.15,
          life: 0.1, size: rand(0.75, 1.05), sizeEnd: 0.2,
          opacity: 0.9, opacityEnd: 0, rot: yaw + Math.PI,
        });
      }
      if (this._q.lights > 0) {
        this._useLight(0xff9a3c, 30, 0.14, rearX - fx * 0.4, y + 0.3, rearZ - fz * 0.4);
      }
    }

    // --- invincibility star aura ------------------------------------------
    if (st.invincible) {
      const count = this._rate(34, dt);
      if (count > 0) {
        const hue = (this._time * 0.6) % 1;
        spec.x = pos.x;
        spec.y = pos.y + 0.7;
        spec.z = pos.z;
        spec.vx = rand(-0.6, 0.6);
        spec.vy = rand(0.6, 1.8);
        spec.vz = rand(-0.6, 0.6);
        spec.spread = 0.6;
        spec.radius = 1.25;
        spec.color = this._hueColor(hue);
        spec.colorEnd = this._hueColor((hue + 0.35) % 1);
        spec.size = 0.3;
        spec.sizeEnd = 0.05;
        spec.life = rand(0.3, 0.6);
        spec.alpha = 0.95;
        spec.alphaEnd = 0;
        spec.gravity = 0.4;
        spec.drag = 1.4;
        spec.count = count;
        this.spark.emit(spec);
      }
      if (this._q.lights > 0) this._useLight(this._hueColor((this._time * 0.6) % 1), 22, 0.12, pos.x, pos.y + 0.8, pos.z);
    }

    // --- frozen / squashed -------------------------------------------------
    if (st.frozen) {
      const count = this._rate(10, dt);
      if (count > 0) {
        spec.x = pos.x;
        spec.y = pos.y + 0.5;
        spec.z = pos.z;
        spec.vx = rand(-0.4, 0.4);
        spec.vy = rand(0.2, 0.8);
        spec.vz = rand(-0.4, 0.4);
        spec.spread = 0.3;
        spec.radius = 0.6;
        spec.color = 0xd8f2ff;
        spec.colorEnd = 0x8fd8ff;
        spec.size = 0.22;
        spec.sizeEnd = 0.05;
        spec.life = rand(0.35, 0.7);
        spec.alpha = 0.8;
        spec.alphaEnd = 0;
        spec.gravity = -2;
        spec.drag = 1.2;
        spec.count = count;
        this.spark.emit(spec);
      }
    }

    // --- spinning: tyre smoke ---------------------------------------------
    if (st.spinning) {
      const count = this._rate(30, dt);
      if (count > 0) {
        spec.x = pos.x + rand(-0.5, 0.5);
        spec.y = pos.y + 0.15;
        spec.z = pos.z + rand(-0.5, 0.5);
        spec.vx = rand(-1.2, 1.2);
        spec.vy = rand(0.6, 1.8);
        spec.vz = rand(-1.2, 1.2);
        spec.spread = 0.6;
        spec.radius = 0.3;
        spec.color = 0xdedede;
        spec.colorEnd = 0x9a9a9a;
        spec.size = 0.45;
        spec.sizeEnd = 1.5;
        spec.life = rand(0.4, 0.8);
        spec.alpha = 0.6;
        spec.alphaEnd = 0;
        spec.gravity = -0.8;
        spec.drag = 2.0;
        spec.count = count;
        this.smoke.emit(spec);
      }
    }
  }

  // ---------------------------------------------------------- event bodies --
  /** @private */
  _onBoost({ kart, power } = {}, source) {
    const pos = this._kartPos(kart, this._v);
    fxState.boost = Math.min(1, (power ?? 0.8) + 0.25);
    if (!pos) return;
    const yaw = this._kartYaw(kart);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const x = pos.x - fx * 1.1;
    const z = pos.z - fz * 1.1;
    const y = pos.y + 0.35;
    this._burstFire(x, y, z, 0.8, 0xffa63c);
    this._ring(x, pos.y + 0.1, z, 0xffe08a, 2.2, 0.32);
    if (this._q.trails) this._streaks(x, y, z, -fx, -fz, 0xffd070);
    this._useLight(0xff9a3c, source === 'rocket' ? 45 : 32, 0.22, x, y, z);
    this._shake(source === 'rocket' ? 0.35 : 0.18, 0.25);
  }

  /** @private */
  _onDriftStart({ kart } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    this._dustPuff(pos.x, pos.y + 0.1, pos.z, this.surfaceColor, 0.7);
  }

  /** @private */
  _onDriftCharge({ kart, level } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const lv = clamp(level | 0, 0, 2);
    this._sparkBurst(pos.x, pos.y + 0.25, pos.z, DRIFT_COLORS[lv], 8, 1.6);
  }

  /** @private */
  _onDriftBoost({ kart, level } = {}) {
    const pos = this._kartPos(kart, this._v);
    const lv = clamp(level | 0, 0, 2);
    fxState.boost = 1;
    if (!pos) return;
    const yaw = this._kartYaw(kart);
    const x = pos.x - Math.sin(yaw) * 1.1;
    const z = pos.z - Math.cos(yaw) * 1.1;
    this._sparkBurst(x, pos.y + 0.25, z, DRIFT_COLORS[lv], lv === 2 ? 26 : 16, 3.4);
    this._ring(x, pos.y + 0.1, z, DRIFT_COLORS[lv], 2.8, 0.45);
    this._useLight(DRIFT_COLORS[lv], 40, 0.3, x, pos.y + 0.3, z);
    this._shake(0.2, 0.2);
  }

  /** @private */
  _onHop({ kart } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    this._dustPuff(pos.x, pos.y + 0.05, pos.z, this.surfaceColor, 0.5);
  }

  /** @private */
  _onLand({ kart, impact } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const force = typeof impact === 'number' ? impact : (impact?.force ?? impact?.power ?? 5);
    this._landing(pos.x, pos.y, pos.z, force);
    if (force > 9) this._shake(clamp(force / 40, 0.05, 0.35), 0.22);
  }

  /** @private */
  _onOffroad({ kart, onRoad } = {}) {
    if (onRoad === true) return;
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    this._dustPuff(pos.x, pos.y + 0.1, pos.z, this.surfaceColor, 1.2);
  }

  /** @private */
  _onHit({ kart, source, kind, from } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const label = `${kind || ''} ${source?.id || source?.kind || source?.name || ''}`.toLowerCase();
    if (label.includes('shell') || label.includes('explo')) {
      this._explosion(pos.x, pos.y + 0.5, pos.z, 0xff8a2b, 1);
    } else if (label.includes('lightning') || label.includes('bolt')) {
      this._lightning(pos.x, pos.y, pos.z, 0xd7e4ff);
    } else {
      this._impact(pos.x, pos.y + 0.5, pos.z, 0xfff2a8);
    }
    const fromPos = from?.position;
    if (fromPos && typeof fromPos.x === 'number') {
      this._streaks(fromPos.x, fromPos.y + 0.5, fromPos.z, 0, 0, 0xffd070);
    }
    this._shake(0.28, 0.3);
  }

  /** @private */
  _onSpin({ kart } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    this._smokeRing(pos.x, pos.y + 0.3, pos.z, 1.3);
    this._sparkBurst(pos.x, pos.y + 0.9, pos.z, 0xfff0a0, 10, 2.2);
  }

  /** @private */
  _onItemBox({ kart } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    this._itemBox(pos.x, pos.y + 0.7, pos.z);
  }

  /** @private */
  _onItemRoll({ kart, item } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const color = asColor(typeof item === 'string' ? undefined : item?.color, 0xfff6be);
    this._sparkBurst(pos.x, pos.y + 0.9, pos.z, color, 6, 1.4);
  }

  /** @private */
  _onItemUse({ kart, item } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const id = typeof item === 'string' ? item : (item?.id ?? '');
    const yaw = this._kartYaw(kart);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const bx = pos.x + fx * 0.6;
    const bz = pos.z + fz * 0.6;
    switch (id) {
      case 'mushroom':
      case 'triple-mushroom':
        this._burstFire(bx, pos.y + 0.35, bz, 1.1, 0xff9a3c);
        this._ring(bx, pos.y + 0.1, bz, 0xffd070, 2.6, 0.4);
        this._useLight(0xff9a3c, 45, 0.3, bx, pos.y + 0.4, bz);
        break;
      case 'green-shell':
        this._sparkBurst(bx, pos.y + 0.5, bz, 0x2ecc71, 14, 2.6);
        this._shellTrail(bx, pos.y + 0.5, bz, 0x2ecc71);
        break;
      case 'red-shell':
        this._sparkBurst(bx, pos.y + 0.5, bz, 0xe74c3c, 14, 2.6);
        this._shellTrail(bx, pos.y + 0.5, bz, 0xe74c3c);
        break;
      case 'triple-shell':
        this._sparkBurst(bx, pos.y + 0.5, bz, 0x9b59b6, 18, 2.8);
        this._shellTrail(bx, pos.y + 0.5, bz, 0x9b59b6);
        break;
      case 'star':
        this._starBurst(pos.x, pos.y + 0.8, pos.z, 2.2);
        this._useLight(0xffe680, 60, 0.5, pos.x, pos.y + 1, pos.z);
        break;
      case 'lightning':
        this._lightning(pos.x, pos.y, pos.z, 0xd7e4ff);
        break;
      case 'banana':
        this._sparkBurst(bx, pos.y + 0.4, bz, 0xffe14d, 8, 1.8);
        break;
      default:
        this._sparkBurst(pos.x, pos.y + 0.6, pos.z, 0xffffff, 8, 1.6);
        break;
    }
  }

  /** @private */
  _onItemHit({ kart, item } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const color = asColor(typeof item === 'string' ? undefined : item?.color, 0xff8a2b);
    this._explosion(pos.x, pos.y + 0.5, pos.z, color, 1);
    this._shake(0.32, 0.32);
  }

  /** @private */
  _onItemExpire({ kart, item } = {}) {
    const pos = this._kartPos(kart, this._v);
    if (!pos) return;
    const color = asColor(typeof item === 'string' ? undefined : item?.color, 0xbbbbbb);
    this._smokePuff(pos.x, pos.y + 0.6, pos.z, color, 0.7);
  }

  /** @private */
  _onCountdown({ value } = {}) {
    if (value !== 0) return;
    const p = this._finish;
    if (!this._hasFinish) return;
    this._ring(p.x, p.y + 0.2, p.z, 0xfff0a0, 6, 0.6);
    this._sparkBurst(p.x, p.y + 1.2, p.z, 0xffe680, 22, 5);
  }

  /** @private */
  _onFinish({ kart, place } = {}) {
    const pos = this._kartPos(kart, this._v);
    const p = pos || (this._hasFinish ? this._finish : null);
    if (!p) return;
    const isWinner = place === 1 || place === undefined;
    const cannons = isWinner ? 3 : 1;
    for (let i = 0; i < cannons; i++) {
      this._queue.push({
        delay: i * 0.12,
        kind: 'confetti',
        x: p.x + rand(-3, 3),
        y: p.y + 1.5,
        z: p.z + rand(-3, 3),
        opts: { scale: isWinner ? 1.4 : 0.9 },
      });
    }
  }

  /** @private */
  _onComplete({ standings } = {}) {
    const p = this._hasFinish ? this._finish : null;
    const base = p || { x: 0, y: 6, z: 0 };
    const count = Array.isArray(standings) ? Math.min(6, standings.length) : 4;
    for (let i = 0; i < Math.max(4, count); i++) {
      this._queue.push({
        delay: 0.35 + i * 0.42,
        kind: 'firework',
        x: base.x + rand(-26, 26),
        y: (base.y ?? 0) + rand(14, 26),
        z: base.z + rand(-26, 26),
        opts: { color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] },
      });
    }
    fxState.flash = Math.max(fxState.flash, 0.25);
  }

  /** @private */
  _processQueue(dt) {
    if (this._queue.length === 0) return;
    for (let i = this._queue.length - 1; i >= 0; i--) {
      const item = this._queue[i];
      item.delay -= dt;
      if (item.delay <= 0) {
        this._queue.splice(i, 1);
        if (item.kind === 'confetti') this._confetti(item.x, item.y, item.z, item.opts?.scale ?? 1);
        else if (item.kind === 'firework') this._firework(item.x, item.y, item.z, item.opts?.color);
        else this.spawn(item.kind, item, item.opts);
      }
    }
  }

  // ------------------------------------------------------- effect bodies ----
  /** @private */
  _rate(rate, dt) {
    const n = rate * this._q.rate * dt;
    const i = Math.floor(n);
    return Math.random() < n - i ? i + 1 : i;
  }

  /**
   * Surface colour under a kart, resolved from `trackApi.surfaceAt()` at most a
   * few times per second (the result is cached; surfaces change slowly).
   * @private
   */
  _dustColorAt(pos) {
    if (this._surfaceTimer <= 0) {
      this._surfaceTimer = 0.25;
      let color = null;
      try {
        const sa = this.track?.surfaceAt?.(pos);
        const name = typeof sa === 'string' ? sa : sa?.surface;
        if (typeof name === 'string') color = SURFACE_COLORS[name] ?? null;
      } catch (err) { /* surfaceAt is optional — ignore */ }
      this._surfaceColor = color ?? this.surfaceColor;
    }
    return this._surfaceColor;
  }

  /** @private */
  _sparkBurst(x, y, z, color, count, speed) {
    const spec = this._spec;
    spec.x = x; spec.y = y; spec.z = z;
    spec.vx = 0; spec.vy = 1.5; spec.vz = 0;
    spec.spread = speed;
    spec.radius = 0.12;
    spec.color = color;
    spec.colorEnd = 0xffffff;
    spec.size = 0.24;
    spec.sizeEnd = 0.03;
    spec.life = rand(0.3, 0.6);
    spec.alpha = 1;
    spec.alphaEnd = 0;
    spec.gravity = -9;
    spec.drag = 1.1;
    spec.count = Math.max(1, Math.round(count * Math.max(0.4, this._q.rate)));
    this.spark.emit(spec);
  }

  /** @private */
  _burstFire(x, y, z, scale = 1, color = 0xff9a3c) {
    const spec = this._spec;
    spec.x = x; spec.y = y; spec.z = z;
    spec.vx = 0; spec.vy = 1.2; spec.vz = 0;
    spec.spread = 2.2 * scale;
    spec.radius = 0.2 * scale;
    spec.color = 0xfff0b0;
    spec.colorEnd = color;
    spec.size = 0.5 * scale;
    spec.sizeEnd = 0.05;
    spec.life = rand(0.25, 0.5);
    spec.alpha = 0.95;
    spec.alphaEnd = 0;
    spec.gravity = 1.2;
    spec.drag = 2.4;
    spec.count = Math.max(2, Math.round(16 * scale * Math.max(0.4, this._q.rate)));
    this.fire.emit(spec);
    // chunky sparks on top
    spec.color = 0xffe9a0;
    spec.colorEnd = 0xff7b1a;
    spec.size = 0.18;
    spec.sizeEnd = 0.02;
    spec.life = rand(0.2, 0.45);
    spec.gravity = -6;
    spec.drag = 1.4;
    spec.spread = 3 * scale;
    spec.count = Math.max(1, Math.round(10 * scale * Math.max(0.4, this._q.rate)));
    this.spark.emit(spec);
  }

  /** @private */
  _streaks(x, y, z, dx, dz, color) {
    const spec = this._spec;
    spec.x = x + rand(-0.4, 0.4);
    spec.y = y + rand(-0.2, 0.4);
    spec.z = z + rand(-0.4, 0.4);
    spec.vx = dx * 12 + rand(-1, 1);
    spec.vy = rand(-0.4, 0.8);
    spec.vz = dz * 12 + rand(-1, 1);
    spec.spread = 0.8;
    spec.radius = 0.1;
    spec.color = color;
    spec.colorEnd = 0xffffff;
    spec.size = 0.42;
    spec.sizeEnd = 0.03;
    spec.life = rand(0.18, 0.36);
    spec.alpha = 0.9;
    spec.alphaEnd = 0;
    spec.gravity = 0;
    spec.drag = 0.6;
    spec.count = Math.max(1, Math.round(10 * Math.max(0.4, this._q.rate)));
    this.trail.emit(spec);
  }

  /** @private */
  _dustPuff(x, y, z, color, scale = 1) {
    const spec = this._spec;
    spec.x = x; spec.y = y; spec.z = z;
    spec.vx = rand(-0.6, 0.6); spec.vy = rand(0.6, 1.6); spec.vz = rand(-0.6, 0.6);
    spec.spread = 0.7 * scale;
    spec.radius = 0.4 * scale;
    spec.color = color;
    spec.colorEnd = color;
    spec.size = 0.35 * scale;
    spec.sizeEnd = 1.2 * scale;
    spec.life = rand(0.4, 0.75);
    spec.alpha = 0.5;
    spec.alphaEnd = 0;
    spec.gravity = -1.4;
    spec.drag = 2.6;
    spec.count = Math.max(1, Math.round(12 * scale * Math.max(0.4, this._q.rate)));
    this.dust.emit(spec);
  }

  /** @private */
  _smokePuff(x, y, z, color, scale = 1) {
    const spec = this._spec;
    spec.x = x; spec.y = y; spec.z = z;
    spec.vx = rand(-0.5, 0.5); spec.vy = rand(0.8, 1.8); spec.vz = rand(-0.5, 0.5);
    spec.spread = 0.6 * scale;
    spec.radius = 0.25 * scale;
    spec.color = color;
    spec.colorEnd = 0x6b6b6b;
    spec.size = 0.4 * scale;
    spec.sizeEnd = 1.4 * scale;
    spec.life = rand(0.5, 0.9);
    spec.alpha = 0.55;
    spec.alphaEnd = 0;
    spec.gravity = -0.6;
    spec.drag = 2.2;
    spec.count = Math.max(1, Math.round(10 * scale * Math.max(0.4, this._q.rate)));
    this.smoke.emit(spec);
  }

  /** @private */
  _smokeRing(x, y, z, scale = 1) {
    const spec = this._spec;
    const n = Math.max(4, Math.round(14 * scale * Math.max(0.4, this._q.rate)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      spec.x = x; spec.y = y; spec.z = z;
      spec.vx = Math.cos(a) * 2.4 * scale;
      spec.vy = rand(0.5, 1.4);
      spec.vz = Math.sin(a) * 2.4 * scale;
      spec.spread = 0.3;
      spec.radius = 0.2;
      spec.color = 0xe8e8e8;
      spec.colorEnd = 0x8f8f8f;
      spec.size = 0.4;
      spec.sizeEnd = 1.3;
      spec.life = rand(0.4, 0.75);
      spec.alpha = 0.6;
      spec.alphaEnd = 0;
      spec.gravity = -0.5;
      spec.drag = 2.2;
      spec.count = 1;
      this.smoke.emit(spec);
    }
  }

  /** @private */
  _landing(x, y, z, impact = 6) {
    const scale = clamp(impact / 10, 0.4, 1.8);
    this._dustPuff(x, y + 0.08, z, this.surfaceColor, 1.1 * scale);
    this._ring(x, y + 0.08, z, this.surfaceColor, 2.4 * scale, 0.42);
    if (impact > 8 && this._q.meshBudget >= 0.6) {
      const spec = this._spec;
      spec.x = x; spec.y = y + 0.2; spec.z = z;
      spec.vx = 0; spec.vy = rand(2, 4); spec.vz = 0;
      spec.spread = 2.4 * scale;
      spec.radius = 0.4;
      spec.color = this.surfaceColor;
      spec.life = rand(0.5, 1.0);
      spec.size = 0.14;
      spec.sizeEnd = 0.1;
      spec.gravity = -22;
      spec.drag = 0.3;
      spec.count = Math.max(2, Math.round(8 * Math.max(0.4, this._q.rate)));
      this.debris.emit(spec);
    }
  }

  /** @private */
  _impact(x, y, z, color) {
    this._sparkBurst(x, y, z, color, 20, 4.2);
    this._smokePuff(x, y, z, 0xd8d8d8, 0.8);
    if (this._q.meshBudget >= 0.6) {
      const spec = this._spec;
      spec.x = x; spec.y = y; spec.z = z;
      spec.vx = 0; spec.vy = rand(2.5, 4.5); spec.vz = 0;
      spec.spread = 3.2;
      spec.radius = 0.3;
      spec.color = 0x9a9a9a;
      spec.life = rand(0.5, 0.9);
      spec.size = 0.16;
      spec.sizeEnd = 0.1;
      spec.gravity = -24;
      spec.drag = 0.3;
      spec.count = Math.max(2, Math.round(9 * Math.max(0.4, this._q.rate)));
      this.debris.emit(spec);
    }
    this._useLight(color, 40, 0.25, x, y, z);
  }

  /** @private */
  _explosion(x, y, z, color, scale = 1) {
    const spec = this._spec;
    // fireball core (pooled mesh + additive particles)
    if (this._q.meshBudget >= 0.6) {
      this.ballPool.spawn({
        x, y, z, life: 0.34 * scale, size: 0.7 * scale, sizeEnd: 1.9 * scale,
        opacity: 0.95, opacityEnd: 0, color: 0xffb347, gravity: 2.5, drag: 2.2,
      });
      this.ballPool.spawn({
        x, y, z, life: 0.5 * scale, size: 0.5 * scale, sizeEnd: 2.6 * scale,
        opacity: 0.5, opacityEnd: 0, color,
      });
    }
    spec.x = x; spec.y = y; spec.z = z;
    spec.vx = 0; spec.vy = 2.5; spec.vz = 0;
    spec.spread = 6.5 * scale;
    spec.radius = 0.35 * scale;
    spec.color = 0xfff3c0;
    spec.colorEnd = color;
    spec.size = 0.6 * scale;
    spec.sizeEnd = 0.05;
    spec.life = rand(0.35, 0.7);
    spec.alpha = 1;
    spec.alphaEnd = 0;
    spec.gravity = 2.0;
    spec.drag = 2.6;
    spec.count = Math.max(4, Math.round(26 * scale * Math.max(0.4, this._q.rate)));
    this.fire.emit(spec);

    spec.color = 0x8f8f8f;
    spec.colorEnd = 0x4a4a4a;
    spec.size = 0.7 * scale;
    spec.sizeEnd = 2.6 * scale;
    spec.life = rand(0.6, 1.2);
    spec.gravity = 0.8;
    spec.drag = 1.6;
    spec.spread = 3.2 * scale;
    spec.alpha = 0.7;
    spec.count = Math.max(3, Math.round(14 * scale * Math.max(0.4, this._q.rate)));
    this.smoke.emit(spec);

    if (this._q.meshBudget >= 0.6) {
      spec.color = 0x6b6b6b;
      spec.size = 0.18;
      spec.sizeEnd = 0.12;
      spec.life = rand(0.6, 1.1);
      spec.gravity = -22;
      spec.drag = 0.4;
      spec.spread = 5 * scale;
      spec.count = Math.max(3, Math.round(14 * scale * Math.max(0.4, this._q.rate)));
      this.debris.emit(spec);
    }
    this._ring(x, y - 0.3, z, 0xffc06a, 4 * scale, 0.4);
    this._useLight(0xff9a3c, 90 * scale, 0.35, x, y + 0.3, z);
    fxState.flash = Math.max(fxState.flash, 0.12 * scale);
  }

  /** @private */
  _starBurst(x, y, z, scale = 1) {
    const spec = this._spec;
    for (let i = 0; i < 3; i++) {
      const hue = (this._time * 0.5 + i * 0.33) % 1;
      spec.x = x; spec.y = y; spec.z = z;
      spec.vx = 0; spec.vy = 2.2; spec.vz = 0;
      spec.spread = 3.6 * scale;
      spec.radius = 0.5 * scale;
      spec.color = this._hueColor(hue);
      spec.colorEnd = this._hueColor((hue + 0.5) % 1);
      spec.size = 0.34 * scale;
      spec.sizeEnd = 0.04;
      spec.life = rand(0.4, 0.8);
      spec.alpha = 1;
      spec.alphaEnd = 0;
      spec.gravity = -2;
      spec.drag = 1.6;
      spec.count = Math.max(3, Math.round(12 * scale * Math.max(0.4, this._q.rate)));
      this.spark.emit(spec);
    }
  }

  /** @private */
  _itemBox(x, y, z) {
    this._sparkBurst(x, y, z, 0xfff6be, 18, 3.2);
    this._ring(x, y - 0.5, z, 0xffe680, 1.8, 0.35);
    this.ghostPool.spawn({
      x, y, z, life: 0.9, size: 0.9, sizeEnd: 1.4,
      opacity: 1, opacityEnd: 0, vy: 1.1, color: 0xfff6be, rot: rand(-0.3, 0.3),
    });
  }

  /** @private */
  _confetti(x, y, z, scale = 1) {
    const spec = this._spec;
    const n = Math.max(4, Math.round(34 * scale * Math.max(0.4, this._q.rate)));
    for (let i = 0; i < n; i++) {
      spec.x = x + rand(-0.5, 0.5);
      spec.y = y;
      spec.z = z + rand(-0.5, 0.5);
      spec.vx = rand(-4, 4);
      spec.vy = rand(7, 13) * scale;
      spec.vz = rand(-4, 4);
      spec.spread = 1.4;
      spec.radius = 0.2;
      spec.color = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
      spec.life = rand(1.6, 2.8);
      spec.size = rand(0.1, 0.17) * scale;
      spec.sizeEnd = spec.size;
      spec.gravity = -11;
      spec.drag = 0.9;
      spec.spin = 14;
      spec.count = 1;
      this.confetti.emit(spec);
    }
    this._sparkBurst(x, y, z, 0xffffff, 10, 2.5);
  }

  /** @private */
  _firework(x, y, z, color = 0xffd070) {
    const spec = this._spec;
    const n = Math.max(8, Math.round(46 * Math.max(0.4, this._q.rate)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const b = Math.random() * Math.PI - Math.PI / 2;
      const speed = rand(6, 13);
      spec.x = x; spec.y = y; spec.z = z;
      spec.vx = Math.cos(a) * Math.cos(b) * speed;
      spec.vy = Math.sin(b) * speed + 2;
      spec.vz = Math.sin(a) * Math.cos(b) * speed;
      spec.spread = 0.6;
      spec.radius = 0.1;
      spec.color = color;
      spec.colorEnd = 0xffffff;
      spec.size = rand(0.28, 0.45);
      spec.sizeEnd = 0.03;
      spec.life = rand(0.7, 1.4);
      spec.alpha = 1;
      spec.alphaEnd = 0;
      spec.gravity = -6;
      spec.drag = 0.85;
      spec.count = 1;
      this.spark.emit(spec);
    }
    this._useLight(color, 60, 0.4, x, y, z);
    fxState.flash = Math.max(fxState.flash, 0.08);
  }

  /** @private */
  _lightning(x, y, z, color, radius) {
    fxState.flash = 1;
    const spec = this._spec;
    const spread = clamp(Number.isFinite(radius) ? radius : 16, 8, 60);
    // world bolt above the target
    const boltY = y + 16;
    if (this._q.meshBudget >= 0.6) {
      this.boltPool.spawn({
        x, y: boltY, z, life: 0.5, size: 1, sizeEnd: 1,
        scaleX: rand(4, 7), scaleY: rand(16, 26),
        opacity: 1, opacityEnd: 0, color, rot: rand(-0.15, 0.15),
      });
      this.boltPool.spawn({
        x: x + rand(-4, 4), y: boltY - 4, z: z + rand(-4, 4), life: 0.4,
        size: 1, sizeEnd: 1, scaleX: rand(2, 4), scaleY: rand(12, 20),
        opacity: 0.8, opacityEnd: 0, color, rot: rand(-0.2, 0.2),
      });
    }
    this._useLight(0xd7e4ff, 160, 0.5, x, y + 3, z);
    // rain of sparks
    const n = Math.max(10, Math.round(70 * Math.max(0.4, this._q.rate)));
    for (let i = 0; i < n; i++) {
      spec.x = x + rand(-spread, spread);
      spec.y = y + rand(10, 20);
      spec.z = z + rand(-spread, spread);
      spec.vx = rand(-1, 1);
      spec.vy = rand(-14, -7);
      spec.vz = rand(-1, 1);
      spec.spread = 0.4;
      spec.radius = 0.4;
      spec.color = 0xdfe9ff;
      spec.colorEnd = color;
      spec.size = rand(0.16, 0.3);
      spec.sizeEnd = 0.02;
      spec.life = rand(0.9, 1.7);
      spec.alpha = 0.95;
      spec.alphaEnd = 0;
      spec.gravity = -6;
      spec.drag = 0.2;
      spec.count = 1;
      this.spark.emit(spec);
    }
    this._shake(0.5, 0.5);
  }

  /** @private */
  _shellTrail(x, y, z, color) {
    const spec = this._spec;
    spec.x = x; spec.y = y; spec.z = z;
    spec.vx = 0; spec.vy = 0.4; spec.vz = 0;
    spec.spread = 0.5;
    spec.radius = 0.15;
    spec.color = color;
    spec.colorEnd = 0xffffff;
    spec.size = 0.36;
    spec.sizeEnd = 0.05;
    spec.life = rand(0.25, 0.45);
    spec.alpha = 0.9;
    spec.alphaEnd = 0;
    spec.gravity = 0;
    spec.drag = 2.4;
    spec.count = Math.max(2, Math.round(12 * Math.max(0.4, this._q.rate)));
    this.trail.emit(spec);
  }

  /** @private */
  _ring(x, y, z, color, size, life) {
    if (this._q.meshBudget < 0.4) return;
    this.ringPool.spawn({
      x, y, z, life, size: size * 0.5, sizeEnd: size, opacity: 0.85, opacityEnd: 0,
      color, spin: rand(-1.5, 1.5), rot: rand(0, Math.PI),
    });
  }

  // ------------------------------------------------------------- helpers ----
  /** @private */
  _hueColor(h) {
    // cheap HSV→RGB (s = 1, v = 1), returns a hex number (no allocation)
    const hh = ((h % 1) + 1) % 1;
    const i = Math.floor(hh * 6);
    const f = hh * 6 - i;
    const q = 1 - f;
    let r;
    let g;
    let b;
    switch (i % 6) {
      case 0: r = 1; g = f; b = 0; break;
      case 1: r = q; g = 1; b = 0; break;
      case 2: r = 0; g = 1; b = f; break;
      case 3: r = 0; g = q; b = 1; break;
      case 4: r = f; g = 0; b = 1; break;
      default: r = 1; g = 0; b = q; break;
    }
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  }

  /** @private */
  _kartPos(kart, out) {
    const local = kart?.object3D?.position;
    if (local && typeof local.x === 'number') {
      out.set(local.x, local.y, local.z);
      return out;
    }
    const world = kart?.position;
    if (world && typeof world.x === 'number') {
      out.set(world.x, world.y, world.z);
      return out;
    }
    return null;
  }

  /** @private */
  _kartYaw(kart) {
    const y = kart?.object3D?.rotation?.y;
    if (typeof y === 'number') return y;
    if (typeof kart?.yaw === 'number') return kart.yaw;
    return 0;
  }

  /** @private */
  _updateScreenScale() {
    let h = 720;
    if (typeof window !== 'undefined') {
      h = (window.innerHeight || 720) * (window.devicePixelRatio || 1);
    }
    const fov = ((this.camera?.fov ?? 60) * Math.PI) / 180;
    const scale = clamp((h * 0.5) / Math.max(0.2, Math.tan(fov * 0.5)), 120, 2600);
    for (const s of this._systems) s.setScreenScale(scale);
  }

  // -------------------------------------------------------------- lights ----
  /** @private */
  _ensureLights(count) {
    const THREE = this.THREE;
    while (this._lights.length < count) {
      const light = new THREE.PointLight(0xffffff, 0, 18, 2);
      light.visible = false;
      light.matrixAutoUpdate = true;
      this.scene.add(light);
      this._lights.push({ light, until: 0, duration: 1, peak: 0 });
    }
  }

  /** @private */
  _useLight(color, intensity, duration, x, y, z) {
    if (this._q.lights === 0) return;
    this._ensureLights(this._q.lights);
    let entry = null;
    for (const e of this._lights) {
      if (e.until <= this._time) { entry = e; break; }
    }
    if (!entry) {
      let best = Infinity;
      for (const e of this._lights) {
        const remaining = e.until - this._time;
        if (remaining < best) { best = remaining; entry = e; }
      }
    }
    if (!entry) return;
    entry.light.position.set(x, y, z);
    entry.light.color.set(color);
    entry.peak = intensity;
    entry.duration = Math.max(0.05, duration);
    entry.until = this._time + entry.duration;
    entry.light.visible = true;
    entry.light.intensity = intensity;
  }

  /** @private */
  _updateLights() {
    for (const e of this._lights) {
      if (e.until <= this._time) {
        if (e.light.intensity !== 0) {
          e.light.intensity = 0;
          e.light.visible = false;
        }
        continue;
      }
      const t = (e.until - this._time) / e.duration;
      e.light.intensity = e.peak * clamp(t, 0, 1);
    }
  }

  /** @private */
  _releaseLights(force = false) {
    if (!force && this._q.lights > 0) return;
    for (const e of this._lights) {
      e.until = 0;
      e.light.intensity = 0;
      e.light.visible = false;
    }
  }

  /** @private */
  _shake(amount, duration) {
    if (!this.bus?.emit) return;
    if (this.quality === 'low') return;
    this.bus.emit(EVENTS.CAMERA_SHAKE, { amount, duration });
  }
}

export default Effects;
