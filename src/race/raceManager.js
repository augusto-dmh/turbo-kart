/**
 * ============================================================================
 * TURBO KART — race director (Agent 3)
 * ============================================================================
 * Owns: the start countdown, validated lap counting, live standings, the
 * finish / results flow, wrong-way detection and race timer events.
 *
 * Public API (consumed by `src/main.js` and the HUD):
 *   - `start()`, `update(dt)`, `dispose()`
 *   - `state`: 'countdown' | 'racing' | 'finished'
 *   - `standings`: [{ kart, place, lap, progress, finished, finishTime, gap, ... }]
 *   - `playerPlace`, `playerFinished`, `raceTime`, `laps`
 *   - `countdownValue` (3/2/1/0/null) and `countdownRemaining` (exact seconds)
 *   - `results`: the final ordered table (also emitted with RACE_COMPLETE)
 *
 * Events emitted: RACE_COUNTDOWN, RACE_START, RACE_LAP, RACE_FINAL_LAP,
 * RACE_FINISH (player only), RACE_COMPLETE, RACE_TIMER, KART_FINISHED,
 * KART_WRONG_WAY, CAMERA_SHAKE (player impacts).
 * ============================================================================
 */

import { EVENTS, RACE } from '../contracts.js';
import { LapTracker } from './lapTracker.js';
import { clamp, wrap01 } from './progress.js';

/** Labels are offset so "3" shows immediately and each number lasts ~1 s. */
const COUNTDOWN_LABEL_OFFSET = 0.4;
/** Re-emit the countdown at this rate so HUDs and the AI see fresh data. */
const COUNTDOWN_EMIT = 0.1;
/** How long `countdownValue` keeps reporting 0 ("GO!") after the start. */
const GO_LABEL_HOLD = 0.9;
/** HUD timer event rate. */
const TIMER_INTERVAL = 0.25;
/** Grace period after the player finishes before results are forced. */
const FINISH_GRACE = 8.0;
/** Safety net: never leave a session without results (stuck player, etc.). */
const RACE_TIMEOUT = 600;
const WRONG_WAY_DOT = -0.3;
const WRONG_WAY_TRIGGER = 1.0;
const WRONG_WAY_CLEAR_DOT = 0.05;
const WRONG_WAY_CLEAR_RATE = 3.0;

const SHAKE_BY_KIND = {
  lightning: 0.85,
  shell: 0.5,
  'red-shell': 0.5,
  'green-shell': 0.45,
  'triple-shell': 0.45,
  banana: 0.4,
  star: 0.55,
  generic: 0.35,
};

export class RaceManager {
  /**
   * @param {{bus?: any, THREE?: any, karts?: any[], trackApi?: any, laps?: number,
   *          playerKart?: any, solo?: boolean}} opts
   */
  constructor({ bus, THREE, karts, trackApi, laps = RACE.LAPS, playerKart = null, solo = false } = {}) {
    this.bus = bus || null;
    this.THREE = THREE || null;
    this.karts = Array.isArray(karts) ? karts.filter(Boolean) : [];
    this.trackApi = trackApi || null;
    this.laps = Math.max(1, Math.floor(laps || RACE.LAPS));
    this.solo = !!solo;
    this.playerKart = playerKart || this.karts.find((k) => k?.isPlayer) || null;
    this.length = Number.isFinite(trackApi?.length) && trackApi.length > 8 ? trackApi.length : 600;

    this.state = 'countdown';
    this.raceTime = 0;
    this.countdownValue = 3;
    this.countdownRemaining = RACE.COUNTDOWN_SECONDS;
    this.playerPlace = this.karts.length;
    this.playerFinished = false;
    /** @type {any[]} final ordered results table (also emitted with RACE_COMPLETE) */
    this.results = null;

    this.tracker = new LapTracker({ trackApi, laps: this.laps });

    /** @type {Array<{kart:any, place:number, lap:number, progress:number, finished:boolean, finishTime:number|null, gap:number, projected:boolean}>} */
    this.standings = [];
    this._entries = new Map();
    /** @type {Map<any, {ww:number, wwOn:boolean}>} */
    this._k = new Map();

    for (let i = 0; i < this.karts.length; i++) {
      const e = this._makeEntry(this.karts[i], i + 1);
      this._entries.set(this.karts[i], e);
      this.standings.push(e);
    }

    this._cd = 0;
    this._cdEmit = 0;
    this._goHold = 0;
    this._timerAcc = 0;
    this._finishCount = 0;
    this._graceEnd = null;
    this._pendingComplete = false;
    this._bestLap = null;

    // ------------------------------------------------------------ wiring ----
    this._unsubs = [];
    if (this.bus?.on) {
      this._unsubs.push(
        this.bus.on(EVENTS.KART_HIT, (p) => this._onKartHit(p)),
      );
    }
  }

  // ------------------------------------------------------------- public ----

  /** Begin a fresh countdown. Safe to call again (restart). */
  start() {
    this.state = 'countdown';
    this.raceTime = 0;
    this.countdownValue = 3;
    this.countdownRemaining = RACE.COUNTDOWN_SECONDS;
    this.playerPlace = this.karts.length;
    this.playerFinished = false;
    this.results = null;
    this._cd = 0;
    this._cdEmit = 0;
    this._goHold = 0;
    this._timerAcc = 0;
    this._finishCount = 0;
    this._graceEnd = null;
    this._pendingComplete = false;
    this._bestLap = null;

    this.tracker.reset();
    this.standings.length = 0;
    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i];
      const e = this._makeEntry(kart, i + 1);
      this._entries.set(kart, e);
      this.standings.push(e);
      const u = this._projectU(kart);
      this.tracker.seed(kart, u);
      if (kart.state) {
        kart.state.finished = false;
        kart.state.wrongWay = false;
      }
      if ('finished' in kart) kart.finished = false;
      kart.lap = 1;
      this._k.set(kart, { ww: 0, wwOn: false });
    }
    this._sortStandings();
    this._emitCountdown();
  }

  /** @param {number} dt seconds */
  update(dt) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    if (this.state === 'countdown') {
      this._updateCountdown(dt);
      return;
    }
    if (this.state !== 'racing') return;

    this.raceTime += dt;
    if (this._goHold > 0) {
      this._goHold -= dt;
      if (this._goHold <= 0) this.countdownValue = null;
    }

    this._updateKarts(dt);
    this._sortStandings();
    this._emitTimer(dt);

    if (this._pendingComplete) {
      this._complete();
      return;
    }
    if (this._graceEnd !== null && this.raceTime >= this._graceEnd) this._complete();
    else if (this.raceTime > RACE_TIMEOUT) this._complete(); // safety net
  }

  /** Remove every bus subscription. */
  dispose() {
    for (const off of this._unsubs) {
      if (typeof off === 'function') off();
    }
    this._unsubs.length = 0;
    this.state = 'finished';
  }

  /** Live entry for a kart (stable object, mutated in place). */
  entryFor(kart) {
    return this._entries.get(kart) || null;
  }

  /** @returns {number} seconds behind the leader (or the winner when finished) */
  gapFor(kart) {
    const e = this._entries.get(kart);
    return e ? e.gap : 0;
  }

  // ---------------------------------------------------------- countdown ----

  /** @returns {number} integer label 3/2/1/0 */
  _countdownLabel(remaining) {
    return clamp(Math.ceil(remaining - COUNTDOWN_LABEL_OFFSET), 0, 3);
  }

  _emitCountdown() {
    this.bus?.emit?.(EVENTS.RACE_COUNTDOWN, {
      value: this.countdownValue,
      exact: this.countdownRemaining,
      total: RACE.COUNTDOWN_SECONDS,
    });
  }

  _updateCountdown(dt) {
    this._cd += dt;
    const remaining = Math.max(0, RACE.COUNTDOWN_SECONDS - this._cd);
    this.countdownRemaining = remaining;
    const label = this._countdownLabel(remaining);

    this._cdEmit += dt;
    if (label !== this.countdownValue || this._cdEmit >= COUNTDOWN_EMIT || remaining <= 0) {
      this.countdownValue = label;
      this._emitCountdown();
      this._cdEmit = 0;
    }

    if (remaining <= 0) {
      this.countdownValue = 0;
      this.countdownRemaining = 0;
      this._emitCountdown();
      this.state = 'racing';
      this._goHold = GO_LABEL_HOLD;
      this._timerAcc = TIMER_INTERVAL; // force a timer tick on the first racing frame
      this.bus?.emit?.(EVENTS.RACE_START, {});
    }
  }

  // ------------------------------------------------------------ karts ------

  _projectU(kart) {
    const api = this.trackApi;
    if (api?.project && kart?.position) {
      const p = api.project(kart.position);
      if (p && Number.isFinite(p.u)) return wrap01(p.u);
    }
    return wrap01(Number(kart?.progress) || 0);
  }

  _updateKarts(dt) {
    const api = this.trackApi;
    for (const kart of this.karts) {
      if (!kart) continue;
      const p = api?.project && kart.position ? api.project(kart.position) : null;
      const u = p && Number.isFinite(p.u) ? wrap01(p.u) : wrap01(Number(kart.progress) || 0);
      const k = this._k.get(kart) || { ww: 0, wwOn: false };
      this._k.set(kart, k);

      const ev = this.tracker.update(kart, u, this.raceTime);
      if (ev?.type === 'lap') {
        this._onLap(kart, ev);
      } else if (ev?.type === 'finish') {
        this._onLap(kart, ev);
        this._finishKart(kart, this.raceTime);
      }
      this._updateWrongWay(kart, p, dt);
    }
  }

  _onLap(kart, ev) {
    const lap = Math.min(ev.lap, this.laps);
    kart.lap = lap;
    const e = this._entries.get(kart);
    if (e) e.lap = lap;
    this.bus?.emit?.(EVENTS.RACE_LAP, {
      kart,
      lap,
      laps: this.laps,
      lapTime: ev.lapTime,
      best: this._bestLap === null || ev.lapTime < this._bestLap,
    });
    if (this._bestLap === null || ev.lapTime < this._bestLap) this._bestLap = ev.lapTime;
    if (ev.lap === this.laps) this.bus?.emit?.(EVENTS.RACE_FINAL_LAP, { kart });
  }

  _finishKart(kart, time) {
    const e = this._entries.get(kart);
    if (!e || e.finished) return;
    e.finished = true;
    e.finishTime = time;
    e.lap = this.laps;
    e.progress = Math.max(e.progress, this.laps);
    e.place = ++this._finishCount;
    if (kart.state) kart.state.finished = true;
    kart.lap = this.laps;
    kart.finishTime = time;

    // `kart.finished = true` makes the shipped Kart emit KART_FINISHED itself;
    // only emit here when nobody else did (keeps the event exactly once).
    let emittedByKart = false;
    const off = this.bus?.on ? this.bus.on(EVENTS.KART_FINISHED, (p) => {
      if (p?.kart === kart) emittedByKart = true;
    }) : null;
    kart.finished = true;
    if (typeof off === 'function') off();
    if (!emittedByKart) this.bus?.emit?.(EVENTS.KART_FINISHED, { kart, place: e.place, time });

    if (kart === this.playerKart) {
      this.playerFinished = true;
      this.playerPlace = e.place;
      this.bus?.emit?.(EVENTS.RACE_FINISH, { kart, place: e.place, time });
      if (!this._allFinished()) this._graceEnd = this.raceTime + FINISH_GRACE;
      else this._pendingComplete = true;
    } else if (this._allFinished()) {
      this._pendingComplete = true;
    }
  }

  _allFinished() {
    return this.karts.length > 0 && this.karts.every((k) => this._entries.get(k)?.finished);
  }

  _updateWrongWay(kart, p, dt) {
    const st = kart.state;
    if (!st) return;
    const k = this._k.get(kart);
    if (!k) return;

    let dot = 1;
    const f = kart.forward;
    if (p?.tangent && f) dot = (f.x || 0) * p.tangent.x + (f.z || 0) * p.tangent.z;

    if (dot < WRONG_WAY_DOT) {
      k.ww += dt;
    } else if (dot > WRONG_WAY_CLEAR_DOT) {
      k.ww = Math.max(0, k.ww - dt * WRONG_WAY_CLEAR_RATE);
    }

    const on = k.ww > WRONG_WAY_TRIGGER;
    if (on !== k.wwOn) {
      k.wwOn = on;
      st.wrongWay = on;
      this.bus?.emit?.(EVENTS.KART_WRONG_WAY, { kart, wrongWay: on });
    }
  }

  // -------------------------------------------------------- standings -----

  _makeEntry(kart, place) {
    return {
      kart,
      place: place || 1,
      lap: 1,
      progress: 0,
      finished: false,
      finishTime: /** @type {number|null} */ (null),
      gap: 0,
      projected: false,
      lapTimes: [],
      bestLap: null,
      isPlayer: !!kart?.isPlayer,
    };
  }

  _sortStandings() {
    const arr = this.standings;
    for (const s of arr) {
      const e = this.tracker.entryOf(s.kart);
      if (e) {
        s.lap = Math.min(e.lap, this.laps);
        if (!s.finished) s.progress = Math.max(s.progress, e.progress);
        s.lapTimes = e.lapTimes;
        s.distToGate = e.distToGate;
      }
    }

    arr.sort((a, b) => {
      if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (b.progress !== a.progress) return b.progress - a.progress;
      const da = a.distToGate ?? 0;
      const db = b.distToGate ?? 0;
      if (da !== db) return da - db;
      return 0;
    });

    const leader = arr[0];
    const winner = arr.find((s) => s.finished) || null;
    const leaderPace = leader
      ? clamp((Math.max(leader.progress, 0.001) * this.length) / Math.max(this.raceTime, 1), 6, 80)
      : 20;

    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      s.place = i + 1;
      if (s.finished && winner) s.gap = Math.max(0, (s.finishTime ?? 0) - (winner.finishTime ?? 0));
      else if (s === leader) s.gap = 0;
      else s.gap = clamp(((leader.progress - s.progress) * this.length) / leaderPace, 0, 999);
      if (s.bestLap === null && s.lapTimes?.length) s.bestLap = Math.min(...s.lapTimes);
    }

    const pe = this.playerKart ? this._entries.get(this.playerKart) : null;
    this.playerPlace = pe ? pe.place : this.karts.length;
  }

  // ---------------------------------------------------------- finish ------

  _buildResults() {
    const rows = [];
    for (const s of this.standings) {
      const e = this.tracker.entryOf(s.kart);
      const lapTimes = e ? e.lapTimes.slice() : [];
      const row = {
        kart: s.kart,
        place: s.place,
        lap: s.lap,
        progress: s.progress,
        finished: s.finished,
        finishTime: s.finishTime,
        gap: s.gap,
        lapTimes,
        bestLap: lapTimes.length ? Math.min(...lapTimes) : null,
        projected: false,
      };
      if (!row.finished) {
        // Project a finish time from current pace so the table is always full.
        const raw = e ? Math.max(0, e.progress) : 0;
        const remaining = Math.max(0, this.laps - raw) * this.length;
        const avgPace = (Math.max(raw, 0.001) * this.length) / Math.max(this.raceTime, 1);
        const current = Math.abs(Number(s.kart?.speed) || 0);
        const pace = clamp(Math.max(avgPace, current * 0.9), 6, 90);
        row.finishTime = this.raceTime + remaining / pace;
        row.projected = true;
        row.gap = clamp(row.finishTime - (this.standings[0]?.finishTime ?? row.finishTime), 0, 9999);
      }
      rows.push(row);
    }
    return rows;
  }

  _complete() {
    if (this.state !== 'racing') return;
    this._pendingComplete = false;
    this.state = 'finished';
    this.countdownValue = null;
    this._sortStandings();
    this.results = this._buildResults();
    this.bus?.emit?.(EVENTS.RACE_TIMER, { time: this.raceTime, final: true });
    this.bus?.emit?.(EVENTS.RACE_COMPLETE, { standings: this.results, time: this.raceTime, laps: this.laps });
  }

  // ----------------------------------------------------------- events -----

  _emitTimer(dt) {
    this._timerAcc += dt;
    if (this._timerAcc < TIMER_INTERVAL) return;
    this._timerAcc = 0;
    this.bus?.emit?.(EVENTS.RACE_TIMER, { time: this.raceTime });
  }

  _onKartHit(p) {
    if (!p || !this.playerKart || p.kart !== this.playerKart) return;
    const base = SHAKE_BY_KIND[p.kind] ?? SHAKE_BY_KIND.generic;
    const power = Number.isFinite(p.power) ? clamp(p.power, 0.4, 2) : 1;
    this.bus?.emit?.(EVENTS.CAMERA_SHAKE, { amount: base * power, duration: 0.32 });
  }
}
