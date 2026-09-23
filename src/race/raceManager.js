// STUB — owned by Agent 3 (AI, Race Logic & Items). Replace with the full implementation.
import { EVENTS, RACE } from '../contracts.js';

export class RaceManager {
  constructor({ bus, karts, trackApi, laps = 3, playerKart, solo = false }) {
    this.bus = bus;
    this.karts = karts;
    this.trackApi = trackApi;
    this.laps = laps;
    this.playerKart = playerKart;
    this.solo = solo;
    this.state = 'idle';
    this.raceTime = 0;
    this.countdownValue = 0;
    this.standings = karts.map((kart, i) => ({ kart, place: i + 1, lap: 1, progress: 0, finished: false, finishTime: null }));
  }

  start() {
    this.state = 'countdown';
    this.countdownValue = Math.ceil(RACE.COUNTDOWN_SECONDS);
    this.bus?.emit?.(EVENTS.RACE_COUNTDOWN, { value: this.countdownValue });
  }

  update(dt) {
    if (this.state === 'countdown') {
      const next = this.countdownValue - dt;
      const before = Math.ceil(this.countdownValue);
      this.countdownValue = Math.max(0, next);
      if (Math.ceil(next) !== before) this.bus?.emit?.(EVENTS.RACE_COUNTDOWN, { value: Math.ceil(next) });
      if (next <= 0) { this.state = 'racing'; this.bus?.emit?.(EVENTS.RACE_START, {}); }
      return;
    }
    if (this.state !== 'racing') return;
    this.raceTime += dt;
    for (const s of this.standings) {
      s.progress = (s.kart.lap - 1) + (s.kart.progress || 0);
      if (s.kart.progress < 0.5 && s.lap === 1 && s.progress > 0.9) s.kart.lap = 2;
    }
    this.standings.sort((a, b) => b.progress - a.progress);
    this.standings.forEach((s, i) => (s.place = i + 1));
  }

  dispose() {}
}
