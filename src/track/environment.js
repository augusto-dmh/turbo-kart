// STUB — owned by Agent 2 (Tracks & Environment). Replace with the full implementation.
export function createEnvironment({ THREE, trackApi, scene }) {
  const group = new THREE.Group();
  const skyGeo = new THREE.SphereGeometry(1400, 24, 16);
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ color: 0x87ceeb, side: THREE.BackSide }));
  group.add(sky);
  scene.add(group);
  return { group, update() {}, dispose() { skyGeo.dispose(); scene.remove(group); } };
}
