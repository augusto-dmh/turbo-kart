/**
 * Turbo Kart — procedural texture factory (Agent 2).
 *
 * Every texture is generated once on a canvas and cached by key, so a track
 * build never touches the same pixels twice. All colour maps are tagged
 * `SRGBColorSpace` and get a sane anisotropy; when there is no DOM (unit tests,
 * node) the helpers return `null` and the callers fall back to flat colours.
 *
 * No external assets, no network.
 */

/** @returns {boolean} */
export function hasCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/** module-level cache: key -> THREE.Texture|CanvasTexture|null */
const CACHE = new Map();

/**
 * @param {any} THREE injected three namespace
 * @param {string} key cache key
 * @param {()=>any} make factory returning a texture or null
 */
function cached(THREE, key, make) {
  if (CACHE.has(key)) return CACHE.get(key);
  let tex = null;
  try {
    tex = make();
  } catch (err) {
    tex = null;
  }
  CACHE.set(key, tex);
  return tex;
}

/** @param {any} THREE @param {number} w @param {number} h */
function makeCanvas(THREE, w, h) {
  if (!hasCanvas()) return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function finish(THREE, cv, { repeat = [1, 1], srgb = true, aniso = 4, wrap = 1000 } = {}) {
  const tex = new THREE.CanvasTexture(cv);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = wrap;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/** deterministic hash noise */
function hash2(x, y, seed = 1) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, seed, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** rgb hex -> css string */
function css(hex) {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
}
function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

/* -------------------------------------------------------------------------- */
/* road / kerb / ground                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Asphalt: base colour + fbm grain + speckles + subtle lighter wear bands.
 * @param {any} THREE @param {object} opts
 */
export function asphaltTexture(THREE, opts = {}) {
  const { color = 0x44464d, noise = 0.5, wear = 0.4, size = 512, seed = 7, key = 'asphalt' } = opts;
  return cached(THREE, `${key}:${color}:${noise}:${wear}:${size}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = css(color);
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const g = fbm(x * 0.06, y * 0.06, seed, 4);
        const grain = (hash2(x, y, seed + 11) - 0.5) * 46 * noise;
        const patch = (fbm(x * 0.012, y * 0.012, seed + 5, 3) - 0.5) * 40 * wear;
        const v = g * 26 * noise - 13 * noise + grain + patch;
        d[i] = Math.max(0, Math.min(255, d[i] + v));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v));
      }
    }
    ctx.putImageData(img, 0, 0);
    // faint cracks / seams
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1;
    for (let k = 0; k < 26; k++) {
      const x0 = hash2(k, 1, seed) * size, y0 = hash2(k, 2, seed) * size;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      let x = x0, y = y0;
      for (let s = 0; s < 6; s++) {
        x += (hash2(k, s + 3, seed) - 0.5) * 60;
        y += (hash2(k, s + 9, seed) - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return finish(THREE, cv, { repeat: [1, 1] });
  });
}

/** Red/white kerb stripes: two cells across a 1 m strip. */
export function kerbTexture(THREE, { a = 0xd23b2c, b = 0xf3f3ef, cells = 2, size = 128 } = {}) {
  return cached(THREE, `kerb:${a}:${b}:${cells}:${size}`, () => {
    const cv = makeCanvas(THREE, size, 32);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const w = size / cells;
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = i % 2 === 0 ? css(a) : css(b);
      ctx.fillRect(i * w, 0, w + 1, 32);
    }
    // grime + chips so the stripes do not look printed
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 90; i++) {
      const x = hash2(i, 3, 21) * size, y = hash2(i, 4, 22) * 32;
      ctx.fillRect(x, y, 1 + hash2(i, 5, 23) * 3, 1);
    }
    const tex = finish(THREE, cv, { repeat: [1, 1], wrap: 1000 });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** Sand: wind ripples + grit. */
export function sandTexture(THREE, { color = 0xd9b87f, dark = 0xb59560, size = 512, scale = 0.05, seed = 31 } = {}) {
  return cached(THREE, `sand:${color}:${size}:${scale}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const ripple = Math.sin((x * 0.18 + fbm(x * 0.03, y * 0.03, seed, 3) * 9) * Math.PI)
          * 0.5 + 0.5;
        const grit = hash2(x, y, seed + 3);
        const t = 0.45 + ripple * 0.35 + grit * 0.2;
        const c = mixHex(color, dark, 1 - t);
        const rgb = c.match(/\d+/g).map(Number);
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(THREE, cv, { repeat: [1, 1] });
  });
}

/** Snow: soft blue shadows + sparkle specks. */
export function snowTexture(THREE, { color = 0xf2f8fd, shade = 0xc9dcec, size = 512, seed = 41 } = {}) {
  return cached(THREE, `snow:${color}:${size}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const n = fbm(x * 0.04, y * 0.04, seed, 4);
        const c = mixHex(shade, color, 0.35 + n * 0.65);
        const rgb = c.match(/\d+/g).map(Number);
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (let k = 0; k < 420; k++) {
      const x = hash2(k, 1, seed) * size, y = hash2(k, 2, seed) * size;
      ctx.fillRect(x, y, 1, 1);
    }
    return finish(THREE, cv, { repeat: [1, 1] });
  });
}

/** Ice: pale blue sheet with cracks and bright specular streaks. */
export function iceTexture(THREE, { color = 0xbfe9ff, deep = 0x6fb6d8, size = 256, seed = 51 } = {}) {
  return cached(THREE, `ice:${color}:${size}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const n = fbm(x * 0.03, y * 0.03, seed, 4);
        const c = mixHex(deep, color, 0.4 + n * 0.6);
        const rgb = c.match(/\d+/g).map(Number);
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    for (let k = 0; k < 22; k++) {
      ctx.lineWidth = 0.6 + hash2(k, 7, seed) * 1.8;
      ctx.beginPath();
      let x = hash2(k, 1, seed) * size, y = hash2(k, 2, seed) * size;
      ctx.moveTo(x, y);
      let ang = hash2(k, 3, seed) * Math.PI * 2;
      for (let s = 0; s < 5; s++) {
        ang += (hash2(k, s + 4, seed) - 0.5) * 1.1;
        x += Math.cos(ang) * (10 + hash2(k, s, seed) * 26);
        y += Math.sin(ang) * (10 + hash2(k, s, seed) * 26);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return finish(THREE, cv, { repeat: [1, 1] });
  });
}

/* -------------------------------------------------------------------------- */
/* banners, signs, decals                                                      */
/* -------------------------------------------------------------------------- */

/** Start/finish banner: chequer band + track name + sponsor blocks. */
export function bannerTexture(THREE, { text = 'TURBO KART', sub = 'START / FINISH', bg = 0x14161d, accent = 0xffc400, size = [1024, 128] } = {}) {
  return cached(THREE, `banner:${text}:${sub}:${bg}:${accent}`, () => {
    const cv = makeCanvas(THREE, size[0], size[1]);
    if (!cv) return null;
    const [w, h] = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = css(bg);
    ctx.fillRect(0, 0, w, h);
    // chequer bands top + bottom
    const cell = h / 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < w / cell; x++) {
        if ((x + y) % 2 === 0) {
          ctx.fillStyle = '#f5f5f5';
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    ctx.fillStyle = css(bg);
    ctx.fillRect(0, cell * 2, w, h - cell * 4);
    ctx.fillStyle = css(accent);
    ctx.font = `bold ${Math.round(h * 0.42)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h * 0.5 - h * 0.02);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(h * 0.16)}px system-ui, sans-serif`;
    ctx.globalAlpha = 0.85;
    ctx.fillText(sub, w / 2, h * 0.8);
    ctx.globalAlpha = 1;
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Trackside sponsor board (invented brands only). */
export function signTexture(THREE, { text = 'TURBO', bg = 0xff3b30, fg = 0xffffff, size = [256, 128] } = {}) {
  return cached(THREE, `sign:${text}:${bg}:${fg}`, () => {
    const cv = makeCanvas(THREE, size[0], size[1]);
    if (!cv) return null;
    const [w, h] = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = css(bg);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, h * 0.82, w, h * 0.18);
    ctx.fillStyle = css(fg);
    ctx.font = `bold ${Math.round(h * 0.4)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h * 0.46);
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Boost pad: directional chevrons, alpha-cut so it can be laid over asphalt. */
export function chevronTexture(THREE, { color = 0xffffff, glow = 0x35d2ff, size = [128, 256] } = {}) {
  return cached(THREE, `chev:${color}:${glow}:${size}`, () => {
    const cv = makeCanvas(THREE, size[0], size[1]);
    if (!cv) return null;
    const [w, h] = size;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const y0 = (r / rows) * h + 6;
      const hh = h / rows - 12;
      ctx.beginPath();
      ctx.moveTo(w * 0.5, y0);
      ctx.lineTo(w * 0.92, y0 + hh);
      ctx.lineTo(w * 0.5, y0 + hh * 0.62);
      ctx.lineTo(w * 0.08, y0 + hh);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, y0, 0, y0 + hh);
      grad.addColorStop(0, css(glow));
      grad.addColorStop(0.55, css(color));
      grad.addColorStop(1, css(glow));
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
    return finish(THREE, cv, { repeat: [1, 1] });
  });
}

/** Grid slot bracket painted on the tarmac. */
export function gridSlotTexture(THREE, { color = 0xffffff, size = 128 } = {}) {
  return cached(THREE, `grid:${color}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = css(color);
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = size * 0.06;
    const m = size * 0.12;
    ctx.beginPath();
    ctx.moveTo(m, size - m);
    ctx.lineTo(m, m);
    ctx.lineTo(size - m, m);
    ctx.moveTo(size - m, size * 0.45);
    ctx.lineTo(size - m, size - m);
    ctx.lineTo(size * 0.45, size - m);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Soft radial glow used by the sun/moon sprite and lamp heads. */
export function glowTexture(THREE, { inner = 0xffffff, outer = 0xffb45e, size = 256, power = 2.6 } = {}) {
  return cached(THREE, `glow:${inner}:${outer}:${power}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, css(inner));
    g.addColorStop(0.45, css(outer));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.globalAlpha = 1;
    ctx.fillRect(0, 0, size, size);
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Puffy cloud billboard (soft blob, alpha). */
export function cloudTexture(THREE, { color = 0xffffff, seed = 61, size = 256 } = {}) {
  return cached(THREE, `cloud:${color}:${seed}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const rgb = [255, 255, 255];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const nx = (x / size) * 2 - 1, ny = (y / size) * 2 - 1;
        const r = Math.sqrt(nx * nx + ny * ny * 1.5);
        const n = fbm(x * 0.025, y * 0.025, seed, 4);
        const a = Math.max(0, Math.min(1, (1 - r) * 1.6 - 0.35 + n * 0.75));
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
        d[i + 3] = Math.round(a * 235);
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Tangent-space normal map for water: crossing sine waves + noise. */
export function waterNormalTexture(THREE, { size = 256, scale = 24, seed = 77 } = {}) {
  return cached(THREE, `waterNrm:${size}:${scale}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const h = (x, y) => {
      const k = (2 * Math.PI) / scale;
      return (
        Math.sin(x * k * 1.0 + y * k * 0.35) * 0.6 +
        Math.sin(x * k * 0.45 - y * k * 0.9) * 0.45 +
        fbm(x * 0.05, y * 0.05, seed, 3) * 1.2
      );
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const dx = h(x + 1, y) - h(x - 1, y);
        const dy = h(x, y + 1) - h(x, y - 1);
        // tangent-space normal, wrapping
        const nx = -dx * 1.4, ny = -dy * 1.4, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        d[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
        d[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
        d[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = finish(THREE, cv, { repeat: [1, 1], srgb: false });
    return tex;
  });
}

/** Round particle sprite (snow / dust). */
export function particleTexture(THREE, { color = 0xffffff, size = 64 } = {}) {
  return cached(THREE, `particle:${color}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, css(color));
    g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Simple striped trackside flag. */
export function flagTexture(THREE, { a = 0xe8402c, b = 0xf7f3e8, stripes = 5, size = [128, 96] } = {}) {
  return cached(THREE, `flag:${a}:${b}:${stripes}`, () => {
    const cv = makeCanvas(THREE, size[0], size[1]);
    if (!cv) return null;
    const [w, h] = size;
    const ctx = cv.getContext('2d');
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? css(a) : css(b);
      ctx.fillRect(0, (i / stripes) * h, w, h / stripes + 1);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, 0, w * 0.1, h);
    return finish(THREE, cv, { repeat: [1, 1], wrap: 1001 });
  });
}

/** Rock strata / cliff face texture. */
export function rockTexture(THREE, { color = 0xa5643f, alt = 0x7d472c, size = 512, seed = 71 } = {}) {
  return cached(THREE, `rock:${color}:${alt}`, () => {
    const cv = makeCanvas(THREE, size, size);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const strata = Math.sin(y * 0.08 + fbm(x * 0.02, y * 0.02, seed, 3) * 6) * 0.5 + 0.5;
        const n = fbm(x * 0.05, y * 0.05, seed + 9, 4);
        const c = mixHex(alt, color, Math.min(1, strata * 0.5 + n * 0.6));
        const rgb = c.match(/\d+/g).map(Number);
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(THREE, cv, { repeat: [1, 1] });
  });
}

/** Free every texture created through this module (called on track dispose). */
export function disposeTextures(THREE) {
  for (const tex of CACHE.values()) {
    if (tex && typeof tex.dispose === 'function') tex.dispose();
  }
  CACHE.clear();
}

export const _internals = { fbm, hash2, valueNoise, mixHex };
