/**
 * Turbo Kart — centerline sampling + fast projection (Agent 2).
 *
 * This is the numerical heart of `TrackApi`:
 *   - closed, centripetal Catmull-Rom curve through the def's control points
 *   - an arc-length-uniform sample table (`count` samples, ~0.5 m apart)
 *   - per-sample tangent, heading, signed curvature and banking
 *   - `project(pos)`: O(1)-ish nearest-sample lookup (spatial hash, with a
 *     decimated fallback for far-off-track positions) + local refinement,
 *     then exact projection onto the neighbouring segment.
 *
 * `project()` reuses a pool of result objects (32 deep) and never allocates
 * during a frame. Copy the fields if you need to keep a result alive for more
 * than a few calls.
 */

import { getTheme } from './themes.js';

const hashU = (v) => v - Math.floor(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed difference between two angles. */
export function wrapPi(a) {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

/** @typedef {{points:Array<{x:number,y:number,z:number}>, width:number, gimmicks?:any[]}} TrackDef */

export class Centerline {
  /**
   * @param {object} opts
   * @param {any} opts.THREE three namespace
   * @param {TrackDef} opts.def track definition
   * @param {number} [opts.sampleCount] table size (default 2048)
   */
  constructor({ THREE, def, sampleCount = 2048 }) {
    this.THREE = THREE;
    this.def = def;
    this.theme = getTheme(def.theme);
    this.halfWidth = (def.width || 15) / 2;
    this.kerbWidth = def.kerbWidth ?? 1.0;
    /** lateral distance (from the centerline) of the guard-rail faces */
    this.wallOffset = this.halfWidth + this.kerbWidth + 0.55;
    this.bankGain = def.bankGain ?? 900;
    this.maxBank = (def.maxBankDeg ?? 9) * (Math.PI / 180);

    const pts = (def.points || []).map((p) => new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0));
    if (pts.length < 4) throw new Error('[Centerline] need at least 4 control points');
    /** @type {any} */
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.rawPoints = pts.length;

    this._buildTable(sampleCount);
    this._applyRamps();
    this._buildBanking();
    this._buildHash();
    this._buildPool();
  }

  /* ----------------------------------------------------------------- table */
  _buildTable(sampleCount) {
    const curve = this.curve;
    const rawN = Math.max(1024, sampleCount * 2);
    const rx = new Float64Array(rawN + 1);
    const ry = new Float64Array(rawN + 1);
    const rz = new Float64Array(rawN + 1);
    const cum = new Float64Array(rawN + 1);
    const p = this.THREE ? new this.THREE.Vector3() : null;
    for (let i = 0; i <= rawN; i++) {
      const q = this._rawPoint(curve, i / rawN, p);
      rx[i] = q.x; ry[i] = q.y; rz[i] = q.z;
      if (i > 0) {
        const dx = rx[i] - rx[i - 1], dy = ry[i] - ry[i - 1], dz = rz[i] - rz[i - 1];
        cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    const length = cum[rawN];
    const count = sampleCount;
    const ds = length / count;
    this.length = length;
    this.count = count;
    this.ds = ds;

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    const pz = new Float32Array(count);
    let seg = 0;
    for (let k = 0; k < count; k++) {
      const target = k * ds;
      while (seg < rawN - 1 && cum[seg + 1] < target) seg++;
      const segLen = cum[seg + 1] - cum[seg] || 1e-6;
      const f = (target - cum[seg]) / segLen;
      px[k] = lerp(rx[seg], rx[seg + 1], f);
      py[k] = lerp(ry[seg], ry[seg + 1], f);
      pz[k] = lerp(rz[seg], rz[seg + 1], f);
    }
    this.px = px; this.py = py; this.pz = pz;

    // tangents from central differences (smooth, exactly consistent with samples)
    const tx = new Float32Array(count), ty = new Float32Array(count), tz = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const a = (k - 1 + count) % count, b = (k + 1) % count;
      let dx = px[b] - px[a], dy = py[b] - py[a], dz = pz[b] - pz[a];
      const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
      tx[k] = dx * inv; ty[k] = dy * inv; tz[k] = dz * inv;
    }
    this.tx = tx; this.ty = ty; this.tz = tz;

    // horizontal heading + signed curvature (positive = turning right)
    const heading = new Float32Array(count);
    const curv = new Float32Array(count);
    for (let k = 0; k < count; k++) heading[k] = Math.atan2(tx[k], tz[k]);
    for (let k = 0; k < count; k++) {
      const a = (k - 1 + count) % count, b = (k + 1) % count;
      curv[k] = wrapPi(heading[b] - heading[a]) / (2 * ds);
    }
    this.heading = heading;
    this.curvature = curv;

    // world bounds of the drivable surface
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    const pad = this.wallOffset + 2;
    for (let k = 0; k < count; k++) {
      if (px[k] < minX) minX = px[k];
      if (px[k] > maxX) maxX = px[k];
      if (pz[k] < minZ) minZ = pz[k];
      if (pz[k] > maxZ) maxZ = pz[k];
      if (py[k] < minY) minY = py[k];
      if (py[k] > maxY) maxY = py[k];
    }
    this.minY = minY; this.maxY = maxY;
    this.bounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  }

  _rawPoint(curve, t, out) {
    // curve.getPoint allocates; reuse its scalar API when possible
    const p = out || new this.THREE.Vector3();
    curve.getPoint(t, p);
    return p;
  }

  /* ---------------------------------------------------------------- ramps */
  /** Raises the sample table over each ramp so karts drive up a real surface. */
  _applyRamps() {
    const gimmicks = (this.def.gimmicks || []).filter((g) => g.kind === 'ramp');
    /** @type {Array<{u0:number,u1:number,mask:Float32Array}>} */
    this.rampSpans = [];
    if (!gimmicks.length) {
      this.rampMask = new Float32Array(this.count);
      return;
    }
    const mask = new Float32Array(this.count);
    for (const g of gimmicks) {
      const L = g.length || 16;
      const H = g.height || 2.4;
      const u0 = hashU(g.u);
      // snap the lip to a sample boundary so the road surface, the terrain cap
      // and `project().y` all agree on where the ramp tops out
      let span = L / this.length;
      const kEnd = Math.max(2, Math.min(this.count - 2, Math.ceil((u0 + span) * this.count)));
      const u1 = (kEnd / this.count) % 1;
      span = hashU(u1 - u0);
      const slopeAtLip = 1.6 * (H / L);
      g.uStart = u0;
      g.uEnd = u1;
      g.lipSlope = slopeAtLip;
      g.angle = Math.atan(slopeAtLip);
      g.lipY = null;
      for (let k = 0; k < this.count; k++) {
        const u = k / this.count;
        const rel = hashU(u - u0);
        if (rel > span) continue;
        const t = rel / span;
        this.py[k] += H * Math.pow(t, 1.6);
        mask[k] = 1;
      }
    }
    this.rampMask = mask;
    this._rampList = gimmicks;
  }

  /* -------------------------------------------------------------- banking */
  _buildBanking() {
    const n = this.count;
    const raw = new Float32Array(n);
    for (let k = 0; k < n; k++) raw[k] = clamp(this.curvature[k] * this.bankGain, -this.maxBank, this.maxBank);
    // box-blur (wrapping) so banking transitions smoothly through corner exits
    const win = 12;
    const out = new Float32Array(n);
    let acc = 0;
    for (let k = -win; k <= win; k++) acc += raw[(k + n) % n];
    for (let k = 0; k < n; k++) {
      out[k] = acc / (2 * win + 1);
      acc -= raw[(k - win + n) % n];
      acc += raw[(k + win + 1) % n];
    }
    // no banking on ramps (a kicked-up cross-section would look wrong)
    for (let k = 0; k < n; k++) if (this.rampMask[k] > 0.5) out[k] = 0;
    this.bank = out;
  }

  /* ------------------------------------------------------------ hash grid */
  _buildHash() {
    const cell = (this.cellSize = 12);
    const { minX, minZ } = this.bounds;
    const gw = (this.gw = Math.max(1, Math.ceil((this.bounds.maxX - minX) / cell) + 1));
    const gh = (this.gh = Math.max(1, Math.ceil((this.bounds.maxZ - minZ) / cell) + 1));
    const n = this.count;
    const counts = new Int32Array(gw * gh + 1);
    const gx = new Int32Array(n);
    const gz = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const ix = clamp(Math.floor((this.px[k] - minX) / cell), 0, gw - 1);
      const iz = clamp(Math.floor((this.pz[k] - minZ) / cell), 0, gh - 1);
      gx[k] = ix; gz[k] = iz;
      counts[iz * gw + ix + 1]++;
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const offsets = counts;
    const fill = new Int32Array(gw * gh);
    const items = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const b = gz[k] * gw + gx[k];
      items[offsets[b] + fill[b]] = k;
      fill[b]++;
    }
    this.offsets = offsets;
    this.items = items;
    this._hashFill = fill;
  }

  /* ----------------------------------------------------------------- pool */
  _buildPool() {
    const THREE = this.THREE;
    this._pool = [];
    for (let i = 0; i < 32; i++) {
      this._pool.push({
        u: 0, lateral: 0, onRoad: true, distance: 0,
        tangent: new THREE.Vector3(0, 0, 1),
        up: new THREE.Vector3(0, 1, 0),
        y: 0, bank: 0, heading: 0, curvature: 0, index: 0,
      });
    }
    this._poolIdx = 0;
    this._scratchV = new THREE.Vector3();
    this._scratchA = new THREE.Vector3();
    this._scratchB = new THREE.Vector3();
    this._scratchC = new THREE.Vector3();
  }

  /* ------------------------------------------------------------ accessors */
  /** @returns {number} index of the sample nearest to u, may be fractional */
  indexAt(u) {
    return hashU(u) * this.count;
  }

  /**
   * Fill a frame for a (possibly fractional) sample index. Allocation-free.
   * @param {number} idx fractional sample index
   * @param {{x:number,y:number,z:number}} outPos
   * @param {{x:number,y:number,z:number}} outTangent
   * @param {{x:number,y:number,z:number}} outLeft horizontal left vector
   * @param {number} bankOut [out] bank angle
   * @returns {{bank:number, index:number}}
   */
  _frame(idx, outPos, outTangent, outLeft, bankBox) {
    const n = this.count;
    const i0 = ((Math.floor(idx) % n) + n) % n;
    const i1 = (i0 + 1) % n;
    const t = idx - Math.floor(idx);
    const px = lerp(this.px[i0], this.px[i1], t);
    const py = lerp(this.py[i0], this.py[i1], t);
    const pz = lerp(this.pz[i0], this.pz[i1], t);
    outPos.x = px; outPos.y = py; outPos.z = pz;
    if (outTangent) {
      outTangent.x = lerp(this.tx[i0], this.tx[i1], t);
      outTangent.y = lerp(this.ty[i0], this.ty[i1], t);
      outTangent.z = lerp(this.tz[i0], this.tz[i1], t);
    }
    if (outLeft) {
      // left = tangent x up, horizontal component only
      const tx = outTangent ? outTangent.x : this.tx[i0];
      const tz = outTangent ? outTangent.z : this.tz[i0];
      const inv = 1 / (Math.hypot(tx, tz) || 1);
      outLeft.x = -tz * inv;
      outLeft.y = 0;
      outLeft.z = tx * inv;
    }
    const bank = bankBox ? lerp(this.bank[i0], this.bank[i1], t) : 0;
    if (bankBox) bankBox.bank = bank;
    return { bank, index: i0 };
  }

  /**
   * World point at (u, lateral), including elevation and banking.
   * Pass `out` (a Vector3) to avoid allocating.
   * @returns {any} a fresh Vector3 unless `out` was supplied
   */
  pointAt(u, lateral = 0, out = null) {
    const THREE = this.THREE;
    const pos = out || new THREE.Vector3();
    const tan = this._scratchA;
    const left = this._scratchB;
    const bank = { bank: 0 };
    this._frame(this.indexAt(u), pos, tan, left, bank);
    const c = Math.cos(bank.bank), s = Math.sin(bank.bank);
    // banked left vector (positive bank raises the left edge)
    const lx = left.x * c, ly = s, lz = left.z * c;
    pos.x += lx * lateral;
    pos.y += ly * lateral;
    pos.z += lz * lateral;
    return pos;
  }

  /** Unit tangent at u (fresh Vector3 unless `out` is supplied). */
  tangentAt(u, out = null) {
    const v = out || new this.THREE.Vector3();
    this._frame(this.indexAt(u), this._scratchC, v, null, null);
    return v.normalize();
  }

  /** Up/normal of the road surface at (u, lateral) — respects elevation + banking. */
  surfaceNormal(u, lateral = 0, out = null) {
    const THREE = this.THREE;
    const left = this._scratchB;
    const tan = this._scratchA;
    const bank = { bank: 0 };
    this._frame(this.indexAt(u), this._scratchC, tan, left, bank);
    const c = Math.cos(bank.bank), s = Math.sin(bank.bank);
    // L' = L*cos + U*sin  (U = world up projected perpendicular to T roughly)
    const lx = left.x * c, ly = s, lz = left.z * c;
    // U' = normalize(cross(L', T))
    const o = out || new THREE.Vector3();
    o.set(ly * tan.z - lz * tan.y, lz * tan.x - lx * tan.z, lx * tan.y - ly * tan.x).normalize();
    return o;
  }

  /** Road surface height at (u, lateral) — allocation free. */
  surfaceY(u, lateral = 0) {
    const bank = { bank: 0 };
    this._frame(this.indexAt(u), this._scratchC, this._scratchA, this._scratchB, bank);
    return this._scratchC.y + Math.sin(bank.bank) * lateral;
  }

  /** Signed curvature (1/m, positive = turning right) at u. */
  curvatureAt(u) {
    const idx = this.indexAt(u);
    const i0 = Math.floor(idx) % this.count;
    const i1 = (i0 + 1) % this.count;
    return lerp(this.curvature[i0], this.curvature[i1], idx - Math.floor(idx));
  }

  /** Terrain-independent quality hint: 1 = straight, 0 = hairpin. */
  speedFactorAt(u) {
    const k = Math.abs(this.curvatureAt(u));
    return clamp(1 - k * 26, 0.25, 1);
  }

  /* -------------------------------------------------------------- project */
  /**
   * Nearest-centerline projection of a world position.
   *
   * Returned objects come from a 32-deep pool: read what you need right away,
   * or copy the fields, if you plan to keep more than 32 results alive.
   *
   * @param {{x:number,y:number,z:number}} pos
   * @returns {{u:number, lateral:number, onRoad:boolean, tangent:any, up:any,
   *            y:number, bank:number, heading:number, curvature:number,
   *            distance:number, index:number}}
   */
  project(pos) {
    const n = this.count;
    const x = pos.x, y = pos.y, z = pos.z;
    let best = -1;
    let bestD2 = Infinity;

    // 1. spatial hash (3x3 cells) — the common case
    const ix = Math.floor((x - this.bounds.minX) / this.cellSize);
    const iz = Math.floor((z - this.bounds.minZ) / this.cellSize);
    const gw = this.gw, gh = this.gh;
    const scan = (ring) => {
      for (let dz = -ring; dz <= ring; dz++) {
        const gz = iz + dz;
        if (gz < 0 || gz >= gh) continue;
        for (let dx = -ring; dx <= ring; dx++) {
          const gx = ix + dx;
          if (gx < 0 || gx >= gw) continue;
          const b = gz * gw + gx;
          const k0 = this.offsets[b], k1 = this.offsets[b + 1];
          for (let k = k0; k < k1; k++) {
            const i = this.items[k];
            const ddx = x - this.px[i], ddy = y - this.py[i], ddz = z - this.pz[i];
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < bestD2) { bestD2 = d2; best = i; }
          }
        }
      }
    };
    scan(1);
    // 2. far from every sample (or outside the grid): decimated global scan for
    //    a reliable candidate, then a wider hash pass if there is nothing at all
    if (best < 0 || bestD2 > this.cellSize * this.cellSize * 1.5) {
      for (let i = 0; i < n; i += 16) {
        const ddx = x - this.px[i], ddy = y - this.py[i], ddz = z - this.pz[i];
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      if (best < 0) scan(3);
    }
    // 4. local refinement over the full table
    let near = best;
    for (let d = -40; d <= 40; d++) {
      const i = (best + d + n) % n;
      const ddx = x - this.px[i], ddy = y - this.py[i], ddz = z - this.pz[i];
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < bestD2) { bestD2 = d2; near = i; }
    }
    // 5. project onto the two neighbouring segments
    let bestT = 0, bestSeg = near, bestSegD2 = Infinity;
    for (const a of [(near - 1 + n) % n, near]) {
      const b = (a + 1) % n;
      const ax = this.px[a], ay = this.py[a], az = this.pz[a];
      let dx = this.px[b] - ax, dy = this.py[b] - ay, dz = this.pz[b] - az;
      const len2 = dx * dx + dy * dy + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2;
      t = clamp(t, 0, 1);
      const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t;
      const ddx = x - cx, ddy = y - cy, ddz = z - cz;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < bestSegD2) { bestSegD2 = d2; bestSeg = a; bestT = t; }
    }

    const i0 = bestSeg, i1 = (bestSeg + 1) % n;
    const u = (i0 + bestT) / n;
    const res = this._pool[this._poolIdx];
    this._poolIdx = (this._poolIdx + 1) % this._pool.length;

    // interpolated frame at the projection
    const bank = lerp(this.bank[i0], this.bank[i1], bestT);
    const tanX = lerp(this.tx[i0], this.tx[i1], bestT);
    const tanY = lerp(this.ty[i0], this.ty[i1], bestT);
    const tanZ = lerp(this.tz[i0], this.tz[i1], bestT);
    const hInv = 1 / (Math.hypot(tanX, tanZ) || 1);
    const lx = -tanZ * hInv, lz = tanX * hInv;
    // contact point on the centerline, then lateral offset in the horizontal plane
    const cxm = lerp(this.px[i0], this.px[i1], bestT);
    const cym = lerp(this.py[i0], this.py[i1], bestT);
    const czm = lerp(this.pz[i0], this.pz[i1], bestT);
    const lateral = (x - cxm) * lx + (z - czm) * lz;
    const sinB = Math.sin(bank), cosB = Math.cos(bank);

    res.u = u;
    res.lateral = lateral;
    res.distance = Math.sqrt(bestSegD2);
    res.onRoad = Math.abs(lateral) <= this.halfWidth + this.kerbWidth;
    res.tangent.set(tanX, tanY, tanZ).normalize();
    // L' = L*cos + U*sin ; U' = normalize(cross(L', T))
    const blx = lx * cosB, bly = sinB, blz = lz * cosB;
    const tx2 = res.tangent.x, ty2 = res.tangent.y, tz2 = res.tangent.z;
    let ux = bly * tz2 - blz * ty2;
    let uy = blz * tx2 - blx * tz2;
    let uz = blx * ty2 - bly * tx2;
    const uInv = 1 / (Math.hypot(ux, uy, uz) || 1);
    res.up.set(ux * uInv, uy * uInv, uz * uInv);
    res.y = cym + sinB * lateral;
    res.bank = bank;
    res.heading = Math.atan2(tanX, tanZ);
    res.curvature = lerp(this.curvature[i0], this.curvature[i1], bestT);
    res.index = i0;
    return res;
  }

  /** True when the position is outside the drivable road + kerb band. */
  isOffRoad(pos) {
    const p = this.project(pos);
    return !p.onRoad;
  }

  /**
   * Like `project(pos)` but returns a fresh, independent object — use this when
   * you need to keep the result around (the pooled result may be reused after
   * 32 further calls).
   */
  projectCopy(pos) {
    const p = this.project(pos);
    return {
      u: p.u, lateral: p.lateral, onRoad: p.onRoad, distance: p.distance,
      tangent: p.tangent.clone(), up: p.up.clone(),
      y: p.y, bank: p.bank, heading: p.heading, curvature: p.curvature, index: p.index,
    };
  }

  /** Simplified minimap loop (~120 points in XZ). */
  minimapOutline(n = 120) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const i = Math.floor((k / n) * this.count) % this.count;
      out.push({ x: +this.px[i].toFixed(2), z: +this.pz[i].toFixed(2) });
    }
    return out;
  }

  /** Minimap position at u. */
  minimapSample(u) {
    const idx = this.indexAt(u);
    const i0 = Math.floor(idx) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = idx - Math.floor(idx);
    return { x: lerp(this.px[i0], this.px[i1], t), z: lerp(this.pz[i0], this.pz[i1], t) };
  }
}
