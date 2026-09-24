/**
 * ============================================================================
 * TURBO KART — item projectiles (Agent 3)
 * ============================================================================
 * Physics + collision for bananas, green shells and red shells. Movement is
 * 2.5D: projectiles are constrained to the road (hovering just above the
 * surface), bounce off the walls described by `trackApi.project().lateral` +
 * `halfWidth`, and collide with karts and each other.
 *
 * The manager is presentation/collision only: the **effects** (spin-outs,
 * events, FX) are applied by the owner through the callbacks it is given.
 *
 * No per-frame allocations in `update`; objects are plain structs.
 * ============================================================================
 */

import { clamp, wrapAngle } from '../race/progress.js';

/** Approximate kart collision radius (m). */
export const KART_RADIUS = 1.05;
/** Projectile-vs-kart vertical tolerance (m) — ignores karts on ramps/bridges. */
const VERTICAL_TOLERANCE = 2.4;

export class ProjectileManager {
  /**
   * @param {{THREE:any, scene:any, trackApi:any,
   *          onHit?:(proj:any,kart:any)=>boolean,
   *          onWall?:(proj:any)=>void,
   *          onExpire?:(proj:any,reason:string)=>void,
   *          onPair?:(a:any,b:any)=>void}} opts
   */
  constructor({ THREE, scene, trackApi, onHit = null, onWall = null, onExpire = null, onPair = null } = {}) {
    this.THREE = THREE;
    this.scene = scene || null;
    this.trackApi = trackApi || null;
    this.onHit = onHit;
    this.onWall = onWall;
    this.onExpire = onExpire;
    this.onPair = onPair;
    /** @type {any[]} */
    this.list = [];
    this._tmp = THREE?.Vector3 ? new THREE.Vector3() : null;
  }

  /**
   * Spawn a projectile.
   * @param {{kind:string, mesh:any, x:number, y:number, z:number,
   *          vx?:number, vz?:number, speed?:number, owner?:any,
   *          target?:any, life?:number, radius?:number, hover?:number,
   *          homing?:boolean, turnRate?:number, solid?:boolean, armTime?:number}} opts
   */
  spawn(opts) {
    const speed = Number.isFinite(opts.speed) ? opts.speed : Math.hypot(opts.vx || 0, opts.vz || 0);
    const p = {
      kind: opts.kind,
      itemId: opts.itemId || opts.kind,
      mesh: opts.mesh || null,
      position: this.THREE?.Vector3 ? new this.THREE.Vector3(opts.x, opts.y, opts.z) : { x: opts.x, y: opts.y, z: opts.z },
      vx: opts.vx || 0,
      vz: opts.vz || 0,
      speed,
      owner: opts.owner || null,
      target: opts.target || null,
      life: Number.isFinite(opts.life) ? opts.life : 8,
      age: 0,
      radius: Number.isFinite(opts.radius) ? opts.radius : 0.55,
      hover: Number.isFinite(opts.hover) ? opts.hover : 0.55,
      homing: !!opts.homing,
      turnRate: Number.isFinite(opts.turnRate) ? opts.turnRate : 2.6,
      solid: opts.solid !== false,
      armTime: Number.isFinite(opts.armTime) ? opts.armTime : 0.15,
      wallHits: 0,
      missTimer: 0,
      lastDist: -1,
      dead: false,
      u: 0,
      spin: opts.kind === 'banana' ? 0.6 : 3.4,
    };
    if (p.mesh && this.scene) this.scene.add(p.mesh);
    this.list.push(p);
    return p;
  }

  /** Remove everything (dispose path). */
  clear() {
    for (const p of this.list) {
      if (p.mesh && this.scene) this.scene.remove(p.mesh);
    }
    this.list.length = 0;
  }

  /** @param {any[]} karts */
  update(dt, karts) {
    const api = this.trackApi;
    const list = this.list;
    if (!list.length) return;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.dead) continue;
      p.age += dt;

      // --- vertical: ride the road surface ---------------------------------
      if (api?.project) {
        const pr = api.project(p.position);
        if (pr && Number.isFinite(pr.u)) {
          p.u = pr.u;
          if (api.pointAt) {
            const road = api.pointAt(pr.u, 0);
            const targetY = (Number(road?.y) || 0) + p.hover;
            p.position.y += (targetY - p.position.y) * Math.min(1, dt * 9);
          }
        }
      }

      if (p.kind === 'banana') {
        if (p.mesh) p.mesh.rotation.y += dt * p.spin;
        if (p.age > p.life - 2.6 && p.mesh) {
          const k = clamp((p.life - p.age) / 2.6, 0, 1);
          p.mesh.scale.setScalar(Math.max(0.05, k));
        }
        if (p.age > p.life) {
          p.dead = true;
          this.onExpire?.(p, 'lifetime');
          continue;
        }
      } else {
        // --- red shell homing ----------------------------------------------
        if (p.homing && p.target && !p.target.state?.finished) {
          const tx = p.target.position.x - p.position.x;
          const tz = p.target.position.z - p.position.z;
          const dist = Math.hypot(tx, tz);
          const a0 = Math.atan2(p.vz, p.vx);
          const a1 = Math.atan2(tz, tx);
          const turn = clamp(wrapAngle(a1 - a0), -p.turnRate * dt, p.turnRate * dt);
          const a = a0 + turn;
          p.vx = Math.cos(a) * p.speed;
          p.vz = Math.sin(a) * p.speed;
          if (dist > p.lastDist && p.lastDist > 0) p.missTimer += dt;
          else p.missTimer = Math.max(0, p.missTimer - dt * 0.5);
          p.lastDist = dist;
          if (p.missTimer > 1.6) {
            p.dead = true;
            this.onExpire?.(p, 'miss');
            continue;
          }
        }

        // --- integrate ------------------------------------------------------
        p.position.x += p.vx * dt;
        p.position.z += p.vz * dt;

        // --- walls -----------------------------------------------------------
        if (api?.project && api.halfWidth) {
          const pr = api.project(p.position);
          if (pr && Number.isFinite(pr.lateral)) {
            const limit = api.halfWidth - p.radius - 0.05;
            if (Math.abs(pr.lateral) > limit) {
              const n = this._lateralNormal(pr.u);
              const vn = p.vx * n.x + p.vz * n.z;
              if (Math.abs(vn) > 1.2) {
                // real impact: reflect and lose a little speed
                p.vx -= 2 * vn * n.x;
                p.vz -= 2 * vn * n.z;
                p.vx *= 0.9;
                p.vz *= 0.9;
                p.wallHits++;
                this.onWall?.(p);
                if (p.kind === 'red-shell' && p.wallHits >= 2) {
                  p.dead = true;
                  this.onExpire?.(p, 'wall');
                  continue;
                }
              } else {
                // scraping: slide along the wall instead of bouncing every frame
                p.vx -= vn * n.x;
                p.vz -= vn * n.z;
              }
              p.speed = Math.hypot(p.vx, p.vz);
              const side = Math.sign(pr.lateral) || 1;
              if (api.pointAt) {
                const inside = api.pointAt(pr.u, side * limit);
                p.position.x = inside.x;
                p.position.z = inside.z;
              }
            }
          }
        }

        if (p.mesh) p.mesh.rotation.y += dt * p.spin;

        if (p.age > p.life) {
          p.dead = true;
          this.onExpire?.(p, 'lifetime');
          continue;
        }
      }

      // --- kart collisions ---------------------------------------------------
      if (karts && karts.length) {
        const armed = p.age >= p.armTime;
        for (let k = 0; k < karts.length; k++) {
          const kart = karts[k];
          if (!kart || !kart.position) continue;
          if (kart.state?.finished) continue;
          if (kart === p.owner && !armed) continue;
          const dx = kart.position.x - p.position.x;
          const dz = kart.position.z - p.position.z;
          const dy = (Number(kart.position.y) || 0) - p.position.y;
          if (Math.abs(dy) > VERTICAL_TOLERANCE) continue;
          const rr = p.radius + KART_RADIUS;
          if (dx * dx + dz * dz > rr * rr) continue;
          const consumed = this.onHit?.(p, kart);
          if (consumed !== false) {
            p.dead = true;
            break;
          }
        }
        if (p.dead) continue;
      }
    }

    // --- projectile vs projectile ------------------------------------------
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead || !a.solid) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead || !b.solid) continue;
        if (a.kind === 'banana' && b.kind === 'banana') continue;
        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        const rr = a.radius + b.radius;
        if (dx * dx + dz * dz > rr * rr) continue;
        a.dead = true;
        b.dead = true;
        this.onPair?.(a, b);
        break;
      }
    }

    // --- compact ------------------------------------------------------------
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p.dead) continue;
      if (p.mesh && this.scene) this.scene.remove(p.mesh);
      list.splice(i, 1);
    }
  }

  /** Unit vector of the +lateral direction at `u` (2 pointAt calls; rare). */
  _lateralNormal(u) {
    const api = this.trackApi;
    if (!api?.pointAt) return { x: 1, z: 0 };
    const a = api.pointAt(u, 0);
    const b = api.pointAt(u, 1);
    const dx = (b?.x || 0) - (a?.x || 0);
    const dz = (b?.z || 0) - (a?.z || 0);
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  /** Nearest projectile to a position (debug / AI helpers). */
  nearest(x, z, maxDist = Infinity) {
    let best = null;
    let bestD = maxDist * maxDist;
    for (const p of this.list) {
      const d = (p.position.x - x) ** 2 + (p.position.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  get count() {
    return this.list.length;
  }
}
