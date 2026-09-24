/**
 * Turbo Kart — procedural soundtrack (Agent 4).
 * ----------------------------------------------------------------------------
 * A tiny look-ahead sequencer: every note is scheduled against
 * `AudioContext.currentTime` (never `setTimeout`), so the groove does not drift
 * even when the frame rate wobbles. Each context is a 4-bar loop built from
 * chord tones, a bass line, a pad, an arpeggio/lead and synthesized drums.
 *
 * The music sits deliberately low in the mix so it never fights the engine.
 */

import { tone, noise, midiToFreq, clamp } from './synth.js';

const LOOKAHEAD = 0.4; // seconds of audio scheduled ahead of the clock
const STEPS = 64;      // 4 bars × 16 sixteenths

/**
 * @typedef {Object} MusicDef
 * @property {number} bpm
 * @property {number} [level]     output level (0..1)
 * @property {Array<{chord:number[], bass:number}>} bars
 * @property {{kick:string, snare:string, hat:string}} drums
 * @property {string} [bassWave]
 * @property {string} [padWave]
 * @property {string} [leadWave]
 * @property {string} [arp]      16-step pattern for the arpeggio
 * @property {string} [lead]     16-step pattern for the lead line
 * @property {Array<{s:number,n:number,d:number,g?:number}>} [melody] explicit events
 */

/** @type {Record<string, MusicDef>} */
export const MUSIC_TRACKS = {
  // ------------------------------------------------------------- menu -----
  menu: {
    bpm: 92,
    level: 0.5,
    bars: [
      { chord: [57, 60, 64, 67], bass: 45 }, // Am7
      { chord: [53, 57, 60, 65], bass: 41 }, // Fmaj7
      { chord: [48, 52, 55, 59], bass: 36 }, // Cmaj7
      { chord: [55, 59, 62, 67], bass: 43 }, // G
    ],
    drums: { kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.' },
    arp: 'x...x...x...x...',
    lead: '....x..x....x...',
    bassWave: 'triangle',
    padWave: 'sine',
    leadWave: 'triangle',
    padGain: 0.028,
    leadGain: 0.05,
  },

  // ------------------------------------------------------------ sunset ----
  sunset: {
    bpm: 118,
    level: 0.46,
    bars: [
      { chord: [48, 52, 55, 59], bass: 36 }, // C
      { chord: [55, 59, 62, 66], bass: 43 }, // G
      { chord: [57, 60, 64, 67], bass: 45 }, // Am
      { chord: [53, 57, 60, 65], bass: 41 }, // F
    ],
    drums: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x.x.x...x.x.x.' },
    arp: 'x.x.x.x.x.x.x.x.',
    lead: 'x..x..x...x..x..',
    bassWave: 'square',
    padWave: 'triangle',
    leadWave: 'sawtooth',
    padGain: 0.022,
    leadGain: 0.048,
  },

  // ------------------------------------------------------------ desert ----
  desert: {
    bpm: 124,
    level: 0.44,
    bars: [
      { chord: [50, 53, 57, 62], bass: 38 }, // Dm
      { chord: [46, 50, 53, 58], bass: 34 }, // Bb
      { chord: [48, 52, 55, 60], bass: 36 }, // C
      { chord: [50, 53, 57, 60], bass: 38 }, // Dm
    ],
    drums: { kick: 'x..x..x...x.x...', snare: '....x.......x..x', hat: 'x.x.x.x.x.x.x.x.' },
    arp: 'x..xx..xx..xx..x',
    lead: '..x...x...x...x.',
    bassWave: 'square',
    padWave: 'triangle',
    leadWave: 'square',
    padGain: 0.02,
    leadGain: 0.042,
  },

  // -------------------------------------------------------------- snow ----
  snow: {
    bpm: 106,
    level: 0.46,
    bars: [
      { chord: [53, 57, 60, 64], bass: 41 }, // Fmaj7
      { chord: [50, 53, 57, 60], bass: 38 }, // Dm7
      { chord: [55, 58, 62, 65], bass: 43 }, // Gm7
      { chord: [48, 52, 55, 59], bass: 36 }, // Cmaj7
    ],
    drums: { kick: 'x.......x...x...', snare: '....x.......x...', hat: '..x..x..x..x..x.' },
    arp: 'x...x.x...x.x...',
    lead: 'x.....x.....x...',
    bassWave: 'triangle',
    padWave: 'sine',
    leadWave: 'sine',
    padGain: 0.032,
    leadGain: 0.05,
  },

  // ----------------------------------------------------------- victory ----
  victory: {
    bpm: 132,
    level: 0.55,
    bars: [
      { chord: [48, 52, 55, 60], bass: 36 },
      { chord: [53, 57, 60, 65], bass: 41 },
      { chord: [55, 59, 62, 67], bass: 43 },
      { chord: [48, 52, 55, 60], bass: 36 },
    ],
    drums: { kick: 'x...x...x...x..x', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
    arp: '',
    lead: '',
    bassWave: 'square',
    padWave: 'sawtooth',
    leadWave: 'square',
    padGain: 0.03,
    leadGain: 0.075,
    melody: [
      { s: 0, n: 67, d: 0.16 }, { s: 2, n: 67, d: 0.16 }, { s: 4, n: 67, d: 0.16 },
      { s: 6, n: 72, d: 0.5 }, { s: 10, n: 71, d: 0.2 }, { s: 12, n: 72, d: 0.8, g: 1.1 },
      { s: 16, n: 76, d: 0.3 }, { s: 20, n: 74, d: 0.2 }, { s: 22, n: 72, d: 0.2 },
      { s: 24, n: 74, d: 0.6 }, { s: 28, n: 76, d: 0.3 },
      { s: 32, n: 72, d: 0.16 }, { s: 34, n: 74, d: 0.16 }, { s: 36, n: 76, d: 0.16 },
      { s: 38, n: 79, d: 0.5 }, { s: 42, n: 77, d: 0.2 }, { s: 44, n: 76, d: 0.2 },
      { s: 46, n: 74, d: 0.3 },
      { s: 48, n: 72, d: 1.1, g: 1.15 }, { s: 56, n: 76, d: 0.2 },
      { s: 58, n: 79, d: 0.2 }, { s: 60, n: 84, d: 1.4, g: 1.2 },
    ],
  },

  // ----------------------------------------------------------- results ----
  results: {
    bpm: 100,
    level: 0.44,
    bars: [
      { chord: [53, 57, 60, 65], bass: 41 }, // F
      { chord: [48, 52, 55, 60], bass: 36 }, // C
      { chord: [55, 59, 62, 67], bass: 43 }, // G
      { chord: [57, 60, 64, 67], bass: 45 }, // Am
    ],
    drums: { kick: 'x.....x.x.......', snare: '....x.......x...', hat: '..x...x...x...x.' },
    arp: 'x...x...x...x...',
    lead: '..x..x....x..x..',
    bassWave: 'triangle',
    padWave: 'triangle',
    leadWave: 'triangle',
    padGain: 0.028,
    leadGain: 0.05,
  },
};

export class MusicEngine {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} out destination (the music bus)
   */
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = out;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.gain.connect(out);

    this.name = null;
    this.def = null;
    this.step = 0;
    this.nextTime = 0;
    this._pending = null;
    this._swapAt = 0;
    this._fadeAt = 0;
    this._fadeDur = 1;
    this._warned = false;
  }

  /** Switch context with a short crossfade. */
  setTrack(name, fade = 1.1) {
    if (!this.ctx) return;
    const target = MUSIC_TRACKS[name] ? name : (MUSIC_TRACKS[this.name] ? this.name : 'menu');
    if (target === this.name && !this._pending) return;
    if (target === this._pending) return;
    const t = this.ctx.currentTime;
    const g = this.gain.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.linearRampToValueAtTime(0.0001, t + fade * 0.5);
    } catch { /* ignore */ }
    this._pending = target;
    this._swapAt = t + fade * 0.5;
    this._fadeDur = fade * 0.6;
  }

  /** Fade the music out (used when the game is muted / disposed). */
  stop(fade = 0.5) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), t);
      this.gain.gain.linearRampToValueAtTime(0.0001, t + fade);
    } catch { /* ignore */ }
    this._pending = null;
    this.name = null;
    this.def = null;
  }

  /** Call once per frame; schedules everything inside the look-ahead window. */
  update() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'suspended') return;
    const now = ctx.currentTime;

    // finish a pending crossfade
    if (this._pending && now >= this._swapAt) {
      this.name = this._pending;
      this._pending = null;
      this.def = MUSIC_TRACKS[this.name] || null;
      this.step = 0;
      this.nextTime = now + 0.06;
      const level = this.def?.level ?? 0.45;
      try {
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(0.0001, now);
        this.gain.gain.linearRampToValueAtTime(level, now + this._fadeDur);
      } catch { /* ignore */ }
    }
    if (!this.def) return;

    const stepDur = 60 / this.def.bpm / 4;
    // If the tab was throttled, jump back into the present instead of
    // dumping a burst of notes.
    if (this.nextTime < now - 0.5) this.nextTime = now + 0.05;
    if (!this.nextTime) this.nextTime = now + 0.05;

    let guard = 0;
    while (this.nextTime < now + LOOKAHEAD && guard < 48) {
      guard++;
      try {
        this._scheduleStep(this.step, this.nextTime, stepDur);
      } catch (err) {
        if (!this._warned) {
          this._warned = true;
          console.warn('[music] step failed:', err);
        }
      }
      this.nextTime += stepDur;
      this.step = (this.step + 1) % STEPS;
    }
  }

  // ------------------------------------------------------------- voices ----
  _scheduleStep(step, t, stepDur) {
    const def = this.def;
    if (!def) return;
    const bars = def.bars || [];
    if (!bars.length) return;
    const barIndex = Math.floor(step / 16) % bars.length;
    const bar = bars[barIndex];
    const b16 = step % 16;
    const barDur = stepDur * 16;

    const drums = def.drums || {};
    if (drums.kick && drums.kick[b16] === 'x') this._kick(t, def);
    if (drums.snare && drums.snare[b16] === 'x') this._snare(t, def);
    if (drums.hat && drums.hat[b16] === 'x') this._hat(t, def);

    if (b16 % 4 === 0 || b16 === 6 || b16 === 14) this._bass(t, bar.bass, def);
    if (b16 === 0) this._pad(t, bar.chord, def, barDur);

    if (def.melody) {
      for (let i = 0; i < def.melody.length; i++) {
        const ev = def.melody[i];
        if (ev.s === step) {
          this._note(t, ev.n, ev.d, def.leadWave || 'triangle', (def.leadGain ?? 0.05) * (ev.g ?? 1));
        }
      }
    } else if (def.lead && def.lead[b16] === 'x') {
      const i = Math.floor(step / 5) % bar.chord.length;
      this._note(t, bar.chord[i] + 12, 0.34, def.leadWave || 'triangle', def.leadGain ?? 0.05);
    }

    if (def.arp && def.arp[b16] === 'x') {
      const i = Math.floor(step / 2) % bar.chord.length;
      this._note(t, bar.chord[i] + 24, 0.14, 'sine', (def.leadGain ?? 0.05) * 0.5);
    }
  }

  _note(t, midi, dur, wave, gain) {
    tone(this.ctx, this.gain, {
      type: wave || 'triangle',
      freq: midiToFreq(midi),
      t0: t,
      dur: Math.max(0.08, dur),
      gain: clamp(gain, 0.005, 0.4),
      attack: 0.008,
      decay: 0.12,
      sustain: 0.55,
      release: Math.min(0.9, Math.max(0.1, dur * 0.6)),
      filter: { type: 'lowpass', freq: 3200, q: 0.6 },
    });
  }

  _bass(t, midi, def) {
    tone(this.ctx, this.gain, {
      type: def.bassWave || 'triangle',
      freq: midiToFreq(midi ?? 40),
      t0: t,
      dur: 0.24,
      gain: def.bassGain ?? 0.15,
      attack: 0.01,
      decay: 0.14,
      sustain: 0.35,
      release: 0.14,
      filter: { type: 'lowpass', freq: 820, q: 3 },
    });
  }

  _pad(t, chord, def, barDur) {
    if (!chord) return;
    const g = def.padGain ?? 0.026;
    for (let i = 0; i < chord.length; i++) {
      tone(this.ctx, this.gain, {
        type: def.padWave || 'sine',
        freq: midiToFreq(chord[i]),
        detune: (Math.random() * 10 - 5),
        t0: t,
        dur: barDur * 0.92,
        gain: g,
        attack: Math.min(0.5, barDur * 0.25),
        decay: 0.4,
        sustain: 0.75,
        release: 0.5,
        filter: { type: 'lowpass', freq: 2200, q: 0.5 },
      });
    }
  }

  _kick(t, def) {
    tone(this.ctx, this.gain, {
      type: 'sine',
      freq: 132,
      glide: 44,
      glideTime: 0.11,
      t0: t,
      dur: 0.12,
      gain: (def.drumGain ?? 1) * 0.32,
      attack: 0.002,
      decay: 0.08,
      sustain: 0.001,
      release: 0.1,
    });
  }

  _snare(t, def) {
    const g = def.drumGain ?? 1;
    noise(this.ctx, this.gain, {
      t0: t,
      dur: 0.09,
      gain: g * 0.11,
      attack: 0.001,
      decay: 0.05,
      sustain: 0.001,
      release: 0.08,
      filter: { type: 'bandpass', freq: 1900, q: 0.8 },
    });
    tone(this.ctx, this.gain, {
      type: 'triangle',
      freq: 210,
      t0: t,
      dur: 0.05,
      gain: g * 0.05,
      attack: 0.001,
      decay: 0.03,
      sustain: 0.001,
      release: 0.05,
    });
  }

  _hat(t, def) {
    noise(this.ctx, this.gain, {
      t0: t,
      dur: 0.03,
      gain: (def.drumGain ?? 1) * 0.045,
      attack: 0.001,
      decay: 0.02,
      sustain: 0.001,
      release: 0.03,
      filter: { type: 'highpass', freq: 6500, q: 0.7 },
    });
  }

  dispose() {
    try {
      this.gain.disconnect();
    } catch { /* ignore */ }
    this.ctx = null;
    this.out = null;
    this.def = null;
    this.name = null;
    this._pending = null;
  }
}
