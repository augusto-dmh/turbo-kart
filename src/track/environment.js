/**
 * Turbo Kart — environment (Agent 2).
 *
 * `createEnvironment({ THREE, trackApi, scene, quality })` returns
 * `{ group, update(dt, camera), setQuality(q), dispose() }`.
 *
 * Builds the world for a track: themed fog/background + light tuning, a
 * heightfield terrain generated from the SAME field the track builder uses,
 * sky/clouds/water/weather (atmosphere.js) and all the trackside life
 * (props.js). `update` also drives `trackApi.update` (boost pads, flags), so
 * the track's own animation stays in sync with the world.
 *
 * Never touches the shared scene graph beyond: scene.fog, scene.background,
 * existing light colours/intensities, and its own `group`.
 */

import { getTheme } from './themes.js';
import { createAtmosphere } from './atmosphere.js';
import { createProps } from './props.js';
import { sandTexture, snowTexture } from './textures.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * @param {object} o
 * @param {any} o.THREE
 * @param {any} o.trackApi
 * @param {any} o.scene
 * @param {string} [o.quality]
 */
export function createEnvironment({ THREE, trackApi, scene, quality = 'high' }) {
  const theme = getTheme(trackApi?.theme || 'sunset');
  const group = new THREE.Group();
  group.name = 'environment';
  const geos = [];
  const mats = [];
  const disposables = [];
  let currentQuality = quality || 'high';

  /* ---------------------------------------------------------- fog & sky --- */
  const fog = new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far);
  if (scene) {
    scene.fog = fog;
    scene.background = new THREE.Color(theme.sky.horizon);
  }

  /* ------------------------------------------------------------ lights --- */
  const dir = {
    x: theme.sky.sunDir[0], y: theme.sky.sunDir[1], z: theme.sky.sunDir[2],
  };
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  dir.x /= dl; dir.y /= dl; dir.z /= dl;
  let hemi = null;
  let sun = null;
  if (scene) {
    scene.traverse((o) => {
      if (o.isHemisphereLight && !hemi) hemi = o;
      if (o.isDirectionalLight && !sun) sun = o;
    });
  }
  if (sun) {
    sun.color.setHex(theme.light.sun.color);
    sun.intensity = theme.light.sun.intensity;
    sun.position.set(dir.x * 420, Math.max(80, dir.y * 420), dir.z * 420);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld?.();
  }
  if (hemi) {
    hemi.color.setHex(theme.light.hemi.sky);
    hemi.groundColor.setHex(theme.light.hemi.ground);
    hemi.intensity = theme.light.hemi.intensity;
  } else if (scene) {
    const h = new THREE.HemisphereLight(theme.light.hemi.sky, theme.light.hemi.ground, theme.light.hemi.intensity);
    h.name = 'envHemi';
    scene.add(h);
    hemi = h;
    disposables.push({ dispose: () => scene.remove(h) });
  }

  /* ----------------------------------------------------------- terrain --- */
  const field = trackApi?.terrainField;
  if (field) {
    const seg = currentQuality === 'low' ? 72 : currentQuality === 'ultra' ? 160 : 128;
    const b = field.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 2200;
    const half = span / 2;
    const n = seg + 1;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const idx = new Uint32Array(seg * seg * 6);
    const cSand = new THREE.Color(theme.terrain.sand);
    const cGrass = new THREE.Color(theme.terrain.grass);
    const cDry = new THREE.Color(theme.terrain.dry);
    const cRock = new THREE.Color(theme.terrain.rock);
    const cRockAlt = new THREE.Color(theme.terrain.rockAlt);
    const cSnow = new THREE.Color(theme.terrain.snow);
    const cc = new THREE.Color();
    const step = span / seg;
    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = cx - half + i * step;
        const z = cz - half + j * step;
        const h = field.heightAt(x, z);
        const k = j * n + i;
        heights[k] = h;
        pos[k * 3] = x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z;
      }
    }
    const sea = field.seaLevel !== null ? field.seaLevel : -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const h = heights[k];
        const hl = heights[j * n + Math.max(0, i - 1)];
        const hr = heights[j * n + Math.min(n - 1, i + 1)];
        const hd = heights[Math.max(0, j - 1) * n + i];
        const hu = heights[Math.min(n - 1, j + 1) * n + i];
        const slope = Math.min(1, (Math.abs(hr - hl) + Math.abs(hu - hd)) / (step * 2.2));
        const rel = h - sea;
        const n2 = 0.5 + 0.5 * Math.sin(pos[k * 3] * 0.02 + pos[k * 3 + 2] * 0.017);
        if (theme.id === 'snow') {
          cc.copy(cSnow).lerp(cRock, clamp(slope * 1.5 - 0.25, 0, 0.85));
          cc.lerp(cRockAlt, clamp(slope * 1.2 - 0.7, 0, 0.5) * n2);
        } else if (theme.id === 'desert') {
          cc.copy(cSand).lerp(cRock, clamp(slope * 1.6 - 0.2, 0, 0.9));
          cc.lerp(cDry, n2 * 0.35);
          if (h > 26) cc.lerp(cRockAlt, clamp((h - 26) / 22, 0, 0.6));
        } else {
          if (rel < 2.2) cc.copy(cSand);
          else cc.copy(cGrass).lerp(cDry, n2 * 0.5);
          cc.lerp(cRock, clamp(slope * 1.7 - 0.1, 0, 0.9));
          if (h > 30) cc.lerp(cRock, clamp((h - 30) / 18, 0, 0.7));
        }
        col[k * 3] = cc.r; col[k * 3 + 1] = cc.g; col[k * 3 + 2] = cc.b;
      }
    }
    let t = 0;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i;
        idx[t++] = a; idx[t++] = a + 1; idx[t++] = a + n;
        idx[t++] = a + 1; idx[t++] = a + n + 1; idx[t++] = a + n;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    geos.push(g);
    const map = theme.id === 'desert'
      ? sandTexture(THREE, { color: theme.terrain.sand, dark: theme.terrain.grass })
      : theme.id === 'snow'
        ? snowTexture(THREE, { color: theme.terrain.snow, shade: theme.terrain.dry })
        : null;
    const m = new THREE.MeshStandardMaterial({
      name: 'terrain', vertexColors: true, roughness: theme.id === 'snow' ? 0.85 : 0.98,
      metalness: 0, flatShading: true, map: map || null,
    });
    if (map) map.repeat.set(span / 90, span / 90);
    mats.push(m);
    const terrain = new THREE.Mesh(g, m);
    terrain.name = 'terrain';
    terrain.receiveShadow = true;
    terrain.castShadow = false;
    terrain.matrixAutoUpdate = false;
    group.add(terrain);
  }

  /* -------------------------------------------------- atmosphere & props --- */
  const atmosphere = createAtmosphere({ THREE, theme, quality: currentQuality, trackApi });
  group.add(atmosphere.group);
  const props = createProps({ THREE, theme, def: trackApi?.trackDef || trackApi?.meta || {}, trackApi, quality: currentQuality });
  group.add(props.group);

  /* ------------------------------------------------------------- lifecycle */
  function update(dt, camera) {
    atmosphere.update(dt, camera);
    props.update(dt, camera);
    trackApi?.update?.(dt, camera);
  }

  function setQuality(q) {
    currentQuality = q || 'high';
    atmosphere.setQuality(currentQuality);
    props.setQuality(currentQuality);
  }

  function dispose() {
    atmosphere.dispose();
    props.dispose();
    for (const g of geos) g.dispose?.();
    for (const m of mats) m.dispose?.();
    for (const d of disposables) d.dispose?.();
    group.clear();
    if (scene) {
      if (group.parent) group.parent.remove(group);
      if (scene.fog === fog) scene.fog = null;
    }
  }

  return {
    group,
    update,
    setQuality,
    dispose,
    /** exposed so other systems can align effects with the sun */
    sunDirection: new THREE.Vector3(dir.x, dir.y, dir.z),
    theme,
    fog,
  };
}
