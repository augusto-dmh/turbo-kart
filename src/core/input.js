// STUB — owned by Agent 1 (Engine & Kart). Replace with the full implementation.
import { createInputState } from '../contracts.js';

export function createInput({ bus, domElement } = {}) {
  const state = createInputState();
  const keys = new Set();
  const onDown = (e) => {
    keys.add(e.code);
    bus?.emit?.('audio:unlock');
  };
  const onUp = (e) => keys.delete(e.code);
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);

  return {
    state,
    enabled: true,
    setEnabled(v) { this.enabled = !!v; },
    update() {
      if (!this.enabled) { state.throttle = 0; state.brake = 0; state.steer = 0; state.drift = false; state.useItem = false; return state; }
      state.throttle = keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0;
      state.brake = keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0;
      state.steer = (keys.has('ArrowLeft') || keys.has('KeyA') ? -1 : 0) + (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
      state.drift = keys.has('Space') || keys.has('ShiftLeft');
      state.useItem = keys.has('KeyE') || keys.has('ControlLeft');
      return state;
    },
    dispose() {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    },
  };
}
