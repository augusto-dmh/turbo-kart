/**
 * ============================================================================
 * TURBO KART — post-processing chain (owned by Agent 5)
 * ============================================================================
 * Constructed by main.js as `new PostFX({ THREE, renderer, scene, camera, quality })`
 * and rendered with `postfx.render()` (no arguments!).
 *
 * Chain per quality preset:
 *   low    → no composer at all (`enabled === false`, direct render)
 *   medium → RenderPass + subtle UnrealBloom + OutputPass
 *   high   → + grade pass (vignette / chromatic aberration / grain) + FXAA
 *   ultra  → + radial speed blur & screen flash + SMAA, more bloom, 4x MSAA
 *
 * Robustness:
 *  - Every optional pass is added inside its own try/catch, so one unsupported
 *    feature degrades instead of breaking the picture.
 *  - If the composer cannot be built or throws while rendering, we fall back to
 *    `renderer.render(scene, camera)` **permanently** and warn exactly once.
 *  - Colours: the scene is rendered into a linear HalfFloat target and
 *    `OutputPass` applies the renderer's tone mapping + output colour space, so
 *    the composer matches a direct render instead of washing out.
 *
 * Speed input: `setSpeed(m/s)` is public. Additionally the chain reads the
 * shared `fxState` (written by `Effects`) and subscribes to `KART_BOOST` /
 * `RACE_START` on the bus so the blur works even if Effects is absent.
 */
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

import { QUALITY_PRESETS, EVENTS } from '../contracts.js';
import { bus } from '../core/events.js';
import { GradeShader, SpeedBlurShader } from './shaders.js';
import { fxState, FX_TOP_SPEED } from './fxState.js';

/** Feature matrix + bloom tuning per preset. */
const PRESETS = {
  low: { bloom: null, grade: false, blur: false, aa: 'none', samples: 0 },
  medium: { bloom: [0.34, 0.45, 0.9], grade: false, blur: false, aa: 'none', samples: 0 },
  high: { bloom: [0.5, 0.5, 0.82], grade: true, blur: false, aa: 'fxaa', samples: 2 },
  ultra: { bloom: [0.62, 0.6, 0.78], grade: true, blur: true, aa: 'smaa', samples: 4 },
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PostFX {
  /**
   * @param {Object} opts
   * @param {any} opts.THREE
   * @param {any} opts.renderer
   * @param {any} opts.scene
   * @param {any} opts.camera
   * @param {'low'|'medium'|'high'|'ultra'} [opts.quality]
   */
  constructor({ THREE, renderer, scene, camera, quality = 'high' }) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = QUALITY_PRESETS.includes(quality) ? quality : 'high';

    /** True when the composer chain is active (false on `low` or after failure). */
    this.enabled = false;
    this._composer = null;
    this._passes = [];
    this._bloom = null;
    this._grade = null;
    this._speedPass = null;
    this._aaPass = null;
    this._fallback = false;
    this._warned = false;
    this._time = 0;
    this._speed = 0;
    this._autoSpeed = 0;
    this._boost = 0;
    this._flash = 0;
    this._unsubs = [];
    this._sizeTmp = null;
    this._size = { x: 1, y: 1 };
    this._bloomBase = 0.5;

    this._onResize = () => this.resize();
    try {
      if (typeof window !== 'undefined') window.addEventListener('resize', this._onResize);
    } catch (err) { /* headless — ignore */ }

    this._wireBus();
    this._rebuild();
  }

  // -------------------------------------------------------------- public ----
  /**
   * Apply a quality preset. Rebuilds the chain (and its render targets).
   * @param {'low'|'medium'|'high'|'ultra'} q
   */
  setQuality(q) {
    const preset = QUALITY_PRESETS.includes(q) ? q : 'high';
    if (preset === this.quality) return;
    this.quality = preset;
    // A quality change is an explicit user action: allow the chain to retry
    // once even if it had previously fallen back (e.g. after a context loss).
    this._fallback = false;
    this._rebuild();
  }

  /**
   * Explicit speed input for the ultra radial blur (m/s).
   * @param {number} v
   */
  setSpeed(v) {
    this._speed = typeof v === 'number' && isFinite(v) ? Math.abs(v) : 0;
  }

  /** Recreate/resize render targets after a window or canvas resize. */
  resize() {
    if (!this._composer || !this.enabled) return;
    try {
      const size = this._measure();
      const dpr = this._pixelRatio();
      this._composer.setPixelRatio(dpr);
      this._composer.setSize(size.x, size.y);
    } catch (err) {
      this._fail(err, 'resize');
    }
  }

  /**
   * Render one frame. Called with **no arguments** by main.js.
   * @param {number} [dt] optional delta time (seconds)
   */
  render(dt) {
    if (this._fallback || !this.enabled || !this._composer) {
      this._renderDirect();
      return;
    }
    const step = typeof dt === 'number' && isFinite(dt) ? clamp(dt, 0, 0.1) : 0.016;
    this._time += step;
    this._updateUniforms(step);
    try {
      this._composer.render(step);
    } catch (err) {
      this._fail(err, 'render');
      this._renderDirect();
    }
  }

  /** Release every GPU resource and unsubscribe. */
  dispose() {
    try {
      if (typeof window !== 'undefined') window.removeEventListener('resize', this._onResize);
    } catch (err) { /* ignore */ }
    for (const off of this._unsubs) {
      try { off(); } catch (err) { /* ignore */ }
    }
    this._unsubs.length = 0;
    this._disposeChain();
    this.enabled = false;
  }

  // -------------------------------------------------------------- internals -
  /** @private */
  _wireBus() {
    const on = (event, fn) => {
      try {
        const off = bus.on(event, (payload) => {
          try { fn(payload || {}); } catch (err) { /* never break the bus */ }
        });
        this._unsubs.push(off);
      } catch (err) { /* bus missing — PostFX still works via fxState */ }
    };
    on(EVENTS.KART_BOOST, () => { this._boost = 1; this._autoSpeed = Math.max(this._autoSpeed, 0.85); });
    on(EVENTS.KART_DRIFT_BOOST, () => { this._boost = 1; this._autoSpeed = Math.max(this._autoSpeed, 0.8); });
    on(EVENTS.KART_ROCKET_START, () => { this._boost = 1; this._autoSpeed = 1; });
    on(EVENTS.RACE_START, () => { this._autoSpeed = 0; this._boost = 0; this._flash = 0; });
    on(EVENTS.RACE_COMPLETE, () => { this._autoSpeed = 0; this._boost = 0; });
    on(EVENTS.ITEM_USE, ({ item } = {}) => {
      const id = typeof item === 'string' ? item : item?.id;
      if (id === 'lightning') this._flash = 1;
    });
    on(EVENTS.ITEM_HIT, ({ item } = {}) => {
      const id = typeof item === 'string' ? item : item?.id;
      if (id === 'lightning') this._flash = 1;
    });
  }

  /** @private */
  _rebuild() {
    this._disposeChain();
    const preset = PRESETS[this.quality] || PRESETS.high;
    if (this.quality === 'low') {
      this.enabled = false;
      return;
    }
    const THREE = this.THREE;
    try {
      const size = this._measure();
      const dpr = this._pixelRatio();
      // NOTE: EffectComposer treats the provided render target size as CSS
      // pixels and multiplies by the pixel ratio, so the RT is created at
      // CSS size and `setPixelRatio` scales it to the drawing buffer.
      const rt = new THREE.WebGLRenderTarget(
        Math.max(1, Math.floor(size.x)),
        Math.max(1, Math.floor(size.y)),
        { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false },
      );
      if (preset.samples > 0 && 'samples' in rt) rt.samples = preset.samples;
      const composer = new EffectComposer(this.renderer, rt);
      composer.setPixelRatio(dpr);
      composer.setSize(size.x, size.y);

      const renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(renderPass);
      this._passes.push(renderPass);

      if (preset.bloom) {
        const bloom = this._addPass(composer, 'bloom', () => {
          const p = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), preset.bloom[0], preset.bloom[1], preset.bloom[2]);
          p.threshold = preset.bloom[2];
          return p;
        });
        this._bloom = bloom;
        this._bloomBase = preset.bloom[0];
      }
      if (preset.grade) {
        this._grade = this._addPass(composer, 'grade', () => new ShaderPass(GradeShader));
      }
      if (preset.blur) {
        this._speedPass = this._addPass(composer, 'speed-blur', () => new ShaderPass(SpeedBlurShader));
      }

      // AA: SMAA runs in linear space (before OutputPass), FXAA after it.
      if (preset.aa === 'smaa') {
        this._aaPass = this._addPass(composer, 'smaa', () => new SMAAPass());
      }

      const output = new OutputPass();
      composer.addPass(output);
      this._passes.push(output);

      if (preset.aa === 'fxaa') {
        this._aaPass = this._addPass(composer, 'fxaa', () => new FXAAPass());
      }

      this._composer = composer;
      this.enabled = true;
    } catch (err) {
      this._fail(err, 'build');
    }
  }

  /**
   * Add an optional pass without letting a failure kill the whole chain.
   * @private
   * @param {any} composer
   * @param {string} label
   * @param {() => any} factory
   */
  _addPass(composer, label, factory) {
    try {
      const pass = factory();
      if (!pass) return null;
      composer.addPass(pass);
      this._passes.push(pass);
      return pass;
    } catch (err) {
      if (!this._warned) {
        this._warned = true;
        console.warn(`[postfx] optional pass "${label}" unavailable:`, err?.message || err);
      }
      return null;
    }
  }

  /** @private */
  _disposeChain() {
    for (const pass of this._passes) {
      try { pass.dispose?.(); } catch (err) { /* ignore */ }
    }
    this._passes.length = 0;
    if (this._composer) {
      try { this._composer.dispose(); } catch (err) { /* ignore */ }
    }
    this._composer = null;
    this._bloom = null;
    this._grade = null;
    this._speedPass = null;
    this._aaPass = null;
    this.enabled = false;
  }

  /** @private */
  _renderDirect() {
    this.renderer.render(this.scene, this.camera);
  }

  /** @private */
  _updateUniforms(dt) {
    // Prefer the shared FX state, fall back to bus-driven envelope / setSpeed().
    const speedNorm = clamp(Math.max(
      fxState.speedNorm || 0,
      this._speed / FX_TOP_SPEED,
      this._autoSpeed,
    ), 0, 1);
    this._autoSpeed = Math.max(0, this._autoSpeed - dt * 0.3);
    this._boost = Math.max(fxState.boost || 0, this._boost - dt * 1.2);
    this._flash = Math.max(fxState.flash || 0, this._flash - dt * 3.2);

    if (this._bloom) {
      this._bloom.strength = this._bloomBase * (1 + this._boost * 0.35);
    }
    if (this._grade) {
      const u = this._grade.uniforms;
      if (u.uTime) u.uTime.value = this._time;
      if (u.uFlash) u.uFlash.value = this._flash * 0.35;
      if (u.uAspect) u.uAspect.value = this._size.y > 0 ? this._size.x / this._size.y : 1;
    }
    if (this._speedPass) {
      const u = this._speedPass.uniforms;
      const base = clamp((speedNorm - 0.55) / 0.45, 0, 1);
      if (u.uStrength) u.uStrength.value = base * 0.8 + this._boost * 0.7;
      if (u.uFlash) u.uFlash.value = this._flash;
    }
  }

  /** @private */
  _measure() {
    if (!this._sizeTmp) this._sizeTmp = new this.THREE.Vector2(1, 1);
    const out = this._sizeTmp;
    let w = 0;
    let h = 0;
    try {
      if (typeof window !== 'undefined') {
        w = window.innerWidth || 0;
        h = window.innerHeight || 0;
      }
    } catch (err) { /* ignore */ }
    if (w <= 0 || h <= 0) {
      const size = this.renderer.getSize(new this.THREE.Vector2());
      w = size.x || 1;
      h = size.y || 1;
    }
    out.set(w, h);
    this._size.x = w;
    this._size.y = h;
    return out;
  }

  /** @private */
  _pixelRatio() {
    try {
      const fromRenderer = this.renderer.getPixelRatio?.();
      if (fromRenderer > 0) return Math.min(fromRenderer, 2);
    } catch (err) { /* ignore */ }
    return Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 2);
  }

  /**
   * Permanent, loud-but-once fallback to a direct render.
   * @private
   * @param {any} err
   * @param {string} phase
   */
  _fail(err, phase) {
    this._fallback = true;
    if (!this._warned) {
      this._warned = true;
      console.warn(`[postfx] disabled after ${phase} failure, falling back to direct rendering:`, err?.message || err);
    }
    this._disposeChain();
  }
}

export default PostFX;
