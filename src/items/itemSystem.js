// STUB — owned by Agent 3 (AI, Race Logic & Items). Replace with the full implementation.
import { EVENTS, ITEMS } from '../contracts.js';

const POOL = Object.keys(ITEMS);

export class ItemSystem {
  constructor({ bus, THREE, scene, karts, trackApi, playerKart }) {
    this.bus = bus;
    this.THREE = THREE;
    this.scene = scene;
    this.karts = karts;
    this.trackApi = trackApi;
    this.playerKart = playerKart;
    this.held = new Map();
    this._prevUse = new Map();
  }

  getItemFor(kart) { return this.held.get(kart) || null; }
  isRolling() { return false; }

  update() {
    for (const kart of this.karts) {
      const use = !!kart.input?.useItem;
      if (use && !this._prevUse.get(kart)) this.useItem(kart);
      this._prevUse.set(kart, use);
      const p = this.trackApi.project(kart.position);
      for (const row of this.trackApi.itemBoxRows || []) {
        const du = Math.abs(((p.u - row.u + 1.5) % 1) - 0.5);
        if (du < 0.004 && !this.held.get(kart)) this.rollItem(kart);
      }
    }
  }

  rollItem(kart) {
    const item = ITEMS[POOL[Math.floor(Math.random() * POOL.length)]];
    this.held.set(kart, item);
    this.bus?.emit?.(EVENTS.ITEM_ROLL, { kart, item });
  }

  useItem(kart) {
    const item = this.held.get(kart);
    if (!item) return;
    this.held.delete(kart);
    this.bus?.emit?.(EVENTS.ITEM_USE, { kart, item });
  }

  dispose() {}
}
