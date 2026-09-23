/**
 * Minimal synchronous event bus shared by every subsystem.
 * Owned by the orchestrator — do not edit.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
    this._debug = false;
  }

  /** @param {string} event @param {Function} fn @returns {() => void} unsubscribe */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /** @param {string} event @param {Function} fn */
  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  /** @param {string} event @param {any} [payload] */
  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${event}" threw:`, err);
      }
    }
  }

  /** Remove every handler. */
  clear() {
    this._handlers.clear();
  }

  /** Turn on verbose event logging (dev only). */
  setDebug(on) {
    this._debug = !!on;
    if (on && !this._debugHooked) {
      this._debugHooked = true;
      const orig = this.emit.bind(this);
      this.emit = (event, payload) => {
        if (this._debug) console.debug('[event]', event, payload ?? '');
        orig(event, payload);
      };
    }
  }
}

/** Shared singleton — subsystems import this, never construct their own. */
export const bus = new EventBus();
