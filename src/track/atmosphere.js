/**
 * Turbo Kart — sky, clouds, water and weather (Agent 2).
 *
 * Everything here uses stock THREE materials + procedural textures (no custom
 * GLSL), so colour management, fog and post-processing stay consistent with the
 * rest of the game. The sky dome is a vertex-coloured gradient with a sun/moon
 * sprite, stars and aurora layers — cheap, and it never needs a shader compile.
 */

import { glowTexture, cloudTexture, particleTexture, waterNormalTexture } from './textures.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** sun direction (normalised) for a theme */
function sunDir(theme) {
  const d = theme.sky.sunDir || [0.4, 0.5, 0.6];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return { x: d[0] / len, y: d[1] / len, z: d[2] / len };
}

/**
 * @param {object} o
 * @param {any} o.THREE
 * @param {any} o.theme
 * @param {string} [o.quality]
 * @param {any} [o.trackApi]
 */
export function createAtmosphere({ THREE, theme, quality = 'high', trackApi = null }) {
  const group = new THREE.Group();
  group.name = 'atmosphere';
  const geos = [];
  const mats = [];
  const dyn = [];          // per-frame updaters
  const clouds = [];       // cloud billboards
  let weather = null;
  let water = null;
  let qualityLevel = quality;

  /* ------------------------------------------------------------------ sky */
  const skyR = 2600;
  const skyGeo = new THREE.SphereGeometry(skyR, 40, 24);
  geos.push(skyGeo);
  const zenith = new THREE.Color(theme.sky.zenith);
  const horizon = new THREE.Color(theme.sky.horizon);
  const ground = new THREE.Color(theme.sky.ground);
  const col = new THREE.Color();
  {
    const pos = skyGeo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / skyR;
      const h = clamp(y, -1, 1);
      if (h >= 0) {
        const t = Math.pow(h, 0.55);
        col.copy(horizon).lerp(zenith, t);
        // haze band hugging the horizon
        const haze = Math.exp(-h * 7) * (theme.sky.haze ?? 0.4);
        col.lerp(new THREE.Color(theme.sky.hazeColor || theme.sky.horizon), clamp(haze, 0, 0.85));
      } else {
        col.copy(horizon).lerp(ground, clamp(-h * 2.6, 0, 1));
      }
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const skyMat = new THREE.MeshBasicMaterial({
    name: 'sky', vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  mats.push(skyMat);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'skyDome';
  sky.frustumCulled = false;
  sky.matrixAutoUpdate = false;
  group.add(sky);

  const dir = sunDir(theme);
  const sunPos = new THREE.Vector3(dir.x * skyR * 0.94, dir.y * skyR * 0.94, dir.z * skyR * 0.94);

  /* sun / moon glow sprite */
  const glowTex = glowTexture(THREE, {
    inner: theme.sky.sunColor, outer: theme.sky.sunGlow, size: 256, power: 2.4,
  });
  if (glowTex) {
    const glowMat = new THREE.SpriteMaterial({
      name: 'sunGlow', map: glowTex, color: 0xffffff, transparent: true,
      opacity: theme.id === 'snow' ? 0.45 : 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    mats.push(glowMat);
    const sprite = new THREE.Sprite(glowMat);
    sprite.position.copy(sunPos);
    sprite.scale.setScalar(theme.id === 'snow' ? 420 : 620);
    sky.add(sprite);
    // a second, tighter core makes the disc read as a sun
    const coreMat = new THREE.SpriteMaterial({
      name: 'sunCore', map: glowTex, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    mats.push(coreMat);
    const core = new THREE.Sprite(coreMat);
    core.position.copy(sunPos.clone().multiplyScalar(0.999));
    core.scale.setScalar(theme.id === 'snow' ? 110 : 170);
    sky.add(core);
  }

  /* stars (alpine / dusk) */
  if ((theme.sky.stars || 0) > 0) {
    const n = Math.round(700 * theme.sky.stars);
    const pos = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // upper hemisphere only
      const u = Math.random() * Math.PI * 2;
      const v = Math.random() * 0.9 + 0.05;
      const y = Math.sin(v * Math.PI * 0.5);
      const r = Math.cos(v * Math.PI * 0.5);
      pos[i * 3] = Math.cos(u) * r * skyR * 0.97;
      pos[i * 3 + 1] = y * skyR * 0.97;
      pos[i * 3 + 2] = Math.sin(u) * r * skyR * 0.97;
      c.setHSL(0.55 + Math.random() * 0.1, 0.25, 0.7 + Math.random() * 0.3);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(g);
    const m = new THREE.PointsMaterial({
      name: 'stars', size: 16, sizeAttenuation: true, vertexColors: true, transparent: true,
      opacity: 0.9, depthWrite: false, fog: false,
    });
    mats.push(m);
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    sky.add(pts);
  }

  /* aurora: two big additive ribbons */
  if ((theme.sky.aurora || 0) > 0 && quality !== 'low') {
    const bands = [];
    for (let k = 0; k < 2; k++) {
      const g = new THREE.PlaneGeometry(skyR * 1.5, 260, 1, 1);
      geos.push(g);
      const m = new THREE.MeshBasicMaterial({
        name: 'aurora', color: k === 0 ? 0x53ffb0 : 0x7ad6ff, transparent: true,
        opacity: 0.12 * theme.sky.aurora, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      mats.push(m);
      const mesh = new THREE.Mesh(g, m);
      const a = -0.9 + k * 0.7;
      mesh.position.set(Math.sin(a) * skyR * 0.7, skyR * 0.34 + k * 90, Math.cos(a) * skyR * 0.7);
      mesh.lookAt(0, skyR * 0.3, 0);
      sky.add(mesh);
      bands.push(mesh);
    }
    dyn.push((dt, t) => {
      for (let k = 0; k < bands.length; k++) {
        bands[k].material.opacity = (0.1 + 0.06 * Math.sin(t * 0.5 + k * 2.1)) * theme.sky.aurora;
      }
    });
  }

  /* ---------------------------------------------------------------- clouds */
  const cloudCfg = theme.sky.clouds;
  const cloudTex = cloudTexture(THREE, { color: 0xffffff, seed: 61 });
  let cloudMesh = null;
  let cloudMax = 0;
  if (cloudTex && cloudCfg) {
    const layers = quality === 'low' ? 1 : (cloudCfg.layers || 1);
    const perLayer = Math.max(4, Math.round(cloudCfg.count / layers));
    cloudMax = perLayer * layers;
    const g = new THREE.PlaneGeometry(1, 1);
    geos.push(g);
    const m = new THREE.MeshBasicMaterial({
      name: 'clouds', map: cloudTex, transparent: true, opacity: cloudCfg.opacity ?? 0.8,
      depthWrite: false, side: THREE.DoubleSide, fog: true, color: 0xffffff,
    });
    mats.push(m);
    cloudMesh = new THREE.InstancedMesh(g, m, cloudMax);
    cloudMesh.name = 'clouds';
    cloudMesh.frustumCulled = false;
    cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const tint = new THREE.Color();
    for (let k = 0; k < cloudMax; k++) {
      const layer = k % layers;
      const alt = cloudCfg.altitude;
      const y = alt[0] + (alt[1] - alt[0]) * ((layer + Math.random() * 0.6) / layers);
      const size = cloudCfg.size;
      const s = size[0] + Math.random() * (size[1] - size[0]);
      const a = Math.random() * Math.PI * 2;
      const r = 300 + Math.random() * 1400;
      clouds.push({
        pos: new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r),
        scale: new THREE.Vector3(s, s * 0.42, 1),
        rot: (Math.random() - 0.5) * 0.4,
        drift: (cloudCfg.drift || 1) * (0.6 + Math.random() * 0.8),
        phase: Math.random() * 10,
      });
      tint.set(cloudCfg.color).lerp(new THREE.Color(cloudCfg.shade), Math.random() * 0.65);
      cloudMesh.setColorAt(k, tint);
    }
    if (cloudMesh.instanceColor) cloudMesh.instanceColor.needsUpdate = true;
    group.add(cloudMesh);
  }

  /* ----------------------------------------------------------------- water */
  if (theme.water) {
    const w = theme.water;
    const g = new THREE.PlaneGeometry(4200, 4200, 1, 1);
    g.rotateX(-Math.PI / 2);
    geos.push(g);
    const nrm = waterNormalTexture(THREE, { size: 256, scale: 26 });
    const m = new THREE.MeshStandardMaterial({
      name: 'water', color: w.shallow, roughness: 0.08, metalness: 0.25,
      normalMap: nrm || null, normalScale: new THREE.Vector2(0.6, 0.6), transparent: false,
    });
    mats.push(m);
    water = new THREE.Mesh(g, m);
    water.name = 'water';
    water.position.y = w.level;
    water.receiveShadow = false;
    water.frustumCulled = true;
    group.add(water);
    const t0 = { v: 0 };
    const shallowC = new THREE.Color(w.shallow);
    const deepC = new THREE.Color(w.deep);
    const mixC = new THREE.Color();
    const nrmOffset = m.normalMap ? m.normalMap.offset : null;
    dyn.push((dt) => {
      t0.v += dt * 0.02 * (w.speed || 1);
      if (nrmOffset) nrmOffset.set(t0.v * 0.6, t0.v);
      // slow colour breathing between shallow and deep reads as moving water
      mixC.copy(shallowC).lerp(deepC, 0.32 + 0.14 * Math.sin(t0.v * 3));
      m.color.copy(mixC);
    });
  }

  /* --------------------------------------------------------------- weather */
  const weatherCfg = theme.weather;
  if (weatherCfg && quality !== 'low') {
    const want = quality === 'ultra' ? weatherCfg.count : Math.round(weatherCfg.count * 0.7);
    const n = Math.max(200, want);
    const area = weatherCfg.area || 80;
    const height = 90;
    const pos = new Float32Array(n * 3);
    const seedSpeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * area;
      pos[i * 3 + 1] = Math.random() * height;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * area;
      seedSpeed[i] = weatherCfg.speed[0] + Math.random() * (weatherCfg.speed[1] - weatherCfg.speed[0]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geos.push(g);
    const ptex = particleTexture(THREE, { color: weatherCfg.color });
    const m = new THREE.PointsMaterial({
      name: 'weather', size: weatherCfg.size, sizeAttenuation: true, map: ptex || null,
      color: weatherCfg.color, transparent: true, opacity: weatherCfg.kind === 'snow' ? 0.9 : 0.35,
      depthWrite: false, fog: true,
    });
    mats.push(m);
    const pts = new THREE.Points(g, m);
    pts.name = 'weather';
    pts.frustumCulled = false;
    group.add(pts);
    const snow = weatherCfg.kind === 'snow';
    weather = { pts, n, area, height, speed: seedSpeed, snow, pos };
    dyn.push((dt, t, camera) => {
      // keep the volume around the camera; wrap particles inside it
      pts.position.set(camera.position.x, 0, camera.position.z);
      const arr = g.getAttribute('position');
      const p = arr.array;
      const fall = snow ? 1 : 0.25;
      for (let i = 0; i < n; i++) {
        p[i * 3 + 1] -= seedSpeed[i] * dt * fall;
        if (snow) p[i * 3] += Math.sin(t * 1.4 + i) * dt * 1.6;
        if (p[i * 3 + 1] < 0) p[i * 3 + 1] += height;
        if (p[i * 3] > area) p[i * 3] -= area * 2;
        if (p[i * 3] < -area) p[i * 3] += area * 2;
      }
      arr.needsUpdate = true;
    });
  }

  /* ---------------------------------------------------------------- update */
  const tmp = new THREE.Object3D();
  const camPos = new THREE.Vector3();
  const fakeCam = { position: camPos };

  function update(dt, camera) {
    const now = performance.now() * 0.001;
    if (camera) camPos.copy(camera.position);
    // sky + everything parented to it follows the camera
    group.position.set(0, 0, 0);
    sky.position.copy(camPos);
    if (water) water.position.set(camPos.x, theme.water.level, camPos.z);
    if (cloudMesh) {
      const drift = now * 1.0;
      for (let i = 0; i < cloudMax; i++) {
        const c = clouds[i];
        const x = c.pos.x + Math.cos(c.phase) * drift * c.drift;
        const z = c.pos.z + Math.sin(c.phase) * drift * c.drift;
        const wrappedX = ((x - camPos.x + 2100) % 4200) - 2100 + camPos.x;
        const wrappedZ = ((z - camPos.z + 2100) % 4200) - 2100 + camPos.z;
        tmp.position.set(wrappedX, c.pos.y, wrappedZ);
        tmp.rotation.set(0, Math.atan2(camPos.x - wrappedX, camPos.z - wrappedZ), c.rot);
        tmp.scale.copy(c.scale);
        tmp.updateMatrix();
        cloudMesh.setMatrixAt(i, tmp.matrix);
      }
      cloudMesh.instanceMatrix.needsUpdate = true;
    }
    for (const fn of dyn) fn(dt, now, camera || fakeCam);
  }

  function setQuality(q) {
    qualityLevel = q;
    if (weather) weather.pts.visible = q !== 'low';
    if (cloudMesh) cloudMesh.visible = true;
    if (water) water.visible = true;
    void qualityLevel;
  }

  function dispose() {
    for (const g of geos) g.dispose?.();
    for (const m of mats) m.dispose?.();
    group.clear();
    if (group.parent) group.parent.remove(group);
  }

  return { group, sky, water, weather, clouds: cloudMesh, update, setQuality, dispose };
}
