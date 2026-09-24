/**
 * Turbo Kart — trackside life & landmarks (Agent 2).
 *
 * Everything is either instanced or merged, placed with a seeded RNG from the
 * track's own control points, and snapped to the shared terrain field so props
 * never float or intersect the road. Quality scaling only changes instance
 * counts / visibility — nothing is rebuilt at runtime.
 */

import { makeRng } from './trackBuilder.js';
import { rockTexture, flagTexture, glowTexture, signTexture } from './textures.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** simple lumpy rock silhouette (lathe-ish icosahedron with jitter) */
function rockGeometry(THREE, rng, detail = 0) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = 0.72 + rng() * 0.5;
    pos.setXYZ(i, x * n, Math.max(y * n * 0.75, -0.35), z * n);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * @param {object} o
 * @param {any} o.THREE
 * @param {any} o.theme
 * @param {any} o.def
 * @param {any} o.trackApi
 * @param {string} [o.quality]
 */
export function createProps({ THREE, theme, def, trackApi, quality = 'high' }) {
  const group = new THREE.Group();
  group.name = 'props';
  const geos = [];
  const mats = [];
  const instanced = [];   // { mesh, full, low, medium }
  const anim = [];        // per-frame updaters
  const rng = makeRng(1337);
  const recipe = def.propSet || {};
  const terrain = trackApi.terrainField || { heightAt: () => 0, sampleAt: () => ({ distance: 999, roadY: 0 }) };
  const qualityLevel = quality;

  const addGeo = (g) => { geos.push(g); return g; };
  /** true when (x,z) is clear of every part of the road (hairpins overlap!) */
  const clearOfRoad = (x, y, z, gap) => {
    const pr = trackApi.project({ x, y, z });
    return Math.abs(pr.lateral) > gap;
  };
  const addMat = (m) => { mats.push(m); return m; };

  /* ------------------------------------------------------------- mountains */
  {
    const layers = theme.id === 'desert' ? 2 : 3;
    const baseY = theme.water ? theme.water.level - 40 : -30;
    for (let L = 0; L < layers; L++) {
      const radius = 620 + L * 260;
      const segments = 72;
      const ridgeH = (theme.id === 'snow' ? 420 : theme.id === 'desert' ? 190 : 230) * (0.7 + L * 0.35);
      const pos = [];
      const col = [];
      const idx = [];
      const outer = new THREE.Color(theme.sky.hazeColor || theme.sky.horizon);
      const rock = new THREE.Color(theme.terrain.rockAlt);
      const snow = new THREE.Color(0xf6fbff);
      const c = new THREE.Color();
      const a0 = L * 0.7;
      for (let s = 0; s <= segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const n = (Math.sin(a * 3 + a0) * 0.5 + Math.sin(a * 7 - a0 * 2) * 0.3 + Math.sin(a * 13 + a0) * 0.2) * 0.5 + 0.5;
        const peak = baseY + 40 + n * ridgeH;
        const mid = peak - (26 + n * 40);
        const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
        pos.push(x * 0.72, baseY, z * 0.72);
        pos.push(x * 0.88, mid, z * 0.88);
        pos.push(x, peak, z);
        // colours: rocky base -> hazy peak (snow on alpine)
        c.copy(rock).lerp(outer, 0.35 + L * 0.18);
        col.push(c.r, c.g, c.b);
        c.copy(rock).lerp(outer, 0.5 + L * 0.18);
        col.push(c.r, c.g, c.b);
        c.copy(theme.id === 'snow' ? snow : rock).lerp(outer, 0.55 + L * 0.2);
        col.push(c.r, c.g, c.b);
        if (s < segments) {
          const a1 = s * 3, b1 = (s + 1) * 3;
          idx.push(a1, a1 + 1, b1, a1 + 1, b1 + 1, b1);
          idx.push(a1 + 1, a1 + 2, b1 + 1, a1 + 2, b1 + 2, b1 + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      addGeo(g);
      const m = addMat(new THREE.MeshBasicMaterial({
        name: `mountains${L}`, vertexColors: true, fog: true, side: THREE.DoubleSide,
      }));
      const mesh = new THREE.Mesh(g, m);
      mesh.name = `mountains${L}`;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  /* ----------------------------------------------------------------- trees */
  const treeKind = recipe.tree || theme.props.tree.kind;
  {
    const trunkMat = addMat(new THREE.MeshStandardMaterial({
      name: 'trunk', color: treeKind === 'pine' ? 0x4a3a2c : treeKind === 'cactus' ? 0x4e7a3c : 0x6b5334,
      roughness: 0.9, metalness: 0,
    }));
    const leafMat = addMat(new THREE.MeshStandardMaterial({
      name: 'leaves', color: treeKind === 'pine' ? 0x2f6b45 : 0x63a844,
      roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    }));
    let trunkGeo;
    let leafGeo;
    if (treeKind === 'pine') {
      trunkGeo = addGeo(new THREE.CylinderGeometry(0.16, 0.26, 2.4, 6));
      trunkGeo.translate(0, 1.2, 0);
      const tiers = [
        new THREE.ConeGeometry(1.9, 3.4, 9),
        new THREE.ConeGeometry(1.45, 3.0, 9),
        new THREE.ConeGeometry(0.95, 2.6, 9),
      ];
      tiers[0].translate(0, 2.6, 0);
      tiers[1].translate(0, 4.0, 0);
      tiers[2].translate(0, 5.4, 0);
      leafGeo = addGeo(mergeSimple(THREE, tiers));
      for (const t of tiers) t.dispose();
    } else if (treeKind === 'cactus') {
      trunkGeo = addGeo(new THREE.CylinderGeometry(0.34, 0.42, 3.4, 8));
      trunkGeo.translate(0, 1.7, 0);
      const armA = addGeo(new THREE.CylinderGeometry(0.2, 0.22, 1.5, 6));
      armA.rotateZ(Math.PI / 2);
      armA.translate(0.62, 2.2, 0);
      const armB = addGeo(new THREE.CylinderGeometry(0.2, 0.22, 1.3, 6));
      armB.rotateZ(Math.PI / 2);
      armB.translate(-0.6, 1.7, 0);
      const upA = addGeo(new THREE.CylinderGeometry(0.2, 0.22, 0.9, 6));
      upA.translate(1.28, 2.6, 0);
      leafGeo = addGeo(mergeSimple(THREE, [armA, armB, upA]));
    } else {
      // palm: tapered trunk + fronds
      trunkGeo = addGeo(new THREE.CylinderGeometry(0.16, 0.34, 6.2, 6));
      trunkGeo.translate(0, 3.1, 0);
      const fronds = [];
      for (let k = 0; k < 7; k++) {
        const f = new THREE.PlaneGeometry(2.8, 0.6, 1, 1);
        f.rotateX(-Math.PI / 2);
        f.translate(1.5, 0, 0);
        f.rotateZ(-0.42 - rng() * 0.22);
        f.rotateY((k / 7) * Math.PI * 2 + rng() * 0.3);
        f.translate(0, 6.1, 0);
        fronds.push(f);
      }
      leafGeo = addGeo(mergeSimple(THREE, fronds));
      for (const f of fronds) f.dispose();
    }
    const treeCfg = theme.props.tree;
    const count = Math.max(0, Math.round(recipe.treeCount ?? treeCfg.count));
    const place = (list) => {
      const total = list.length;
      const dummy = new THREE.Object3D();
      const a = new THREE.InstancedMesh(trunkGeo, trunkMat, total);
      const b = new THREE.InstancedMesh(leafGeo, leafMat, total);
      a.name = 'treeTrunks'; b.name = 'treeLeaves';
      a.castShadow = false; b.castShadow = false;
      a.receiveShadow = true; b.receiveShadow = true;
      for (let i = 0; i < total; i++) {
        const it = list[i];
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(0, it.rot, 0);
        dummy.scale.set(it.s * it.sx, it.s, it.s * it.sx);
        dummy.updateMatrix();
        a.setMatrixAt(i, dummy.matrix);
        b.setMatrixAt(i, dummy.matrix);
      }
      a.instanceMatrix.needsUpdate = true;
      b.instanceMatrix.needsUpdate = true;
      group.add(a, b);
      instanced.push({ mesh: a, full: total }, { mesh: b, full: total });
      return { a, b };
    };
    const spots = [];
    const L = trackApi.length;
    let guard = 0;
    while (spots.length < count && guard++ < count * 12) {
      const u = treeCfg.minU + rng() * (treeCfg.maxU - treeCfg.minU);
      const side = rng() < 0.5 ? 1 : -1;
      const lat = side * (treeCfg.minLat + rng() * (treeCfg.maxLat - treeCfg.minLat));
      const p = trackApi.pointAt(u, lat);
      const h = terrain.heightAt(p.x, p.z);
      if (theme.water && h < theme.water.level + 2) continue;
      if (Math.abs(p.y - h) > 26) continue; // don't hang off cliffs
      if (!clearOfRoad(p.x, p.y, p.z, trackApi.wallOffset + 3)) continue;
      const scale = treeCfg.scale[0] + rng() * (treeCfg.scale[1] - treeCfg.scale[0]);
      spots.push({ x: p.x, y: h - 0.25, z: p.z, rot: rng() * Math.PI * 2, s: scale, sx: 0.85 + rng() * 0.35 });
    }
    place(spots);
  }

  /* ----------------------------------------------------------------- rocks */
  {
    const mat = addMat(new THREE.MeshStandardMaterial({
      name: 'rocks', color: theme.terrain.rock, roughness: 0.95, metalness: 0,
      map: rockTexture(THREE, { color: theme.terrain.rock, alt: theme.terrain.rockAlt }) || null,
    }));
    const geo = addGeo(rockGeometry(THREE, rng, 0));
    const count = Math.max(0, Math.round(recipe.rockCount ?? theme.props.rock.count));
    const dummy = new THREE.Object3D();
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'rocks';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    let placed = 0, guard = 0;
    while (placed < count && guard++ < count * 12) {
      const u = rng();
      const side = rng() < 0.5 ? 1 : -1;
      const lat = side * (14 + rng() * 70);
      const p = trackApi.pointAt(u, lat);
      const h = terrain.heightAt(p.x, p.z);
      if (theme.water && h < theme.water.level + 1) continue;
      if (!clearOfRoad(p.x, p.y, p.z, trackApi.wallOffset + 4)) continue;
      const s = (theme.props.rock.scale[0] + rng() * (theme.props.rock.scale[1] - theme.props.rock.scale[0])) * 1.1;
      dummy.position.set(p.x, h - s * 0.2, p.z);
      dummy.rotation.set(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4);
      dummy.scale.set(s * (0.8 + rng() * 0.6), s * (0.6 + rng() * 0.7), s * (0.8 + rng() * 0.6));
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    instanced.push({ mesh, full: placed });
  }

  /* --------------------------------------------------------- bushes / grass */
  {
    const mat = addMat(new THREE.MeshStandardMaterial({
      name: 'bushes', roughness: 0.9, metalness: 0, vertexColors: true, flatShading: true,
    }));
    const geo = addGeo(new THREE.IcosahedronGeometry(1, 0));
    geo.scale(1, 0.7, 1);
    const count = Math.max(0, Math.round(recipe.bushCount ?? theme.props.bush.count));
    const dummy = new THREE.Object3D();
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'bushes';
    const cA = new THREE.Color(theme.terrain.grass);
    const cB = new THREE.Color(theme.terrain.dry);
    const c = new THREE.Color();
    let placed = 0, guard = 0;
    while (placed < count && guard++ < count * 12) {
      const u = rng();
      const lat = (rng() < 0.5 ? 1 : -1) * (11 + rng() * 34);
      const p = trackApi.pointAt(u, lat);
      const h = terrain.heightAt(p.x, p.z);
      if (theme.water && h < theme.water.level + 1) continue;
      if (!clearOfRoad(p.x, p.y, p.z, trackApi.wallOffset + 1.5)) continue;
      const s = theme.props.bush.scale[0] + rng() * (theme.props.bush.scale[1] - theme.props.bush.scale[0]);
      dummy.position.set(p.x, h + s * 0.25, p.z);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.set(s * 1.3, s * 0.8, s * 1.3);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      c.copy(cA).lerp(cB, rng());
      if (theme.id === 'snow') c.lerp(new THREE.Color(0xffffff), 0.55);
      mesh.setColorAt(placed, c);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    instanced.push({ mesh, full: placed });
  }

  /* --------------------------------------------------- crystals (snow) */
  if ((recipe.crystals || 0) > 0) {
    const mat = addMat(new THREE.MeshStandardMaterial({
      name: 'crystals', color: 0x9fe8ff, roughness: 0.12, metalness: 0.1,
      emissive: 0x1d5f7a, transparent: true, opacity: 0.9, flatShading: true,
    }));
    const geo = addGeo(new THREE.OctahedronGeometry(1, 0));
    geo.scale(0.5, 2.1, 0.5);
    const count = recipe.crystals;
    const dummy = new THREE.Object3D();
    const mesh = new THREE.InstancedMesh(geo, mat, count * 3);
    mesh.name = 'crystals';
    let placed = 0, guard = 0;
    while (placed < count * 3 && guard++ < count * 20) {
      const u = rng();
      const lat = (rng() < 0.5 ? 1 : -1) * (16 + rng() * 50);
      const p = trackApi.pointAt(u, lat);
      const h = terrain.heightAt(p.x, p.z);
      if (!clearOfRoad(p.x, p.y, p.z, trackApi.wallOffset + 2)) continue;
      const s = 0.8 + rng() * 2.4;
      dummy.position.set(p.x, h + s * 1.4, p.z);
      dummy.rotation.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    instanced.push({ mesh, full: placed });
  }

  /* -------------------------------------------------- stands + crowd */
  {
    const standMat = addMat(new THREE.MeshStandardMaterial({ name: 'stand', color: 0xb9bec8, roughness: 0.7, metalness: 0.1, vertexColors: true }));
    const crowdMat = addMat(new THREE.MeshStandardMaterial({ name: 'crowd', roughness: 0.85, metalness: 0, vertexColors: true }));
    const steps = 7;
    const stepH = 0.55, stepD = 1.1, width = 26;
    const pos = [], norm = [], col = [], idx = [];
    const c = new THREE.Color();
    let v = 0;
    const push = (x, y, z, shade) => {
      pos.push(x, y, z);
      norm.push(0, 0, 1);
      c.setHex(theme.id === 'snow' ? 0xc9d6e2 : theme.id === 'desert' ? 0xc8a878 : 0xb9bec8);
      c.multiplyScalar(shade);
      col.push(c.r, c.g, c.b);
      return v++;
    };
    for (let s = 0; s < steps; s++) {
      const y = s * stepH;
      const z = s * stepD;
      const a = push(-width / 2, y, z, 1);
      const b = push(width / 2, y, z, 1);
      const d = push(width / 2, y + stepH, z + stepD, 0.85);
      const e = push(-width / 2, y + stepH, z + stepD, 0.85);
      idx.push(a, b, d, a, d, e);
      // riser
      const f = push(-width / 2, y, z, 0.7);
      const g2 = push(width / 2, y, z, 0.7);
      idx.push(f, e, g2, e, d, g2);
    }
    // roof
    const yTop = steps * stepH + 0.5;
    const zTop = steps * stepD;
    const r0 = push(-width / 2 - 1, yTop + 2.6, zTop + 0.4, 0.6);
    const r1 = push(width / 2 + 1, yTop + 2.6, zTop + 0.4, 0.6);
    const r2 = push(width / 2 + 1, yTop + 2.2, -0.6, 0.75);
    const r3 = push(-width / 2 - 1, yTop + 2.2, -0.6, 0.75);
    idx.push(r0, r1, r2, r0, r2, r3);
    const standGeo = addGeo(new THREE.BufferGeometry());
    standGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    standGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    standGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    standGeo.setIndex(idx);
    standGeo.computeVertexNormals();

    const stands = recipe.stands || [];
    const crowdCount = Math.max(40, Math.round((theme.props.crowd || 400) * (stands.length / 3)));
    const crowdGeo = addGeo(new THREE.BoxGeometry(0.52, 1.0, 0.42));
    crowdGeo.translate(0, 0.5, 0);
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdCount);
    crowd.name = 'crowd';
    const dummy = new THREE.Object3D();
    const palette = [0xff5a4d, 0xffd54d, 0x4dd0ff, 0xb46bff, 0x66e07a, 0xffffff, 0x2b2f3a, 0xff8ac2];
    const cc = new THREE.Color();
    let ci = 0;
    const phases = new Float32Array(crowdCount);
    for (const st of stands) {
      const p = trackApi.pointAt(st.u, st.side * (trackApi.halfWidth + 15));
      if (!clearOfRoad(p.x, p.y, p.z, trackApi.halfWidth + 6)) continue;
      const heading = (() => { const t = trackApi.tangentAt(st.u); return Math.atan2(t.x, t.z); })();
      const mesh = new THREE.Mesh(standGeo, standMat);
      mesh.name = 'grandstand';
      mesh.position.set(p.x, terrain.heightAt(p.x, p.z) - 0.4, p.z);
      mesh.rotation.y = heading + (st.side > 0 ? Math.PI : 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      const per = Math.max(6, Math.floor(crowdCount / Math.max(1, stands.length)));
      for (let k = 0; k < per && ci < crowdCount; k++) {
        const step = k % steps;
        const seat = Math.floor(k / steps) % Math.floor(width / 1.1);
        dummy.position.set(-width / 2 + 0.7 + seat * 1.1, step * stepH, -0.2 + step * stepD);
        dummy.rotation.set(0, (rng() - 0.5) * 0.3, 0);
        dummy.scale.set(1, 0.9 + rng() * 0.25, 1);
        dummy.updateMatrix();
        // convert local -> world
        const m = dummy.matrix.clone();
        mesh.updateMatrix();
        m.premultiply(mesh.matrix);
        crowd.setMatrixAt(ci, m);
        cc.setHex(palette[Math.floor(rng() * palette.length)]);
        crowd.setColorAt(ci, cc);
        phases[ci] = rng() * Math.PI * 2;
        ci++;
      }
    }
    crowd.count = ci;
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    crowd.castShadow = false;
    crowd.frustumCulled = false;
    group.add(crowd);
    instanced.push({ mesh: crowd, full: ci });

    // rolling-wave animation: refresh a slice of the crowd every frame
    const slice = Math.max(8, Math.floor(ci / 10));
    let cursor = 0;
    const base = [];
    for (let i = 0; i < ci; i++) base.push(crowd.instanceMatrix.array.slice(i * 16, i * 16 + 16));
    const anchor = new THREE.Vector3();
    if (stands.length) {
      const p0 = trackApi.pointAt(stands[0].u, 0);
      anchor.copy(p0);
    }
    anim.push((dt, t, camera) => {
      if (camera && camera.position.distanceToSquared(anchor) > 850 * 850) return;
      for (let s = 0; s < slice; s++) {
        const i = (cursor + s) % ci;
        const m = crowd.instanceMatrix.array;
        const o = i * 16;
        const by = base[i][13];
        m[o + 13] = by + Math.max(0, Math.sin(t * 3.4 + phases[i])) * 0.22;
        for (let k = 0; k < 16; k++) if (k !== 13) m[o + k] = base[i][k];
      }
      cursor = (cursor + slice) % ci;
      crowd.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------------------ flags */
  {
    const tex = flagTexture(THREE, { a: theme.kerb.a, b: theme.kerb.b, stripes: 4 });
    const mat = addMat(new THREE.MeshBasicMaterial({
      name: 'flags', map: tex || null, side: THREE.DoubleSide, color: 0xffffff, fog: true,
    }));
    const poleMat = addMat(new THREE.MeshStandardMaterial({ name: 'flagPoles', color: 0xa9b0ba, roughness: 0.5, metalness: 0.5 }));
    const count = Math.max(0, Math.round(recipe.flags ?? theme.props.flags));
    const cols = 4, rows = 3;
    const clothPos = [];
    const clothUv = [];
    const clothIdx = [];
    const clothAnim = [];
    const poleGeo = addGeo(new THREE.CylinderGeometry(0.07, 0.09, 3.4, 5));
    const poleMatrices = [];
    const dummy = new THREE.Object3D();
    let placed = 0, guard = 0;
    while (placed < count && guard++ < count * 8) {
      const u = (placed / count) * 0.985 + 0.006;
      const side = placed % 2 === 0 ? 1 : -1;
      const lat = side * (trackApi.wallOffset + 3.4);
      const p = trackApi.pointAt(u, lat);
      const h = Math.max(terrain.heightAt(p.x, p.z), p.y - 3.2);
      const tan = trackApi.tangentAt(u);
      const yaw = Math.atan2(tan.x, tan.z);
      // pole
      dummy.position.set(p.x, h + 1.7, p.z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poleMatrices.push(dummy.matrix.clone());
      // cloth: 4x3 grid hanging off the pole, index range recorded for the wave
      const start = clothPos.length / 3;
      const w = 1.5, hgt = 0.95;
      for (let r = 0; r <= rows; r++) {
        for (let cIdx = 0; cIdx <= cols; cIdx++) {
          const fx = (cIdx / cols) * w;
          const fy = h + 3.35 - (r / rows) * hgt;
          const local = new THREE.Vector3(fx, fy - (h + 1.7), 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI / 2);
          clothPos.push(p.x + local.x, fy, p.z + local.z);
          clothUv.push(cIdx / cols, 1 - r / rows);
        }
      }
      for (let r = 0; r < rows; r++) {
        for (let cIdx = 0; cIdx < cols; cIdx++) {
          const a0 = start + r * (cols + 1) + cIdx;
          clothIdx.push(a0, a0 + 1, a0 + cols + 1, a0 + 1, a0 + cols + 2, a0 + cols + 1);
        }
      }
      clothAnim.push({ start, cols, rows, phase: rng() * Math.PI * 2, base: null });
      placed++;
    }
    const clothGeo = addGeo(new THREE.BufferGeometry());
    clothGeo.setAttribute('position', new THREE.Float32BufferAttribute(clothPos, 3));
    clothGeo.setAttribute('uv', new THREE.Float32BufferAttribute(clothUv, 2));
    clothGeo.setIndex(clothIdx);
    clothGeo.computeVertexNormals();
    const cloth = new THREE.Mesh(clothGeo, mat);
    cloth.name = 'flags';
    cloth.frustumCulled = false;
    group.add(cloth);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleMatrices.length);
    poles.name = 'flagPoles';
    poles.frustumCulled = false;
    for (let i = 0; i < poleMatrices.length; i++) poles.setMatrixAt(i, poleMatrices[i]);
    poles.instanceMatrix.needsUpdate = true;
    group.add(poles);
    for (const f of clothAnim) f.base = Float32Array.from(clothPos.slice(f.start * 3, (f.start + (f.cols + 1) * (f.rows + 1)) * 3));
    anim.push((dt, t) => {
      const arr = clothGeo.getAttribute('position');
      const p = arr.array;
      for (const f of clothAnim) {
        const count2 = (f.cols + 1) * (f.rows + 1);
        for (let i = 0; i < count2; i++) {
          const ci = f.start + i;
          const cIdx = i % (f.cols + 1);
          const amp = Math.pow(cIdx / f.cols, 1.4) * 0.34;
          const off = Math.sin(t * 3.2 + f.phase + cIdx * 1.3) * amp;
          p[ci * 3] = f.base[i * 3] + off;
          p[ci * 3 + 1] = f.base[i * 3 + 1] + Math.sin(t * 2.1 + f.phase + cIdx) * amp * 0.25;
          p[ci * 3 + 2] = f.base[i * 3 + 2] + off * 0.6;
        }
      }
      arr.needsUpdate = true;
    });
  }

  /* --------------------------------------------------------- lamps (sunset) */
  if ((recipe.lamps || 0) > 0) {
    const mat = addMat(new THREE.MeshStandardMaterial({ name: 'lamps', color: 0x59606b, roughness: 0.5, metalness: 0.6 }));
    const headMat = addMat(new THREE.MeshBasicMaterial({ name: 'lampHeads', color: 0xffe9b0 }));
    const poleGeo = addGeo(new THREE.CylinderGeometry(0.12, 0.2, 8.4, 6));
    poleGeo.translate(0, 4.2, 0);
    const armGeo = addGeo(new THREE.BoxGeometry(1.5, 0.16, 0.16));
    armGeo.translate(0.75, 8.3, 0);
    const headGeo = addGeo(new THREE.BoxGeometry(0.9, 0.28, 0.5));
    headGeo.translate(1.4, 8.2, 0);
    const count = Math.round(recipe.lamps);
    const dummy = new THREE.Object3D();
    const poles = new THREE.InstancedMesh(poleGeo, mat, count);
    const heads = new THREE.InstancedMesh(headGeo, headMat, count);
    poles.name = 'lamps'; heads.name = 'lampHeads';
    for (let i = 0; i < count; i++) {
      const u = (i / count) * 0.99 + 0.005;
      const side = i % 2 === 0 ? 1 : -1;
      const lat = side * (trackApi.wallOffset + 2.4);
      const p = trackApi.pointAt(u, lat);
      const tan = trackApi.tangentAt(u);
      dummy.position.set(p.x, Math.max(terrain.heightAt(p.x, p.z), p.y - 2.6), p.z);
      dummy.rotation.set(0, Math.atan2(tan.x, tan.z) + (side > 0 ? Math.PI : 0), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
      heads.setMatrixAt(i, dummy.matrix);
    }
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    group.add(poles, heads);
    instanced.push({ mesh: poles, full: count }, { mesh: heads, full: count });

    // four floodlight pylons near the start straight
    const pylonMat = addMat(new THREE.MeshStandardMaterial({ name: 'pylon', color: 0x3a4049, roughness: 0.6, metalness: 0.4 }));
    const panelMat = addMat(new THREE.MeshBasicMaterial({ name: 'pylonPanels', color: 0xfff0c4 }));
    const towerGeo = addGeo(new THREE.BoxGeometry(1.2, 22, 1.2));
    towerGeo.translate(0, 11, 0);
    const rigGeo = addGeo(new THREE.BoxGeometry(6.4, 2.6, 0.4));
    const panelGeo = addGeo(new THREE.PlaneGeometry(5.8, 2.1));
    for (let k = 0; k < 4; k++) {
      const u = 0.02 + k * 0.012;
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * (trackApi.wallOffset + 12);
      const p = trackApi.pointAt(u, lat);
      const tan = trackApi.tangentAt(u);
      const yaw = Math.atan2(tan.x, tan.z) + (side > 0 ? Math.PI : 0);
      const tower = new THREE.Mesh(towerGeo, pylonMat);
      tower.position.set(p.x, terrain.heightAt(p.x, p.z), p.z);
      tower.rotation.y = yaw;
      tower.castShadow = false;
      group.add(tower);
      const rig = new THREE.Mesh(rigGeo, pylonMat);
      rig.position.set(p.x, tower.position.y + 22.6, p.z);
      rig.rotation.y = yaw;
      group.add(rig);
      const panel = new THREE.Mesh(panelGeo, panelMat);
      panel.position.set(p.x, tower.position.y + 22.6, p.z);
      panel.rotation.y = yaw;
      panel.translateZ(0.3);
      group.add(panel);
      const glow = glowTexture(THREE, { inner: 0xfff3cc, outer: 0xffd07a, size: 128 });
      if (glow) {
        const sm = new THREE.SpriteMaterial({ map: glow, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
        addMat(sm);
        const sprite = new THREE.Sprite(sm);
        sprite.position.set(p.x, tower.position.y + 22.6, p.z);
        sprite.scale.setScalar(16);
        group.add(sprite);
      }
    }
  }

  /* ------------------------------------------------------------ landmarks */
  const landmarks = recipe.landmarks || [];
  /* lighthouse (sunset) */
  if (landmarks.includes('lighthouse')) {
    const white = addMat(new THREE.MeshStandardMaterial({ name: 'lhWhite', color: 0xf3f1ea, roughness: 0.6, metalness: 0 }));
    const red = addMat(new THREE.MeshStandardMaterial({ name: 'lhRed', color: 0xd6342c, roughness: 0.6, metalness: 0 }));
    const glass = addMat(new THREE.MeshBasicMaterial({ name: 'lhLamp', color: 0xfff0b8 }));
    const towerG = addGeo(new THREE.CylinderGeometry(2.2, 3.4, 26, 12));
    towerG.translate(0, 13, 0);
    const bandG = addGeo(new THREE.CylinderGeometry(2.32, 2.5, 3.4, 12));
    bandG.translate(0, 15, 0);
    const roomG = addGeo(new THREE.CylinderGeometry(2.0, 2.0, 3.0, 10));
    roomG.translate(0, 27.5, 0);
    const roofG = addGeo(new THREE.ConeGeometry(2.6, 2.4, 10));
    roofG.translate(0, 30.2, 0);
    const base = trackApi.pointAt(0.55, 0);
    const dirX = Math.cos(2.1), dirZ = Math.sin(2.1);
    const lx = base.x + dirX * 190, lz = base.z + dirZ * 190;
    const ly = Math.max(terrain.heightAt(lx, lz), (theme.water.level || 0) + 2);
    const tower = new THREE.Mesh(towerG, white);
    tower.position.set(lx, ly - 1, lz);
    tower.castShadow = true;
    group.add(tower);
    const band = new THREE.Mesh(bandG, red);
    band.position.copy(tower.position);
    group.add(band);
    const room = new THREE.Mesh(roomG, glass);
    room.position.copy(tower.position);
    group.add(room);
    const roof = new THREE.Mesh(roofG, red);
    roof.position.copy(tower.position);
    group.add(roof);
  }

  /* rock arch + mesas (desert) */
  if (landmarks.includes('arch')) {
    const mat = addMat(new THREE.MeshStandardMaterial({
      name: 'arch', color: theme.terrain.rock, roughness: 0.95, metalness: 0, flatShading: true,
      map: rockTexture(THREE, { color: theme.terrain.rock, alt: theme.terrain.rockAlt, seed: 103 }) || null,
    }));
    const u = 0.163;
    const p = trackApi.pointAt(u, 0);
    const tan = trackApi.tangentAt(u);
    const yaw = Math.atan2(tan.x, tan.z);
    const span = trackApi.halfWidth + 9.5;
    const legGeo = addGeo(new THREE.BoxGeometry(5.5, 26, 4.5));
    const capGeo = addGeo(new THREE.BoxGeometry(span * 2 + 3, 4.4, 5.2));
    // arch underside: a shallow curve made of 5 boxes
    const archParts = [];
    for (let k = 0; k < 5; k++) {
      const t = k / 4;
      const g = new THREE.BoxGeometry((span * 2 + 3) / 5 + 0.4, 3.4, 5.0);
      g.rotateZ((0.5 - t) * 0.35);
      g.translate((t - 0.5) * (span * 2 + 2), -1.6 - Math.sin(t * Math.PI) * 2.6, 0);
      archParts.push(g);
    }
    const archGeo = addGeo(mergeSimple(THREE, archParts));
    for (const g of archParts) g.dispose();
    const ground = terrain.heightAt(p.x, p.z);
    const arch = new THREE.Group();
    arch.position.set(p.x, ground, p.z);
    arch.rotation.y = yaw;
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.set(side * span, 13, 0);
      leg.castShadow = true;
      arch.add(leg);
    }
    const cap = new THREE.Mesh(capGeo, mat);
    cap.position.set(0, 27.4, 0);
    cap.castShadow = true;
    arch.add(cap);
    const under = new THREE.Mesh(archGeo, mat);
    under.position.set(0, 25.2, 0);
    arch.add(under);
    group.add(arch);
  }
  if (landmarks.includes('mesas')) {
    const mat = addMat(new THREE.MeshStandardMaterial({
      name: 'mesa', color: theme.terrain.rock, roughness: 0.95, metalness: 0, flatShading: true,
      map: rockTexture(THREE, { color: theme.terrain.rock, alt: theme.terrain.rockAlt, seed: 111 }) || null,
    }));
    for (let k = 0; k < 5; k++) {
      const u = 0.1 + k * 0.17;
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * (70 + rng() * 90);
      const p = trackApi.pointAt(u, lat);
      const ground = terrain.heightAt(p.x, p.z);
      const h = 26 + rng() * 34;
      const g = addGeo(new THREE.CylinderGeometry(16 + rng() * 16, 24 + rng() * 18, h, 7));
      g.translate(0, h / 2, 0);
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(p.x, ground - 4, p.z);
      mesh.rotation.y = rng() * Math.PI;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  if (landmarks.includes('icecave') || landmarks.includes('crystals')) {
    const mat = addMat(new THREE.MeshStandardMaterial({
      name: 'iceCave', color: 0xa8dcf0, roughness: 0.25, metalness: 0.05, flatShading: true,
      transparent: true, opacity: 0.92,
    }));
    const u = 0.20;
    const side = -1;
    const lat = side * (trackApi.halfWidth + 26);
    const p = trackApi.pointAt(u, lat);
    const ground = terrain.heightAt(p.x, p.z);
    const shell = addGeo(new THREE.SphereGeometry(13, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62));
    shell.scale(1.4, 1.1, 1.15);
    const cave = new THREE.Mesh(shell, mat);
    cave.position.set(p.x, ground - 1.5, p.z);
    cave.castShadow = true;
    cave.receiveShadow = true;
    group.add(cave);
    const mouth = addGeo(new THREE.TorusGeometry(5.4, 1.5, 6, 12, Math.PI));
    const m = new THREE.Mesh(mouth, mat);
    m.position.set(p.x, ground + 0.4, p.z);
    m.rotation.y = rng() * Math.PI;
    group.add(m);
  }

  /* ------------------------------------------------------ ambient motion */
  /* seagulls (sunset) */
  if ((recipe.birds || 0) > 0) {
    const mat = addMat(new THREE.MeshBasicMaterial({ name: 'birds', color: 0xf4f6f8, side: THREE.DoubleSide }));
    const body = [];
    const w1 = new THREE.BufferGeometry();
    w1.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.9, 0.12, -0.25, 0, 0, -1.1], 3));
    w1.computeVertexNormals();
    const w2 = new THREE.BufferGeometry();
    w2.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -0.9, 0.12, -0.25, 0, 0, -1.1], 3));
    w2.computeVertexNormals();
    addGeo(w1); addGeo(w2);
    body.push(w1, w2);
    const count = recipe.birds;
    const mesh = new THREE.InstancedMesh(addGeo(mergeSimple(THREE, body)), mat, count);
    mesh.name = 'birds';
    mesh.frustumCulled = false;
    const state = [];
    const start = trackApi.pointAt(0.2, 0);
    for (let i = 0; i < count; i++) {
      state.push({
        cx: start.x + (rng() - 0.5) * 220, cz: start.z + (rng() - 0.5) * 220,
        r: 26 + rng() * 46, y: 22 + rng() * 26, a: rng() * Math.PI * 2,
        speed: 0.22 + rng() * 0.25, flap: rng() * Math.PI * 2,
      });
    }
    const dummy = new THREE.Object3D();
    anim.push((dt, t) => {
      for (let i = 0; i < count; i++) {
        const s = state[i];
        s.a += dt * s.speed;
        const x = s.cx + Math.cos(s.a) * s.r;
        const z = s.cz + Math.sin(s.a) * s.r;
        dummy.position.set(x, s.y + Math.sin(t * 0.8 + s.flap) * 2.2, z);
        dummy.rotation.set(0, -s.a + Math.PI / 2, Math.sin(t * 9 + s.flap) * 0.35);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    group.add(mesh);
  }

  /* hot-air balloons (desert) */
  if ((recipe.balloons || 0) > 0) {
    const envMat = addMat(new THREE.MeshStandardMaterial({ name: 'balloons', roughness: 0.7, metalness: 0, flatShading: true }));
    const env = addGeo(new THREE.SphereGeometry(6.5, 10, 8));
    env.scale(1, 1.15, 1);
    const basket = addGeo(new THREE.BoxGeometry(2.2, 1.6, 2.2));
    basket.translate(0, -8.4, 0);
    const total = addGeo(mergeSimple(THREE, [env, basket]));
    const count = recipe.balloons;
    const mesh = new THREE.InstancedMesh(total, envMat, count);
    mesh.name = 'balloons';
    mesh.frustumCulled = false;
    const cols = [0xe8402c, 0xffc400, 0x3f8ef0, 0x7ad66a, 0xb46bff];
    const c = new THREE.Color();
    const state = [];
    for (let i = 0; i < count; i++) {
      const u = 0.12 + i * 0.16;
      const p = trackApi.pointAt(u, (i % 2 ? 1 : -1) * (60 + rng() * 90));
      const ground = terrain.heightAt(p.x, p.z);
      state.push({ x: p.x, z: p.z, y: ground + 60 + rng() * 40, phase: rng() * 10, drift: 0.4 + rng() * 0.5 });
      c.setHex(cols[i % cols.length]);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const dummy = new THREE.Object3D();
    anim.push((dt, t) => {
      for (let i = 0; i < count; i++) {
        const s = state[i];
        dummy.position.set(s.x + Math.sin(t * 0.1 + s.phase) * 30, s.y + Math.sin(t * 0.4 + s.phase) * 3.5, s.z + Math.cos(t * 0.08 + s.phase) * 24);
        dummy.rotation.set(0, s.phase, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    group.add(mesh);
  }

  /* buoys + sailboat (sunset water) */
  if (theme.water && landmarks.includes('buoys')) {
    const mat = addMat(new THREE.MeshStandardMaterial({ name: 'buoys', color: 0xe8402c, roughness: 0.6, metalness: 0.1 }));
    const geo = addGeo(new THREE.SphereGeometry(1.5, 8, 6));
    const count = 8;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'buoys';
    mesh.frustumCulled = false;
    const state = [];
    for (let i = 0; i < count; i++) {
      const u = i / count;
      const p = trackApi.pointAt(u, 0);
      const a = Math.atan2(p.z, p.x) || 0;
      const r = 300 + rng() * 120;
      state.push({ x: Math.cos(a + 0.5) * r, z: Math.sin(a + 0.5) * r, phase: rng() * 10 });
    }
    const dummy = new THREE.Object3D();
    anim.push((dt, t, camera) => {
      for (let i = 0; i < count; i++) {
        const s = state[i];
        dummy.position.set(s.x, (theme.water.level || 0) + Math.sin(t * 1.4 + s.phase) * 0.6 + 0.6, s.z);
        dummy.rotation.set(Math.sin(t + s.phase) * 0.12, 0, Math.cos(t * 0.8 + s.phase) * 0.12);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    group.add(mesh);

    // a sailboat cruising past the coast
    const hullMat = addMat(new THREE.MeshStandardMaterial({ name: 'boat', color: 0xf6f4ee, roughness: 0.6, metalness: 0.05 }));
    const hull = addGeo(new THREE.BoxGeometry(9, 2.4, 3));
    hull.translate(0, 1.2, 0);
    const sail = addGeo(new THREE.PlaneGeometry(4.6, 7.2, 1, 1));
    sail.translate(0.6, 6.2, 0);
    const boat = new THREE.Group();
    boat.add(new THREE.Mesh(hull, hullMat));
    const sailMesh = new THREE.Mesh(sail, addMat(new THREE.MeshBasicMaterial({ name: 'sail', color: 0xffffff, side: THREE.DoubleSide })));
    boat.add(sailMesh);
    group.add(boat);
    anim.push((dt, t) => {
      const a = t * 0.03;
      const r = 380;
      boat.position.set(Math.cos(a) * r, (theme.water.level || 0) + 0.4 + Math.sin(t * 1.1) * 0.4, Math.sin(a) * r);
      boat.rotation.y = -a + Math.PI / 2 + Math.sin(t * 0.4) * 0.06;
      boat.rotation.z = Math.sin(t * 1.1) * 0.05;
    });
  }

  /* ------------------------------------------------------------------ api */
  function update(dt, camera) {
    const t = performance.now() * 0.001;
    // cheap distance gate for the ambient animators
    for (const fn of anim) fn(dt, t, camera);
  }

  function setQuality(q) {
    const f = q === 'low' ? 0.45 : q === 'medium' ? 0.72 : 1;
    for (const it of instanced) {
      const target = Math.max(4, Math.round(it.full * f));
      it.mesh.count = Math.min(it.full, target);
      it.mesh.visible = true;
    }
    void qualityLevel;
  }

  function dispose() {
    for (const g of geos) g.dispose?.();
    for (const m of mats) m.dispose?.();
    group.traverse((o) => {
      if (o.isMesh && o.geometry && !geos.includes(o.geometry)) o.geometry.dispose?.();
      if (o.isMesh && o.material && !mats.includes(o.material)) o.material.dispose?.();
    });
    group.clear();
    if (group.parent) group.parent.remove(group);
  }

  return { group, update, setQuality, dispose };
}

/** Merge simple geometries (position/normal + planar UVs for textured props). */
function mergeSimple(THREE, list) {
  let total = 0;
  for (const g of list) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = [];
  let vo = 0;
  const bbox = new THREE.Box3();
  for (const g of list) {
    const p = g.getAttribute('position');
    pos.set(p.array, vo * 3);
    const n = g.getAttribute('normal');
    if (n) nor.set(n.array, vo * 3);
    // planar UV from the local XZ footprint (rocks / mesas use a texture map)
    g.computeBoundingBox?.();
    const bb = g.boundingBox || bbox;
    const sx = Math.max(1, (bb?.max?.x ?? 1) - (bb?.min?.x ?? 0));
    const sz = Math.max(1, (bb?.max?.z ?? 1) - (bb?.min?.z ?? 0));
    for (let i = 0; i < p.count; i++) {
      uv[(vo + i) * 2] = (p.getX(i) - (bb?.min?.x ?? 0)) / sx;
      uv[(vo + i) * 2 + 1] = (p.getZ(i) - (bb?.min?.z ?? 0)) / sz;
    }
    const gi = g.getIndex();
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(gi.array[i] + vo);
    else for (let i = 0; i < p.count; i++) idx.push(i + vo);
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

export { mergeSimple };
