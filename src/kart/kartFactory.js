// STUB — owned by Agent 1 (Engine & Kart). Replace with the full implementation.
import { getCharacter } from '../contracts.js';

export function createKartMesh({ THREE, characterId = 'nova', isPlayer = false }) {
  const c = getCharacter(characterId);
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.45, 1.9),
    new THREE.MeshStandardMaterial({ color: c.color, metalness: 0.4, roughness: 0.35 })
  );
  body.position.y = 0.35;
  group.add(body);
  const driver = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 10),
    new THREE.MeshStandardMaterial({ color: c.accent })
  );
  driver.position.set(0, 0.85, -0.15);
  group.add(driver);
  for (const [x, z] of [[-0.55, 0.6], [0.55, 0.6], [-0.55, -0.6], [0.55, -0.6]]) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 0.24, 12),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.28, z);
    group.add(wheel);
  }
  return { group, update(dt, state) { group.rotation.z = -(state.lean || 0) * 0.3; }, dispose() {} };
}
