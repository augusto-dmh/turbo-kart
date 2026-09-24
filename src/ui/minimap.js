/**
 * Turbo Kart — canvas 2D minimap.
 * Owned by Agent 4 (UI). Consumes the frozen `TrackApi.minimap` surface only;
 * never imports `src/track/*`.
 *
 * Design notes:
 *  - The map rotates around the *track centre* so the whole course always fits
 *    (like a broadcast minimap); the player arrow always points up while the
 *    map spins, and follows its heading in north-up mode.
 *  - Every allocation happens in `setTrack()`; `draw()` reuses scratch arrays
 *    and only projects points (no per-frame object creation).
 */

import { characterOf, hexColor, clamp } from './components.js';

const TAU = Math.PI * 2;

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ size?: number }} [opts] logical (CSS) size in px
   */
  constructor(canvas, { size = 152 } = {}) {
    this.canvas = canvas || null;
    this.ctx = canvas?.getContext?.('2d', { alpha: true }) || null;
    this.size = size;
    this.quality = 'high';

    /** Rotate the map so the player heading points up (Mario-Kart style). */
    this.northUp = false;
    this.showItemBoxes = true;

    // --- cached track data -------------------------------------------------
    this.trackApi = null;
    this._pts = null;        // Float32Array [x, -z, ...] map space
    this._scr = null;        // Float32Array projected screen coords
    this._n = 0;
    this._boxes = null;      // Float32Array of item box positions (map space)
    this._start = null;      // { ax, az, bx, bz } map space
    this._mx = 0;
    this._mz = 0;
    this._sx = 1;
    this._sz = 1;
    this._fit = null;
    this._half = size / 2;

    this._colors = new Map();
    this._frame = 0;
    this._yaw = 0;
    this._dpr = 1;
    this._bgGrad = null;
    this._time = 0;
    this._out = { x: 0, y: 0 };

    this.resize();
  }

  /** Fit the backing store to the device pixel ratio. */
  resize() {
    if (!this.canvas) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const css = this.canvas.clientWidth || this.size;
    const px = Math.round(css * dpr);
    if (this.canvas.width !== px || this.canvas.height !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this._dpr = dpr;
    this._half = css / 2;
    this._bgGrad = null;
    this._updateScale();
  }

  /** Fit the track into the circle (slightly non-uniform, like a real map). */
  _updateScale() {
    const fit = this._fit;
    if (!fit) return;
    const r = this._half * 0.82;
    this._sx = r / Math.max(1, fit.w * 0.5);
    this._sz = r / Math.max(1, fit.h * 0.5);
  }

  setQuality(q) {
    this.quality = q || 'high';
  }

  setNorthUp(on) {
    this.northUp = !!on;
    return this.northUp;
  }

  toggleNorthUp() {
    return this.setNorthUp(!this.northUp);
  }

  /**
   * Build the cached geometry for a track.
   * @param {any} trackApi
   */
  setTrack(trackApi) {
    this.trackApi = trackApi || null;
    this._pts = null;
    this._scr = null;
    this._n = 0;
    this._boxes = null;
    this._start = null;
    this._fit = null;

    if (!trackApi) return;

    const mm = trackApi.minimap || {};
    const outline = Array.isArray(mm.outline) ? mm.outline : null;

    if (outline && outline.length > 2) {
      const n = outline.length;
      const pts = new Float32Array(n * 2);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = outline[i] || {};
        const x = Number.isFinite(p.x) ? p.x : 0;
        const z = Number.isFinite(p.z) ? p.z : 0;
        pts[i * 2] = x;
        pts[i * 2 + 1] = -z; // map space: screen-up = world +Z
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      this._pts = pts;
      this._scr = new Float32Array(n * 2);
      this._n = n;

      const b = trackApi.bounds;
      if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX)) {
        minX = b.minX; maxX = b.maxX; minZ = b.minZ; maxZ = b.maxZ;
      }

      this._mx = (minX + maxX) / 2;
      this._mz = -(minZ + maxZ) / 2;
      this._fit = { w: Math.max(1, maxX - minX), h: Math.max(1, maxZ - minZ) };
      this._updateScale();

      // Start/finish tick -------------------------------------------------
      if (typeof mm.sample === 'function') {
        try {
          const u0 = Number.isFinite(trackApi.startU) ? trackApi.startU : 0;
          const a = mm.sample((u0 + 0.985) % 1);
          const c = mm.sample((u0 + 0.015) % 1);
          if (a && c) this._start = { ax: a.x, az: -a.z, bx: c.x, bz: -c.z };
        } catch { /* preview-less tracks are fine */ }
      }
    }

    // Item box positions ---------------------------------------------------
    const rows = Array.isArray(trackApi.itemBoxRows) ? trackApi.itemBoxRows : null;
    if (rows && rows.length && typeof trackApi.pointAt === 'function') {
      const list = [];
      for (const row of rows) {
        const laterals = Array.isArray(row?.lateral) ? row.lateral : [0];
        for (const lat of laterals) {
          try {
            const p = trackApi.pointAt(row.u, lat);
            if (p && Number.isFinite(p.x)) list.push(p.x, -p.z);
          } catch { /* ignore */ }
        }
      }
      if (list.length) this._boxes = Float32Array.from(list);
    }
  }

  /** Cache character colors as CSS strings. */
  _colorFor(kart) {
    const id = kart?.characterId || 'unknown';
    let c = this._colors.get(id);
    if (!c) {
      const ch = characterOf(kart);
      c = hexColor(ch?.color, '#dfe7ff');
      this._colors.set(id, c);
    }
    return c;
  }

  /**
   * Project map-space (x, -z) into canvas pixels (writes into `_out`).
   * @private
   */
  _project(x, z, cos, sin, half) {
    const dx = (x - this._mx) * this._sx;
    const dy = (-z - this._mz) * this._sz;
    const o = this._out;
    o.x = half + dx * cos - dy * sin;
    o.y = half + dx * sin + dy * cos;
    return o;
  }

  /**
   * Draw one frame.
   * @param {any[]} karts
   * @param {any} player
   * @param {number} dt
   */
  draw(karts, player, dt = 0.016) {
    const ctx = this.ctx;
    if (!ctx) return;
    this._frame++;
    this._time += dt;

    // Low quality: refresh at half rate (the minimap barely moves).
    if (this.quality === 'low' && this._frame % 2 === 1) return;

    const half = this._half;
    const size = half * 2;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Circular backdrop ----------------------------------------------------
    if (!this._bgGrad) {
      const g = ctx.createRadialGradient(half, half * 0.7, half * 0.15, half, half, half);
      g.addColorStop(0, 'rgba(38, 30, 74, 0.92)');
      g.addColorStop(1, 'rgba(8, 10, 24, 0.95)');
      this._bgGrad = g;
    }
    ctx.beginPath();
    ctx.arc(half, half, half - 1.5, 0, TAU);
    ctx.fillStyle = this._bgGrad;
    ctx.fill();

    ctx.save();
    ctx.clip();

    if (!this._pts || !this._n) {
      // Placeholder before a track is loaded.
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(half, half, half * 0.55, 0, TAU);
      ctx.stroke();
      ctx.restore();
      this._drawRing(ctx, half);
      return;
    }

    const yaw = Number.isFinite(player?.yaw) ? player.yaw : this._yaw;
    this._yaw = yaw;
    const rot = this.northUp ? 0 : -yaw;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    // Track outline (rotates around the track centre) -----------------------
    const pts = this._pts;
    const scr = this._scr;
    const n = this._n;
    for (let i = 0; i < n; i++) {
      const p = this._project(pts[i * 2], -pts[i * 2 + 1], cos, sin, half);
      scr[i * 2] = p.x;
      scr[i * 2 + 1] = p.y;
    }

    ctx.beginPath();
    ctx.moveTo(scr[0], scr[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(scr[i * 2], scr[i * 2 + 1]);
    ctx.closePath();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(6, 8, 18, 0.9)';
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.65)';
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.setLineDash([5, 7]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Start / finish tick ---------------------------------------------------
    const sl = this._start;
    if (sl) {
      const a = this._project(sl.ax, -sl.az, cos, sin, half);
      const ax = a.x;
      const ay = a.y;
      const b = this._project(sl.bx, -sl.bz, cos, sin, half);
      let dx = b.x - ax;
      let dy = b.y - ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 212, 0, 0.95)';
      ctx.beginPath();
      ctx.moveTo(ax - dx * 6, ay - dy * 6);
      ctx.lineTo(ax + dx * 6, ay + dy * 6);
      ctx.stroke();
    }

    // Item boxes ------------------------------------------------------------
    if (this.showItemBoxes && this._boxes) {
      const boxes = this._boxes;
      ctx.fillStyle = 'rgba(255, 176, 32, 0.8)';
      for (let i = 0; i < boxes.length; i += 2) {
        const p = this._project(boxes[i], -boxes[i + 1], cos, sin, half);
        const dx = p.x - half;
        const dy = p.y - half;
        if (dx * dx + dy * dy > (half - 4) * (half - 4)) continue;
        ctx.fillRect(p.x - 1.7, p.y - 1.7, 3.4, 3.4);
      }
    }

    // Karts -----------------------------------------------------------------
    const list = Array.isArray(karts) ? karts : [];
    for (let i = 0; i < list.length; i++) {
      const kart = list[i];
      const pos = kart?.position;
      if (!pos || !Number.isFinite(pos.x)) continue;
      if (kart.isPlayer || kart === player) continue; // drawn on top below
      const p = this._project(pos.x, pos.z, cos, sin, half);
      const dx = p.x - half;
      const dy = p.y - half;
      if (dx * dx + dy * dy > (half - 3) * (half - 3)) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.6, 0, TAU);
      ctx.fillStyle = this._colorFor(kart);
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.stroke();
    }

    // Player arrow ----------------------------------------------------------
    const me = player || (Array.isArray(karts) ? karts.find((k) => k?.isPlayer) : null);
    if (me?.position && Number.isFinite(me.position.x)) {
      const p = this._project(me.position.x, me.position.z, cos, sin, half);
      const angle = rot + yaw;
      const color = this._colorFor(me);
      const pulse = 1 + Math.sin(this._time * 6) * 0.06;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.scale(pulse, pulse);
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5.6, 6.4);
      ctx.lineTo(0, 3.6);
      ctx.lineTo(-5.6, 6.4);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // North indicator -------------------------------------------------------
    if (this.northUp) {
      ctx.save();
      ctx.translate(half, 12);
      ctx.fillStyle = 'rgba(0, 229, 255, 0.9)';
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    this._drawRing(ctx, half);
  }

  _drawRing(ctx, half) {
    ctx.beginPath();
    ctx.arc(half, half, half - 1.5, 0, TAU);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.stroke();
  }

  dispose() {
    this.trackApi = null;
    this._pts = null;
    this._scr = null;
    this._n = 0;
    this._boxes = null;
    this._start = null;
    this._colors.clear();
    this.canvas = null;
    this.ctx = null;
  }
}
