/**
 * ============================================================================
 * TURBO KART — Engine (Agent 1)
 * ============================================================================
 * Owns the renderer, the scene, the lighting rig and the camera.
 *
 * Public surface used by `main.js`:
 *   new Engine({ canvas, quality })
 *   engine.scene / engine.camera / engine.renderer / engine.THREE / engine.quality
 *   engine.setQuality(q) / engine.setAtmosphere({...})
 *   engine.updateCamera(dt, kart, { mode, lookBack, paused })
 *   engine.updateMenuCamera(dt) / engine.resetCamera(kart?)
 *   engine.render(postfx) / engine.resize() / engine.onResize(cb)
 *
 * Camera shake is driven by `EVENTS.CAMERA_SHAKE` on the shared bus (imported
 * singleton — the Engine constructor has no bus argument in `main.js`).
 * ============================================================================
 */
import * as THREE from 'three';
import { bus as sharedBus } from './events.js';
import { EVENTS, DEFAULT_QUALITY, DEFAULT_CAMERA_MODE } from '../contracts.js';
import { CameraRig, CAMERA_MODES } from './cameraRig.js';

/** Material texture slots we keep anisotropic. */
const ANISO_MAPS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'bumpMap', 'alphaMap', 'displacementMap', 'specularMap',
];

/**
 * Quality presets. Everything here is safe to change at runtime:
 * the renderer/lighting are reconfigured, never rebuilt.
 */
const PRESETS = {
  low: {
    pixelRatio: 1, shadows: false, shadowMapSize: 512, rimLight: false, rimIntensity: 0,
    anisotropy: 2, shadowHalf: 70, exposure: 1.05,
  },
  medium: {
    pixelRatio: 1.5, shadows: true, shadowMapSize: 1024, rimLight: false, rimIntensity: 0.35,
    anisotropy: 4, shadowHalf: 90, exposure: 1.05,
  },
  high: {
    pixelRatio: 2, shadows: true, shadowMapSize: 2048, rimLight: true, rimIntensity: 0.55,
    anisotropy: 8, shadowHalf: 110, exposure: 1.06,
  },
  ultra: {
    pixelRatio: 2, shadows: true, shadowMapSize: 4096, rimLight: true, rimIntensity: 0.7,
    anisotropy: 16, shadowHalf: 130, exposure: 1.06,
  },
};

const SUN_DISTANCE = 420;

/** @param {string} q @returns {keyof typeof PRESETS} */
function normalizeQuality(q) {
  return PRESETS[q] ? q : DEFAULT_QUALITY;
}

export class Engine {
  /** @param {{canvas?:HTMLCanvasElement, quality?:string, bus?:any}} opts */
  constructor({ canvas, quality = DEFAULT_QUALITY, bus } = {}) {
    this.THREE = THREE;
    this.bus = bus || sharedBus;
    this.canvas = canvas;
    this.quality = normalizeQuality(quality);
    this.preset = PRESETS[this.quality];

    // ------------------------------------------------------------ renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.preset.exposure;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x8ec5ff, 1);
    this.renderer.autoClear = true;
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // --------------------------------------------------------------- scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8ec5ff);
    this.scene.fog = new THREE.Fog(0x9fc4ee, 320, 1600);

    // -------------------------------------------------------------- camera
    const aspect = (typeof window !== 'undefined' && window.innerHeight) ? window.innerWidth / window.innerHeight : 16 / 9;
    this.camera = new THREE.PerspectiveCamera(CAMERA_MODES.chase.fov, aspect, 0.25, 5000);
    this.camera.position.set(0, 6, -14);
    this.camera.up.set(0, 1, 0);

    this._buildLights();

    // ------------------------------------------------------------- runtime
    this.rig = new CameraRig({ camera: this.camera });
    this._menuTime = 0;
    this._lastKart = null;
    this._trackApi = null;
    this._postfx = null;
    this._resizeCbs = new Set();
    this._tmpProj = new THREE.Vector3();
    this._shadowFocus = new THREE.Vector3();
    this._lightBasisX = new THREE.Vector3();
    this._lightBasisY = new THREE.Vector3();
    this._lightBasisZ = new THREE.Vector3();
    this._anisoTimer = 0;
    this._unsubs = [];
    this.disposed = false;
    this.extras = {};

    // Ground query used by the camera rig (bound once, allocation-free).
    this._groundYFn = (x, z, fallback) => this.groundHeightAt(x, z, fallback);

    this._applyQuality();

    if (typeof window !== 'undefined') {
      this._onWindowResize = () => this.resize();
      window.addEventListener('resize', this._onWindowResize, { passive: true });
      window.addEventListener('orientationchange', this._onWindowResize, { passive: true });
      this._onVisibility = () => { if (!document.hidden) this.resize(); };
      document.addEventListener('visibilitychange', this._onVisibility);
    }

    // Camera shake from anywhere in the game (impact FX, items, collisions).
    this._unsubs.push(this.bus?.on?.(EVENTS.CAMERA_SHAKE, (p) => {
      const amount = Number(p?.amount) || 0;
      const duration = Number(p?.duration) || 0.35;
      if (amount > 0) this.rig.shake(amount, duration);
    }));

    this.resize();
  }

  // ============================================================ lighting ==
  _buildLights() {
    const THREE_ = this.THREE;

    // Ambient sky/ground fill.
    this.hemi = new THREE_.HemisphereLight(0xcfe3ff, 0x4a4436, 1.0);
    this.hemi.position.set(0, 60, 0);
    this.scene.add(this.hemi);

    // Key sun with a shadow camera that follows the action.
    this.sun = new THREE_.DirectionalLight(0xfff1d6, 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.preset.shadowMapSize, this.preset.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.near = 20;
    sc.far = SUN_DISTANCE * 2.2;
    sc.left = -this.preset.shadowHalf;
    sc.right = this.preset.shadowHalf;
    sc.top = this.preset.shadowHalf;
    sc.bottom = -this.preset.shadowHalf;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 1.4;
    this.sunTarget = new THREE_.Object3D();
    this.sun.target = this.sunTarget;
    this.scene.add(this.sunTarget);
    this.scene.add(this.sun);

    // Optional rim/back light for silhouette pop (high/ultra).
    this.rim = new THREE_.DirectionalLight(0xa8c8ff, this.preset.rimIntensity);
    this.rim.castShadow = false;
    this.rim.position.set(-140, 90, -220);
    this.scene.add(this.rim);

    this.sunDir = new THREE_.Vector3(0.62, 0.72, 0.32).normalize();
    this._updateSunPosition(0, 0, 0);
  }

  _updateSunPosition(x, y, z) {
    this.sunTarget.position.set(x, y, z);
    this.sun.position.copy(this.sunTarget.position).addScaledVector(this.sunDir, SUN_DISTANCE);
    this.rim.position.set(x - this.sunDir.x * 260, y + 140, z - this.sunDir.z * 260);
  }

  /**
   * Keep the shadow camera tight around the action point (much crisper than a
   * static ±250 m frustum) and snap it to shadow-map texels to avoid swimming.
   */
  _updateSunShadow(kart) {
    if (!this.preset.shadows) return;
    const p = kart.position;
    const half = this.preset.shadowHalf;
    const texel = (half * 2) / Math.max(1, this.sun.shadow.mapSize.width);
    const f = this._shadowFocus.set(p.x, p.y, p.z);
    // Snap in light space.
    const zAxis = this._lightBasisZ.copy(this.sunDir).normalize();
    const xAxis = this._lightBasisX.set(0, 1, 0).cross(zAxis).normalize();
    if (!Number.isFinite(xAxis.x) || xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
    const yAxis = this._lightBasisY.copy(zAxis).cross(xAxis).normalize();
    const lx = f.dot(xAxis);
    const ly = f.dot(yAxis);
    const dx = Math.round(lx / texel) * texel - lx;
    const dy = Math.round(ly / texel) * texel - ly;
    f.addScaledVector(xAxis, dx).addScaledVector(yAxis, dy);
    this._updateSunPosition(f.x, f.y, f.z);
  }

  /**
   * Theme the world from the environment agent. Only the provided fields are
   * touched — if they set `scene.fog` / `scene.background` directly we leave
   * them alone unless explicitly overridden here.
   *
   * @param {{background?:any, fogColor?:any, fogNear?:number, fogFar?:number,
   *          sunColor?:any, sunIntensity?:number, ambientColor?:any,
   *          ambientIntensity?:number, rimColor?:any, rimIntensity?:number,
   *          exposure?:number, sunDirection?:any}} o
   */
  setAtmosphere(o = {}) {
    if (o.background !== undefined) {
      if (o.background === null) this.scene.background = null;
      else if (o.background?.isTexture || o.background?.isColor) this.scene.background = o.background;
      else this.scene.background = new this.THREE.Color(o.background);
    }

    const hasFog = o.fogColor !== undefined || o.fogNear !== undefined || o.fogFar !== undefined;
    if (hasFog) {
      const color = o.fogColor !== undefined ? o.fogColor : (this.scene.fog?.color ?? 0x9fc4ee);
      const near = o.fogNear ?? this.scene.fog?.near ?? 320;
      const far = o.fogFar ?? this.scene.fog?.far ?? 1600;
      if (!this.scene.fog || this.scene.fog.isFog) {
        this.scene.fog = new this.THREE.Fog(color, near, far);
      } else if (this.scene.fog.color) {
        if (o.fogColor !== undefined) this.scene.fog.color.set(color);
      }
    }

    if (o.sunColor !== undefined) this.sun.color.set(o.sunColor);
    if (Number.isFinite(o.sunIntensity)) this.sun.intensity = o.sunIntensity;
    if (o.ambientColor !== undefined) this.hemi.color.set(o.ambientColor);
    if (Number.isFinite(o.ambientIntensity)) this.hemi.intensity = o.ambientIntensity;
    if (o.rimColor !== undefined) this.rim.color.set(o.rimColor);
    if (Number.isFinite(o.rimIntensity)) {
      this.preset.rimIntensity = o.rimIntensity;
      this.rim.intensity = o.rimIntensity;
    }
    if (Number.isFinite(o.exposure)) {
      this.renderer.toneMappingExposure = o.exposure;
      this.preset.exposure = o.exposure;
    }
    if (o.sunDirection) {
      const d = o.sunDirection;
      const v = this.sunDir.set(d.x ?? d[0] ?? 0, d.y ?? d[1] ?? 1, d.z ?? d[2] ?? 0);
      if (v.lengthSq() > 1e-6) v.normalize(); else v.set(0.6, 0.75, 0.3).normalize();
      this._updateSunPosition(this.sunTarget.position.x, this.sunTarget.position.y, this.sunTarget.position.z);
    }
    return this;
  }

  // ============================================================= quality ==
  /**
   * Switch quality preset. Never throws, never rebuilds the renderer.
   * @param {string} q
   */
  setQuality(q) {
    const next = normalizeQuality(q);
    if (next === this.quality && this._qualityApplied) return this;
    this.quality = next;
    this._applyQuality();
    return this;
  }

  _applyQuality() {
    const p = (this.preset = PRESETS[this.quality]);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const pixelRatio = Math.min(dpr, p.pixelRatio);
    this.renderer.setPixelRatio(pixelRatio);

    const shadowsWere = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    this.rim.visible = p.rimLight;
    this.rim.intensity = p.rimIntensity;

    const mapSize = this.sun.shadow.mapSize.width;
    if (mapSize !== p.shadowMapSize) {
      this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    const half = p.shadowHalf;
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.updateProjectionMatrix();

    this.renderer.toneMappingExposure = p.exposure;
    this.applyAnisotropy(p.anisotropy);
    if (shadowsWere !== p.shadows) this._refreshMaterials();

    this._qualityApplied = true;
    this.extras = {
      shadows: p.shadows,
      shadowMapSize: p.shadowMapSize,
      pixelRatio,
      rimLight: p.rimLight,
      anisotropy: p.anisotropy,
      antialias: this.quality !== 'low',
    };
    if (typeof window !== 'undefined') this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    return this;
  }

  /** Toggling shadows at runtime needs a shader recompile for every material. */
  _refreshMaterials() {
    this.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
      else m.needsUpdate = true;
    });
  }

  /**
   * Apply (and clamp) anisotropy to a texture. Public so the track/FX agents
   * can call `engine.applyAnisotropy(tex)` on their procedurally built maps.
   * @param {any} texture @param {number} [level]
   */
  applyAnisotropy(level = this.preset?.anisotropy ?? 4, root = this.scene) {
    const want = Math.max(1, Math.min(this.maxAnisotropy, level));
    root?.traverse?.((o) => {
      const m = o.material;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      for (const mat of mats) {
        for (const key of ANISO_MAPS) {
          const tex = mat[key];
          if (tex && tex.isTexture && tex.anisotropy !== want) {
            tex.anisotropy = want;
            tex.needsUpdate = true;
          }
        }
      }
    });
    return want;
  }

  // ============================================================== camera ==
  /**
   * @param {number} dt
   * @param {any} kart player kart (may be undefined — never throws)
   * @param {{mode?:string, lookBack?:boolean, paused?:boolean}} [opts]
   */
  updateCamera(dt, kart, opts = {}) {
    const mode = CAMERA_MODES[opts.mode] ? opts.mode : DEFAULT_CAMERA_MODE;
    const lookBack = !!opts.lookBack;
    const paused = !!opts.paused;
    this._cameraMode = mode;

    if (paused) return; // hold the camera perfectly still while paused

    if (!kart || !kart.position) {
      this._idleCamera(dt);
      return;
    }

    if (kart !== this._lastKart) {
      // Race start / kart switch: snap so we never fly in from the menu orbit.
      this._lastKart = kart;
      this._trackApi = kart.trackApi || this._trackApi;
      this.rig.reset(kart, mode);
    }

    this.rig.update(dt, kart, { mode, lookBack, groundY: this._groundYFn });
    this._updateSunShadow(kart);
  }

  /** Snap the camera onto the kart immediately (used on race start). */
  resetCamera(kart) {
    const k = kart || this._lastKart;
    if (k) this._lastKart = k;
    this.rig.reset(k, this._cameraMode || this.rig.mode);
    if (k) this._updateSunShadow(k);
  }

  /** Slow cinematic orbit used by the menus. */
  updateMenuCamera(dt = 0.016) {
    this._menuTime += dt;
    const t = this._menuTime;
    const c = this._menuCenter();
    const ang = t * 0.055;
    const r = c.r;
    this.camera.position.set(
      c.x + Math.cos(ang) * r,
      c.y + r * 0.34 + Math.sin(t * 0.19) * 2.2,
      c.z + Math.sin(ang) * r,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(
      c.x + Math.sin(t * 0.09) * 7,
      c.y + 3.5 + Math.sin(t * 0.14) * 2.0,
      c.z + Math.cos(t * 0.11) * 7,
    );
    const fov = 58 + Math.sin(t * 0.13) * 3;
    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // Keep the rig "un-snapped" so entering a race always starts clean.
    this.rig.reset(null, this.rig.mode);
  }

  _menuCenter() {
    const b = this._trackApi?.bounds;
    if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX)) {
      const x = (b.minX + b.maxX) * 0.5;
      const z = (b.minZ + b.maxZ) * 0.5;
      const r = Math.max(40, Math.min(220, Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.55));
      return { x, y: 0, z, r };
    }
    return { x: 0, y: 0, z: 0, r: 70 };
  }

  /** Fallback when no kart exists: drift gently instead of freezing. */
  _idleCamera(dt) {
    this._menuTime += dt;
    const t = this._menuTime;
    const p = this.camera.position;
    this.camera.lookAt(p.x + Math.sin(t * 0.1) * 20, p.y - 2, p.z + Math.cos(t * 0.1) * 20);
  }

  /**
   * Ground height under a world position, using the track API when available.
   * @param {number} x @param {number} z @param {number} [fallback]
   * @returns {number}
   */
  groundHeightAt(x, z, fallback = 0) {
    const api = this._trackApi;
    if (!api || typeof api.project !== 'function' || typeof api.pointAt !== 'function') return fallback;
    try {
      const p = api.project(this._tmpProj.set(x, fallback, z));
      if (!p) return fallback;
      const gp = api.pointAt(p.u, p.lateral);
      if (gp && Number.isFinite(gp.y)) return gp.y;
    } catch {
      /* track api unavailable — ignore */
    }
    return fallback;
  }

  /** Optional explicit track binding (main.js does not call this; we auto-detect). */
  setTrack(trackApi) {
    this._trackApi = trackApi || null;
    return this;
  }

  // ============================================================== render ==
  /** @param {{render?:Function, resize?:Function}} [postfx] */
  render(postfx) {
    if (postfx && typeof postfx.render === 'function') {
      this._postfx = postfx;
      postfx.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    // Late-created textures (tracks, FX) still want anisotropy.
    this._anisoTimer += 1;
    if (this._anisoTimer >= 180) {
      this._anisoTimer = 0;
      this.applyAnisotropy(this.preset.anisotropy);
    }
  }

  // ============================================================== resize ==
  resize() {
    if (typeof window === 'undefined') return this;
    const w = Math.max(1, window.innerWidth || 1);
    const h = Math.max(1, window.innerHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(dpr);
    // `false`: CSS owns the canvas size (`#game-canvas { width/height: 100% }`).
    this.renderer.setSize(w, h, false);

    this._postfx?.resize?.(w, h, dpr);
    for (const cb of this._resizeCbs) {
      try {
        cb({ width: w, height: h, pixelRatio: dpr, aspect: w / h });
      } catch (err) {
        console.error('[engine] resize callback failed:', err);
      }
    }
    return this;
  }

  /** @param {(info:{width:number,height:number,pixelRatio:number,aspect:number}) => void} cb */
  onResize(cb) {
    if (typeof cb !== 'function') return () => {};
    this._resizeCbs.add(cb);
    return () => this._resizeCbs.delete(cb);
  }

  /** Release listeners + GPU resources. Not called by `main.js`. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this._unsubs) u?.();
    this._unsubs.length = 0;
    this._resizeCbs.clear();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onWindowResize);
      window.removeEventListener('orientationchange', this._onWindowResize);
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    this.renderer.dispose();
  }
}

export default Engine;
