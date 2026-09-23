// STUB — owned by Agent 1 (Engine & Kart). Replace with the full implementation.
import { createKartState, EVENTS } from '../contracts.js';
import { createKartMesh } from './kartFactory.js';

export class Kart {
  constructor({ THREE, bus, trackApi, isPlayer = false, characterId = 'nova', startIndex = 0 }) {
    this.THREE = THREE;
    this.bus = bus;
    this.trackApi = trackApi;
    this.isPlayer = isPlayer;
    this.characterId = characterId;
    this.startIndex = startIndex;
    this.state = createKartState();
    this.lap = 1;
    this.progress = 0;
    this.finished = false;

    const slot = trackApi.startGrid?.[startIndex] || { position: new THREE.Vector3(), heading: 0 };
    const built = createKartMesh({ THREE, characterId, isPlayer });
    this.object3D = built.group;
    this._mesh = built;
    this.object3D.position.copy(slot.position);
    this.yaw = slot.heading || 0;
    this.object3D.rotation.y = this.yaw;
    this.velocity = new THREE.Vector3();
    this._forward = new THREE.Vector3(0, 0, 1);
  }

  get position() { return this.object3D.position; }
  get forward() { return this._forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  get speed() { return this.state.speed; }

  update(dt, input = { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false }) {
    const target = (input.throttle ? 22 : 0) - (input.brake ? 8 : 0);
    this.state.speed += (target - this.state.speed) * Math.min(1, dt * 2.2);
    this.yaw -= (input.steer || 0) * dt * 1.8 * (0.4 + Math.min(1, Math.abs(this.state.speed) / 22));
    this.object3D.rotation.y = this.yaw;
    this.object3D.position.addScaledVector(this.forward, this.state.speed * dt);
    const p = this.trackApi.project(this.object3D.position);
    if (!p.onRoad) this.state.offRoad = true; else this.state.offRoad = false;
    this.progress = p.u;
    this._mesh?.update?.(dt, this.state);
    return this;
  }

  applyBoost(power = 1) { this.state.boosting = true; this.bus?.emit?.(EVENTS.KART_BOOST, { kart: this, source: 'boost', power }); }
  applyImpulse(v) { this.object3D.position.add(v); }
  spinOut() { this.state.spinning = true; this.bus?.emit?.(EVENTS.KART_SPIN, { kart: this }); }
  squash() { this.state.squashed = true; }
  freeze() { this.state.frozen = true; }
  setScale() {}
  resetTo(pos, quat) { this.object3D.position.copy(pos); if (quat) this.object3D.quaternion.copy(quat); }
  dispose() { this._mesh?.dispose?.(); }
}
