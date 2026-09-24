/**
 * ============================================================================
 * TURBO KART — lap validation (Agent 3)
 * ============================================================================
 * Bullet-proof lap counting from `trackApi.checkpointUs`.
 *
 * Rules implemented:
 *  1. Checkpoints must be crossed **in order**. A kart only ever tests the gate
 *     it is due to cross next, so skipping / cutting gives no credit.
 *  2. The last checkpoint is the finish line. A lap only completes when every
 *     earlier gate was crossed first, in the forward direction, in this lap.
 *  3. Moving backwards over a gate never credits anything (reversing over the
 *     line cannot re-trigger a lap).
 *  4. A frame whose projected `u` jumps further than `MAX_STEP` is treated as a
 *     teleport (respawn / external reset): gates are re-synced and nothing is
 *     credited for that frame.
 *  5. Progress (`lap + fractionOfLap`) is derived from **signed accumulated
 *     forward arc**, so reversing bleeds progress off but can never be farmed
 *     by driving backwards and re-covering the same ground.
 *
 * Pure logic, no THREE, no subsystem imports → unit-testable in plain node.
 * ============================================================================
 */

import { clamp, forward01, wrap01, wrapDelta } from './progress.js';

/** A u-jump above this in a single frame is a teleport, never real motion. */
export const MAX_STEP = 0.1;

/**
 * @typedef {Object} LapEvent
 * @property {'lap'|'finish'} type
 * @property {number} lap     new lap number (1-based) — `laps + 1` means finished
 * @property {number} lapTime seconds for the lap that just ended (0 for the first)
 * @property {number} arc     total forward arc travelled at the crossing (m)
 */

export class LapTracker {
  /**
   * @param {{trackApi: import('../contracts.js').TrackApi, laps?: number}} opts
   */
  constructor({ trackApi, laps = 3 } = {}) {
    this.trackApi = trackApi || null;
    this.laps = Math.max(1, Math.floor(laps || 3));
    this.length = Number.isFinite(trackApi?.length) && trackApi.length > 8 ? trackApi.length : 600;

    const raw0 = Array.isArray(trackApi?.checkpointUs) ? trackApi.checkpointUs : [];
    const raw = raw0.map(Number).filter((x) => Number.isFinite(x)).map(wrap01);
    const su = Number.isFinite(trackApi?.startU) ? wrap01(trackApi.startU) : NaN;

    // Which gate is the finish line? `checkpointUs` is documented as ascending
    // with the last entry = finish, but real tracks express it as `i / count`,
    // so the last entry can be exactly 1 which wraps to 0 (= `startU`).
    const nearForward = (a, b) => Math.min(forward01(a, b), forward01(b, a)) < 0.01;
    let finishU = Number.isFinite(su) && raw.length ? su : raw.length ? raw[raw.length - 1] : (Number.isFinite(su) ? su : 0);
    if (raw.length && !raw.some((g) => nearForward(g, finishU))) finishU = raw[raw.length - 1];

    // Order every other gate by its forward distance from the finish line and
    // append the finish so `gates[gates.length - 1]` is always the finish.
    const others = raw
      .filter((g) => forward01(finishU, g) > 1e-4)
      .sort((a, b) => forward01(finishU, a) - forward01(finishU, b));
    const gates = [];
    for (const g of others) {
      if (!gates.length || forward01(gates[gates.length - 1], g) > 1e-3) gates.push(g);
    }
    gates.push(finishU);
    /** @type {number[]} ascending checkpoint u values (travel order); the last one is the finish line */
    this.gates = gates;
    /** u of the finish line (authoritative for lap counting). */
    this.finishU = finishU;
    /** u of the start/finish line from the track API (may differ slightly). */
    this.startU = Number.isFinite(su) ? su : finishU;

    /** @type {Map<object, object>} */
    this.entries = new Map();
  }

  /** @param {object} kart */
  entry(kart) {
    let e = this.entries.get(kart);
    if (!e) {
      e = {
        kart,
        lap: 1, // 1-based; `laps + 1` = finished
        gate: 0, // next checkpoint index to cross
        prevU: null,
        u: 0,
        arc: 0, // accumulated forward arc since the grid (m), >= 0
        arcAtLap: 0, // arc value when the current lap started
        progress: 0, // lap + fractionOfLap (loses value when driving backwards)
        best: 0, // highest progress reached so far (monotonic, for debug/HUD)
        distToGate: this.length, // metres to the next gate (for tie-breaks)
        finished: false,
        armed: false, // has crossed the finish line at least once
        teleports: 0,
        lapTimes: [],
        lapStartedAt: null,
        lastLapTime: null,
      };
      this.entries.set(kart, e);
    }
    return e;
  }

  /** Reset every kart to "on the grid" state. */
  reset() {
    for (const e of this.entries.values()) {
      e.lap = 1;
      e.gate = 0;
      e.prevU = e.u;
      e.arc = 0;
      e.arcAtLap = 0;
      e.progress = 0;
      e.best = 0;
      e.distToGate = this.length;
      e.finished = false;
      e.armed = false;
      e.teleports = 0;
      e.lapTimes.length = 0;
      e.lapStartedAt = null;
      e.lastLapTime = null;
    }
  }

  /** Place a kart on the grid: `u` is its starting projection. */
  seed(kart, u) {
    const e = this.entry(kart);
    e.prevU = wrap01(u || 0);
    e.u = e.prevU;
    e.arc = 0;
    e.arcAtLap = 0;
    e.gate = this.firstGateAhead(e.prevU);
    e.distToGate = this.forwardMetres(e.prevU, this.gates[e.gate]);
    e.progress = 0;
    e.best = 0;
    return e;
  }

  /** Index of the next checkpoint strictly ahead of `u`. */
  firstGateAhead(u) {
    let best = 0;
    let bestD = Infinity;
    for (let g = 0; g < this.gates.length; g++) {
      const d = forward01(u, this.gates[g]);
      if (d > 1e-6 && d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  /** @returns {number} metres from `fromU` forward to `toU` */
  forwardMetres(fromU, toU) {
    return forward01(fromU, toU) * this.length;
  }

  /**
   * Feed one frame of a kart's projected u.
   * @param {object} kart
   * @param {number} u       projection along the centerline (any value)
   * @param {number} time    race time in seconds
   * @returns {LapEvent|null}
   */
  update(kart, u, time = 0) {
    const e = this.entry(kart);
    const nextU = wrap01(u);
    if (e.prevU === null) {
      this.seed(kart, nextU);
      return null;
    }

    const du = wrapDelta(nextU - e.prevU);
    e.prevU = nextU;
    e.u = nextU;
    let event = null;

    if (Math.abs(du) > MAX_STEP) {
      // Teleport (respawn or external reset): resync without crediting anything.
      e.teleports++;
      e.gate = this.firstGateAhead(nextU);
    } else {
      const len = this.length;
      // Signed accumulated arc: reversing bleeds it off (so a kart can never
      // farm progress by driving backwards and re-covering ground) but it can
      // never fall more than a quarter lap below the current lap's start.
      e.arc += du * len;
      const floor = Math.max(0, e.arcAtLap - len * 0.25);
      if (e.arc < floor) e.arc = floor;

      if (du > 0) {
        const G = this.gates.length;
        let from = wrap01(nextU - du); // start of the traversed interval
        let d = du;

        // 1) ordered checkpoints, everything except the finish line
        while (e.gate < G - 1) {
          const rel = wrapDelta(this.gates[e.gate] - from);
          if (rel > 0 && rel <= d) {
            from = this.gates[e.gate];
            d -= rel;
            e.gate++;
          } else break;
        }

        // 2) the finish line (last gate)
        const relF = wrapDelta(this.finishU - from);
        if (relF > 0 && relF <= d) {
          if (e.gate === G - 1 && e.arc - e.arcAtLap >= len * 0.45) {
            // full ordered lap complete
            const lapStart = e.lapStartedAt === null ? 0 : e.lapStartedAt;
            const lapTime = Math.max(0, time - lapStart);
            e.lap += 1;
            e.arcAtLap = e.arc;
            e.lapStartedAt = time;
            e.lastLapTime = lapTime;
            e.lapTimes.push(lapTime);
            e.gate = 0;
            e.armed = true;
            if (e.lap > this.laps) {
              e.finished = true;
              event = { type: 'finish', lap: e.lap, lapTime, arc: e.arc };
            } else {
              event = { type: 'lap', lap: e.lap, lapTime, arc: e.arc };
            }
          } else {
            // Crossing the line is not a lap this time (starting-grid arming,
            // respawn near the line, or too little arc): if the finish gate was
            // the expected next gate, the next one in travel order is gate 0.
            e.armed = true;
            if (e.gate === G - 1) e.gate = 0;
          }
        }
      }
    }

    // 3) progress + tie-break distance
    if (!e.finished) {
      const frac = clamp((e.arc - e.arcAtLap) / this.length, -0.5, 0.9999);
      e.progress = (e.lap - 1) + frac;
      if (e.progress > e.best) e.best = e.progress;
      const gateU = this.gates[e.gate === undefined ? 0 : e.gate] ?? this.finishU;
      e.distToGate = wrapDelta(gateU - nextU) * this.length;
    }

    return event;
  }

  /** @returns {number} progress metric: `lap + fractionOfLap`, monotonic */
  progressOf(kart) {
    return this.entry(kart).progress;
  }

  /** @returns {object|undefined} */
  entryOf(kart) {
    return this.entries.get(kart);
  }

  /** Drop entries for karts that no longer exist. */
  prune(activeKarts) {
    const keep = new Set(activeKarts || []);
    for (const key of [...this.entries.keys()]) {
      if (!keep.has(key)) this.entries.delete(key);
    }
  }
}
