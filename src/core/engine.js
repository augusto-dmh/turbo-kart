// STUB — owned by Agent 1 (Engine & Kart). Replace with the full implementation.
// Keeps the scaffold runnable so integration can be verified at any time.
import * as THREE from 'three';

export class Engine {
  constructor({ canvas, quality = 'high' } = {}) {
    this.THREE = THREE;
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8ec5ff);
    this.scene.fog = new THREE.Fog(0x8ec5ff, 200, 900);
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 3000);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d0, 2.0);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    this._camTarget = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setQuality(q) { this.quality = q; }

  updateCamera(dt, kart, { mode = 'chase', lookBack = false } = {}) {
    if (!kart) return;
    const fwd = kart.forward || new THREE.Vector3(0, 0, 1);
    const dir = fwd.clone().multiplyScalar(lookBack ? -1 : 1);
    const dist = mode === 'far' ? 12 : 8;
    const height = mode === 'hood' ? 1.6 : 3.6;
    this._camPos.copy(kart.position).addScaledVector(dir, -dist).add(new THREE.Vector3(0, height, 0));
    this.camera.position.lerp(this._camPos, 1 - Math.pow(0.001, dt));
    this._camTarget.copy(kart.position).addScaledVector(dir, 6);
    this.camera.lookAt(this._camTarget);
  }

  updateMenuCamera(dt) {
    const t = performance.now() * 0.0001;
    this.camera.position.set(Math.cos(t) * 30, 12, Math.sin(t) * 30);
    this.camera.lookAt(0, 0, 0);
  }

  render(postfx) {
    if (postfx && typeof postfx.render === 'function') postfx.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
