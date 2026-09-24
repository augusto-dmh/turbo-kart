/**
 * ============================================================================
 * TURBO KART — Kart (Agent 1)
 * ============================================================================
 * Arcade kart physics: stat-driven engine, lateral-grip model with a real
 * slip angle, hop + 3-stage mini-turbo drift, boosts, off-road/ice surfaces,
 * boost pads & ramps, ballistic air time, wall sliding, kart-vs-kart
 * collisions, slipstream, wrong-way detection and auto-respawn.
 *
 * Conventions (frozen):
 *  - local forward is +Z, `object3D.rotation.y = yaw`, forward = (sin yaw, 0, cos yaw)
 *  - `speed` is signed m/s, `position` is a live world Vector3
 *  - `steer > 0` = LEFT (matches "positive lateral = left of travel")
 *  - every cross-subsystem message goes through `bus.emit(EVENTS.*)`
 * ============================================================================
 */
import * as THREE from 'three';
import { createKartState, getCharacter, EVENTS, RACE } from '../contracts.js';
import { createKartMesh } from './kartFactory.js';
import {
  KART_TUNING as T, deriveKartTuning, boostMultiplier, stageForCharge, chargeProgress,
} from './kartPhysics.js';
import { clamp, damp, wrap01, wrapDelta, safe } from '../core/mathUtils.js';
import { rngFor } from '../core/rng.js';

/** Mini-turbo stage colours (blue / orange / purple) for FX consumers. */
export const DRIFT_STAGE_COLORS = [0x3fb6ff, 0xffa63d, 0xc46bff];

const ZERO_INPUT = { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false };
const TAU = Math.PI * 2;

// Scratch vectors (module scoped → the hot path allocates nothing).
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _mat = new THREE.Matrix4();

let NEXT_ID = 1;

export class Kart {
  /** Every live kart — used for kart-vs-kart collisions without main.js help. */
  static registry = [];

  constructor({
    THREE: T3, bus, trackApi, isPlayer = false, characterId = 'nova',
    startIndex = 0, difficulty = 'normal', quality = 'high',
  } = {}) {
    this.THREE = T3 || THREE;
    this.bus = bus || null;
    this.trackApi = trackApi || null;
    this.isPlayer = !!isPlayer;
    this.characterId = characterId;
    this.character = getCharacter(characterId);
    this.name = this.character.name;
    this.stats = { ...this.character.stats };
    this.startIndex = startIndex;
    this.difficulty = difficulty;
    this.id = NEXT_ID++;
    this.disposed = false;
    this.time = 0;

    // ---- derived tuning --------------------------------------------------
    const d = deriveKartTuning(this.stats);
    this.topSpeed = d.topSpeed;
    this.accel = d.accel;
    this.gripRate = d.gripRate;
    this.mass = d.mass;
    this.wheelRadius = 0.3;
    this.collisionRadius = T.collisionRadius;

    // ---- public state ----------------------------------------------------
    this.state = createKartState();
    this.lap = 1;
    this.progress = 0;
    this._finished = false;
    this._rng = rngFor(characterId, startIndex);
    this._phase = this._rng() * TAU;

    // ---- mesh ------------------------------------------------------------
    this._mesh = createKartMesh({
      THREE: this.THREE, characterId, isPlayer, quality, number: startIndex + 1,
    });
    this.object3D = this._mesh.group;
    this.object3D.name = `kart:${characterId}:${startIndex}`;

    // ---- placement -------------------------------------------------------
    const slot = trackApi?.startGrid?.[startIndex] || null;
    if (slot?.position) this.object3D.position.copy(slot.position);
    else this.object3D.position.set(0, 0, 0);
    this.yaw = safe(slot?.heading, 0);
    this._forwardVec = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.velocity = new THREE.Vector3();
    this.vy = 0;

    // ---- internals -------------------------------------------------------
    this.input = ZERO_INPUT;
    this.visual = {
      wheelAngle: 0, driftTilt: 0, airPitch: 0, hopTilt: 0, squash: 1,
      spinYaw: 0, boostGlow: 0, brakeLight: 0, bounce: 0,
    };
    this.boostTime = 0;
    this.boostPower = 0;
    this.spinTime = 0;
    this.spinDuration = 1;
    this.spinDir = 1;
    this.frozenTime = 0;
    this.invincibleTime = 0;
    this.squashTime = 0;
    this.squashDuration = 1;
    this.squashAmount = 0.3;
    this.airborne = false;
    this.airTime = 0;
    this._wheelAngle = 0;
    this._wheelspin = 0;
    this._drifting = false;
    this._driftHeld = false;
    this.driftDir = 1;
    this.driftChargeTime = 0;
    this._driftStage = -1;
    this._driftLowTimer = 0;
    this._onIceTimer = 0;
    this._draft = 0;
    this._steerIn = 0;
    this._brakeIn = 0;
    this._throttleIn = 0;
    this._prevThrottle = false;
    this._prevUseItem = false;
    this._onRoad = true;
    this._lateral = 0;
    this._groundY = this.object3D.position.y;
    this._wallContact = false;
    this._wrongWayTimer = 0;
    this._stuckTimer = 0;
    this._dustTimer = 0;
    this._sparkTimer = 0;
    this._wallTimer = 0;
    this._scale = 1;
    this._lastSpeed = 0;
    this._countdown = false;
    this._goIn = 0;
    this._raceStarted = false;
    this._rocketResolved = false;
    this._unsubs = [];

    // ---- track data ------------------------------------------------------
    this._gimmicks = [];
    const gim = trackApi?.gimmicks;
    if (Array.isArray(gim)) {
      for (let i = 0; i < gim.length; i++) {
        const g = gim[i];
        if (!g) continue;
        this._gimmicks.push({
          u: wrap01(safe(g.u, 0)),
          lanes: Array.isArray(g.lateral) ? g.lateral.slice() : [safe(g.lateral, 0)],
          width: Number.isFinite(g.width) ? g.width : (Number.isFinite(g.halfWidth) ? g.halfWidth * 2 : 0),
          kind: g.kind || 'boost',
        });
      }
    }
    const trackLen = Number.isFinite(trackApi?.length) ? trackApi.length : 800;
    this._gimUMargin = T.gimmickLengthMeters / Math.max(200, trackLen);
    this._gimInside = new Array(this._gimmicks.length).fill(false);
    this._gimCooldown = new Array(this._gimmicks.length).fill(0);

    // Snap onto the road surface at spawn.
    this._sampleTrack();
    this.object3D.position.y = this._groundY;
    this._applyOrientation();
    this.progress = wrap01(this.progress);

    Kart.registry.push(this);
    this._subscribe();
  }

  // =========================================================== accessors ==
  get position() { return this.object3D.position; }

  /** World-space unit forward (owned by the kart — do not mutate). */
  get forward() { return this._forwardVec; }

  get speed() { return this.state.speed; }

  get finished() { return this._finished; }
  set finished(v) { this._setFinished(!!v); }

  get drifting() { return this._drifting; }
  get onRoad() { return this._onRoad; }
  get draft() { return this._draft; }
  get lateral() { return this._lateral; }

  // ========================================================== public API ==
  /**
   * @param {number} dt
   * @param {import('../contracts.js').InputState} input
   */
  update(dt, input) {
    if (this.disposed) return this;
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.05) dt = 0.05; // main clamps, but be safe

    this.time += dt;
    this.input = input || ZERO_INPUT;
    const inp = this.input;
    const state = this.state;

    // ---------------------------------------------------------- timers ---
    this._tickTimers(dt);

    // ------------------------------------------------------ rocket start --
    this._rocketStart(dt, inp);

    // ------------------------------------------------------------- track --
    this._sampleTrack();

    const locked = this._countdown && !this._raceStarted;
    const frozen = this.frozenTime > 0;
    const spinning = this.spinTime > 0;

    this._steerIn = locked ? 0 : clamp(inp.steer || 0, -1, 1);
    this._brakeIn = locked ? 0 : clamp(inp.brake || 0, 0, 1);
    this._throttleIn = locked ? 0 : clamp(inp.throttle || 0, 0, 1);

    // ------------------------------------------------------ surface state --
    this._updateSurface(dt);
    this._updateGimmicks(dt);

    // ---------------------------------------------------------- vertical --
    this._stepVertical(dt);

    // ------------------------------------------------------------ driving --
    this._stepDrive(dt, frozen, spinning, locked);

    // ------------------------------------------------------- world updates -
    this._resolveBarriers(dt);
    this._resolveKarts(dt);
    this._updateWrongWay(dt);
    this._updateStuck(dt);

    // -------------------------------------------------------- presentation -
    this._applyOrientation();
    this._updateVisuals(dt);
    this._mesh?.update?.(dt, state, this);

    state.airborne = this.airborne;
    state.finished = this._finished;
    this._lastSpeed = state.speed;
    return this;
  }

  /**
   * @param {number} power 1 ≈ a mushroom
   * @param {number} duration seconds
   * @param {string} source 'drift' | 'pad' | 'rocket-start' | 'item' | …
   */
  applyBoost(power = 1, duration = 1.2, source = 'boost') {
    const p = clamp(power, 0, T.boostMaxPower);
    const d = Math.max(0.05, duration);
    this.boostTime = Math.max(this.boostTime, d);
    this.boostPower = Math.max(this.boostPower, p);
    this.state.boosting = true;
    this.state.boostTime = this.boostTime;
    this._emit(EVENTS.KART_BOOST, { kart: this, source, power: p });
    return this;
  }

  /** Add a world-space velocity impulse; `spinSeconds > 0` also spins the kart. */
  applyImpulse(vec, spinSeconds = 0) {
    if (vec) {
      this.velocity.add(vec);
      if (Number.isFinite(vec.y) && vec.y > 0.5) {
        this.vy += vec.y;
        this.airborne = true;
        this.airTime = 0;
      }
    }
    if (spinSeconds > 0) this.spinOut(spinSeconds);
    return this;
  }

  /** Knock the kart into a (visual) spin — heavy speed loss, no control. */
  spinOut(seconds = T.spinOutTime) {
    if (this.invincibleTime > 0) return this;
    const s = Math.max(0.25, seconds);
    this.spinTime = Math.max(this.spinTime, s);
    this.spinDuration = Math.max(this.spinDuration, s);
    this.spinDir = this._rng() < 0.5 ? -1 : 1;
    this.state.spinning = true;
    this._endDrift(false);
    this._emit(EVENTS.KART_SPIN, { kart: this });
    if (this.isPlayer) this._emit(EVENTS.CAMERA_SHAKE, { amount: 0.34, duration: 0.45 });
    return this;
  }

  /** Squash the kart (landing, item hit). `amount` = 0..0.6. */
  squash(seconds = 0.3, amount = 0.3) {
    const s = Math.max(0.05, seconds);
    this.squashTime = Math.max(this.squashTime, s);
    this.squashDuration = Math.max(this.squashDuration, s);
    this.squashAmount = clamp(amount, 0.05, 0.6);
    this.state.squashed = true;
    this._emit(EVENTS.KART_SQUASH, { kart: this });
    return this;
  }

  /** Lightning: no power, barely steerable. */
  setFrozen(seconds = 2.5) {
    this.frozenTime = Math.max(this.frozenTime, Math.max(0.2, seconds));
    this.state.frozen = true;
    this._endDrift(false);
    return this;
  }

  /** Star: immune to spins, slightly faster. */
  setInvincible(seconds = 6) {
    this.invincibleTime = Math.max(this.invincibleTime, Math.max(0.2, seconds));
    this.state.invincible = true;
    return this;
  }

  /** Uniform scale (shrink items, debugging). */
  setScale(s = 1) {
    this._scale = clamp(s, 0.2, 3);
    this.object3D.scale.setScalar(this._scale);
    this.collisionRadius = T.collisionRadius * this._scale;
    return this;
  }

  /** Hard teleport (grid placement, debugging). */
  resetTo(position, quaternion) {
    if (position) this.object3D.position.copy(position);
    if (quaternion) {
      _v1.set(0, 0, 1).applyQuaternion(quaternion);
      this.yaw = Math.atan2(_v1.x, _v1.z);
      this.object3D.quaternion.copy(quaternion);
    }
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.airborne = false;
    this.airTime = 0;
    this.spinTime = 0;
    this.state.spinning = false;
    this.state.speed = 0;
    this._endDrift(false);
    this._stuckTimer = 0;
    this._sampleTrack();
    return this;
  }

  /** Put the kart back on the racing line at its current progress. */
  respawn() {
    const api = this.trackApi;
    const p = this._proj || null;
    const u = wrap01(p ? p.u : this.progress);
    const speedBefore = Math.abs(this.state.speed);
    const pos = this.object3D.position;

    let placed = false;
    if (api && typeof api.pointAt === 'function') {
      let gp = null;
      try { gp = api.pointAt(u, 0); } catch { gp = null; }
      if (gp && Number.isFinite(gp.x)) {
        pos.set(gp.x, gp.y + 0.15, gp.z);
        placed = true;
      }
    }
    if (!placed) pos.y = this._groundY + 0.15;

    if (api && typeof api.tangentAt === 'function') {
      let t = null;
      try { t = api.tangentAt(u); } catch { t = null; }
      if (t && Number.isFinite(t.x)) this.yaw = Math.atan2(t.x, t.z);
    }

    const half = clamp(speedBefore * T.respawnSpeedFactor, 0, this.topSpeed);
    this.velocity.set(Math.sin(this.yaw) * half, 0, Math.cos(this.yaw) * half);
    this.vy = 0;
    this.airborne = false;
    this.airTime = 0;
    this.spinTime = 0;
    this.state.spinning = false;
    this.state.speed = half;
    this._endDrift(false);
    this._stuckTimer = 0;
    this._wallContact = false;
    this.setInvincible(T.respawnInvincible);
    this._sampleTrack();
    this.object3D.position.y = this._groundY;
    this._applyOrientation();
    this._emit(EVENTS.FX_SPAWN, { kind: 'respawn', position: pos, opts: {} });
    return this;
  }

  /** Convenience used by item code: apply damage + feedback in one call. */
  hit({ source = 'unknown', kind = 'item', from = null, power = 1 } = {}) {
    this._emit(EVENTS.KART_HIT, { kart: this, source, kind, from });
    if (this.invincibleTime > 0) return this;
    this.spinOut(T.spinOutTime * clamp(power, 0.5, 1.6));
    if (this.isPlayer) this._emit(EVENTS.CAMERA_SHAKE, { amount: 0.4 * power, duration: 0.45 });
    return this;
  }

  /** Swap mesh detail tier (listens to UI_SETTINGS by default). */
  setQuality(q) {
    this._mesh?.setQuality?.(q);
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this._unsubs) u?.();
    this._unsubs.length = 0;
    const i = Kart.registry.indexOf(this);
    if (i >= 0) Kart.registry.splice(i, 1);
    this._mesh?.dispose?.();
    if (this.object3D?.parent) this.object3D.parent.remove(this.object3D);
    this.input = ZERO_INPUT;
    return undefined;
  }

  // ============================================================= internals ==
  _emit(name, payload) {
    this.bus?.emit?.(name, payload);
  }

  _setFinished(v) {
    if (v === this._finished) return;
    this._finished = v;
    this.state.finished = v;
    if (v) this._emit(EVENTS.KART_FINISHED, { kart: this });
  }

  _subscribe() {
    const bus = this.bus;
    if (!bus?.on) return;
    this._unsubs.push(bus.on(EVENTS.RACE_COUNTDOWN, (payload) => {
      const value = Number(payload?.value) || 0;
      if (value > 0) {
        this._countdown = true;
        this._raceStarted = false;
        this._rocketResolved = false;
        this._goIn = value;
      } else {
        this._goIn = 0;
        this._countdown = false;
      }
    }));
    this._unsubs.push(bus.on(EVENTS.RACE_START, () => {
      this._countdown = false;
      this._raceStarted = true;
      this._goIn = 0;
    }));
    this._unsubs.push(bus.on(EVENTS.UI_SETTINGS, (s) => {
      if (s?.quality) this.setQuality(s.quality);
    }));
  }

  _tickTimers(dt) {
    const state = this.state;
    if (this.boostTime > 0) {
      this.boostTime = Math.max(0, this.boostTime - dt);
      if (this.boostTime === 0) this.boostPower = 0;
    }
    state.boostTime = this.boostTime;
    state.boosting = this.boostTime > 0;

    if (this.spinTime > 0) {
      this.spinTime = Math.max(0, this.spinTime - dt);
      if (this.spinTime === 0) {
        this.state.spinning = false;
        this.visual.spinYaw = 0;
      }
    }
    if (this.frozenTime > 0) {
      this.frozenTime = Math.max(0, this.frozenTime - dt);
      if (this.frozenTime === 0) this.state.frozen = false;
    }
    if (this.invincibleTime > 0) {
      this.invincibleTime = Math.max(0, this.invincibleTime - dt);
      if (this.invincibleTime === 0) this.state.invincible = false;
    }
    if (this.squashTime > 0) {
      this.squashTime = Math.max(0, this.squashTime - dt);
      if (this.squashTime === 0) this.state.squashed = false;
    }
    if (this._wheelspin > 0) this._wheelspin = Math.max(0, this._wheelspin - dt);
    if (this._onIceTimer > 0) this._onIceTimer = Math.max(0, this._onIceTimer - dt);
  }

  _rocketStart(dt, inp) {
    if (this._countdown) this._goIn = Math.max(0, this._goIn - dt);
    const throttle = (inp.throttle || 0) > 0.5;
    const edge = throttle && !this._prevThrottle;
    this._prevThrottle = throttle;
    if (!edge || this._rocketResolved) return;

    if (this._countdown && !this._raceStarted) {
      this._rocketResolved = true;
      const window = RACE.ROCKET_START_WINDOW + 0.08;
      if (this._goIn <= window) {
        const accuracy = clamp(1 - this._goIn / window, 0, 1);
        const power = 0.95 + accuracy * 0.55;
        this.applyBoost(power, 1.5, 'rocket-start');
        this._emit(EVENTS.KART_ROCKET_START, { kart: this, power });
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'rocket-start', position: this.object3D.position, opts: { power },
        });
        if (this.isPlayer) this._emit(EVENTS.CAMERA_SHAKE, { amount: 0.16, duration: 0.3 });
      } else {
        // Way too eager: wheelspin, no drive for a moment.
        this._wheelspin = 0.9;
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'wheelspin', position: this.object3D.position, opts: {},
        });
      }
    }
  }

  /** Project onto the track and refresh cached surface data. */
  _sampleTrack() {
    const api = this.trackApi;
    const pos = this.object3D.position;
    let u = this.progress;
    let lateral = this._lateral;
    let onRoad = this._onRoad;
    let proj = null;

    if (api && typeof api.project === 'function') {
      try {
        proj = api.project(pos);
      } catch {
        proj = null; // a broken track API must never stall the kart
      }
      if (proj) {
        u = safe(proj.u, u);
        lateral = safe(proj.lateral, lateral);
        if (proj.onRoad !== undefined) onRoad = !!proj.onRoad;
        else if (typeof api.isOffRoad === 'function') onRoad = !api.isOffRoad(pos);
      }
    } else if (api && typeof api.isOffRoad === 'function') {
      onRoad = !api.isOffRoad(pos);
    }

    this._proj = proj;
    this.progress = wrap01(u);
    this._lateral = lateral;
    this._onRoad = onRoad;
    this._tangent = proj?.tangent || null;

    // Surface normal (banking) — fall back to the projection's up, then world up.
    let n = null;
    if (typeof api?.surfaceNormal === 'function') {
      try { n = api.surfaceNormal(this.progress, lateral); } catch { n = null; }
    }
    if (n && Number.isFinite(n.y)) {
      _up.copy(n);
      if (_up.lengthSq() > 1e-6) _up.normalize(); else _up.set(0, 1, 0);
    } else if (proj?.up && Number.isFinite(proj.up.y)) {
      _up.copy(proj.up);
      if (_up.lengthSq() > 1e-6) _up.normalize(); else _up.set(0, 1, 0);
    } else {
      _up.set(0, 1, 0);
    }
    this._upVec = _up;

    // Ground height under the kart.
    if (typeof api?.pointAt === 'function') {
      let gp = null;
      try { gp = api.pointAt(this.progress, lateral); } catch { gp = null; }
      if (gp && Number.isFinite(gp.y)) this._groundY = gp.y;
    } else {
      this._groundY = pos.y;
    }
  }

  _updateSurface(dt) {
    const state = this.state;
    const onRoad = this._onRoad;
    const offRoad = !onRoad;
    if (offRoad !== state.offRoad) {
      state.offRoad = offRoad;
      this._emit(EVENTS.KART_OFFROAD, { kart: this, onRoad });
      if (!onRoad) {
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'dust', position: this.object3D.position, opts: { scale: 1 },
        });
      }
    }
    // Off-road dust while driving.
    if (!onRoad && Math.abs(state.speed) > 6) {
      this._dustTimer = (this._dustTimer || 0) + dt;
      if (this._dustTimer > 0.09) {
        this._dustTimer = 0;
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'dust', position: this.object3D.position, opts: { scale: 0.8 },
        });
      }
    }
  }

  _updateGimmicks(dt) {
    const list = this._gimmicks;
    if (!list.length) return;
    const u = this.progress;
    const lateral = this._lateral;
    const speed = Math.abs(this.state.speed);

    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (this._gimCooldown[i] > 0) this._gimCooldown[i] -= dt;
      const near = Math.abs(wrapDelta(u, g.u)) < this._gimUMargin;
      let inLane = false;
      if (near) {
        const margin = g.width > 0 ? g.width * 0.5 : T.gimmickLateralMargin;
        for (let l = 0; l < g.lanes.length; l++) {
          if (Math.abs(lateral - g.lanes[l]) < margin) { inLane = true; break; }
        }
      }
      const inside = near && inLane;
      const was = this._gimInside[i];
      this._gimInside[i] = inside;

      if (g.kind === 'ice' && inside) this._onIceTimer = 0.25;
      if (!inside || was || this._gimCooldown[i] > 0) continue;
      this._gimCooldown[i] = T.gimmickCooldown;

      if (g.kind === 'boost') {
        this.applyBoost(T.padBoostPower, T.padBoostTime, 'pad');
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'boost-pad', position: this.object3D.position, opts: { color: this.character.accent },
        });
      } else if (g.kind === 'ramp') {
        this.vy = T.rampLaunchBase + Math.min(speed, this.topSpeed) * T.rampLaunchPerSpeed;
        this.airborne = true;
        this.airTime = 0;
        this.visual.hopTilt = -0.14;
        this._emit(EVENTS.KART_HOP, { kart: this });
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'ramp', position: this.object3D.position, opts: { power: this.vy },
        });
      }
    }
  }

  _stepVertical(dt) {
    const pos = this.object3D.position;
    const ground = this._groundY;
    if (this.airborne) {
      this.airTime += dt;
      if (this.vy <= 0 && pos.y <= ground) this._land(Math.abs(this.vy));
    } else {
      const dy = ground - pos.y;
      if (dy < -0.5) {
        // Drove off a ledge: free fall.
        this.airborne = true;
        this.vy = 0;
        this.airTime = 0;
      } else {
        pos.y = ground;
        this.vy = 0;
      }
    }
  }

  /** Ballistic landing: squash, dust, camera shake, heavy-impact speed loss. */
  _land(impact) {
    const pos = this.object3D.position;
    pos.y = this._groundY;
    this.vy = 0;
    this.airborne = false;
    this.airTime = 0;
    this.visual.hopTilt = 0;
    this._emit(EVENTS.KART_LAND, { kart: this, impact });
    if (impact <= 3) return;
    this.squash(T.landingSquashTime, clamp(impact / 24, 0.12, 0.45));
    this._emit(EVENTS.FX_SPAWN, {
      kind: 'dust', position: pos, opts: { scale: clamp(impact / 9, 0.6, 2.2), landing: true },
    });
    if (impact > T.landingHardImpact) {
      const loss = clamp(1 - (impact - T.landingHardImpact) * 0.012, 0.78, 1);
      this.velocity.multiplyScalar(loss);
      if (this.isPlayer) {
        this._emit(EVENTS.CAMERA_SHAKE, {
          amount: clamp(impact * 0.022, 0.08, 0.4), duration: 0.4,
        });
      }
    }
  }

  _stepDrive(dt, frozen, spinning, locked) {
    const state = this.state;
    const pos = this.object3D.position;
    const up = this._upVec;

    // ---- basis -----------------------------------------------------------
    const grounded = !this.airborne;
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (grounded) {
      _fwd.addScaledVector(up, -_fwd.dot(up));
      if (_fwd.lengthSq() < 1e-5) _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    }
    _fwd.normalize();
    _left.crossVectors(up, _fwd);
    if (_left.lengthSq() < 1e-5) _left.set(1, 0, 0);
    _left.normalize();

    // ---- velocity decomposition -----------------------------------------
    let vFwd = this.velocity.dot(_fwd);
    let vLeft = this.velocity.dot(_left);
    const planar = Math.hypot(vFwd, vLeft);

    // ---- drift state machine --------------------------------------------
    const wantDrift = !locked && !!this.input.drift;
    const canDrift = !frozen && !spinning && planar > T.driftMinSpeed * 0.9;
    if (wantDrift && !this._driftHeld) {
      this._driftHeld = true;
      if (grounded && planar > T.hopMinSpeed) {
        this.vy = T.hopSpeed;
        this.airborne = true;
        this.airTime = 0;
        this.visual.hopTilt = -0.12;
        this._emit(EVENTS.KART_HOP, { kart: this });
      }
    } else if (!wantDrift) {
      this._driftHeld = false;
    }
    if (!this._drifting && this._driftHeld && canDrift && Math.abs(this._steerIn) > T.driftSteerStart) {
      this._drifting = true;
      this.driftDir = this._steerIn >= 0 ? 1 : -1;
      this.driftChargeTime = 0;
      this._driftStage = -1;
      this._driftLowTimer = 0;
      this._emit(EVENTS.KART_DRIFT_START, { kart: this });
    }
    if (this._drifting) {
      if (!wantDrift) this._endDrift(true);
      else if (spinning || frozen) this._endDrift(false);
      else if (!this.airborne && planar < T.driftMinSpeed * 0.55) {
        this._driftLowTimer += dt;
        if (this._driftLowTimer > 0.3) this._endDrift(true);
      } else {
        this._driftLowTimer = 0;
      }
    }

    // ---- drift charge ----------------------------------------------------
    if (this._drifting) {
      state.drifting = true;
      if (grounded && planar > T.driftMinSpeed && this._steerIn * this.driftDir > T.driftSteerCharge) {
        const rate = 1 + T.driftChargeSpeedBonus * clamp(planar / this.topSpeed, 0, 1);
        this.driftChargeTime += dt * rate;
        const stage = stageForCharge(this.driftChargeTime);
        if (stage > this._driftStage) {
          this._driftStage = stage;
          this._emit(EVENTS.KART_DRIFT_CHARGE, { kart: this, level: stage });
          this._emit(EVENTS.FX_SPAWN, {
            kind: 'drift-charge',
            position: pos,
            opts: { level: stage, color: DRIFT_STAGE_COLORS[stage] || DRIFT_STAGE_COLORS[0] },
          });
        }
      }
      state.driftCharge = clamp(chargeProgress(this.driftChargeTime), 0, 1);
      state.driftLevel = Math.max(0, this._driftStage);
      state.driftReady = this._driftStage >= 0;
      if (planar > 4) {
        this._sparkTimer = (this._sparkTimer || 0) + dt;
        const interval = this._driftStage >= 1 ? 0.07 : 0.13;
        if (this._sparkTimer > interval) {
          this._sparkTimer = 0;
          this._emit(EVENTS.FX_SPAWN, {
            kind: 'drift-spark',
            position: pos,
            opts: { level: Math.max(0, this._driftStage), color: DRIFT_STAGE_COLORS[Math.max(0, this._driftStage)] },
          });
        }
      }
    } else {
      state.drifting = false;
      state.driftCharge = 0;
      state.driftLevel = 0;
      state.driftReady = false;
    }

    // ---- steering --------------------------------------------------------
    const absF = planar;
    let authority = clamp(absF / T.lowSpeedTurn, 0, 1) *
      (1 - T.highSpeedTurnDrop * clamp(absF / this.topSpeed, 0, 1));
    if (this.airborne) authority *= T.airSteerScale;
    if (frozen) authority *= T.frozenSteerScale;
    if (spinning) authority = 0;

    let yawRate;
    if (this._drifting) {
      const into = clamp(this._steerIn * this.driftDir, -1, 1);
      const turn = T.driftTurnRate *
        (1 + T.driftTurnGain * Math.max(0, into) - T.driftTurnLoosen * Math.max(0, -into));
      yawRate = this.driftDir * turn;
    } else {
      yawRate = this._steerIn * T.maxYawRate;
    }
    yawRate *= authority;
    if (vFwd < -0.5) yawRate = -yawRate;
    this.yaw += yawRate * dt;

    // ---- longitudinal ----------------------------------------------------
    const boostMult = state.boosting ? boostMultiplier(this.boostPower) : 1;
    const draftMult = this._draft > 0 ? 1 + (T.draftTopSpeedMult - 1) * this._draft : 1;
    let targetSpeed = this.topSpeed * boostMult * draftMult;
    if (!this._onRoad) targetSpeed *= T.offroadTopSpeedScale;
    if (frozen) targetSpeed = Math.min(targetSpeed, T.frozenMaxSpeed);
    if (state.invincible) targetSpeed *= T.invincibleSpeedMult;

    let aFwd = 0;
    const throttle = this._throttleIn;
    if (this._wheelspin > 0) {
      aFwd = 0; // rocket-start penalty
    } else if (throttle > 0 && !spinning) {
      const ratio = clamp(vFwd / Math.max(1, targetSpeed), 0, 1);
      aFwd += this.accel * throttle * (1 - T.accelFalloff * ratio);
    }
    if (this._brakeIn > 0 && !spinning) {
      if (vFwd > 0.4) aFwd -= T.brakeDecel * this._brakeIn;
      else if (frozen) aFwd = 0;
      else aFwd -= T.reverseAccel * this._brakeIn;
    }
    if (state.boosting) aFwd += T.boostAccel * this.boostPower;
    if (spinning) aFwd -= T.brakeDecel * 0.55;
    if (this._draft > 0) aFwd += T.draftAccel * this._draft;

    // drag + rolling resistance (opposes motion on both signs)
    let roll = T.rollResist;
    if (!this._onRoad) roll += T.offroadExtraRoll;
    aFwd -= T.drag * vFwd * Math.abs(vFwd) + roll * vFwd;
    // gravity along the slope
    aFwd -= T.gravity * _fwd.y * T.slopeFactor;

    vFwd += aFwd * dt;
    if (vFwd > targetSpeed) {
      vFwd -= (vFwd - targetSpeed) * Math.min(1, dt * T.overspeedEase);
    }
    if (vFwd < -T.reverseMax) vFwd = -T.reverseMax;

    // ---- lateral grip ----------------------------------------------------
    // Arcade model: momentum is *rotated* toward the heading at `grip` 1/s
    // instead of being deleted, so corners and drifts keep their speed and
    // the slip angle stays bounded (slip ≈ yawRate / grip).
    let grip = this.gripRate;
    if (!this._onRoad) grip *= T.offroadGripScale;
    if (this._onIceTimer > 0) grip *= T.iceGripScale;
    if (this._drifting) grip *= T.driftGripScale;
    if (this.airborne) grip *= T.airGripScale;
    if (frozen) grip *= 0.6;
    if (spinning) grip *= 0.5;
    if (grip < T.minGrip) grip = T.minGrip;

    const total = Math.hypot(vFwd, vLeft);
    if (total > 0.05) {
      const sgn = vFwd < 0 ? -1 : 1;
      const slip = Math.atan2(vLeft, Math.abs(vFwd));
      const newSlip = slip * Math.exp(-grip * dt);
      // tyres scrub a little speed while sliding
      const mag = total * (1 - Math.min(0.6, Math.abs(newSlip) * T.slipScrub) * dt);
      vFwd = sgn * Math.cos(newSlip) * mag;
      vLeft = Math.sin(newSlip) * mag;
    }
    if (this._drifting && grounded) vLeft -= this.driftDir * T.driftOutward * dt;

    // ---- write back ------------------------------------------------------
    this.velocity.copy(_fwd).multiplyScalar(vFwd).addScaledVector(_left, vLeft);
    if (this.airborne) this.velocity.y = this.vy;
    else this.vy = 0;

    // ---- integrate -------------------------------------------------------
    pos.x += this.velocity.x * dt;
    pos.z += this.velocity.z * dt;
    if (this.airborne) {
      this.vy -= T.gravity * dt;
      pos.y += this.vy * dt;
      if (this.vy <= 0 && pos.y <= this._groundY) this._land(Math.abs(this.vy));
    }

    // ---- presentation state ---------------------------------------------
    const planarOut = Math.hypot(vFwd, vLeft);
    state.speed = vFwd >= 0 ? planarOut : -planarOut;
    state.frozen = frozen;
    state.spinning = spinning;
    state.invincible = this.invincibleTime > 0;
    this._yawRate = yawRate;
    this._vFwd = vFwd;
    this._vLeft = vLeft;
  }

  _endDrift(giveBoost) {
    if (!this._drifting) return;
    const stage = this._driftStage;
    this._drifting = false;
    this.driftChargeTime = 0;
    this._driftStage = -1;
    this._driftLowTimer = 0;
    this.state.drifting = false;
    this.state.driftCharge = 0;
    this.state.driftLevel = 0;
    this.state.driftReady = false;

    if (!giveBoost || stage < 0) return;
    const power = T.stageBoostPower[stage] ?? T.stageBoostPower[0];
    const duration = T.stageBoostTime[stage] ?? T.stageBoostTime[0];
    this.applyBoost(power, duration, 'drift');
    this._emit(EVENTS.KART_DRIFT_BOOST, { kart: this, level: stage });
    this._emit(EVENTS.FX_SPAWN, {
      kind: 'drift-boost',
      position: this.object3D.position,
      opts: { level: stage, color: DRIFT_STAGE_COLORS[stage] },
    });
    if (this.isPlayer) {
      this._emit(EVENTS.CAMERA_SHAKE, { amount: 0.1 + stage * 0.07, duration: 0.3 });
    }
  }

  /**
   * Soft guardrails. Uses real wall data if the track provides it
   * (`wallHalfWidth` / `wallSoftLimit` / `wallHardLimit`), otherwise a margin
   * outside the road so karts cannot leave the world.
   */
  _resolveBarriers(dt) {
    const api = this.trackApi;
    if (!api) return;
    const halfWidth = Number.isFinite(api.halfWidth) ? api.halfWidth : 8;
    const soft = Number.isFinite(api.wallSoftLimit) ? api.wallSoftLimit : halfWidth + T.wallSoftMargin;
    const hard = Number.isFinite(api.wallHardLimit) ? api.wallHardLimit
      : (Number.isFinite(api.wallHalfWidth) ? api.wallHalfWidth : halfWidth + T.wallHardMargin);
    const lat = this._lateral;
    const abs = Math.abs(lat);
    this._wallContact = abs > soft;
    if (!this._wallContact) return;
    if (typeof api.pointAt !== 'function') return;

    const over = abs - soft;
    const side = lat >= 0 ? 1 : -1;
    // World direction of increasing lateral (only needed when we hit something).
    let a = null;
    let b = null;
    try {
      a = api.pointAt(this.progress, lat);
      b = api.pointAt(this.progress, lat + 0.25);
    } catch {
      return;
    }
    if (!a || !b) return;
    _v4.subVectors(b, a);
    _v4.y = 0;
    if (_v4.lengthSq() < 1e-8) return;
    _v4.normalize();

    const speed = Math.abs(this.state.speed);
    const vOut = this.velocity.dot(_v4) * side;
    // Rate-based damping so glancing hits slide and square hits stop.
    if (vOut > 0) this.velocity.addScaledVector(_v4, -side * vOut * Math.min(1, T.wallDamp * dt));
    const push = T.wallPush * clamp(over / 3, 0.1, 1);
    this.velocity.addScaledVector(_v4, -side * push * dt);

    // Scrape feedback + hard limit.
    if (over > 0.4 && speed > T.wallSparkSpeed) {
      this._wallTimer = (this._wallTimer || 0) + dt;
      if (this._wallTimer > 0.12) {
        this._wallTimer = 0;
        this._emit(EVENTS.FX_SPAWN, {
          kind: 'spark', position: this.object3D.position, opts: { scale: 1 },
        });
      }
      this.velocity.multiplyScalar(clamp(1 - T.wallSpeedLoss * dt * 3, 0.8, 1));
    }
    if (abs > hard) {
      const fix = (abs - hard) * side;
      this.object3D.position.addScaledVector(_v4, -fix);
      this._lateral = lat - fix;
    }
  }

  /** Kart-vs-kart collisions + slipstream (each pair is handled once). */
  _resolveKarts(dt) {
    const reg = Kart.registry;
    const n = reg.length;
    this._draft = 0;
    if (n < 2) return;
    const pos = this.object3D.position;

    for (let i = 0; i < n; i++) {
      const other = reg[i];
      if (!other || other === this || other.disposed) continue;
      const dx = other.position.x - pos.x;
      const dz = other.position.z - pos.z;
      const dy = other.position.y - pos.y;
      const d2 = dx * dx + dz * dz;

      // ---- slipstream (read-only, any pair order) ----------------------
      if (d2 > 4 && d2 < T.draftRange * T.draftRange && Math.abs(dy) < 3) {
        const d = Math.sqrt(d2);
        const fx = Math.sin(this.yaw);
        const fz = Math.cos(this.yaw);
        const cos = (dx * fx + dz * fz) / d;
        if (cos > T.draftCone) {
          const strength = 1 - d / T.draftRange;
          if (strength > this._draft) this._draft = strength;
        }
      }

      if (other.id < this.id) continue; // each pair resolved once
      const r = this.collisionRadius + other.collisionRadius;
      if (d2 >= r * r || d2 < 1e-8 || Math.abs(dy) > 1.4) continue;

      const d = Math.sqrt(d2);
      // n points from `this` toward `other`.
      const nx = dx / d;
      const nz = dz / d;
      const overlap = r - d;
      const wThis = 1 / this.mass;
      const wOther = 1 / other.mass;
      const wSum = wThis + wOther || 1;

      // positional separation (mass weighted)
      pos.x -= nx * overlap * (wThis / wSum);
      pos.z -= nz * overlap * (wThis / wSum);
      other.position.x += nx * overlap * (wOther / wSum);
      other.position.z += nz * overlap * (wOther / wSum);

      // normal impulse — `vApproach > 0` means we are closing on the other kart
      const relx = this.velocity.x - other.velocity.x;
      const relz = this.velocity.z - other.velocity.z;
      const vApproach = relx * nx + relz * nz;
      if (vApproach <= 0) continue;

      const j = ((1 + T.collisionRestitution) * vApproach) / wSum;
      this.velocity.x -= nx * j * wThis;
      this.velocity.z -= nz * j * wThis;
      other.velocity.x += nx * j * wOther;
      other.velocity.z += nz * j * wOther;

      // scrub a little speed on both
      this.velocity.multiplyScalar(1 - T.collisionSpeedLoss);
      other.velocity.multiplyScalar(1 - T.collisionSpeedLoss);

      const impact = vApproach;
      if (impact > T.hardHitImpact) {
        // who rammed whom: the kart closing fastest is the hitter
        const thisApproach = this.velocity.x * nx + this.velocity.z * nz;
        const otherApproach = -(other.velocity.x * nx + other.velocity.z * nz);
        let victim = thisApproach > otherApproach ? other : this;
        let hitter = victim === this ? other : this;
        // A star (invincible) kart never loses the exchange.
        if (victim.invincibleTime > 0 && hitter.invincibleTime <= 0) {
          const tmp = victim; victim = hitter; hitter = tmp;
        }
        const power = clamp(impact / 12, 0.6, 1.7);
        victim.hit({ source: hitter.isPlayer ? 'player' : 'kart', kind: 'kart', from: hitter, power });
        hitter._emit(EVENTS.KART_HIT, { kart: hitter, source: 'kart', kind: 'bump', from: victim });
        hitter.squash(0.2, 0.14);
        if (this.isPlayer || other.isPlayer) {
          this._emit(EVENTS.CAMERA_SHAKE, { amount: clamp(impact * 0.03, 0.1, 0.5), duration: 0.4 });
        }
        this._emit(EVENTS.FX_SPAWN, { kind: 'spark', position: pos, opts: { scale: power } });
      }
    }
  }

  _updateWrongWay(dt) {
    const api = this.trackApi;
    let t = this._tangent;
    if (!t && typeof api?.tangentAt === 'function') t = api.tangentAt(this.progress);
    let wrong = false;
    if (t && Number.isFinite(t.x)) {
      const dot = Math.sin(this.yaw) * t.x + Math.cos(this.yaw) * t.z;
      wrong = dot < T.wrongWayDot && Math.abs(this.state.speed) > 4;
    }
    if (wrong) this._wrongWayTimer += dt;
    else this._wrongWayTimer = 0;
    const flag = this._wrongWayTimer > T.wrongWayDelay;
    if (flag !== this.state.wrongWay) {
      this.state.wrongWay = flag;
      this._emit(EVENTS.KART_WRONG_WAY, { kart: this, wrongWay: flag });
    }
  }

  _updateStuck(dt) {
    const speed = Math.abs(this.state.speed);
    const bad = this._wallContact || this.state.offRoad || this.state.wrongWay;
    if (bad && speed < T.stuckSpeed) this._stuckTimer += dt;
    else this._stuckTimer = 0;

    const y = this.object3D.position.y;
    const lost = !Number.isFinite(y) || y < this._groundY - 60 || y < -120;
    const reset = this.input?.resetRequested === true;
    if (this._stuckTimer > T.stuckTime || lost || reset) this.respawn();
  }

  _applyOrientation() {
    const up = this._upVec || _up.set(0, 1, 0);
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (!this.airborne) {
      _fwd.addScaledVector(up, -_fwd.dot(up));
      if (_fwd.lengthSq() < 1e-5) _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    }
    _fwd.normalize();
    _left.crossVectors(up, _fwd);
    if (_left.lengthSq() < 1e-5) _left.set(1, 0, 0);
    _left.normalize();
    const up2 = _v1.crossVectors(_fwd, _left);
    if (up2.lengthSq() < 1e-5) up2.copy(up);
    up2.normalize();

    _mat.makeBasis(_left, up2, _fwd);
    this.object3D.quaternion.setFromRotationMatrix(_mat);
    this._forwardVec.copy(_fwd);
  }

  _updateVisuals(dt) {
    const state = this.state;
    const vis = this.visual;
    const vFwd = this._vFwd || 0;
    const speed = Math.abs(vFwd);
    const yawRate = this._yawRate || 0;

    // steering wheel visuals
    const steerTarget = clamp(this._steerIn, -1, 1);
    state.steerVisual = damp(state.steerVisual, steerTarget, 15, dt);

    // body roll: outward (positive lean = rolling right)
    const latAcc = yawRate * vFwd;
    const driftLean = this._drifting ? this.driftDir * 0.05 : 0;
    const leanTarget = clamp(latAcc * 0.0085 + driftLean, -0.45, 0.45);
    state.lean = damp(state.lean, leanTarget, 7, dt);

    // wheels
    this._wheelAngle += (vFwd / this.wheelRadius) * dt;
    if (this._wheelspin > 0) this._wheelAngle += 42 * dt;
    state.wheelSpin = wrap01(this._wheelAngle / TAU);
    vis.wheelAngle = this._wheelAngle;

    // squash curve
    if (this.squashTime > 0) {
      const p = 1 - this.squashTime / Math.max(0.001, this.squashDuration);
      vis.squash = 1 - this.squashAmount * Math.sin(Math.PI * clamp(p, 0, 1));
    } else if (vis.squash !== 1) {
      vis.squash = 1;
    }

    // air pitch (nose up while rising)
    const airTarget = this.airborne
      ? clamp(-Math.atan2(this.vy, Math.max(5, speed)) * T.airPitchGain, -0.5, 0.5)
      : 0;
    vis.airPitch = damp(vis.airPitch, airTarget, 8, dt);
    vis.hopTilt = damp(vis.hopTilt, 0, 9, dt);

    // drift tilt (adds a little extra roll into the slide)
    vis.driftTilt = damp(vis.driftTilt, this._drifting ? this.driftDir * 0.04 : 0, 8, dt);

    // off-road rumble
    vis.bounce = state.offRoad
      ? Math.sin(this.time * 34 + this._phase) * T.offroadBump * clamp(speed / 12, 0, 1)
      : 0;

    // brake lights
    const braking = this._brakeIn > 0.15 && vFwd > 0.5 && !this.airborne;
    vis.brakeLight = damp(vis.brakeLight, braking ? 1 : 0, 14, dt);

    // boost flame
    vis.boostGlow = damp(vis.boostGlow, state.boosting ? clamp(0.5 + this.boostPower * 0.45, 0, 1.5) : 0, 10, dt);

    // spin-out yaw (visual full turn; physics heading is untouched)
    if (this.spinTime > 0) {
      const p = 1 - this.spinTime / Math.max(0.001, this.spinDuration);
      vis.spinYaw = this.spinDir * p * TAU;
    } else if (vis.spinYaw !== 0) {
      vis.spinYaw = 0;
    }
  }
}

export default Kart;
