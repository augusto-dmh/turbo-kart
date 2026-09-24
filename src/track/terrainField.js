/**
 * Turbo Kart — terrain height field (Agent 2).
 *
 * One analytic field shared by the track builder (clearance, bridge piers) and
 * the environment (terrain mesh, prop placement), so the ground can never
 * contradict the road: inside the road corridor the field is clamped below the
 * road surface, and it only rises again a good distance away.
 *
 * Pure math, no THREE, no allocations in `heightAt`.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, seed, octaves = 4, lac = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 17) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** ridged noise for alpine peaks */
function ridge(x, y, seed, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + o * 29) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/**
 * @param {object} opts
 * @param {any} opts.def track def
 * @param {import('./projection.js').Centerline} opts.cl centerline sample table
 * @param {any} opts.theme theme record
 */
export function createTerrainField({ def, cl, theme }) {
  const seaLevel = theme.water ? theme.water.level : null;
  const corridor = def.corridorRadius ?? 24; // fully clamped radius (m)
  const blend = def.corridorBlend ?? 58;     // back to natural terrain (m)
  const shelf = def.corridorDrop ?? 1.7;     // terrain sits this far under the road
  const gorgeSpans = (def.structures || [])
    .filter((s) => s.kind === 'bridge')
    .map((s) => ({ u0: s.u0, u1: s.u1, depth: s.depth || 24, halfWidth: s.gorgeHalfWidth || 52 }));

  // center of the layout (sea island / falloff reference)
  const count = cl.count;
  let cx = 0, cz = 0;
  for (let i = 0; i < count; i += 4) { cx += cl.px[i]; cz += cl.pz[i]; }
  cx /= count / 4; cz /= count / 4;

  /**
   * Nearest centerline sample. Coarse scan + local refine, allocation free.
   * @returns {{d2:number, i:number}}
   */
  const nearest = { d2: Infinity, i: 0 };
  function nearestSample(x, z) {
    let best = 0, bestD2 = Infinity;
    for (let i = 0; i < count; i += 8) {
      const dx = x - cl.px[i], dz = z - cl.pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    for (let k = -8; k <= 8; k++) {
      const i = (best + k + count) % count;
      const dx = x - cl.px[i], dz = z - cl.pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    nearest.d2 = bestD2;
    nearest.i = best;
    return nearest;
  }

  /** natural terrain before the road corridor is considered */
  function natural(x, z) {
    switch (theme.id) {
      case 'sunset': {
        // coastal plateau: rolling dry hills, island falloff into the sea
        const r = Math.hypot(x - cx, z - cz);
        let h = 6 + fbm(x * 0.0035, z * 0.0035, 11, 4) * 26 + fbm(x * 0.014, z * 0.014, 23, 3) * 5;
        const cliff = 1 - smoothstep(clamp((r - 330) / 170, 0, 1));
        h = h * cliff - (1 - cliff) * 26;
        if (seaLevel !== null) h = Math.max(h, seaLevel - 30);
        return h;
      }
      case 'desert': {
        // terraced mesas: quantised height gives flat tops and steep cliffs
        const n = fbm(x * 0.0022, z * 0.0022, 31, 4);
        const step = 7.5;
        const terr = Math.round(n * 5) / 5;
        let h = 4 + terr * 34 + fbm(x * 0.02, z * 0.02, 47, 3) * 2.4;
        const dune = fbm(x * 0.008, z * 0.008, 59, 3);
        h += Math.max(0, dune - 0.55) * 26;
        return h;
      }
      case 'snow':
      default: {
        // alpine: ridged peaks plus a broad valley shelf
        const rg = ridge(x * 0.0026, z * 0.0026, 71, 5);
        const base = fbm(x * 0.006, z * 0.006, 83, 4);
        let h = 8 + rg * 120 * Math.max(0, base - 0.32) * 2.4 + base * 12;
        return h;
      }
    }
  }

  /** final height: natural terrain capped under the road corridor */
  function heightAt(x, z) {
    let h = natural(x, z);
    const ns = nearestSample(x, z);
    const d = Math.sqrt(ns.d2);
    const roadY = cl.py[ns.i];
    // gorge under a bridge: dig hard, regardless of distance
    for (const g of gorgeSpans) {
      const u = ns.i / count;
      const du = Math.abs(((u - (g.u0 + g.u1) / 2 + 1.5) % 1) - 0.5);
      if (du < (g.u1 - g.u0) / 2 + 0.02) {
        const t = smoothstep(clamp(1 - d / g.halfWidth, 0, 1));
        h = Math.min(h, roadY - g.depth * t - 2);
      }
    }
    const cap = roadY - shelf;
    if (d <= corridor) return Math.min(h, cap);
    if (d < blend) {
      const t = smoothstep((d - corridor) / (blend - corridor));
      return Math.min(h, cap + (h - cap) * t);
    }
    return h;
  }

  /** ground surface type for gameplay/props */
  function surfaceAt(x, z) {
    const ns = nearestSample(x, z);
    const d = Math.sqrt(ns.d2);
    if (d <= cl.wallOffset + 0.6) return 'road';
    return def.offRoadSurface || 'grass';
  }

  /** distance to the centerline (m) + road elevation there */
  function sampleAt(x, z) {
    const ns = nearestSample(x, z);
    return { distance: Math.sqrt(ns.d2), roadY: cl.py[ns.i], index: ns.i, u: ns.i / count };
  }

  return {
    heightAt,
    surfaceAt,
    sampleAt,
    natural,
    seaLevel,
    center: { x: cx, z: cz },
    corridor,
    blend,
    shelf,
    gorgeSpans,
    bounds: cl.bounds,
    theme,
  };
}
