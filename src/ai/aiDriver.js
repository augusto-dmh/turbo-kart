// STUB — owned by Agent 3 (AI, Race Logic & Items). Replace with the full implementation.
import { createInputState } from '../contracts.js';

export class AIDriver {
  constructor({ THREE, bus, kart, trackApi, difficulty = 'normal', index = 0 }) {
    this.THREE = THREE;
    this.bus = bus;
    this.kart = kart;
    this.trackApi = trackApi;
    this.difficulty = difficulty;
    this.index = index;
    this.input = createInputState();
    this.lookahead = 0.012 + index * 0.0005;
  }

  update(dt) {
    const p = this.trackApi.project(this.kart.position);
    const targetU = (p.u + this.lookahead) % 1;
    const target = this.trackApi.pointAt(targetU, 0);
    const fwd = this.kart.forward;
    const to = target.clone().sub(this.kart.position);
    const angle = Math.atan2(fwd.x * to.z - fwd.z * to.x, fwd.x * to.x + fwd.z * to.z);
    this.input.throttle = 1;
    this.input.steer = Math.max(-1, Math.min(1, -angle * 1.6));
    return this.input;
  }

  dispose() {}
}
