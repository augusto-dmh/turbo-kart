/**
 * ============================================================================
 * TURBO KART — procedural item meshes (Agent 3)
 * ============================================================================
 * All geometry/material/texture creation for the item layer lives here so the
 * system can share and dispose everything in one place.
 *
 * Style rules: readable at a glance from a chase camera at 30 m/s — bright
 * saturated colours, strong emissive, chunky silhouettes, no textures except
 * the single canvas "?" for item boxes. Geometry is low-poly and shared;
 * `clone()` of the returned groups shares geometry and material.
 * ============================================================================
 */

const TAU = Math.PI * 2;

export class ItemMeshLibrary {
  /**
   * @param {{THREE:any, quality?:string}} opts
   */
  constructor({ THREE, quality = 'high' } = {}) {
    this.THREE = THREE;
    this.quality = quality;
    this.low = quality === 'low';
    this._geo = [];
    this._mat = [];
    this._tex = [];

    const seg = this.low ? 8 : 14;
    const seg2 = this.low ? 6 : 10;

    // ------------------------------------------------------------ shell ----
    this.shellBody = this._geo_(new THREE.SphereGeometry(0.44, seg, seg2));
    this.shellBody.scale(1, 0.82, 1);
    this.shellRim = this._geo_(new THREE.TorusGeometry(0.4, 0.075, this.low ? 4 : 6, seg));
    this.shellRim.rotateX(Math.PI / 2);
    this.shellFoot = this._geo_(new THREE.CylinderGeometry(0.22, 0.26, 0.14, seg2));
    this.shellMats = {
      'green-shell': this._mat_(new THREE.MeshStandardMaterial({ color: 0x2ecc71, emissive: 0x0b7a3a, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.1 })),
      'red-shell': this._mat_(new THREE.MeshStandardMaterial({ color: 0xff5b4a, emissive: 0x8c1206, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.1 })),
      'triple-shell': this._mat_(new THREE.MeshStandardMaterial({ color: 0xb06bff, emissive: 0x4b1e94, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.1 })),
    };
    this.shellRimMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x777777, emissiveIntensity: 0.35, roughness: 0.35 }));
    this.shellFootMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.8 }));

    // ----------------------------------------------------------- banana ----
    this.bananaGeo = this._geo_(new THREE.TorusGeometry(0.3, 0.115, this.low ? 4 : 6, this.low ? 8 : 14, Math.PI * 0.95));
    this.bananaGeo.rotateX(-Math.PI / 2);
    this.bananaMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0xffdf3b, emissive: 0x8a6a00, emissiveIntensity: 0.55, roughness: 0.35 }));
    this.bananaTipGeo = this._geo_(new THREE.SphereGeometry(0.075, 6, 5));
    this.bananaTipMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0x4a3a12, roughness: 0.7 }));

    // --------------------------------------------------------- mushroom ----
    this.mushCapGeo = this._geo_(new THREE.SphereGeometry(0.42, seg, seg2, 0, TAU, 0, Math.PI / 2));
    this.mushStemGeo = this._geo_(new THREE.CylinderGeometry(0.155, 0.2, 0.36, seg2));
    this.mushSpotGeo = this._geo_(new THREE.SphereGeometry(0.085, 6, 5));
    this.mushCapMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0x7a0d0d, emissiveIntensity: 0.5, roughness: 0.35 }));
    this.mushStemMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0xfff3dc, roughness: 0.5 }));
    this.mushSpotMat = this._mat_(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x999999, emissiveIntensity: 0.3 }));

    // ------------------------------------------------------------- star ----
    this.starGeo = this._geo_(this._makeStarGeometry(THREE, 0.5, 0.21, 0.17));
    this.starGeo.center();
    this.starMat = this._mat_(new THREE.MeshStandardMaterial({
      color: 0xffe14d, emissive: 0xffc400, emissiveIntensity: 0.95, roughness: 0.25, metalness: 0.15,
    }));

    // ------------------------------------------------------------- box -----
    this.boxGeo = this._geo_(new THREE.BoxGeometry(1.2, 1.2, 1.2));
    this.boxTex = this._makeBoxTexture(THREE);
    this.boxMat = this._mat_(new THREE.MeshStandardMaterial({
      map: this.boxTex || null,
      color: this.boxTex ? 0xffffff : 0x59d9ff,
      emissive: 0xffffff,
      emissiveIntensity: 0.35,
      emissiveMap: this.boxTex || null,
      roughness: 0.35,
      metalness: 0.1,
    }));
    this.glassGeo = this._geo_(new THREE.BoxGeometry(1.42, 1.42, 1.42));
    this.glassMat = this._mat_(new THREE.MeshStandardMaterial({
      color: 0xa9e8ff, transparent: true, opacity: 0.22, roughness: 0.15, metalness: 0.0,
    }));
  }

  _geo_(g) {
    this._geo.push(g);
    return g;
  }

  _mat_(m) {
    this._mat.push(m);
    return m;
  }

  // ------------------------------------------------------------- makers ---

  /**
   * A shell: body + rim + foot. `kind` selects the material.
   * @returns {any} THREE.Group (shared geo/mat — just `clone()` to instance)
   */
  createShell(kind = 'green-shell') {
    const THREE = this.THREE;
    const g = new THREE.Group();
    const mat = this.shellMats[kind] || this.shellMats['green-shell'];
    const body = new THREE.Mesh(this.shellBody, mat);
    body.position.y = 0.42;
    const rim = new THREE.Mesh(this.shellRim, this.shellRimMat);
    rim.position.y = 0.42;
    const foot = new THREE.Mesh(this.shellFoot, this.shellFootMat);
    foot.position.y = 0.24;
    g.add(body, rim, foot);
    g.userData.spin = 3.2;
    return g;
  }

  createBanana() {
    const THREE = this.THREE;
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.bananaGeo, this.bananaMat);
    body.position.y = 0.28;
    body.rotation.y = 0.4;
    const tipA = new THREE.Mesh(this.bananaTipGeo, this.bananaTipMat);
    const tipB = new THREE.Mesh(this.bananaTipGeo, this.bananaTipMat);
    const a0 = 0.02, a1 = Math.PI * 0.95 - 0.02;
    tipA.position.set(Math.cos(a0) * 0.3, 0.28, -Math.sin(a0) * 0.3);
    tipB.position.set(Math.cos(a1) * 0.3, 0.28, -Math.sin(a1) * 0.3);
    g.add(body, tipA, tipB);
    return g;
  }

  createMushroom() {
    const THREE = this.THREE;
    const g = new THREE.Group();
    const cap = new THREE.Mesh(this.mushCapGeo, this.mushCapMat);
    cap.position.y = 0.42;
    const stem = new THREE.Mesh(this.mushStemGeo, this.mushStemMat);
    stem.position.y = 0.2;
    g.add(cap, stem);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.6;
      const spot = new THREE.Mesh(this.mushSpotGeo, this.mushSpotMat);
      spot.position.set(Math.cos(a) * 0.2, 0.55, Math.sin(a) * 0.2);
      g.add(spot);
    }
    return g;
  }

  createStar() {
    const THREE = this.THREE;
    const g = new THREE.Group();
    const m = new THREE.Mesh(this.starGeo, this.starMat);
    m.position.y = 0.5;
    g.add(m);
    g.userData.spin = 2.4;
    return g;
  }

  /** Build the five point star extrusion. */
  _makeStarGeometry(THREE, outer, inner, depth) {
    const shape = new THREE.Shape();
    const spikes = 5;
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (i / (spikes * 2)) * TAU - Math.PI / 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  }

  /** Canvas "?" texture; returns null when there is no DOM (node tests). */
  _makeBoxTexture(THREE) {
    if (typeof document === 'undefined') return null;
    try {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const grd = ctx.createLinearGradient(0, 0, size, size);
      grd.addColorStop(0, '#2b6bff');
      grd.addColorStop(0.5, '#38d6ff');
      grd.addColorStop(1, '#8a5cff');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 9;
      ctx.strokeRect(4.5, 4.5, size - 9, size - 9);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 88px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', size / 2, size / 2 + 6);
      const tex = new THREE.CanvasTexture(canvas);
      if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
      this._tex.push(tex);
      return tex;
    } catch (err) {
      return null;
    }
  }

  // ------------------------------------------------------------- dispose --

  dispose() {
    for (const g of this._geo) g?.dispose?.();
    for (const m of this._mat) m?.dispose?.();
    for (const t of this._tex) t?.dispose?.();
    this._geo.length = 0;
    this._mat.length = 0;
    this._tex.length = 0;
  }
}
