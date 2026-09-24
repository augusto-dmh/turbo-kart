/**
 * Turbo Kart — AudioManager (Agent 4).
 * ----------------------------------------------------------------------------
 * Fully synthesized WebAudio: no audio files, no network. Everything is built
 * from oscillators, generated noise and generated impulse-response reverb.
 *
 * Graph:
 *   master ── compressor ── destination
 *     ├── musicBus ── MusicEngine (procedural soundtrack, look-ahead scheduled)
 *     ├── sfxBus ── SFX voices (with stereo panning + reverb send)
 *     └── engineBus ── the player's continuous engine voice
 *
 * Public API (frozen by main.js):
 *   new AudioManager({ bus, settings })
 *   playMusic(name) / playSfx(name, opts) / setVolumes({master,music,sfx})
 *   update(dt, { kart, camera, state }) / unlock() / dispose()
 *   setMuted(bool) / isMuted()
 *
 * The manager subscribes to the shared bus itself: other subsystems only have
 * to emit the frozen EVENTS and the right sound comes out.
 */

import { EVENTS, SFX, ITEMS } from '../contracts.js';
import { tone, noise, arpeggio, createImpulseResponse, getNoiseBuffer, midiToFreq, clamp } from './synth.js';
import { MusicEngine } from './music.js';

const MAX_SPEED = 36;   // m/s used to normalize engine pitch/volume
const HEAR_RANGE = 75;  // meters at which positional SFX are almost silent

/** Per-item pitch flavour so item sounds read differently. */
const ITEM_PITCH = {
  mushroom: 1.15,
  'triple-mushroom': 1.22,
  banana: 0.95,
  'green-shell': 1.0,
  'red-shell': 0.9,
  'triple-shell': 0.84,
  star: 1.3,
  lightning: 0.72,
};

/**
 * Pitch multiplier for an item. Accepts an id string, an `ITEMS[id]` def, or
 * the `{ itemId }` opts shape the item system emits.
 */
const itemPitch = (value) => {
  if (!value) return 1;
  if (typeof value === 'string') return ITEM_PITCH[value] || 1;
  const id = value.item?.id || value.itemId || value.id;
  return ITEM_PITCH[id] || 1;
};

/* ==========================================================================
 * SFX voices — (ctx, out, t, opts)
 * ======================================================================== */
const SFX_DEFS = {
  [SFX.COUNTDOWN_BEEP]: (ctx, out, t, o) => {
    const v = clamp(Math.round(Number(o?.value) || 3), 1, 3);
    const base = [0, 560, 640, 720][v] || 560;
    const p = o?.pitch || 1;
    tone(ctx, out, { type: 'square', freq: base * p, t0: t, dur: 0.16, gain: 0.2, attack: 0.004, decay: 0.06, sustain: 0.3, release: 0.13, filter: { type: 'lowpass', freq: 2800, q: 0.7 } });
    tone(ctx, out, { type: 'sine', freq: base * p * 2, t0: t, dur: 0.1, gain: 0.07, attack: 0.003, decay: 0.04, sustain: 0.2, release: 0.09 });
  },

  [SFX.COUNTDOWN_GO]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    arpeggio(ctx, out, [64, 68, 71, 76], {
      t0: t, spacing: 0.014, dur: 0.5, gain: 0.13, type: 'sawtooth',
      attack: 0.008, decay: 0.2, sustain: 0.3, release: 0.4,
      filter: { type: 'lowpass', freq: 3400, sweepTo: 900, sweepTime: 0.5, q: 0.8 },
    });
    noise(ctx, out, { t0: t, dur: 0.45, gain: 0.13, attack: 0.012, decay: 0.3, sustain: 0.08, release: 0.22, filter: { type: 'bandpass', freq: 420, sweepTo: 4200, sweepTime: 0.38, q: 0.9 } });
    tone(ctx, out, { type: 'sine', freq: 92 * p, glide: 42, glideTime: 0.3, t0: t, dur: 0.32, gain: 0.17, attack: 0.004, decay: 0.2, sustain: 0.05, release: 0.2 });
  },

  // The continuous engine is its own voice; this is the ignition "rev".
  [SFX.ENGINE]: (ctx, out, t) => {
    tone(ctx, out, { type: 'sawtooth', freq: 58, glide: 210, glideTime: 0.28, t0: t, dur: 0.42, gain: 0.16, attack: 0.02, decay: 0.2, sustain: 0.45, release: 0.3, filter: { type: 'lowpass', freq: 700, sweepTo: 2200, sweepTime: 0.3, q: 4 } });
    tone(ctx, out, { type: 'square', freq: 92, glide: 260, glideTime: 0.26, t0: t + 0.02, dur: 0.34, gain: 0.07, attack: 0.02, decay: 0.16, sustain: 0.3, release: 0.28, filter: { type: 'lowpass', freq: 1600, q: 2 } });
  },

  [SFX.DRIFT]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    noise(ctx, out, { t0: t, dur: 0.38, gain: 0.1, attack: 0.02, decay: 0.16, sustain: 0.45, release: 0.16, filter: { type: 'bandpass', freq: 1900 * p, sweepTo: 2600 * p, sweepTime: 0.3, q: 7 } });
    tone(ctx, out, { type: 'sawtooth', freq: 420 * p, glide: 560 * p, glideTime: 0.3, t0: t, dur: 0.34, gain: 0.035, attack: 0.03, decay: 0.14, sustain: 0.4, release: 0.18, filter: { type: 'bandpass', freq: 1800, q: 5 } });
  },

  [SFX.DRIFT_BOOST]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    noise(ctx, out, { t0: t, dur: 0.5, gain: 0.16, attack: 0.006, decay: 0.26, sustain: 0.12, release: 0.22, filter: { type: 'bandpass', freq: 700 * p, sweepTo: 5200 * p, sweepTime: 0.34, q: 1.1 } });
    tone(ctx, out, { type: 'sawtooth', freq: 210 * p, glide: 980 * p, glideTime: 0.3, t0: t, dur: 0.36, gain: 0.12, attack: 0.006, decay: 0.2, sustain: 0.25, release: 0.2, filter: { type: 'lowpass', freq: 4200, sweepTo: 1200, sweepTime: 0.4, q: 1.4 } });
    tone(ctx, out, { type: 'square', freq: 1180 * p, t0: t + 0.02, dur: 0.09, gain: 0.06, attack: 0.002, decay: 0.05, sustain: 0.1, release: 0.08 });
  },

  [SFX.HOP]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    tone(ctx, out, { type: 'sine', freq: 300 * p, glide: 640 * p, glideTime: 0.1, t0: t, dur: 0.11, gain: 0.17, attack: 0.004, decay: 0.06, sustain: 0.2, release: 0.1 });
  },

  [SFX.LAND]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    tone(ctx, out, { type: 'sine', freq: 150 * p, glide: 54 * p, glideTime: 0.14, t0: t, dur: 0.16, gain: 0.22, attack: 0.002, decay: 0.1, sustain: 0.02, release: 0.14 });
    noise(ctx, out, { t0: t, dur: 0.12, gain: 0.13, attack: 0.002, decay: 0.07, sustain: 0.02, release: 0.1, filter: { type: 'lowpass', freq: 900, sweepTo: 300, sweepTime: 0.12, q: 0.9 } });
  },

  [SFX.HIT]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    noise(ctx, out, { t0: t, dur: 0.22, gain: 0.24, attack: 0.001, decay: 0.12, sustain: 0.03, release: 0.18, filter: { type: 'bandpass', freq: 900 * p, sweepTo: 320, sweepTime: 0.18, q: 0.7 } });
    tone(ctx, out, { type: 'square', freq: 260 * p, glide: 68 * p, glideTime: 0.18, t0: t, dur: 0.24, gain: 0.18, attack: 0.002, decay: 0.14, sustain: 0.04, release: 0.16, filter: { type: 'lowpass', freq: 1500, q: 1.2 } });
  },

  [SFX.SPIN]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    tone(ctx, out, { type: 'sawtooth', freq: 760 * p, glide: 210 * p, glideTime: 0.55, t0: t, dur: 0.6, gain: 0.11, attack: 0.01, decay: 0.3, sustain: 0.3, release: 0.3, filter: { type: 'bandpass', freq: 1400, sweepTo: 500, sweepTime: 0.5, q: 3 } });
    tone(ctx, out, { type: 'triangle', freq: 520 * p, glide: 150 * p, glideTime: 0.5, t0: t + 0.03, dur: 0.5, gain: 0.07, attack: 0.01, decay: 0.26, sustain: 0.2, release: 0.3 });
  },

  [SFX.ITEM_ROLL]: (ctx, out, t, o) => {
    const p = (o?.pitch || 1) * (0.94 + Math.random() * 0.14);
    tone(ctx, out, { type: 'square', freq: 1020 * p, t0: t, dur: 0.055, gain: 0.085, attack: 0.002, decay: 0.03, sustain: 0.1, release: 0.05, filter: { type: 'lowpass', freq: 3400, q: 0.8 } });
    tone(ctx, out, { type: 'sine', freq: 2040 * p, t0: t, dur: 0.035, gain: 0.035, attack: 0.001, decay: 0.02, sustain: 0.05, release: 0.03 });
  },

  [SFX.ITEM_USE]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    noise(ctx, out, { t0: t, dur: 0.34, gain: 0.13, attack: 0.006, decay: 0.2, sustain: 0.1, release: 0.16, filter: { type: 'bandpass', freq: 320 * p, sweepTo: 2600 * p, sweepTime: 0.24, q: 0.9 } });
    tone(ctx, out, { type: 'triangle', freq: 620 * p, glide: 940 * p, glideTime: 0.16, t0: t, dur: 0.26, gain: 0.12, attack: 0.004, decay: 0.12, sustain: 0.25, release: 0.16 });
  },

  [SFX.ITEM_HIT]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    noise(ctx, out, { t0: t, dur: 0.26, gain: 0.22, attack: 0.001, decay: 0.14, sustain: 0.03, release: 0.2, filter: { type: 'highpass', freq: 700 * p, q: 0.6 } });
    tone(ctx, out, { type: 'square', freq: 190 * p, glide: 58 * p, glideTime: 0.2, t0: t, dur: 0.26, gain: 0.17, attack: 0.002, decay: 0.16, sustain: 0.03, release: 0.18, filter: { type: 'lowpass', freq: 1200, q: 1 } });
    tone(ctx, out, { type: 'triangle', freq: 1500 * p, t0: t, dur: 0.1, gain: 0.05, attack: 0.001, decay: 0.05, sustain: 0.05, release: 0.09 });
  },

  [SFX.BOX]: (ctx, out, t) => {
    arpeggio(ctx, out, [76, 81, 88], { t0: t, spacing: 0.045, dur: 0.34, gain: 0.09, type: 'sine', attack: 0.003, decay: 0.14, sustain: 0.25, release: 0.24 });
    tone(ctx, out, { type: 'triangle', freq: 520, glide: 1200, glideTime: 0.14, t0: t, dur: 0.16, gain: 0.07, attack: 0.003, decay: 0.08, sustain: 0.15, release: 0.12 });
  },

  [SFX.BOOST]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    noise(ctx, out, { t0: t, dur: 0.72, gain: 0.17, attack: 0.01, decay: 0.3, sustain: 0.35, release: 0.3, filter: { type: 'lowpass', freq: 900 * p, sweepTo: 4200 * p, sweepTime: 0.5, q: 1.1 } });
    tone(ctx, out, { type: 'sine', freq: 118 * p, glide: 44 * p, glideTime: 0.45, t0: t, dur: 0.5, gain: 0.2, attack: 0.006, decay: 0.24, sustain: 0.15, release: 0.28 });
    tone(ctx, out, { type: 'sawtooth', freq: 620 * p, glide: 1500 * p, glideTime: 0.35, t0: t + 0.02, dur: 0.4, gain: 0.05, attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.24, filter: { type: 'bandpass', freq: 1800, q: 2 } });
  },

  [SFX.OFFROAD]: (ctx, out, t) => {
    noise(ctx, out, { t0: t, dur: 0.3, gain: 0.14, attack: 0.004, decay: 0.14, sustain: 0.12, release: 0.16, filter: { type: 'lowpass', freq: 520, sweepTo: 240, sweepTime: 0.24, q: 0.8 } });
  },

  [SFX.LAP]: (ctx, out, t, o) => {
    const p = o?.pitch || 1;
    arpeggio(ctx, out, [81, 88], { t0: t, spacing: 0.075, dur: 0.5, gain: 0.1, type: 'sine', attack: 0.003, decay: 0.2, sustain: 0.2, release: 0.4 });
    tone(ctx, out, { type: 'triangle', freq: 660 * p, t0: t, dur: 0.2, gain: 0.05, attack: 0.004, decay: 0.1, sustain: 0.15, release: 0.16 });
  },

  [SFX.FINAL_LAP]: (ctx, out, t) => {
    arpeggio(ctx, out, [72, 76, 79, 84], { t0: t, spacing: 0.085, dur: 0.42, gain: 0.12, type: 'square', attack: 0.005, decay: 0.16, sustain: 0.3, release: 0.34, filter: { type: 'lowpass', freq: 3600, q: 0.8 } });
    noise(ctx, out, { t0: t, dur: 0.3, gain: 0.08, attack: 0.01, decay: 0.16, sustain: 0.1, release: 0.2, filter: { type: 'highpass', freq: 2600, q: 0.7 } });
  },

  [SFX.FINISH]: (ctx, out, t) => {
    arpeggio(ctx, out, [67, 72, 76, 79, 84, 88], { t0: t, spacing: 0.085, dur: 0.6, gain: 0.13, type: 'sawtooth', attack: 0.006, decay: 0.2, sustain: 0.35, release: 0.5, filter: { type: 'lowpass', freq: 3800, sweepTo: 2000, sweepTime: 0.9, q: 0.8 } });
    arpeggio(ctx, out, [60, 64, 67], { t0: t + 0.55, spacing: 0.01, dur: 1.1, gain: 0.09, type: 'triangle', attack: 0.02, decay: 0.3, sustain: 0.6, release: 0.6 });
    noise(ctx, out, { t0: t + 0.5, dur: 0.6, gain: 0.07, attack: 0.02, decay: 0.3, sustain: 0.15, release: 0.4, filter: { type: 'highpass', freq: 3200, q: 0.6 } });
  },

  [SFX.LOSE]: (ctx, out, t) => {
    arpeggio(ctx, out, [72, 68, 65], { t0: t, spacing: 0.16, dur: 0.5, gain: 0.11, type: 'triangle', attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.4, filter: { type: 'lowpass', freq: 1800, q: 0.7 } });
    tone(ctx, out, { type: 'sine', freq: midiToFreq(41), t0: t + 0.32, dur: 0.7, gain: 0.1, attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.5 });
  },

  [SFX.UI_CLICK]: (ctx, out, t) => {
    noise(ctx, out, { t0: t, dur: 0.03, gain: 0.07, attack: 0.001, decay: 0.015, sustain: 0.001, release: 0.02, filter: { type: 'highpass', freq: 3000, q: 0.7 } });
    tone(ctx, out, { type: 'square', freq: 1250, glide: 700, glideTime: 0.05, t0: t, dur: 0.045, gain: 0.06, attack: 0.001, decay: 0.02, sustain: 0.05, release: 0.03 });
  },

  [SFX.UI_MOVE]: (ctx, out, t) => {
    tone(ctx, out, { type: 'sine', freq: 820, glide: 1120, glideTime: 0.045, t0: t, dur: 0.05, gain: 0.05, attack: 0.002, decay: 0.02, sustain: 0.1, release: 0.04 });
  },

  [SFX.SHIELD_BLOCK]: (ctx, out, t) => {
    tone(ctx, out, { type: 'sine', freq: 1320, t0: t, dur: 0.5, gain: 0.12, attack: 0.001, decay: 0.2, sustain: 0.06, release: 0.4 });
    tone(ctx, out, { type: 'sine', freq: 1980, detune: 12, t0: t, dur: 0.42, gain: 0.07, attack: 0.001, decay: 0.16, sustain: 0.05, release: 0.34 });
    noise(ctx, out, { t0: t, dur: 0.14, gain: 0.09, attack: 0.001, decay: 0.06, sustain: 0.02, release: 0.1, filter: { type: 'highpass', freq: 2400, q: 0.8 } });
  },

  [SFX.THUNDER]: (ctx, out, t) => {
    noise(ctx, out, { t0: t, dur: 1.4, gain: 0.3, attack: 0.004, decay: 0.5, sustain: 0.16, release: 1.1, filter: { type: 'lowpass', freq: 2600, sweepTo: 130, sweepTime: 1.2, q: 0.9 } });
    tone(ctx, out, { type: 'sine', freq: 74, glide: 30, glideTime: 0.9, t0: t + 0.02, dur: 1.0, gain: 0.22, attack: 0.01, decay: 0.5, sustain: 0.12, release: 0.8 });
    noise(ctx, out, { t0: t + 0.08, dur: 0.5, gain: 0.12, attack: 0.001, decay: 0.2, sustain: 0.05, release: 0.3, filter: { type: 'highpass', freq: 1500, q: 0.6 } });
  },

  _default: (ctx, out, t) => {
    tone(ctx, out, { type: 'triangle', freq: 520, t0: t, dur: 0.12, gain: 0.1, attack: 0.004, decay: 0.06, sustain: 0.2, release: 0.08 });
  },
};

export class AudioManager {
  /**
   * @param {{ bus?: any, settings?: any }} opts
   */
  constructor({ bus, settings = {} } = {}) {
    this.bus = bus || null;
    this.settings = {
      master: 0.9,
      music: 0.6,
      sfx: 0.9,
      ...(settings || {}),
    };

    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
    this._muted = false;
    this._hidden = !!document.hidden;
    this._disposed = false;
    this._unsubs = [];
    this._gestureOff = [];
    this._camera = null;
    this._state = 'boot';
    this._musicName = null;
    this._cdLabel = null;
    this._lastSfx = new Map();
    this._engine = null;
    this.music = null;

    this._bindBus();
    this._bindGesture();
    this._bindVisibility();
  }

  // ------------------------------------------------------------- lifecycle --
  _bindGesture() {
    if (typeof window === 'undefined') return;
    const events = ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'click'];
    const handler = () => {
      if (this.unlock()) {
        for (const off of this._gestureOff) off();
        this._gestureOff.length = 0;
      }
    };
    for (const type of events) {
      window.addEventListener(type, handler, { passive: true });
      this._gestureOff.push(() => window.removeEventListener(type, handler));
    }
  }

  _bindVisibility() {
    if (typeof document === 'undefined') return;
    const onVis = () => {
      this._hidden = !!document.hidden;
      if (!this.ctx) return;
      try {
        if (this._hidden) this.ctx.suspend?.();
        else if (!this._muted) this.ctx.resume?.();
      } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVis);
    this._unsubs.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  /**
   * Create/resume the AudioContext. Safe to call any number of times.
   * @returns {boolean} true when audio is usable
   */
  unlock() {
    if (this._disposed) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._buildGraph();
      }
      if (this.ctx.state === 'suspended' && !this._hidden) {
        const p = this.ctx.resume?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      this.unlocked = true;
      if (this._musicName && this.music) this.music.setTrack(this._musicName, 0.6);
      else if (!this._musicName && this.music && this._state === 'menu') this.music.setTrack('menu', 0.6);
      return true;
    } catch (err) {
      this.ctx = null;
      this.ready = false;
      return false;
    }
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0.0001 : clamp(this.settings.master ?? 0.9, 0, 1);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 7;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;

    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = clamp(this.settings.sfx ?? 0.9, 0, 1);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = clamp(this.settings.music ?? 0.6, 0, 1);
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = clamp(this.settings.sfx ?? 0.9, 0, 1) * 0.9;

    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.engineBus.connect(this.master);

    // Shared reverb (generated impulse) fed from a parallel send.
    try {
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = createImpulseResponse(ctx, 1.9, 2.7);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.14;
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.master);
      this.sfxBus.connect(this.reverbSend);
    } catch {
      this.reverb = null;
      this.reverbSend = null;
    }

    this.music = new MusicEngine(ctx, this.musicBus);
    this._buildEngine();
    this.ready = true;
    this._applyVolumes(true);
  }

  // ---------------------------------------------------------------- engine --
  _buildEngine() {
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.0001;
    bus.connect(this.engineBus);

    const oscMix = ctx.createGain();
    oscMix.gain.value = 0.55;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 5;
    oscMix.connect(lp);
    lp.connect(bus);

    const mk = (type, freq, detune, level) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g);
      g.connect(oscMix);
      o.start();
      return o;
    };
    const osc1 = mk('sawtooth', 62, 0, 0.5);
    const osc2 = mk('square', 93, 9, 0.22);
    const osc3 = mk('sawtooth', 124, -12, 0.28);

    // road / tyre rumble
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = getNoiseBuffer(ctx, 'pink');
    rumbleSrc.loop = true;
    const rumbleF = ctx.createBiquadFilter();
    rumbleF.type = 'lowpass';
    rumbleF.frequency.value = 420;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.0001;
    rumbleSrc.connect(rumbleF);
    rumbleF.connect(rumbleGain);
    rumbleGain.connect(bus);
    rumbleSrc.start();

    // drift squeal
    const driftSrc = ctx.createBufferSource();
    driftSrc.buffer = getNoiseBuffer(ctx, 'white');
    driftSrc.loop = true;
    const driftF = ctx.createBiquadFilter();
    driftF.type = 'bandpass';
    driftF.frequency.value = 2100;
    driftF.Q.value = 6;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 0.0001;
    driftSrc.connect(driftF);
    driftF.connect(driftGain);
    driftGain.connect(bus);
    driftSrc.start();

    // ice / low-grip slide
    const slideSrc = ctx.createBufferSource();
    slideSrc.buffer = getNoiseBuffer(ctx, 'white');
    slideSrc.loop = true;
    const slideF = ctx.createBiquadFilter();
    slideF.type = 'highpass';
    slideF.frequency.value = 2600;
    const slideGain = ctx.createGain();
    slideGain.gain.value = 0.0001;
    slideSrc.connect(slideF);
    slideF.connect(slideGain);
    slideGain.connect(bus);
    slideSrc.start();

    // turbo whistle
    const whistle = ctx.createOscillator();
    whistle.type = 'sine';
    whistle.frequency.value = 1600;
    const whistleGain = ctx.createGain();
    whistleGain.gain.value = 0.0001;
    whistle.connect(whistleGain);
    whistleGain.connect(bus);
    whistle.start();

    this._engine = {
      bus, osc1, osc2, osc3, lp, rumbleF, rumbleGain, driftGain, slideGain, whistle, whistleGain,
    };
  }

  _updateEngine(dt, { kart, state } = {}) {
    const e = this._engine;
    if (!e) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const st = kart?.state || {};
    const active = !!kart && (state === 'racing' || state === 'countdown' || state === 'results');
    const speed = Math.abs(Number(st.speed ?? kart?.speed ?? 0));
    const sp = clamp(speed / MAX_SPEED, 0, 1);
    const throttle = active ? clamp(Number(kart?.input?.throttle ?? (sp > 0.02 ? 1 : 0)), 0, 1) : 0;

    // Fake gearbox: the note climbs then resets, so speed reads as acceleration.
    const revs = sp * 3.4;
    const gearFrac = revs - Math.floor(revs);
    const rpm = sp <= 0.002 ? 0 : 0.22 + 0.78 * gearFrac;
    const f = 52 + rpm * 168 + throttle * 14;

    const smooth = (param, value, tc) => {
      try { param.setTargetAtTime(value, now, tc); } catch { /* ignore */ }
    };
    smooth(e.osc1.frequency, f, 0.045);
    smooth(e.osc2.frequency, f * 1.51, 0.05);
    smooth(e.osc3.frequency, f * 2.03, 0.05);
    smooth(e.lp.frequency, 360 + 2300 * sp + 700 * throttle, 0.08);

    const vol = active ? 0.045 + 0.075 * sp + 0.02 * throttle : 0.0001;
    smooth(e.bus.gain, vol, active ? 0.09 : 0.3);

    const offroad = !!st.offRoad;
    smooth(e.rumbleGain.gain, active ? (offroad ? 0.05 + 0.085 * sp : 0.006 + 0.018 * sp) : 0.0001, 0.08);
    smooth(e.rumbleF.frequency, offroad ? 900 : 420, 0.15);

    smooth(e.driftGain.gain, active && st.drifting ? 0.026 + 0.03 * sp : 0.0001, 0.1);

    const ice = kart?.trackApi?.theme === 'snow';
    const slip = Math.abs(Number(st.steerVisual) || 0);
    smooth(e.slideGain.gain, active && ice && slip > 0.25 ? 0.016 + 0.03 * sp * slip : 0.0001, 0.12);

    const boosting = !!st.boosting;
    smooth(e.whistleGain.gain, boosting ? 0.018 : 0.0001, 0.06);
    smooth(e.whistle.frequency, 1200 + 1500 * sp, 0.1);
  }

  // ------------------------------------------------------------------ sfx --
  /** Distance attenuation + panning relative to the camera. */
  _spatial(opts) {
    const src = opts?.kart?.position || opts?.position;
    const cam = this._camera;
    if (!src || !cam?.position) return { pan: 0, gain: 1 };
    const dx = Number(src.x || 0) - cam.position.x;
    const dy = Number(src.y || 0) - cam.position.y;
    const dz = Number(src.z || 0) - cam.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let pan = 0;
    const el = cam.matrixWorld?.elements;
    if (el) {
      const rx = dx * el[0] + dy * el[4] + dz * el[8];
      pan = clamp(rx / Math.max(5, dist * 0.85), -1, 1);
    }
    const gain = clamp(1 - dist / HEAR_RANGE, 0.12, 1);
    return { pan, gain };
  }

  _isDuplicate(name) {
    const now = performance.now();
    const last = this._lastSfx.get(name) || 0;
    if (now - last < 26) return true;
    this._lastSfx.set(name, now);
    if (this._lastSfx.size > 64) this._lastSfx.clear();
    return false;
  }

  /**
   * @param {string} name one of `SFX`
   * @param {{ kart?: any, position?: any, volume?: number, pitch?: number }} [opts]
   */
  playSfx(name, opts = {}) {
    if (!this.ready || !this.ctx || this._muted || this._disposed) return;
    if (!name) return;
    if (this._isDuplicate(name)) return;
    const def = SFX_DEFS[name] || SFX_DEFS._default;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.002;
    try {
      const spatial = this._spatial(opts);
      const gain = clamp((Number(opts.volume ?? 1) || 1) * spatial.gain, 0, 2);
      const g = ctx.createGain();
      g.gain.value = gain;
      if (Math.abs(spatial.pan) > 0.02 && typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = spatial.pan;
        g.connect(p);
        p.connect(this.sfxBus);
      } else {
        g.connect(this.sfxBus);
      }
      def(ctx, g, t, { ...opts, pitch: Number(opts.pitch) || 1 });
    } catch (err) {
      // Audio must never break the game.
    }
  }

  // ---------------------------------------------------------------- music --
  /** @param {string} name 'menu' | 'sunset' | 'desert' | 'snow' | 'victory' | 'results' */
  playMusic(name) {
    this._musicName = name || null;
    if (!this.ready || !this.ctx || !this.music || !name) return;
    try {
      this.music.setTrack(name, 1.1);
    } catch { /* ignore */ }
  }

  // -------------------------------------------------------------- volumes --
  /** @param {{master?:number, music?:number, sfx?:number}} v 0..1 */
  setVolumes(v = {}) {
    if (typeof v.master === 'number') this.settings.master = clamp(v.master, 0, 1);
    if (typeof v.music === 'number') this.settings.music = clamp(v.music, 0, 1);
    if (typeof v.sfx === 'number') this.settings.sfx = clamp(v.sfx, 0, 1);
    this._applyVolumes();
  }

  _applyVolumes(immediate = false) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = immediate ? 0.001 : 0.05;
    const mute = this._muted ? 0.0001 : 1;
    const set = (param, value) => {
      try {
        param.cancelScheduledValues(t);
        param.setTargetAtTime(Math.max(0.0001, value), t, tc);
      } catch { /* ignore */ }
    };
    set(this.master.gain, mute * clamp(this.settings.master ?? 0.9, 0, 1));
    set(this.musicBus.gain, clamp(this.settings.music ?? 0.6, 0, 1));
    set(this.sfxBus.gain, clamp(this.settings.sfx ?? 0.9, 0, 1));
    set(this.engineBus.gain, clamp(this.settings.sfx ?? 0.9, 0, 1) * 0.9);
  }

  /** @param {boolean} on */
  setMuted(on) {
    this._muted = !!on;
    this._applyVolumes();
    if (!this.ctx) return;
    try {
      if (this._muted) this.ctx.suspend?.();
      else if (!this._hidden) this.ctx.resume?.();
    } catch { /* ignore */ }
  }

  isMuted() {
    return this._muted;
  }

  // ------------------------------------------------------------------ bus --
  _bindBus() {
    const bus = this.bus;
    if (!bus?.on) return;
    const on = (event, fn) => {
      const off = bus.on(event, fn);
      if (typeof off === 'function') this._unsubs.push(off);
    };
    const isPlayer = (kart) => !!kart?.isPlayer;

    on(EVENTS.AUDIO_SFX, ({ name, opts } = {}) => this.playSfx(name, opts || {}));
    on(EVENTS.AUDIO_MUSIC, ({ name } = {}) => this.playMusic(name));
    // Raw unlock ping (emitted by the input layer).
    on('audio:unlock', () => this.unlock());

    // ---------------------------------------------------------- race flow --
    on(EVENTS.RACE_COUNTDOWN, ({ value } = {}) => {
      // The manager re-emits the same label every ~100 ms — beep once per label.
      const label = Number(value) > 0 ? `c${Number(value)}` : 'go';
      if (label === this._cdLabel) return;
      this._cdLabel = label;
      if (Number(value) > 0) this.playSfx(SFX.COUNTDOWN_BEEP, { value: Number(value), volume: 0.9 });
      else this.playSfx(SFX.COUNTDOWN_GO, { volume: 1 });
    });
    on(EVENTS.RACE_START, () => { this._cdLabel = null; });
    on(EVENTS.RACE_LAP, ({ kart, lap } = {}) => {
      if (isPlayer(kart)) this.playSfx(SFX.LAP, { volume: 0.8, pitch: 1 + Math.min(0.25, (Number(lap) || 1) * 0.04) });
      else this.playSfx(SFX.LAP, { kart, volume: 0.32, pitch: 1.06 });
    });
    on(EVENTS.RACE_FINAL_LAP, ({ kart } = {}) => {
      this.playSfx(SFX.FINAL_LAP, { kart, volume: isPlayer(kart) ? 1 : 0.4 });
    });
    on(EVENTS.RACE_FINISH, ({ kart, place } = {}) => {
      if (isPlayer(kart)) this.playSfx(Number(place) <= 3 ? SFX.FINISH : SFX.LOSE, { volume: 1 });
    });
    // Rivals crossing the line get a quieter, positional cue.
    on(EVENTS.KART_FINISHED, ({ kart } = {}) => {
      if (!kart || isPlayer(kart)) return;
      this.playSfx(SFX.LAP, { kart, volume: 0.22, pitch: 0.9 });
    });
    on(EVENTS.GAME_STATE, ({ state } = {}) => {
      this._state = state || this._state;
      if (this._state === 'menu' && !this._musicName) this.playMusic('menu');
    });

    // -------------------------------------------------------------- kart --
    on(EVENTS.KART_BOOST, ({ kart, power } = {}) => {
      this.playSfx(SFX.BOOST, { kart, volume: isPlayer(kart) ? 0.8 : 0.42, pitch: 1 + clamp(Number(power) || 1, 0, 3) * 0.05 });
    });
    on(EVENTS.KART_ROCKET_START, ({ kart } = {}) => {
      if (!isPlayer(kart)) return;
      this.playSfx(SFX.BOOST, { volume: 1, pitch: 1.25 });
      this.playSfx(SFX.COUNTDOWN_GO, { volume: 0.45 });
    });
    on(EVENTS.KART_DRIFT_BOOST, ({ kart, level } = {}) => {
      this.playSfx(SFX.DRIFT_BOOST, {
        kart,
        volume: isPlayer(kart) ? 0.9 : 0.45,
        pitch: 1 + clamp(Number(level) || 0, 0, 2) * 0.09,
      });
    });
    on(EVENTS.KART_DRIFT_START, ({ kart } = {}) => {
      if (isPlayer(kart)) this.playSfx(SFX.DRIFT, { kart, volume: 0.4 });
    });
    on(EVENTS.KART_HOP, ({ kart } = {}) => this.playSfx(SFX.HOP, { kart, volume: isPlayer(kart) ? 0.7 : 0.35 }));
    on(EVENTS.KART_LAND, ({ kart, impact } = {}) => {
      const vol = clamp(0.35 + (Number(impact) || 0) * 0.45, 0.2, 1) * (isPlayer(kart) ? 1 : 0.6);
      this.playSfx(SFX.LAND, { kart, volume: vol });
    });
    on(EVENTS.KART_HIT, ({ kart, kind } = {}) => {
      this.playSfx(SFX.HIT, { kart, volume: isPlayer(kart) ? 0.95 : 0.5, pitch: kind === 'wall' ? 0.85 : 1 });
    });
    on(EVENTS.KART_SPIN, ({ kart } = {}) => this.playSfx(SFX.SPIN, { kart, volume: isPlayer(kart) ? 0.85 : 0.4 }));
    on(EVENTS.KART_OFFROAD, ({ kart, onRoad } = {}) => {
      if (!onRoad) this.playSfx(SFX.OFFROAD, { kart, volume: isPlayer(kart) ? 0.5 : 0.25 });
    });

    // ------------------------------------------------------------- items --
    on(EVENTS.ITEM_BOX, ({ kart } = {}) => this.playSfx(SFX.BOX, { kart, volume: isPlayer(kart) ? 0.85 : 0.4 }));
    on(EVENTS.ITEM_ROLL, ({ kart, item, itemId } = {}) => this.playSfx(SFX.ITEM_ROLL, { kart, volume: isPlayer(kart) ? 0.6 : 0.3, pitch: itemPitch(itemId || item) }));
    on(EVENTS.ITEM_USE, ({ kart, item, itemId } = {}) => this.playSfx(SFX.ITEM_USE, { kart, volume: isPlayer(kart) ? 0.9 : 0.5, pitch: itemPitch(itemId || item) }));
    on(EVENTS.ITEM_HIT, ({ kart, item, itemId } = {}) => this.playSfx(SFX.ITEM_HIT, { kart, volume: isPlayer(kart) ? 0.95 : 0.5, pitch: itemPitch(itemId || item) }));
    on(EVENTS.ITEM_BLOCKED, ({ kart } = {}) => this.playSfx(SFX.SHIELD_BLOCK, { kart, volume: isPlayer(kart) ? 0.8 : 0.4 }));
    on(EVENTS.ITEM_EXPIRE, ({ kart } = {}) => this.playSfx(SFX.UI_MOVE, { kart, volume: isPlayer(kart) ? 0.4 : 0.2, pitch: 0.7 }));

    // Lightning-style items get their own big hit.
    on(EVENTS.ITEM_USE, ({ item, itemId, kart } = {}) => {
      if ((itemId || item?.id) !== ITEMS.lightning.id) return;
      this.playSfx(SFX.THUNDER, { kart, volume: 1 });
    });
  }

  // --------------------------------------------------------------- update --
  /**
   * @param {number} dt
   * @param {{ kart?: any, camera?: any, state?: string }} view
   */
  update(dt, view = {}) {
    if (this._disposed) return;
    if (view.camera) this._camera = view.camera;
    if (view.state) this._state = view.state;
    if (!this.ready || !this.ctx || this._muted || this._hidden) return;
    try {
      this._updateEngine(dt, view);
    } catch { /* ignore */ }
    try {
      this.music?.update?.();
    } catch { /* ignore */ }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch { /* ignore */ }
    }
    this._unsubs.length = 0;
    for (const off of this._gestureOff) {
      try { off(); } catch { /* ignore */ }
    }
    this._gestureOff.length = 0;
    try { this.music?.dispose?.(); } catch { /* ignore */ }
    this.music = null;
    this._engine = null;
    try { this.ctx?.close?.(); } catch { /* ignore */ }
    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
  }
}
