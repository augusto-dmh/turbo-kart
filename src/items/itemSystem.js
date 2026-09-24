/**
 * ============================================================================
 * TURBO KART — item system (Agent 3)
 * ============================================================================
 * Owns everything item-related:
 *
 *  - **Item boxes**: instanced, spinning, bobbing boxes at
 *    `trackApi.itemBoxRows`; respawn after `RACE.ITEM_BOX_RESPAWN`; only karts
 *    with an empty hand may pick one up (emits `ITEM_BOX`).
 *  - **Roulette**: a ~0.7 s roll (`isRolling() === true`) weighted by the
 *    kart's current place (classic rubber-band table, see `ROULETTE_TABLE`),
 *    then `ITEM_ROLL`.
 *  - **Items**: mushroom / triple-mushroom, banana, green shell, red shell,
 *    triple shells (orbiting), star and lightning.
 *  - **Projectiles** (see `projectiles.js`) with wall bounces, kart collisions,
 *    projectile-vs-projectile and graceful despawns (banana fade-out).
 *  - **Shields**: holding a banana or shell blocks an incoming shell/banana —
 *    the held item is consumed and `ITEM_BLOCKED` is emitted instead of a
 *    spin-out (short grace afterwards). The star blocks everything.
 *  - **Presentation**: procedural meshes, `FX_SPAWN`, `AUDIO_SFX`,
 *    `CAMERA_SHAKE` and the additive `item:hazards` feed consumed by the AI.
 *
 * Public API: `update(dt, { raceManager })`, `rollItem(kart)`,
 * `useItem(kart)`, `getItemFor(kart)`, `isRolling(kart)`, `dispose()`.
 * ============================================================================
 */

import { EVENTS, ITEMS, RACE, SFX } from '../contracts.js';
import { createRng } from '../ai/rng.js';
import { ItemMeshLibrary } from './itemMeshes.js';
import { ProjectileManager } from './projectiles.js';
import { ITEM_HAZARDS } from './itemEvents.js';
import { clamp, TAU, wrap01, wrapDelta } from '../race/progress.js';

/**
 * Weighted roulette table, indexed by place band:
 *   0: 1st   1: 2nd   2: 3rd-4th   3: 5th-6th   4: 7th-8th
 * Weights are relative (they sum to 100 per band). The leader gets defensive
 * items, the back of the field gets the comeback items. AI-only rolls apply a
 * small bounded nudge (`AI_ITEM_BIAS`) so expert AI use their items a little
 * better; the player's table is never modified.
 */
export const ROULETTE_TABLE = [
  { banana: 30, 'green-shell': 30, mushroom: 15, 'triple-mushroom': 10, 'red-shell': 10, 'triple-shell': 5 },
  { banana: 22, 'green-shell': 26, mushroom: 18, 'triple-mushroom': 12, 'red-shell': 14, 'triple-shell': 8 },
  { banana: 15, 'green-shell': 20, mushroom: 20, 'triple-mushroom': 14, 'red-shell': 16, 'triple-shell': 10, star: 5 },
  { banana: 8, 'green-shell': 12, mushroom: 18, 'triple-mushroom': 18, 'red-shell': 16, 'triple-shell': 18, star: 10 },
  { mushroom: 10, 'triple-mushroom': 22, 'red-shell': 12, 'triple-shell': 18, star: 20, lightning: 18 },
];

/** Small AI-only nudge on the strong items (never applied to the player). */
const AI_ITEM_BIAS = { easy: 0.85, normal: 1.0, hard: 1.08, expert: 1.15 };
const STRONG_ITEMS = new Set(['star', 'lightning', 'triple-mushroom', 'triple-shell', 'red-shell']);

const ROLL_TIME = 0.7;
const ROLL_JITTER = 0.15;
const BANANA_LIFE = 30;
const GREEN_SHELL_LIFE = 8;
const RED_SHELL_LIFE = 12;
const STAR_TIME = 8;
const STAR_CONTACT_RADIUS = 2.4;
const LIGHTNING_SQUASH = 3.2;
const LIGHTNING_SPIN = 1.0;
const BLOCK_GRACE = 0.75;
const PICKUP_RADIUS = 2.0;
const HAZARD_INTERVAL = 0.12;

export class ItemSystem {
  /**
   * @param {{bus:any, THREE:any, scene:any, karts:any[], trackApi:any,
   *          playerKart?:any, difficulty?:string}} opts
   */
  constructor({ bus, THREE, scene, karts, trackApi, playerKart = null, difficulty = 'normal' } = {}) {
    this.bus = bus || null;
    this.THREE = THREE;
    this.scene = scene || null;
    this.karts = Array.isArray(karts) ? karts.filter(Boolean) : [];
    this.trackApi = trackApi || null;
    this.playerKart = playerKart || this.karts.find((k) => k?.isPlayer) || null;
    this.difficulty = AI_ITEM_BIAS[difficulty] ? difficulty : 'normal';

    this.rng = createRng(trackApi?.id || 'track', 'items', this.difficulty);
    this.lib = new ItemMeshLibrary({ THREE, quality: 'high' });

    /** @type {Map<any, {def:any, uses:number, rolling:boolean, rollT:number, orbit:any[]|null}>} */
    this.held = new Map();
    this._prevUse = new Map();
    /** karts that cannot be hit again until this time (block grace). */
    this._grace = new Map();
    /** karts currently under star protection (own bookkeeping, kart-agnostic). */
    this._starred = new Map();

    this._t = 0;
    this._hazTimer = 0;
    this._hazList = [];

    this._yAxis = THREE?.Vector3 ? new THREE.Vector3(0, 1, 0) : { x: 0, y: 1, z: 0 };
    this._scratchM = THREE?.Matrix4 ? new THREE.Matrix4() : null;
    this._scratchQ = THREE?.Quaternion ? new THREE.Quaternion() : null;
    this._scratchP = THREE?.Vector3 ? new THREE.Vector3() : null;
    this._scratchS = THREE?.Vector3 ? new THREE.Vector3() : null;
    this._scratchV = THREE?.Vector3 ? new THREE.Vector3() : null;

    this._projectiles = new ProjectileManager({
      THREE,
      scene,
      trackApi,
      onHit: (proj, kart) => this._onProjectileHit(proj, kart),
      onWall: (proj) => this._onProjectileWall(proj),
      onExpire: (proj, reason) => this._onProjectileExpire(proj, reason),
      onPair: (a, b) => this._onProjectilesCollide(a, b),
    });

    /** @type {Array<{u:number, lateral:number, x:number, y:number, z:number, active:boolean, respawn:number, pop:number, phase:number}>} */
    this._boxes = [];
    this._boxBody = null;
    this._boxGlass = null;
    this._buildBoxes();

    this._unsubs = [];
  }

  // ------------------------------------------------------------- public ----

  /**
   * @param {number} dt
   * @param {{raceManager?:any}} [ctx]
   */
  update(dt, ctx = {}) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this._t += dt;
    if (ctx?.raceManager) this._raceManager = ctx.raceManager;

    this._updateBoxes(dt);
    this._pollInputs();
    this._pickups();
    this._updateRolls(dt);
    this._projectiles.update(dt, this.karts);
    this._updateHeldVisuals(dt);
    this._updateStarContacts();
    this._publishHazards(dt);
  }

  /**
   * Give a kart a roulette roll (called by item boxes and tests).
   * @returns {boolean} true when a roll started
   */
  rollItem(kart) {
    if (!kart) return false;
    if (this.held.has(kart)) return false;
    const place = this._placeOf(kart);
    const def = this._rollFor(place, !!kart.isPlayer);
    const triple = def.id === 'triple-mushroom' || def.id === 'triple-shell';
    const entry = {
      def,
      uses: triple ? 3 : 1,
      rolling: true,
      rollT: ROLL_TIME + this.rng.range(0, ROLL_JITTER),
      orbit: null,
    };
    this.held.set(kart, entry);
    this.bus?.emit?.(EVENTS.ITEM_BOX, { kart });
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.BOX });
    return true;
  }

  /**
   * Use the held item. Rising-edge driven (main/AI set `input.useItem`).
   * @returns {boolean} true when an item was used
   */
  useItem(kart) {
    const entry = this.held.get(kart);
    if (!entry || entry.rolling) return false;
    const st = kart?.state;
    if (st?.spinning || st?.frozen || st?.finished) return false;

    const def = entry.def;
    this._apply(kart, entry, def);

    entry.uses -= 1;
    if (entry.uses <= 0) {
      this._clearOrbit(entry);
      this.held.delete(kart);
    } else if (entry.orbit) {
      this._trimOrbit(entry);
    }

    this.bus?.emit?.(EVENTS.ITEM_USE, { kart, item: def, itemId: def.id });
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.ITEM_USE, opts: { itemId: def.id } });
    return true;
  }

  /** @returns {any|null} the `ITEMS[id]` entry the kart holds, or null */
  getItemFor(kart) {
    const entry = this.held.get(kart);
    if (!entry || entry.rolling) return null;
    return entry.def || null;
  }

  /** @returns {boolean} true while the roulette animation is running */
  isRolling(kart) {
    const entry = this.held.get(kart);
    return !!(entry && entry.rolling);
  }

  /** Number of charges left for triple items (1 otherwise). */
  chargesFor(kart) {
    const entry = this.held.get(kart);
    return entry ? entry.uses : 0;
  }

  dispose() {
    for (const off of this._unsubs) if (typeof off === 'function') off();
    this._unsubs.length = 0;
    for (const entry of this.held.values()) {
      for (const m of entry.orbit || []) this.scene?.remove?.(m);
      entry.orbit = null;
    }
    this.held.clear();
    this._prevUse.clear();
    this._grace.clear();
    this._starred.clear();
    this._projectiles.clear();
    if (this.scene) {
      if (this._boxBody) this.scene.remove(this._boxBody);
      if (this._boxGlass) this.scene.remove(this._boxGlass);
    }
    this._boxBody?.dispose?.();
    this._boxGlass?.dispose?.();
    this._boxBody = null;
    this._boxGlass = null;
    this._boxes.length = 0;
    this.lib?.dispose?.();
  }

  // -------------------------------------------------------- item boxes ----

  _buildBoxes() {
    const THREE = this.THREE;
    const api = this.trackApi;
    const halfWidth = Number(api?.halfWidth) || 8;
    let rows = Array.isArray(api?.itemBoxRows) ? api.itemBoxRows : [];
    if (!rows.length) {
      // graceful default so the layer still works on a minimal track API
      rows = [
        { u: 0.14, lateral: [-halfWidth * 0.45, 0, halfWidth * 0.45] },
        { u: 0.58, lateral: [-halfWidth * 0.45, 0, halfWidth * 0.45] },
      ];
    }
    for (const row of rows) {
      if (!row) continue;
      const u = wrap01(Number(row.u) || 0);
      const laterals = Array.isArray(row.lateral) && row.lateral.length ? row.lateral : [0];
      for (const lat of laterals) {
        const l = Number(lat) || 0;
        const p = api?.pointAt ? api.pointAt(u, l) : { x: 0, y: 0, z: 0 };
        this._boxes.push({
          u,
          lateral: l,
          x: Number(p?.x) || 0,
          y: (Number(p?.y) || 0) + 0.95,
          z: Number(p?.z) || 0,
          active: true,
          respawn: 0,
          pop: 1,
          phase: this.rng.range(0, TAU),
        });
      }
      if (this._boxes.length >= 60) break;
    }
    if (!this._boxes.length || !THREE || !this.scene) return;

    this._boxBody = new THREE.InstancedMesh(this.lib.boxGeo, this.lib.boxMat, this._boxes.length);
    this._boxGlass = new THREE.InstancedMesh(this.lib.glassGeo, this.lib.glassMat, this._boxes.length);
    for (const mesh of [this._boxBody, this._boxGlass]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.scene.add(mesh);
    }
    if ('renderOrder' in this._boxGlass) this._boxGlass.renderOrder = 2;
  }

  _updateBoxes(dt) {
    const boxes = this._boxes;
    const body = this._boxBody;
    if (!boxes.length || !body || !this._scratchM) return;
    const M = this._scratchM, P = this._scratchP, Q = this._scratchQ, S = this._scratchS;
    const time = this._t;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.active) {
        b.respawn -= dt;
        if (b.respawn <= 0) {
          b.active = true;
          b.pop = 0.001;
        }
      } else if (b.pop < 1) {
        b.pop = Math.min(1, b.pop + dt * 3.2);
      }
      const scale = b.active ? (b.pop >= 1 ? 1 : 0.25 + 0.75 * b.pop) : 0;
      const bob = Math.sin(time * 2.2 + b.phase) * 0.17;
      P.set(b.x, b.y + bob, b.z);
      Q.setFromAxisAngle(this._yAxis, time * 1.35 + b.phase);
      S.setScalar(scale);
      M.compose(P, Q, S);
      body.setMatrixAt(i, M);
      this._boxGlass.setMatrixAt(i, M);
    }
    body.instanceMatrix.needsUpdate = true;
    this._boxGlass.instanceMatrix.needsUpdate = true;
  }

  _pickups() {
    for (const kart of this.karts) {
      if (!kart?.position || kart.state?.finished) continue;
      if (this.held.has(kart)) continue;
      const u = this._uOf(kart);
      for (const b of this._boxes) {
        if (!b.active) continue;
        if (Math.abs(wrapDelta(b.u - u)) > 0.02) continue;
        const dx = b.x - kart.position.x;
        const dz = b.z - kart.position.z;
        const dy = b.y - (Number(kart.position.y) || 0);
        if (dx * dx + dz * dz + dy * dy > PICKUP_RADIUS * PICKUP_RADIUS) continue;
        this._takeBox(kart, b);
        break;
      }
    }
  }

  _takeBox(kart, box) {
    box.active = false;
    box.respawn = RACE.ITEM_BOX_RESPAWN;
    box.pop = 0;
    this.rollItem(kart);
  }

  // ---------------------------------------------------------- roulette ----

  _rankOf(kart) {
    const lap = Math.max(1, Number(kart?.lap) || 1);
    const progress = clamp(Number(kart?.progress) || 0, 0, 1);
    return lap - 1 + progress;
  }

  _placeOf(kart) {
    const mine = this._rankOf(kart);
    let place = 1;
    for (const other of this.karts) {
      if (other === kart) continue;
      if (this._rankOf(other) > mine + 1e-6) place++;
    }
    return place;
  }

  /** @returns {any} `ITEMS[id]` entry */
  _rollFor(place, isPlayer) {
    const band = place <= 1 ? 0 : place === 2 ? 1 : place <= 4 ? 2 : place <= 6 ? 3 : 4;
    const table = ROULETTE_TABLE[band] || ROULETTE_TABLE[0];
    const bias = AI_ITEM_BIAS[this.difficulty] || 1;
    const entries = [];
    for (const id of Object.keys(table)) {
      let w = table[id];
      if (!isPlayer && bias !== 1 && STRONG_ITEMS.has(id)) w *= bias;
      entries.push({ id, w });
    }
    const picked = this.rng.weighted(entries);
    return ITEMS[picked?.id] || ITEMS.mushroom;
  }

  _updateRolls(dt) {
    for (const [kart, entry] of this.held) {
      if (!entry.rolling) continue;
      entry.rollT -= dt;
      if (entry.rollT > 0) continue;
      entry.rolling = false;
      if (entry.def.id === 'triple-shell') this._ensureOrbit(entry);
      this.bus?.emit?.(EVENTS.ITEM_ROLL, { kart, item: entry.def, itemId: entry.def.id });
      this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.ITEM_ROLL, opts: { itemId: entry.def.id } });
    }
  }

  _pollInputs() {
    for (const kart of this.karts) {
      if (!kart) continue;
      const raw = kart.input || kart._lastInput || kart.lastInput;
      const use = !!(raw && raw.useItem);
      const prev = this._prevUse.get(kart) || false;
      this._prevUse.set(kart, use);
      if (use && !prev) this.useItem(kart);
    }
  }

  // ------------------------------------------------------------- items ----

  _apply(kart, entry, def) {
    switch (def.id) {
      case 'mushroom':
        kart.applyBoost?.(1.3, 1.7, 'mushroom');
        this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.BOOST });
        break;
      case 'triple-mushroom':
        kart.applyBoost?.(1.2, 1.4, 'mushroom');
        this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.BOOST });
        break;
      case 'banana':
        this._dropBanana(kart);
        break;
      case 'green-shell':
        this._fireShell(kart, 'green-shell');
        break;
      case 'red-shell':
        this._fireShell(kart, 'red-shell');
        break;
      case 'triple-shell':
        this._fireShell(kart, 'triple-shell');
        break;
      case 'star':
        this._activateStar(kart);
        break;
      case 'lightning':
        this._strikeLightning(kart);
        break;
      default:
        kart.applyBoost?.(1.1, 1.2, 'item');
        break;
    }
  }

  /** Drop a banana behind the kart. */
  _dropBanana(kart) {
    const fwd = kart.forward || { x: 0, y: 0, z: 1 };
    const mesh = this.lib.createBanana();
    this._projectiles.spawn({
      kind: 'banana',
      itemId: 'banana',
      mesh,
      x: kart.position.x - fwd.x * 2.3,
      y: (Number(kart.position.y) || 0) + 0.3,
      z: kart.position.z - fwd.z * 2.3,
      vx: 0,
      vz: 0,
      owner: kart,
      life: BANANA_LIFE,
      radius: 0.72,
      hover: 0.28,
      solid: true,
      armTime: 0.5,
    });
  }

  /** Fire a shell (green: straight, red: homing, triple: purple straight). */
  _fireShell(kart, itemId) {
    const isRed = itemId === 'red-shell';
    const behavior = isRed ? 'red-shell' : 'green-shell';
    const fwd = kart.forward || { x: 0, y: 0, z: 1 };
    const speed = (isRed ? 27 : 23) + Math.max(0, Number(kart.speed) || 0) * 0.35;
    const mesh = this.lib.createShell(itemId === 'triple-shell' ? 'triple-shell' : behavior);
    const proj = this._projectiles.spawn({
      kind: behavior,
      itemId,
      mesh,
      x: kart.position.x + fwd.x * 2.1,
      y: (Number(kart.position.y) || 0) + 0.75,
      z: kart.position.z + fwd.z * 2.1,
      vx: fwd.x * speed,
      vz: fwd.z * speed,
      speed,
      owner: kart,
      target: isRed ? this._nextAhead(kart) : null,
      homing: isRed,
      turnRate: 3.0,
      life: isRed ? RED_SHELL_LIFE : GREEN_SHELL_LIFE,
      radius: 0.55,
      hover: 0.55,
      solid: true,
      armTime: isRed ? 0.06 : 0.12,
    });
    this._fx('shell-trail', proj.position, { color: isRed ? 0xff5b4a : 0x3ddc74, itemId });
  }

  /** Nearest kart ahead in track order (used by red shells). */
  _nextAhead(kart) {
    const mine = this._rankOf(kart);
    let best = null;
    let bestD = 0.4;
    for (const other of this.karts) {
      if (other === kart || !other || other.state?.finished) continue;
      const d = wrapDelta(this._rankOf(other) - mine);
      if (d > 0 && d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  _activateStar(kart) {
    kart.setInvincible?.(STAR_TIME);
    kart.applyBoost?.(1.0, STAR_TIME, 'star');
    this._starred.set(kart, this._t + STAR_TIME);
    this._fx('star-aura', kart.position, { duration: STAR_TIME, kart });
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.BOOST, opts: { itemId: 'star' } });
  }

  _strikeLightning(kart) {
    const def = ITEMS.lightning;
    let playerHit = false;
    for (const other of this.karts) {
      if (!other || other === kart || other.state?.finished) continue;
      if (other.state?.invincible) continue; // the star shrugs it off
      other.spinOut?.(LIGHTNING_SPIN);
      other.squash?.(LIGHTNING_SQUASH);
      this.bus?.emit?.(EVENTS.ITEM_HIT, { kart: other, item: def, itemId: def.id, from: kart });
      if (other === this.playerKart) playerHit = true;
    }
    this._fx('lightning', kart.position, { radius: 300 });
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.THUNDER });
    this.bus?.emit?.(EVENTS.CAMERA_SHAKE, { amount: playerHit ? 0.9 : 0.45, duration: 0.55 });
  }

  // -------------------------------------------------------- projectiles ---

  _onProjectileHit(proj, kart) {
    const def = ITEMS[proj.itemId] || ITEMS[proj.kind] || ITEMS['green-shell'];
    const result = this._hitKart(kart, def, proj.owner, proj.position);
    if (result === 'ignored') return false; // grace period: let it fly on
    return true; // shells and bananas are consumed on impact
  }

  /**
   * Apply an item hit to a kart with shielding rules.
   * @returns {'hit'|'blocked'|'invincible'|'ignored'}
   */
  _hitKart(kart, def, from, position) {
    if (!kart || kart.state?.finished) return 'ignored';
    const now = this._t;
    if ((this._grace.get(kart) || -1) > now) return 'ignored';

    if (kart.state?.invincible || (this._starred.get(kart) || 0) > now) {
      this._fx('explosion', position || kart.position, { scale: 0.6, blocked: true });
      return 'invincible';
    }

    // Shield: consume a held banana/shell instead of spinning out.
    const entry = this.held.get(kart);
    if (entry && !entry.rolling) {
      const id = entry.def.id;
      if (id === 'banana' || id === 'green-shell' || id === 'red-shell' || id === 'triple-shell') {
        entry.uses -= 1;
        if (entry.uses <= 0) {
          this._clearOrbit(entry);
          this.held.delete(kart);
        } else if (entry.orbit) {
          this._trimOrbit(entry);
        }
        this._grace.set(kart, now + BLOCK_GRACE);
        this.bus?.emit?.(EVENTS.ITEM_BLOCKED, { kart, item: entry.def, itemId: id, blocked: def, blockedId: def?.id, from });
        this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.SHIELD_BLOCK });
        this._fx('explosion', position || kart.position, { scale: 0.5, blocked: true });
        return 'blocked';
      }
    }

    kart.spinOut?.(1.35);
    this.bus?.emit?.(EVENTS.ITEM_HIT, { kart, item: def, itemId: def?.id, from, power: 1 });
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.ITEM_HIT, opts: { itemId: def?.id } });
    this._fx('explosion', position || kart.position, { scale: 0.85, itemId: def?.id });
    if (kart === this.playerKart) {
      this.bus?.emit?.(EVENTS.CAMERA_SHAKE, { amount: 0.55, duration: 0.34 });
    }
    return 'hit';
  }

  _onProjectileWall(proj) {
    if (proj.kind === 'red-shell' || proj.wallHits > 1) {
      this._fx('explosion', proj.position, { scale: 0.6 });
    }
  }

  _onProjectileExpire(proj, reason) {
    const def = ITEMS[proj.itemId] || ITEMS[proj.kind] || null;
    if (reason === 'miss' || reason === 'wall') this._fx('explosion', proj.position, { scale: 0.75 });
    this.bus?.emit?.(EVENTS.ITEM_EXPIRE, {
      kart: proj.owner,
      item: def,
      itemId: def?.id || proj.kind,
      reason,
      position: proj.position,
    });
  }

  _onProjectilesCollide(a, b) {
    this._fx('explosion', a.position, { scale: 0.7 });
    this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.HIT });
  }

  // ------------------------------------------------------ star contacts ---

  _updateStarContacts() {
    const now = this._t;
    if (!this._starred.size) return;
    for (const [kart, until] of this._starred) {
      if (until <= now) {
        this._starred.delete(kart);
        continue;
      }
      const kp = kart?.position;
      if (!kp) continue;
      for (const other of this.karts) {
        if (!other || other === kart || !other.position || other.state?.finished) continue;
        if ((this._grace.get(other) || -1) > now) continue;
        const dx = other.position.x - kp.x;
        const dz = other.position.z - kp.z;
        const dy = (Number(other.position.y) || 0) - (Number(kp.y) || 0);
        if (Math.abs(dy) > 2.5) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > STAR_CONTACT_RADIUS * STAR_CONTACT_RADIUS) continue;
        if (other.state?.invincible) continue;
        this._grace.set(other, now + 0.9);
        const len = Math.sqrt(d2) || 1;
        const v = this._scratchV || { set: () => {} };
        v.set?.((dx / len) * 8, 0, (dz / len) * 8);
        other.applyImpulse?.(v, 0.6);
        other.spinOut?.(1.1);
        this.bus?.emit?.(EVENTS.ITEM_HIT, { kart: other, item: ITEMS.star, itemId: 'star', from: kart });
        this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: SFX.ITEM_HIT });
        this._fx('explosion', other.position, { scale: 0.7 });
      }
    }
  }

  // ------------------------------------------------------------- visuals --

  _ensureOrbit(entry) {
    if (!this.scene || !this.lib) return;
    if (!entry.orbit) entry.orbit = [];
    while (entry.orbit.length < entry.uses) {
      const m = this.lib.createShell('triple-shell');
      m.scale.setScalar(0.55);
      this.scene.add(m);
      entry.orbit.push(m);
    }
  }

  _trimOrbit(entry) {
    if (!entry.orbit || !entry.orbit.length) return;
    const m = entry.orbit.pop();
    this.scene?.remove?.(m);
  }

  _clearOrbit(entry) {
    if (!entry.orbit) return;
    for (const m of entry.orbit) this.scene?.remove?.(m);
    entry.orbit = null;
  }

  _updateHeldVisuals() {
    if (!this.held.size) return;
    for (const [kart, entry] of this.held) {
      if (!entry.orbit || !entry.orbit.length || !kart?.position) continue;
      const pos = kart.position;
      const n = entry.orbit.length;
      for (let i = 0; i < n; i++) {
        const a = this._t * 2.1 + (i / Math.max(1, n)) * TAU;
        const m = entry.orbit[i];
        m.position.set(
          pos.x + Math.cos(a) * 1.65,
          (Number(pos.y) || 0) + 1.15 + Math.sin(this._t * 3 + i * 1.3) * 0.12,
          pos.z + Math.sin(a) * 1.65,
        );
        m.rotation.y = this._t * 4 + i;
      }
    }
  }

  // --------------------------------------------------------------- misc ---

  _uOf(kart) {
    const api = this.trackApi;
    if (api?.project && kart?.position) {
      const p = api.project(kart.position);
      if (p && Number.isFinite(p.u)) return wrap01(p.u);
    }
    return wrap01(Number(kart?.progress) || 0);
  }

  _fx(kind, position, opts) {
    this.bus?.emit?.(EVENTS.FX_SPAWN, { kind, position, opts: opts || {} });
  }

  /** Publish dynamic hazards so the AI can steer around them (~8 Hz). */
  _publishHazards(dt) {
    this._hazTimer -= dt;
    if (this._hazTimer > 0) return;
    this._hazTimer = HAZARD_INTERVAL;
    const list = this._hazList;
    list.length = 0;
    const projectiles = this._projectiles.list;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (p.age < 0.35) continue;
      list.push({
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        radius: p.radius + 0.6,
        kind: p.kind,
        from: p.owner,
      });
    }
    this.bus?.emit?.(ITEM_HAZARDS, { hazards: list });
  }

  // ---------------------------------------------------------- debug API ---

  get debugInfo() {
    return {
      boxes: this._boxes.length,
      activeBoxes: this._boxes.filter((b) => b.active).length,
      projectiles: this._projectiles.count,
      held: [...this.held.entries()].map(([k, v]) => ({ kart: k?.name || k?.characterId, item: v.def.id, uses: v.uses, rolling: v.rolling })),
      starred: this._starred.size,
    };
  }
}
