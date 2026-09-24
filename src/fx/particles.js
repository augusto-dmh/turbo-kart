/**
 * ============================================================================
 * TURBO KART — pooled particle primitives (owned by Agent 5)
 * ============================================================================
 * Three primitives, all fixed-capacity and allocation-free per frame:
 *
 *  - `ParticleSystem` : `THREE.Points` with a custom soft-point shader
 *                       (falls back to `PointsMaterial` when the shader probe
 *                       fails). CPU integrates position/velocity/gravity/drag.
 *  - `DebrisSystem`   : `THREE.InstancedMesh` of chunky boxes (debris, confetti).
 *  - `MeshPool`       : a handful of one-shot meshes (fireballs, rings, `?`
 *                       ghosts, lightning bolts, boost flame cones).
 *
 * All of them use ring buffers and recycle the **oldest** particle first, so a
 * sustained 8-kart race can never grow the heap.
 */

import { PARTICLE_VERT, PARTICLE_FRAG, canUseParticleShader } from './shaders.js';

/** @typedef {{x:number,y:number,z:number}} Vec3Like */

const TMP = { r: 1, g: 1, b: 1 };

/**
 * Read a colour (hex number or `{r,g,b}`) into a shared scratch object.
 * @param {number|any} input
 * @param {{r:number,g:number,b:number}} out
 */
function readColor(input, out) {
  if (typeof input === 'number') {
    out.r = ((input >> 16) & 255) / 255;
    out.g = ((input >> 8) & 255) / 255;
    out.b = (input & 255) / 255;
  } else if (input && typeof input.r === 'number') {
    out.r = input.r;
    out.g = input.g;
    out.b = input.b;
  } else {
    out.r = 1;
    out.g = 1;
    out.b = 1;
  }
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** @returns {number} */
function rnd() {
  return Math.random();
}

/**
 * One pooled additive/alpha point cloud.
 *
 * `emit(spec)` takes a **reusable** spec object (the caller mutates fields and
 * reuses it) so no garbage is produced in the hot loop. Recognised fields:
 *
 * ```
 * x, y, z            spawn position (world)
 * vx, vy, vz         base velocity (m/s)
 * spread             extra random speed added on each axis
 * radius             random spawn offset inside a sphere of this radius
 * color, colorEnd    hex number or {r,g,b}; colour lerps over the lifetime
 * size, sizeEnd      world-space sprite size (metres)
 * life               seconds
 * alpha, alphaEnd    0..1 opacity endpoints
 * gravity            m/s² (default -9)
 * drag               per-second exponential damping (default 0.8)
 * count              particles to spawn (default 1)
 * ```
 */
export class ParticleSystem {
  /**
   * @param {Object} opts
   * @param {any} opts.THREE
   * @param {number} opts.capacity
   * @param {'additive'|'normal'} [opts.blending]
   * @param {any} [opts.texture]
   * @param {number} [opts.renderOrder]
   * @param {number} [opts.softness]  near-camera fade distance (metres)
   * @param {number} [opts.hardness]  falloff exponent for the no-texture path
   * @param {string} [opts.name]
   */
  constructor({
    THREE, capacity, blending = 'additive', texture = null,
    renderOrder = 0, softness = 0.9, hardness = 0.35, name = 'particles',
  }) {
    this.THREE = THREE;
    this.name = name;
    this.capacity = Math.max(1, capacity | 0);
    this.cap = this.capacity;
    this.sizeScale = 1;
    this.globalAlpha = 1;

    const cap = this.capacity;
    this._px = new Float32Array(cap);
    this._py = new Float32Array(cap);
    this._pz = new Float32Array(cap);
    this._vx = new Float32Array(cap);
    this._vy = new Float32Array(cap);
    this._vz = new Float32Array(cap);
    this._r = new Float32Array(cap);
    this._g = new Float32Array(cap);
    this._b = new Float32Array(cap);
    this._er = new Float32Array(cap);
    this._eg = new Float32Array(cap);
    this._eb = new Float32Array(cap);
    this._size0 = new Float32Array(cap);
    this._size1 = new Float32Array(cap);
    this._alpha0 = new Float32Array(cap);
    this._alpha1 = new Float32Array(cap);
    this._grav = new Float32Array(cap);
    this._drag = new Float32Array(cap);
    this._life = new Float32Array(cap);
    this._maxLife = new Float32Array(cap);

    this._cursor = 0;
    this._live = 0;

    const geometry = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this._colAttr = new THREE.BufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this._sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this._alphaAttr = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this._posAttr);
    geometry.setAttribute('color', this._colAttr);
    geometry.setAttribute('aSize', this._sizeAttr);
    geometry.setAttribute('aAlpha', this._alphaAttr);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    this.material = this._createMaterial(THREE, { blending, texture, softness, hardness });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = renderOrder;
    this.points.visible = false;
    this.points.name = `fx-${name}`;
  }

  /** @private */
  _createMaterial(THREE, { blending, texture, softness, hardness }) {
    const blend = blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
    const common = {
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: blend,
      toneMapped: true,
    };
    const useShader = this._shaderAvailable();
    if (useShader) {
      try {
        return new THREE.ShaderMaterial({
          uniforms: {
            uMap: { value: texture || null },
            uUseMap: { value: texture ? 1 : 0 },
            uScale: { value: 420 },
            uSoftness: { value: softness },
            uHardness: { value: hardness },
          },
          vertexShader: PARTICLE_VERT,
          fragmentShader: PARTICLE_FRAG,
          ...common,
        });
      } catch (err) {
        // fall through to PointsMaterial
      }
    }
    return new THREE.PointsMaterial({
      map: texture || null,
      size: 0.5,
      sizeAttenuation: true,
      vertexColors: true,
      alphaTest: 0.01,
      ...common,
    });
  }

  /** @private */
  _shaderAvailable() {
    if (this._shaderOk === undefined) this._shaderOk = canUseParticleShader();
    return this._shaderOk;
  }

  /** True when the custom soft-point shader is in use. */
  get usingShader() {
    return !!(this.material && this.material.isShaderMaterial);
  }

  /** Live particle count. */
  get live() {
    return this._live;
  }

  /**
   * Screen-space conversion factor (pixels per world metre at 1 m depth),
   * updated once per frame from the camera by `Effects`.
   * @param {number} value
   */
  setScreenScale(value) {
    if (this.usingShader) this.material.uniforms.uScale.value = value;
  }

  /**
   * Spawn particles. See the class doc for the spec fields.
   * @param {Object} spec reusable object (never retained)
   */
  emit(spec) {
    if (this._live >= this.cap) return 0;
    const count = Math.max(1, (spec.count ?? 1) | 0);
    const cap = this.capacity;
    const maxNew = Math.min(count, this.cap - this._live);
    const spread = spec.spread ?? 0;
    const radius = spec.radius ?? 0;
    const gravity = spec.gravity ?? -9;
    const drag = spec.drag ?? 0.8;
    const life = Math.max(0.02, spec.life ?? 0.6);
    const size0 = spec.size ?? 0.4;
    const size1 = spec.sizeEnd ?? size0 * 0.4;
    const alpha0 = spec.alpha ?? 1;
    const alpha1 = spec.alphaEnd ?? 0;
    readColor(spec.color ?? 0xffffff, TMP);
    const r0 = TMP.r;
    const g0 = TMP.g;
    const b0 = TMP.b;
    let r1 = r0;
    let g1 = g0;
    let b1 = b0;
    if (spec.colorEnd !== undefined) {
      readColor(spec.colorEnd, TMP);
      r1 = TMP.r;
      g1 = TMP.g;
      b1 = TMP.b;
    }
    const bx = spec.x ?? 0;
    const by = spec.y ?? 0;
    const bz = spec.z ?? 0;
    const bvx = spec.vx ?? 0;
    const bvy = spec.vy ?? 0;
    const bvz = spec.vz ?? 0;

    let spawned = 0;
    for (let n = 0; n < maxNew; n++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % cap;
      if (this._life[i] <= 0) this._live++;
      this._life[i] = life;
      this._maxLife[i] = life;
      this._px[i] = bx + (radius ? (rnd() * 2 - 1) * radius : 0);
      this._py[i] = by + (radius ? rnd() * radius : 0);
      this._pz[i] = bz + (radius ? (rnd() * 2 - 1) * radius : 0);
      this._vx[i] = bvx + (spread ? (rnd() * 2 - 1) * spread : 0);
      this._vy[i] = bvy + (spread ? rnd() * spread : 0);
      this._vz[i] = bvz + (spread ? (rnd() * 2 - 1) * spread : 0);
      this._r[i] = r0;
      this._g[i] = g0;
      this._b[i] = b0;
      this._er[i] = r1;
      this._eg[i] = g1;
      this._eb[i] = b1;
      this._size0[i] = size0;
      this._size1[i] = size1;
      this._alpha0[i] = alpha0;
      this._alpha1[i] = alpha1;
      this._grav[i] = gravity;
      this._drag[i] = drag;
      spawned++;
    }
    return spawned;
  }

  /** Integrate + repack the attribute buffers. */
  update(dt) {
    const cap = this.capacity;
    const step = dt > 0 ? dt : 0;
    let live = 0;
    for (let i = 0; i < cap; i++) {
      let l = this._life[i];
      if (l <= 0) continue;
      l -= step;
      if (l <= 0) {
        this._life[i] = 0;
        continue;
      }
      this._life[i] = l;
      const d = this._drag[i];
      const damp = d > 0 ? 1 / (1 + d * step) : 1;
      this._vx[i] *= damp;
      this._vy[i] = this._vy[i] * damp + this._grav[i] * step;
      this._vz[i] *= damp;
      this._px[i] += this._vx[i] * step;
      this._py[i] += this._vy[i] * step;
      this._pz[i] += this._vz[i] * step;
      live++;
    }
    this._live = live;

    const posArr = this._posAttr.array;
    const colArr = this._colAttr.array;
    const sizeArr = this._sizeAttr.array;
    const alphaArr = this._alphaAttr.array;
    let w = 0;
    if (live > 0) {
      for (let i = 0; i < cap && w < live; i++) {
        const l = this._life[i];
        if (l <= 0) continue;
        const maxL = this._maxLife[i];
        const t = maxL > 0 ? 1 - l / maxL : 1;
        const o3 = w * 3;
        const o4 = w * 4;
        posArr[o3] = this._px[i];
        posArr[o3 + 1] = this._py[i];
        posArr[o3 + 2] = this._pz[i];
        colArr[o4] = this._r[i] + (this._er[i] - this._r[i]) * t;
        colArr[o4 + 1] = this._g[i] + (this._eg[i] - this._g[i]) * t;
        colArr[o4 + 2] = this._b[i] + (this._eb[i] - this._b[i]) * t;
        colArr[o4 + 3] = 1;
        sizeArr[w] = (this._size0[i] + (this._size1[i] - this._size0[i]) * t) * this.sizeScale;
        alphaArr[w] = (this._alpha0[i] + (this._alpha1[i] - this._alpha0[i]) * t) * this.globalAlpha;
        w++;
      }
      this._posAttr.needsUpdate = true;
      this._colAttr.needsUpdate = true;
      this._sizeAttr.needsUpdate = true;
      this._alphaAttr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, w);
    this.points.visible = w > 0;
  }

  /**
   * Per-quality live budget. Extras are killed oldest-first (no reallocation).
   * @param {number} value
   */
  setCap(value) {
    this.cap = clamp(value | 0, 0, this.capacity);
    while (this._live > this.cap) this._killOldest();
  }

  /** @private */
  _killOldest() {
    const cap = this.capacity;
    let idx = (this._cursor - 1 + cap) % cap;
    for (let n = 0; n < cap; n++) {
      if (this._life[idx] > 0) {
        this._life[idx] = 0;
        this._live--;
        return;
      }
      idx = (idx - 1 + cap) % cap;
    }
    this._live = 0;
  }

  /** Kill everything immediately (quality change / track change). */
  clear() {
    this._life.fill(0);
    this._live = 0;
    this.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}

/**
 * Pooled chunky debris / confetti (`InstancedMesh` of boxes).
 * Positions integrate on the CPU, each instance tumbles on its own axis.
 */
export class DebrisSystem {
  /**
   * @param {Object} opts
   * @param {any} opts.THREE
   * @param {number} opts.capacity
   * @param {number} [opts.size]  base cube size in metres
   * @param {boolean} [opts.lit]  use a lit material (default true)
   * @param {number} [opts.renderOrder]
   */
  constructor({ THREE, capacity = 96, size = 0.18, lit = true, renderOrder = 1 }) {
    this.THREE = THREE;
    this.capacity = Math.max(1, capacity | 0);
    this.cap = this.capacity;
    this._baseSize = size;
    const cap = this.capacity;

    this._px = new Float32Array(cap);
    this._py = new Float32Array(cap);
    this._pz = new Float32Array(cap);
    this._vx = new Float32Array(cap);
    this._vy = new Float32Array(cap);
    this._vz = new Float32Array(cap);
    this._rx = new Float32Array(cap);
    this._ry = new Float32Array(cap);
    this._rz = new Float32Array(cap);
    this._wx = new Float32Array(cap);
    this._wy = new Float32Array(cap);
    this._wz = new Float32Array(cap);
    this._s0 = new Float32Array(cap);
    this._s1 = new Float32Array(cap);
    this._grav = new Float32Array(cap);
    this._drag = new Float32Array(cap);
    this._life = new Float32Array(cap);
    this._maxLife = new Float32Array(cap);
    /** @type {Array<number|any>} hex number or THREE.Color per slot */
    this._colors = new Array(cap).fill(0xffffff);
    this._cursor = 0;
    this._live = 0;

    this._geometry = new THREE.BoxGeometry(1, 1, 1);
    this._material = lit
      ? new THREE.MeshLambertMaterial({ color: 0xffffff })
      : new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(this._geometry, this._material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = 'fx-debris';
    this._color = new THREE.Color(1, 1, 1);
    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._vec = new THREE.Vector3();
    this._colorScratch = { r: 1, g: 1, b: 1 };
    this.mesh.setColorAt(0, this._color);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  /** Live debris count. */
  get live() {
    return this._live;
  }

  /** @param {Object} spec see `ParticleSystem.emit` (x/y/z/vx…, color, life, size) */
  emit(spec) {
    if (this._live >= this.cap) return 0;
    const cap = this.capacity;
    const maxNew = Math.min(Math.max(1, (spec.count ?? 1) | 0), this.cap - this._live);
    const life = Math.max(0.05, spec.life ?? 1);
    const spread = spec.spread ?? 0;
    const radius = spec.radius ?? 0;
    const size0 = (spec.size ?? this._baseSize) / this._baseSize;
    const size1 = (spec.sizeEnd ?? spec.size ?? this._baseSize) / this._baseSize;
    const gravity = spec.gravity ?? -22;
    const drag = spec.drag ?? 0.4;
    const spin = spec.spin ?? 9;
    let spawned = 0;
    for (let n = 0; n < maxNew; n++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % cap;
      if (this._life[i] <= 0) this._live++;
      this._life[i] = life;
      this._maxLife[i] = life;
      this._px[i] = (spec.x ?? 0) + (radius ? (rnd() * 2 - 1) * radius : 0);
      this._py[i] = (spec.y ?? 0) + (radius ? rnd() * radius : 0);
      this._pz[i] = (spec.z ?? 0) + (radius ? (rnd() * 2 - 1) * radius : 0);
      this._vx[i] = (spec.vx ?? 0) + (spread ? (rnd() * 2 - 1) * spread : 0);
      this._vy[i] = (spec.vy ?? 0) + (spread ? rnd() * spread * 0.5 : 0);
      this._vz[i] = (spec.vz ?? 0) + (spread ? (rnd() * 2 - 1) * spread : 0);
      this._rx[i] = rnd() * Math.PI * 2;
      this._ry[i] = rnd() * Math.PI * 2;
      this._rz[i] = rnd() * Math.PI * 2;
      this._wx[i] = (rnd() * 2 - 1) * spin;
      this._wy[i] = (rnd() * 2 - 1) * spin;
      this._wz[i] = (rnd() * 2 - 1) * spin;
      this._s0[i] = size0;
      this._s1[i] = size1;
      this._grav[i] = gravity;
      this._drag[i] = drag;
      this._colors[i] = spec.color ?? 0xffffff;
      spawned++;
    }
    return spawned;
  }

  update(dt) {
    const cap = this.capacity;
    let live = 0;
    const step = dt > 0 ? dt : 0;
    for (let i = 0; i < cap; i++) {
      let l = this._life[i];
      if (l <= 0) continue;
      l -= step;
      if (l <= 0) {
        this._life[i] = 0;
        continue;
      }
      this._life[i] = l;
      const damp = 1 / (1 + this._drag[i] * step);
      this._vx[i] *= damp;
      this._vy[i] = this._vy[i] * damp + this._grav[i] * step;
      this._vz[i] *= damp;
      this._px[i] += this._vx[i] * step;
      this._py[i] += this._vy[i] * step;
      this._pz[i] += this._vz[i] * step;
      this._rx[i] += this._wx[i] * step;
      this._ry[i] += this._wy[i] * step;
      this._rz[i] += this._wz[i] * step;
      live++;
    }
    this._live = live;
    this.mesh.count = live;
    if (live > 0) {
      let w = 0;
      for (let i = 0; i < cap && w < live; i++) {
        if (this._life[i] <= 0) continue;
        const t = 1 - this._life[i] / this._maxLife[i];
        const s = this._s0[i] + (this._s1[i] - this._s0[i]) * t;
        this._euler.set(this._rx[i], this._ry[i], this._rz[i]);
        this._quat.setFromEuler(this._euler);
        this._vec.set(this._px[i], this._py[i], this._pz[i]);
        this._scale.set(s, s, s);
        this._matrix.compose(this._vec, this._quat, this._scale);
        this.mesh.setMatrixAt(w, this._matrix);
        readColor(this._colors[i], this._colorScratch);
        this._color.setRGB(this._colorScratch.r, this._colorScratch.g, this._colorScratch.b);
        this.mesh.setColorAt(w, this._color);
        w++;
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  setCap(value) {
    this.cap = clamp(value | 0, 0, this.capacity);
    while (this._live > this.cap) {
      const cap = this.capacity;
      let idx = (this._cursor - 1 + cap) % cap;
      let killed = false;
      for (let n = 0; n < cap; n++) {
        if (this._life[idx] > 0) {
          this._life[idx] = 0;
          this._live--;
          killed = true;
          break;
        }
        idx = (idx - 1 + cap) % cap;
      }
      if (!killed) break;
    }
  }

  clear() {
    this._life.fill(0);
    this._live = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this._geometry.dispose();
    this._material.dispose();
    this.mesh.removeFromParent();
  }
}

/**
 * Small pool of one-shot meshes (fireballs, shockwave rings, `?` ghosts,
 * lightning bolts, boost flame cones).
 */
export class MeshPool {
  /**
   * @param {Object} opts
   * @param {any} opts.THREE
   * @param {number} opts.count
   * @param {any} opts.geometry
   * @param {any} opts.material  template material (cloned per entry)
   * @param {number} [opts.renderOrder]
   * @param {boolean} [opts.billboard]
   * @param {boolean} [opts.flat]  lie flat on the ground (rings)
   * @param {string} [opts.name]
   */
  constructor({ THREE, count = 8, geometry, material, renderOrder = 2, billboard = false, flat = false, name = 'mesh-pool' }) {
    this.THREE = THREE;
    this.billboard = billboard;
    this.flat = flat;
    this.cap = count;
    this.name = name;
    this._entries = [];
    for (let i = 0; i < count; i++) {
      const mat = material.clone();
      mat.transparent = true;
      mat.depthWrite = false;
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = renderOrder;
      mesh.name = `${name}-${i}`;
      this._entries.push({
        mesh,
        material: mat,
        life: 0,
        maxLife: 1,
        vx: 0, vy: 0, vz: 0,
        s0: 1, s1: 1,
        o0: 1, o1: 0,
        grav: 0, drag: 0, spin: 0, rot: 0,
        scaleX: 1, scaleY: 1,
      });
    }
    this._cursor = 0;
    this._live = 0;
  }

  get live() {
    return this._live;
  }

  /** Every mesh in the pool (for scene attachment). @returns {any[]} */
  get meshes() {
    return this._entries.map((e) => e.mesh);
  }

  /**
   * @param {Object} spec `{ x,y,z, vx,vy,vz, life, size, sizeEnd, opacity,
   *   opacityEnd, color, gravity, drag, spin, scaleX, scaleY }`
   * @returns {any|null} the mesh (for immediate tweaks) or null when the pool is full
   */
  spawn(spec) {
    let entry = null;
    for (let n = 0; n < this.cap; n++) {
      const i = (this._cursor + n) % this.cap;
      if (this._entries[i].life <= 0) {
        entry = this._entries[i];
        this._cursor = (i + 1) % this.cap;
        break;
      }
    }
    if (!entry) return null;
    const life = Math.max(0.03, spec.life ?? 0.4);
    entry.life = life;
    entry.maxLife = life;
    entry.vx = spec.vx ?? 0;
    entry.vy = spec.vy ?? 0;
    entry.vz = spec.vz ?? 0;
    entry.s0 = spec.size ?? 1;
    entry.s1 = spec.sizeEnd ?? entry.s0;
    entry.o0 = spec.opacity ?? 1;
    entry.o1 = spec.opacityEnd ?? 0;
    entry.grav = spec.gravity ?? 0;
    entry.drag = spec.drag ?? 0;
    entry.spin = spec.spin ?? 0;
    entry.rot = spec.rot ?? 0;
    entry.scaleX = spec.scaleX ?? 1;
    entry.scaleY = spec.scaleY ?? 1;
    entry.mesh.position.set(spec.x ?? 0, spec.y ?? 0, spec.z ?? 0);
    if (this.flat) entry.mesh.rotation.set(-Math.PI / 2, 0, entry.rot);
    else entry.mesh.rotation.set(0, entry.rot, 0);
    entry.material.color.set(spec.color ?? 0xffffff);
    entry.material.opacity = entry.o0;
    entry.mesh.visible = true;
    entry.mesh.scale.set(entry.s0 * entry.scaleX, entry.s0 * entry.scaleY, entry.s0);
    this._live++;
    return entry.mesh;
  }

  /** @param {number} dt @param {any} [camera] */
  update(dt, camera) {
    let live = 0;
    const step = dt > 0 ? dt : 0;
    for (const e of this._entries) {
      if (e.life <= 0) continue;
      e.life -= step;
      if (e.life <= 0) {
        e.life = 0;
        e.mesh.visible = false;
        continue;
      }
      live++;
      const damp = e.drag > 0 ? 1 / (1 + e.drag * step) : 1;
      e.vx *= damp;
      e.vy = e.vy * damp + e.grav * step;
      e.vz *= damp;
      e.mesh.position.x += e.vx * step;
      e.mesh.position.y += e.vy * step;
      e.mesh.position.z += e.vz * step;
      if (e.spin) e.rot += e.spin * step;
      const t = 1 - e.life / e.maxLife;
      const s = e.s0 + (e.s1 - e.s0) * t;
      e.mesh.scale.set(s * e.scaleX, s * e.scaleY, s);
      e.material.opacity = e.o0 + (e.o1 - e.o0) * t;
      if (this.flat) e.mesh.rotation.set(-Math.PI / 2, 0, e.rot);
      else if (this.billboard && camera) e.mesh.quaternion.copy(camera.quaternion);
      else e.mesh.rotation.set(0, e.rot, 0);
    }
    this._live = live;
  }

  /** Kill the oldest entry (used when quality drops). */
  setCap(value) {
    const cap = clamp(value | 0, 0, this.cap);
    if (cap >= this.cap) return;
    // Keep at most `cap` entries alive: kill oldest (largest remaining life first
    // is a decent proxy because all spawns share a similar duration).
    while (this._live > cap) {
      let oldest = null;
      for (const e of this._entries) {
        if (e.life <= 0) continue;
        if (!oldest || e.life > oldest.life) oldest = e;
      }
      if (!oldest) break;
      oldest.life = 0;
      oldest.mesh.visible = false;
      this._live--;
    }
  }

  clear() {
    for (const e of this._entries) {
      e.life = 0;
      e.mesh.visible = false;
    }
    this._live = 0;
  }

  dispose() {
    for (const e of this._entries) {
      e.material.dispose();
      e.mesh.removeFromParent();
    }
  }
}
