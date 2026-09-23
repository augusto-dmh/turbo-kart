// STUB — owned by Agent 2 (Tracks & Environment). Replace with the full implementation.
import { RACE } from '../contracts.js';

export class TrackBuilder {
  constructor({ THREE, trackDef, meta }) {
    this.THREE = THREE;
    this.def = trackDef;
    this.meta = meta || trackDef;
  }

  build() {
    const THREE = this.THREE;
    const def = this.def;
    const pts = def.points.map((p) => new THREE.Vector3(p.x, p.y || 0, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
    const length = curve.getLength();
    const halfWidth = def.width / 2;
    const group = new THREE.Group();

    // Road ribbon
    const N = 400;
    const geo = new THREE.BufferGeometry();
    const verts = [];
    const uvs = [];
    const idx = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u);
      const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
      const l = p.clone().addScaledVector(n, halfWidth);
      const r = p.clone().addScaledVector(n, -halfWidth);
      verts.push(l.x, l.y, l.z, r.x, r.y, r.z);
      uvs.push(0, u * 40, 1, u * 40);
      if (i < N) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3a3f4b, roughness: 0.9 })));

    // Sample table for projection
    const samples = [];
    for (let i = 0; i < N; i++) samples.push(curve.getPointAt(i / N));

    const pointAt = (u, lateral = 0) => {
      const uu = ((u % 1) + 1) % 1;
      const p = curve.getPointAt(uu);
      const t = curve.getTangentAt(uu);
      const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
      return p.clone().addScaledVector(n, lateral);
    };
    const tangentAt = (u) => curve.getTangentAt(((u % 1) + 1) % 1).normalize();
    const project = (pos) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const d = samples[i].distanceToSquared(pos);
        if (d < bestD) { bestD = d; best = i; }
      }
      const u = best / samples.length;
      const t = tangentAt(u);
      const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
      const rel = pos.clone().sub(samples[best]);
      const lateral = rel.dot(n);
      return { u, lateral, onRoad: Math.abs(lateral) <= halfWidth, tangent: t, up: new THREE.Vector3(0, 1, 0) };
    };

    const startGrid = [];
    for (let i = 0; i < RACE.KART_COUNT; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? 1 : -1;
      const u = 0.995 - row * 0.006;
      startGrid.push({ position: pointAt(u, side * 3.5), heading: Math.atan2(tangentAt(u).x, tangentAt(u).z) });
    }

    const trackApi = {
      id: def.id, name: def.name, theme: def.theme, laps: def.laps || 3,
      group, curve, length, halfWidth,
      pointAt, tangentAt, project,
      surfaceNormal: () => new THREE.Vector3(0, 1, 0),
      startGrid, startU: 0,
      checkpointUs: [0.25, 0.5, 0.75, 0.999],
      itemBoxRows: [{ u: 0.12, lateral: [-4, 0, 4] }, { u: 0.55, lateral: [-4, 0, 4] }],
      gimmicks: [{ u: 0.35, lateral: 0, kind: 'boost' }],
      minimap: {
        outline: pts.map((p) => ({ x: p.x, z: p.z })),
        sample: (u) => { const p = pointAt(u); return { x: p.x, z: p.z }; },
      },
      bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
      isOffRoad: (pos) => !project(pos).onRoad,
      dispose() { geo.dispose(); },
    };
    return trackApi;
  }

  dispose() {}
}
