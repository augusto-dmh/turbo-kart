/**
 * Turbo Kart — track themes (Agent 2: tracks & environment).
 *
 * A theme is the single source of truth for a track's look: sky, fog, lights,
 * terrain palette, road/kerb/verge materials, water, prop recipe, weather and
 * minimap colours. Both `trackBuilder.js` and `environment.js` read from here,
 * so a track's surfaces and its world can never drift apart.
 */

/** @typedef {typeof THEMES.sunset} Theme */

/** Palette + world recipe per theme. Keys match `TRACKS[].theme` in contracts.js. */
export const THEMES = {
  /* ------------------------------------------------------------------ sunset */
  sunset: {
    id: 'sunset',
    label: 'Golden hour coast',
    sky: {
      zenith: 0x1d2f6e,
      horizon: 0xffb166,
      ground: 0x4b2f45,
      sunColor: 0xfff4cf,
      sunGlow: 0xffb45e,
      sunDir: [0.66, 0.12, -0.74],
      sunDisc: 0.026,
      haze: 0.55,
      hazeColor: 0xffc07a,
      stars: 0,
      aurora: 0,
      clouds: {
        count: 26, layers: 2, altitude: [170, 330], size: [110, 260],
        color: 0xffd7ab, shade: 0x9a5f86, opacity: 0.8, drift: 1.6,
      },
    },
    light: {
      hemi: { sky: 0xffd8a6, ground: 0x33405c, intensity: 0.95 },
      sun: { color: 0xffc98d, intensity: 2.5, shadows: true },
      ambient: { color: 0x3a4663, intensity: 0.35 },
    },
    fog: { color: 0xefae72, near: 200, far: 1500 },
    water: {
      level: -13.5, deep: 0x10314d, shallow: 0x2a6c85, foam: 0xffe6c6,
      wave: 0.75, speed: 1.0, sunTint: 0xffc78d, flat: 1,
    },
    terrain: {
      base: 0x7c6f4f, grass: 0x8b8b4c, dry: 0xa08c56, rock: 0x6b6055,
      rockAlt: 0x554b43, sand: 0xc8ab7c, snow: 0xf6f3ee,
    },
    verge: { a: 0x8f8551, b: 0x6e6a40, c: 0xa1935f },
    road: { color: 0x44464d, edge: 0x393b41, rough: 0.93, noise: 0.55, wear: 0.4 },
    kerb: { a: 0xd23b2c, b: 0xf3f3ef },
    surface: 'grass',
    gimmick: { boost: 0x35d2ff, ice: 0xbfe9ff },
    props: {
      tree: { kind: 'palm', count: 150, minLat: 15, maxLat: 60, minU: 0.02, maxU: 0.98, scale: [0.85, 1.35] },
      rock: { count: 46, minLat: 18, maxLat: 75, scale: [0.7, 2.2] },
      bush: { count: 90, minLat: 12, maxLat: 40, scale: [0.6, 1.2] },
      stands: 4, lamps: 34, flags: 54, birds: 9, balloons: 0, crowd: 900, crystals: 0,
    },
    weather: null,
    minimap: { road: '#4a5060', off: '#8b8b4c' },
  },

  /* ------------------------------------------------------------------ desert */
  desert: {
    id: 'desert',
    label: 'Red rock canyon',
    sky: {
      zenith: 0x2f6fce,
      horizon: 0xdcc49b,
      ground: 0x8a5a38,
      sunColor: 0xfff8e2,
      sunGlow: 0xffe3a8,
      sunDir: [0.34, 0.72, 0.6],
      sunDisc: 0.02,
      haze: 0.42,
      hazeColor: 0xe8cba1,
      stars: 0,
      aurora: 0,
      clouds: {
        count: 12, layers: 1, altitude: [260, 420], size: [130, 300],
        color: 0xffffff, shade: 0xa98a63, opacity: 0.5, drift: 2.4,
      },
    },
    light: {
      hemi: { sky: 0xcfe6ff, ground: 0xb07a48, intensity: 1.1 },
      sun: { color: 0xfff3d6, intensity: 2.3, shadows: true },
      ambient: { color: 0x6d5842, intensity: 0.3 },
    },
    fog: { color: 0xdcbf95, near: 240, far: 1800 },
    water: null,
    terrain: {
      base: 0xd2aa72, grass: 0xb99a63, dry: 0xe0bc86, rock: 0xa5643f,
      rockAlt: 0x7d472c, sand: 0xdcb87f, snow: 0xf7ead2,
    },
    verge: { a: 0xd9b87f, b: 0xc0a069, c: 0xe6c894 },
    road: { color: 0x5b544f, edge: 0x4a443f, rough: 0.95, noise: 0.7, wear: 0.55 },
    kerb: { a: 0xd8562f, b: 0xf6efe2 },
    surface: 'sand',
    gimmick: { boost: 0xffc63a, ice: 0xbfe9ff },
    props: {
      tree: { kind: 'cactus', count: 130, minLat: 14, maxLat: 55, minU: 0.02, maxU: 0.98, scale: [0.8, 1.6] },
      rock: { count: 70, minLat: 16, maxLat: 80, scale: [0.8, 3.0] },
      bush: { count: 70, minLat: 12, maxLat: 38, scale: [0.5, 1.1] },
      stands: 3, lamps: 0, flags: 46, birds: 0, balloons: 5, crowd: 620, crystals: 0,
    },
    weather: { kind: 'dust', count: 900, color: 0xe8cfa4, size: 0.55, speed: [0.3, 1.1], area: 90 },
    minimap: { road: '#5b544f', off: '#d2aa72' },
  },

  /* -------------------------------------------------------------------- snow */
  snow: {
    id: 'snow',
    label: 'Alpine dawn',
    sky: {
      zenith: 0x123a72,
      horizon: 0xcfe8f8,
      ground: 0x9fb6c8,
      sunColor: 0xfff6e0,
      sunGlow: 0xd8ecff,
      sunDir: [-0.42, 0.46, 0.78],
      sunDisc: 0.017,
      haze: 0.36,
      hazeColor: 0xd8ecfa,
      stars: 0.55,
      aurora: 0.5,
      clouds: {
        count: 18, layers: 2, altitude: [200, 380], size: [120, 280],
        color: 0xffffff, shade: 0x9db6d6, opacity: 0.75, drift: 1.2,
      },
    },
    light: {
      hemi: { sky: 0xdcf0ff, ground: 0xa8bccb, intensity: 1.05 },
      sun: { color: 0xfff2da, intensity: 2.1, shadows: true },
      ambient: { color: 0x557092, intensity: 0.4 },
    },
    fog: { color: 0xd6e9f7, near: 220, far: 1450 },
    water: null,
    terrain: {
      base: 0xe9f2f8, grass: 0xdce9f1, dry: 0xf2f8fc, rock: 0x5d6a7a,
      rockAlt: 0x46505e, sand: 0xdbe6ee, snow: 0xf7fbff,
    },
    verge: { a: 0xeef6fb, b: 0xd3e2ee, c: 0xfbfeff },
    road: { color: 0x3b4048, edge: 0x31353c, rough: 0.72, noise: 0.4, wear: 0.5 },
    kerb: { a: 0x3b7fd4, b: 0xf4f8ff },
    surface: 'snow',
    gimmick: { boost: 0x7ce7ff, ice: 0xa9e2f7 },
    props: {
      tree: { kind: 'pine', count: 190, minLat: 13, maxLat: 70, minU: 0.02, maxU: 0.98, scale: [0.8, 1.7] },
      rock: { count: 48, minLat: 15, maxLat: 80, scale: [0.7, 2.4] },
      bush: { count: 40, minLat: 12, maxLat: 34, scale: [0.5, 1.0] },
      stands: 3, lamps: 18, flags: 42, birds: 0, balloons: 0, crowd: 520, crystals: 26,
    },
    weather: { kind: 'snow', count: 1600, color: 0xffffff, size: 0.35, speed: [1.6, 3.4], area: 80 },
    minimap: { road: '#3b4048', off: '#eef6fb' },
  },
};

/**
 * @param {string} id theme id (`sunset` | `desert` | `snow`), unknown ids fall back to sunset
 * @returns {Theme}
 */
export function getTheme(id) {
  return THEMES[id] || THEMES.sunset;
}
