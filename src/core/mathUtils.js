/**
 * ============================================================================
 * TURBO KART — shared math helpers (Agent 1)
 * ============================================================================
 * Pure scalar/array helpers with no imports, used by the engine, camera rig,
 * input and kart physics. Everything here is allocation-free.
 *
 * Angle conventions used across Agent 1 modules:
 *  - Kart yaw: `forward = (sin(yaw), 0, cos(yaw))`.
 *  - `steer > 0` means "turn left" (+X when facing +Z), matching the track
 *    convention "positive lateral = left of travel".
 * ============================================================================
 */

/** @param {number} v @param {number} a @param {number} b @returns {number} */
export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** @param {number} a @param {number} b @param {number} t @returns {number} */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** @param {number} v @param {number} a @param {number} b @returns {number} 0..1 */
export function invLerp(a, b, v) {
  return b === a ? 0 : clamp((v - a) / (b - a), 0, 1);
}

/** @param {number} t @returns {number} smoothstep(0,1,t) */
export function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** @param {number} t @returns {number} */
export function easeOutCubic(t) {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

/**
 * Frame-rate independent exponential smoothing (critically-damped-ish).
 * @param {number} current @param {number} target @param {number} lambda (1/s)
 * @param {number} dt @returns {number}
 */
export function damp(current, target, lambda, dt) {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap into [0,1). */
export function wrap01(u) {
  return u - Math.floor(u);
}

/** Shortest signed difference `a - b` wrapped into (-0.5, 0.5]. */
export function wrapDelta(a, b) {
  let d = wrap01(a) - wrap01(b);
  if (d > 0.5) d -= 1;
  else if (d <= -0.5) d += 1;
  return d;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  else if (x <= -Math.PI) x += Math.PI * 2;
  return x;
}

/** Shortest signed angle from `b` to `a`. */
export function angleDelta(a, b) {
  return wrapAngle(a - b);
}

/** Exponential smoothing for angles (takes the short way around). */
export function dampAngle(current, target, lambda, dt) {
  if (dt <= 0) return current;
  return current + angleDelta(target, current) * (1 - Math.exp(-lambda * dt));
}

/** Numeric safety net: returns `fallback` when `v` is not finite. */
export function safe(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Unity-style critically damped spring for a single axis.
 * @param {number} current @param {number} target
 * @param {{v:number}} velocity holder @param {number} smoothTime seconds
 * @param {number} dt @returns {number}
 */
export function smoothDamp(current, target, velocity, smoothTime, dt) {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity.v + omega * change) * dt;
  velocity.v = (velocity.v - omega * temp) * exp;
  const out = target + (change + temp) * exp;
  return Number.isFinite(out) ? out : target;
}

/** Scalar value with an associated spring velocity, for `smoothDamp`. */
export class SpringValue {
  /** @param {number} value */
  constructor(value = 0) {
    this.value = value;
    this.velocity = { v: 0 };
  }

  /** @param {number} value */
  reset(value) {
    this.value = value;
    this.velocity.v = 0;
    return this;
  }

  /** @param {number} target @param {number} smoothTime @param {number} dt */
  update(target, smoothTime, dt) {
    this.value = smoothDamp(this.value, target, this.velocity, smoothTime, dt);
    return this.value;
  }
}
