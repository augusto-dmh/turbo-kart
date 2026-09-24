/**
 * Turbo Kart — front-end menus, pause and results screens.
 * Owned by Agent 4 (UI).
 *
 * Flow:
 *   title → mode → character → track → difficulty → UI_RACE_CONFIG
 *   (TIME_TRIAL skips the difficulty step)
 *
 * Everything is plain DOM + CSS. Navigation works with mouse, keyboard
 * (arrows / Enter / Escape) and gamepad (D-pad / left stick / A / B).
 *
 * Public API (frozen by main.js):
 *   new Menus({ bus, container, characters, settings })
 *   showTitle(config) / showPause(settings) / hidePause()
 *   showResults(standings, { config, place, mode }) / hide()
 *   showTrackSelect(config) / showCharacterSelect(config) / showSettings()
 *   setQuality(q) / dispose()
 */

import './styles.css';
import {
  EVENTS, SFX, MODES, TRACKS, DIFFICULTIES, CHARACTERS, RACE, QUALITY_PRESETS,
} from '../contracts.js';
import {
  clamp, esc, formatTime, hexColor, characterOf, stars, setClass, setText, ordinal, prefersReducedMotion,
} from './components.js';

const MODE_INFO = {
  [MODES.GP]: {
    icon: '🏁',
    title: 'Grand Prix',
    desc: 'Eight racers, three laps, items on. Finish first for maximum points.',
    meta: ['8 racers', '3 laps', 'Items on'],
  },
  [MODES.VERSUS]: {
    icon: '⚔️',
    title: 'Versus',
    desc: 'A single no-points grudge match against seven rivals.',
    meta: ['8 racers', 'Items on', 'One race'],
  },
  [MODES.TIME_TRIAL]: {
    icon: '⏱️',
    title: 'Time Trial',
    desc: 'No rivals, no items. Just you, the track and the clock.',
    meta: ['Solo', 'Items off', 'Best lap'],
  },
};

const DIFFICULTY_INFO = {
  easy: { desc: 'Rivals take it easy. Perfect for learning the racing line.', pips: 1 },
  normal: { desc: 'A fair fight — clean lines and the occasional item.', pips: 2 },
  hard: { desc: 'Rivals brake late, drift hard and use items smartly.', pips: 3 },
  expert: { desc: 'Merciless pace. Miss an apex and they are gone.', pips: 4 },
};

const CAMERA_MODES = ['chase', 'far', 'hood'];

const THEME_COLORS = {
  sunset: { a: '#ffd400', b: '#ff2e88', glow: 'rgba(255, 122, 24, 0.55)', sky: 'rgba(70, 26, 60, 0.9)' },
  desert: { a: '#ffe1a8', b: '#ff7a18', glow: 'rgba(255, 176, 32, 0.55)', sky: 'rgba(64, 40, 18, 0.9)' },
  snow: { a: '#eafcff', b: '#4fc3ff', glow: 'rgba(79, 195, 255, 0.55)', sky: 'rgba(22, 40, 70, 0.9)' },
};

/** Stylized (not real) track silhouettes for the select screen previews. */
const PREVIEW_SHAPES = {
  // Wide coastal speedway: long sweepers + one tight hairpin.
  'sunset-speedway': [
    [-0.95, -0.06], [-0.72, -0.28], [-0.2, -0.36], [0.34, -0.28], [0.78, -0.36],
    [1.0, -0.1], [0.72, 0.1], [0.4, 0.03], [0.5, 0.3], [0.06, 0.38],
    [-0.42, 0.26], [-0.86, 0.2],
  ],
  // Canyon switchbacks: an S-shaped run with a big air section.
  'desert-dunes': [
    [-1.0, 0.14], [-0.66, -0.1], [-0.28, -0.3], [0.2, -0.34], [0.62, -0.2],
    [0.94, -0.03], [0.6, 0.1], [0.24, 0.06], [0.36, 0.3], [-0.12, 0.4],
    [-0.58, 0.32], [-0.96, 0.34],
  ],
  // Alpine: narrow loop with two hairpins.
  'frozen-peaks': [
    [-0.62, -0.4], [-0.1, -0.36], [0.36, -0.42], [0.86, -0.3], [0.9, -0.03],
    [0.5, 0.07], [0.62, 0.3], [0.16, 0.42], [-0.36, 0.36], [-0.74, 0.24],
    [-0.98, 0.02], [-0.86, -0.24],
  ],
};

/**
 * Paint a stylized track silhouette into a preview canvas.
 * Purely decorative: never touches `src/track/*`.
 */
function paintTrackPreview(canvas, trackId, theme) {
  if (!canvas) return;
  const w = canvas.clientWidth || 260;
  const h = canvas.clientHeight || 132;
  if (w < 8 || h < 8) return;
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = THEME_COLORS[theme] || THEME_COLORS.sunset;

  // sky / ground
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, colors.sky);
  bg.addColorStop(1, 'rgba(8, 10, 22, 0.95)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // sun / moon disc
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.26, Math.min(w, h) * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = colors.glow;
  ctx.fill();

  const pts = PREVIEW_SHAPES[trackId] || PREVIEW_SHAPES[TRACKS[0].id];
  const pad = 24;
  // Uniform scale fitted to the silhouette's own extent → keeps proportions.
  let maxX = 0.001;
  let maxY = 0.001;
  for (const [x, y] of pts) {
    maxX = Math.max(maxX, Math.abs(x));
    maxY = Math.max(maxY, Math.abs(y));
  }
  const s = Math.max(8, Math.min((w / 2 - pad) / maxX, (h / 2 - pad) / maxY));
  const map = pts.map(([x, y]) => [w / 2 + x * s, h / 2 + y * s]);

  const trace = () => {
    ctx.beginPath();
    const n = map.length;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let m = mid(map[n - 1], map[0]);
    ctx.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) {
      const cur = map[i];
      const next = map[(i + 1) % n];
      const nm = mid(cur, next);
      ctx.quadraticCurveTo(cur[0], cur[1], nm[0], nm[1]);
    }
    ctx.closePath();
  };

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.shadowColor = colors.glow;
  ctx.shadowBlur = 14;
  trace();
  ctx.lineWidth = 13;
  ctx.strokeStyle = 'rgba(8, 10, 20, 0.85)';
  ctx.stroke();
  ctx.shadowBlur = 0;

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, colors.a);
  grad.addColorStop(1, colors.b);
  trace();
  ctx.lineWidth = 7;
  ctx.strokeStyle = grad;
  ctx.stroke();

  trace();
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.stroke();
  ctx.setLineDash([]);

  // start/finish tick
  const p0 = map[0];
  const p1 = map[1];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  ctx.beginPath();
  ctx.moveTo(p0[0] + (dy / len) * 8, p0[1] - (dx / len) * 8);
  ctx.lineTo(p0[0] - (dy / len) * 8, p0[1] + (dx / len) * 8);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

export class Menus {
  /**
   * @param {{ bus?: any, container?: HTMLElement, characters?: any[], settings?: any }} opts
   */
  constructor({ bus, container, characters = [], settings = {} } = {}) {
    this.bus = bus || null;
    this.container = container || null;
    this.characters = Array.isArray(characters) && characters.length ? characters : CHARACTERS;
    this.settings = settings || {};

    this.root = document.createElement('div');
    this.root.className = 'menus is-hidden';
    this.root.innerHTML = `
      <div class="menu-backdrop"></div>
      <div class="menu-grid"></div>
      <div class="menu-blob menu-blob--a"></div>
      <div class="menu-blob menu-blob--b"></div>
      <div class="menu-blob menu-blob--c"></div>
      <div class="menu-stage" data-stage></div>
      <div class="menu-wipe" data-wipe></div>`;
    this.container?.appendChild?.(this.root);

    this.stage = this.root.querySelector('[data-stage]');
    this.wipe = this.root.querySelector('[data-wipe]');

    /** Current screen id ('title' | 'mode' | …). */
    this.kind = null;
    this.screen = null;
    this._open = false;
    this._paused = false;
    this._disposed = false;
    this._nav = [];
    this._navIndex = -1;
    this._timers = new Set();
    this._listeners = [];
    this._readyEmitted = false;
    this._quality = this.settings.quality || 'high';
    this._gpTotals = new Map();

    // selection state (mirrors the race config)
    this._sel = {
      mode: MODES.GP,
      characterId: this.characters[0]?.id || 'nova',
      trackId: TRACKS[0].id,
      difficulty: DIFFICULTIES[1],
      cameraMode: this.settings.cameraMode || 'chase',
    };

    // gamepad repeat state
    this._gp = { dir: '', next: 0, a: false, b: false, start: false };

    this._on(window, 'keydown', (e) => this._onKey(e), true);
    this._on(window, 'gamepadconnected', () => this._sfx(SFX.UI_MOVE));
    this._on(document, 'visibilitychange', () => {
      setClass(this.root, 'is-frozen', !!document.hidden);
    });

    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  // ------------------------------------------------------------------ util --
  _on(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    this._listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._disposed) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _sfx(name) {
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name });
  }

  _isOpen() {
    return this._open;
  }

  // ------------------------------------------------------------- rendering --
  _showRoot() {
    if (!this._open) {
      this._open = true;
      this.root.classList.remove('is-hidden');
      // next frame so the opacity transition actually runs
      requestAnimationFrame(() => {
        if (this._open) this.root.classList.add('is-visible');
      });
    }
    // The boot overlay must disappear as soon as the title is up.
    const boot = document.getElementById('boot-overlay');
    if (boot && !boot.classList.contains('hidden')) {
      boot.classList.add('hidden');
      this._later(() => { boot.style.display = 'none'; }, 700);
    }
  }

  _wipe() {
    if (!this.wipe) return;
    this.wipe.classList.remove('is-run');
    void this.wipe.offsetWidth;
    this.wipe.classList.add('is-run');
  }

  /**
   * Mount a screen.
   * @param {string} kind
   * @param {string} html
   * @param {{ focus?: number, cls?: string }} [opts]
   */
  _mount(kind, html, { focus = 0, cls = '' } = {}) {
    this.kind = kind;
    const screen = document.createElement('div');
    screen.className = `menu-screen menu-screen--${kind}${cls ? ` ${cls}` : ''}`;
    screen.innerHTML = html;
    this.stage.replaceChildren(screen);
    this.screen = screen;
    this._showRoot();
    this._wire(screen);
    this._collectNav();
    this._navIndex = -1;
    this._setNav(focus, true);
    this._wipe();
    return screen;
  }

  /** Wire every `[data-action]` / `[data-select]` element in a screen. */
  _wire(screen) {
    screen.querySelectorAll('[data-action]').forEach((node) => {
      const run = (e) => {
        e?.preventDefault?.();
        this._sfx(SFX.UI_CLICK);
        this._action(node.getAttribute('data-action'), node);
      };
      node.addEventListener('click', run);
    });
    screen.querySelectorAll('[data-select]').forEach((node) => {
      node.addEventListener('click', () => {
        this._sfx(SFX.UI_CLICK);
        this._choose(node.getAttribute('data-select'), node.getAttribute('data-value'));
      });
      node.addEventListener('pointerenter', () => {
        const idx = this._nav.indexOf(node);
        if (idx >= 0 && idx !== this._navIndex) this._setNav(idx, true);
      });
    });
  }

  _collectNav() {
    if (!this.screen) {
      this._nav = [];
      return;
    }
    const all = [...this.screen.querySelectorAll('[data-nav]')];
    this._nav = all.filter((node) => !node.disabled && node.offsetParent !== null);
  }

  _setNav(index, silent = false) {
    const nav = this._nav;
    if (!nav.length) {
      this._navIndex = -1;
      return;
    }
    const n = nav.length;
    const idx = ((index % n) + n) % n;
    if (idx === this._navIndex && !silent) return;
    for (let i = 0; i < n; i++) setClass(nav[i], 'is-focused', i === idx);
    this._navIndex = idx;
    const node = nav[idx];
    try { node.focus({ preventScroll: true }); } catch { /* older browsers */ }
    this._scrollIntoView(node);
    if (!silent) this._sfx(SFX.UI_MOVE);
  }

  _scrollIntoView(node) {
    const screen = this.screen;
    if (!node?.getBoundingClientRect || !screen || !this.stage) return;
    const r = node.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    const pad = 24;
    if (r.top < s.top + pad) {
      screen.scrollTop -= (s.top + pad) - r.top;
    } else if (r.bottom > s.bottom - pad) {
      screen.scrollTop += r.bottom - (s.bottom - pad);
    }
  }

  _move(dx, dy) {
    if (!this._nav.length) return;
    const cur = this._nav[this._navIndex] || this._nav[0];
    const grid = cur.closest?.('[data-cols]');
    const cols = grid ? Math.max(1, parseInt(grid.getAttribute('data-cols'), 10) || 1) : 1;
    const vStep = cols > 1 ? cols : 1;
    const step = dx ? dx : dy * vStep;
    this._setNav((this._navIndex < 0 ? 0 : this._navIndex) + step);
  }

  _activate() {
    const node = this._nav[this._navIndex];
    if (!node) return;
    if (node.tagName === 'INPUT' && node.type === 'range') return;
    node.click?.();
  }

  // -------------------------------------------------------------- keyboard --
  _onKey(e) {
    if (!this._isOpen() || this._disposed) return;
    const target = e.target;
    const isRange = target?.tagName === 'INPUT' && target.type === 'range';
    const key = e.key;

    if (key === 'Escape') {
      e.preventDefault();
      this._back();
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      this._move(0, key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      const dir = key === 'ArrowLeft' ? -1 : 1;
      if (isRange) this._nudgeRange(target, dir);
      else this._move(dir, 0);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (isRange) return;
      e.preventDefault();
      this._activate();
    }
  }

  _nudgeRange(input, dir) {
    const step = Number(input.step) || 5;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const next = clamp(Number(input.value) + dir * (step * 2), min, max);
    if (next !== Number(input.value)) {
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  _back() {
    switch (this.kind) {
      case 'title': break;
      case 'mode': this.showTitle(); break;
      case 'character': this.showModeSelect(); break;
      case 'track': this.showCharacterSelect(); break;
      case 'difficulty': this.showTrackSelect(); break;
      case 'howto': this.showTitle(); break;
      case 'settings': this._returnFromSettings(); break;
      // The input layer owns pause toggling for every device (keyboard Escape,
      // touch, gamepad Start). Emitting UI_RESUME here as well produced a
      // resume-then-pause pair on a single key press, so Escape could never
      // resume. Do nothing for the pause screen — the toggle closes it.
      case 'pause': break;
      default: break;
    }
  }

  // --------------------------------------------------------------- gamepad --
  _tick() {
    this._raf = requestAnimationFrame(this._tick);
    if (!this._open || this._disposed || document.hidden) return;
    try {
      this._pollGamepad();
    } catch { /* never break the game because of a pad */ }
  }

  _pollGamepad() {
    const pads = navigator.getGamepads?.() || [];
    const now = performance.now() / 1000;
    for (const pad of pads) {
      if (!pad) continue;
      const btn = (i) => !!pad.buttons?.[i]?.pressed;
      const ax = pad.axes?.[0] ?? 0;
      const ay = pad.axes?.[1] ?? 0;

      let dx = 0;
      let dy = 0;
      if (btn(12) || ay < -0.55) dy = -1;
      else if (btn(13) || ay > 0.55) dy = 1;
      else if (btn(14) || ax < -0.55) dx = -1;
      else if (btn(15) || ax > 0.55) dx = 1;

      const dir = dx || dy ? `${dx},${dy}` : '';
      if (dir) {
        if (dir !== this._gp.dir) {
          this._gp.dir = dir;
          this._gp.next = now + 0.34;
          this._move(dx, dy);
        } else if (now >= this._gp.next) {
          this._gp.next = now + 0.15;
          this._move(dx, dy);
        }
      } else {
        this._gp.dir = '';
      }

      const a = btn(0);
      if (a && !this._gp.a) this._activate();
      this._gp.a = a;

      const b = btn(1);
      if (b && !this._gp.b) this._back();
      this._gp.b = b;

      const start = btn(9);
      if (start && !this._gp.start) {
        // Start is owned by the input layer (it toggles UI_PAUSE/UI_RESUME);
        // see the note in `_back()`.
      }
      this._gp.start = start;
    }
  }

  // ============================================================ screens ====
  /** Title screen. Also used by main.js as the "return to menu" entry point. */
  showTitle(config = {}) {
    if (config && typeof config === 'object') {
      this._sel.mode = config.mode || this._sel.mode;
      this._sel.characterId = config.characterId || this._sel.characterId;
      this._sel.trackId = config.trackId || this._sel.trackId;
      this._sel.difficulty = config.difficulty || this._sel.difficulty;
    }
    this._paused = false;

    const best = this._gpTotals.get(this._sel.characterId);
    this._mount('title', `
      <div class="mk-logo">
        <div class="mk-logo__word">TURBO KART</div>
        <div class="mk-logo__kart">ARCADE RACER</div>
        <div class="mk-logo__tag">${TRACKS.length} tracks · ${this.characters.length} racers · one finish line</div>
      </div>
      <div class="menu-btns">
        <button class="menu-btn menu-btn--primary" data-nav data-action="mode">Start</button>
        <button class="menu-btn menu-btn--cyan" data-nav data-action="timetrial">Time Trial</button>
        <button class="menu-btn" data-nav data-action="settings">Settings</button>
        <button class="menu-btn menu-btn--ghost" data-nav data-action="howto">How to play</button>
      </div>
      <div class="menu-foot">
        <span>↑ ↓ Navigate</span><span>Enter Select</span><span>Esc Back</span>
        ${best ? `<span>GP points: <b>${best}</b></span>` : ''}
      </div>`);

    if (!this._readyEmitted) {
      this._readyEmitted = true;
      this._later(() => this.bus?.emit?.(EVENTS.UI_READY, {}), 0);
    }
    return this;
  }

  /** Mode select (GP / Versus / Time Trial). */
  showModeSelect() {
    const cards = [MODES.GP, MODES.VERSUS, MODES.TIME_TRIAL].map((id) => {
      const info = MODE_INFO[id];
      return `
        <button class="menu-card" data-nav data-select="mode" data-value="${id}">
          <div class="menu-card__icon">${info.icon}</div>
          <div class="menu-card__title">${esc(info.title)}</div>
          <div class="menu-card__desc">${esc(info.desc)}</div>
          <div class="menu-card__meta">${info.meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
        </button>`;
    }).join('');

    this._mount('mode', `
      <div class="menu-head">
        <div class="menu-eyebrow">Turbo Kart</div>
        <h2 class="menu-title">Select Mode</h2>
      </div>
      <div class="menu-cards" data-cols="3">${cards}</div>
      <div class="menu-row">
        <button class="menu-btn menu-btn--ghost" data-nav data-action="title">Back</button>
      </div>`);
    return this;
  }

  /** Character select (8 racers, stats, preview). */
  showCharacterSelect(config = {}) {
    if (config?.characterId) this._sel.characterId = config.characterId;
    if (config?.mode) this._sel.mode = config.mode;

    const cards = this.characters.map((c) => {
      const color = hexColor(c.color);
      const accent = hexColor(c.accent, '#ffffff');
      const selected = c.id === this._sel.characterId ? ' is-selected' : '';
      return `
        <button class="char-card${selected}" data-nav data-select="character" data-value="${esc(c.id)}">
          <div class="char-card__top">
            <span class="char-card__swatch" style="background:linear-gradient(160deg, ${color}, ${accent})"></span>
            <span class="char-card__name">${esc(c.name)}</span>
          </div>
          <div class="char-card__tag">${esc(c.tagline || '')}</div>
          ${this._statsHTML(c.stats, true)}
        </button>`;
    }).join('');

    this._mount('character', `
      <div class="menu-head">
        <div class="menu-eyebrow">${esc(MODE_INFO[this._sel.mode]?.title || 'Race')}</div>
        <h2 class="menu-title">Choose your racer</h2>
      </div>
      <div class="char-layout">
        <div class="char-grid" data-cols="4">${cards}</div>
        <aside class="char-preview" data-preview>${this._previewHTML()}</aside>
      </div>
      <div class="menu-row">
        <button class="menu-btn menu-btn--ghost" data-nav data-action="back">Back</button>
        <button class="menu-btn menu-btn--primary" data-nav data-action="next">Next</button>
      </div>`);
    return this;
  }

  _statsHTML(stats, compact) {
    if (!stats) return '';
    const rows = [['speed', 'Speed'], ['accel', 'Accel'], ['grip', 'Grip'], ['weight', 'Weight']];
    return rows.map(([key, label]) => {
      const v = clamp(Math.round(stats[key] ?? 0), 0, 5);
      if (compact) {
        return `<div class="stat-row"><span class="stat-row__label">${label}</span>
          <span class="stat-bar"><span class="stat-bar__fill" style="transform:scaleX(${(v / 5).toFixed(2)})"></span></span>
          <span class="stat-row__val">${v}</span></div>`;
      }
      return `<div class="stat-row"><span class="stat-row__label">${label}</span>
        <span class="stat-bar"><span class="stat-bar__fill" style="transform:scaleX(${(v / 5).toFixed(2)})"></span></span>
        <span class="stat-row__val">${v}</span></div>`;
    }).join('');
  }

  _previewHTML() {
    const c = characterOf(this._sel.characterId) || this.characters[0];
    if (!c) return '';
    const color = hexColor(c.color);
    const accent = hexColor(c.accent, '#ffffff');
    return `
      <div class="char-preview__avatar" style="background:linear-gradient(160deg, ${color}, ${accent})">${esc((c.name || '?')[0])}</div>
      <div class="char-preview__name">${esc(c.name)}</div>
      <div class="char-preview__tag">${esc(c.tagline || '')}</div>
      ${this._statsHTML(c.stats, false)}`;
  }

  /** Track select with stylized canvas previews. */
  showTrackSelect(config = {}) {
    if (config?.trackId) this._sel.trackId = config.trackId;
    if (config?.mode) this._sel.mode = config.mode;
    if (config?.characterId) this._sel.characterId = config.characterId;

    const cards = TRACKS.map((t) => `
      <button class="track-card menu-card${t.id === this._sel.trackId ? ' is-selected' : ''}"
              data-nav data-select="track" data-value="${esc(t.id)}">
        <canvas class="track-card__canvas" data-preview-track="${esc(t.id)}" data-theme="${esc(t.theme)}"></canvas>
        <div class="track-card__name">${esc(t.name)}</div>
        <div class="track-card__meta">
          <span>${esc(t.theme)}</span><span>${t.laps} laps</span>
          <span class="stars">${stars(t.difficulty)}</span>
        </div>
        <div class="track-card__desc">${esc(t.description)}</div>
      </button>`).join('');

    this._mount('track', `
      <div class="menu-head">
        <div class="menu-eyebrow">${esc(MODE_INFO[this._sel.mode]?.title || 'Race')}</div>
        <h2 class="menu-title">Select track</h2>
      </div>
      <div class="track-grid" data-cols="3">${cards}</div>
      <div class="menu-row">
        <button class="menu-btn menu-btn--ghost" data-nav data-action="back">Back</button>
        <button class="menu-btn menu-btn--primary" data-nav data-action="next">Next</button>
      </div>`);

    // Previews need layout → paint on the next frame.
    requestAnimationFrame(() => {
      if (this._disposed || this.kind !== 'track') return;
      this.screen?.querySelectorAll('[data-preview-track]').forEach((canvas) => {
        paintTrackPreview(canvas, canvas.getAttribute('data-preview-track'), canvas.getAttribute('data-theme'));
      });
    });
    return this;
  }

  /** Difficulty select (4 tiers). */
  showDifficulty(config = {}) {
    if (config?.difficulty) this._sel.difficulty = config.difficulty;
    const cards = DIFFICULTIES.map((d) => {
      const info = DIFFICULTY_INFO[d] || { desc: '', pips: 1 };
      const pips = Array.from({ length: 4 }, (_, i) =>
        `<span class="diff-card__pip${i < info.pips ? ' is-on' : ''}"></span>`).join('');
      return `
        <button class="menu-card diff-card${d === this._sel.difficulty ? ' is-selected' : ''}"
                data-nav data-select="difficulty" data-value="${esc(d)}">
          <div class="menu-card__title">${esc(d)}</div>
          <div class="diff-card__pips">${pips}</div>
          <div class="menu-card__desc">${esc(info.desc)}</div>
        </button>`;
    }).join('');

    this._mount('difficulty', `
      <div class="menu-head">
        <div class="menu-eyebrow">${esc(MODE_INFO[this._sel.mode]?.title || 'Race')}</div>
        <h2 class="menu-title">Difficulty</h2>
      </div>
      <div class="diff-grid" data-cols="4">${cards}</div>
      <div class="menu-row">
        <button class="menu-btn menu-btn--ghost" data-nav data-action="back">Back</button>
        <button class="menu-btn menu-btn--primary" data-nav data-action="go">Start race</button>
      </div>`);
    return this;
  }

  /** Settings panel (used standalone and inside the pause screen). */
  showSettings(returnTo = 'title') {
    this._settingsReturn = returnTo;
    this._mount('settings', `
      <div class="menu-head">
        <div class="menu-eyebrow">Turbo Kart</div>
        <h2 class="menu-title">Settings</h2>
      </div>
      <div class="settings" data-settings></div>
      <div class="menu-row">
        <button class="menu-btn menu-btn--ghost" data-nav data-action="back">Back</button>
      </div>`);
    this._renderSettings(this.screen?.querySelector('[data-settings]'));
    return this;
  }

  _returnFromSettings() {
    if (this._settingsReturn === 'pause') this.showPause(this.settings);
    else this.showTitle();
  }

  _renderSettings(host) {
    if (!host) return;
    const s = this.settings || {};
    const vol = (v) => Math.round(clamp(Number(v ?? 0.9) * 100, 0, 100));

    host.innerHTML = `
      <div class="settings__row">
        <span class="settings__label">Quality</span>
        <div class="segmented" data-seg="quality">
          ${QUALITY_PRESETS.map((q) => `<button class="segmented__btn${s.quality === q ? ' is-active' : ''}" data-nav data-seg-btn="quality" data-value="${q}">${q}</button>`).join('')}
        </div>
      </div>
      <div class="settings__row">
        <span class="settings__label">Master</span>
        <div class="slider-wrap">
          <input class="slider" type="range" min="0" max="100" step="5" value="${vol(s.master)}" data-nav data-vol="master" aria-label="Master volume">
          <span class="slider-wrap__val" data-vol-val="master">${vol(s.master)}</span>
        </div>
      </div>
      <div class="settings__row">
        <span class="settings__label">Music</span>
        <div class="slider-wrap">
          <input class="slider" type="range" min="0" max="100" step="5" value="${vol(s.music)}" data-nav data-vol="music" aria-label="Music volume">
          <span class="slider-wrap__val" data-vol-val="music">${vol(s.music)}</span>
        </div>
      </div>
      <div class="settings__row">
        <span class="settings__label">Effects</span>
        <div class="slider-wrap">
          <input class="slider" type="range" min="0" max="100" step="5" value="${vol(s.sfx)}" data-nav data-vol="sfx" aria-label="Effects volume">
          <span class="slider-wrap__val" data-vol-val="sfx">${vol(s.sfx)}</span>
        </div>
      </div>
      <div class="settings__row">
        <span class="settings__label">Camera</span>
        <div class="segmented" data-seg="cameraMode">
          ${CAMERA_MODES.map((m) => `<button class="segmented__btn${(s.cameraMode || 'chase') === m ? ' is-active' : ''}" data-nav data-seg-btn="cameraMode" data-value="${m}">${m}</button>`).join('')}
        </div>
      </div>`;

    host.querySelectorAll('[data-seg-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-seg-btn');
        const value = btn.getAttribute('data-value');
        this.settings[key] = value;
        if (key === 'quality') this.setQuality(value);
        this._sfx(SFX.UI_CLICK);
        host.querySelectorAll(`[data-seg-btn="${key}"]`).forEach((b) => {
          setClass(b, 'is-active', b === btn);
        });
        this._emitSettings();
        // keep nav in sync (buttons are static, focus is unchanged)
      });
    });

    host.querySelectorAll('[data-vol]').forEach((input) => {
      const key = input.getAttribute('data-vol');
      const out = host.querySelector(`[data-vol-val="${key}"]`);
      const apply = () => {
        const v = clamp(Number(input.value) / 100, 0, 1);
        this.settings[key] = v;
        setText(out, Math.round(v * 100));
        this._emitSettings();
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
      input.addEventListener('pointerdown', () => this._sfx(SFX.UI_CLICK));
    });

    // refresh nav list (settings panel is dynamic)
    const idx = this._navIndex;
    this._collectNav();
    this._navIndex = -1;
    this._setNav(Math.max(0, idx), true);
  }

  _emitSettings() {
    const s = this.settings || {};
    this.bus?.emit?.(EVENTS.UI_SETTINGS, {
      quality: s.quality || this._quality,
      master: clamp(Number(s.master ?? 0.9), 0, 1),
      music: clamp(Number(s.music ?? 0.6), 0, 1),
      sfx: clamp(Number(s.sfx ?? 0.9), 0, 1),
      cameraMode: s.cameraMode || 'chase',
    });
  }

  /** Controls reference. */
  showHowTo() {
    const key = (k) => `<span class="key">${esc(k)}</span>`;
    const row = (label, keys) => `<div class="keyrow"><span>${esc(label)}</span><span class="keyrow__keys">${keys}</span></div>`;
    this._mount('howto', `
      <div class="menu-head">
        <div class="menu-eyebrow">Turbo Kart</div>
        <h2 class="menu-title">How to play</h2>
        <p class="menu-sub">Hold a drift to charge a mini-turbo, then release it on the exit for a burst of speed.</p>
      </div>
      <div class="howto">
        <div class="howto__col">
          <h3>Keyboard</h3>
          ${row('Accelerate', key('W') + key('↑'))}
          ${row('Brake / reverse', key('S') + key('↓'))}
          ${row('Steer', key('A') + key('D'))}
          ${row('Drift / hop', key('Space') + key('Shift'))}
          ${row('Use item', key('E') + key('Ctrl'))}
          ${row('Look back', key('Q'))}
          ${row('Pause', key('Esc'))}
        </div>
        <div class="howto__col">
          <h3>Gamepad</h3>
          ${row('Accelerate', key('RT') + key('A'))}
          ${row('Brake', key('LT') + key('B'))}
          ${row('Steer', key('Stick') + key('D-pad'))}
          ${row('Drift / hop', key('RB') + key('X'))}
          ${row('Use item', key('LB') + key('Y'))}
          ${row('Look back', key('L3'))}
          ${row('Pause', key('Start'))}
        </div>
        <div class="howto__col">
          <h3>Touch</h3>
          ${row('Accelerate', key('Right pad'))}
          ${row('Brake', key('Left pad'))}
          ${row('Steer', key('Drag pad'))}
          ${row('Drift', key('Drift btn'))}
          ${row('Use item', key('Item btn'))}
          <h3 style="margin-top:14px">Tips</h3>
          ${row('Rocket start', key('Hold gas on 2'))}
          ${row('Mini-turbo', key('Drift ×2'))}
          ${row('Slipstream', key('Follow closely'))}
        </div>
      </div>
      <div class="menu-row">
        <button class="menu-btn menu-btn--primary" data-nav data-action="back">Back</button>
      </div>`);
    return this;
  }

  // ----------------------------------------------------------------- pause --
  /** Pause overlay with a live settings panel. */
  showPause(settings) {
    if (settings && typeof settings === 'object') this.settings = settings;
    // Remember what was on screen so Resume can put it back (e.g. the results
    // screen, which the input layer can also pause from).
    if (this.kind !== 'settings' && this.kind !== 'pause') this._pauseReturn = this.kind;
    this._paused = true;
    this._mount('pause', `
      <div class="pause-shell">
        <div class="pause-panel">
          <h2 class="pause-panel__title">Paused</h2>
          <div class="menu-btns menu-btns--col">
            <button class="menu-btn menu-btn--primary" data-nav data-action="resume">Resume</button>
            <button class="menu-btn" data-nav data-action="restart">Restart race</button>
            <button class="menu-btn" data-nav data-action="settings">Settings</button>
            <button class="menu-btn menu-btn--danger" data-nav data-action="quit">Quit to menu</button>
          </div>
        </div>
        <div class="settings" data-settings></div>
      </div>`);
    this._renderSettings(this.screen?.querySelector('[data-settings]'));
    return this;
  }

  hidePause() {
    this._paused = false;
    if (this.kind !== 'pause' && this.kind !== 'settings') return;
    const back = this._pauseReturn;
    this._pauseReturn = null;
    // Paused on top of the results screen → restore it instead of a blank UI.
    if (back === 'results' && this._lastResults) {
      const { standings, opts } = this._lastResults;
      this.showResults(standings, opts, { countPoints: false });
      return;
    }
    this.hide();
  }

  // --------------------------------------------------------------- results --
  /**
   * @param {any[]} standings race manager standings
   * @param {{ config?: any, place?: number, mode?: string }} opts
   */
  showResults(standings = [], { config = {}, place = 1, mode } = {}, { countPoints = true } = {}) {
    const raceMode = mode || config?.mode || this._sel.mode;
    const list = (Array.isArray(standings) ? standings : [])
      .filter(Boolean)
      .map((s, i) => ({
        kart: s.kart || null,
        place: clamp(Math.round(Number(s.place) || i + 1), 1, 99),
        lap: Number(s.lap) || null,
        laps: Number(s.laps) || null,
        time: Number.isFinite(s.finishTime) ? s.finishTime : null,
        bestLap: Number.isFinite(s.bestLap) ? s.bestLap
          : (Number.isFinite(s.kart?.bestLap) ? s.kart.bestLap : null),
        character: characterOf(s.kart) || null,
        isPlayer: !!s.kart?.isPlayer,
      }))
      .sort((a, b) => a.place - b.place);

    const playerPlace = clamp(Math.round(Number(place) || 1), 1, list.length || 8);
    const isGP = raceMode === MODES.GP;
    const isTT = raceMode === MODES.TIME_TRIAL;
    const podium = playerPlace >= 1 && playerPlace <= 3;

    // Keep the raw input so the screen can be restored after a pause.
    this._lastResults = { standings, opts: { config, place, mode } };

    // GP points + running totals (single-race GP in this build: the "Total"
    // column is the session cumulative for the player, this race for the AI).
    // `countPoints` is false when the screen is restored after a pause.
    const pointsFor = (p) => RACE.FINISH_PLACE_POINTS?.[p - 1] ?? Math.max(0, 9 - p);
    if (isGP) {
      const playerRow = list.find((r) => r.isPlayer);
      const playerId = playerRow?.character?.id || playerRow?.kart?.characterId || 'player';
      const earned = playerRow ? pointsFor(playerRow.place) : 0;
      const total = countPoints
        ? (this._gpTotals.get(playerId) || 0) + earned
        : (this._gpTotals.get(playerId) || earned);
      if (playerRow && countPoints) this._gpTotals.set(playerId, total);
      for (const row of list) {
        row.points = pointsFor(row.place);
        row.gpTotal = row.isPlayer ? total : row.points;
      }
    }

    const header = `
      <tr>
        <th>#</th><th>Racer</th><th>Laps</th><th>Time</th>
        ${isGP ? '<th>Pts</th><th>Total</th>' : ''}
      </tr>`;

    const rows = list.length
      ? list.map((row) => {
        const name = row.character?.name || row.kart?.name || `Racer ${row.place}`;
        const color = hexColor(row.character?.color, '#9fb0d0');
        const laps = row.laps ? `${Math.min(row.lap || 1, row.laps)}/${row.laps}` : (row.lap ? String(row.lap) : '–');
        const time = row.time != null ? formatTime(row.time) : '—';
        const cls = [
          row.isPlayer ? 'is-player' : '',
          row.place <= 3 ? 'is-podium' : '',
        ].filter(Boolean).join(' ');
        return `
          <tr class="${cls}">
            <td>${row.place}</td>
            <td><span class="results-row__name"><i class="results-row__swatch" style="background:${color}"></i>${esc(name)}${row.isPlayer ? ' <span class="badge-pill">You</span>' : ''}</span></td>
            <td>${esc(laps)}</td>
            <td class="results-row__time">${time}</td>
            ${isGP ? `<td>${row.points ?? '–'}</td><td>${row.gpTotal ?? '–'}</td>` : ''}
          </tr>`;
      }).join('')
      : '<tr><td colspan="6">No results recorded.</td></tr>';

    const notes = [];
    if (isTT) {
      const best = list.find((r) => r.bestLap != null)?.bestLap
        ?? (Number.isFinite(config?.bestLap) ? config.bestLap : null);
      const total = list.find((r) => r.time != null)?.time;
      if (best != null) notes.push(`<span>Best lap <b>${formatTime(best)}</b></span>`);
      if (total != null) notes.push(`<span>Total <b>${formatTime(total)}</b></span>`);
    }

    const titleCls = podium ? 'is-win' : 'is-lose';
    const titleText = !list.length
      ? 'Race complete'
      : (playerPlace === 1 ? 'Winner!' : `${ordinal(playerPlace)} place`);

    const podiumHTML = podium ? this._podiumHTML(list) : `
      <div class="badge-pill" style="align-self:center;margin-top:22px">Podium: top 3 finish</div>`;

    this._mount('results', `
      <div class="results-shell">
        <div class="results-panel">
          <h2 class="results-panel__title ${titleCls}">${esc(titleText)}</h2>
          <div class="results-table-wrap">
            <table class="results-table">
              <thead>${header}</thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${notes.length ? `<div class="results-note">${notes.join('')}</div>` : ''}
          <div class="menu-row" style="margin-top:16px">
            <button class="menu-btn menu-btn--primary" data-nav data-action="restart">Race again</button>
            <button class="menu-btn menu-btn--cyan" data-nav data-action="changetrack">Change track</button>
            <button class="menu-btn menu-btn--ghost" data-nav data-action="quit">Quit</button>
          </div>
        </div>
        <div class="results-panel podium-wrap">
          ${podiumHTML}
        </div>
      </div>`, { cls: 'menu-screen--results' });

    if (podium) this._confetti(this.screen.querySelector('.podium-wrap'));
    return this;
  }

  _podiumHTML(list) {
    const top = list.slice(0, 3);
    if (!top.length) return '';
    const order = [top[1], top[0], top[2]].filter(Boolean);
    const steps = order.map((row) => {
      const c = row.character;
      const color = hexColor(c?.color, '#8fa0c0');
      const accent = hexColor(c?.accent, '#ffffff');
      const name = c?.name || `Racer ${row.place}`;
      const cls = `podium__step podium__step--${clamp(row.place, 1, 3)}`;
      return `
        <div class="${cls}">
          <div class="podium__place">${row.place}</div>
          <div class="podium__avatar" style="background:linear-gradient(160deg, ${color}, ${accent})">${esc((name || '?')[0])}</div>
          <div class="podium__name">${esc(name)}</div>
        </div>`;
    }).join('');
    return `<div class="podium">${steps}</div>`;
  }

  _confetti(host) {
    if (!host) return;
    if (prefersReducedMotion()) return;
    const heavy = this._quality !== 'low';
    const count = heavy ? 36 : 14;
    const colors = ['#ffd400', '#ff2e88', '#00e5ff', '#7dff9b', '#ff7a18', '#7b5cff'];
    let bits = '';
    for (let i = 0; i < count; i++) {
      const left = (i * 37 + 11) % 100;
      const delay = ((i * 13) % 30) / 10;
      const dur = 2.6 + ((i * 7) % 22) / 10;
      const color = colors[i % colors.length];
      const rot = (i * 47) % 360;
      bits += `<span class="confetti__bit" style="left:${left}%;background:${color};animation-duration:${dur.toFixed(1)}s;animation-delay:${delay.toFixed(1)}s;transform:rotate(${rot}deg)"></span>`;
    }
    host.insertAdjacentHTML('afterbegin', `<div class="confetti">${bits}</div>`);
  }

  // ---------------------------------------------------------------- actions --
  _action(name) {
    switch (name) {
      case 'title': this.showTitle(); break;
      case 'mode': this.showModeSelect(); break;
      case 'timetrial':
        this._sel.mode = MODES.TIME_TRIAL;
        this.showCharacterSelect();
        break;
      case 'back': this._back(); break;
      case 'next': this._next(); break;
      case 'go': this._emitRaceConfig(); break;
      case 'settings': this.showSettings(this.kind === 'pause' ? 'pause' : 'title'); break;
      case 'howto': this.showHowTo(); break;
      case 'resume': this.bus?.emit?.(EVENTS.UI_RESUME); break;
      case 'restart':
        this.hide();
        this.bus?.emit?.(EVENTS.UI_RESTART, {});
        break;
      case 'changetrack':
        this.showTrackSelect(this._sel);
        break;
      case 'quit':
        this.hide();
        this.bus?.emit?.(EVENTS.UI_QUIT, {});
        break;
      default: break;
    }
  }

  _choose(kind, value) {
    if (!value) return;
    switch (kind) {
      case 'mode':
        this._sel.mode = value;
        this.showCharacterSelect();
        break;
      case 'character': {
        this._sel.characterId = value;
        // update selection styling in place (cheap) + preview panel
        this.screen?.querySelectorAll('[data-select="character"]').forEach((card) => {
          setClass(card, 'is-selected', card.getAttribute('data-value') === value);
        });
        const preview = this.screen?.querySelector('[data-preview]');
        if (preview) {
          preview.innerHTML = this._previewHTML();
          preview.querySelector('.char-preview__avatar')?.animate?.(
            [{ transform: 'scale(0.8)' }, { transform: 'scale(1)' }],
            { duration: 220, easing: 'cubic-bezier(.18,1.4,.4,1)' },
          );
        }
        break;
      }
      case 'track':
        this._sel.trackId = value;
        this.screen?.querySelectorAll('[data-select="track"]').forEach((card) => {
          setClass(card, 'is-selected', card.getAttribute('data-value') === value);
        });
        break;
      case 'difficulty':
        this._sel.difficulty = value;
        this.screen?.querySelectorAll('[data-select="difficulty"]').forEach((card) => {
          setClass(card, 'is-selected', card.getAttribute('data-value') === value);
        });
        break;
      default: break;
    }
  }

  _next() {
    switch (this.kind) {
      case 'character': this.showTrackSelect(); break;
      case 'track': this._afterTrack(); break;
      case 'difficulty': this._emitRaceConfig(); break;
      default: break;
    }
  }

  _afterTrack() {
    // Time trial has no rivals — difficulty would be meaningless.
    if (this._sel.mode === MODES.TIME_TRIAL) this._emitRaceConfig();
    else this.showDifficulty();
  }

  _emitRaceConfig() {
    const cfg = {
      trackId: this._sel.trackId,
      characterId: this._sel.characterId,
      difficulty: this._sel.difficulty,
      mode: this._sel.mode,
    };
    this.hide();
    this.bus?.emit?.(EVENTS.UI_RACE_CONFIG, cfg);
  }

  // -------------------------------------------------------------- lifecycle --
  /** Hide the whole menu layer (called when a race starts). */
  hide() {
    this._open = false;
    this._paused = false;
    this.root.classList.remove('is-visible');
    this.root.classList.add('is-hidden');
    this._nav = [];
    this._navIndex = -1;
    this.kind = null;
    this.screen = null;
  }

  /** @param {string} q */
  setQuality(q) {
    this._quality = q || 'high';
    this.root.classList.remove('q-low', 'q-medium', 'q-high', 'q-ultra');
    this.root.classList.add(`q-${this._quality}`);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    for (const off of this._listeners) {
      try { off(); } catch { /* ignore */ }
    }
    this._listeners.length = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this.root.remove();
  }
}
