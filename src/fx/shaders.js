/**
 * ============================================================================
 * TURBO KART — FX shaders & procedural textures (owned by Agent 5)
 * ============================================================================
 * Everything here is generated at runtime: no external assets, no network.
 *
 * Robustness contract:
 *  - `canUseParticleShader()` probes GLSL compilation in a throwaway context.
 *    If anything fails (no WebGL, driver quirk, headless) the caller must fall
 *    back to `THREE.PointsMaterial` and the game keeps running.
 *  - Texture helpers return `null` when there is no DOM (`document` missing),
 *    callers must tolerate a null map.
 */

/** Soft round particle. Per-particle size/colour/alpha, radial falloff. */
export const PARTICLE_VERT = /* glsl */ `
  attribute vec4 color;
  attribute float aSize;
  attribute float aAlpha;

  uniform float uScale;
  uniform float uSoftness;

  varying vec4 vColor;
  varying float vAlpha;

  void main() {
    vColor = color;
    vAlpha = aAlpha;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float depth = max(0.001, -mv.z);
    // Soft particles fade out when they get very close to the camera.
    float nearFade = smoothstep(0.0, uSoftness, depth);
    gl_PointSize = max(1.0, aSize * uScale / depth);
    gl_Position = projectionMatrix * mv;
    vAlpha *= nearFade;
  }
`;

export const PARTICLE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform float uHardness;

  varying vec4 vColor;
  varying float vAlpha;

  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    float d = length(pc) * 2.0;

    float mask;
    if (uUseMap > 0.5) {
      mask = texture2D(uMap, gl_PointCoord).a;
    } else {
      mask = 1.0 - smoothstep(0.0, 1.0, d);
      mask = pow(mask, mix(1.0, 3.0, uHardness));
    }
    if (mask <= 0.001) discard;

    gl_FragColor = vec4(vColor.rgb, vColor.a * vAlpha * mask);
    #include <colorspace_fragment>
  }
`;

/**
 * Combined "grade" pass: vignette + radial chromatic aberration + film grain.
 * Runs in linear space, before `OutputPass`.
 */
export const GradeShader = {
  name: 'TurboKartGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uAberration: { value: 0.6 },
    uGrain: { value: 0.035 },
    uAspect: { value: 1 },
    uSaturation: { value: 1.05 },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uAspect;
    uniform float uSaturation;
    uniform float uFlash;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // --- chromatic aberration (radial, grows towards the edges) ----------
      float amount = uAberration * 0.004 * (0.35 + r2 * 2.6);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + centered * amount).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - centered * amount).b;

      // --- vignette --------------------------------------------------------
      float dist = length(centered * vec2(uAspect, 1.0));
      float vig = 1.0 - smoothstep(0.42, 1.02, dist) * uVignette;
      col *= vig;

      // --- saturation lift -------------------------------------------------
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // --- film grain (animated, luminance weighted) -----------------------
      float n = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 97.0);
      col += (n - 0.5) * uGrain * (1.0 - 0.6 * luma);

      // --- screen flash (lightning / explosions) ---------------------------
      col += vec3(uFlash);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Ultra-only pass: subtle radial speed blur + screen flash.
 * Blur strength is driven by `fxState.speedNorm` / boost envelope.
 */
export const SpeedBlurShader = {
  name: 'TurboKartSpeedBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0 },
    uFlash: { value: 0 },
    uSamples: { value: 6 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    uniform float uFlash;
    uniform float uSamples;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;
      vec2 dir = uv - 0.5;
      vec3 col = vec3(0.0);
      float total = 0.0;
      const int MAX_SAMPLES = 8;
      for (int i = 0; i < MAX_SAMPLES; i++) {
        if (float(i) > uSamples) break;
        float t = float(i) / max(1.0, uSamples);
        float w = 1.0 - t * 0.65;
        col += texture2D(tDiffuse, uv - dir * (t * uStrength * 0.075)).rgb * w;
        total += w;
      }
      col /= max(0.0001, total);
      col += vec3(uFlash);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

/** @type {boolean|undefined} */
let _particleShaderOk;

/**
 * Probe (once) whether the custom point shader compiles in this browser.
 * Creates a throwaway WebGL context; never throws.
 * @returns {boolean}
 */
export function canUseParticleShader() {
  if (_particleShaderOk !== undefined) return _particleShaderOk;
  _particleShaderOk = false;
  if (typeof document === 'undefined') return _particleShaderOk;
  let gl = null;
  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
      || canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false });
    if (!gl) return _particleShaderOk;

    const strip = (src) => src.replace(/^#include .*$/gm, '');
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(vs, `#version 300 es\n#define varying out\n#define attribute in\n${strip(PARTICLE_VERT)}`);
    gl.shaderSource(fs, `#version 300 es\nprecision highp float;\n#define varying in\n#define gl_FragColor pc_fragColor\nlayout(location = 0) out vec4 pc_fragColor;\n#define texture2D texture\n${strip(PARTICLE_FRAG)}`);
    gl.compileShader(vs);
    gl.compileShader(fs);
    const ok = gl.getShaderParameter(vs, gl.COMPILE_STATUS) && gl.getShaderParameter(fs, gl.COMPILE_STATUS);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    _particleShaderOk = !!(ok && gl.getProgramParameter(program, gl.LINK_STATUS));
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  } catch (err) {
    _particleShaderOk = false;
  } finally {
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (err) { /* ignore */ }
  }
  return _particleShaderOk;
}

// ---------------------------------------------------------------------------
// Procedural textures (CanvasTexture). All return `null` without a DOM.
// ---------------------------------------------------------------------------

/**
 * @param {number} size
 * @returns {HTMLCanvasElement|null}
 */
function makeCanvas(size) {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  } catch (err) {
    return null;
  }
}

/**
 * Soft radial sprite, alpha in the A channel (used by the particle shader)
 * and white RGB (so `PointsMaterial` fallback looks identical).
 * @param {any} THREE
 * @param {number} [size]
 * @returns {any|null} THREE.CanvasTexture
 */
export function makeSoftTexture(THREE, size = 64) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const r = size * 0.5;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return makeTexture(THREE, canvas);
}

/**
 * Puffy smoke sprite: a few overlapping soft blobs so puffs do not look like
 * perfect circles.
 * @param {any} THREE
 * @param {number} [size]
 */
export function makeSmokeTexture(THREE, size = 64) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  const blobs = [
    [0.5, 0.5, 0.42], [0.32, 0.42, 0.26], [0.68, 0.44, 0.24],
    [0.44, 0.68, 0.24], [0.62, 0.66, 0.2],
  ];
  for (const [bx, by, br] of blobs) {
    const grad = ctx.createRadialGradient(bx * size, by * size, 0, bx * size, by * size, br * size);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  return makeTexture(THREE, canvas);
}

/**
 * Vertical flame gradient (hot core → transparent tip). Used by the boost
 * flame cone.
 * @param {any} THREE
 * @param {number} [w]
 * @param {number} [h]
 */
export function makeFlameTexture(THREE, w = 64, h = 128) {
  if (typeof document === 'undefined') return null;
  const canvas = makeCanvas(Math.max(w, h));
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = w;
  canvas.height = h;
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,232,120,0.95)');
  grad.addColorStop(0.6, 'rgba(255,130,20,0.55)');
  grad.addColorStop(1.0, 'rgba(255,60,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  return makeTexture(THREE, canvas);
}

/**
 * `?` glyph on transparent background (item box pickup ghost).
 * @param {any} THREE
 * @param {number} [size]
 */
export function makeQuestionTexture(THREE, size = 128) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.72)}px system-ui, sans-serif`;
  ctx.lineWidth = size * 0.09;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.fillStyle = 'rgba(255,246,190,0.95)';
  ctx.fillText('?', size * 0.5, size * 0.54);
  ctx.strokeText('?', size * 0.5, size * 0.54);
  return makeTexture(THREE, canvas);
}

/**
 * Jagged lightning bolt, drawn as a bright polyline with a wide glow.
 * @param {any} THREE
 * @param {number} [w]
 * @param {number} [h]
 */
export function makeBoltTexture(THREE, w = 64, h = 256) {
  if (typeof document === 'undefined') return null;
  const canvas = makeCanvas(Math.max(w, h));
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const pts = [];
  let x = w * 0.5;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    x += (Math.random() - 0.5) * w * 0.42;
    x = Math.max(w * 0.1, Math.min(w * 0.9, x));
    pts.push([i % 2 === 0 ? x : w - x, t * h]);
  }
  const draw = (width, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  };
  draw(w * 0.5, 'rgba(140,160,255,0.28)');
  draw(w * 0.24, 'rgba(200,215,255,0.6)');
  draw(w * 0.1, 'rgba(255,255,255,1)');
  return makeTexture(THREE, canvas);
}

/**
 * Ring / shockwave sprite (soft annulus).
 * @param {any} THREE
 * @param {number} [size]
 */
export function makeRingTexture(THREE, size = 128) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const r = size * 0.5;
  const grad = ctx.createRadialGradient(r, r, r * 0.45, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return makeTexture(THREE, canvas);
}

/**
 * @param {any} THREE
 * @param {HTMLCanvasElement} canvas
 */
function makeTexture(THREE, canvas) {
  try {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch (err) {
    return null;
  }
}
