/**
 * Turbo Kart — track builder (Agent 2).
 *
 * `new TrackBuilder({ THREE, trackDef, meta }).build()` returns the frozen
 * `TrackApi` from `src/contracts.js` plus a few documented extras:
 *
 *   surfaceAt(pos)      -> { surface, grip, onRoad, u, lateral, y }
 *   wallOffset          -> lateral distance of the guard-rail faces
 *   railSpans           -> [{u0,u1,side,lateral}] collision spans for karts
 *   structures          -> tunnel / bridge records
 *   terrainHeight(x,z)  -> ground height (same field the environment meshes)
 *   update(dt, camera)  -> animates boost pads + gate flags (environment calls it)
 *   project() returns   -> {u, lateral, onRoad, tangent, up, y, bank, heading,
 *                           curvature, distance, index}
 *
 * The road geometry is generated from the same sample table `project()` uses,
 * so the visible surface and the collision surface are the same surface.
 */

import { RACE } from '../contracts.js';
import { Centerline } from './projection.js';
import { getTheme } from './themes.js';
import { createTerrainField } from './terrainField.js';
import {
  asphaltTexture, kerbTexture, bannerTexture, signTexture, chevronTexture,
  gridSlotTexture, iceTexture, rockTexture, sandTexture, snowTexture,
  flagTexture, disposeTextures,
} from './textures.js';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------ small utils -- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Merge BufferGeometries that share the same attribute layout. */
function mergeGeos(geos) {
  const list = geos.filter(Boolean);
  if (!list.length) return null;
  const hasUv = !!list[0].getAttribute('uv');
  const hasColor = !!list[0].getAttribute('color');
  let total = 0;
  for (const g of list) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = hasUv ? new Float32Array(total * 2) : null;
  const col = hasColor ? new Float32Array(total * 3) : null;
  const idx = [];
  let vo = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (uv && g.getAttribute('uv')) uv.set(g.getAttribute('uv').array, vo * 2);
    if (col && g.getAttribute('color')) col.set(g.getAttribute('color').array, vo * 3);
    const gi = g.getIndex();
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(gi.array[i] + vo);
    else for (let i = 0; i < p.count; i++) idx.push(i + vo);
    vo += p.count;
  }
  const out = new (list[0].constructor)();
  const PosCtor = list[0].getAttribute('position').constructor;
  out.setAttribute('position', new PosCtor(pos, 3));
  out.setAttribute('normal', new PosCtor(nor, 3));
  if (uv) out.setAttribute('uv', new PosCtor(uv, 2));
  if (col) out.setAttribute('color', new PosCtor(col, 3));
  out.setIndex(idx);
  return out;
}

/** Cheap safety net: make a mostly-flat geometry's faces point up. */
function ensureUpFacing(geo) {
  const nor = geo.getAttribute('normal');
  if (!nor || !geo.getIndex()) return geo;
  let sum = 0;
  const step = Math.max(1, Math.floor(nor.count / 24));
  for (let i = 0; i < nor.count; i += step) sum += nor.getY(i);
  if (sum < 0) {
    const idx = geo.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    geo.getIndex().needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

/** Deterministic RNG (mulberry32) — track decoration must not flicker on rebuild. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} BuiltTrack
 * @property {()=>void} dispose
 */

export class TrackBuilder {
  /**
   * @param {{THREE:any, trackDef:any, meta?:any}} opts
   */
  constructor({ THREE, trackDef, meta }) {
    this.THREE = THREE;
    this.def = trackDef;
    this.meta = meta || trackDef;
    this.theme = getTheme(trackDef.theme);
    this.geos = [];
    this.mats = [];
    this.items = [];
    this._padMaterials = [];
    this._gateFlags = [];
    this._t = 0;
  }

  /* ==================================================================== build */
  /** @returns {any} TrackApi */
  build() {
    const THREE = this.THREE;
    const def = this.def;
    const theme = this.theme;

    this.cl = new Centerline({ THREE, def, sampleCount: 2048 });
    this.terrain = createTerrainField({ def, cl: this.cl, theme });

    const group = new THREE.Group();
    group.name = `track:${def.id}`;
    this.group = group;

    this._materials();
    this._buildRoad();
    this._buildKerbs();
    this._buildVerge();
    this._buildRails();
    this._buildGate();
    this._buildGrid();
    this._buildGimmicks();
    this._buildStructures();

    // merge everything that shares a material to keep draw calls low
    this._mergeByMaterial();

    const api = this._makeApi();
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    return api;
  }

  /* ------------------------------------------------------------- materials */
  _materials() {
    const THREE = this.THREE;
    const theme = this.theme;
    const cl = this.cl;
    const def = this.def;
    const m = {};
    const track = (mat) => { m[mat.name] = mat; this.mats.push(mat); return mat; };

    const asphalt = asphaltTexture(THREE, { color: theme.road.color, noise: theme.road.noise, wear: theme.road.wear, seed: 7 });
    m.road = track(new THREE.MeshStandardMaterial({
      name: 'road', color: 0xffffff, roughness: theme.road.rough, metalness: 0.03,
      map: asphalt || null,
    }));
    if (!asphalt) m.road.color.setHex(theme.road.color);

    const kerb = kerbTexture(THREE, { a: theme.kerb.a, b: theme.kerb.b, cells: 2 });
    m.kerb = track(new THREE.MeshStandardMaterial({
      name: 'kerb', color: 0xffffff, roughness: 0.55, metalness: 0.0, map: kerb || null,
    }));
    if (!kerb) m.kerb.color.setHex(theme.kerb.a);

    m.verge = track(new THREE.MeshStandardMaterial({ name: 'verge', vertexColors: true, roughness: 0.96, metalness: 0 }));
    m.skirt = track(new THREE.MeshStandardMaterial({
      name: 'skirt', color: theme.terrain.rockAlt, roughness: 1, metalness: 0, flatShading: true,
      side: THREE.DoubleSide,
      map: rockTexture(THREE, { color: theme.terrain.rock, alt: theme.terrain.rockAlt }) || null,
    }));

    m.rail = track(new THREE.MeshStandardMaterial({
      name: 'rail', color: theme.id === 'snow' ? 0x8d7a5f : 0xc3c9d2, side: THREE.DoubleSide,
      roughness: theme.id === 'snow' ? 0.75 : 0.38, metalness: theme.id === 'snow' ? 0.05 : 0.65,
    }));
    m.post = track(new THREE.MeshStandardMaterial({ name: 'post', color: 0x6f7681, roughness: 0.7, metalness: 0.4 }));

    m.gate = track(new THREE.MeshStandardMaterial({ name: 'gate', color: 0x2b2f3a, roughness: 0.45, metalness: 0.55 }));
    m.gateAccent = track(new THREE.MeshStandardMaterial({ name: 'gateAccent', color: 0xffc400, roughness: 0.5, metalness: 0.2, emissive: 0x2a1c00 }));
    m.banner = track(new THREE.MeshBasicMaterial({
      name: 'banner', side: THREE.DoubleSide,
      map: bannerTexture(THREE, { text: `TURBO KART — ${def.name.toUpperCase()}`, sub: 'START / FINISH', bg: 0x14161d, accent: 0xffc400 }) || null,
      color: 0xffffff,
    }));
    m.sign1 = track(new THREE.MeshBasicMaterial({
      name: 'sign1', side: THREE.DoubleSide,
      map: signTexture(THREE, { text: 'NITRO COLA', bg: 0xe8402c, fg: 0xfff3d0 }) || null,
    }));
    m.sign2 = track(new THREE.MeshBasicMaterial({
      name: 'sign2', side: THREE.DoubleSide,
      map: signTexture(THREE, { text: 'GRIPCO TYRES', bg: 0x1b4fd8, fg: 0xffffff }) || null,
    }));

    m.paint = track(new THREE.MeshBasicMaterial({
      name: 'paint', map: gridSlotTexture(THREE) || null, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, color: 0xffffff,
    }));
    m.boost = track(new THREE.MeshBasicMaterial({
      name: 'boost', map: chevronTexture(THREE, { color: 0xffffff, glow: theme.gimmick.boost }) || null,
      color: theme.gimmick.boost, transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4,
    }));
    m.ice = track(new THREE.MeshStandardMaterial({
      name: 'ice', map: iceTexture(THREE, { color: theme.gimmick.ice }) || null,
      color: theme.gimmick.ice, roughness: 0.06, metalness: 0.15, transparent: true, opacity: 0.82,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
    }));
    m.kicker = track(new THREE.MeshStandardMaterial({
      name: 'kicker', color: 0x2a2c33, roughness: 0.7, metalness: 0.1,
      map: kerbTexture(THREE, { a: 0x18191d, b: 0xf0b32a, cells: 8 }) || null,
      polygonOffset: true, polygonOffsetFactor: -2,
    }));
    m.glow = track(new THREE.MeshBasicMaterial({
      name: 'glow', color: 0xfff0c0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    m.tunnel = track(new THREE.MeshStandardMaterial({
      name: 'tunnel', color: theme.terrain.rock, roughness: 0.95, metalness: 0.05, side: THREE.DoubleSide,
      map: rockTexture(THREE, { color: theme.terrain.rock, alt: theme.terrain.rockAlt, seed: 91 }) || null,
    }));
    m.tunnelLight = track(new THREE.MeshBasicMaterial({ name: 'tunnelLight', color: 0xfff2c8 }));
    m.bridge = track(new THREE.MeshStandardMaterial({ name: 'bridge', color: 0x8a6a4a, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }));
    m.bridgeSteel = track(new THREE.MeshStandardMaterial({ name: 'bridgeSteel', color: 0x5a616e, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
    if (theme.id === 'snow') m.bridge.map = null;

    this.mat = m;
  }

  /* --------------------------------------------------------------- ribbons */
  /**
   * Sweep a two-rail ribbon along the sample table.
   * @param {object} o
   */
  _ribbon(o) {
    const THREE = this.THREE;
    const cl = this.cl;
    const {
      latA = 0, latB = 1, yA = 0, yB = 0, step = 1, arcScale = 8,
      uvA = 0, uvB = 1, colorFn = null, lift = 0, flip = false,
    } = o;
    const n = cl.count;
    const rows = Math.floor(n / step);
    const verts = rows * 2;
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const col = colorFn ? new Float32Array(verts * 3) : null;
    const idx = [];
    const c = colorFn ? new THREE.Color() : null;
    for (let r = 0; r < rows; r++) {
      const i = (r * step) % n;
      const b = cl.bank[i];
      const cb = Math.cos(b), sb = Math.sin(b);
      const tx = cl.tx[i], tz = cl.tz[i];
      const hInv = 1 / (Math.hypot(tx, tz) || 1);
      const lx = -tz * hInv, lz = tx * hInv;
      const arc = i * cl.ds;
      for (let k = 0; k < 2; k++) {
        const lat = k === 0 ? latA : latB;
        const yo = k === 0 ? yA : yB;
        const v = (r * 2 + k) * 3;
        pos[v] = cl.px[i] + lx * cb * lat;
        pos[v + 1] = cl.py[i] + sb * lat + yo + lift;
        pos[v + 2] = cl.pz[i] + lz * cb * lat;
        uv[(r * 2 + k) * 2] = arc / arcScale;
        uv[(r * 2 + k) * 2 + 1] = k === 0 ? uvA : uvB;
        if (col) {
          colorFn(c, lat, arc, i);
          col[(r * 2 + k) * 3] = c.r;
          col[(r * 2 + k) * 3 + 1] = c.g;
          col[(r * 2 + k) * 3 + 2] = c.b;
        }
      }
      const a0 = r * 2;
      const b0 = ((r + 1) % rows) * 2;
      if (flip) idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
      else idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    if (Math.abs(latA) > 0.001 || Math.abs(latB) > 0.001) ensureUpFacing(geo);
    return geo;
  }

  _add(geo, mat, { cast = false, receive = true, renderOrder = 0, name = '' } = {}) {
    const THREE = this.THREE;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (name) mesh.name = name;
    this.items.push(mesh);
    return mesh;
  }

  /* ------------------------------------------------------------------ road */
  _buildRoad() {
    const hw = this.cl.halfWidth;
    const geo = this._ribbon({ latA: -hw, latB: hw, step: 1, arcScale: 9, uvA: 0, uvB: (2 * hw) / 9 });
    const mesh = this._add(geo, this.mat.road, { name: 'road', renderOrder: 0 });
    mesh.receiveShadow = true;
  }

  _buildKerbs() {
    const cl = this.cl;
    const hw = cl.halfWidth;
    const kw = cl.kerbWidth;
    const a = this._ribbon({ latA: hw, latB: hw + kw, step: 2, arcScale: 2.4, uvA: 0, uvB: 1, lift: 0.015 });
    const b = this._ribbon({ latA: -hw - kw, latB: -hw, step: 2, arcScale: 2.4, uvA: 0, uvB: 1, lift: 0.015 });
    const geo = mergeGeos([a, b]);
    a.dispose(); b.dispose();
    this._add(geo, this.mat.kerb, { name: 'kerbs', renderOrder: 1 });
  }

  _buildVerge() {
    const THREE = this.THREE;
    const cl = this.cl;
    const theme = this.theme;
    const vw = this.def.vergeWidth || 15;
    // the verge starts at the outer kerb edge and runs outwards (no gaps, and
    // it passes under the guard-rail posts)
    const innerLat = cl.halfWidth + cl.kerbWidth - 0.06;
    const ca = new THREE.Color(theme.verge.a);
    const cb = new THREE.Color(theme.verge.b);
    const cc = new THREE.Color(theme.verge.c);
    const colorFn = (out, lat, arc) => {
      const t = Math.min(1, Math.abs(lat) / vw);
      const n = 0.5 + 0.5 * Math.sin(arc * 0.11 + lat * 0.21);
      const n2 = Math.sin(arc * 0.031);
      out.copy(ca).lerp(n2 > 0 ? cb : cc, t * 0.75 + Math.abs(n) * 0.25);
      const v = 0.9 + 0.1 * n;
      out.multiplyScalar(v);
    };
    const geos = [];
    for (const side of [1, -1]) {
      const flip = side < 0;
      const inner = this._ribbon({
        latA: side * innerLat, latB: side * (innerLat + vw * 0.35), step: 2, arcScale: 26,
        yA: -0.06, yB: -1.0, uvA: 0, uvB: 0.35, colorFn, flip,
      });
      const outer = this._ribbon({
        latA: side * (innerLat + vw * 0.35), latB: side * (innerLat + vw), step: 2, arcScale: 26,
        yA: -1.0, yB: -2.6, uvA: 0.35, uvB: 1, colorFn, flip,
      });
      geos.push(inner, outer);
    }
    const geo = mergeGeos(geos);
    for (const g of geos) g.dispose();
    this._add(geo, this.mat.verge, { name: 'verge' });

    // outer skirt: hides any gap between the verge and the coarse terrain
    const skirts = [];
    for (const side of [1, -1]) {
      skirts.push(this._ribbon({
        latA: side * (innerLat + vw), latB: side * (innerLat + vw), step: 2, arcScale: 30,
        yA: -2.6, yB: -22, uvA: 0, uvB: 1, flip: side < 0,
      }));
    }
    const skirtGeo = mergeGeos(skirts);
    for (const g of skirts) g.dispose();
    this._add(skirtGeo, this.mat.skirt, { name: 'skirt', receive: false });
  }

  /* ----------------------------------------------------------------- rails */
  _railGaps() {
    const cl = this.cl;
    const gaps = [];
    const L = cl.length;
    for (const g of this.def.gimmicks || []) {
      if (g.kind !== 'ramp') continue;
      const u0 = g.uStart ?? g.u;
      const u1 = (g.uStart ?? g.u) + (g.length || 16) / L;
      gaps.push({ u0: (u0 - 6 / L + 1) % 1, u1: (u1 + 46 / L) % 1, side: 0 });
    }
    for (const s of this.def.structures || []) {
      if (s.kind === 'tunnel') gaps.push({ u0: s.u0, u1: s.u1, side: 0 });
      if (s.kind === 'bridge') gaps.push({ u0: s.u0, u1: s.u1, side: 0 });
    }
    for (const g of this.def.railGaps || []) gaps.push({ u0: g.u0, u1: g.u1, side: g.side ?? 0 });
    return gaps;
  }

  _buildRails() {
    const THREE = this.THREE;
    const cl = this.cl;
    const n = cl.count;
    const L = cl.length;
    const gaps = this._railGaps();
    const railY = 0.62;
    const railH = 0.36;
    const base = cl.wallOffset;

    const inGap = (u, side) => {
      for (const g of gaps) {
        if (g.side !== 0 && g.side !== side) continue;
        const du = ((u - g.u0 + 1.5) % 1) - 0.5;
        const span = ((g.u1 - g.u0 + 1.5) % 1) - 0.5;
        if (span >= 0 ? du >= 0 && du <= span : du >= span || du <= 0) return true;
      }
      return false;
    };

    const spans = [];
    const bands = [];
    const posts = [];
    const dummy = new THREE.Object3D();
    for (const side of [1, -1]) {
      let start = null;
      for (let i = 0; i <= n; i++) {
        const k = i % n;
        const u = k / n;
        const open = i < n ? inGap(u, side) : true;
        if (!open && start === null) start = i;
        if ((open || i === n) && start !== null) {
          const i0 = start, i1 = i;
          if (i1 - i0 >= 3) {
            const lat = side * base;
            const latInner = side * (base - 0.12);
            bands.push(this._verticalBand(i0, i1, latInner, railY - railH / 2, railY + railH / 2, side < 0));
            spans.push({ u0: i0 / n, u1: i1 / n, side, lateral: lat, i0, i1 });
            // posts every ~3 m
            const stepI = Math.max(2, Math.round(3 / cl.ds));
            for (let k2 = i0; k2 < i1; k2 += stepI) {
              const idx = k2 % n;
              this._framePoint(idx, lat, 0, dummy.position);
              dummy.position.y += railY - railH / 2 - 0.12;
              dummy.rotation.set(0, cl.heading[idx], 0);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              posts.push(dummy.matrix.clone());
            }
          }
          start = null;
        }
      }
    }

    const bandGeo = mergeGeos(bands);
    for (const g of bands) g.dispose();
    if (bandGeo) this._add(bandGeo, this.mat.rail, { name: 'rails', cast: true });

    if (posts.length) {
      const postGeo = new THREE.BoxGeometry(0.14, railH + 0.6, 0.14);
      this.geos.push(postGeo);
      const inst = new THREE.InstancedMesh(postGeo, this.mat.post, posts.length);
      inst.name = 'railPosts';
      inst.castShadow = false;
      inst.receiveShadow = false;
      for (let i = 0; i < posts.length; i++) inst.setMatrixAt(i, posts[i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this.items.push(inst);
      this.geos.push(postGeo);
    }
    this.railSpans = spans;
  }

  /** Vertical quad strip between two sample indices at one lateral offset. */
  _verticalBand(i0, i1, lat, yBottom, yTop, flip = false) {
    const THREE = this.THREE;
    const cl = this.cl;
    const n = cl.count;
    const rows = Math.max(2, i1 - i0);
    const pos = new Float32Array((rows + 1) * 2 * 3);
    const uv = new Float32Array((rows + 1) * 2 * 2);
    const idx = [];
    for (let r = 0; r <= rows; r++) {
      const i = (i0 + r) % n;
      const b = cl.bank[i];
      const cb = Math.cos(b), sb = Math.sin(b);
      const tx = cl.tx[i], tz = cl.tz[i];
      const hInv = 1 / (Math.hypot(tx, tz) || 1);
      const lx = -tz * hInv, lz = tx * hInv;
      const px = cl.px[i] + lx * cb * lat;
      const pz = cl.pz[i] + lz * cb * lat;
      const arc = (i0 + r) * cl.ds;
      for (let k = 0; k < 2; k++) {
        const v = (r * 2 + k) * 3;
        pos[v] = px;
        pos[v + 1] = cl.py[i] + sb * lat + (k === 0 ? yBottom : yTop);
        pos[v + 2] = pz;
        uv[(r * 2 + k) * 2] = arc / 4;
        uv[(r * 2 + k) * 2 + 1] = k;
      }
      if (r < rows) {
        const a0 = r * 2, b0 = (r + 1) * 2;
        if (flip) idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
        else idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** Write a world point at sample `i`, lateral offset. */
  _framePoint(i, lateral, yOff, out) {
    const cl = this.cl;
    const b = cl.bank[i];
    const cb = Math.cos(b), sb = Math.sin(b);
    const tx = cl.tx[i], tz = cl.tz[i];
    const hInv = 1 / (Math.hypot(tx, tz) || 1);
    const lx = -tz * hInv, lz = tx * hInv;
    out.x = cl.px[i] + lx * cb * lateral;
    out.y = cl.py[i] + sb * lateral + yOff;
    out.z = cl.pz[i] + lz * cb * lateral;
    return out;
  }

  /* ------------------------------------------------------------------ gate */
  _buildGate() {
    const THREE = this.THREE;
    const cl = this.cl;
    const hw = cl.halfWidth;
    const def = this.def;
    const gateLat = hw + 2.9;
    const i0 = 0;
    const pillarGeo = new THREE.BoxGeometry(1.25, 1, 1.25);
    this.geos.push(pillarGeo);
    const pillarH = 8.4;
    const base = new THREE.Vector3();
    const pillars = [];
    for (const side of [-1, 1]) {
      this._framePoint(i0, side * gateLat, 0, base);
      const m = new THREE.Mesh(pillarGeo, this.mat.gate);
      m.position.set(base.x, base.y + pillarH / 2, base.z);
      m.scale.y = pillarH;
      m.rotation.y = cl.heading[i0];
      m.castShadow = true;
      m.receiveShadow = true;
      this.items.push(m);
      pillars.push({ side, pos: base.clone() });
      // foot
      const foot = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 2.1), this.mat.gateAccent);
      this.geos.push(foot.geometry);
      foot.position.set(base.x, base.y + 0.25, base.z);
      foot.rotation.y = cl.heading[i0];
      this.items.push(foot);
    }

    // banner across the top
    const span = gateLat * 2 + 1.25;
    const bannerGeo = new THREE.PlaneGeometry(span, 2.1);
    this.geos.push(bannerGeo);
    this._framePoint(i0, 0, pillarH - 1.3, base);
    const banner = new THREE.Mesh(bannerGeo, this.mat.banner);
    banner.position.copy(base);
    // Face the drivers on the grid (they approach the gate from behind), so the
    // banner text reads correctly instead of being mirrored.
    banner.rotation.y = cl.heading[i0] + Math.PI;
    banner.matrixAutoUpdate = false;
    banner.updateMatrix();
    this.items.push(banner);

    // sponsor boards on both pillars
    const signGeo = new THREE.PlaneGeometry(3.2, 1.6);
    this.geos.push(signGeo);
    for (const p of pillars) {
      const s = new THREE.Mesh(signGeo, p.side > 0 ? this.mat.sign1 : this.mat.sign2);
      this._framePoint(i0, p.side * (gateLat + 0.75), 2.6, base);
      s.position.set(base.x, base.y, base.z);
      s.rotation.y = cl.heading[i0] + (p.side > 0 ? -Math.PI / 2 : Math.PI / 2);
      s.matrixAutoUpdate = false;
      s.updateMatrix();
      this.items.push(s);
    }

    // small flags on the gate beam (animated in update())
    const flagGeo = new THREE.PlaneGeometry(0.9, 0.6);
    this.geos.push(flagGeo);
    const flagTex = flagTexture(THREE, { a: this.theme.kerb.a, b: this.theme.kerb.b, stripes: 3 });
    const flagMat = new THREE.MeshBasicMaterial({ name: 'gateFlags', map: flagTex || null, side: THREE.DoubleSide, color: 0xffffff });
    this.mats.push(flagMat);
    for (let k = 0; k < 6; k++) {
      const lat = lerp(-hw - 1.5, hw + 1.5, k / 5);
      const f = new THREE.Mesh(flagGeo, flagMat);
      this._framePoint(i0, lat, pillarH - 3.35, base);
      f.position.copy(base);
      f.rotation.y = cl.heading[i0];
      this.items.push(f);
      this._gateFlags.push({ mesh: f, phase: k * 0.7 });
    }

    // a beam the pennants hang from, just under the banner
    const beamGeo = new THREE.BoxGeometry(span + 0.6, 0.16, 0.16);
    this.geos.push(beamGeo);
    this._framePoint(i0, 0, pillarH - 2.85, base);
    const beam = new THREE.Mesh(beamGeo, this.mat.gate);
    beam.position.copy(base);
    beam.rotation.y = cl.heading[i0];
    beam.matrixAutoUpdate = false;
    beam.updateMatrix();
    this.items.push(beam);

    // start line paint (a chequered strip across the road)
    const lineGeo = this._surfaceQuad({ u: 0, lateral: 0, width: hw * 2, along: 1.6, lift: 0.025 });
    this._add(lineGeo, this.mat.paint, { name: 'startLine', renderOrder: 4, receive: false });
  }

  /**
   * A flat quad laid on the road surface following elevation + banking.
   * @param {{u:number,lateral:number,width:number,along:number,lift?:number,segments?:number}} o
   */
  _surfaceQuad({ u, lateral, width, along, lift = 0.03, segments = 6 }) {
    const THREE = this.THREE;
    const cl = this.cl;
    const L = cl.length;
    const pos = [];
    const uv = [];
    const idx = [];
    const halfAlong = along / 2 / L;
    const p = new THREE.Vector3();
    for (let r = 0; r <= segments; r++) {
      const uu = u - halfAlong + (along / L) * (r / segments);
      const src = uu < 0 ? uu + 1 : uu;
      const fi = Math.floor(src * cl.count) % cl.count;
      const b = cl.bank[fi];
      const cb = Math.cos(b), sb = Math.sin(b);
      const tx = cl.tx[fi], tz = cl.tz[fi];
      const hInv = 1 / (Math.hypot(tx, tz) || 1);
      const lx = -tz * hInv, lz = tx * hInv;
      for (let k = 0; k < 2; k++) {
        const lat = lateral + (k === 0 ? -width / 2 : width / 2);
        p.x = cl.px[fi] + lx * cb * lat;
        p.y = cl.py[fi] + sb * lat + lift;
        p.z = cl.pz[fi] + lz * cb * lat;
        pos.push(p.x, p.y, p.z);
        uv.push(k, r / segments);
      }
      if (r < segments) {
        const a0 = r * 2;
        const b0 = (r + 1) * 2;
        idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    ensureUpFacing(geo);
    return geo;
  }

  /* ------------------------------------------------------------------ grid */
  _buildGrid() {
    const THREE = this.THREE;
    const cl = this.cl;
    const hw = cl.halfWidth;
    const L = cl.length;
    const lat = Math.min(3.5, Math.max(2.4, hw - 3.2));
    const grid = [];
    for (let i = 0; i < RACE.KART_COUNT; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? 1 : -1;
      const back = 7.5 + row * 4.6;
      const u = (1 - back / L) % 1;
      const latI = side * lat;
      const pos = cl.pointAt(u, latI);
      const tan = cl.tangentAt(u);
      const heading = Math.atan2(tan.x, tan.z);
      grid.push({ position: pos, heading, u, lateral: latI, index: i });
      const q = this._surfaceQuad({ u, lateral: latI, width: 2.6, along: 3.4, lift: 0.028, segments: 3 });
      const mesh = new THREE.Mesh(q, this.mat.paint);
      mesh.renderOrder = 4;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      this.geos.push(q);
      this.items.push(mesh);
    }
    this.startGrid = grid;
  }

  /* -------------------------------------------------------------- gimmicks */
  _buildGimmicks() {
    const THREE = this.THREE;
    const cl = this.cl;
    const def = this.def;
    this.gimmicks = [];
    for (const g of def.gimmicks || []) {
      const rec = { ...g, power: g.power ?? 1, grip: g.grip ?? 0.25 };
      if (g.kind === 'ramp') {
        rec.uStart = g.uStart ?? g.u;
        rec.uEnd = g.uEnd ?? (g.u + (g.length || 16) / cl.length);
        rec.lipY = cl.surfaceY(rec.uEnd, g.lateral || 0);
        rec.angle = Math.atan(1.6 * (g.height || 2.4) / (g.length || 16));
        rec.lipSlope = Math.tan(rec.angle);
        this._buildRampVisual(rec);
      } else if (g.kind === 'boost') {
        this._buildBoostPad(rec);
      } else if (g.kind === 'ice') {
        this._buildIcePatch(rec);
      }
      this.gimmicks.push(rec);
    }
    // keep the shared def in sync so debug tools see the resolved values
  }

  _buildBoostPad(g) {
    const THREE = this.THREE;
    const w = g.width || 6.5;
    const l = g.length || 8;
    const geo = this._surfaceQuad({ u: g.u, lateral: g.lateral, width: w, along: l, lift: 0.035, segments: 6 });
    const mat = this.mat.boost;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 5;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = false;
    this.geos.push(geo);
    this.items.push(mesh);
    // side glow rails so the pad reads from a distance
    const railGeo = this._surfaceQuad({ u: g.u, lateral: g.lateral, width: w + 1.4, along: l, lift: 0.02, segments: 6 });
    const rail = new THREE.Mesh(railGeo, this.mat.glow);
    rail.renderOrder = 4;
    rail.matrixAutoUpdate = false;
    rail.receiveShadow = false;
    this.geos.push(railGeo);
    this.items.push(rail);
    this._padMaterials.push({ mat, mesh, phase: this._padMaterials.length * 1.7 });
  }

  _buildIcePatch(g) {
    const THREE = this.THREE;
    const cl = this.cl;
    const seg = 14;
    const du = (g.along || 12) / cl.length;
    const rad = g.radius || 4;
    const pos = [];
    const uv = [];
    const idx = [];
    const p = new THREE.Vector3();
    // fan from the centre
    const cu = g.u;
    const ci = Math.floor(((cu % 1) + 1) % 1 * cl.count) % cl.count;
    const b0 = cl.bank[ci];
    const tx0 = cl.tx[ci], tz0 = cl.tz[ci];
    const hInv = 1 / (Math.hypot(tx0, tz0) || 1);
    const lx0 = -tz0 * hInv, lz0 = tx0 * hInv;
    const cx = cl.px[ci] + lx0 * Math.cos(b0) * g.lateral;
    const cy = cl.py[ci] + Math.sin(b0) * g.lateral + 0.03;
    const cz = cl.pz[ci] + lz0 * Math.cos(b0) * g.lateral;
    pos.push(cx, cy, cz);
    uv.push(0.5, 0.5);
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const uu = cu + Math.cos(a) * du * 0.5;
      const lat = g.lateral + Math.sin(a) * rad;
      const src = ((uu % 1) + 1) % 1;
      const fi = Math.floor(src * cl.count) % cl.count;
      const b = cl.bank[fi];
      const cb = Math.cos(b), sb = Math.sin(b);
      const tx = cl.tx[fi], tz = cl.tz[fi];
      const inv = 1 / (Math.hypot(tx, tz) || 1);
      const lx = -tz * inv, lz = tx * inv;
      pos.push(cl.px[fi] + lx * cb * lat, cl.py[fi] + sb * lat + 0.03, cl.pz[fi] + lz * cb * lat);
      uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      idx.push(0, 1 + k, 1 + ((k + 1) % seg));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    ensureUpFacing(geo);
    const mesh = new THREE.Mesh(geo, this.mat.ice);
    mesh.renderOrder = 3;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.geos.push(geo);
    this.items.push(mesh);
  }

  _buildRampVisual(g) {
    const THREE = this.THREE;
    const cl = this.cl;
    const L = cl.length;
    const H = g.height || 2.4;
    const length = g.length || 16;
    const w = (g.width || cl.halfWidth * 2) / 2;
    const u0 = g.uStart;
    const u1 = g.uEnd;
    // top surface strips + lip face + side trims
    const seg = 10;
    const pos = [];
    const uv = [];
    const idx = [];
    const p = new THREE.Vector3();
    for (let r = 0; r <= seg; r++) {
      const t = r / seg;
      const uu = (u0 + (u1 - u0) * t) % 1;
      const fi = Math.floor(uu * cl.count) % cl.count;
      const b = cl.bank[fi];
      const cb = Math.cos(b), sb = Math.sin(b);
      const tx = cl.tx[fi], tz = cl.tz[fi];
      const inv = 1 / (Math.hypot(tx, tz) || 1);
      const lx = -tz * inv, lz = tx * inv;
      const y = cl.py[fi] + H * Math.pow(t, 1.6) + 0.025;
      for (let k = 0; k < 2; k++) {
        const lat = k === 0 ? -w : w;
        pos.push(cl.px[fi] + lx * cb * lat, y + sb * lat, cl.pz[fi] + lz * cb * lat);
        uv.push(k, (t * length) / 2.4);
      }
      if (r < seg) {
        const a0 = r * 2, b0 = (r + 1) * 2;
        idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    ensureUpFacing(geo);
    const mesh = new THREE.Mesh(geo, this.mat.kicker);
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    this.geos.push(geo);
    this.items.push(mesh);

    // lip edge trim + side rails
    const trimGeo = new THREE.BoxGeometry(w * 2 + 0.4, 0.3, 0.5);
    this.geos.push(trimGeo);
    const dummy = new THREE.Object3D();
    const i1 = Math.floor((u1 % 1) * cl.count) % cl.count;
    this._framePoint(i1, 0, H + 0.05, dummy.position);
    dummy.rotation.set(0, cl.heading[i1], 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    const trim = new THREE.Mesh(trimGeo, this.mat.gateAccent);
    trim.position.copy(dummy.position);
    trim.rotation.y = dummy.rotation.y;
    trim.castShadow = true;
    trim.matrixAutoUpdate = false;
    trim.updateMatrix();
    this.items.push(trim);
  }

  /* ------------------------------------------------------------ structures */
  _buildStructures() {
    this.structures = [];
    for (const s of this.def.structures || []) {
      if (s.kind === 'tunnel') this._buildTunnel(s);
      else if (s.kind === 'bridge') this._buildBridge(s);
      this.structures.push({ ...s });
    }
  }

  _buildTunnel(s) {
    const THREE = this.THREE;
    const cl = this.cl;
    const hw = cl.halfWidth;
    const w = Math.max((s.width || hw * 2 + 2) / 2, hw + cl.kerbWidth + 0.85);
    const h = Math.max(s.height || 7.4, 6.6);
    const i0 = Math.floor(s.u0 * cl.count);
    const i1 = Math.floor(s.u1 * cl.count);
    const rows = i1 - i0;
    // cross-section: arch from -w to +w (7 points)
    const cs = [];
    const steps = 7;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const ang = Math.PI * t;
      cs.push({ lat: -Math.cos(ang) * (w + 0.6), y: h * Math.sin(ang) * 0.92 + 1.2 });
    }
    cs[0].y = -0.6; cs[steps].y = -0.6;
    const pos = [];
    const uv = [];
    const idx = [];
    const innerPos = [];
    const innerUv = [];
    const innerIdx = [];
    for (let r = 0; r <= rows; r++) {
      const i = (i0 + r) % cl.count;
      const b = cl.bank[i];
      const cb = Math.cos(b), sb = Math.sin(b);
      const tx = cl.tx[i], tz = cl.tz[i];
      const inv = 1 / (Math.hypot(tx, tz) || 1);
      const lx = -tz * inv, lz = tx * inv;
      for (let k = 0; k <= steps; k++) {
        const c = cs[k];
        const lat = c.lat;
        const px = cl.px[i] + lx * cb * lat;
        const pz = cl.pz[i] + lz * cb * lat;
        const py = cl.py[i] + sb * lat + c.y;
        pos.push(px, py, pz);
        uv.push((i * cl.ds) / 6, k / steps);
        innerPos.push(px, py - 0.35, pz);
        innerUv.push((i * cl.ds) / 6, k / steps);
      }
      if (r < rows) {
        for (let k = 0; k < steps; k++) {
          const a0 = r * (steps + 1) + k;
          const b0 = (r + 1) * (steps + 1) + k;
          idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
          innerIdx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
        }
      }
    }
    const outer = new THREE.BufferGeometry();
    outer.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    outer.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    outer.setIndex(idx);
    outer.computeVertexNormals();
    const inner = new THREE.BufferGeometry();
    inner.setAttribute('position', new THREE.Float32BufferAttribute(innerPos, 3));
    inner.setAttribute('uv', new THREE.Float32BufferAttribute(innerUv, 2));
    inner.setIndex(innerIdx);
    inner.computeVertexNormals();
    const outerMesh = new THREE.Mesh(outer, this.mat.tunnel);
    outerMesh.receiveShadow = true;
    outerMesh.matrixAutoUpdate = false;
    outerMesh.frustumCulled = false;
    const innerMesh = new THREE.Mesh(inner, this.mat.tunnel);
    innerMesh.renderOrder = 1;
    innerMesh.matrixAutoUpdate = false;
    innerMesh.frustumCulled = false;
    this.geos.push(outer, inner);
    this.items.push(outerMesh, innerMesh);

    // ceiling light strips
    const lightGeo = [];
    for (let i = i0 + 8; i < i1 - 8; i += 16) {
      const strip = new THREE.PlaneGeometry(1.6, 0.4);
      this.geos.push(strip);
      const idxp = i % cl.count;
      const THREE2 = this.THREE;
      const q = new THREE2.Matrix4();
      const pos3 = new THREE2.Vector3();
      this._framePoint(idxp, 0, h * 0.86, pos3);
      q.makeRotationY(cl.heading[idxp] + Math.PI / 2);
      q.setPosition(pos3);
      strip.applyMatrix4(q);
      lightGeo.push(strip);
    }
    if (lightGeo.length) {
      const merged = mergeGeos(lightGeo);
      const lights = new THREE.Mesh(merged, this.mat.tunnelLight);
      lights.matrixAutoUpdate = false;
      this.items.push(lights);
    }
  }

  _buildBridge(s) {
    const THREE = this.THREE;
    const cl = this.cl;
    const i0 = Math.floor(s.u0 * cl.count);
    const i1 = Math.floor(s.u1 * cl.count);
    const base = cl.wallOffset + 0.3;
    for (const side of [1, -1]) {
      const deck = this._verticalBand(i0, i1, side * base, -1.5, 0.32);
      const mesh = new THREE.Mesh(deck, this.mat.bridgeSteel);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.geos.push(deck);
      this.items.push(mesh);
      const railTop = this._verticalBand(i0, i1, side * base, 1.05, 1.35);
      const rm = new THREE.Mesh(railTop, this.mat.bridge);
      rm.matrixAutoUpdate = false;
      rm.frustumCulled = false;
      this.geos.push(railTop);
      this.items.push(rm);
    }
    // piers + diagonal bracing
    const piers = [];
    const dummy = new THREE.Object3D();
    const nPiers = 3;
    for (let k = 1; k <= nPiers; k++) {
      const i = Math.floor(lerp(i0, i1, k / (nPiers + 1))) % cl.count;
      const roadY = cl.py[i];
      const groundY = this.terrain.heightAt(cl.px[i], cl.pz[i]);
      const hgt = Math.max(6, roadY - groundY);
      const pier = new THREE.BoxGeometry(2.4, hgt, 3.6);
      this.geos.push(pier);
      dummy.position.set(cl.px[i], groundY + hgt / 2, cl.pz[i]);
      dummy.rotation.set(0, cl.heading[i], 0);
      dummy.updateMatrix();
      pier.applyMatrix4(dummy.matrix);
      piers.push(pier);
      const brace = new THREE.BoxGeometry(base * 2 + 2, 0.7, 0.7);
      this.geos.push(brace);
      dummy.position.set(cl.px[i], roadY - 3.2, cl.pz[i]);
      dummy.updateMatrix();
      brace.applyMatrix4(dummy.matrix);
      piers.push(brace);
    }
    const merged = mergeGeos(piers);
    for (const g of piers) g.dispose();
    const mesh = new THREE.Mesh(merged, this.mat.bridgeSteel);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    this.items.push(mesh);
  }

  /* ------------------------------------------------------------- assembly */
  _mergeByMaterial() {
    const THREE = this.THREE;
    // Group meshes by material and merge the ones that are static and share a
    // material (rails/tunnel/bridge are already one mesh each).
    const byMat = new Map();
    const keep = [];
    for (const it of this.items) {
      if (!(it.isMesh) || Array.isArray(it.material)) { keep.push(it); continue; }
      if (it.isInstancedMesh) { keep.push(it); continue; }
      const mat = it.material;
      const key = mat.uuid;
      if (!byMat.has(key)) byMat.set(key, { mat, list: [] });
      byMat.get(key).list.push(it);
    }
    const merged = [];
    for (const { mat, list } of byMat.values()) {
      if (list.length === 1) { keep.push(list[0]); continue; }
      // only merge if the attribute layouts match exactly
      const usable = list.every((m) => m.geometry.getAttribute('position')
        && !!m.geometry.getAttribute('uv') === !!list[0].geometry.getAttribute('uv'));
      if (!usable) { keep.push(...list); continue; }
      const clones = list.map((m) => {
        m.updateMatrix();
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrix);
        return g;
      });
      const gm = mergeGeos(clones);
      for (const g of clones) g.dispose();
      const mesh = new THREE.Mesh(gm, mat);
      mesh.name = `merged:${mat.name}`;
      mesh.castShadow = list.some((m) => m.castShadow);
      mesh.receiveShadow = list.some((m) => m.receiveShadow);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = Math.max(...list.map((m) => m.renderOrder));
      this.geos.push(gm);
      merged.push(mesh);
    }
    // replace the group's children
    this.group.clear();
    for (const it of keep) {
      if (!it.parent) this.group.add(it);
    }
    for (const m of merged) this.group.add(m);
    this._merged = merged;
  }

  _makeApi() {
    const THREE = this.THREE;
    const cl = this.cl;
    const def = this.def;
    const theme = this.theme;
    const self = this;
    const checkpointCount = def.checkpointCount || 12;
    const checkpointUs = [];
    for (let i = 1; i <= checkpointCount; i++) checkpointUs.push(i / checkpointCount);

    // keep gimmicks' uStart/uEnd fresh (Centerline may have written them)
    const gimmicks = this.gimmicks.map((g) => ({ ...g }));

    const api = {
      id: def.id,
      name: def.name,
      theme: def.theme,
      laps: def.laps || 3,
      group: this.group,
      length: cl.length,
      halfWidth: cl.halfWidth,
      width: def.width,
      curve: cl.curve,
      sampleCount: cl.count,
      startU: def.startU ?? 0,
      pointAt: (u, lateral = 0, out = null) => cl.pointAt(u, lateral, out),
      tangentAt: (u, out = null) => cl.tangentAt(u, out),
      surfaceNormal: (u, lateral = 0, out = null) => cl.surfaceNormal(u, lateral, out),
      project: (pos) => cl.project(pos),
      projectCopy: (pos) => cl.projectCopy(pos),
      curvatureAt: (u) => cl.curvatureAt(u),
      speedFactorAt: (u) => cl.speedFactorAt(u),
      isOffRoad: (pos) => cl.isOffRoad(pos),
      startGrid: this.startGrid,
      checkpointUs,
      itemBoxRows: (def.itemBoxRows || []).map((r) => ({ u: r.u, lateral: [...r.lateral] })),
      /** optional apex hints for the AI agent (see trackData.js header) */
      aiRacingLine: (def.aiRacingLine || []).map((h) => ({ u: h.u, lateral: h.lateral })),
      gimmicks,
      structures: this.structures,
      wallOffset: cl.wallOffset,
      railSpans: this.railSpans,
      bounds: cl.bounds,
      boundsY: { min: cl.minY, max: cl.maxY },
      minimap: {
        outline: cl.minimapOutline(120),
        sample: (u) => cl.minimapSample(u),
        bounds: cl.bounds,
        width: def.width,
        theme: theme.minimap,
      },
      terrainHeight: (x, z) => this.terrain.heightAt(x, z),
      terrainField: this.terrain,
      themeRecord: theme,
      meta: this.meta,
      trackDef: def,

      /** Surface + grip under a world position (ice / off-road aware). */
      surfaceAt: (pos) => {
        const p = cl.project(pos);
        if (p.onRoad) {
          let surface = 'road';
          let grip = def.surfaceGrip?.road ?? 1;
          const g = self.gimmickAt(p.u, p.lateral);
          if (g && g.kind === 'ice') {
            surface = 'ice';
            grip = g.grip;
          } else if (g && g.kind === 'boost') {
            surface = 'boost';
            grip = 1;
          }
          return { surface, grip, onRoad: true, u: p.u, lateral: p.lateral, y: p.y };
        }
        const surface = def.offRoadSurface || theme.surface || 'grass';
        return {
          surface, grip: def.surfaceGrip?.[surface] ?? 0.55,
          onRoad: false, u: p.u, lateral: p.lateral, y: p.y,
        };
      },

      /** Gimmick under (u, lateral) or null. */
      gimmickAt: (u, lateral) => self.gimmickAt(u, lateral),

      update: (dt) => self.update(dt),

      dispose: () => self.dispose(),
    };
    this.api = api;
    return api;
  }

  /** @returns {any|null} the gimmick containing (u, lateral) */
  gimmickAt(u, lateral) {
    const cl = this.cl;
    const L = cl.length;
    for (const g of this.gimmicks) {
      if (g.kind === 'ramp') {
        const span = ((g.uEnd - g.uStart) + 1) % 1;
        const du = ((u - g.uStart) + 1) % 1;
        const halfW = (g.width || cl.halfWidth * 2) / 2;
        if (du <= span && Math.abs(lateral - (g.lateral || 0)) <= halfW) return g;
      } else if (g.kind === 'ice') {
        const du = Math.abs(((u - g.u + 1.5) % 1) - 0.5) * L;
        const dl = lateral - (g.lateral || 0);
        const rx = (g.along || 12) / 2, ry = g.radius || 4;
        if ((du * du) / (rx * rx) + (dl * dl) / (ry * ry) <= 1) return g;
      } else if (g.kind === 'boost') {
        const du = Math.abs(((u - g.u + 1.5) % 1) - 0.5) * L;
        const dl = Math.abs(lateral - (g.lateral || 0));
        if (du <= (g.length || 8) / 2 && dl <= (g.width || 6.5) / 2) return g;
      }
    }
    return null;
  }

  /** Called by environment.update; cheap (no allocations). */
  update(dt) {
    this._t += dt;
    const t = this._t;
    for (const pad of this._padMaterials) {
      if (pad.mat.map) {
        pad.mat.map.offset.y = -(((t * 1.6 + pad.phase * 0.1) % 1 + 1) % 1);
        pad.mat.map.offset.x = 0;
      }
      const pulse = 0.72 + 0.28 * Math.sin(t * 5.5 + pad.phase);
      pad.mat.opacity = clamp(pulse, 0.35, 1);
    }
    for (const f of this._gateFlags) {
      f.mesh.rotation.z = Math.sin(t * 3.1 + f.phase) * 0.12;
      f.mesh.rotation.x = Math.sin(t * 2.3 + f.phase * 1.7) * 0.08;
    }
  }

  /** Free every GPU resource this builder created (safe to call twice). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const g of this.geos) g?.dispose?.();
    for (const m of this.mats) m?.dispose?.();
    for (const it of this.items) {
      if (it.geometry && !this.geos.includes(it.geometry)) it.geometry.dispose?.();
      if (it.material && !this.mats.includes(it.material)) {
        if (Array.isArray(it.material)) it.material.forEach((mm) => mm.dispose?.());
        else it.material.dispose?.();
      }
    }
    if (this.group?.parent) this.group.parent.remove(this.group);
    this.group?.clear?.();
    disposeTextures(this.THREE);
    this.geos.length = 0;
    this.mats.length = 0;
    this.items.length = 0;
  }
}

export { mergeGeos };
