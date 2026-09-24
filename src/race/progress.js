/**
 * ============================================================================
 * TURBO KART — race progress math (Agent 3)
 * ============================================================================
 * Pure, dependency-free helpers shared by `RaceManager` (lap validation and
 * standings) and by the AI drivers (track-space navigation).
 *
 * Keeping these functions free of THREE and of any subsystem import makes the
 * race logic trivially unit-testable in plain node.
 *
 * Conventions (see docs/CONVENTIONS.md):
 *  - `u` is normalized progress along the centerline, [0, 1) in travel order.
 *  - "left" of a traveller facing `forward` with Y up is `up × forward`.
 * ============================================================================
 */

export const TAU = Math.PI * 2;

/** Clamp `v` into [a, b]. @returns {number} */
export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Linear interpolation, no clamping. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Wrap `u` into [0, 1). */
export function wrap01(u) {
  const x = u % 1;
  return x < 0 ? x + 1 : x;
}

/**
 * Wrap a u-delta into (-0.5, 0.5] — the shortest signed distance between two
 * points on a closed loop. Positive = forward (increasing u).
 */
export function wrapDelta(d) {
  const x = wrap01(d);
  return x > 0.5 ? x - 1 : x;
}

/** Forward distance from `from` to `to` in u units, always in [0, 1). */
export function forward01(from, to) {
  return wrap01(to - from);
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  let x = a % TAU;
  if (x <= -Math.PI) x += TAU;
  else if (x > Math.PI) x -= TAU;
  return x;
}

/**
 * Signed angle from a heading to a target, positive when the target is to the
 * **left** of the heading (world space, Y up: left = up × forward).
 *
 * @param {number} fx forward x (unit)
 * @param {number} fz forward z (unit)
 * @param {number} tx target direction x (need not be normalized)
 * @param {number} tz target direction z
 * @returns {number} radians in (-PI, PI]
 */
export function angleToLeft(fx, fz, tx, tz) {
  return Math.atan2(tx * fz - tz * fx, tx * fx + tz * fz);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current, target, maxDelta) {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

/**
 * Circular box blur of a Float32Array (used for curvature smoothing).
 * @param {Float32Array} src
 * @param {number} radius samples
 * @param {number} [passes]
 * @returns {Float32Array}
 */
export function circularBlur(src, radius, passes = 1) {
  const n = src.length;
  if (radius < 1 || n === 0) return src.slice();
  let a = src;
  let b = new Float32Array(n);
  const r = Math.min(radius, (n >> 1) - 1);
  if (r < 1) return src.slice();
  const inv = 1 / (r * 2 + 1);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += a[(i + j + n) % n];
      b[i] = sum * inv;
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}
