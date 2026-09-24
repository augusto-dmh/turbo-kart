/**
 * ============================================================================
 * TURBO KART — deterministic RNG helpers (Agent 1)
 * ============================================================================
 * Gameplay-relevant randomness (visual variation, bumpiness, spin direction)
 * uses these so a race can be reproduced from a seed. FX-only randomness may
 * still use `Math.random()` per the project conventions.
 * ============================================================================
 */

/**
 * mulberry32 — small, fast, decent-quality 32-bit PRNG.
 * @param {number} seed
 * @returns {() => number} generator returning [0,1)
 */
export function createRng(seed = 1) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a string hash → unsigned 32-bit int. Stable across runs/platforms.
 * @param {string} str @returns {number}
 */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Convenience: seeded RNG for a named entity plus an index salt.
 * @param {string} name @param {number} salt @returns {() => number}
 */
export function rngFor(name, salt = 0) {
  return createRng(hashString(name) ^ Math.imul(salt | 0, 0x9e3779b1));
}
