/**
 * Turbo Kart — in-race HUD.
 * Owned by Agent 4 (UI). Pure DOM/CSS + two small canvases (speedo dial,
 * minimap). No per-frame DOM rebuilding: text/classes/styles are only written
 * when the value actually changed.
 *
 * Public API (frozen by main.js):
 *   new HUD({ bus, container })
 *   setTrack(trackApi) / setMode(mode) / setQuality(q)
 *   show() / hide()
 *   showCountdown(value) / hideCountdown()
 *   update(dt, view) / dispose()
 */

import './styles.css';
import { EVENTS, MODES, ITEMS } from '../contracts.js';
import { Minimap } from './minimap.js';
import {
  clamp, formatTime, ordinalSuffix, resolveItem, itemCount, hexColor,
  restartAnimation, setText, setClass, setHidden,
} from './components.js';

const ROULETTE_ICONS = Object.values(ITEMS).map((i) => i.icon).filter(Boolean);
const DRIFT_STAGE_LABEL = ['BLUE', 'ORANGE', 'PURPLE'];

/** The HUD template (built once, mutated forever). */
const TEMPLATE = `
  <div class="hud-fx">
    <div class="hud-vignette hud-vignette--offroad" data-fx="offroad"></div>
    <div class="hud-speedlines" data-fx="speedlines"></div>
    <div class="hud-vignette hud-vignette--boost" data-fx="boost"></div>
    <div class="hud-hitflash" data-fx="hit"></div>
  </div>

  <div class="hud__top">
    <div class="hud__cluster">
      <div class="hud-place hud-card" data-place>
        <span class="hud-place__num" data-place-num>1</span>
        <span class="hud-place__suffix" data-place-suffix>st</span>
        <span class="hud-place__label" data-place-label>Position</span>
        <span class="hud-place__arrow" data-place-arrow>&#9650;</span>
      </div>
      <div class="hud-tt hud-card" data-tt hidden>
        <div class="hud-tt__row"><span>Lap</span><span data-tt-lap>--:--.--</span></div>
        <div class="hud-tt__row"><span>Best</span><span class="hud-tt__best" data-tt-best>--:--.--</span></div>
      </div>
    </div>

    <div class="hud__cluster hud__cluster--center">
      <div class="hud-lap hud-card" data-lap>
        <span class="hud-lap__label">Lap</span>
        <span class="hud-lap__value"><b data-lap-cur>1</b>/<span data-lap-total>3</span></span>
      </div>
      <div class="hud-timer hud-card" data-timer>
        <span class="hud-timer__label">Time</span><span data-timer-val>0.00</span>
      </div>
    </div>

    <div class="hud__cluster hud__cluster--right">
      <div class="hud-item is-empty" data-item>
        <div class="hud-item__slot hud-card" data-item-slot>
          <span class="hud-item__icon" data-item-icon>&#10068;</span>
          <span class="hud-item__count" data-item-count></span>
        </div>
        <div class="hud-item__label" data-item-label>Item</div>
      </div>
    </div>
  </div>

  <div class="hud__bottom">
    <div class="hud-minimap hud-card" data-minimap>
      <canvas class="hud-minimap__canvas" data-minimap-canvas></canvas>
      <span class="hud-minimap__north">N</span>
      <button class="hud-minimap__toggle" type="button" data-minimap-toggle aria-label="Toggle minimap orientation"></button>
    </div>

    <div class="hud__cluster hud__cluster--right">
      <div class="hud-drift" data-drift>
        <div class="hud-drift__head"><span>Drift</span><span class="hud-drift__stage" data-drift-stage>CHARGE</span></div>
        <div class="hud-drift__track">
          <div class="hud-drift__fill" data-drift-fill></div>
          <div class="hud-drift__marks"></div>
        </div>
      </div>
      <div class="hud-speedo" data-speedo>
        <canvas class="hud-speedo__canvas" data-speedo-canvas></canvas>
        <div class="hud-speedo__digital">
          <div class="hud-speedo__value" data-speedo-value>0</div>
          <div class="hud-speedo__unit">km/h</div>
        </div>
      </div>
    </div>
  </div>

  <div class="hud-wrongway" data-wrongway><span class="hud-wrongway__arrow">&#9664;</span> WRONG WAY</div>
  <div class="hud-banner" data-banner><div class="hud-banner__text" data-banner-text></div></div>
  <div class="hud-countdown" data-countdown>
    <div class="hud-countdown__ring"></div>
    <div class="hud-countdown__value" data-countdown-value>3</div>
  </div>
`;

export class HUD {
  /**
   * @param {{ bus?: any, container?: HTMLElement }} opts
   */
  constructor({ bus, container } = {}) {
    this.bus = bus || null;
    this.container = container || null;

    this.root = document.createElement('div');
    this.root.className = 'hud is-hidden';
    this.root.innerHTML = TEMPLATE;
    this.container?.appendChild?.(this.root);

    const q = (sel) => this.root.querySelector(sel);
    this.el = {
      place: q('[data-place]'),
      placeNum: q('[data-place-num]'),
      placeSuffix: q('[data-place-suffix]'),
      placeLabel: q('[data-place-label]'),
      lap: q('[data-lap]'),
      lapCur: q('[data-lap-cur]'),
      lapTotal: q('[data-lap-total]'),
      timer: q('[data-timer-val]'),
      tt: q('[data-tt]'),
      ttLap: q('[data-tt-lap]'),
      ttBest: q('[data-tt-best]'),
      item: q('[data-item]'),
      itemSlot: q('[data-item-slot]'),
      itemIcon: q('[data-item-icon]'),
      itemCount: q('[data-item-count]'),
      itemLabel: q('[data-item-label]'),
      drift: q('[data-drift]'),
      driftFill: q('[data-drift-fill]'),
      driftStage: q('[data-drift-stage]'),
      speedo: q('[data-speedo]'),
      speedoCanvas: q('[data-speedo-canvas]'),
      speedoValue: q('[data-speedo-value]'),
      minimapEl: q('[data-minimap]'),
      minimapCanvas: q('[data-minimap-canvas]'),
      minimapToggle: q('[data-minimap-toggle]'),
      wrongway: q('[data-wrongway]'),
      banner: q('[data-banner]'),
      bannerText: q('[data-banner-text]'),
      countdown: q('[data-countdown]'),
      countdownValue: q('[data-countdown-value]'),
      fxOffroad: q('[data-fx="offroad"]'),
      fxBoost: q('[data-fx="boost"]'),
      fxSpeedlines: q('[data-fx="speedlines"]'),
      fxHit: q('[data-fx="hit"]'),
    };

    // --- state ------------------------------------------------------------
    this.mode = MODES.GP;
    this.quality = 'high';
    this.visible = false;
    this.trackApi = null;
    this._t = 0;
    this._hidden = !!document.hidden;
    this._disposed = false;
    this._timers = new Set();

    this._place = null;
    this._lap = null;
    this._timerText = '';
    this._itemId = null;
    this._itemCharges = 1;
    this._rouletteT = 0;
    this._rouletteI = 0;
    this._driftHold = 0;
    this._boostPulse = 0;
    this._cdLast = '';
    this._cdTime = 0;
    this._cdHideTimer = null;
    this._lastCountdownView = null;

    // speedometer -----------------------------------------------------------
    this._maxKmh = 120;
    this._kmh = 0;
    this._needle = { a: 0.75 * Math.PI + 1.5 * Math.PI * 0, v: 0 };
    this._dialCache = null;
    this._dialSize = 0;
    this._speedoCtx = this.el.speedoCanvas?.getContext?.('2d') || null;

    this.minimap = this.el.minimapCanvas
      ? new Minimap(this.el.minimapCanvas, { size: 152 })
      : null;

    // --- wiring -----------------------------------------------------------
    this._unsubs = [];
    this._on(window, 'resize', () => this._queueResize());
    this._on(document, 'visibilitychange', () => this._onVisibility());
    this._on(this.el.minimapToggle, 'click', () => {
      const north = this.minimap?.toggleNorthUp?.() ?? false;
      setClass(this.el.minimapEl, 'is-northup', north);
      this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: 'ui-click' });
    });
    this._bindBus();

    this._resizeSpeedo();
  }

  // ------------------------------------------------------------------ util --
  _on(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    this._unsubs.push(() => target.removeEventListener(type, fn, opts));
  }

  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._disposed) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _bindBus() {
    const bus = this.bus;
    if (!bus?.on) return;
    const on = (event, fn) => {
      const off = bus.on(event, fn);
      if (typeof off === 'function') this._unsubs.push(off);
    };
    const isPlayer = (p) => !!p?.kart?.isPlayer;

    on(EVENTS.RACE_COUNTDOWN, ({ value } = {}) => {
      if (value > 0) this.showCountdown(value);
      else this.showCountdown('GO!');
    });
    on(EVENTS.RACE_START, () => {
      this._later(() => this.hideCountdown(), 120);
    });
    on(EVENTS.RACE_LAP, ({ kart, lap, laps } = {}) => {
      if (!kart?.isPlayer) return;
      restartAnimation(this.el.lap, 'is-flash');
      const final = Number.isFinite(laps) && Number(lap) >= laps;
      setClass(this.el.lap, 'is-final', final);
    });
    on(EVENTS.RACE_FINAL_LAP, ({ kart } = {}) => {
      if (!kart?.isPlayer) return;
      this._showBanner('FINAL LAP!', 'final');
      restartAnimation(this.el.lap, 'is-flash');
      setClass(this.el.lap, 'is-final', true);
    });
    on(EVENTS.KART_FINISHED, ({ kart } = {}) => {
      if (!kart?.isPlayer) return;
      this._showBanner('FINISH!', 'finish', 2.4);
    });
    on(EVENTS.KART_DRIFT_BOOST, ({ kart, level } = {}) => {
      if (!kart?.isPlayer) return;
      this._driftHold = 1.0;
      restartAnimation(this.el.drift, 'is-flash');
      setClass(this.el.drift, 'is-on', true);
    });
    on(EVENTS.KART_HIT, ({ kart } = {}) => {
      if (!kart?.isPlayer) return;
      restartAnimation(this.el.fxHit, 'is-on');
    });
    on(EVENTS.KART_BOOST, ({ kart } = {}) => {
      if (!kart?.isPlayer) return;
      this._boostPulse = 0.55;
    });
    on(EVENTS.KART_ROCKET_START, ({ kart } = {}) => {
      if (!kart?.isPlayer) return;
      setClass(this.el.countdown, 'is-rocket', true);
      restartAnimation(this.el.fxHit, 'is-on');
      this._later(() => setClass(this.el.countdown, 'is-rocket', false), 900);
    });
    on(EVENTS.ITEM_ROLL, ({ kart, item } = {}) => {
      if (!kart?.isPlayer) return;
      this._itemId = null; // force the settle animation on the next update
      this._itemCharges = itemCount(resolveItem(item));
    });
    on(EVENTS.ITEM_USE, ({ kart, item } = {}) => {
      if (!kart?.isPlayer) return;
      this._itemCharges = Math.max(0, this._itemCharges - 1);
      const def = resolveItem(item);
      if (def) setText(this.el.itemIcon, def.icon);
      restartAnimation(this.el.itemSlot, 'is-use');
    });
    on(EVENTS.KART_WRONG_WAY, ({ kart, wrongWay } = {}) => {
      if (!kart?.isPlayer) return;
      setClass(this.el.wrongway, 'is-on', !!wrongWay);
    });
  }

  // ------------------------------------------------------------- public API --
  /** @param {any} trackApi */
  setTrack(trackApi) {
    this.trackApi = trackApi || null;
    try {
      this.minimap?.setTrack?.(trackApi);
    } catch (err) {
      console.warn('[hud] minimap track failed:', err);
    }
    this._resizeSpeedo();
  }

  /** @param {string} mode one of MODES */
  setMode(mode) {
    this.mode = mode || MODES.GP;
    const tt = this.mode === MODES.TIME_TRIAL;
    setHidden(this.el.tt, !tt);
    setClass(this.root, 'mode-tt', tt);
    // No opponents in time trial → the position widget is noise.
    setHidden(this.el.place, tt);
  }

  /** @param {string} q quality preset */
  setQuality(q) {
    this.quality = q || 'high';
    this.root.classList.remove('q-low', 'q-medium', 'q-high', 'q-ultra');
    this.root.classList.add(`q-${this.quality}`);
    this.minimap?.setQuality?.(this.quality);
    this._resizeSpeedo();
  }

  show() {
    this.visible = true;
    this._place = null;
    this._lap = null;
    this._timerText = '';
    this._cdLast = ''; // a fresh race restarts the countdown animation
    this.root.classList.remove('is-hidden');
    this.root.classList.add('is-visible');
    this._resizeSpeedo();
    this._queueResize();
  }

  hide() {
    this.visible = false;
    this.root.classList.remove('is-visible');
    this.root.classList.add('is-hidden');
    this.root.classList.remove('is-prestart');
    this.hideCountdown();
    setClass(this.el.banner, 'is-show', false);
    setClass(this.el.wrongway, 'is-on', false);
    setClass(this.el.fxOffroad, 'is-on', false);
    setClass(this.el.fxBoost, 'is-on', false);
    setClass(this.el.fxSpeedlines, 'is-on', false);
    setClass(this.el.drift, 'is-on', false);
  }

  /** @param {number|string} value 3, 2, 1 or 'GO!' */
  showCountdown(value) {
    const el = this.el.countdown;
    if (!el) return;
    const label = typeof value === 'number' ? String(Math.max(0, Math.round(value))) : String(value ?? '');
    if (!label) return;
    // The race manager re-emits the same label every ~100 ms: only the first
    // emission of each label animates.
    if (this._cdLast === label) return;
    this._cdLast = label;
    this._cdTime = performance.now();

    // A pending fade-out must not wipe the new number.
    if (this._cdHideTimer) {
      clearTimeout(this._cdHideTimer);
      this._timers.delete(this._cdHideTimer);
      this._cdHideTimer = null;
    }

    const isGo = label === 'GO!' || label === 'GO' || label === '0';
    setText(this.el.countdownValue, isGo ? 'GO!' : label);
    setClass(el, 'is-go', isGo);
    setClass(el, 'is-out', false);
    restartAnimation(el, 'is-on');
    setClass(this.root, 'is-prestart', !isGo);
  }

  hideCountdown() {
    const el = this.el.countdown;
    if (!el) return;
    setClass(this.root, 'is-prestart', false);
    if (!el.classList.contains('is-on')) return;
    setClass(el, 'is-on', false);
    setClass(el, 'is-out', true);
    this._cdHideTimer = this._later(() => {
      this._cdHideTimer = null;
      setClass(el, 'is-out', false);
      setText(this.el.countdownValue, '');
    }, 520);
  }

  // ------------------------------------------------------------------ frame --
  /**
   * @param {number} dt seconds
   * @param {any} view the object main.js passes in
   */
  update(dt, view) {
    if (this._disposed || !this.visible) return;
    const d = Math.min(0.1, Math.max(0, dt || 0));
    this._t += d;
    if (this._hidden) return;
    const v = view || {};

    this._updateSpeedo(d, v);
    this._updateLap(v);
    this._updatePlace(v);
    this._updateItem(d, v);
    this._updateDrift(d, v);
    this._updateTimer(v);
    this._updateTimeTrial(v);
    this._updateFx(d, v);

    try {
      this.minimap?.draw?.(v.karts, v.kart, d);
    } catch (err) {
      if (!this._minimapWarned) {
        this._minimapWarned = true;
        console.warn('[hud] minimap draw failed:', err);
      }
    }
  }

  // ------------------------------------------------------------- speedometer --
  _resizeSpeedo() {
    const canvas = this.el.speedoCanvas;
    if (!canvas) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const css = Math.round(canvas.clientWidth || 200);
    const px = Math.round(css * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
      this._dialCache = null;
    }
    this._dialSize = css;
    this._dialDpr = dpr;
    this._buildDialCache();
  }

  _queueResize() {
    if (this._resizeQueued) return;
    this._resizeQueued = true;
    requestAnimationFrame(() => {
      this._resizeQueued = false;
      if (this._disposed) return;
      this.minimap?.resize?.();
      this._resizeSpeedo();
    });
  }

  /** Static dial art (ticks, red zone, ring) rendered once per size change. */
  _buildDialCache() {
    const size = this._dialSize;
    if (!size || !this._speedoCtx) return;
    const dpr = this._dialDpr || 1;
    const px = Math.round(size * dpr);
    const cache = document.createElement('canvas');
    cache.width = px;
    cache.height = px;
    const c = cache.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;
    const A0 = 0.75 * Math.PI;
    const SWEEP = 1.5 * Math.PI;

    // face
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(8, 11, 24, 0.92)';
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    c.stroke();

    // arc track
    c.beginPath();
    c.arc(cx, cy, r - 5, A0, A0 + SWEEP);
    c.lineWidth = 7;
    c.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    c.stroke();

    // red zone (last 22%)
    c.beginPath();
    c.arc(cx, cy, r - 5, A0 + SWEEP * 0.78, A0 + SWEEP);
    c.lineWidth = 7;
    c.strokeStyle = 'rgba(255, 59, 48, 0.72)';
    c.stroke();

    // ticks
    const maxKmh = this._maxKmh;
    const stepKmh = 10;
    for (let kmh = 0; kmh <= maxKmh; kmh += stepKmh) {
      const t = kmh / maxKmh;
      const a = A0 + SWEEP * t;
      const major = kmh % 40 === 0;
      const inner = r - (major ? 17 : 12);
      const outer = r - 8;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      c.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      c.lineWidth = major ? 2.6 : 1.2;
      c.strokeStyle = major ? 'rgba(255, 255, 255, 0.92)' : 'rgba(255, 255, 255, 0.42)';
      c.stroke();
      if (major && kmh % 40 === 0 && kmh < maxKmh) {
        const lr = r - 30;
        c.font = `700 ${Math.round(size * 0.062)}px ui-monospace, monospace`;
        c.fillStyle = 'rgba(255, 255, 255, 0.7)';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(kmh), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
      }
    }

    // hub
    c.beginPath();
    c.arc(cx, cy, size * 0.14, 0, Math.PI * 2);
    c.fillStyle = 'rgba(6, 8, 18, 0.9)';
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(0, 229, 255, 0.5)';
    c.stroke();

    this._dialCache = cache;
  }

  _updateSpeedo(dt, v) {
    const kmh = clamp(Math.abs(Number(v.speed) || 0) * 3.6, 0, 999);
    this._kmh = kmh;

    // Sticky adaptive scale: only ever grows during a race.
    if (kmh > this._maxKmh - 6) {
      const next = Math.ceil((kmh + 12) / 20) * 20;
      if (next > this._maxKmh) {
        this._maxKmh = clamp(next, 120, 400);
        this._dialCache = null;
        this._buildDialCache();
      }
    }

    const t = clamp(kmh / this._maxKmh, 0, 1);
    const A0 = 0.75 * Math.PI;
    const SWEEP = 1.5 * Math.PI;
    const target = A0 + SWEEP * t;

    // Under-damped spring → needle overshoots then settles.
    const n = this._needle;
    n.v += (target - n.a) * 210 * dt;
    n.v *= Math.exp(-13.5 * dt);
    n.a += n.v * dt;
    if (n.a < A0 - 0.25) { n.a = A0 - 0.25; n.v = Math.abs(n.v) * 0.2; }
    if (n.a > A0 + SWEEP + 0.2) { n.a = A0 + SWEEP + 0.2; n.v = -Math.abs(n.v) * 0.2; }

    // digital readout
    const shown = Math.round(kmh);
    setText(this.el.speedoValue, shown);
    setClass(this.el.speedo, 'is-red', t > 0.78);

    const ctx = this._speedoCtx;
    if (!ctx || !this._dialSize) return;
    if (!this._dialCache) this._buildDialCache();
    const size = this._dialSize;
    const dpr = this._dialDpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (this._dialCache) ctx.drawImage(this._dialCache, 0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const len = size * 0.36;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(n.a);
    // needle
    ctx.beginPath();
    ctx.moveTo(-size * 0.014, size * 0.05);
    ctx.lineTo(-size * 0.008, -len);
    ctx.lineTo(size * 0.008, -len);
    ctx.lineTo(size * 0.014, size * 0.05);
    ctx.closePath();
    const hot = t > 0.78;
    ctx.fillStyle = hot ? '#ff5a5a' : '#f4f7ff';
    ctx.shadowColor = hot ? 'rgba(255, 59, 48, 0.9)' : 'rgba(0, 229, 255, 0.8)';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    // counterweight
    ctx.beginPath();
    ctx.moveTo(-size * 0.012, size * 0.05);
    ctx.lineTo(size * 0.012, size * 0.05);
    ctx.lineTo(0, size * 0.12);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
    ctx.restore();

    // hub cap on top of the needle
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = '#0b1020';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.75)';
    ctx.stroke();
  }

  // ------------------------------------------------------------------- parts --
  _updateLap(v) {
    const lap = clamp(Math.round(Number(v.lap) || 1), 1, 99);
    const laps = clamp(Math.round(Number(v.laps) || 3), 1, 99);
    if (lap !== this._lap) {
      this._lap = lap;
      setText(this.el.lapCur, lap);
      setText(this.el.lapTotal, laps);
    } else {
      setText(this.el.lapTotal, laps);
    }
  }

  _updatePlace(v) {
    if (this.mode === MODES.TIME_TRIAL) return;
    const place = clamp(Math.round(Number(v.place) || 1), 1, 99);
    const total = clamp(Math.round(Number(v.totalKarts) || 8), 1, 99);
    setText(this.el.placeLabel, `of ${total}`);
    if (place === this._place) return;
    const prev = this._place;
    this._place = place;
    setText(this.el.placeNum, place);
    setText(this.el.placeSuffix, ordinalSuffix(place));
    if (prev != null && prev !== place) {
      restartAnimation(this.el.place, place < prev ? 'is-up' : 'is-down');
    }
  }

  _updateItem(dt, v) {
    const item = resolveItem(v.item);
    const rolling = !!v.roulette;

    if (rolling) {
      this._rouletteT += dt;
      if (this._rouletteT >= 0.07) {
        this._rouletteT = 0;
        this._rouletteI = (this._rouletteI + 1) % ROULETTE_ICONS.length;
        setText(this.el.itemIcon, ROULETTE_ICONS[this._rouletteI]);
      }
      setClass(this.el.itemSlot, 'is-rolling', true);
      setClass(this.el.item, 'is-empty', false);
      setText(this.el.itemLabel, 'Rolling…');
      return;
    }
    setClass(this.el.itemSlot, 'is-rolling', false);

    if (item) {
      const id = item.id;
      if (id !== this._itemId) {
        this._itemId = id;
        this._itemCharges = itemCount(item);
        setText(this.el.itemIcon, item.icon);
        restartAnimation(this.el.itemSlot, 'is-pop');
      }
      const n = Math.max(0, this._itemCharges);
      const showCount = n > 1;
      setText(this.el.itemCount, showCount ? `x${n}` : '');
      setClass(this.el.itemCount, 'is-on', showCount);
      setText(this.el.itemLabel, item.name || 'Item');
      setClass(this.el.item, 'is-empty', false);
      setClass(this.el.item, 'is-hot', !!item.offensive);
      this.el.itemSlot?.style.setProperty('--tk-item', hexColor(item.color));
    } else {
      if (this._itemId !== null) {
        this._itemId = null;
        setText(this.el.itemCount, '');
        setClass(this.el.itemCount, 'is-on', false);
      }
      setClass(this.el.item, 'is-empty', true);
      setClass(this.el.item, 'is-hot', false);
      setText(this.el.itemLabel, 'Item');
    }
  }

  _updateDrift(dt, v) {
    const drifting = !!v.drifting;
    this._driftHold = Math.max(0, this._driftHold - dt);
    const on = drifting || this._driftHold > 0;
    setClass(this.el.drift, 'is-on', on);

    const charge = clamp(Number(v.boostCharge) || 0, 0, 1);
    const level = clamp(Math.round(Number(v.kart?.state?.driftLevel) || 0), 0, 2);
    const stage = drifting ? level + 1 : 0;
    if (on) {
      if (this.el.driftFill) {
        const s = charge.toFixed(3);
        if (this.el.driftFill.__tkScale !== s) {
          this.el.driftFill.__tkScale = s;
          this.el.driftFill.style.transform = `scaleX(${s})`;
        }
      }
      setText(this.el.driftStage, drifting ? DRIFT_STAGE_LABEL[level] : 'BOOST!');
      this.el.drift.classList.remove('is-stage1', 'is-stage2', 'is-stage3');
      if (stage) this.el.drift.classList.add(`is-stage${stage}`);
    }
  }

  _updateTimer(v) {
    const text = formatTime(v.raceTime);
    if (text !== this._timerText) {
      this._timerText = text;
      setText(this.el.timer, text);
    }
  }

  _updateTimeTrial(v) {
    if (this.mode !== MODES.TIME_TRIAL) return;
    const kart = v.kart;
    const lapTime = kart?.lapTime ?? kart?.currentLapTime ?? kart?.lastLapTime;
    const best = kart?.bestLap ?? kart?.bestLapTime;
    setText(this.el.ttLap, Number.isFinite(lapTime) ? formatTime(lapTime) : '--:--.--');
    setText(this.el.ttBest, Number.isFinite(best) ? formatTime(best) : '--:--.--');
    if (Number.isFinite(best) && best !== this._lastBest) {
      const isFirst = this._lastBest == null;
      this._lastBest = best;
      if (!isFirst) restartAnimation(this.el.tt, 'is-best');
    }
  }

  _updateFx(dt, v) {
    this._boostPulse = Math.max(0, this._boostPulse - dt);
    const boosting = !!v.boosting || this._boostPulse > 0;
    setClass(this.el.fxBoost, 'is-on', boosting);
    setClass(this.el.fxSpeedlines, 'is-on', boosting);
    setClass(this.el.fxOffroad, 'is-on', !!v.offRoad);
    setClass(this.el.wrongway, 'is-on', !!v.wrongWay);
    setClass(this.root, 'is-prestart', v.state === 'countdown' && !this.el.countdown?.classList.contains('is-go'));
  }

  _showBanner(text, variant = 'final', seconds = 1.9) {
    const b = this.el.banner;
    if (!b) return;
    setText(this.el.bannerText, text);
    b.className = `hud-banner${variant ? ` hud-banner--${variant}` : ''}`;
    void b.offsetWidth;
    b.classList.add('is-show');
    this._later(() => b.classList.remove('is-show'), Math.round(seconds * 1000));
  }

  // ---------------------------------------------------------------- lifecycle --
  _onVisibility() {
    this._hidden = !!document.hidden;
    setClass(this.root, 'is-frozen', this._hidden);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch { /* ignore */ }
    }
    this._unsubs.length = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    try { this.minimap?.dispose?.(); } catch { /* ignore */ }
    this.minimap = null;
    this.root.remove();
  }
}
