/**
 * ============================================================================
 * TURBO KART — racing line + speed profile (Agent 3)
 * ============================================================================
 * Built once per track (cached and shared by every AI driver) from the
 * centerline exposed by `TrackApi`:
 *
 *   1. sample the centerline, its tangent and its +lateral basis;
 *   2. measure the **signed curvature**, smoothed over ~3 m;
 *   3. detect corners (runs of curvature above a relative threshold) and build
 *      lateral offsets: wide on entry, clipped to the inside at the apex, wide
 *      on exit. `trackApi.aiRacingLine` / `trackDef.aiRacingLine` hints, when
 *      present, override the generated offset locally;
 *   4. derive a **speed profile** as a 0..1 ratio of the driver's top speed:
 *      cornering is limited by a lateral-grip budget, a yaw-rate budget and a
 *      braking pass that walks the profile backwards around the loop;
 *   5. tag medium/long corners as **drift zones**.
 *
 * Everything is stored in typed arrays; methods are O(1) with linear
 * interpolation, zero allocation. No THREE import (node-testable).
 * ============================================================================
 */

import { clamp, circularBlur, wrap01 } from '../race/progress.js';

/** Lateral offsets never use more than `halfWidth - INSET_MARGIN`. */
const INSET_MARGIN = 1.6;
/** Relative curvature threshold for corner detection. */
const CORNER_REL = 0.4;
const CORNER_ABS = 0.004;
/** Wings (wide entry / exit) length in metres, and how far outside they go. */
const WING_MIN_M = 8;
const WING_MAX_M = 42;
const WING_AMOUNT = 0.5;
/** How much of the sample is "inside" at the apex. */
const APEX_MIN = 0.55;
/** Speed-profile model constants. */
const V_REF = 30; // m/s nominal top speed the profile is normalised to
const A_LAT = 20; // m/s^2 lateral grip budget
const YAW_AUTHORITY = 1.9; // rad/s of usable yaw rate at the tyre limit
const YAW_SAFETY = 0.65;
const A_BRAKE = 15; // m/s^2 braking budget for the backward pass
const MIN_RATIO = 0.3;
/** A corner at least this long is worth drifting. */
const DRIFT_MIN_M = 8;
const DRIFT_MIN_K = 0.009;

/** @type {Map<string, RacingLine>} */
const CACHE = new Map();
const MAX_CACHE = 4;

export class RacingLine {
  /**
   * Shared per-track instance. `trackApi` must expose `pointAt`, `tangentAt`,
   * `length` and `halfWidth`.
   * @param {{trackApi:any, trackDef?:any}} opts
   * @returns {RacingLine}
   */
  static get({ trackApi, trackDef = null }) {
    const key = [
      trackApi?.id || 'track',
      Math.round(Number(trackApi?.length) || 0),
      Math.round((Number(trackApi?.halfWidth) || 0) * 10),
    ].join('|');
    let line = CACHE.get(key);
    if (!line) {
      line = new RacingLine({ trackApi, trackDef });
      if (CACHE.size >= MAX_CACHE) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(key, line);
    }
    return line;
  }

  /** Test/debug helper — forget every cached track. */
  static clearCache() {
    CACHE.clear();
  }

  /**
   * @param {{trackApi:any, trackDef?:any}} opts
   */
  constructor({ trackApi, trackDef = null } = {}) {
    this.trackApi = trackApi;
    this.trackDef = trackDef || trackApi?.trackDef || trackApi?.def || null;
    this.length = Math.max(20, Number(trackApi?.length) || 600);
    this.halfWidth = Math.max(3, Number(trackApi?.halfWidth) || 8);
    this.maxInset = Math.max(0.8, this.halfWidth - INSET_MARGIN);
    this.n = clamp(Math.round(this.length / 3), 192, 512) | 0;
    this.ds = this.length / this.n;

    /** @type {Array<{start:number,len:number,dir:number,peak:number,metres:number}>} */
    this.corners = [];

    this.cx = new Float32Array(this.n);
    this.cy = new Float32Array(this.n);
    this.cz = new Float32Array(this.n);
    this.tx = new Float32Array(this.n);
    this.tz = new Float32Array(this.n);
    this.curv = new Float32Array(this.n);
    this.curvS = new Float32Array(this.n);
    this.offset = new Float32Array(this.n);
    this.speed = new Float32Array(this.n);
    this.drift = new Uint8Array(this.n);
    this.driftLen = new Float32Array(this.n);

    if (trackApi?.pointAt && trackApi?.tangentAt) this.build();
    else this.speed.fill(1);
  }

  // ------------------------------------------------------------ build -----

  build() {
    const api = this.trackApi;
    const n = this.n;
    const { cx, cy, cz, tx, tz, curv, curvS, offset } = this;

    const bx = new Float32Array(n);
    const bz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const c = api.pointAt(u, 0);
      const t = api.tangentAt(u);
      const l = api.pointAt(u, 1);
      cx[i] = Number(c?.x) || 0;
      cy[i] = Number(c?.y) || 0;
      cz[i] = Number(c?.z) || 0;
      const tl = Math.hypot(Number(t?.x) || 0, Number(t?.z) || 0) || 1;
      tx[i] = (Number(t?.x) || 0) / tl;
      tz[i] = (Number(t?.z) || 0) / tl;
      const dx = (Number(l?.x) || 0) - cx[i];
      const dz = (Number(l?.z) || 0) - cz[i];
      const dl = Math.hypot(dx, dz) || 1;
      bx[i] = dx / dl;
      bz[i] = dz / dl;
    }

    // Signed curvature, positive when the track bends toward +lateral.
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const dtx = tx[b] - tx[a];
      const dtz = tz[b] - tz[a];
      const towardLateral = dtx * bx[i] + dtz * bz[i];
      const along = tx[a] * tx[b] + tz[a] * tz[b];
      curv[i] = Math.atan2(towardLateral, along) / (2 * this.ds);
    }
    const smooth = circularBlur(curv, clamp(Math.round(n * 0.01), 1, 5), 2);
    curvS.set(smooth);

    this._findCorners();
    this._buildOffsets(offset);
    this._applyHints(offset);
    const blurred = circularBlur(offset, 3, 1);
    for (let i = 0; i < n; i++) offset[i] = clamp(blurred[i], -this.maxInset, this.maxInset);
    this._buildSpeedProfile();
  }

  _findCorners() {
    const n = this.n;
    const { curvS } = this;
    let maxK = 0;
    for (let i = 0; i < n; i++) maxK = Math.max(maxK, Math.abs(curvS[i]));
    const thresh = Math.max(CORNER_ABS, CORNER_REL * maxK);

    const runs = [];
    let start = -1;
    for (let i = 0; i < n; i++) {
      const on = Math.abs(curvS[i]) >= thresh;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        runs.push({ start, len: i - start });
        start = -1;
      }
    }
    if (start >= 0) {
      const tail = { start, len: n - start };
      if (runs.length && runs[0].start === 0) {
        // corner straddles u = 0: merge tail + head
        runs[0] = { start, len: tail.len + runs[0].len };
      } else {
        runs.push(tail);
      }
    }

    this.corners.length = 0;
    for (const r of runs) {
      let sum = 0;
      let peak = 0;
      for (let j = 0; j < r.len; j++) {
        const k = curvS[(r.start + j) % n];
        sum += k;
        if (Math.abs(k) > Math.abs(peak)) peak = k;
      }
      const dir = sum >= 0 ? 1 : -1;
      const metres = r.len * this.ds;
      this.corners.push({ start: r.start, len: r.len, dir, peak, metres });
    }
  }

  _buildOffsets(offset) {
    const n = this.n;
    const maxInset = this.maxInset;
    for (const c of this.corners) {
      const len = c.len;
      const dir = c.dir;
      // apex clipping
      for (let j = 0; j < len; j++) {
        const idx = (c.start + j) % n;
        const t = len > 1 ? j / (len - 1) : 0.5;
        const inside = APEX_MIN + (1 - APEX_MIN) * Math.sin(Math.PI * t);
        offset[idx] += dir * maxInset * inside;
      }
      // wide entry + wide exit
      const wing = clamp(Math.round(clamp(c.metres * 0.6, WING_MIN_M, WING_MAX_M) / this.ds), 2, Math.round(n * 0.1));
      for (let j = 1; j <= wing; j++) {
        const t = j / wing;
        const amt = -dir * maxInset * WING_AMOUNT * Math.sin(Math.PI * t);
        offset[(c.start - j + n * 2) % n] += amt;
        offset[(c.start + len - 1 + j) % n] += amt;
      }
    }
  }

  _applyHints(offset) {
    const api = this.trackApi;
    const hints = api?.aiRacingLine || this.trackDef?.aiRacingLine || null;
    if (!Array.isArray(hints) || hints.length === 0) return;
    const n = this.n;
    const blend = 0.65;
    if (typeof hints[0] === 'number') {
      // One lateral value per hint sample; resample onto our grid.
      for (let i = 0; i < n; i++) {
        const h = hints[Math.min(hints.length - 1, Math.floor((i / n) * hints.length))];
        if (Number.isFinite(h)) offset[i] = offset[i] * (1 - blend) + clamp(h, -this.maxInset, this.maxInset) * blend;
      }
    } else if (hints[0] && typeof hints[0] === 'object') {
      for (const h of hints) {
        if (!h || !Number.isFinite(h.u) || !Number.isFinite(h.lateral)) continue;
        const centre = Math.floor(wrap01(h.u) * n) % n;
        const spread = 4;
        for (let j = -spread; j <= spread; j++) {
          const w = blend * (1 - Math.abs(j) / (spread + 1));
          const idx = (centre + j + n * 2) % n;
          offset[idx] = offset[idx] * (1 - w) + clamp(h.lateral, -this.maxInset, this.maxInset) * w;
        }
      }
    }
  }

  _buildSpeedProfile() {
    const n = this.n;
    const absK = new Float32Array(n);
    for (let i = 0; i < n; i++) absK[i] = Math.abs(this.curvS[i]);
    const kSmooth = circularBlur(absK, clamp(Math.round(n * 0.012), 1, 6), 2);

    const ratio = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ak = Math.max(kSmooth[i], 1e-4);
      const vGrip = Math.sqrt(A_LAT / ak);
      const vYaw = (YAW_SAFETY * YAW_AUTHORITY) / ak;
      const v = clamp(Math.min(V_REF, vGrip, vYaw), V_REF * MIN_RATIO, V_REF);
      ratio[i] = v / V_REF;
    }

    // Backward braking pass (two wraps so a lap-long chain propagates).
    const c = (2 * A_BRAKE * this.ds) / (V_REF * V_REF);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const nxt = ratio[(i + 1) % n];
        const cap = Math.sqrt(nxt * nxt + c);
        if (ratio[i] > cap) ratio[i] = cap;
      }
    }
    const smooth = circularBlur(ratio, 2, 1);
    this.speed.set(smooth);

    // Drift zones: medium/long corners.
    this.drift.fill(0);
    this.driftLen.fill(0);
    for (const cdef of this.corners) {
      if (cdef.metres < DRIFT_MIN_M || Math.abs(cdef.peak) < DRIFT_MIN_K) continue;
      for (let j = 0; j < cdef.len; j++) {
        const idx = (cdef.start + j) % n;
        this.drift[idx] = 1;
        this.driftLen[idx] = cdef.metres;
      }
    }
  }

  // ---------------------------------------------------------- sampling ----

  /** @returns {number} sample index for a u value */
  indexOf(u) {
    const i = Math.floor(wrap01(u) * this.n);
    return i >= this.n ? this.n - 1 : i < 0 ? 0 : i;
  }

  /** Linear sample interpolation with wrap-around. @returns {number} */
  _sample(arr, u) {
    const n = this.n;
    const x = wrap01(u) * n;
    const i0 = Math.floor(x) % n;
    const i1 = (i0 + 1) % n;
    const t = x - Math.floor(x);
    return arr[i0] * (1 - t) + arr[i1] * t;
  }

  /** Lateral offset target (metres, signed) at `u`. */
  offsetAt(u) {
    return this._sample(this.offset, u);
  }

  /** Signed curvature (1/m) at `u`. */
  curvatureAt(u) {
    return this._sample(this.curvS, u);
  }

  /** Speed ratio (0..1 of the driver's top speed) at `u`. */
  speedAt(u) {
    return this._sample(this.speed, u);
  }

  /** True when the sample at `u` is inside a medium/long corner. */
  driftZoneAt(u) {
    return this.drift[this.indexOf(u)] === 1;
  }

  /** Metres of the corner containing `u` (0 outside corners). */
  driftLengthAt(u) {
    return this.driftLen[this.indexOf(u)];
  }

  /** Max |curvature| in the window `[u, u + metres]`. */
  maxCurvatureAhead(u, metres) {
    const n = this.n;
    const steps = Math.max(1, Math.round(metres / this.ds));
    let i = this.indexOf(u);
    let m = 0;
    for (let s = 0; s < steps; s++) {
      const k = Math.abs(this.curvS[i]);
      if (k > m) m = k;
      i = (i + 1) % n;
    }
    return m;
  }

  /** True when a drift-worth corner starts within `metres`. */
  driftTargetAhead(u, metres) {
    const n = this.n;
    const steps = Math.max(1, Math.round(metres / this.ds));
    let i = this.indexOf(u);
    let seen = 0;
    for (let s = 0; s < steps; s++) {
      const len = this.driftLen[i];
      if (len > 0) seen = Math.max(seen, len);
      i = (i + 1) % n;
    }
    return seen;
  }

  /** The corner descriptor containing `u`, or null. */
  cornerAt(u) {
    const i = this.indexOf(u);
    for (const c of this.corners) {
      const rel = (i - c.start + this.n) % this.n;
      if (rel < c.len) return c;
    }
    return null;
  }

  /** Free-form debug snapshot for tooling. */
  debugInfo() {
    return {
      n: this.n,
      length: this.length,
      halfWidth: this.halfWidth,
      maxInset: this.maxInset,
      corners: this.corners.length,
      minSpeedRatio: Math.min(...this.speed),
    };
  }
}
