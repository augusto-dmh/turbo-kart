/**
 * Turbo Kart — hand-authored track data (Agent 2: tracks & environment).
 *
 * Three layouts, each authored as an element sequence (straights + arcs) that
 * was resampled to uniformly spaced control points (~14 m apart) and closed
 * exactly, then traced with a closed centripetal Catmull-Rom spline by
 * `TrackBuilder`. Every layout is 1000-1100 m long, 14-16 m wide, and has:
 *
 *   sunset-speedway  coastal high-speed sweepers (34-76 m radii), gentle
 *                    elevation, one big jump (u 0.755), two boost pads.
 *   desert-dunes     red-rock canyon, two tight hairpins (13-19 m radii),
 *                    three full-width ramps with real air, long start straight.
 *   frozen-peaks     alpine switchback ladder (three hairpins), 120 m tunnel,
 *                    bridge over a gorge, four low-grip ice patches, one ramp.
 *
 * Gimmick kinds consumed by the kart/AI/items agents:
 *   { kind:'boost', u, lateral, power }                      -> free speed boost
 *   { kind:'ramp',  u, lateral, length, height, angle }      -> road rises to a
 *        lip: `project(pos).y` already includes the profile, so a kart that
 *        follows the road surface launches naturally. `angle` (rad) is the
 *        slope at the lip, `lipSlope` = tan(angle).
 *   { kind:'ice',   u, lateral, radius, along, grip }        -> low grip patch
 *        (flat decal, no elevation change; use `trackApi.surfaceAt`).
 *
 * `aiRacingLine` is an OPTIONAL ordered list of `{u, lateral}` apex hints for
 * the AI agent: lateral is signed, positive = left of travel.
 */

import { TRACKS } from '../contracts.js';
import { getTheme } from './themes.js';

const meta = (id) => TRACKS.find((t) => t.id === id) || TRACKS[0];

/* ---------------------------------------------------------------- sunset -- */
const SUNSET_POINTS = [
  { x: -14.9, y: 0.2, z: -2 }, { x: -14.9, y: 0.2, z: 12 }, { x: -14.9, y: 0.2, z: 26.1 }, { x: -14.9, y: 0.2, z: 40.1 },
  { x: -14.9, y: 0.2, z: 54.2 }, { x: -14.9, y: 0.2, z: 68.3 }, { x: -14.9, y: 0.3, z: 82.3 }, { x: -14.9, y: 0.5, z: 96.4 },
  { x: -14.3, y: 0.8, z: 110.4 }, { x: -10.8, y: 1.3, z: 124 }, { x: -4.7, y: 1.8, z: 136.6 }, { x: 3.9, y: 2.4, z: 147.7 },
  { x: 14.6, y: 3.1, z: 156.7 }, { x: 27, y: 3.7, z: 163.3 }, { x: 40.5, y: 4.4, z: 167.3 }, { x: 54.4, y: 5.1, z: 168.3 },
  { x: 68.4, y: 5.8, z: 166.4 }, { x: 81.6, y: 6.6, z: 161.7 }, { x: 93.8, y: 7.4, z: 154.8 }, { x: 105.8, y: 8.2, z: 147.5 },
  { x: 118.2, y: 8.9, z: 140.9 }, { x: 131.7, y: 9.5, z: 137.2 }, { x: 145.7, y: 10.2, z: 137 }, { x: 159.4, y: 10.8, z: 140 },
  { x: 173.1, y: 11.5, z: 143.4 }, { x: 186.8, y: 12, z: 146.5 }, { x: 200.8, y: 12.6, z: 147.5 }, { x: 214.7, y: 13, z: 146.2 },
  { x: 228.3, y: 13.5, z: 142.6 }, { x: 241, y: 13.9, z: 136.7 }, { x: 252.6, y: 14.3, z: 128.8 }, { x: 262.7, y: 14.7, z: 119 },
  { x: 271, y: 14.9, z: 107.7 }, { x: 277.3, y: 15, z: 95.1 }, { x: 281.3, y: 15, z: 81.7 }, { x: 283.7, y: 14.7, z: 67.8 },
  { x: 285.9, y: 14.4, z: 54 }, { x: 288.1, y: 13.9, z: 40.1 }, { x: 289, y: 13.4, z: 26.1 }, { x: 286.3, y: 12.8, z: 12.3 },
  { x: 280.3, y: 12.2, z: -0.3 }, { x: 271.3, y: 11.7, z: -11.1 }, { x: 259.9, y: 11.1, z: -19.2 }, { x: 247.6, y: 10.5, z: -26.1 },
  { x: 235.3, y: 9.9, z: -32.9 }, { x: 223.1, y: 9.3, z: -39.7 }, { x: 211.2, y: 8.7, z: -47.2 }, { x: 201.1, y: 8.1, z: -56.9 },
  { x: 193.4, y: 7.4, z: -68.6 }, { x: 187.8, y: 6.7, z: -81.5 }, { x: 182.5, y: 6, z: -94.6 }, { x: 177.2, y: 5.3, z: -107.6 },
  { x: 171.8, y: 4.6, z: -120.5 }, { x: 163.9, y: 4, z: -132 }, { x: 152.9, y: 3.4, z: -140.7 }, { x: 139.8, y: 3, z: -145.9 },
  { x: 126, y: 2.6, z: -148 }, { x: 112, y: 2.2, z: -149.9 }, { x: 98.1, y: 1.8, z: -151.8 }, { x: 84.2, y: 1.5, z: -153.7 },
  { x: 70.2, y: 1.2, z: -154.9 }, { x: 56.2, y: 0.9, z: -153.6 }, { x: 42.8, y: 0.7, z: -149.6 }, { x: 30.2, y: 0.5, z: -143.3 },
  { x: 19.1, y: 0.4, z: -134.7 }, { x: 9.8, y: 0.3, z: -124.2 }, { x: 2.6, y: 0.2, z: -112.2 }, { x: -2.3, y: 0.2, z: -99 },
  { x: -5.5, y: 0.2, z: -85.3 }, { x: -8.6, y: 0.2, z: -71.6 }, { x: -11.7, y: 0.2, z: -57.9 }, { x: -14.5, y: 0.2, z: -44.2 },
  { x: -14.9, y: 0.2, z: -30.1 }, { x: -14.9, y: 0.2, z: -16.1 },
];

/* ---------------------------------------------------------------- desert -- */
const DESERT_POINTS = [
  { x: -14.1, y: 0.2, z: -3.9 }, { x: -14.1, y: 0.2, z: 10.1 }, { x: -14.1, y: 0.2, z: 24 }, { x: -14.1, y: 0.2, z: 38 },
  { x: -14.1, y: 0.2, z: 51.9 }, { x: -14.1, y: 0.2, z: 65.9 }, { x: -14.1, y: 0.3, z: 79.8 }, { x: -14.1, y: 0.5, z: 93.8 },
  { x: -14.1, y: 1, z: 107.7 }, { x: -13.6, y: 1.5, z: 121.6 }, { x: -9.8, y: 2.2, z: 135 }, { x: -3, y: 2.9, z: 147.2 },
  { x: 4.1, y: 3.6, z: 159.2 }, { x: 11.2, y: 4.4, z: 171.2 }, { x: 21.9, y: 5.1, z: 179.7 }, { x: 35.6, y: 6, z: 179.5 },
  { x: 46.2, y: 6.9, z: 170.9 }, { x: 49, y: 7.8, z: 157.5 }, { x: 44.3, y: 8.7, z: 144.4 }, { x: 39, y: 9.6, z: 131.5 },
  { x: 33.7, y: 10.4, z: 118.6 }, { x: 28.4, y: 11.2, z: 105.7 }, { x: 26, y: 11.9, z: 92 }, { x: 27.7, y: 12.6, z: 78.2 },
  { x: 33.5, y: 13.2, z: 65.6 }, { x: 42.8, y: 13.8, z: 55.3 }, { x: 54.8, y: 14.3, z: 48.2 }, { x: 68.3, y: 14.8, z: 45 },
  { x: 82.1, y: 15.1, z: 46 }, { x: 95.5, y: 15.4, z: 50.1 }, { x: 108.8, y: 15.6, z: 54.3 }, { x: 122.2, y: 15.7, z: 58.2 },
  { x: 136, y: 15.7, z: 60 }, { x: 149.9, y: 15.7, z: 59.2 }, { x: 163.4, y: 15.6, z: 55.8 }, { x: 176.1, y: 15.4, z: 50.1 },
  { x: 188.4, y: 15.2, z: 43.5 }, { x: 200.6, y: 14.9, z: 36.8 }, { x: 212.7, y: 14.6, z: 29.8 }, { x: 219.7, y: 14.2, z: 18.1 },
  { x: 217.8, y: 13.7, z: 4.5 }, { x: 207.8, y: 13.2, z: -4.8 }, { x: 194.1, y: 12.7, z: -5.9 }, { x: 181.3, y: 12.2, z: -0.5 },
  { x: 168.5, y: 11.7, z: 5 }, { x: 155.7, y: 11.1, z: 10.5 }, { x: 142.8, y: 10.5, z: 16 }, { x: 129.4, y: 9.9, z: 19.6 },
  { x: 115.5, y: 9.2, z: 19.7 }, { x: 102, y: 8.6, z: 16.4 }, { x: 89.8, y: 7.9, z: 9.8 }, { x: 79.5, y: 7.1, z: 0.3 },
  { x: 72, y: 6.3, z: -11.4 }, { x: 67.6, y: 5.6, z: -24.6 }, { x: 66.6, y: 4.8, z: -38.4 }, { x: 69.1, y: 4.2, z: -52.1 },
  { x: 73.1, y: 3.6, z: -65.5 }, { x: 77.1, y: 3.1, z: -78.9 }, { x: 80.6, y: 2.6, z: -92.4 }, { x: 80.5, y: 2.2, z: -106.3 },
  { x: 76.3, y: 1.8, z: -119.5 }, { x: 68.6, y: 1.4, z: -131 }, { x: 57.8, y: 1.1, z: -139.8 }, { x: 44.9, y: 0.8, z: -145.1 },
  { x: 31.1, y: 0.6, z: -146.4 }, { x: 17.5, y: 0.5, z: -143.7 }, { x: 5.2, y: 0.3, z: -137.2 }, { x: -4.6, y: 0.2, z: -127.3 },
  { x: -11.2, y: 0.2, z: -115.1 }, { x: -14, y: 0.2, z: -101.5 }, { x: -14.1, y: 0.2, z: -87.5 }, { x: -14.1, y: 0.2, z: -73.6 },
  { x: -14.1, y: 0.2, z: -59.6 }, { x: -14.1, y: 0.2, z: -45.7 }, { x: -14.1, y: 0.2, z: -31.8 }, { x: -14.1, y: 0.2, z: -17.8 },
];

/* ------------------------------------------------------------------ snow -- */
const SNOW_POINTS = [
  { x: -26, y: 5, z: 1.1 }, { x: -26, y: 5.1, z: 15.2 }, { x: -26, y: 5.1, z: 29.2 }, { x: -26, y: 5.1, z: 43.3 },
  { x: -26, y: 5.2, z: 57.3 }, { x: -26, y: 5.3, z: 71.4 }, { x: -26, y: 5.5, z: 85.4 }, { x: -26, y: 5.7, z: 99.5 },
  { x: -26, y: 6.1, z: 113.6 }, { x: -24.2, y: 6.5, z: 127.4 }, { x: -15.7, y: 7, z: 138.4 }, { x: -2.8, y: 7.6, z: 143.3 },
  { x: 10.8, y: 8.2, z: 140.6 }, { x: 21, y: 8.8, z: 131.2 }, { x: 24.7, y: 9.3, z: 117.8 }, { x: 25.1, y: 9.9, z: 103.8 },
  { x: 25.4, y: 10.5, z: 89.7 }, { x: 25.7, y: 11.1, z: 75.7 }, { x: 26.1, y: 11.7, z: 61.6 }, { x: 26.6, y: 12.3, z: 47.6 },
  { x: 32.2, y: 12.9, z: 34.9 }, { x: 43.6, y: 13.5, z: 27.1 }, { x: 57.5, y: 14.1, z: 26.4 }, { x: 69.6, y: 14.7, z: 33.2 },
  { x: 76.3, y: 15.3, z: 45.3 }, { x: 77.6, y: 15.9, z: 59.3 }, { x: 78.5, y: 16.5, z: 73.3 }, { x: 79.4, y: 17.1, z: 87.3 },
  { x: 80.3, y: 17.7, z: 101.4 }, { x: 82.3, y: 18.4, z: 115.2 }, { x: 90.6, y: 19, z: 126.3 }, { x: 103.5, y: 19.7, z: 131.4 },
  { x: 117.1, y: 20.2, z: 128.9 }, { x: 127.4, y: 20.7, z: 119.6 }, { x: 131.3, y: 21.1, z: 106.3 }, { x: 131.6, y: 21.5, z: 92.2 },
  { x: 132, y: 21.8, z: 78.2 }, { x: 132.3, y: 22, z: 64.1 }, { x: 132.6, y: 22.1, z: 50.1 }, { x: 133, y: 22.1, z: 36 },
  { x: 133.3, y: 22.1, z: 22 }, { x: 133.6, y: 21.9, z: 7.9 }, { x: 134, y: 21.6, z: -6.1 }, { x: 134.3, y: 21.3, z: -20.2 },
  { x: 134.6, y: 20.8, z: -34.2 }, { x: 135.6, y: 20.3, z: -48.2 }, { x: 137.5, y: 19.7, z: -62.2 }, { x: 139.4, y: 19.1, z: -76.1 },
  { x: 141.3, y: 18.3, z: -90 }, { x: 143.1, y: 17.5, z: -103.9 }, { x: 143.6, y: 16.6, z: -118 }, { x: 141.1, y: 15.6, z: -131.8 },
  { x: 135.9, y: 14.7, z: -144.8 }, { x: 128.1, y: 13.7, z: -156.5 }, { x: 118.1, y: 12.9, z: -166.3 }, { x: 106.3, y: 12.1, z: -173.9 },
  { x: 93.2, y: 11.3, z: -178.9 }, { x: 79.3, y: 10.5, z: -181.1 }, { x: 65.3, y: 9.7, z: -180.4 }, { x: 51.7, y: 9, z: -176.9 },
  { x: 39.1, y: 8.3, z: -170.7 }, { x: 28.1, y: 7.7, z: -162 }, { x: 18.5, y: 7.2, z: -151.8 }, { x: 8.9, y: 6.7, z: -141.4 },
  { x: -0.6, y: 6.3, z: -131.1 }, { x: -10.1, y: 5.8, z: -120.8 }, { x: -19.1, y: 5.5, z: -110 }, { x: -24.6, y: 5.1, z: -97.1 },
  { x: -25.9, y: 4.2, z: -83.2 }, { x: -25.9, y: 3.7, z: -69.1 }, { x: -25.9, y: 3.6, z: -55.1 }, { x: -25.9, y: 3.8, z: -41 },
  { x: -25.9, y: 4.2, z: -27 }, { x: -25.9, y: 4.6, z: -12.9 },
];

/* -------------------------------------------------------------------------- */

const defs = {
  'sunset-speedway': {
    ...meta('sunset-speedway'),
    width: 16,
    kerbWidth: 1.1,
    vergeWidth: 16,
    laps: meta('sunset-speedway').laps,
    points: SUNSET_POINTS,
    elevation: { min: 0.2, max: 15, maxGrade: 0.056, style: 'gentle coastal roll' },
    bankGain: 1100,
    maxBankDeg: 8,
    startU: 0,
    checkpointCount: 12,
    offRoadSurface: 'grass',
    surfaceGrip: { road: 1, grass: 0.62 },
    music: 'sunset-groove',
    ambient: 'waves-seagulls',
    propSet: {
      tree: 'palm', treeCount: 150, rockCount: 46, bushCount: 90, crystals: 0,
      stands: [{ u: 0.985, side: 1 }, { u: 0.03, side: -1 }, { u: 0.245, side: 1 }, { u: 0.585, side: -1 }],
      landmarks: ['lighthouse', 'buoys', 'sailboat'],
      lamps: 34, weather: 'none', water: true, mountains: 'coast',
    },
    itemBoxRows: [
      { u: 0.252, lateral: [-5.4, -1.8, 1.8, 5.4] },
      { u: 0.585, lateral: [-5.4, -1.8, 1.8, 5.4] },
      { u: 0.925, lateral: [-5.4, -1.8, 1.8, 5.4] },
    ],
    gimmicks: [
      { u: 0.755, lateral: 0, kind: 'ramp', length: 15, height: 2.3, width: 15.4, label: 'cliff kicker' },
      { u: 0.243, lateral: -2.6, kind: 'boost', power: 1.0, width: 7, length: 8 },
      { u: 0.952, lateral: 2.6, kind: 'boost', power: 1.0, width: 7, length: 8 },
    ],
    structures: [],
    aiRacingLine: [
      { u: 0.0, lateral: 0 }, { u: 0.09, lateral: 0 }, { u: 0.108, lateral: -5 },
      { u: 0.145, lateral: -1.6 }, { u: 0.163, lateral: -5 }, { u: 0.21, lateral: -1.6 },
      { u: 0.23, lateral: -5 }, { u: 0.27, lateral: 5 }, { u: 0.30, lateral: 1.6 },
      { u: 0.34, lateral: -5 }, { u: 0.38, lateral: -5 }, { u: 0.42, lateral: -1.6 },
      { u: 0.446, lateral: -5 }, { u: 0.49, lateral: -1.6 }, { u: 0.513, lateral: -5 },
      { u: 0.555, lateral: -5 }, { u: 0.62, lateral: 5 }, { u: 0.66, lateral: 1.6 },
      { u: 0.716, lateral: -5 }, { u: 0.78, lateral: 0 }, { u: 0.811, lateral: -5 },
      { u: 0.851, lateral: -5 }, { u: 0.892, lateral: -5 }, { u: 0.96, lateral: -5 },
      { u: 0.99, lateral: 0 },
    ],
  },

  'desert-dunes': {
    ...meta('desert-dunes'),
    width: 15,
    kerbWidth: 1.0,
    vergeWidth: 18,
    laps: meta('desert-dunes').laps,
    points: DESERT_POINTS,
    elevation: { min: 0.2, max: 16, maxGrade: 0.07, style: 'rolling canyon floor' },
    bankGain: 700,
    maxBankDeg: 6,
    startU: 0,
    checkpointCount: 12,
    offRoadSurface: 'sand',
    surfaceGrip: { road: 1, sand: 0.55 },
    music: 'canyon-rock',
    ambient: 'desert-wind',
    propSet: {
      tree: 'cactus', treeCount: 130, rockCount: 70, bushCount: 70, crystals: 0,
      stands: [{ u: 0.988, side: 1 }, { u: 0.06, side: -1 }, { u: 0.58, side: 1 }],
      landmarks: ['arch', 'mesas', 'watertower'],
      lamps: 0, weather: 'dust', water: false, mountains: 'mesa',
    },
    itemBoxRows: [
      { u: 0.055, lateral: [-5.0, -1.7, 1.7, 5.0] },
      { u: 0.39, lateral: [-5.0, 0, 5.0] },
      { u: 0.575, lateral: [-5.0, -1.7, 1.7, 5.0] },
    ],
    gimmicks: [
      { u: 0.072, lateral: 0, kind: 'ramp', length: 16, height: 2.8, width: 14.4, label: 'canyon kicker' },
      { u: 0.468, lateral: 0, kind: 'ramp', length: 15, height: 2.9, width: 14.4, label: 'mesa launch' },
      { u: 0.928, lateral: 0, kind: 'ramp', length: 16, height: 2.6, width: 14.4, label: 'home straight launch' },
      { u: 0.33, lateral: -2.6, kind: 'boost', power: 1.05, width: 6.5, length: 8 },
      { u: 0.80, lateral: 2.6, kind: 'boost', power: 1.05, width: 6.5, length: 8 },
    ],
    structures: [],
    aiRacingLine: [
      { u: 0.0, lateral: 0 }, { u: 0.1, lateral: -1.6 }, { u: 0.118, lateral: -4.7 },
      { u: 0.166, lateral: -1.6 }, { u: 0.184, lateral: -4.7 }, { u: 0.225, lateral: -4.7 },
      { u: 0.275, lateral: 4.7 }, { u: 0.33, lateral: 1.6 }, { u: 0.369, lateral: 4.7 },
      { u: 0.408, lateral: -4.7 }, { u: 0.448, lateral: -4.7 }, { u: 0.5, lateral: -4.7 },
      { u: 0.54, lateral: -4.7 }, { u: 0.618, lateral: 4.7 }, { u: 0.671, lateral: 4.7 },
      { u: 0.71, lateral: 4.7 }, { u: 0.762, lateral: -4.7 }, { u: 0.802, lateral: -4.7 },
      { u: 0.869, lateral: -4.7 }, { u: 0.95, lateral: 0 },
    ],
  },

  'frozen-peaks': {
    ...meta('frozen-peaks'),
    width: 14,
    kerbWidth: 0.95,
    vergeWidth: 17,
    laps: meta('frozen-peaks').laps,
    points: SNOW_POINTS,
    elevation: { min: 5, max: 25.7, maxGrade: 0.07, style: 'alpine climb then descent' },
    bankGain: 650,
    maxBankDeg: 6,
    startU: 0,
    checkpointCount: 12,
    offRoadSurface: 'snow',
    surfaceGrip: { road: 0.92, snow: 0.5, ice: 0.22 },
    music: 'alpine-synth',
    ambient: 'mountain-wind',
    propSet: {
      tree: 'pine', treeCount: 190, rockCount: 48, bushCount: 40, crystals: 26,
      stands: [{ u: 0.99, side: 1 }, { u: 0.05, side: -1 }, { u: 0.63, side: 1 }],
      landmarks: ['icecave', 'peaks', 'crystals'],
      lamps: 18, weather: 'snow', water: false, mountains: 'alpine',
    },
    itemBoxRows: [
      { u: 0.075, lateral: [-4.6, 0, 4.6] },
      { u: 0.63, lateral: [-5.0, -1.7, 1.7, 5.0] },
      { u: 0.90, lateral: [-4.6, 0, 4.6] },
    ],
    gimmicks: [
      { u: 0.835, lateral: 0, kind: 'ramp', length: 14, height: 2.4, width: 13.4, label: 'ridge kicker' },
      { u: 0.625, lateral: -2.6, kind: 'boost', power: 1.0, width: 6.5, length: 8 },
      { u: 0.955, lateral: 2.6, kind: 'boost', power: 1.0, width: 6.5, length: 8 },
      { u: 0.145, lateral: -4.2, kind: 'ice', radius: 4.4, along: 13, grip: 0.22 },
      { u: 0.30, lateral: 4.0, kind: 'ice', radius: 4.2, along: 12, grip: 0.22 },
      { u: 0.425, lateral: 0, radius: 4.6, along: 14, kind: 'ice', grip: 0.22 },
      { u: 0.715, lateral: 2.6, kind: 'ice', radius: 5.0, along: 16, grip: 0.22 },
    ],
    structures: [
      { kind: 'tunnel', u0: 0.468, u1: 0.592, height: 7.6, width: 13.5, label: 'ice tunnel' },
      { kind: 'bridge', u0: 0.695, u1: 0.775, depth: 26, label: 'gorge bridge' },
    ],
    aiRacingLine: [
      { u: 0.0, lateral: 0 }, { u: 0.103, lateral: 1.5 }, { u: 0.121, lateral: 4.3 },
      { u: 0.176, lateral: 4.3 }, { u: 0.27, lateral: -4.3 }, { u: 0.324, lateral: -4.3 },
      { u: 0.391, lateral: 4.3 }, { u: 0.446, lateral: 4.3 }, { u: 0.53, lateral: 0 },
      { u: 0.63, lateral: -1.5 }, { u: 0.675, lateral: -4.3 }, { u: 0.742, lateral: -4.3 },
      { u: 0.812, lateral: -4.3 }, { u: 0.87, lateral: 0 }, { u: 0.95, lateral: 3 },
    ],
  },
};

/** All track definitions keyed by id. */
export const TRACK_DEFS = defs;

/**
 * @param {string} id track id (`sunset-speedway` | `desert-dunes` | `frozen-peaks`)
 * @returns {typeof defs['sunset-speedway']} the track def (falls back to sunset-speedway)
 */
export function getTrack(id) {
  return defs[id] || defs['sunset-speedway'];
}

/** Theme record for a track id (see themes.js). */
export function getTrackTheme(id) {
  return getTheme(getTrack(id).theme);
}

/** Lightweight list for menus/debug: id, name, theme, laps, length hint. */
export function listTracks() {
  return Object.values(defs).map((d) => ({
    id: d.id, name: d.name, theme: d.theme, laps: d.laps,
    width: d.width, points: d.points.length, difficulty: d.difficulty,
  }));
}
