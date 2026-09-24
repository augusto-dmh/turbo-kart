/**
 * ============================================================================
 * TURBO KART — FX shared state (owned by Agent 5)
 * ============================================================================
 * A tiny module-level struct that `Effects` writes every frame and `PostFX`
 * reads. It exists so the two FX modules can share presentation state without
 * touching the frozen contract (no new bus events) and without reading
 * `window.__TURBO_KART__`.
 *
 * It is intentionally a plain mutable object: no allocation, no imports.
 */

/** @typedef {{
 *   speed:number, speedNorm:number, boost:number, driftLevel:number,
 *   flash:number, shake:number, quality:string, particles:number, active:boolean
 * }} FxState */

/** @type {FxState} */
export const fxState = {
  /** Absolute speed of the reference (player) kart in m/s. */
  speed: 0,
  /** Speed normalized to 0..1 against a nominal top speed. */
  speedNorm: 0,
  /** Boost envelope 0..1 (set by `KART_BOOST` / `KART_DRIFT_BOOST`, decays). */
  boost: 0,
  /** Drift stage of the reference kart: 0, 1 or 2. */
  driftLevel: 0,
  /** Full-screen flash 0..1 (lightning, explosions). */
  flash: 0,
  /** Suggested camera shake 0..1 (PostFX may ignore it). */
  shake: 0,
  /** Last quality preset applied by `Effects`. */
  quality: 'high',
  /** Live particle count (debug / HUD). */
  particles: 0,
  /** True while a race is active (set on RACE_START, cleared on RACE_COMPLETE). */
  active: false,
};

/** Nominal top speed used to normalize `speedNorm`. */
export const FX_TOP_SPEED = 55;

/**
 * Reset the shared state. Called by `Effects.dispose()`.
 * @param {Partial<FxState>} [patch]
 */
export function resetFxState(patch = {}) {
  fxState.speed = 0;
  fxState.speedNorm = 0;
  fxState.boost = 0;
  fxState.driftLevel = 0;
  fxState.flash = 0;
  fxState.shake = 0;
  fxState.particles = 0;
  fxState.active = false;
  Object.assign(fxState, patch);
}
