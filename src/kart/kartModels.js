/**
 * ============================================================================
 * TURBO KART — procedural kart + driver models (Agent 1)
 * ============================================================================
 * Every kart is built from primitives, baked into a handful of merged
 * geometries with per-vertex colours:
 *
 *   solid  → one vertex-coloured MeshStandardMaterial (tub, pods, spoiler,
 *            driver, frame, exhaust…)
 *   glow   → one emissive material (accent strips, visors, crystals)
 *   wheels → one merged geometry per axle (tire + rim + spokes)
 *   decal  → a procedurally drawn number texture (DataTexture, no canvas)
 *
 * That keeps a kart at ~10 draw calls and lets 8 karts share cached geometry
 * while each instance owns its (clonable, tintable) materials.
 * ============================================================================
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Per-character silhouette + livery
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} KartStyle
 * @property {number} number       race number (1..8)
 * @property {string} shape        tub silhouette
 * @property {number} width        track width
 * @property {number} length       overall length
 * @property {number} height       tub height
 * @property {number} noseTaper    how narrow the nose gets
 * @property {number} rearTaper    how narrow the tail gets
 * @property {number} wheelR       front wheel radius
 * @property {number} rearWheelR   rear wheel radius
 * @property {number} wheelW       tire width
 * @property {number} trackFront   front axle half track
 * @property {number} trackRear    rear axle half track
 * @property {number} wheelbase    axle distance from center
 * @property {string} spoiler      'wing' | 'small' | 'fin' | 'none' | 'cage' | 'twin'
 * @property {string} helmet       driver headgear
 * @property {number} dark         chassis/dark trim colour
 * @property {number} metal        metal trim colour
 * @property {number} rough        body roughness
 * @property {number} metalness    body metalness
 */

/** @type {Record<string, KartStyle>} */
export const CHARACTER_STYLES = {
  blaze: {
    number: 1, shape: 'wedge', width: 1.2, length: 2.32, height: 0.42,
    noseTaper: 0.5, rearTaper: 0.94, wheelR: 0.3, rearWheelR: 0.35, wheelW: 0.27,
    trackFront: 0.63, trackRear: 0.7, wheelbase: 0.74, spoiler: 'wing',
    helmet: 'flame', dark: 0x2b1216, metal: 0xe0b455, rough: 0.32, metalness: 0.5,
  },
  nova: {
    number: 2, shape: 'sleek', width: 1.14, length: 2.26, height: 0.4,
    noseTaper: 0.58, rearTaper: 0.9, wheelR: 0.29, rearWheelR: 0.32, wheelW: 0.25,
    trackFront: 0.62, trackRear: 0.68, wheelbase: 0.72, spoiler: 'small',
    helmet: 'visor', dark: 0x1b1533, metal: 0xb9c6ff, rough: 0.28, metalness: 0.55,
  },
  bolt: {
    number: 3, shape: 'buggy', width: 1.06, length: 1.98, height: 0.34,
    noseTaper: 0.62, rearTaper: 0.88, wheelR: 0.28, rearWheelR: 0.37, wheelW: 0.3,
    trackFront: 0.58, trackRear: 0.66, wheelbase: 0.66, spoiler: 'fin',
    helmet: 'bolt', dark: 0x1a1a1a, metal: 0xffe27a, rough: 0.4, metalness: 0.35,
  },
  viper: {
    number: 4, shape: 'low', width: 1.26, length: 2.3, height: 0.3,
    noseTaper: 0.42, rearTaper: 0.86, wheelR: 0.27, rearWheelR: 0.33, wheelW: 0.28,
    trackFront: 0.66, trackRear: 0.72, wheelbase: 0.75, spoiler: 'twin',
    helmet: 'slit', dark: 0x0d2b1e, metal: 0x8ef0c0, rough: 0.24, metalness: 0.6,
  },
  rosie: {
    number: 5, shape: 'bubble', width: 1.16, length: 2.14, height: 0.46,
    noseTaper: 0.66, rearTaper: 0.96, wheelR: 0.3, rearWheelR: 0.32, wheelW: 0.26,
    trackFront: 0.6, trackRear: 0.66, wheelbase: 0.68, spoiler: 'small',
    helmet: 'ears', dark: 0x6b3550, metal: 0xfff3f8, rough: 0.36, metalness: 0.3,
  },
  tank: {
    number: 6, shape: 'truck', width: 1.3, length: 2.24, height: 0.52,
    noseTaper: 0.78, rearTaper: 1.0, wheelR: 0.36, rearWheelR: 0.4, wheelW: 0.34,
    trackFront: 0.68, trackRear: 0.74, wheelbase: 0.72, spoiler: 'cage',
    helmet: 'guard', dark: 0x2c2c2c, metal: 0x8c8f7a, rough: 0.55, metalness: 0.3,
  },
  frost: {
    number: 7, shape: 'canopy', width: 1.12, length: 2.28, height: 0.38,
    noseTaper: 0.54, rearTaper: 0.88, wheelR: 0.29, rearWheelR: 0.33, wheelW: 0.26,
    trackFront: 0.61, trackRear: 0.68, wheelbase: 0.73, spoiler: 'fin',
    helmet: 'crystal', dark: 0x123a52, metal: 0xd8f6ff, rough: 0.22, metalness: 0.6,
  },
  zumi: {
    number: 8, shape: 'stealth', width: 1.18, length: 2.34, height: 0.36,
    noseTaper: 0.46, rearTaper: 0.82, wheelR: 0.28, rearWheelR: 0.34, wheelW: 0.28,
    trackFront: 0.64, trackRear: 0.7, wheelbase: 0.76, spoiler: 'twin',
    helmet: 'stripe', dark: 0x14161f, metal: 0xff5c8a, rough: 0.2, metalness: 0.65,
  },
};

/** Detail level per quality preset (radial/curve segment counts). */
function detailFor(quality) {
  if (quality === 'low') return { radial: 8, curve: 4, spokes: 3 };
  if (quality === 'medium') return { radial: 12, curve: 6, spokes: 4 };
  if (quality === 'ultra') return { radial: 20, curve: 10, spokes: 5 };
  return { radial: 16, curve: 8, spokes: 4 };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Bake a flat vertex colour into a geometry (linear space, as three expects). */
function colorize(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Merge geometries (indexed or not) into one non-indexed geometry. */
function mergeGeometries(list) {
  const parts = [];
  let total = 0;
  for (const g of list) {
    if (!g) continue;
    const p = g.index ? g.toNonIndexed() : g;
    parts.push(p);
    total += p.attributes.position.count;
  }
  if (!parts.length) return new THREE.BufferGeometry();
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const p = g.attributes.position.array;
    pos.set(p, o);
    const n = g.attributes.normal?.array;
    if (n) nor.set(n, o);
    const c = g.attributes.color?.array;
    if (c) col.set(c, o);
    o += p.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Free the source geometries after merging (they are not referenced). */
function release(list) {
  for (const g of list) g?.dispose?.();
}

/** Axis-aligned box, optionally rotated about Y, then coloured. */
function box(color, w, h, d, x, y, z, ry = 0, rx = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return colorize(g, color);
}

/** Cylinder along +Y by default; `axis` = 'x' | 'y' | 'z'. */
function cyl(color, rTop, rBot, h, x, y, z, axis = 'y', seg = 12) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, color);
}

function sphere(color, r, x, y, z, seg = 12) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.75)));
  g.translate(x, y, z);
  return colorize(g, color);
}

/** Cone pointing +Y (rotate with rx/rz before translating). */
function cone(color, r, h, x, y, z, seg = 12, rx = 0, rz = 0) {
  const g = new THREE.ConeGeometry(r, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return colorize(g, color);
}

/** Extruded tub from a top-view plan outline, bottom sitting at `baseY`. */
function tub(style, color, detail, baseY = 0.16) {
  const hw = style.width / 2;
  const hl = style.length / 2;
  const nose = style.noseTaper;
  const tail = style.rearTaper;
  const s = new THREE.Shape();
  s.moveTo(-hw * tail, -hl);
  s.lineTo(hw * tail, -hl);
  s.lineTo(hw, -hl * 0.2);
  s.lineTo(hw * (nose + 0.32), hl * 0.4);
  s.quadraticCurveTo(hw * nose, hl * 0.98, 0, hl);
  s.quadraticCurveTo(-hw * nose, hl * 0.98, -hw * (nose + 0.32), hl * 0.4);
  s.lineTo(-hw, -hl * 0.2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: style.height,
    bevelEnabled: true,
    bevelSize: 0.05,
    bevelThickness: 0.045,
    bevelSegments: 2,
    curveSegments: detail.curve,
  });
  g.rotateX(Math.PI / 2);
  g.translate(0, baseY + style.height, 0);
  return colorize(g, color);
}

// ---------------------------------------------------------------------------
// Wheels (merged per axle: tire + rim + spokes + hub, vertex coloured)
// ---------------------------------------------------------------------------

function buildWheel(radius, width, colors, detail) {
  const seg = detail.radial;
  const parts = [];
  parts.push(cyl(colors.tire, radius, radius, width, 0, 0, 0, 'x', seg));
  parts.push(cyl(colors.rim, radius * 0.62, radius * 0.62, width * 1.04, 0, 0, 0, 'x', seg));
  const spokes = detail.spokes;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const g = new THREE.BoxGeometry(width * 1.06, radius * 1.05, radius * 0.14);
    g.rotateX(a);
    parts.push(colorize(g, colors.spoke));
  }
  parts.push(cyl(colors.spoke, radius * 0.2, radius * 0.2, width * 1.12, 0, 0, 0, 'x', 8));
  const merged = mergeGeometries(parts);
  release(parts);
  return merged;
}

// ---------------------------------------------------------------------------
// Number decal — tiny 3x5 bitmap font drawn into a DataTexture (no DOM)
// ---------------------------------------------------------------------------

const FONT_3X5 = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

/**
 * @param {number} num @param {number} hexColor
 * @returns {THREE.DataTexture}
 */
export function makeNumberTexture(num, hexColor = 0xffffff) {
  const scale = 4;
  const gw = 3 * scale;
  const gh = 5 * scale;
  const w = gw + 4;
  const h = gh + 4;
  const data = new Uint8Array(w * h * 4);
  const c = new THREE.Color(hexColor);
  const r = Math.round(Math.pow(Math.max(0, c.r), 1 / 2.2) * 255);
  const g = Math.round(Math.pow(Math.max(0, c.g), 1 / 2.2) * 255);
  const b = Math.round(Math.pow(Math.max(0, c.b), 1 / 2.2) * 255);
  const glyph = FONT_3X5[Math.abs(Math.round(num)) % 10] || FONT_3X5[0];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (glyph[y][x] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = 2 + x * scale + sx;
          const py = 2 + y * scale + sy;
          const i = (py * w + px) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Body assembly
// ---------------------------------------------------------------------------

/**
 * Build the merged solid/glow geometry for one character.
 * @returns {{solid: THREE.BufferGeometry, glow: THREE.BufferGeometry, colors: any}}
 */
function buildBody(style, char, detail) {
  const body = char.color;
  const accent = char.accent;
  const dark = style.dark;
  const metal = style.metal;
  const solid = [];
  const glow = [];
  const S = (geo) => solid.push(geo);
  const G = (geo) => glow.push(geo);

  const hw = style.width / 2;
  const hl = style.length / 2;
  const baseY = 0.16;

  // --- floor pan + tub -----------------------------------------------------
  S(box(dark, style.width * 0.94, 0.09, style.length * 0.94, 0, baseY - 0.03, 0));
  S(tub(style, body, detail, baseY));

  // --- nose ----------------------------------------------------------------
  const noseZ = hl * 0.86;
  if (style.shape === 'wedge' || style.shape === 'stealth') {
    S(box(body, style.width * 0.62, 0.16, 0.5, 0, baseY + style.height * 0.55, noseZ, 0, -0.18));
    S(box(accent, style.width * 0.3, 0.05, 0.34, 0, baseY + style.height * 0.92, noseZ - 0.06));
  } else if (style.shape === 'truck') {
    S(box(body, style.width * 0.94, 0.3, 0.34, 0, baseY + 0.16, noseZ - 0.02));
    S(box(metal, style.width * 0.96, 0.08, 0.16, 0, baseY - 0.02, noseZ + 0.12));
  } else if (style.shape === 'buggy') {
    S(box(body, style.width * 0.7, 0.14, 0.4, 0, baseY + 0.2, noseZ - 0.04, 0, -0.1));
    S(cyl(metal, 0.045, 0.045, style.width * 0.72, 0, baseY + 0.42, noseZ - 0.14, 'x', 8));
  } else {
    S(box(body, style.width * 0.7, 0.2, 0.46, 0, baseY + style.height * 0.42, noseZ - 0.02, 0, -0.12));
    S(box(accent, style.width * 0.24, 0.06, 0.3, 0, baseY + style.height * 0.62, noseZ + 0.04));
  }

  // --- front bumper --------------------------------------------------------
  S(box(dark, style.width * 0.9, 0.09, 0.12, 0, baseY + 0.02, hl * 0.98));
  S(box(dark, 0.1, 0.1, 0.2, hw * 0.5, baseY + 0.06, hl * 0.9));
  S(box(dark, 0.1, 0.1, 0.2, -hw * 0.5, baseY + 0.06, hl * 0.9));

  // --- side pods -----------------------------------------------------------
  const podZ = style.shape === 'bubble' ? 0.1 : -0.05;
  const podW = style.shape === 'low' || style.shape === 'stealth' ? 0.3 : 0.22;
  S(box(dark, podW, 0.26, style.length * 0.5, hw + podW * 0.42, baseY + 0.14, podZ));
  S(box(dark, podW, 0.26, style.length * 0.5, -hw - podW * 0.42, baseY + 0.14, podZ));
  if (style.shape !== 'buggy') {
    G(box(accent, podW * 0.55, 0.05, style.length * 0.34, hw + podW * 0.42, baseY + 0.29, podZ));
    G(box(accent, podW * 0.55, 0.05, style.length * 0.34, -hw - podW * 0.42, baseY + 0.29, podZ));
  }

  // --- seat + cockpit ------------------------------------------------------
  const seatY = baseY + style.height;
  S(box(dark, style.width * 0.52, 0.44, 0.16, 0, seatY + 0.2, -0.36, 0, 0.14));
  S(box(dark, style.width * 0.46, 0.1, 0.34, 0, seatY + 0.02, -0.16));
  S(box(body, style.width * 0.5, 0.06, 0.2, 0, seatY + 0.06, 0.02));

  // --- steering wheel ------------------------------------------------------
  const swY = seatY + 0.34;
  const sw = new THREE.TorusGeometry(0.13, 0.026, 6, detail.radial);
  sw.rotateX(Math.PI / 2 - 0.5);
  sw.translate(0, swY, 0.22);
  S(colorize(sw, dark));
  S(cyl(dark, 0.02, 0.02, 0.2, 0, swY - 0.1, 0.22, 'z', 6));

  // --- engine / exhaust ----------------------------------------------------
  S(box(dark, style.width * 0.66, 0.24, 0.34, 0, seatY + 0.02, -hl * 0.72));
  const pipeX = style.shape === 'truck' ? 0.42 : 0.24;
  const pipeR = style.shape === 'truck' ? 0.09 : 0.062;
  S(cyl(metal, pipeR, pipeR, 0.4, pipeX, seatY + 0.12, -hl * 0.86, 'z', 10));
  S(cyl(metal, pipeR, pipeR, 0.4, -pipeX, seatY + 0.12, -hl * 0.86, 'z', 10));
  G(cyl(accent, pipeR * 0.6, pipeR * 0.6, 0.06, pipeX, seatY + 0.12, -hl * 0.86 - 0.2, 'z', 8));
  G(cyl(accent, pipeR * 0.6, pipeR * 0.6, 0.06, -pipeX, seatY + 0.12, -hl * 0.86 - 0.2, 'z', 8));

  // --- spoiler -------------------------------------------------------------
  const spY = seatY + 0.4;
  const spZ = -hl * 0.82;
  if (style.spoiler === 'wing') {
    S(box(accent, style.width * 1.02, 0.06, 0.34, 0, spY, spZ, 0, -0.12));
    S(box(dark, 0.06, 0.34, 0.2, hw * 0.42, spY - 0.17, spZ));
    S(box(dark, 0.06, 0.34, 0.2, -hw * 0.42, spY - 0.17, spZ));
    S(box(body, style.width * 0.98, 0.05, 0.2, 0, spY - 0.28, spZ + 0.06));
  } else if (style.spoiler === 'twin') {
    S(box(accent, style.width * 0.3, 0.05, 0.3, hw * 0.52, spY - 0.05, spZ, 0, -0.1));
    S(box(accent, style.width * 0.3, 0.05, 0.3, -hw * 0.52, spY - 0.05, spZ, 0, -0.1));
    S(box(dark, 0.05, 0.26, 0.16, hw * 0.52, spY - 0.2, spZ));
    S(box(dark, 0.05, 0.26, 0.16, -hw * 0.52, spY - 0.2, spZ));
    G(box(accent, style.width * 0.16, 0.03, 0.3, hw * 0.52, spY - 0.02, spZ));
    G(box(accent, style.width * 0.16, 0.03, 0.3, -hw * 0.52, spY - 0.02, spZ));
  } else if (style.spoiler === 'small') {
    S(box(accent, style.width * 0.86, 0.05, 0.26, 0, spY - 0.12, spZ, 0, -0.14));
    S(box(dark, 0.05, 0.2, 0.16, hw * 0.38, spY - 0.24, spZ));
    S(box(dark, 0.05, 0.2, 0.16, -hw * 0.38, spY - 0.24, spZ));
  } else if (style.spoiler === 'fin') {
    S(box(accent, 0.07, 0.42, 0.36, 0, spY - 0.06, spZ, 0, -0.22));
    S(box(accent, 0.07, 0.2, 0.16, 0, spY + 0.14, spZ - 0.16, 0, -0.5));
    S(box(dark, style.width * 0.7, 0.04, 0.2, 0, spY - 0.2, spZ + 0.02));
  } else if (style.spoiler === 'cage') {
    S(box(dark, style.width * 0.9, 0.06, 0.06, 0, spY + 0.22, spZ + 0.1));
    S(box(dark, 0.06, 0.3, 0.06, hw * 0.42, spY + 0.08, spZ + 0.1));
    S(box(dark, 0.06, 0.3, 0.06, -hw * 0.42, spY + 0.08, spZ + 0.1));
    S(box(dark, style.width * 0.9, 0.06, 0.06, 0, seatY + 0.5, -0.1));
    S(box(dark, 0.06, 0.55, 0.06, hw * 0.42, seatY + 0.26, -0.1));
    S(box(dark, 0.06, 0.55, 0.06, -hw * 0.42, seatY + 0.26, -0.1));
    G(box(accent, style.width * 0.5, 0.04, 0.04, 0, spY + 0.2, spZ + 0.08));
  }

  // --- driver --------------------------------------------------------------
  buildDriver(style, char, detail, seatY, S, G);

  // --- number decal plate --------------------------------------------------
  S(box(dark, 0.42, 0.02, 0.34, 0, baseY + style.height + 0.06, hl * 0.42));

  const solidGeo = mergeGeometries(solid);
  const glowGeo = mergeGeometries(glow);
  release(solid);
  release(glow);
  return { solid: solidGeo, glow: glowGeo, decalZ: hl * 0.42, decalY: baseY + style.height + 0.075 };
}

/** Driver body + headgear; silhouette differs per character. */
function buildDriver(style, char, detail, seatY, S, G) {
  const suit = char.color;
  const accent = char.accent;
  const dark = style.dark;
  const torsoY = seatY + 0.3;
  const headY = seatY + 0.74;
  const headZ = -0.06;

  // torso + shoulders + arms
  S(box(suit, 0.42, 0.44, 0.32, 0, torsoY, -0.12));
  S(box(dark, 0.44, 0.1, 0.3, 0, torsoY + 0.16, -0.12));
  S(box(suit, 0.12, 0.3, 0.12, 0.24, torsoY - 0.02, 0.06, 0.3));
  S(box(suit, 0.12, 0.3, 0.12, -0.24, torsoY - 0.02, 0.06, -0.3));
  G(box(accent, 0.3, 0.04, 0.02, 0, torsoY + 0.06, 0.045));

  // helmet
  const helmetStyle = style.helmet;
  const helmetR = 0.21;
  S(sphere(helmetStyle === 'guard' ? dark : suit, helmetR, 0, headY, headZ, detail.radial));
  S(box(accent, 0.3, 0.1, 0.06, 0, headY + 0.02, headZ + 0.18)); // visor band

  if (helmetStyle === 'flame') {
    G(cone(accent, 0.07, 0.26, 0, headY + 0.2, headZ - 0.02, 8, -0.5));
    S(box(accent, 0.06, 0.06, 0.3, 0, headY + 0.16, headZ - 0.02, 0, -0.4));
  } else if (helmetStyle === 'visor') {
    G(box(accent, 0.34, 0.05, 0.05, 0, headY + 0.03, headZ + 0.19));
    S(cyl(accent, 0.012, 0.012, 0.24, 0, headY + 0.28, headZ - 0.06, 'z', 6));
    G(sphere(accent, 0.03, 0, headY + 0.4, headZ - 0.06, 6));
  } else if (helmetStyle === 'bolt') {
    S(box(accent, 0.05, 0.3, 0.05, 0, headY + 0.24, headZ - 0.04, 0, -0.35));
    S(box(accent, 0.05, 0.14, 0.05, 0.07, headY + 0.34, headZ - 0.02, 0, -0.9));
    S(box(accent, 0.05, 0.14, 0.05, -0.07, headY + 0.3, headZ - 0.02, 0, -0.9));
  } else if (helmetStyle === 'slit') {
    G(box(accent, 0.07, 0.03, 0.03, 0.1, headY + 0.04, headZ + 0.19));
    G(box(accent, 0.07, 0.03, 0.03, -0.1, headY + 0.04, headZ + 0.19));
    S(cone(accent, 0.05, 0.18, 0, headY + 0.2, headZ - 0.12, 6, -1.1));
  } else if (helmetStyle === 'ears') {
    S(sphere(accent, 0.09, 0.12, headY + 0.2, headZ - 0.02, 8));
    S(sphere(accent, 0.09, -0.12, headY + 0.2, headZ - 0.02, 8));
    S(box(char.accent, 0.16, 0.1, 0.1, 0, headY + 0.22, headZ - 0.12, 0, -0.3));
    S(box(char.accent, 0.16, 0.1, 0.1, 0, headY + 0.22, headZ - 0.12, 0, 0.3));
  } else if (helmetStyle === 'guard') {
    S(box(dark, 0.42, 0.12, 0.3, 0, headY - 0.08, headZ + 0.04));
    G(box(accent, 0.36, 0.05, 0.04, 0, headY + 0.01, headZ + 0.2));
  } else if (helmetStyle === 'crystal') {
    S(cone(accent, 0.06, 0.34, 0, headY + 0.26, headZ - 0.04, 6, -0.2));
    S(cone(accent, 0.04, 0.2, 0.1, headY + 0.2, headZ - 0.06, 6, -0.2, -0.5));
    S(cone(accent, 0.04, 0.2, -0.1, headY + 0.2, headZ - 0.06, 6, -0.2, 0.5));
  } else if (helmetStyle === 'stripe') {
    G(box(accent, 0.06, 0.02, 0.34, 0, headY + 0.19, headZ - 0.02));
    G(box(accent, 0.02, 0.16, 0.3, 0.13, headY + 0.06, headZ - 0.02));
    G(box(accent, 0.02, 0.16, 0.3, -0.13, headY + 0.06, headZ - 0.02));
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const geoCache = new Map();

/**
 * @param {{character:any, quality?:string}} opts
 * @returns {{solid:any, glow:any, wheelFront:any, wheelRear:any, decal:any, style:KartStyle, colors:any}}
 */
export function getKartParts({ character, quality = 'high' }) {
  const key = `${character.id}:${quality}`;
  const hit = geoCache.get(key);
  if (hit) return hit;

  const style = CHARACTER_STYLES[character.id] || CHARACTER_STYLES.nova;
  const detail = detailFor(quality);
  const colors = {
    body: character.color,
    accent: character.accent,
    dark: style.dark,
    metal: style.metal,
    tire: 0x181a20,
    rim: style.metal,
    spoke: 0xd8dde6,
  };

  const bodyParts = buildBody(style, character, detail);
  const entry = {
    style,
    colors,
    detail,
    solid: bodyParts.solid,
    glow: bodyParts.glow,
    decalY: bodyParts.decalY,
    decalZ: bodyParts.decalZ,
    wheelFront: buildWheel(style.wheelR, style.wheelW, colors, detail),
    wheelRear: buildWheel(style.rearWheelR, style.wheelW * 1.12, colors, detail),
  };
  geoCache.set(key, entry);
  return entry;
}

/** Drop cached geometry (called when nothing references it any more). */
export function disposeKartCache() {
  for (const e of geoCache.values()) {
    e.solid?.dispose?.();
    e.glow?.dispose?.();
    e.wheelFront?.dispose?.();
    e.wheelRear?.dispose?.();
  }
  geoCache.clear();
}

export default { CHARACTER_STYLES, getKartParts, makeNumberTexture, disposeKartCache };
