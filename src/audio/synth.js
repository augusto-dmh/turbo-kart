/**
 * Turbo Kart — WebAudio synthesis toolkit (Agent 4).
 * ----------------------------------------------------------------------------
 * Everything the game sounds like is generated at runtime: no audio files, no
 * network. These are the low-level primitives used by `audio.js` (SFX + engine)
 * and `music.js` (procedural soundtrack).
 *
 * All helpers are defensive: a missing/blocked AudioContext can never throw
 * into the game loop.
 */

/** Cached noise buffers per AudioContext. */
const noiseCache = new WeakMap();

/** MIDI note number → frequency in Hz. */
export function midiToFreq(note) {
  return 440 * Math.pow(2, (Number(note) - 69) / 12);
}

/** Clamp helper (kept local so the audio layer has no UI dependency). */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * White / pink noise buffer (2 s, looped by callers).
 * @param {AudioContext} ctx
 * @param {'white'|'pink'} kind
 */
export function getNoiseBuffer(ctx, kind = 'white') {
  if (!ctx) return null;
  let perCtx = noiseCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    noiseCache.set(ctx, perCtx);
  }
  const cached = perCtx.get(kind);
  if (cached) return cached;

  const seconds = 2;
  const len = Math.max(64, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);

  if (kind === 'pink') {
    // Paul Kellet's economical pink noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  perCtx.set(kind, buf);
  return buf;
}

/**
 * Generated impulse response for the shared convolver reverb.
 * @param {AudioContext} ctx
 * @param {number} seconds
 * @param {number} decay
 */
export function createImpulseResponse(ctx, seconds = 1.8, decay = 2.6) {
  if (!ctx) return null;
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

/** Shared envelope shaping: 0 → peak → (decay) → sustain → hold → 0. */
function shapeGain(ctx, gain, t0, dur, o) {
  const peak = Math.max(0.0002, o.gain ?? 0.25);
  const attack = clamp(o.attack ?? 0.005, 0.0005, dur * 0.5);
  const decay = clamp(o.decay ?? dur * 0.3, 0.001, Math.max(0.002, dur - attack));
  const sustain = clamp(o.sustain ?? 0.22, 0.0001, 1);
  const release = clamp(o.release ?? Math.min(0.8, dur * 0.7), 0.01, 4);
  const level = Math.max(0.0001, peak * sustain);

  const aEnd = t0 + attack;
  const dEnd = aEnd + decay;
  const sEnd = Math.max(dEnd, t0 + dur);

  const g = gain.gain;
  g.setValueAtTime(0.0001, t0);
  g.linearRampToValueAtTime(peak, aEnd);
  g.exponentialRampToValueAtTime(level, dEnd);
  if (sEnd > dEnd) g.setValueAtTime(level, sEnd);
  g.exponentialRampToValueAtTime(0.0001, sEnd + release);
  return sEnd + release;
}

/** Optional biquad filter between a source and its gain. */
function insertFilter(ctx, source, o) {
  if (!o.filter) return source;
  const f = ctx.createBiquadFilter();
  f.type = o.filter.type || 'lowpass';
  f.frequency.setValueAtTime(Math.max(20, o.filter.freq ?? 2000), o.t0);
  if (o.filter.sweepTo) {
    f.frequency.exponentialRampToValueAtTime(
      Math.max(20, o.filter.sweepTo),
      o.t0 + Math.max(0.01, o.filter.sweepTime ?? o.dur ?? 0.2),
    );
  }
  f.Q.value = o.filter.q ?? 1;
  if (o.filter.gain) f.gain.value = o.filter.gain;
  source.connect(f);
  return f;
}

/**
 * Play a single oscillator note.
 * @param {AudioContext} ctx
 * @param {AudioNode} dest
 * @param {any} o { type, freq, glide, glideTime, detune, t0, dur, gain, attack,
 *                  decay, sustain, release, filter:{type,freq,q,sweepTo} }
 * @returns {{osc: OscillatorNode, gain: GainNode}|null}
 */
export function tone(ctx, dest, o = {}) {
  if (!ctx || !dest) return null;
  const opts = { t0: ctx.currentTime, ...o };
  const t0 = Math.max(ctx.currentTime, opts.t0);
  opts.t0 = t0;
  const dur = Math.max(0.012, opts.dur ?? 0.25);

  const osc = ctx.createOscillator();
  osc.type = opts.type || 'sine';
  const f0 = Math.max(8, opts.freq ?? 440);
  osc.frequency.setValueAtTime(f0, t0);
  if (opts.glide) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(8, opts.glide),
      t0 + Math.max(0.01, opts.glideTime ?? dur * 0.85),
    );
  }
  if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);

  const node = insertFilter(ctx, osc, opts);
  const g = ctx.createGain();
  node.connect(g);
  g.connect(dest);
  const end = shapeGain(ctx, g, t0, dur, opts);
  try {
    osc.start(t0);
    osc.stop(end + 0.05);
  } catch { /* ignore */ }
  return { osc, gain: g };
}

/**
 * Play a filtered noise burst (percussion, tyres, wind, thunder…).
 * @param {AudioContext} ctx
 * @param {AudioNode} dest
 * @param {any} o { kind, rate, t0, dur, gain, attack, decay, sustain, release, filter }
 */
export function noise(ctx, dest, o = {}) {
  if (!ctx || !dest) return null;
  const buf = getNoiseBuffer(ctx, o.kind || 'white');
  if (!buf) return null;
  const opts = { t0: ctx.currentTime, ...o };
  const t0 = Math.max(ctx.currentTime, opts.t0);
  opts.t0 = t0;
  const dur = Math.max(0.012, opts.dur ?? 0.2);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  if (opts.rate) src.playbackRate.value = opts.rate;

  const node = insertFilter(ctx, src, opts);
  const g = ctx.createGain();
  node.connect(g);
  g.connect(dest);
  const end = shapeGain(ctx, g, t0, dur, opts);
  try {
    src.start(t0, (opts.offset ?? Math.random()) * Math.max(0.001, buf.duration - 0.05));
    src.stop(end + 0.05);
  } catch { /* ignore */ }
  return { src, gain: g };
}

/**
 * Quick arpeggio / chord helper.
 * @param {AudioContext} ctx
 * @param {AudioNode} dest
 * @param {number[]} notes MIDI numbers
 * @param {any} o shared tone options + { spacing, spread }
 */
export function arpeggio(ctx, dest, notes = [], o = {}) {
  const spacing = o.spacing ?? 0.06;
  const base = o.t0 ?? ctx.currentTime;
  notes.forEach((n, i) => {
    tone(ctx, dest, {
      ...o,
      type: o.type || 'triangle',
      freq: midiToFreq(n + (o.octave ?? 0) * 12),
      t0: base + i * spacing,
    });
  });
}

/**
 * Connect `node` to `dest`, through a StereoPanner when available.
 * @returns {AudioNode} the node that was connected into
 */
export function connectPanned(ctx, node, dest, pan = 0) {
  if (!node) return dest;
  if (pan && Math.abs(pan) > 0.01 && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    node.connect(p);
    p.connect(dest);
    return p;
  }
  node.connect(dest);
  return dest;
}
