// STUB — owned by Agent 4 (UI, HUD & Audio). Replace with the full WebAudio implementation.
import { EVENTS } from '../contracts.js';

export class AudioManager {
  constructor({ bus, settings = {} } = {}) {
    this.bus = bus;
    this.settings = settings;
    this.ctx = null;
    this.unlocked = false;
    bus?.on?.(EVENTS.AUDIO_SFX, ({ name } = {}) => this.playSfx(name));
    bus?.on?.(EVENTS.AUDIO_MUSIC, ({ name } = {}) => this.playMusic(name));
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  unlock() {
    if (this.unlocked) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.unlocked = true;
    } catch { /* audio unavailable */ }
  }

  playSfx(name) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = name === 'countdown' ? 440 : 220;
    g.gain.value = 0.05 * (this.settings.sfx ?? 1);
    o.connect(g).connect(this.ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15);
    o.stop(this.ctx.currentTime + 0.16);
  }

  playMusic() {}
  setVolumes(v = {}) { Object.assign(this.settings, v); }
  update() {}
  dispose() {}
}
