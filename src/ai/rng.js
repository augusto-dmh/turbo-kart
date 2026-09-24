/**
 * ============================================================================
 * TURBO KART — seeded RNG for gameplay (Agent 3)
 * ============================================================================
 * mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Gameplay randomness
 * (AI mistakes, item roulette, personality jitter) uses this so races are
 * reproducible in tests: the same track + difficulty + kart index always
 * produces the same roll sequence.
 *
 * Do not use `Math.random()` for anything that affects gameplay.
 * ============================================================================
 */

/** FNV-1a 32-bit hash of a string. @returns {number} unsigned */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * mulberry32 PRNG.
 * @param {number|string} seed
 * @returns {() => number} generator returning [0, 1)
 */
export function mulberry32(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed | 0) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small convenience wrapper around mulberry32. */
export class Rng {
  /** @param {number|string} seed */
  constructor(seed = 1) {
    this.seed = seed;
    this._next = mulberry32(seed);
  }

  /** @returns {number} [0, 1) */
  next() {
    return this._next();
  }

  /** @returns {number} [a, b) */
  range(a, b) {
    return a + (b - a) * this._next();
  }

  /** @returns {number} integer in [a, b] */
  int(a, b) {
    return a + Math.floor(this._next() * (b - a + 1));
  }

  /** @param {number} p probability [0,1] @returns {boolean} */
  chance(p) {
    return this._next() < p;
  }

  /** @param {any[]} arr */
  pick(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(this._next() * arr.length) % arr.length];
  }

  /**
   * Weighted pick.
   * @param {Array<{w:number}>} entries non-empty, weights >= 0
   * @returns {any|null}
   */
  weighted(entries) {
    if (!entries || !entries.length) return null;
    let total = 0;
    for (const e of entries) total += Math.max(0, e.w || 0);
    if (total <= 0) return entries[0];
    let r = this._next() * total;
    for (const e of entries) {
      r -= Math.max(0, e.w || 0);
      if (r <= 0) return e;
    }
    return entries[entries.length - 1];
  }

  /** Derive an independent stream (per-driver / per-system sub-seeds). */
  fork(salt = '') {
    return new Rng((hashString(String(this.seed)) ^ hashString(salt)) >>> 0);
  }
}

/**
 * Build a deterministic RNG from mixed seed parts.
 * @param {...(string|number)} parts
 * @returns {Rng}
 */
export function createRng(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) h = (Math.imul(h ^ hashString(String(p ?? '')), 16777619) >>> 0);
  return new Rng(h >>> 0);
}
