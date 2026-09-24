/**
 * ============================================================================
 * TURBO KART — input (Agent 1)
 * ============================================================================
 * Keyboard + gamepad + touch, all funnelled into one live `InputState`.
 *
 * Steering convention (matches the track/kart contract):
 *   `state.steer > 0` = LEFT, `state.steer < 0` = RIGHT.
 *
 * Extra fields added on top of the frozen `InputState` (safe, additive):
 *   - `state.resetRequested` : true for exactly one `update()` after R / L3
 *   - `state.device`         : 'keyboard' | 'gamepad' | 'touch'
 *   - `state.pauseRequested` : true for exactly one `update()` after Start
 *
 * Touch controls live in their own layer appended to `document.body`
 * (never inside `#ui-root`, which belongs to the UI agent).
 * ============================================================================
 */
import { createInputState, EVENTS } from '../contracts.js';
import { clamp, moveTowards } from './mathUtils.js';

/** Default bindings. `input.bindings` is live — mutate or use `setBindings()`. */
export function defaultBindings() {
  return {
    keys: {
      throttle: ['KeyW', 'ArrowUp'],
      brake: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      drift: ['Space', 'ShiftLeft', 'ShiftRight'],
      item: ['KeyE', 'ControlLeft', 'ControlRight'],
      lookBack: ['KeyQ'],
      pause: ['Escape'],
      reset: ['KeyR'],
    },
    // Gamepad button indices (standard mapping). Triggers are analog.
    gamepad: {
      throttleButton: [7, 0],
      brakeButton: [6, 1],
      driftButton: [4, 2],
      itemButton: [5],
      lookBackButton: [3],
      pauseButton: [9, 8],
      resetButton: [10],
      deadzone: 0.16,
      sensitivity: 1,
    },
    touch: {
      enabled: true,
      autoThrottle: false,
      digitalSteerRate: 9,
      analogSteerRate: 42,
    },
    /** Keyboard steer ramp (units/second). */
    digitalSteerRate: 9,
    analogSteerRate: 42,
  };
}

const TYPING_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

/** @param {any} el @returns {boolean} */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  return !!TYPING_TAGS[el.tagName] || el.isContentEditable === true;
}

/**
 * Create the input controller.
 * @param {{bus?:any, domElement?:HTMLElement}} [opts]
 */
export function createInput({ bus, domElement } = {}) {
  const bindings = defaultBindings();
  const state = createInputState();

  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {Map<string,string>} */
  let codeToAction = new Map();
  /** @type {Map<string,string[]>} action → codes (for fast "is any held") */
  let actionCodes = new Map();

  let enabled = true;
  let resetLatched = false;
  let pauseShown = false;
  let disposed = false;

  let steerSmooth = 0;
  let lastDevice = 'keyboard';
  let activePad = null;
  let padSeen = false;

  const touch = {
    throttle: false,
    brake: false,
    drift: false,
    item: false,
    lookBack: false,
    steerPointers: new Map(), // pointerId → 'left' | 'right'
    steer: 0,
    layer: null,
    visible: false,
  };

  const isTouch = typeof window !== 'undefined' && !!(
    ('ontouchstart' in window) ||
    (typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0))
  );

  // ---------------------------------------------------------------- helpers
  function rebuildBindings() {
    codeToAction = new Map();
    actionCodes = new Map();
    for (const [action, codes] of Object.entries(bindings.keys)) {
      const list = Array.isArray(codes) ? codes : [codes];
      actionCodes.set(action, list);
      for (const c of list) codeToAction.set(c, action);
    }
  }
  rebuildBindings();

  function held(action) {
    const codes = actionCodes.get(action);
    if (!codes) return false;
    for (const c of codes) if (keys.has(c)) return true;
    return false;
  }

  function zeroState() {
    state.throttle = 0;
    state.brake = 0;
    state.steer = 0;
    state.drift = false;
    state.useItem = false;
    state.lookBack = false;
    steerSmooth = 0;
    touch.steer = 0;
  }

  function togglePause() {
    pauseShown = !pauseShown;
    bus?.emit?.(pauseShown ? EVENTS.UI_PAUSE : EVENTS.UI_RESUME, {});
  }

  function clearKeys() {
    keys.clear();
  }

  // --------------------------------------------------------------- keyboard
  const onKeyDown = (e) => {
    if (disposed || isTypingTarget(e.target)) return;
    const action = codeToAction.get(e.code);
    if (!action) return;
    if (enabled) e.preventDefault?.();
    if (e.repeat) return;
    lastDevice = 'keyboard';
    keys.add(e.code);
    if (action === 'pause') togglePause();
    else if (action === 'reset') resetLatched = true;
  };

  const onKeyUp = (e) => {
    if (disposed) return;
    if (codeToAction.has(e.code)) {
      keys.delete(e.code);
      if (enabled) e.preventDefault?.();
    }
  };

  const onBlur = () => clearKeys();

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onBlur);
  }

  // ---------------------------------------------------------------- gamepad
  const onPadConnected = () => { padSeen = true; };
  const onPadDisconnected = () => { activePad = null; };
  if (typeof window !== 'undefined') {
    window.addEventListener('gamepadconnected', onPadConnected);
    window.addEventListener('gamepaddisconnected', onPadDisconnected);
  }

  function pollGamepad() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    let pad = null;
    try {
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) { pad = p; break; }
      }
    } catch {
      return null;
    }
    activePad = pad;
    if (!pad) return null;
    const b = bindings.gamepad;
    const val = (i) => (pad.buttons?.[i]?.value ?? 0);
    const down = (i) => !!pad.buttons?.[i]?.pressed;
    const anyDown = (list) => list.some((i) => down(i));

    const throttle = Math.max(val(b.throttleButton[0]), down(b.throttleButton[0]) ? 1 : 0, down(0) ? 1 : 0);
    const brake = Math.max(val(b.brakeButton[0]), down(b.brakeButton[0]) ? 1 : 0, down(1) ? 1 : 0);

    // axes[0]: -1 left … +1 right → steer is inverted (positive = left).
    const dz = b.deadzone ?? 0.16;
    let ax = pad.axes?.[0] ?? 0;
    if (Math.abs(ax) < dz) ax = 0;
    else ax = Math.sign(ax) * ((Math.abs(ax) - dz) / (1 - dz));
    ax *= b.sensitivity ?? 1;
    const dpad = (down(14) ? 1 : 0) - (down(15) ? 1 : 0); // 14 = left, 15 = right
    const steer = clamp(-ax + dpad, -1, 1);

    const drift = anyDown(b.driftButton);
    const item = anyDown(b.itemButton);
    const lookBack = anyDown(b.lookBackButton);
    const pause = anyDown(b.pauseButton);
    const reset = anyDown(b.resetButton);
    const analogActive = Math.abs(steer) > 0.02 || throttle > 0.02 || brake > 0.02 ||
      drift || item || lookBack || pause || reset;
    if (analogActive) lastDevice = 'gamepad';
    return { throttle, brake, steer, drift, item, lookBack, pause, reset, analog: Math.abs(ax) > 0.02 };
  }

  // ------------------------------------------------------------------ touch
  function touchStyle(el, css) {
    el.style.cssText = css;
    return el;
  }

  function buildTouchLayer() {
    if (typeof document === 'undefined' || touch.layer) return;
    const layer = touchStyle(document.createElement('div'),
      'position:fixed;inset:0;z-index:40;pointer-events:none;display:none;' +
      'touch-action:none;-webkit-user-select:none;user-select:none;' +
      '-webkit-tap-highlight-color:transparent;font-family:system-ui,sans-serif;');
    layer.setAttribute('data-turbo-kart', 'touch-controls');

    const baseBtn =
      'position:absolute;display:grid;place-items:center;box-sizing:border-box;' +
      'border-radius:50%;pointer-events:auto;touch-action:none;color:#fff;font-weight:800;' +
      'background:rgba(12,18,34,0.42);border:2px solid rgba(255,255,255,0.45);' +
      'backdrop-filter:blur(2px);text-shadow:0 1px 3px rgba(0,0,0,0.6);transition:transform .05s;';

    const safeB = 'env(safe-area-inset-bottom, 0px)';
    const safeR = 'env(safe-area-inset-right, 0px)';
    const safeT = 'env(safe-area-inset-top, 0px)';

    // ---- steering zone (bottom-left, two halves, slide friendly) ----
    const zone = touchStyle(document.createElement('div'),
      `position:absolute;left:0;bottom:0;width:48%;height:44%;pointer-events:auto;touch-action:none;` +
      `padding-bottom:${safeB};box-sizing:border-box;`);
    const halfCss = 'position:absolute;bottom:calc(18px + ' + safeB + ');width:88px;height:88px;' +
      'border-radius:50%;display:grid;place-items:center;color:rgba(255,255,255,0.85);' +
      'font-size:34px;font-weight:900;background:rgba(12,18,34,0.34);' +
      'border:2px solid rgba(255,255,255,0.35);pointer-events:none;';
    const leftHalf = touchStyle(document.createElement('div'), halfCss + 'left:14px;');
    leftHalf.textContent = '◀';
    const rightHalf = touchStyle(document.createElement('div'), halfCss + 'left:112px;');
    rightHalf.textContent = '▶';
    zone.appendChild(leftHalf);
    zone.appendChild(rightHalf);
    layer.appendChild(zone);

    const setSteerPointer = (id, dir) => {
      if (dir) touch.steerPointers.set(id, dir);
      else touch.steerPointers.delete(id);
    };
    const dirFromEvent = (e) => {
      const r = zone.getBoundingClientRect();
      return e.clientX - r.left < r.width * 0.5 ? 'left' : 'right';
    };
    const zoneDown = (e) => {
      e.preventDefault();
      lastDevice = 'touch';
      zone.setPointerCapture?.(e.pointerId);
      setSteerPointer(e.pointerId, dirFromEvent(e));
    };
    const zoneMove = (e) => {
      if (!touch.steerPointers.has(e.pointerId)) return;
      e.preventDefault();
      setSteerPointer(e.pointerId, dirFromEvent(e));
    };
    const zoneUp = (e) => {
      if (!touch.steerPointers.has(e.pointerId)) return;
      setSteerPointer(e.pointerId, null);
    };
    zone.addEventListener('pointerdown', zoneDown);
    zone.addEventListener('pointermove', zoneMove);
    zone.addEventListener('pointerup', zoneUp);
    zone.addEventListener('pointercancel', zoneUp);
    zone.addEventListener('lostpointercapture', zoneUp);

    // ---- action buttons ----
    const makeButton = (label, css, onDown, onUp) => {
      const el = touchStyle(document.createElement('div'), baseBtn + css);
      el.textContent = label;
      const ids = new Set();
      const press = (e) => {
        e.preventDefault();
        lastDevice = 'touch';
        el.setPointerCapture?.(e.pointerId);
        ids.add(e.pointerId);
        el.style.transform = 'scale(0.93)';
        onDown();
      };
      const release = (e) => {
        if (!ids.has(e.pointerId)) return;
        ids.delete(e.pointerId);
        if (ids.size === 0) {
          el.style.transform = '';
          onUp();
        }
      };
      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      layer.appendChild(el);
      return el;
    };

    makeButton('⛽', `right:calc(16px + ${safeR});bottom:calc(24px + ${safeB});width:104px;height:104px;font-size:40px;`,
      () => { touch.throttle = true; }, () => { touch.throttle = false; });
    makeButton('⏹', `right:calc(126px + ${safeR});bottom:calc(24px + ${safeB});width:76px;height:76px;font-size:26px;`,
      () => { touch.brake = true; }, () => { touch.brake = false; });
    makeButton('DRIFT', `right:calc(30px + ${safeR});bottom:calc(136px + ${safeB});width:84px;height:84px;font-size:14px;letter-spacing:0.5px;`,
      () => { touch.drift = true; }, () => { touch.drift = false; });
    makeButton('ITEM', `right:calc(28px + ${safeR});bottom:calc(230px + ${safeB});width:68px;height:68px;font-size:13px;`,
      () => { touch.item = true; }, () => { touch.item = false; });
    makeButton('↩', `left:calc(16px + 0px);top:calc(14px + ${safeT});width:64px;height:64px;font-size:26px;`,
      () => { touch.lookBack = true; }, () => { touch.lookBack = false; });
    makeButton('❚❚', `right:calc(16px + ${safeR});top:calc(14px + ${safeT});width:52px;height:52px;font-size:18px;`,
      () => togglePause(), () => {});

    document.body.appendChild(layer);
    touch.layer = layer;
    touch.visible = true;
    layer.style.display = 'block';

    // Hybrid devices: first real touch reveals the controls.
    const reveal = () => { setTouchVisible(true); };
    window.addEventListener('touchstart', reveal, { once: true, passive: true });
    touch._reveal = reveal;
  }

  function setTouchVisible(on) {
    const want = !!on && isTouch;
    if (want && !touch.layer) buildTouchLayer();
    if (touch.layer) {
      touch.visible = want;
      touch.layer.style.display = want ? 'block' : 'none';
      if (!want) {
        touch.throttle = touch.brake = touch.drift = touch.item = touch.lookBack = false;
        touch.steerPointers.clear();
        touch.steer = 0;
      }
    }
    return want;
  }

  // ------------------------------------------------------------------- API
  const api = {
    state,
    bindings,
    isTouch,
    get lastDevice() { return lastDevice; },
    get enabled() { return enabled; },
    get pad() { return activePad; },
    get hasGamepad() { return !!activePad; },

    /** Replace part of the bindings (e.g. from a settings screen). */
    setBindings(partial = {}) {
      if (partial.keys) Object.assign(bindings.keys, partial.keys);
      if (partial.gamepad) Object.assign(bindings.gamepad, partial.gamepad);
      if (partial.touch) Object.assign(bindings.touch, partial.touch);
      if (Number.isFinite(partial.digitalSteerRate)) bindings.digitalSteerRate = partial.digitalSteerRate;
      if (Number.isFinite(partial.analogSteerRate)) bindings.analogSteerRate = partial.analogSteerRate;
      rebuildBindings();
      return bindings;
    },

    /** Show/hide the on-screen touch controls (only works on touch devices). */
    setTouchVisible,

    /** Enable/disable gameplay input. Disabling zeroes the state. */
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) {
        zeroState();
        resetLatched = false;
      }
      if (touch.layer && !enabled) {
        touch.layer.style.display = 'none';
        touch.throttle = touch.brake = touch.drift = touch.item = touch.lookBack = false;
        touch.steerPointers.clear();
        touch.steer = 0;
      } else if (touch.layer && enabled && touch.visible) {
        touch.layer.style.display = 'block';
      }
      return enabled;
    },

    /** Rumble the active gamepad (and vibrate on mobile). */
    rumble(strength = 0.5, duration = 200) {
      const s = clamp(strength, 0, 1);
      const d = Math.max(10, duration | 0);
      const pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : null;
      if (pads) {
        for (const p of pads) {
          const act = p?.vibrationActuator;
          if (act && typeof act.playEffect === 'function') {
            try {
              act.playEffect('dual-rumble', {
                startDelay: 0,
                duration: d,
                weakMagnitude: s * 0.7,
                strongMagnitude: s,
              });
            } catch { /* unsupported effect */ }
            break;
          }
        }
      }
      if (isTouch && typeof navigator !== 'undefined' && navigator.vibrate) {
        try { navigator.vibrate(Math.min(90, d)); } catch { /* ignore */ }
      }
      return api;
    },

    /**
     * Poll devices and refresh `state`.
     * @param {number} dt @param {{active?:boolean}} [opts]
     */
    update(dt = 0.016, { active = true } = {}) {
      // One-frame pulse for R / L3.
      state.resetRequested = resetLatched;
      resetLatched = false;
      state.pauseRequested = false;

      const on = enabled && active !== false;
      if (!on) {
        zeroState();
        state.device = lastDevice;
        return state;
      }

      const step = clamp(dt, 0.0005, 0.1);
      const pad = pollGamepad();

      // ---- steering ----
      let target = (held('left') ? 1 : 0) - (held('right') ? 1 : 0); // + = left
      let analog = false;
      if (pad && Math.abs(pad.steer) > 0.001) {
        target = clamp(target + pad.steer, -1, 1);
        analog = analog || pad.analog;
      }
      if (touch.steerPointers.size > 0) {
        let t = 0;
        for (const dir of touch.steerPointers.values()) t += dir === 'left' ? 1 : -1;
        target = clamp(target + clamp(t, -1, 1), -1, 1);
      }
      const rate = (analog ? bindings.analogSteerRate : bindings.digitalSteerRate) || 12;
      steerSmooth = moveTowards(steerSmooth, target, rate * step);
      state.steer = clamp(steerSmooth, -1, 1);

      // ---- throttle / brake ----
      let throttle = held('throttle') ? 1 : 0;
      let brake = held('brake') ? 1 : 0;
      if (pad) {
        throttle = Math.max(throttle, pad.throttle);
        brake = Math.max(brake, pad.brake);
      }
      if (touch.throttle || bindings.touch.autoThrottle) throttle = Math.max(throttle, 1);
      if (touch.brake) brake = Math.max(brake, 1);
      state.throttle = clamp(throttle, 0, 1);
      state.brake = clamp(brake, 0, 1);

      // ---- buttons ----
      state.drift = held('drift') || (pad ? pad.drift : false) || touch.drift;
      state.useItem = held('item') || (pad ? pad.item : false) || touch.item;
      state.lookBack = held('lookBack') || (pad ? pad.lookBack : false) || touch.lookBack;

      if (pad && pad.pause && !api._padPause) togglePause();
      api._padPause = !!pad?.pause;
      if (pad && pad.reset && !api._padReset) resetLatched = true;
      api._padReset = !!pad?.reset;

      state.device = lastDevice;
      return state;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('gamepadconnected', onPadConnected);
        window.removeEventListener('gamepaddisconnected', onPadDisconnected);
        document.removeEventListener('visibilitychange', onBlur);
        if (touch._reveal) window.removeEventListener('touchstart', touch._reveal);
      }
      touch.layer?.remove?.();
      touch.layer = null;
      unsubPause?.();
      unsubResume?.();
      unsubQuit?.();
      clearKeys();
      zeroState();
    },
  };

  // Keep our pause flag in sync when the UI pauses/resumes on its own.
  const unsubPause = bus?.on?.(EVENTS.UI_PAUSE, () => { pauseShown = true; });
  const unsubResume = bus?.on?.(EVENTS.UI_RESUME, () => { pauseShown = false; });
  const unsubQuit = bus?.on?.(EVENTS.UI_QUIT, () => { pauseShown = false; });

  if (domElement?.style) domElement.style.touchAction = 'none';
  if (isTouch) setTouchVisible(true);

  return api;
}

export default createInput;
