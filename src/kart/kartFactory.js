/**
 * ============================================================================
 * TURBO KART — kart mesh factory (Agent 1)
 * ============================================================================
 * `createKartMesh({ THREE, characterId, isPlayer, quality })` returns
 *   { group, update(dt, state, kart), setQuality(q), dispose() }
 *
 * Geometry is cached and shared per character+quality; materials are cloned
 * per kart so star/frozen tints never bleed between karts.
 * ============================================================================
 */
import * as THREE from 'three';
import { getCharacter } from '../contracts.js';
import { clamp } from '../core/mathUtils.js';
import { getKartParts, makeNumberTexture } from './kartModels.js';

const _hsl = new THREE.Color();

/**
 * @param {{THREE?:any, characterId?:string, isPlayer?:boolean, quality?:string, number?:number}} opts
 */
export function createKartMesh({ THREE: T3, characterId = 'nova', isPlayer = false, quality = 'high', number } = {}) {
  const three = T3 || THREE;
  const character = getCharacter(characterId);
  const parts = getKartParts({ character, quality });
  const { style, colors } = parts;

  const group = new three.Group();
  group.name = `kart:${characterId}`;
  const spinGroup = new three.Group();   // visual spin-out rotation
  const chassis = new three.Group();     // lean / pitch / hop
  const wheelsGroup = new three.Group();
  group.add(spinGroup);
  spinGroup.add(chassis);
  spinGroup.add(wheelsGroup);

  // ------------------------------------------------------------- materials
  const bodyMat = new three.MeshStandardMaterial({
    vertexColors: true,
    metalness: style.metalness,
    roughness: style.rough,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  const glowMat = new three.MeshStandardMaterial({
    color: character.accent,
    emissive: character.accent,
    emissiveIntensity: 1.35,
    metalness: 0.1,
    roughness: 0.35,
    toneMapped: true,
  });
  const wheelMat = new three.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.3,
    roughness: 0.72,
  });
  const flameMat = new three.MeshBasicMaterial({
    color: character.accent,
    transparent: true,
    opacity: 0,
    blending: three.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const brakeMat = new three.MeshBasicMaterial({
    color: 0xff2f2f,
    transparent: true,
    opacity: 0.18,
    toneMapped: false,
  });
  const chevronMat = new three.MeshBasicMaterial({
    color: 0x9df6ff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    toneMapped: false,
  });
  const underglowMat = new three.MeshBasicMaterial({
    color: character.accent,
    transparent: true,
    opacity: 0.22,
    blending: three.AdditiveBlending,
    depthWrite: false,
    side: three.DoubleSide,
    toneMapped: false,
  });
  const decalTex = makeNumberTexture(number ?? style.number, character.accent);
  const decalMat = new three.MeshStandardMaterial({
    map: decalTex,
    transparent: true,
    alphaTest: 0.4,
    roughness: 0.7,
    metalness: 0.0,
  });
  const materials = [bodyMat, glowMat, wheelMat, flameMat, brakeMat, chevronMat, underglowMat, decalMat];

  // ------------------------------------------------------------ body meshes
  const bodyMesh = new three.Mesh(parts.solid, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = false;
  chassis.add(bodyMesh);

  const glowMesh = new three.Mesh(parts.glow, glowMat);
  glowMesh.castShadow = false;
  chassis.add(glowMesh);

  // number decal on the nose (readable from behind/above, nose up-screen)
  const decalGeo = new three.PlaneGeometry(0.42, 0.5);
  decalGeo.rotateZ(Math.PI);
  decalGeo.rotateX(-Math.PI / 2);
  decalGeo.translate(0, parts.decalY + 0.012, parts.decalZ);
  const decal = new three.Mesh(decalGeo, decalMat);
  chassis.add(decal);

  // brake lights
  const brakeGeo = new three.PlaneGeometry(0.16, 0.09);
  const brakeL = new three.Mesh(brakeGeo, brakeMat);
  brakeL.position.set(style.width * 0.3, 0.42, -style.length * 0.46);
  brakeL.rotation.y = Math.PI;
  const brakeR = brakeL.clone();
  brakeR.position.x = -style.width * 0.3;
  chassis.add(brakeL, brakeR);

  // boost flames (hidden unless boosting)
  const flameGeo = new three.ConeGeometry(0.11, 0.55, 8, 1, true);
  flameGeo.rotateX(-Math.PI / 2);
  const flames = [];
  for (const sx of [1, -1]) {
    const f = new three.Mesh(flameGeo, flameMat);
    f.position.set(sx * (style.shape === 'truck' ? 0.42 : 0.24), 0.7, -style.length * 0.5);
    f.visible = false;
    f.renderOrder = 2;
    chassis.add(f);
    flames.push(f);
  }

  // ---------------------------------------------------------------- wheels
  const frontPivots = [];
  const frontWheels = [];
  const rearWheels = [];
  for (const sx of [1, -1]) {
    const pivot = new three.Group();
    pivot.position.set(sx * style.trackFront, style.wheelR, style.wheelbase);
    const wheel = new three.Mesh(parts.wheelFront, wheelMat);
    wheel.castShadow = true;
    pivot.add(wheel);
    wheelsGroup.add(pivot);
    frontPivots.push(pivot);
    frontWheels.push(wheel);

    const rear = new three.Mesh(parts.wheelRear, wheelMat);
    rear.castShadow = true;
    rear.position.set(sx * style.trackRear, style.rearWheelR, -style.wheelbase);
    wheelsGroup.add(rear);
    rearWheels.push(rear);
  }

  // ------------------------------------------------------- player markers
  let chevron = null;
  let underglow = null;
  if (isPlayer) {
    const chevGeo = new three.ConeGeometry(0.24, 0.34, 4);
    chevGeo.rotateX(Math.PI);
    chevGeo.rotateY(Math.PI / 4);
    chevron = new three.Mesh(chevGeo, chevronMat);
    chevron.position.set(0, 2.35, 0);
    chevron.renderOrder = 3;
    group.add(chevron);

    const ringGeo = new three.RingGeometry(0.55, 1.35, 24);
    ringGeo.rotateX(-Math.PI / 2);
    underglow = new three.Mesh(ringGeo, underglowMat);
    underglow.position.y = 0.035;
    underglow.renderOrder = 1;
    group.add(underglow);
  }

  // -------------------------------------------------------------- animation
  let time = 0;
  let tint = 'normal';

  const api = {
    group,
    /** @type {THREE.Group} */ spinGroup,
    /** @type {THREE.Group} */ chassis,
    /** @type {THREE.Group} */ wheelsGroup,
    materials,
    isPlayer,

    /**
     * @param {number} dt
     * @param {any} state KartState
     * @param {any} [kart] owning kart (provides `visual`)
     */
    update(dt, state = {}, kart) {
      time += dt;
      const v = (kart && kart.visual) || {};

      // ---- wheels: roll + steer ----------------------------------------
      const spin = Number.isFinite(v.wheelAngle) ? v.wheelAngle : (state.wheelSpin || 0) * Math.PI * 2;
      for (let i = 0; i < frontWheels.length; i++) {
        frontWheels[i].rotation.x = spin;
        rearWheels[i].rotation.x = spin;
      }
      const steer = clamp(state.steerVisual || 0, -1, 1);
      const steerAngle = steer * 0.42;
      for (const p of frontPivots) p.rotation.y = steerAngle;

      // ---- chassis: lean, pitch, hop, bump -----------------------------
      const lean = clamp(state.lean || 0, -1, 1);
      chassis.rotation.z = lean * 0.5 + (v.driftTilt || 0);
      chassis.rotation.x = (v.airPitch || 0) + (v.hopTilt || 0);
      chassis.position.y = v.bounce || 0;

      // ---- spin-out (visual only; physics yaw is untouched) ------------
      spinGroup.rotation.y = v.spinYaw || 0;

      // ---- squash / stretch --------------------------------------------
      const squash = Number.isFinite(v.squash) ? v.squash : 1;
      const stretch = 1 / Math.max(0.4, squash);
      spinGroup.scale.set(stretch * 0.5 + 0.5, squash, stretch * 0.5 + 0.5);

      // ---- boost flames ------------------------------------------------
      const boost = clamp(v.boostGlow || 0, 0, 1.6);
      if (boost > 0.02) {
        flameMat.opacity = Math.min(0.95, boost);
        const len = 0.5 + boost * 1.5;
        for (let i = 0; i < flames.length; i++) {
          const f = flames[i];
          f.visible = true;
          f.scale.set(0.8 + boost * 0.35, 0.8 + boost * 0.35, len);
          f.rotation.z = Math.sin(time * 26 + i * 2.1) * 0.12;
        }
      } else if (flames[0].visible) {
        for (const f of flames) f.visible = false;
        flameMat.opacity = 0;
      }

      // ---- brake lights ------------------------------------------------
      const brake = clamp(v.brakeLight || 0, 0, 1);
      brakeMat.opacity = 0.16 + brake * 0.84;

      // ---- tint states: normal / star / frozen -------------------------
      const want = state.invincible ? 'star' : state.frozen ? 'frozen' : 'normal';
      if (want !== tint) {
        tint = want;
        if (want === 'normal') {
          bodyMat.color.setRGB(1, 1, 1);
          bodyMat.emissive.setHex(0x000000);
          bodyMat.emissiveIntensity = 0;
          glowMat.color.setHex(character.accent);
          glowMat.emissive.setHex(character.accent);
          glowMat.emissiveIntensity = 1.35;
          wheelMat.color.setRGB(1, 1, 1);
          underglowMat.color.setHex(character.accent);
        } else if (want === 'frozen') {
          bodyMat.color.setHex(0x9fd4ff);
          bodyMat.emissive.setHex(0x1b3b5c);
          bodyMat.emissiveIntensity = 0.7;
          glowMat.color.setHex(0xbdefff);
          glowMat.emissive.setHex(0x7fd8ff);
          glowMat.emissiveIntensity = 1.8;
          wheelMat.color.setHex(0xbcd8ea);
          underglowMat.color.setHex(0x8fd8ff);
        }
      }
      if (tint === 'star') {
        const hue = (time * 1.35) % 1;
        _hsl.setHSL(hue, 1, 0.62);
        bodyMat.color.copy(_hsl);
        glowMat.color.copy(_hsl);
        glowMat.emissive.copy(_hsl);
        glowMat.emissiveIntensity = 2.4;
        wheelMat.color.copy(_hsl);
        underglowMat.color.copy(_hsl);
      }

      // ---- player markers ----------------------------------------------
      if (chevron) {
        chevron.position.y = 2.35 + Math.sin(time * 2.6) * 0.09;
        chevron.rotation.y = time * 1.2;
        chevronMat.opacity = 0.55 + Math.sin(time * 3.4) * 0.25;
      }
      if (underglow) {
        underglowMat.opacity = 0.16 + (state.boosting ? 0.25 : 0) + Math.sin(time * 4) * 0.03;
      }
      return api;
    },

    /** Swap to another detail tier (geometries are cached per quality). */
    setQuality(q) {
      const next = getKartParts({ character, quality: q || 'high' });
      bodyMesh.geometry = next.solid;
      glowMesh.geometry = next.glow;
      frontWheels.forEach((w) => { w.geometry = next.wheelFront; });
      rearWheels.forEach((w) => { w.geometry = next.wheelRear; });
      return api;
    },

    dispose() {
      decalTex.dispose();
      decalGeo.dispose();
      brakeGeo.dispose();
      flameGeo.dispose();
      for (const m of materials) m.dispose();
      if (chevron) chevron.geometry.dispose();
      if (underglow) underglow.geometry.dispose();
      group.clear();
      return undefined;
    },
  };

  return api;
}

export default createKartMesh;
