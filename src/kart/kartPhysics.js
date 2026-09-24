/**
 * ============================================================================
 * TURBO KART — kart physics tuning (Agent 1)
 * ============================================================================
 * Every number that defines how a kart drives lives here so the feel can be
 * tuned in one place. Units: meters, seconds, radians.
 *
 * Stat mapping (stats are 1..5 from `CHARACTERS`):
 *   speed  → top speed        27.5 … 34.5 m/s   (99 … 124 km/h)
 *   accel  → engine force     12.5 … 21.7 m/s²
 *   grip   → lateral grip      9.0 … 15.0 (1/s)
 *   weight → mass / shove     1.0 … 1.88
 * ============================================================================
 */

export const KART_TUNING = {
  // ---- longitudinal ------------------------------------------------------
  baseTopSpeed: 27.5,
  topSpeedPerStat: 1.75,
  baseAccel: 12.5,
  accelPerStat: 2.3,
  accelFalloff: 0.75,       // how strongly acceleration tapers near top speed
  brakeDecel: 30,           // m/s² while braking
  reverseAccel: 9,          // m/s² when stopped and holding brake
  reverseMax: 7,            // m/s reverse speed cap
  drag: 0.0016,             // quadratic drag coefficient
  rollResist: 0.06,         // linear drag while coasting (1/s)
  overspeedEase: 1.6,       // how fast over-speed decays after a boost ends
  slopeFactor: 0.85,        // gravity component along the road
  boostPowerToMult: 0.2,    // top-speed multiplier per boost power
  boostAccel: 15,           // extra m/s² while boosting
  boostMaxPower: 2.2,

  // ---- steering / grip ---------------------------------------------------
  maxYawRate: 1.95,         // rad/s at full steering authority
  lateralGripBase: 8.0,     // 1/s rate at which momentum rotates to the heading
  lateralGripPerStat: 2.2,
  lowSpeedTurn: 6.5,        // m/s where full steering authority is reached
  highSpeedTurnDrop: 0.32,  // authority lost at top speed
  offroadGripScale: 0.62,
  iceGripScale: 0.16,
  minGrip: 1.8,             // grip floor so ice+drift never becomes uncontrollable
  airGripScale: 0.1,
  airSteerScale: 0.42,

  // ---- drift -------------------------------------------------------------
  hopSpeed: 4.3,            // vertical launch of the drift hop
  hopMinSpeed: 5.5,
  driftMinSpeed: 7.5,
  driftGripScale: 0.22,     // lateral grip while drifting (slip ≈ yawRate/grip)
  slipScrub: 0.16,          // speed scrubbed per radian of slip (1/s)
  driftTurnRate: 1.35,      // rad/s base drift yaw rate
  driftTurnGain: 0.4,       // tightening when steering into the drift
  driftTurnLoosen: 0.6,     // widening when steering against it
  driftOutward: 1.2,        // m/s² outward push while sliding
  driftSteerStart: 0.12,    // |steer| needed to initiate a drift
  driftSteerCharge: -0.2,   // charge unless the player counter-steers hard
  driftChargeSpeedBonus: 0.3,
  stageTimes: [1.05, 2.15, 3.25],   // seconds to blue / orange / purple
  stageBoostPower: [1.0, 1.32, 1.72],
  stageBoostTime: [0.95, 1.45, 1.95],

  // ---- surfaces ----------------------------------------------------------
  offroadTopSpeedScale: 0.55,
  offroadExtraRoll: 3.4,    // added rolling resistance off-road
  offroadBump: 0.055,       // visual bump amplitude off-road

  // ---- air / ramps -------------------------------------------------------
  gravity: 22,
  airPitchGain: 0.5,
  rampLaunchBase: 7.0,
  rampLaunchPerSpeed: 0.34,
  landingHardImpact: 7.5,
  landingSquashTime: 0.3,

  // ---- collisions --------------------------------------------------------
  collisionRadius: 0.9,
  collisionRestitution: 0.32,
  collisionSpeedLoss: 0.04,
  hardHitImpact: 6.5,
  spinOutTime: 1.15,

  // ---- status ------------------------------------------------------------
  frozenSpeedScale: 0.16,
  frozenMaxSpeed: 4.5,
  frozenSteerScale: 0.35,
  invincibleSpeedMult: 1.08,

  // ---- recovery ----------------------------------------------------------
  respawnInvincible: 1.6,
  respawnSpeedFactor: 0.5,
  stuckTime: 3.0,
  stuckSpeed: 3.0,
  wrongWayDot: -0.3,
  wrongWayDelay: 0.7,

  // ---- barriers (approximation until the track exposes real walls) -------
  wallSoftMargin: 7.0,      // lateral margin where drag starts
  wallHardMargin: 16.0,     // lateral margin where the kart is stopped
  wallPush: 18,             // inward acceleration at the hard limit
  wallDamp: 10,             // outward velocity damping rate (1/s)
  wallSpeedLoss: 0.35,
  wallSparkSpeed: 9,

  // ---- gimmicks / draft --------------------------------------------------
  gimmickCooldown: 0.6,
  gimmickLengthMeters: 10,  // u-window size for pad/ramp detection
  gimmickLateralMargin: 2.8,
  padBoostPower: 0.8,
  padBoostTime: 1.15,
  draftRange: 22,
  draftCone: 0.94,
  draftTopSpeedMult: 1.03,
  draftAccel: 3.5,
};

/**
 * @param {{speed:number,accel:number,grip:number,weight:number}} stats
 * @returns {{topSpeed:number, accel:number, gripRate:number, mass:number}}
 */
export function deriveKartTuning(stats) {
  const s = stats || { speed: 3, accel: 3, grip: 3, weight: 3 };
  return {
    topSpeed: KART_TUNING.baseTopSpeed + (s.speed - 1) * KART_TUNING.topSpeedPerStat,
    accel: KART_TUNING.baseAccel + (s.accel - 1) * KART_TUNING.accelPerStat,
    gripRate: KART_TUNING.lateralGripBase + (s.grip - 1) * KART_TUNING.lateralGripPerStat,
    mass: 1.0 + (s.weight - 1) * 0.22,
  };
}

/** Top-speed multiplier for a boost of the given power. */
export function boostMultiplier(power) {
  return 1 + KART_TUNING.boostPowerToMult * Math.max(0, power);
}

/**
 * Drift stage for an accumulated charge time.
 * @param {number} t seconds @returns {-1|0|1|2} -1 = not charged yet
 */
export function stageForCharge(t) {
  const st = KART_TUNING.stageTimes;
  if (t >= st[2]) return 2;
  if (t >= st[1]) return 1;
  if (t >= st[0]) return 0;
  return -1;
}

/** Progress 0..1 inside the current drift stage. */
export function chargeProgress(t) {
  const st = KART_TUNING.stageTimes;
  if (t >= st[2]) return 1;
  if (t >= st[1]) return (t - st[1]) / (st[2] - st[1]);
  if (t >= st[0]) return (t - st[0]) / (st[1] - st[0]);
  return t / st[0];
}

export default KART_TUNING;
