/**
 * ============================================================================
 * TURBO KART — FROZEN CONTRACT
 * ============================================================================
 * This file is the single source of truth shared by every subsystem.
 * It is owned by the orchestrator. Subsystem agents MUST import from it and
 * MUST NOT edit it. If a change is required, document it in your report and
 * add a new export instead of breaking an existing one.
 *
 * Conventions:
 *  - Units: meters, seconds, radians. Y is up. Right-handed coordinates.
 *  - `u` is normalized track progress in [0,1) measured along the centerline.
 *  - lateral offset is signed: positive = left of the direction of travel.
 * ============================================================================
 */

/** Quality presets, ordered low → ultra. */
export const QUALITY_PRESETS = ['low', 'medium', 'high', 'ultra'];

/** AI difficulty tiers, ordered easy → expert. */
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'];

/** Game modes. */
export const MODES = {
  GP: 'gp', // 8 karts, items on, 3 laps
  VERSUS: 'versus', // 8 karts, items on
  TIME_TRIAL: 'timeTrial', // solo, no items, beat the clock
};

/** Global race tuning shared by every subsystem. */
export const RACE = {
  LAPS: 3,
  KART_COUNT: 8,
  COUNTDOWN_SECONDS: 3.4, // total countdown length before "GO!"
  ROCKET_START_WINDOW: 0.35, // seconds before GO in which throttle gives a boost
  ITEM_BOX_RESPAWN: 5.0, // seconds until a used item box returns
  FINISH_PLACE_POINTS: [15, 12, 10, 8, 6, 4, 2, 1], // GP points by place
  PLAYER_START_PLACE: 8, // player always starts last on the grid
};

/**
 * The eight playable characters. `id` is frozen — meshes, AI, UI and audio all
 * key off these ids. `stats` are 1..5 (5 = best).
 * @typedef {{id:string,name:string,color:number,accent:number,stats:{speed:number,accel:number,grip:number,weight:number},tagline:string}} CharacterDef
 * @type {CharacterDef[]}
 */
export const CHARACTERS = [
  { id: 'blaze', name: 'Blaze', color: 0xff3b30, accent: 0xffc400, stats: { speed: 5, accel: 3, grip: 3, weight: 4 }, tagline: 'Top speed monster' },
  { id: 'nova', name: 'Nova', color: 0x7b5cff, accent: 0x00e5ff, stats: { speed: 4, accel: 4, grip: 4, weight: 3 }, tagline: 'Perfectly balanced' },
  { id: 'bolt', name: 'Bolt', color: 0xffd400, accent: 0x1b1b1b, stats: { speed: 3, accel: 5, grip: 4, weight: 2 }, tagline: 'Lightning launches' },
  { id: 'viper', name: 'Viper', color: 0x27d17f, accent: 0x0d2b1e, stats: { speed: 3, accel: 4, grip: 5, weight: 2 }, tagline: 'Corners on rails' },
  { id: 'rosie', name: 'Rosie', color: 0xff6fb5, accent: 0xfff3f8, stats: { speed: 3, accel: 4, grip: 4, weight: 3 }, tagline: 'Sweet but quick' },
  { id: 'tank', name: 'Tank', color: 0x6f7f3a, accent: 0x2c2c2c, stats: { speed: 4, accel: 2, grip: 3, weight: 5 }, tagline: 'Immovable object' },
  { id: 'frost', name: 'Frost', color: 0x4fc3ff, accent: 0xeaffff, stats: { speed: 4, accel: 3, grip: 5, weight: 3 }, tagline: 'Ice-cold lines' },
  { id: 'zumi', name: 'Zumi', color: 0x1f2430, accent: 0xff2e63, stats: { speed: 5, accel: 3, grip: 4, weight: 3 }, tagline: 'Silent and fast' },
];

/** @param {string} id */
export function getCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

/**
 * The three tracks. `id`/`name`/`theme`/`laps` are frozen so the UI can build
 * menus without the track implementation. Control points live in
 * `src/track/trackData.js` (owned by Agent 2).
 * @typedef {{id:string,name:string,theme:string,laps:number,difficulty:number,description:string}} TrackMeta
 * @type {TrackMeta[]}
 */
export const TRACKS = [
  { id: 'sunset-speedway', name: 'Sunset Speedway', theme: 'sunset', laps: 3, difficulty: 1, description: 'Coastal high-speed sweepers at golden hour.' },
  { id: 'desert-dunes', name: 'Desert Dunes', theme: 'desert', laps: 3, difficulty: 2, description: 'Canyon switchbacks, big air off the dunes.' },
  { id: 'frozen-peaks', name: 'Frozen Peaks', theme: 'snow', laps: 3, difficulty: 3, description: 'Low-grip ice, tight alpine hairpins.' },
];

/** @param {string} id */
export function getTrackMeta(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS[0];
}

/**
 * Item ids (frozen). Metadata is consumed by the HUD and audio layers.
 * @typedef {{id:string,name:string,icon:string,color:number,offensive:boolean}} ItemDef
 * @type {Record<string, ItemDef>}
 */
export const ITEMS = {
  mushroom: { id: 'mushroom', name: 'Mushroom', icon: '🍄', color: 0xff4d4d, offensive: false },
  'triple-mushroom': { id: 'triple-mushroom', name: 'Triple Mushrooms', icon: '🍄🍄', color: 0xff7043, offensive: false },
  banana: { id: 'banana', name: 'Banana', icon: '🍌', color: 0xffe14d, offensive: true },
  'green-shell': { id: 'green-shell', name: 'Green Shell', icon: '🟢', color: 0x2ecc71, offensive: true },
  'red-shell': { id: 'red-shell', name: 'Red Shell', icon: '🔴', color: 0xe74c3c, offensive: true },
  'triple-shell': { id: 'triple-shell', name: 'Triple Shells', icon: '🔴🟢', color: 0x9b59b6, offensive: true },
  star: { id: 'star', name: 'Star', icon: '⭐', color: 0xfff176, offensive: false },
  lightning: { id: 'lightning', name: 'Lightning', icon: '⚡', color: 0x8e7cff, offensive: true },
};

/** Every event name on the shared bus. Emit with `{ ...payload }`. */
export const EVENTS = {
  // ---- lifecycle / UI -----------------------------------------------------
  GAME_STATE: 'game:state', // { state, prev }
  UI_RACE_CONFIG: 'ui:race-config', // { trackId, characterId, difficulty, mode }
  UI_PAUSE: 'ui:pause', // {}
  UI_RESUME: 'ui:resume', // {}
  UI_RESTART: 'ui:restart', // {}
  UI_QUIT: 'ui:quit', // {}
  UI_SETTINGS: 'ui:settings', // { quality, master, music, sfx, cameraMode }
  UI_READY: 'ui:ready', // {} menus finished booting

  // ---- race flow ----------------------------------------------------------
  RACE_COUNTDOWN: 'race:countdown', // { value } 3,2,1 then 0 = GO
  RACE_START: 'race:start', // {}
  RACE_LAP: 'race:lap', // { kart, lap, laps }
  RACE_FINAL_LAP: 'race:final-lap', // { kart }
  RACE_FINISH: 'race:finish', // { kart, place, time }
  RACE_COMPLETE: 'race:complete', // { standings }
  RACE_TIMER: 'race:timer', // { time }

  // ---- kart ---------------------------------------------------------------
  KART_BOOST: 'kart:boost', // { kart, source, power }
  KART_DRIFT_START: 'kart:drift-start', // { kart }
  KART_DRIFT_CHARGE: 'kart:drift-charge', // { kart, level }
  KART_DRIFT_BOOST: 'kart:drift-boost', // { kart, level }
  KART_HOP: 'kart:hop', // { kart }
  KART_LAND: 'kart:land', // { kart, impact }
  KART_OFFROAD: 'kart:offroad', // { kart, onRoad }
  KART_HIT: 'kart:hit', // { kart, source, kind, from }
  KART_SPIN: 'kart:spin', // { kart }
  KART_SQUASH: 'kart:squash', // { kart }
  KART_ROCKET_START: 'kart:rocket-start', // { kart, power }
  KART_WRONG_WAY: 'kart:wrong-way', // { kart, wrongWay }
  KART_FINISHED: 'kart:finished', // { kart }

  // ---- items --------------------------------------------------------------
  ITEM_BOX: 'item:box', // { kart }
  ITEM_ROLL: 'item:roll', // { kart, item }
  ITEM_USE: 'item:use', // { kart, item }
  ITEM_HIT: 'item:hit', // { kart, item, from }
  ITEM_BLOCKED: 'item:blocked', // { kart, item }
  ITEM_EXPIRE: 'item:expire', // { kart, item }

  // ---- presentation (decoupled: anyone may emit, FX/audio listen) ---------
  FX_SPAWN: 'fx:spawn', // { kind, position, opts }
  AUDIO_SFX: 'audio:sfx', // { name, opts }
  AUDIO_MUSIC: 'audio:music', // { name }
  CAMERA_SHAKE: 'camera:shake', // { amount, duration }
};

/** Canonical sfx names (audio layer must support all of these). */
export const SFX = {
  COUNTDOWN_BEEP: 'countdown',
  COUNTDOWN_GO: 'go',
  ENGINE: 'engine',
  DRIFT: 'drift',
  DRIFT_BOOST: 'drift-boost',
  HOP: 'hop',
  LAND: 'land',
  HIT: 'hit',
  SPIN: 'spin',
  ITEM_ROLL: 'item-roll',
  ITEM_USE: 'item-use',
  ITEM_HIT: 'item-hit',
  BOX: 'item-box',
  BOOST: 'boost',
  OFFROAD: 'offroad',
  LAP: 'lap',
  FINAL_LAP: 'final-lap',
  FINISH: 'finish',
  LOSE: 'lose',
  UI_CLICK: 'ui-click',
  UI_MOVE: 'ui-move',
  SHIELD_BLOCK: 'shield-block',
  THUNDER: 'thunder',
};

/**
 * Kart `state` object — the single shape every subsystem may read/write.
 * @typedef {Object} KartState
 * @property {number} speed           meters/second (signed, forward +)
 * @property {boolean} drifting
 * @property {number} driftCharge     0..1 within the current drift stage
 * @property {number} driftLevel      0,1,2 (blue/orange/purple mini-turbo)
 * @property {boolean} boosting
 * @property {number} boostTime       seconds of boost left
 * @property {boolean} offRoad
 * @property {boolean} airborne
 * @property {boolean} spinning
 * @property {boolean} squashed
 * @property {boolean} frozen
 * @property {boolean} invincible
 * @property {boolean} wrongWay
 * @property {boolean} finished
 * @property {number} wheelSpin       0..1 visual wheel rotation accumulator
 * @property {number} steerVisual     -1..1 smoothed steering for wheel visuals
 * @property {number} lean            -1..1 body roll for visuals
 */

/** @returns {KartState} */
export function createKartState() {
  return {
    speed: 0,
    drifting: false,
    driftCharge: 0,
    driftLevel: 0,
    boosting: false,
    boostTime: 0,
    offRoad: false,
    airborne: false,
    spinning: false,
    squashed: false,
    frozen: false,
    invincible: false,
    wrongWay: false,
    finished: false,
    wheelSpin: 0,
    steerVisual: 0,
    lean: 0,
  };
}

/**
 * Player/AI input for one frame.
 * @typedef {{throttle:number, brake:number, steer:number, drift:boolean, useItem:boolean, lookBack:boolean}} InputState
 */

/** @returns {InputState} */
export function createInputState() {
  return { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false };
}

/**
 * Track geometry API returned by `TrackBuilder.build()`.
 * Every subsystem that needs the road (karts, AI, items, minimap) uses this.
 *
 * @typedef {Object} TrackApi
 * @property {string} id
 * @property {string} name
 * @property {string} theme
 * @property {number} laps
 * @property {THREE.Group} group            root object (already positioned in world)
 * @property {number} length                centerline length in meters
 * @property {number} halfWidth             road half-width in meters
 * @property {(u:number, lateral?:number)=>any} pointAt   world position at u
 * @property {(u:number)=>any} tangentAt                  unit tangent at u
 * @property {(pos:any)=>{u:number, lateral:number, onRoad:boolean, tangent:any, up:any}} project
 *           nearest-centerline projection of a world position
 * @property {any[]} startGrid              RACE.KART_COUNT grid slots, index 0 = pole
 * @property {number} startU                u of the start/finish line
 * @property {number[]} checkpointUs        ascending u values of checkpoints (last = finish)
 * @property {Array<{u:number, lateral:number[]}>} itemBoxRows
 * @property {Array<{u:number, lateral:number, kind:string}>} gimmicks  boost pads / ramps
 * @property {(u:number, lateral:number)=>any} surfaceNormal
 * @property {{outline:Array<{x:number,z:number}>, sample:(u:number)=>{x:number,z:number}}} minimap
 * @property {{minX:number,maxX:number,minZ:number,maxZ:number}} bounds
 * @property {(pos:any)=>boolean} isOffRoad
 * @property {()=>void} dispose
 */

/** Sensible default export surface used by `main.js` for each subsystem. */
export const DEFAULT_QUALITY = 'high';
export const DEFAULT_DIFFICULTY = 'normal';
export const DEFAULT_CAMERA_MODE = 'chase'; // 'chase' | 'far' | 'hood'
