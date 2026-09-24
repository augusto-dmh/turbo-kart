/**
 * ============================================================================
 * TURBO KART — chase camera rig (Agent 1)
 * ============================================================================
 * A critically-damped spring camera with:
 *  - speed-based FOV kick, distance pull-back and look-ahead
 *  - smoothed look-back (180° swing), drift lean-in, hood/far modes
 *  - ground/ceiling clamping, impact shake, snap-on-reset
 *
 * All state is preallocated: `update()` performs zero allocations.
 * ============================================================================
 */
import * as THREE from 'three';
import { clamp, damp, dampAngle, smoothDamp, wrapAngle } from './mathUtils.js';

/** Per-mode camera parameters. */
export const CAMERA_MODES = {
  chase: {
    dist: 7.3, height: 3.05, lookAhead: 7.5, lookHeight: 1.05, fov: 63, fovKick: 13,
    smoothTime: 0.15, lookSmoothTime: 0.075, yawLambda: 8.0, speedPull: 1.35,
    lateral: 0.55, driftLook: 0.16, groundClear: 0.6,
  },
  far: {
    dist: 11.4, height: 4.6, lookAhead: 8.5, lookHeight: 1.2, fov: 60, fovKick: 11,
    smoothTime: 0.2, lookSmoothTime: 0.1, yawLambda: 6.0, speedPull: 1.7,
    lateral: 0.35, driftLook: 0.12, groundClear: 0.7,
  },
  hood: {
    dist: 0.18, height: 1.34, lookAhead: 15, lookHeight: 0.55, fov: 72, fovKick: 9,
    smoothTime: 0.035, lookSmoothTime: 0.03, yawLambda: 24, speedPull: 0,
    lateral: 0, driftLook: 0.05, groundClear: 0.35,
  },
};

/** @type {keyof typeof CAMERA_MODES} */
export const DEFAULT_MODE = 'chase';

/**
 * Chase camera controller. Owned by `Engine`; not used directly by gameplay.
 */
export class CameraRig {
  /** @param {{THREE?:any, camera:any}} opts */
  constructor({ camera } = {}) {
    this.camera = camera;
    this.mode = DEFAULT_MODE;
    this.time = 0;

    this.focus = { x: 0, y: 0, z: 0 };       // smoothed kart position
    this.focusVel = { x: { v: 0 }, y: { v: 0 }, z: { v: 0 } };
    this.look = { x: 0, y: 0, z: 0 };        // smoothed look target
    this.lookVel = { x: { v: 0 }, y: { v: 0 }, z: { v: 0 } };
    this.yaw = 0;                            // smoothed camera yaw
    this.yawVel = { v: 0 };
    this.fov = CAMERA_MODES[DEFAULT_MODE].fov;
    this.lookBackBlend = 0;
    this.lateral = 0;
    this.driftBlend = 0;

    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeDur = 0;
    this._shakeRoll = 0;
    this._desiredYaw = 0;
    this._desiredFov = CAMERA_MODES[DEFAULT_MODE].fov;
    this._dx = 0; this._dy = 0; this._dz = 0;
    this._lx = 0; this._ly = 0; this._lz = 0;

    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
    this._hasState = false;
  }

  /** @param {number} amount @param {number} duration seconds */
  shake(amount, duration = 0.35) {
    this.shakeAmp = Math.max(this.shakeAmp, Math.max(0, amount));
    this.shakeDur = Math.max(0.05, duration);
    this.shakeTime = Math.max(this.shakeTime, this.shakeDur);
  }

  /** Clear shake and re-snap on the next update. */
  reset(kart = null, mode = this.mode) {
    this.mode = mode;
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeDur = 0;
    this.lookBackBlend = 0;
    this.lateral = 0;
    this.driftBlend = 0;
    this._hasState = false;
    if (kart) {
      this._computeDesired(kart, mode, 0, 0);
      this.focus.x = this._dx; this.focus.y = this._dy; this.focus.z = this._dz;
      this.look.x = this._lx; this.look.y = this._ly; this.look.z = this._lz;
      this.yaw = this._desiredYaw;
      this.fov = this._desiredFov;
      this._hasState = true;
    }
  }

  /**
   * @param {number} dt
   * @param {any} kart
   * @param {{mode?:string, lookBack?:boolean, paused?:boolean, groundY?:(x:number,z:number,y:number)=>number}} opts
   */
  update(dt, kart, opts = {}) {
    const mode = CAMERA_MODES[opts.mode] ? opts.mode : DEFAULT_MODE;
    this.mode = mode;
    if (!kart || !kart.position) return;
    this.time += dt;

    const p = CAMERA_MODES[mode];
    const state = kart.state || {};
    const speed = Math.abs(state.speed || 0);
    const top = Math.max(1, kart.topSpeed || 32);
    const speedT = clamp(speed / top, 0, 1.25);

    // Look-back + drift lean blends (smoothed so the swing is never a snap).
    this.lookBackBlend = damp(this.lookBackBlend, opts.lookBack ? 1 : 0, 9, dt);
    const drifting = state.drifting ? 1 : 0;
    this.driftBlend = damp(this.driftBlend, drifting, 6, dt);

    this._computeDesired(kart, mode, speedT, dt);

    if (!this._hasState) {
      // First frame (or after reset): snap.
      this.focus.x = this._dx; this.focus.y = this._dy; this.focus.z = this._dz;
      this.look.x = this._lx; this.look.y = this._ly; this.look.z = this._lz;
      this.yaw = this._desiredYaw;
      this.fov = this._desiredFov;
      this._hasState = true;
    } else {
      this._springVec(this.focus, this.focusVel, this._dx, this._dy, this._dz, p.smoothTime, dt);
      this._springVec(this.look, this.lookVel, this._lx, this._ly, this._lz, p.lookSmoothTime, dt);
      this.yaw = dampAngle(this.yaw, this._desiredYaw, p.yawLambda, dt);
      this.fov = damp(this.fov, this._desiredFov, 4.5, dt);
    }

    // ---- camera position ------------------------------------------------
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // Kart-relative right for a camera facing (sin yaw, 0, cos yaw).
    const rx = -cy;
    const rz = sy;

    const dist = p.dist + p.speedPull * speedT;
    const px = this.focus.x - sy * dist + rx * this.lateral;
    const py = this.focus.y + p.height;
    const pz = this.focus.z - cy * dist + rz * this.lateral;

    this.position.set(px, py, pz);
    this.target.set(this.look.x, this.look.y, this.look.z);

    // ---- shake ----------------------------------------------------------
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
      const k = this.shakeDur > 0 ? this.shakeTime / this.shakeDur : 0;
      const amp = this.shakeAmp * k * k;
      if (amp > 0.0001) {
        const t = this.time;
        const n1 = Math.sin(t * 41.7) * 0.6 + Math.sin(t * 17.3 + 1.1) * 0.4;
        const n2 = Math.sin(t * 37.1 + 2.3) * 0.5 + Math.sin(t * 23.9 + 0.4) * 0.5;
        const n3 = Math.sin(t * 29.3 + 3.1) * 0.5 + Math.sin(t * 13.1) * 0.5;
        this.position.x += rx * n1 * amp + sy * n3 * amp * 0.6;
        this.position.y += n2 * amp;
        this.position.z += rz * n1 * amp + cy * n3 * amp * 0.6;
        this.target.x += rx * n1 * amp * 0.35;
        this.target.y += n2 * amp * 0.3;
        this.target.z += rz * n1 * amp * 0.35;
        this._shakeRoll = n1 * amp * 0.06;
      } else {
        this._shakeRoll = 0;
      }
      if (this.shakeTime === 0) this.shakeAmp = 0;
    } else {
      this._shakeRoll = 0;
    }

    // ---- clamps ---------------------------------------------------------
    const groundClear = p.groundClear;
    const kartY = kart.position.y || 0;
    if (typeof opts.groundY === 'function') {
      const gy = opts.groundY(this.position.x, this.position.z, kartY);
      if (Number.isFinite(gy) && this.position.y < gy + groundClear) this.position.y = gy + groundClear;
    } else if (this.position.y < kartY + 0.25) {
      this.position.y = kartY + 0.25;
    }
    const ceiling = kartY + 22;
    if (this.position.y > ceiling) this.position.y = ceiling;

    // ---- commit ---------------------------------------------------------
    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    if (this._shakeRoll) this.camera.rotateZ(this._shakeRoll);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Compute the desired (unsmoothed) camera state into `_dx/_dy/_dz/_lx/_ly/_lz`.
   * @private
   */
  _computeDesired(kart, mode, speedT, dt) {
    const p = CAMERA_MODES[mode];
    const pos = kart.position;
    const state = kart.state || {};
    const yaw = Number.isFinite(kart.yaw) ? kart.yaw : 0;

    // Kart forward / right in the horizontal plane.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = -fz;
    const rz = fx;

    // --- focus: kart position (slightly ahead at speed) ---
    const lead = 0.5 + speedT * 0.9;
    this._dx = pos.x + fx * lead;
    this._dy = pos.y + 0.35;
    this._dz = pos.z + fz * lead;

    // --- look target ---
    const vx = kart.velocity ? kart.velocity.x : 0;
    const vz = kart.velocity ? kart.velocity.z : 0;
    const lookAhead = p.lookAhead + speedT * 3.5;
    this._lx = pos.x + fx * lookAhead + vx * 0.05;
    this._ly = pos.y + p.lookHeight + (state.airborne ? 0.5 : 0);
    this._lz = pos.z + fz * lookAhead + vz * 0.05;

    // --- yaw: kart heading + look-back swing + drift lean-in ---
    const steer = clamp(state.steerVisual || 0, -1, 1);
    const driftLook = this.driftBlend * steer * p.driftLook;
    this._desiredYaw = wrapAngle(yaw + Math.PI * this.lookBackBlend + driftLook);

    // --- lateral offset: lean into the corner so the racing line is visible ---
    const targetLateral = -steer * p.lateral * (0.6 + 0.4 * (1 - this.lookBackBlend));
    this.lateral = dt > 0 ? damp(this.lateral, targetLateral, 6, dt) : targetLateral;

    // --- fov kick ---
    const boost = state.boosting ? 1 : 0;
    this._desiredFov = p.fov + p.fovKick * clamp(speedT, 0, 1) + boost * 3.5;
  }

  _springVec(cur, vel, tx, ty, tz, smoothTime, dt) {
    cur.x = smoothDamp(cur.x, tx, vel.x, smoothTime, dt);
    cur.y = smoothDamp(cur.y, ty, vel.y, smoothTime, dt);
    cur.z = smoothDamp(cur.z, tz, vel.z, smoothTime, dt);
  }
}

export default CameraRig;
