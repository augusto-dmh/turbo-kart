/**
 * ============================================================================
 * TURBO KART — AI driver (Agent 3)
 * ============================================================================
 * One `AIDriver` per AI kart. Every frame `update(dt, { raceManager, karts,
 * state })` returns an `InputState` that `main.js` hands to `kart.update()`.
 *
 * Design:
 *  - **Racing line**: shared, cached `RacingLine` per track (built once for all
 *    drivers) — apex-clipping offsets + a curvature-derived speed profile.
 *  - **Pure pursuit steering** with a speed-sensitive lookahead, a steering
 *    rate limit (no twitching) and a self-calibrating steer sign that also
 *    covers a kart implementation with the opposite steer convention.
 *  - **Speed control** from the profile (backward-pass braking) plus a
 *    difficulty "cruise cap" on straights.
 *  - **Drifting** through medium/long corners, released for mini-turbos.
 *  - **Recovery**: off-road / spun / backwards / stuck handling with a
 *    `kart.respawn()` last resort after 4 s.
 *  - **Avoidance** of other karts and of item hazards published on the bus.
 *  - **Rubber-banding** scaled by difficulty (documented, subtle, tunable).
 *  - **Personality** per character: aggression, precision, line bias, drift and
 *    item love — read from `CharacterDef.stats`.
 *  - **Determinism**: a seeded RNG (`track|difficulty|index|character`), no
 *    `Math.random()` anywhere.
 *
 * Public API: `update(dt, ctx)`, `dispose()`, `wantsItem()`, `debug`, plus
 * `heldItem` bookkeeping fed from item bus events.
 * ============================================================================
 */

import { createInputState, EVENTS, ITEMS, RACE, getCharacter } from '../contracts.js';
import { createRng } from './rng.js';
import { RacingLine } from './racingLine.js';
import { ITEM_HAZARDS } from '../items/itemEvents.js';
import { angleToLeft, approach, clamp, forward01, TAU, wrap01, wrapAngle, wrapDelta } from '../race/progress.js';

/**
 * Difficulty tuning table (documented in the report).
 *  - `topSpeed`      cruise cap on straights, as a fraction of the kart's
 *                    observed top speed (the main straight-line difficulty knob)
 *  - `cornerScale`   corner speed multiplier against the racing-line profile
 *  - `steerGain`     pure-pursuit gain, `steerRate` the input rate limit (1/s)
 *  - `reaction`      input latency in seconds (steer/throttle/drift)
 *  - `driftSkill`    0..1 — how eagerly and how long the AI drifts
 *  - `driftLevel`    mini-turbo level to wait for before releasing (1..2)
 *  - `mistakeRate`   mistakes per second (wide line / lifted throttle)
 *  - `itemSkill`     item usage quality 0..1, `itemDelay` reaction to a roll
 *  - `aggression`    how much room it gives / how eagerly it uses attacks
 *  - `rubber`        rubber-band strength (0 = none, 1.25 = strongest)
 *  - `lookahead`     multiplier on the pure-pursuit lookahead distance
 *  - `rocketAccuracy` 0..1 — how close to "GO" the rocket start is timed
 */
export const DIFFICULTY_TUNING = {
  easy: {
    topSpeed: 0.78, cornerScale: 0.9, steerGain: 1.38, steerRate: 3.2, reaction: 0.22,
    driftSkill: 0.3, driftLevel: 1, mistakeRate: 0.16, mistakeTime: [0.5, 1.4],
    itemSkill: 0.45, itemDelay: 0.55, itemHold: 13, aggression: 0.65, rubber: 1.25,
    lookahead: 1.05, rocketAccuracy: 0.45,
  },
  normal: {
    topSpeed: 0.89, cornerScale: 0.94, steerGain: 1.45, steerRate: 3.4, reaction: 0.18,
    driftSkill: 0.55, driftLevel: 2, mistakeRate: 0.09, mistakeTime: [0.4, 1.1],
    itemSkill: 0.65, itemDelay: 0.35, itemHold: 10, aggression: 0.8, rubber: 1.0,
    lookahead: 1.0, rocketAccuracy: 0.65,
  },
  hard: {
    topSpeed: 0.96, cornerScale: 1.0, steerGain: 1.6, steerRate: 4.2, reaction: 0.1,
    driftSkill: 0.78, driftLevel: 2, mistakeRate: 0.04, mistakeTime: [0.3, 0.8],
    itemSkill: 0.85, itemDelay: 0.22, itemHold: 7, aggression: 0.95, rubber: 0.7,
    lookahead: 1.05, rocketAccuracy: 0.85,
  },
  expert: {
    topSpeed: 1.0, cornerScale: 1.04, steerGain: 1.7, steerRate: 5.0, reaction: 0.055,
    driftSkill: 0.95, driftLevel: 2, mistakeRate: 0.012, mistakeTime: [0.25, 0.6],
    itemSkill: 1.0, itemDelay: 0.12, itemHold: 5, aggression: 1.1, rubber: 0.45,
    lookahead: 1.1, rocketAccuracy: 1.0,
  },
};

/** Seconds of full-throttle probing at race start to learn the kart's top speed. */
const PROBE_SECONDS = 5;
/** Difficulty top speeds are < 1; `topSpeed` observation is clamped to this. */
const MAX_OBSERVED_SPEED = 46;
/** Histogram slots for the input-latency buffer (>= reaction / frame). */
const HISTORY_SLOTS = 160;
const EMPTY_HAZARDS = [];

export class AIDriver {
  /**
   * @param {{THREE:any, bus:any, kart:any, trackApi:any, difficulty?:string, index?:number}} opts
   */
  constructor({ THREE, bus, kart, trackApi, difficulty = 'normal', index = 0 } = {}) {
    this.THREE = THREE;
    this.bus = bus || null;
    this.kart = kart;
    this.trackApi = trackApi || null;
    this.difficulty = DIFFICULTY_TUNING[difficulty] ? difficulty : 'normal';
    this.tuning = DIFFICULTY_TUNING[this.difficulty];
    this.index = index | 0;
    this.input = createInputState();

    const character = kart?.character || getCharacter(kart?.characterId || 'nova');
    const stats = character?.stats || { speed: 3, accel: 3, grip: 3, weight: 3 };
    const trackId = trackApi?.id || 'track';
    this.rng = createRng(trackId, this.difficulty, this.index, character?.id || 'x');

    this.line = RacingLine.get({ trackApi, trackDef: trackApi?.trackDef || trackApi?.def || null });
    this.length = Math.max(50, Number(trackApi?.length) || 600);
    this.maxInset = this.line.maxInset;

    /** Boost pads / ramps the AI will aim for when they are just ahead. */
    this._gimmicks = [];
    const gim = Array.isArray(trackApi?.gimmicks) ? trackApi.gimmicks : [];
    for (const g of gim) {
      if (!g || !Number.isFinite(g.u) || !Number.isFinite(g.lateral)) continue;
      if (g.kind !== 'boost' && g.kind !== 'ramp') continue;
      this._gimmicks.push({ u: wrap01(g.u), lateral: g.lateral, kind: g.kind });
    }

    // ------------------------------------------------------- personality ---
    const r = this.rng;
    this.personality = {
      aggression: clamp(0.35 + stats.weight * 0.09 + stats.speed * 0.05 + r.range(-0.15, 0.15), 0.2, 1.3),
      precision: clamp(0.55 + stats.grip * 0.09 + r.range(-0.12, 0.12), 0.3, 1.2),
      driftLove: clamp(0.4 + stats.accel * 0.1 + r.range(-0.1, 0.1), 0.2, 1.1),
      itemLove: clamp(0.5 + stats.speed * 0.1 + r.range(-0.1, 0.1), 0.2, 1.1),
      lateralBias: r.range(-0.5, 0.5) * this.maxInset * 0.45,
      wanderPhase: r.range(0, TAU),
      wanderPeriod: r.range(7, 17),
      wanderAmp: r.range(0.2, 0.85) * this.maxInset * 0.18,
      holdLimit: this.tuning.itemHold * r.range(0.85, 1.25),
    };

    // ---------------------------------------------------------- state ------
    /** Observed top speed (m/s): seeded from the kart when it exposes one,
     *  otherwise a conservative estimate that adapts upward while driving. */
    const kartTop = Number(kart?.topSpeed);
    this.topSpeed = Number.isFinite(kartTop) && kartTop > 5
      ? clamp(kartTop, 8, MAX_OBSERVED_SPEED)
      : clamp(14 + stats.speed * 1.6, 12, 24);
    this.lineScale = clamp(0.85 + this.personality.precision * 0.22, 0.72, 1.12);

    // Steer sign: the frozen convention (and the shipped Kart) is
    // `steer > 0 = LEFT`, so `steer = +errLeft * gain` → `_steerSign = -1`
    // in the formula `steer = −errLeft · gain · _steerSign` used below.
    // `_calibrateSteer()` flips it automatically if a kart ever disagrees.
    this._steerSign = -1;
    this._steer = 0;
    this._time = 0;
    this._frame = 0;
    this._u = 0;
    this._lateral = 0;

    this._mode = 'drive';
    this._modeTime = 0;
    this._stuck = 0;
    this._backTime = 0;
    this._backSecs = 0;
    this._turnDir = 0;
    this._driftHold = 0;
    this._driftCooldown = 0;
    this._mistake = 0;
    this._mistakeKind = 'none';
    this._nextMistake = this.tuning.mistakeRate > 0 ? 2.5 + r.range(0, 4) : Infinity;

    this._rubber = { speedMul: 1, aggr: 1, diff: 0 };
    this._rubberBoostAt = 3;
    this._place = 1;
    this._fieldSize = 1;
    this._progress = 0;
    this._playerProgress = 0;
    this._playerKart = null;
    this._raceManager = null;
    this._karts = [];
    this._cdExact = NaN;
    this._cdAt = 0;
    this._rocketPressAt = NaN;

    this._latSign = this._computeLatSign();

    /** Input-latency ring buffer. */
    this._hist = new Array(HISTORY_SLOTS);
    for (let i = 0; i < HISTORY_SLOTS; i++) this._hist[i] = { t: -1e9, throttle: 0, brake: 0, steer: 0, drift: false };
    this._histIdx = 0;

    this._desire = { throttle: 0, brake: 0, steer: 0, drift: false };
    // ------------------------------------------------------------ items ----
    this.heldItem = null; // ItemDef from ITEMS
    this.heldCount = 0;
    this.heldSince = 0;
    this._itemReadyAt = 0;
    this._wantItem = false;
    this._nextUseAttempt = 0;

    /** @type {Array<{x:number,y:number,z:number,radius:number,kind:string}>} */
    this._hazards = EMPTY_HAZARDS;
    this._targets = [];
    for (let i = 0; i < 9; i++) this._targets.push({ kart: null, gap: 0, side: 0, lateral: 0 });
    this._targetList = [];

    /** Steer-sign calibration. */
    this._cal = { sum: 0, abs: 0, t: 0, prevYaw: NaN, flips: 0, strikes: 0 };
    this._calCooldown = 0;
    this._lostTime = 0;
    this._lostEffort = 0;
    this._lostFlips = 0;
    this._healthyTime = 0;

    /** Live debug snapshot (read by tooling / tests, never gameplay). */
    this.debug = {
      mode: 'idle', targetU: 0, lateralTarget: 0, targetSpeed: 0, speed: 0,
      throttle: 0, brake: 0, steer: 0, drift: false, errLeft: 0, place: 1,
      topSpeed: this.topSpeed, item: null, rubber: 0, steerSign: 1, stuck: 0,
    };

    this._unsubs = [];
    if (this.bus?.on) {
      const b = this.bus;
      this._unsubs.push(
        b.on(EVENTS.ITEM_ROLL, (p) => {
          if (!p || p.kart !== this.kart) return;
          this.heldItem = p.item || (p.itemId ? ITEMS[p.itemId] : null) || null;
          this.heldCount = String(p.itemId || p.item?.id).includes('triple') ? 3 : 1;
          this.heldSince = this._time;
          const delay = this.tuning.itemDelay * this.rng.range(0.75, 1.3);
          this._itemReadyAt = this._time + delay;
        }),
        b.on(EVENTS.ITEM_USE, (p) => {
          if (!p || p.kart !== this.kart) return;
          this.heldCount -= 1;
          if (this.heldCount <= 0) {
            this.heldItem = null;
            this.heldCount = 0;
          }
        }),
        b.on(EVENTS.ITEM_BLOCKED, (p) => {
          if (p && p.kart === this.kart) {
            this.heldItem = null;
            this.heldCount = 0;
          }
        }),
        b.on(EVENTS.RACE_COUNTDOWN, (p) => {
          if (Number.isFinite(p?.exact)) {
            this._cdExact = p.exact;
            this._cdAt = this._time;
          }
        }),
        b.on(ITEM_HAZARDS, (p) => {
          this._hazards = Array.isArray(p?.hazards) ? p.hazards : EMPTY_HAZARDS;
        }),
      );
    }
  }

  // ------------------------------------------------------------ public ----

  /**
   * @param {number} dt
   * @param {{raceManager?:any, karts?:any[], state?:string}} [ctx]
   * @returns {import('../contracts.js').InputState}
   */
  update(dt, ctx = {}) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this._time += dt;
    this._frame++;

    const input = this.input;
    input.throttle = 0;
    input.brake = 0;
    input.steer = 0;
    input.drift = false;
    input.useItem = false;
    input.lookBack = false;

    const kart = this.kart;
    if (!kart) return input;

    const raceManager = ctx.raceManager || this._raceManager || null;
    this._raceManager = raceManager;
    const phase = ctx.state || (raceManager?.state === 'finished' ? 'results' : 'racing');

    if (phase === 'countdown') {
      this._updateCountdown(input, raceManager);
      this._publish(input);
      return input;
    }

    const st = kart.state || {};
    const finished = !!kart.finished || !!st.finished || raceManager?.state === 'finished' || phase === 'results';

    this._karts = ctx.karts || this._karts || [];
    this._readStandings(raceManager, this._karts);
    this._think(dt, ctx, finished, this._desire);
    this._pushHistory(this._desire);
    this._applyDelayed(input, dt);

    this._wantItem = !finished && !st.spinning && !st.frozen && this._itemStrategy();
    // One-frame pulse, retried at most every 0.3 s (the ItemSystem uses rising
    // edges, so a held flag would never fire twice).
    input.useItem = false;
    if (this._wantItem && this.heldItem && this._time >= this._nextUseAttempt) {
      input.useItem = true;
      this._nextUseAttempt = this._time + 0.3;
    }
    this.debug.item = this.heldItem ? this.heldItem.id : null;

    this._publish(input);
    return input;
  }

  /** True on the frame the AI pressed the item button (rising edge). */
  wantsItem() {
    return !!this.input.useItem;
  }

  dispose() {
    for (const off of this._unsubs) if (typeof off === 'function') off();
    this._unsubs.length = 0;
    this._hazards = EMPTY_HAZARDS;
  }

  // ----------------------------------------------------------- driving ----

  /** Write the input back onto the kart so the ItemSystem sees the same object. */
  _publish(input) {
    if (this.kart && this.kart.input !== input) this.kart.input = input;
  }

  _readStandings(raceManager, karts) {
    const list = raceManager?.standings;
    this._fieldSize = (karts && karts.length) || this._fieldSize;
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (s.kart === this.kart) {
        this._place = s.place;
        this._progress = s.progress;
      } else if (s.kart?.isPlayer) {
        this._playerProgress = s.progress;
      }
    }
    if (!this._playerKart) {
      this._playerKart = raceManager?.playerKart || (karts ? karts.find((k) => k?.isPlayer) : null) || null;
    }
  }

  _think(dt, ctx, finished, out) {
    const kart = this.kart;
    const st = kart.state || {};
    const api = this.trackApi;
    const pos = kart.position;
    const p = api?.project ? api.project(pos) : null;
    const u = wrap01(p ? p.u : Number(kart.progress) || 0);
    const lateral = Number.isFinite(p?.lateral) ? p.lateral : 0;
    const speed = Number.isFinite(kart.speed) ? kart.speed : 0;
    const fwd = kart.forward || { x: 0, y: 0, z: 1 };
    const tan = (api?.tangentAt ? api.tangentAt(u) : null) || { x: 0, y: 0, z: 1 };
    const align = fwd.x * tan.x + fwd.z * tan.z;
    const absSpeed = Math.abs(speed);
    const karts = ctx.karts || [];
    const line = this.line;

    this._u = u;
    this._lateral = lateral;
    this._modeTime += dt;

    this._observeTopSpeed(dt, speed, st, align);
    this._updateRubber();
    this._updateMistakes(dt);

    // ------------------------------------------------------------- modes ---
    const wrongWay = !!st.wrongWay || (align < -0.2 && absSpeed > 4);
    const waiting = !!(st.spinning || st.frozen);
    const moving = absSpeed > 2.2 || st.airborne;
    if (moving) this._stuck = 0;
    else if (!waiting) this._stuck += dt;
    if (align > 0.35) this._backTime = 0;
    // Debounce the "facing backwards" state so a bump or a noisy yaw frame
    // cannot trigger a reverse/U-turn thrash.
    if (align < -0.35) this._backSecs += dt;
    else this._backSecs = Math.max(0, this._backSecs - dt * 2);

    let mode = 'drive';
    if (finished) mode = 'finished';
    else if (waiting) mode = 'wait';
    else if (this._stuck > 4) mode = 'respawn';
    else if (align < -0.35 && this._backSecs > 0.3) {
      // facing (roughly) backwards: back away if stopped, otherwise U-turn
      if (absSpeed < 2.5 && this._backTime < 0.6) {
        this._backTime += dt;
        mode = 'reverse';
      } else {
        this._backTime = 0.6;
        mode = 'turnaround';
      }
    } else if (this._stuck > 2) mode = 'unstick';
    else if (wrongWay) mode = 'recover';
    else if (st.offRoad) mode = 'recover';

    if (mode !== this._mode) {
      this._mode = mode;
      this._modeTime = 0;
      if (mode === 'unstick') {
        this._turnDir = 0;
        this._driftHold = 0;
        this._driftCooldown = 0.6;
      }      if (mode === 'respawn') {
        this._stuck = 0;
        this._modeTime = 0;
        this._backTime = 0;
        this._steer = 0;
        kart.respawn?.();
        mode = this._mode = 'drive';
      }
    }

    // ---- "lost" detector (steer-sign safety net) --------------------------
    // A healthy driver spends almost all its time in 'drive'. If we keep
    // failing to hold the line for >6 s of continuous struggle, with real
    // steering effort and no 1.5 s healthy stretch, the steer sign is probably
    // inverted: flip it once (early in the race) and carry on. A correct kart
    // never produces this pattern — measured 0 false flips.
    if (mode === 'drive') {
      this._healthyTime += dt;
      if (this._healthyTime > 1.5) this._lostTime = 0;
    } else if (mode === 'recover' || mode === 'turnaround') {
      this._healthyTime = 0;
      this._lostTime += dt;
      if (Math.abs(this._steer) > 0.5 && absSpeed > 5) this._lostEffort += dt;
      if (this._lostFlips < 1 && this._time < 90 && this._lostTime > 6 && this._lostEffort > 1.5) {
        this._steerSign = -this._steerSign;
        this._cal.flips++;
        this._lostFlips++;
        this._lostTime = 0;
        this._lostEffort = 0;
        this._steer = 0;
        for (let i = 0; i < HISTORY_SLOTS; i++) this._hist[i].t = -1e9;
        this._calCooldown = 2.0;
      }
    } else {
      this._healthyTime = 0;
      this._lostTime = 0;
      this._lostEffort = 0;
    }

    // --------------------------------------------------------- steering ----
    const extra = this._avoidBias(karts);
    let latTarget = line.offsetAt(u) * this.lineScale + this.personality.lateralBias + extra;
    latTarget += Math.sin((this._time / this.personality.wanderPeriod) * TAU + this.personality.wanderPhase)
      * this.personality.wanderAmp;
    if (this._mistake > 0 && this._mistakeKind === 'wide') {
      latTarget += (lateral >= 0 ? 1 : -1) * this.personality.wanderAmp * 3;
    }
    if (mode === 'recover') latTarget = clamp(lateral, -2, 2) * 0.35; // head back to the middle
    latTarget = clamp(latTarget, -line.maxInset, line.maxInset);
    if (mode === 'drive') latTarget = this._seekGimmicks(u, latTarget, line.maxInset);

    // A driver with more input latency needs to look further ahead to stay
    // stable: the easy AI takes wide, calm lines instead of twitching off-road.
    const latencyLead = 1 + this.tuning.reaction * 1.6;
    const lookM = this._lookaheadM(absSpeed) * this.tuning.lookahead * latencyLead * (mode === 'recover' ? 1.3 : 1);
    const tu = wrap01(u + clamp(lookM / this.length, 0.0012, 0.15));
    const tp = api?.pointAt ? api.pointAt(tu, latTarget) : { x: pos.x, y: pos.y, z: pos.z };
    let errLeft = angleToLeft(fwd.x, fwd.z, tp.x - pos.x, tp.z - pos.z);
    // Cross-track correction: pure pursuit alone cuts chords and drifts to the
    // outside of long corners, so pull the kart back toward the target lateral.
    const latErr = clamp(latTarget - lateral, -4, 4) * this._latSign;
    errLeft += latErr / Math.max(6, lookM);

    let desired = clamp(-errLeft * this.tuning.steerGain * this._steerSign, -1, 1);
    const steerRate = this.tuning.steerRate * (mode === 'recover' ? 1.35 : 1) * (0.85 + this.personality.precision * 0.25);
    this._steer = approach(this._steer, desired, steerRate * dt);
    // Only judge the steer sign where the output IS `_steer` (drive/recover).
    this._calibrateSteer(dt, errLeft, this._steer, st, speed, mode === 'drive' || mode === 'recover');

    if (mode === 'wait') {
      this._steer = 0;
      out.throttle = 0;
      out.brake = 0;
      out.steer = 0;
      out.drift = false;
      this.debug.mode = mode;
      this._fillDebug(out, tu, latTarget, 0, errLeft);
      return;
    }

    if (mode === 'reverse' || mode === 'unstick') {
      out.throttle = 0;
      out.brake = 1;
      out.steer = clamp(-this._steer, -1, 1); // wheel the other way when backing up
      out.drift = false;
      this.debug.mode = mode;
      this._fillDebug(out, tu, latTarget, 0, errLeft);
      return;
    }

    if (mode === 'turnaround') {
      // Committed U-turn: full lock one way, enough throttle to rotate.
      if (this._modeTime === 0) {
        const s = Math.abs(errLeft) > 0.25 ? Math.sign(errLeft) : (this.rng.chance(0.5) ? 1 : -1);
        this._turnDir = s > 0 ? -1 : 1; // errLeft > 0 means "turn left", steer is negative for left
      }
      if (this._modeTime > 2.4) {
        this._stuck = 0;
        this._backTime = 0;
        this._modeTime = 0;
        this._mode = 'drive';
        kart.respawn?.();
        this.debug.mode = 'respawn';
        this._fillDebug(out, tu, latTarget, 0, errLeft);
        return;
      }
      out.throttle = 0.5;
      out.brake = 0;
      out.steer = this._turnDir || 1;
      out.drift = false;
      this.debug.mode = mode;
      this._fillDebug(out, tu, latTarget, 0, errLeft);
      return;
    }

    out.steer = clamp(this._steer, -1, 1);

    // ------------------------------------------------------------ speed ----
    const ratioHere = line.speedAt(u);
    const ratioAhead = line.speedAt(wrap01(u + (4 + absSpeed * 0.45) / this.length));
    const ratio = Math.min(ratioHere, ratioAhead);
    const straight = ratio > 0.96;

    let target = this.topSpeed * ratio * this.tuning.cornerScale;
    if (straight) target = Math.max(target, this.topSpeed * this.tuning.topSpeed);
    if (straight && this._time < PROBE_SECONDS) target = Infinity; // learn the real top speed
    target *= this._rubber.speedMul;
    if (mode === 'recover') target *= 0.92;
    if (mode === 'finished') target *= 0.72;
    if (this._mistake > 0 && this._mistakeKind === 'lift') target *= 0.78;

    // Fractional throttle/brake (the shipped Kart scales engine force by them):
    // a proportional band keeps speed control smooth instead of bang-bang.
    const over = (absSpeed - target) / Math.max(2, target * 0.25);
    if (absSpeed <= target) {
      out.throttle = 1;
      out.brake = 0;
    } else if (absSpeed > target * 1.35) {
      out.throttle = 0;
      out.brake = 1;
    } else {
      out.throttle = clamp(0.8 - over * 0.8, 0, 0.8);
      out.brake = over > 0.5 ? 0.5 : 0;
    }

    // ------------------------------------------------------------ drift ----
    out.drift = false;
    if (mode === 'drive' && !st.airborne) {
      this._driftCooldown = Math.max(0, this._driftCooldown - dt);
      const skill = clamp(this.tuning.driftSkill * (0.7 + this.personality.driftLove * 0.5), 0, 1);
      const want = skill > 0.12
        && absSpeed > 8
        && this._driftCooldown <= 0
        && line.driftTargetAhead(wrap01(u + 2 / this.length), 6 + absSpeed * 0.42) >= 8 * (1.5 - skill);
      if (want) this._driftHold = 0.3;
      else if (this._driftHold > 0) this._driftHold -= dt;

      if (this._driftHold > 0) out.drift = true;
      if (st.drifting && st.driftLevel >= this.tuning.driftLevel) {
        // release for the mini-turbo, then cool down before re-drifting
        out.drift = false;
        this._driftHold = 0;
        this._driftCooldown = 0.45;
      }
    }

    this.debug.mode = mode;
    this._fillDebug(out, tu, latTarget, target, errLeft);
  }

  _fillDebug(out, tu, latTarget, targetSpeed, errLeft) {
    const d = this.debug;
    d.targetU = tu;
    d.lateralTarget = latTarget;
    d.targetSpeed = Number.isFinite(targetSpeed) ? targetSpeed : 999;
    d.speed = Number(this.kart?.speed) || 0;
    d.throttle = out.throttle;
    d.brake = out.brake;
    d.steer = out.steer;
    d.drift = out.drift;
    d.errLeft = errLeft;
    d.place = this._place;
    d.topSpeed = this.topSpeed;
    d.rubber = this._rubber.speedMul;
    d.steerSign = this._steerSign;
    d.stuck = this._stuck;
  }

  // --------------------------------------------------------- sub-systems --

  _lookaheadM(speed) {
    return clamp(6.5 + speed * 0.3, 7, 24);
  }

  /**
   * Latency: the AI emits the input it *decided* `reaction` seconds ago.
   * Frame-rate independent up to HISTORY_SLOTS frames of history.
   */
  _pushHistory(desire) {
    const slot = this._hist[this._histIdx];
    slot.t = this._time;
    slot.throttle = desire.throttle;
    slot.brake = desire.brake;
    slot.steer = desire.steer;
    slot.drift = desire.drift;
    this._histIdx = (this._histIdx + 1) % HISTORY_SLOTS;
  }

  _applyDelayed(input, dt) {
    const reaction = this.tuning.reaction;
    if (reaction <= 0.001) {
      input.throttle = this._desire.throttle;
      input.brake = this._desire.brake;
      input.steer = this._desire.steer;
      input.drift = this._desire.drift;
      return;
    }
    const cut = this._time - reaction;
    const N = HISTORY_SLOTS;
    let idx = (this._histIdx - 1 + N) % N;
    let use = null;
    for (let i = 0; i < N; i++) {
      const h = this._hist[idx];
      if (h.t > -1e8 && h.t <= cut) {
        use = h;
        break;
      }
      idx = (idx - 1 + N) % N;
    }
    use = use || this._hist[(this._histIdx - 1 + N) % N];
    if (!use || use.t < -1e8) use = this._desire;
    input.throttle = use.throttle;
    input.brake = use.brake;
    input.steer = use.steer;
    input.drift = use.drift;
  }

  /**
   * Watch whether our steering produces the intended yaw response. If a kart
   * implementation uses the opposite steer sign we detect it in ~0.6 s and
   * flip, so the AI can never be crippled by a convention mismatch. Kept
   * deliberately permissive (works off-road and while sliding) because a wrong
   * sign ruins the conditions a stricter test would need.
   */
  _calibrateSteer(dt, errLeft, steer, st, speed, steeringIsOutput) {
    const yaw = Number.isFinite(this.kart?.yaw) ? this.kart.yaw
      : Number(this.kart?.object3D?.rotation?.y);
    if (!Number.isFinite(yaw)) return;
    if (!Number.isFinite(this._cal.prevYaw)) {
      this._cal.prevYaw = yaw;
      return;
    }
    const dYaw = wrapAngle(yaw - this._cal.prevYaw);
    this._cal.prevYaw = yaw;

    if (this._calCooldown > 0) {
      // let the input pipeline drain after a flip before judging again
      this._calCooldown -= dt;
      this._cal.sum = 0;
      this._cal.abs = 0;
      this._cal.t = 0;
      return;
    }
    const usable = steeringIsOutput && !st.spinning && !st.frozen && !st.airborne && !st.drifting
      && Math.abs(steer) > 0.25 && Math.abs(errLeft) > 0.12
      && Math.abs(speed) > 3 && Math.abs(dYaw) < 0.25;
    if (usable) {
      this._cal.sum += errLeft * dYaw;
      this._cal.abs += Math.abs(errLeft * dYaw);
      this._cal.t += dt;
    } else {
      this._cal.t += dt * 0.25; // idle evidence so the window still expires
    }
    if (this._cal.t > 1.0) {
      // A flipped kart steers hard the wrong way every frame, so its evidence
      // is strongly and *consistently* negative. Require two full windows of
      // it (≈2 s) before trusting the flip — collisions, wall slides, drifts
      // and bumps can all produce a single misleading window.
      if (this._cal.abs > 0.3 && this._cal.sum < -0.6 * this._cal.abs) this._cal.strikes++;
      else this._cal.strikes = 0;
      if (this._cal.strikes >= 2) {
        this._steerSign = -this._steerSign;
        this._cal.flips++;
        this._cal.strikes = 0;
        this._steer = 0;
        for (let i = 0; i < HISTORY_SLOTS; i++) this._hist[i].t = -1e9; // drop stale inputs
        this._calCooldown = 2.0;
      }
      this._cal.sum = 0;
      this._cal.abs = 0;
      this._cal.t = 0;
    }
  }

  _observeTopSpeed(dt, speed, st, align) {
    const obs = Math.abs(speed);
    if (st.boosting) return;
    if (align > 0.9 && obs > this.topSpeed) {
      this.topSpeed = clamp(this.topSpeed + (obs - this.topSpeed) * clamp(dt * 1.5, 0, 1), 8, MAX_OBSERVED_SPEED);
    } else if (!Number.isFinite(speed)) {
      this.topSpeed = clamp(this.topSpeed, 8, MAX_OBSERVED_SPEED);
    }
  }

  _updateMistakes(dt) {
    if (this._mistake > 0) this._mistake = Math.max(0, this._mistake - dt);
    const rate = this.tuning.mistakeRate;
    if (rate <= 0) return;
    if (this._time >= this._nextMistake) {
      this._nextMistake = this._time + (1 / rate) * this.rng.range(0.6, 1.5);
      this._mistake = this.rng.range(this.tuning.mistakeTime[0], this.tuning.mistakeTime[1]);
      this._mistakeKind = this.rng.chance(0.5) ? 'wide' : 'lift';
    }
  }

  /**
   * Rubber banding (documented, difficulty-scaled, subtle):
   *  - behind the player by > 0.16 laps: up to +5.5% * `rubber` target speed
   *    and an occasional short `applyBoost`, plus more item aggression;
   *  - ahead of the player by > 0.16 laps: up to -5% * `rubber` target speed.
   * `rubber` is 1.25 (easy) … 0.45 (expert), so expert barely rubber-bands.
   */
  _updateRubber() {
    const r = this._rubber;
    r.speedMul = 1;
    r.aggr = 1;
    r.diff = 0;
    if (!this._playerKart || this.kart?.isPlayer) return;
    const diff = this._playerProgress - this._progress;
    r.diff = diff;
    const k = this.tuning.rubber;
    const dead = 0.16;
    const span = 0.5;
    if (diff > dead) {
      const t = clamp((diff - dead) / span, 0, 1);
      r.speedMul = 1 + t * 0.055 * k;
      r.aggr = 1 + t * 0.5 * k;
      const interval = clamp(10 - 4 * k, 4, 12);
      if (t > 0.45 && this._time > this._rubberBoostAt && this.kart?.applyBoost) {
        this.kart.applyBoost(0.5, 1.3, 'rubber');
        this._rubberBoostAt = this._time + interval;
      }
    } else if (diff < -dead) {
      const t = clamp((-diff - dead) / span, 0, 1);
      r.speedMul = 1 - t * 0.05 * k;
      r.aggr = 1 - t * 0.3 * k;
    }
  }

  /** Deterministic per-track sign of `pointAt(u, +lateral)` vs world-left. */
  _computeLatSign() {
    const api = this.trackApi;
    if (!api?.pointAt || !api?.tangentAt) return 1;
    let acc = 0;
    for (let i = 0; i < 8; i++) {
      const u = i / 8;
      const c = api.pointAt(u, 0);
      const l = api.pointAt(u, 1);
      const t = api.tangentAt(u);
      if (!c || !l || !t) continue;
      const bx = (Number(l.x) || 0) - (Number(c.x) || 0);
      const bz = (Number(l.z) || 0) - (Number(c.z) || 0);
      acc += bx * (Number(t.z) || 0) - bz * (Number(t.x) || 0);
    }
    return acc >= 0 ? 1 : -1;
  }

  // ----------------------------------------------------------- avoidance --

  /**
   * Steer toward a boost pad / ramp just ahead (up to ~22 m). Humans take the
   * pads, so the AI does too; the blend is partial so it never swerves wildly.
   */
  _seekGimmicks(u, latTarget, maxInset) {
    const list = this._gimmicks;
    if (!list.length) return latTarget;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const aheadM = forward01(u, g.u) * this.length;
      if (aheadM > 22) continue;
      if (Math.abs(g.lateral) > maxInset) continue;
      return clamp(latTarget + (g.lateral - latTarget) * 0.6, -maxInset, maxInset);
    }
    return latTarget;
  }

  /**
   * Lateral bias (in track-lateral units) that steers around karts and item
   * hazards. Returns 0 when the road ahead is clear.
   */
  _avoidBias(karts) {
    const kart = this.kart;
    const fwd = kart.forward || { x: 0, y: 0, z: 1 };
    const pos = kart.position;
    let bias = 0;
    const lateral = this._lateral;
    const aggr = clamp(this.personality.aggression * this._rubber.aggr * this.tuning.aggression, 0.2, 1.5);
    const player = this._playerKart;
    const playerFinalLap = !!player && Number(player.lap) >= (this._raceManager?.laps || RACE.LAPS);

    // --- other karts -------------------------------------------------------
    for (const other of karts) {
      if (!other || other === kart || !other.position) continue;
      if (other.state?.finished) continue;
      const rx = other.position.x - pos.x;
      const rz = other.position.z - pos.z;
      const ahead = rx * fwd.x + rz * fwd.z;
      const side = rx * fwd.z - rz * fwd.x; // positive = to my left (world)
      const dist = Math.hypot(rx, rz);
      const isPlayer = !!other.isPlayer;

      if (ahead > 0.2 && ahead < 12 && Math.abs(side) < 3.4 && dist < 14) {
        const otherLat = (side * this._latSign);
        const room = 3.4 - Math.abs(side);
        const urgency = clamp(room / 3.4, 0, 1) * clamp(1 - ahead / 12, 0.25, 1);
        let dir = otherLat >= lateral ? -1 : 1;
        if (Math.abs(otherLat - lateral) < 0.5) dir = lateral > 0 ? -1 : 1;
        bias += dir * urgency * 3.2 / aggr;
        // courtesy: do not ram the player from behind on his final lap
        if (isPlayer && playerFinalLap && ahead > 1.2 && ahead < 6) {
          bias += (lateral > 0 ? 1 : -1) * 0.8;
        }
      } else if (Math.abs(ahead) < 2.6 && Math.abs(side) < 2.4 && dist < 4) {
        // side by side: give a little room
        const dir = side >= 0 ? -1 : 1;
        bias += dir * 1.5 / aggr;
      }
    }

    // --- item hazards ------------------------------------------------------
    const hazards = this._hazards;
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      if (!h) continue;
      const rx = (Number(h.x) || 0) - pos.x;
      const rz = (Number(h.z) || 0) - pos.z;
      const ahead = rx * fwd.x + rz * fwd.z;
      const side = rx * fwd.z - rz * fwd.x;
      if (ahead < 0.8 || ahead > 16) continue;
      const rad = Number(h.radius) || 1;
      if (Math.abs(side) > rad + 2.2) continue;
      const hLat = side * this._latSign;
      let dir = hLat >= lateral ? -1 : 1;
      if (Math.abs(hLat - lateral) < 0.6) dir = lateral > 0 ? -1 : 1;
      const urgency = clamp(1 - ahead / 16, 0.3, 1);
      bias += dir * urgency * (2.6 + rad);
    }

    return clamp(bias, -this.maxInset, this.maxInset);
  }

  // ---------------------------------------------------------------- items --

  /** Difficulty/personality gate for firing the held item this frame. */
  _itemStrategy() {
    const item = this.heldItem;
    if (!item) return false;
    if (this._time < this._itemReadyAt) return false;
    const id = item.id || item.itemId;
    const skill = this.tuning.itemSkill;
    const held = this._time - this.heldSince;
    const targets = this._targetsAhead(this._karts);
    const nearest = targets.length ? targets[0] : null;
    const behind = this._nearestBehind(this._karts);
    const u = this._u;
    const curvAhead = this.line.maxCurvatureAhead(wrap01(u + 16 / this.length), 34);
    const straight = curvAhead < 0.022;
    const aggr = clamp(this.personality.aggression * this._rubber.aggr * this.tuning.aggression, 0.2, 1.5);
    const holdLimit = this.personality.holdLimit * (1.4 - 0.5 * skill) * (1.25 - 0.4 * this.personality.itemLove) / (0.85 + 0.25 * aggr);

    switch (id) {
      case 'mushroom':
      case 'triple-mushroom':
        if (this._mode === 'recover' && this.kart?.state?.offRoad) return true; // get back on the road
        if (held > holdLimit) return true;
        if (straight && (nearest ? nearest.gap < 40 : true)) return skill > 0.35;
        return false;
      case 'red-shell':
        if (held > holdLimit) return true;
        return !!nearest && nearest.gap < 55 * (0.6 + 0.5 * skill);
      case 'green-shell':
        if (held > holdLimit) return true;
        // straight shots only: a shell fired into a corner just wastes itself
        return !!nearest && nearest.gap > 3.5 && nearest.gap < 26
          && Math.abs(nearest.lateral) < 3.2
          && this.line.maxCurvatureAhead(wrap01(u + 5 / this.length), nearest.gap) < 0.02;
      case 'triple-shell':
        if (held > holdLimit) return true;
        return !!nearest && nearest.gap > 3 && nearest.gap < 26 && Math.abs(nearest.lateral) < 3;
      case 'banana':
        if (held > holdLimit) return true;
        if (behind && behind.gap < 16) return true;
        return !!behind && curvAhead > 0.03; // shield a corner entry
      case 'star': {
        if (held > holdLimit) return true;
        const near = targets.length + (behind ? 1 : 0);
        if (this._place > 4) return true;
        if (near >= 2) return true;
        return held > 4 && this._rubber.aggr > 1.05;
      }
      case 'lightning':
        if (held > holdLimit) return true;
        return this._place >= 5; // four or more karts ahead
      default:
        return held > holdLimit;
    }
  }

  /** Nearest karts ahead (in this lap's forward direction), capped at 9. */
  _targetsAhead(karts) {
    const out = this._targets;
    const list = this._targetList;
    list.length = 0;
    const kart = this.kart;
    if (!kart) return list;
    const myU = this._u;
    const fwd = kart.forward || { x: 0, y: 0, z: 1 };
    let n = 0;
    for (const other of karts) {
      if (n >= out.length) break;
      if (!other || other === kart || !other.position) continue;
      if (other.state?.finished) continue;
      const du = wrapDelta((Number(other.progress) || 0) - myU);
      if (du <= 0 || du > 0.25) continue;
      const gap = du * this.length;
      const rx = other.position.x - kart.position.x;
      const rz = other.position.z - kart.position.z;
      const side = rx * fwd.z - rz * fwd.x;
      const e = out[n++];
      e.kart = other;
      e.gap = gap;
      e.side = side;
      e.lateral = side * this._latSign;
      list.push(e);
    }
    list.sort((a, b) => a.gap - b.gap);
    return list;
  }

  /** Nearest kart behind within 25 m (or null). */
  _nearestBehind(karts) {
    const kart = this.kart;
    if (!kart) return null;
    const myU = this._u;
    const fwd = kart.forward || { x: 0, y: 0, z: 1 };
    let best = null;
    for (const other of karts) {
      if (!other || other === kart || !other.position) continue;
      if (other.state?.finished) continue;
      const du = wrapDelta(myU - (Number(other.progress) || 0));
      if (du <= 0 || du > 0.1) continue;
      const gap = du * this.length;
      if (gap > 25) continue;
      if (!best || gap < best.gap) {
        const rx = other.position.x - kart.position.x;
        const rz = other.position.z - kart.position.z;
        const side = rx * fwd.z - rz * fwd.x;
        best = { kart: other, gap, side, lateral: side * this._latSign };
      }
    }
    return best;
  }

  // ------------------------------------------------------------ countdown --

  /**
   * Rocket start: never press before the window, and aim for a difficulty
   * scaled point inside it (higher accuracy = closer to "GO").
   */
  _updateCountdown(input, raceManager) {
    input.throttle = 0;
    input.steer = 0;
    input.drift = false;
    input.brake = 0;
    input.useItem = false;
    if (!Number.isFinite(this._rocketPressAt)) {
      const acc = clamp(this.tuning.rocketAccuracy, 0, 1);
      const w = RACE.ROCKET_START_WINDOW;
      this._rocketPressAt = clamp(0.02 + (w - 0.02) * (1 - acc) * this.rng.range(0.35, 1), 0.03, w);
    }
    let remaining = Number(raceManager?.countdownRemaining);
    if (!Number.isFinite(remaining)) {
      remaining = Number.isFinite(this._cdExact) ? this._cdExact - (this._time - this._cdAt) : RACE.COUNTDOWN_SECONDS;
    }
    if (remaining > 0 && remaining <= this._rocketPressAt) input.throttle = 1;
    this.debug.mode = 'countdown';
    this.debug.targetSpeed = 0;
    return input;
  }
}
