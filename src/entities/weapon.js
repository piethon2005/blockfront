// =====================================================================
// Weapons — first-person viewmodels for every weapon in the catalog,
// melee slashes, gunfire, reserve-ammo reloads, semi/full-auto triggers,
// zoom, and procedural animation (sway, bob, breathing, recoil springs,
// camera kick, reload dip with magazine drop, switch raise, shotgun pump,
// rail-coil glow, knife slash, med-kit lowering).
//
// The active weapon always comes from the Inventory. Damage resolution
// is delegated to a `combat` object supplied by main.js.
// =====================================================================

import * as THREE from 'three';
import { PLAYER, VOXEL } from '../config.js';
import { events } from '../core/events.js';
import { applyWorldUVs, getPlainMaterial, getSurfaceMaterial } from '../world/materials.js';

const ARCHETYPE_POSES = {
  rifle: { rest: new THREE.Vector3(0.28, -0.26, -0.5), aim: new THREE.Vector3(0.0, -0.2, -0.42) },
  pistol: { rest: new THREE.Vector3(0.22, -0.23, -0.42), aim: new THREE.Vector3(0.0, -0.165, -0.36) },
  melee: { rest: new THREE.Vector3(0.3, -0.3, -0.46), aim: new THREE.Vector3(0.3, -0.3, -0.46) },
};
const SWITCH_DURATION = 0.32;

// Simple damped spring used for recoil.
class Spring {
  constructor(stiffness, damping) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.value = 0;
    this.velocity = 0;
  }
  impulse(amount) {
    this.velocity += amount;
  }
  update(deltaSeconds) {
    const acceleration = -this.stiffness * this.value - this.damping * this.velocity;
    this.velocity += acceleration * deltaSeconds;
    this.value += this.velocity * deltaSeconds;
    return this.value;
  }
}

// ------------------------------------------------------------------ materials & helpers
const gunMetal = () => getPlainMaterial(0x2b2d33, { roughness: 0.32, metalness: 0.85 });
const darkMetal = () => getPlainMaterial(0x16171b, { roughness: 0.4, metalness: 0.75 });
const brightSteel = () => getPlainMaterial(0xcfd4da, { roughness: 0.18, metalness: 1 });
const chrome = () => getPlainMaterial(0xb8bcc2, { roughness: 0.22, metalness: 1 });
const polymer = () => getPlainMaterial(0x1f2024, { roughness: 0.7, metalness: 0.05 });
const olivePolymer = () => getPlainMaterial(0x3a4a2a, { roughness: 0.6, metalness: 0.2 });
const tanPolymer = () => getPlainMaterial(0xa8875a, { roughness: 0.65, metalness: 0.05 });
const woodMaterial = () => getSurfaceMaterial('planks', 0x8a5a2e);
const glow = (color, intensity = 3) => getPlainMaterial(color, { emissive: color, emissiveIntensity: intensity, roughness: 0.3 });

function addPart(parent, width, height, depth, material, x, y, z, rotationX = 0, rotationY = 0, rotationZ = 0) {
  const geometry = applyWorldUVs(new THREE.BoxGeometry(width, height, depth), width, height, depth, 0.4);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rotationX, rotationY, rotationZ);
  parent.add(mesh);
  return mesh;
}

function addLimb(parent, from, to, thickness, material) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, start.distanceTo(end)), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.lookAt(end);
  parent.add(mesh);
  return mesh;
}

function createAnchor(parent, x, y, z) {
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);
  parent.add(anchor);
  return anchor;
}

function finishModel(group, extras) {
  return { group, muzzle: null, magazine: null, magazineRest: null, pump: null, pumpRest: 0, glowParts: [], archetype: 'rifle', ...extras, };
}

function addMagazine(group, parts, position) {
  const magazine = new THREE.Group();
  for (const [width, height, depth, material, x, y, z, rotationX] of parts) addPart(magazine, width, height, depth, material, x, y, z, rotationX || 0);
  magazine.position.copy(position);
  group.add(magazine);
  return magazine;
}

// ------------------------------------------------------------------ model builders
const MODEL_BUILDERS = {
  knife() {
    const group = new THREE.Group();
    addPart(group, 0.045, 0.06, 0.16, polymer(), 0, 0, 0.03);                        // handle
    addPart(group, 0.05, 0.065, 0.02, darkMetal(), 0, 0, 0.11);                      // pommel
    addPart(group, 0.11, 0.025, 0.03, darkMetal(), 0, 0, -0.06);                     // guard
    addPart(group, 0.012, 0.05, 0.2, brightSteel(), 0, 0.005, -0.18);                // blade
    addPart(group, 0.012, 0.03, 0.07, brightSteel(), 0, 0.015, -0.3, 0.35);          // tip
    addPart(group, 0.014, 0.012, 0.18, darkMetal(), 0, 0.03, -0.17);                 // spine
    return finishModel(group, { archetype: 'melee', muzzle: createAnchor(group, 0, 0, -0.3) });
  },
  machete() {
    const group = new THREE.Group();
    addPart(group, 0.05, 0.07, 0.18, woodMaterial(), 0, 0, 0.04);
    addPart(group, 0.06, 0.03, 0.03, brightSteel(), 0, 0, -0.06);
    addPart(group, 0.014, 0.08, 0.24, getPlainMaterial(0x6a6e74, { roughness: 0.35, metalness: 0.9 }), 0, 0.01, -0.19);
    addPart(group, 0.014, 0.11, 0.2, getPlainMaterial(0x6a6e74, { roughness: 0.35, metalness: 0.9 }), 0, -0.005, -0.38, -0.25);
    addPart(group, 0.016, 0.014, 0.42, brightSteel(), 0, -0.05, -0.3, -0.12);       // honed edge
    return finishModel(group, { archetype: 'melee', muzzle: createAnchor(group, 0, 0, -0.45) });
  },
  pistol() {
    const group = new THREE.Group();
    addPart(group, 0.06, 0.05, 0.2, polymer(), 0, -0.02, -0.08);                     // frame
    addPart(group, 0.066, 0.055, 0.22, gunMetal(), 0, 0.03, -0.09);                  // slide
    addPart(group, 0.055, 0.14, 0.07, polymer(), 0, -0.1, 0.0, 0.22);                // grip
    addPart(group, 0.012, 0.02, 0.012, darkMetal(), 0, 0.065, -0.19);                // front sight
    addPart(group, 0.04, 0.018, 0.012, darkMetal(), 0, 0.065, 0.01);                 // rear sight
    addPart(group, 0.02, 0.02, 0.02, glow(0x6fff6f, 2), 0, 0.068, -0.19);            // tritium dot
    const magazine = addMagazine(group, [[0.045, 0.13, 0.055, darkMetal(), 0, -0.06, 0, 0.22]], new THREE.Vector3(0, -0.06, 0.01));
    return finishModel(group, { archetype: 'pistol', muzzle: createAnchor(group, 0, 0.03, -0.21), magazine, magazineRest: magazine.position.clone() });
  },
  deagle() {
    const group = new THREE.Group();
    addPart(group, 0.07, 0.06, 0.26, chrome(), 0, -0.02, -0.1);
    addPart(group, 0.078, 0.075, 0.3, chrome(), 0, 0.04, -0.12);
    addPart(group, 0.03, 0.02, 0.3, getPlainMaterial(0x9a9ea4, { roughness: 0.3, metalness: 1 }), 0, 0.085, -0.12); // top rib
    addPart(group, 0.062, 0.16, 0.08, getPlainMaterial(0x2a1c14, { roughness: 0.7 }), 0, -0.11, 0.02, 0.2);
    const magazine = addMagazine(group, [[0.05, 0.14, 0.06, darkMetal(), 0, -0.06, 0, 0.2]], new THREE.Vector3(0, -0.07, 0.03));
    return finishModel(group, { archetype: 'pistol', muzzle: createAnchor(group, 0, 0.04, -0.28), magazine, magazineRest: magazine.position.clone() });
  },
  glock18() {
    const group = new THREE.Group();
    addPart(group, 0.06, 0.05, 0.2, tanPolymer(), 0, -0.02, -0.08);
    addPart(group, 0.066, 0.055, 0.22, gunMetal(), 0, 0.03, -0.09);
    addPart(group, 0.07, 0.06, 0.05, darkMetal(), 0, 0.03, -0.22);                   // compensator
    addPart(group, 0.068, 0.012, 0.05, glow(0xff8a1a, 2.5), 0, 0.06, -0.22);          // ported glow
    addPart(group, 0.055, 0.14, 0.07, tanPolymer(), 0, -0.1, 0.0, 0.22);
    addPart(group, 0.03, 0.015, 0.03, glow(0xffb21a, 2), 0.035, 0.02, -0.02);         // fire selector
    const magazine = addMagazine(group, [[0.045, 0.24, 0.055, darkMetal(), 0, -0.11, 0.02, 0.22]], new THREE.Vector3(0, -0.06, 0.01));
    return finishModel(group, { archetype: 'pistol', muzzle: createAnchor(group, 0, 0.03, -0.25), magazine, magazineRest: magazine.position.clone() });
  },
  ak47() {
    const group = new THREE.Group();
    addPart(group, 0.09, 0.11, 0.62, gunMetal(), 0, 0, -0.2);
    addPart(group, 0.05, 0.05, 0.36, darkMetal(), 0, 0.02, -0.62);
    addPart(group, 0.065, 0.065, 0.07, darkMetal(), 0, 0.02, -0.81);
    addPart(group, 0.03, 0.03, 0.3, darkMetal(), 0, 0.065, -0.5);
    addPart(group, 0.11, 0.075, 0.22, woodMaterial(), 0, -0.035, -0.42);
    addPart(group, 0.1, 0.14, 0.24, woodMaterial(), 0, -0.035, 0.18);
    addPart(group, 0.07, 0.15, 0.07, polymer(), 0, -0.12, -0.04, 0.25);
    addPart(group, 0.08, 0.07, 0.1, darkMetal(), 0, 0.09, -0.18);
    addPart(group, 0.05, 0.05, 0.012, glow(0xff3030), 0, 0.09, -0.236);
    addPart(group, 0.015, 0.06, 0.015, darkMetal(), 0, 0.06, -0.76);
    const magazine = addMagazine(group, [
      [0.06, 0.13, 0.09, darkMetal(), 0, -0.06, 0, 0.12],
      [0.06, 0.12, 0.09, darkMetal(), 0, -0.17, 0.03, 0.35],
    ], new THREE.Vector3(0, -0.06, -0.27));
    return finishModel(group, { muzzle: createAnchor(group, 0, 0.02, -0.86), magazine, magazineRest: magazine.position.clone() });
  },
  m4() {
    const group = new THREE.Group();
    addPart(group, 0.08, 0.1, 0.36, polymer(), 0, 0, -0.12);                         // receiver
    addPart(group, 0.09, 0.09, 0.32, darkMetal(), 0, 0.005, -0.46);                  // quad-rail handguard
    for (const railZ of [-0.36, -0.44, -0.52, -0.6]) addPart(group, 0.1, 0.02, 0.03, gunMetal(), 0, 0.055, railZ);
    addPart(group, 0.045, 0.045, 0.2, darkMetal(), 0, 0.01, -0.72);                  // barrel
    addPart(group, 0.06, 0.06, 0.06, darkMetal(), 0, 0.01, -0.84);                   // flash hider
    addPart(group, 0.07, 0.07, 0.22, polymer(), 0, -0.02, 0.17);                     // buffer tube
    addPart(group, 0.08, 0.13, 0.12, polymer(), 0, -0.03, 0.3);                      // stock
    addPart(group, 0.065, 0.15, 0.065, polymer(), 0, -0.12, 0.0, 0.25);              // grip
    addPart(group, 0.07, 0.07, 0.12, darkMetal(), 0, 0.1, -0.15);                    // holo sight body
    addPart(group, 0.06, 0.05, 0.01, getPlainMaterial(0x88ffcc, { transparent: true, opacity: 0.35, roughness: 0.05 }), 0, 0.105, -0.205);
    addPart(group, 0.012, 0.012, 0.005, glow(0x30ff7a, 4), 0, 0.105, -0.21);
    const magazine = addMagazine(group, [
      [0.055, 0.17, 0.08, darkMetal(), 0, -0.08, 0, 0.12],
    ], new THREE.Vector3(0, -0.06, -0.2));
    return finishModel(group, { muzzle: createAnchor(group, 0, 0.01, -0.88), magazine, magazineRest: magazine.position.clone() });
  },
  shotgun() {
    const group = new THREE.Group();
    addPart(group, 0.12, 0.12, 0.72, gunMetal(), 0, 0, -0.35);
    addPart(group, 0.1, 0.1, 0.56, darkMetal(), 0, -0.1, -0.3);
    addPart(group, 0.11, 0.13, 0.26, gunMetal(), 0, -0.02, 0.0);
    addPart(group, 0.1, 0.15, 0.32, woodMaterial(), 0, -0.04, 0.17);
    addPart(group, 0.07, 0.14, 0.07, polymer(), 0, -0.12, 0.05, 0.3);
    addPart(group, 0.03, 0.05, 0.03, glow(0xff3030, 2.5), 0, 0.08, -0.69);
    const pump = addPart(group, 0.15, 0.11, 0.24, woodMaterial(), 0, -0.1, -0.42);
    return finishModel(group, { muzzle: createAnchor(group, 0, 0.02, -0.74), pump, pumpRest: pump.position.z });
  },
  rail() {
    const group = new THREE.Group();
    addPart(group, 0.06, 0.06, 1.05, darkMetal(), 0, 0, -0.55);
    addPart(group, 0.1, 0.13, 0.56, olivePolymer(), 0, 0, -0.1);
    addPart(group, 0.09, 0.09, 0.36, darkMetal(), 0, 0.13, -0.2);
    addPart(group, 0.07, 0.07, 0.01, getPlainMaterial(0x4fd0ff, { emissive: 0x4fd0ff, emissiveIntensity: 2, metalness: 0.5, roughness: 0.1 }), 0, 0.13, -0.385);
    addPart(group, 0.1, 0.15, 0.32, olivePolymer(), 0, -0.03, 0.2);
    addPart(group, 0.07, 0.14, 0.07, polymer(), 0, -0.12, 0.02, 0.25);
    addPart(group, 0.06, 0.09, 0.12, darkMetal(), 0, -0.1, -0.2);
    const glowParts = [];
    for (const coilZ of [-0.42, -0.57, -0.72, -0.87]) {
      const coilMaterial = new THREE.MeshStandardMaterial({ color: 0x4fd0ff, emissive: 0x4fd0ff, emissiveIntensity: 2.5, roughness: 0.3 });
      glowParts.push(addPart(group, 0.1, 0.1, 0.03, coilMaterial, 0, 0, coilZ));
    }
    return finishModel(group, { muzzle: createAnchor(group, 0, 0, -1.12), glowParts });
  },
  lmg() {
    const group = new THREE.Group();
    const lmgBody = getPlainMaterial(0x2f3426, { roughness: 0.55, metalness: 0.4 });
    addPart(group, 0.12, 0.14, 0.6, lmgBody, 0, 0, -0.18);                           // receiver
    addPart(group, 0.1, 0.06, 0.2, darkMetal(), 0, 0.1, -0.12);                      // feed cover
    addPart(group, 0.085, 0.085, 0.48, getPlainMaterial(0x45474c, { roughness: 0.5, metalness: 0.7 }), 0, 0.01, -0.68); // heat shield
    for (const ventZ of [-0.5, -0.6, -0.7, -0.8]) addPart(group, 0.09, 0.02, 0.025, darkMetal(), 0, 0.055, ventZ);
    addPart(group, 0.05, 0.05, 0.16, darkMetal(), 0, 0.01, -0.98);
    addPart(group, 0.05, 0.06, 0.2, darkMetal(), 0, 0.14, -0.35);                    // carry handle
    addPart(group, 0.1, 0.15, 0.28, polymer(), 0, -0.04, 0.24);                      // stock
    addPart(group, 0.07, 0.15, 0.07, polymer(), 0, -0.13, -0.02, 0.25);              // grip
    addPart(group, 0.02, 0.2, 0.02, darkMetal(), 0.04, -0.06, -0.85, 0.9);           // bipod legs (folded)
    addPart(group, 0.02, 0.2, 0.02, darkMetal(), -0.04, -0.06, -0.85, 0.9);
    const magazine = addMagazine(group, [
      [0.15, 0.17, 0.17, getPlainMaterial(0x3a4a2a, { roughness: 0.7 }), -0.02, -0.08, 0],
      [0.04, 0.04, 0.12, getPlainMaterial(0xd4a33a, { roughness: 0.3, metalness: 1 }), 0.05, 0.02, 0],
    ], new THREE.Vector3(-0.03, -0.07, -0.28));
    return finishModel(group, { muzzle: createAnchor(group, 0, 0.01, -1.07), magazine, magazineRest: magazine.position.clone() });
  },
};

/** Build a weapon model by id (used by the viewmodel, ground loot and the menu armory). */
export function buildWeaponModel(modelId) {
  const builder = MODEL_BUILDERS[modelId] || MODEL_BUILDERS.ak47;
  return builder();
}

function buildArmSets(gender = 'male') {
  const thin = gender === 'female' ? 0.82 : 1;   // slimmer forearms and gloves for female operators
  const sleeve = getSurfaceMaterial('plaster', 0x56653a);
  const glove = getPlainMaterial(0x2a2420, { roughness: 0.85 });
  const cuff = getPlainMaterial(0x1b1d17, { roughness: 0.8 });

  const rifle = new THREE.Group();
  addLimb(rifle, [0.24, -0.34, 0.42], [0.06, -0.15, -0.02], 0.13 * thin, sleeve);
  addPart(rifle, 0.11, 0.11, 0.16, glove, 0.03, -0.12, -0.06);
  addPart(rifle, 0.14, 0.05, 0.08, cuff, 0.2, -0.3, 0.34);
  addLimb(rifle, [-0.32, -0.4, 0.2], [-0.03, -0.1, -0.38], 0.13 * thin, sleeve);
  addPart(rifle, 0.11, 0.1, 0.16, glove, -0.01, -0.09, -0.42);

  const pistol = new THREE.Group();
  addLimb(pistol, [0.2, -0.38, 0.36], [0.02, -0.12, 0.02], 0.12 * thin, sleeve);
  addLimb(pistol, [-0.24, -0.4, 0.3], [-0.02, -0.12, 0.02], 0.12 * thin, sleeve);
  addPart(pistol, 0.09, 0.1, 0.12, glove, 0.015, -0.1, 0.02);
  addPart(pistol, 0.08, 0.09, 0.11, glove, -0.03, -0.12, 0.0);

  const melee = new THREE.Group();
  addLimb(melee, [0.12, -0.36, 0.42], [0.0, -0.03, 0.06], 0.13 * thin, sleeve);
  addPart(melee, 0.1, 0.1, 0.12, glove, 0.0, -0.01, 0.04);

  return { rifle, pistol, melee };
}

// ------------------------------------------------------------------ weapon system
export class WeaponSystem {
  constructor({ camera, inventory }) {
    this.camera = camera;
    this.inventory = inventory;
    this.viewmodelRoot = new THREE.Group();
    camera.add(this.viewmodelRoot);

    this.modelsById = new Map();
    this.armSets = buildArmSets();
    Object.values(this.armSets).forEach((arms) => this.viewmodelRoot.add(arms));

    this.displayedItem = null;
    this.currentModel = null;
    this.fireCooldown = 0;
    this.reloadTimer = 0;
    this.isZoomed = false;
    this.lastEmptyClickTime = 0;
    this.timeSinceShot = 10;
    this.swingTimer = 0;
    this.swingDuration = 0.32;
    this.meleeHitPending = false;

    // Animation state.
    this.recoilKick = new Spring(180, 16);
    this.recoilPitch = new Spring(160, 15);
    this.cameraRecoil = new Spring(120, 14);
    this.swayX = 0;
    this.swayY = 0;
    this.bobPhase = 0;
    this.idleTime = 0;
    this.switchTimer = 0;
    this.aimBlend = 0;
    this.deathLowering = 0;
    this.healLowering = 0;

    this.scratchOrigin = new THREE.Vector3();
    this.scratchPose = new THREE.Vector3();
    this.scratchDirection = new THREE.Vector3();
    this.scratchMuzzle = new THREE.Vector3();
    this.scratchRight = new THREE.Vector3();
    this.scratchUp = new THREE.Vector3();

    this.syncWithInventory(true);
  }

  // ------------------------------------------------------------------ state accessors
  get activeItem() {
    return this.inventory.active;
  }

  get weapon() {
    return this.activeItem ? this.activeItem.definition : null;
  }

  get ammo() {
    return this.activeItem ? this.activeItem.ammo : 0;
  }

  get reserve() {
    return this.activeItem ? this.activeItem.reserve : 0;
  }

  get isReloading() {
    return this.reloadTimer > 0;
  }

  get reloadProgress() {
    return this.isReloading && this.weapon ? 1 - this.reloadTimer / this.weapon.reloadTime : 0;
  }

  get cameraKickPitch() {
    return this.cameraRecoil.value;
  }

  get mobility() {
    return this.weapon ? this.weapon.mobility || 1 : 1;
  }

  get targetFov() {
    return this.isZoomed && this.weapon && !this.weapon.isMelee ? this.weapon.zoomFov : PLAYER.baseFov;
  }

  get isScoped() {
    return this.isZoomed && !!this.weapon && !!this.weapon.hideViewmodelWhenZoomed;
  }

  /** Swap first-person arms for the selected operator gender. */
  setGender(gender) {
    Object.values(this.armSets).forEach((arms) => this.viewmodelRoot.remove(arms));
    this.armSets = buildArmSets(gender);
    Object.values(this.armSets).forEach((arms) => this.viewmodelRoot.add(arms));
    const archetype = this.currentModel ? this.currentModel.archetype : 'rifle';
    for (const [name, arms] of Object.entries(this.armSets)) arms.visible = name === archetype;
  }

  getModel(modelId) {
    if (!this.modelsById.has(modelId)) {
      const model = buildWeaponModel(modelId);
      model.group.visible = false;
      model.group.traverse((object) => {
        if (object.isMesh) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });
      this.viewmodelRoot.add(model.group);
      this.modelsById.set(modelId, model);
    }
    return this.modelsById.get(modelId);
  }

  /** Show the model of the inventory's active weapon; plays the switch raise when it changes. */
  syncWithInventory(silent = false) {
    const item = this.activeItem;
    if (item === this.displayedItem) return;
    this.displayedItem = item;
    this.reloadTimer = 0;
    this.swingTimer = 0;
    this.meleeHitPending = false;
    if (this.currentModel) this.currentModel.group.visible = false;
    this.currentModel = item ? this.getModel(item.definition.model) : null;
    if (this.currentModel) {
      this.currentModel.group.visible = true;
      if (this.currentModel.magazine) this.currentModel.magazine.position.copy(this.currentModel.magazineRest);
    }
    const archetype = this.currentModel ? this.currentModel.archetype : 'rifle';
    for (const [name, arms] of Object.entries(this.armSets)) arms.visible = name === archetype;
    if (!silent) {
      this.switchTimer = SWITCH_DURATION;
      if (item) events.emit('weapon:switch', { weapon: item.definition, index: this.inventory.activeSlot });
    }
  }

  switchToSlot(slotIndex) {
    if (this.inventory.equip(slotIndex)) this.syncWithInventory();
  }

  cycleWeapon(direction) {
    if (this.inventory.cycle(direction)) this.syncWithInventory();
  }

  startReload() {
    const item = this.activeItem;
    if (!item || item.definition.isMelee || this.isReloading || this.switchTimer > 0.1) return;
    if (item.ammo >= item.definition.magazineSize || item.reserve <= 0) return;
    this.reloadTimer = item.definition.reloadTime;
    events.emit('weapon:reload-start', { weapon: item.definition, duration: item.definition.reloadTime });
  }

  setZoom(zoomed) {
    const allowed = zoomed && this.weapon && !this.weapon.isMelee;
    if (allowed === this.isZoomed) return;
    this.isZoomed = !!allowed;
    events.emit('weapon:zoom', { weapon: this.weapon, zoomed: this.isZoomed });
  }

  currentSpread(player) {
    const weapon = this.weapon;
    if (!weapon || weapon.isMelee) return 0.01;
    if (this.isZoomed && weapon.zoomRemovesSpread) return 0;
    let spread = weapon.spread;
    if (this.isZoomed) spread *= 0.6;
    if (player.isMoving) spread *= 1.35;
    if (!player.isGrounded) spread *= 1.8;
    if (player.isCrouching) spread *= PLAYER.crouchSpreadMultiplier;
    return spread;
  }

  // ------------------------------------------------------------------ per frame
  /**
   * context: { firing, firePressed, lookDeltaX, lookDeltaY, player, combat, canFire }
   */
  update(deltaSeconds, context) {
    const { player } = context;
    this.syncWithInventory();
    this.fireCooldown -= deltaSeconds;
    this.timeSinceShot += deltaSeconds;
    this.switchTimer = Math.max(0, this.switchTimer - deltaSeconds);

    if (this.isReloading) {
      this.reloadTimer -= deltaSeconds;
      if (this.reloadTimer <= 0) this.finishReload();
    }

    if (this.swingTimer > 0) {
      this.swingTimer -= deltaSeconds;
      const swingProgress = 1 - this.swingTimer / this.swingDuration;
      if (this.meleeHitPending && swingProgress >= 0.35) {
        this.meleeHitPending = false;
        this.resolveMelee(context.combat);
      }
    }

    const weapon = this.weapon;
    if (weapon && context.canFire && !player.isHealing) {
      const triggerHeld = weapon.automatic ? context.firing : context.firePressed;
      if (triggerHeld) {
        if (weapon.isMelee) this.tryMelee(player);
        else this.tryFire(player, context.combat);
      }
    }
    this.animate(deltaSeconds, context);
  }

  finishReload() {
    this.reloadTimer = 0;
    const item = this.activeItem;
    if (!item) return;
    const needed = item.definition.magazineSize - item.ammo;
    const taken = Math.min(needed, item.reserve);
    item.ammo += taken;
    item.reserve -= taken;
    if (this.currentModel && this.currentModel.magazine) this.currentModel.magazine.position.copy(this.currentModel.magazineRest);
    events.emit('weapon:reload-end', { weapon: item.definition });
    this.inventory.notifyChanged();
  }

  tryMelee(player) {
    if (!player.isAlive || this.fireCooldown > 0 || this.switchTimer > 0.1) return;
    const weapon = this.weapon;
    this.fireCooldown = weapon.fireInterval;
    this.swingDuration = Math.min(0.4, weapon.fireInterval * 0.8);
    this.swingTimer = this.swingDuration;
    this.meleeHitPending = true;
    this.timeSinceShot = 0;
    events.emit('weapon:melee-swing', { weapon });
  }

  /** Short-range fan of rays: center plus two angled rays for forgiving melee aim. */
  resolveMelee(combat) {
    const weapon = this.weapon;
    if (!weapon || !weapon.isMelee) return;
    this.camera.updateMatrixWorld(true);
    const origin = this.camera.getWorldPosition(this.scratchOrigin).clone();
    let bestHit = null;
    for (const yawOffset of [0, 0.22, -0.22]) {
      const direction = new THREE.Vector3(Math.sin(yawOffset), 0, -Math.cos(yawOffset)).applyQuaternion(this.camera.quaternion);
      const hit = combat.traceShot(origin, direction, weapon.range);
      if (hit && (!bestHit || (hit.bot && !bestHit.bot) || (!!hit.bot === !!bestHit.bot && hit.distance < bestHit.distance))) bestHit = hit;
    }
    if (bestHit) {
      combat.applyShotHit(bestHit, weapon);
      events.emit('weapon:impact', {
        point: bestHit.point.clone(), normal: bestHit.worldNormal, surfaceObject: bestHit.object, surfaceColor: bestHit.surfaceColor, hitBot: !!bestHit.bot, hitBarrel: !!bestHit.barrel, hitVoxel: !!bestHit.voxel, weapon,
      });
      this.recoilKick.impulse(-1.5);
    }
    events.emit('weapon:melee', { weapon, didHit: !!bestHit, hitBot: !!(bestHit && bestHit.bot) });
  }

  tryFire(player, combat) {
    const item = this.activeItem;
    const weapon = item.definition;
    if (!player.isAlive || this.isReloading || this.fireCooldown > 0 || this.switchTimer > 0.1) return;
    if (item.ammo <= 0) {
      if (performance.now() - this.lastEmptyClickTime > 350) {
        this.lastEmptyClickTime = performance.now();
        events.emit('weapon:empty', { weapon });
        if (item.reserve <= 0) events.emit('notify', { text: 'OUT OF AMMO — FIND AN AMMO BOX', tone: 'danger' });
      }
      this.startReload();
      return;
    }

    item.ammo -= 1;
    this.fireCooldown = weapon.fireInterval;
    this.timeSinceShot = 0;

    this.camera.updateMatrixWorld(true);
    const origin = this.camera.getWorldPosition(this.scratchOrigin);
    const spread = this.currentSpread(player);
    const muzzlePosition = this.currentModel.muzzle.getWorldPosition(this.scratchMuzzle).clone();
    const tracerEnds = [];

    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      const direction = this.scratchDirection
        .set((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, -1)
        .normalize()
        .applyQuaternion(this.camera.quaternion)
        .clone();
      const endPoint = this.traceWithPenetration(origin.clone(), direction, weapon, combat);
      if (pellet % weapon.tracerEvery === 0) tracerEnds.push(endPoint);
    }

    this.recoilKick.impulse(weapon.recoil * 1.6);
    this.recoilPitch.impulse(weapon.recoil * 2.2);
    this.cameraRecoil.impulse(weapon.cameraKick * 18);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = this.scratchRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = this.scratchUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const ejectBack = this.currentModel.archetype === 'pistol' ? -0.18 : -0.55;
    const ejectPosition = muzzlePosition.clone().addScaledVector(forward, ejectBack).addScaledVector(right, 0.05);
    const ejectDirection = right.clone().multiplyScalar(2.6).addScaledVector(up, 2.2).addScaledVector(forward, -0.4);

    events.emit('weapon:fire', {
      weapon, muzzlePosition, direction: forward, muzzleAnchor: this.currentModel.muzzle, tracerEnds,
      ejectPosition, ejectDirection, floorHeight: player.position.y, isScoped: this.isScoped,
    });
  }

  /**
   * Fire one ray. Penetrable voxel structures (wooden crates and fences) — and anything for the
   * RAIL-X — let the round pass through with reduced damage. Returns the final end point.
   */
  traceWithPenetration(rayOrigin, direction, weapon, combat) {
    let remaining = weapon.range;
    let damageScale = 1;
    for (let penetrations = 0; penetrations <= VOXEL.maxPenetrations; penetrations++) {
      const hit = combat.traceShot(rayOrigin, direction, remaining);
      if (!hit) return rayOrigin.clone().addScaledVector(direction, remaining);
      combat.applyShotHit(hit, weapon, damageScale);
      events.emit('weapon:impact', {
        point: hit.point.clone(), normal: hit.worldNormal, surfaceObject: hit.object, surfaceColor: hit.surfaceColor, hitBot: !!hit.bot, hitBarrel: !!hit.barrel, hitVoxel: !!hit.voxel, weapon,
      });
      const pierces = hit.voxel && (hit.voxel.structure.materialDefinition.penetrable || weapon.id === 'rail');
      if (!pierces || penetrations === VOXEL.maxPenetrations) return hit.point.clone();
      // Skip to where the ray leaves this structure, then keep going.
      const exitDistance = hit.voxel.exitDistance + 0.02;
      rayOrigin.addScaledVector(direction, exitDistance);
      remaining -= exitDistance;
      damageScale *= VOXEL.penetrationDamageFactor;
      if (remaining <= 0) return rayOrigin.clone();
    }
    return rayOrigin.clone();
  }

  animate(deltaSeconds, context) {
    const { player } = context;
    const model = this.currentModel;
    const weapon = this.weapon;
    this.idleTime += deltaSeconds;
    if (!model || !weapon) {
      this.viewmodelRoot.visible = false;
      return;
    }

    const targetSwayX = THREE.MathUtils.clamp(-context.lookDeltaX * 0.0009, -0.06, 0.06);
    const targetSwayY = THREE.MathUtils.clamp(context.lookDeltaY * 0.0009, -0.06, 0.06);
    const swayBlend = 1 - Math.exp(-deltaSeconds * 10);
    this.swayX += (targetSwayX - this.swayX) * swayBlend;
    this.swayY += (targetSwayY - this.swayY) * swayBlend;

    const walking = player.isMoving && player.isGrounded && player.isAlive;
    if (walking) this.bobPhase += deltaSeconds * (player.isDashing ? 16 : 10.5);
    const bobStrength = walking ? (this.isZoomed ? 0.3 : 1) : 0;
    const bobX = Math.sin(this.bobPhase) * 0.014 * bobStrength;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.016 * bobStrength;
    const breathY = Math.sin(this.idleTime * 1.7) * 0.004;

    const aimTarget = this.isZoomed && !weapon.hideViewmodelWhenZoomed ? 1 : 0;
    this.aimBlend += (aimTarget - this.aimBlend) * (1 - Math.exp(-deltaSeconds * 14));

    const kick = this.recoilKick.update(deltaSeconds);
    const pitchKick = this.recoilPitch.update(deltaSeconds);
    this.cameraRecoil.update(deltaSeconds);

    let reloadLower = 0;
    if (this.isReloading) {
      const progress = this.reloadProgress;
      reloadLower = Math.sin(Math.min(1, progress * 1.15) * Math.PI);
      if (model.magazine) {
        const restY = model.magazineRest.y;
        if (progress < 0.18) model.magazine.position.y = restY;
        else if (progress < 0.4) model.magazine.position.y = restY - ((progress - 0.18) / 0.22) * 0.35;
        else if (progress < 0.6) model.magazine.position.y = restY - 0.35;
        else if (progress < 0.8) model.magazine.position.y = restY - 0.35 + ((progress - 0.6) / 0.2) * 0.35;
        else model.magazine.position.y = restY;
      }
    }

    if (model.pump) {
      const pumpTime = this.timeSinceShot - 0.18;
      const pumpTravel = pumpTime > 0 && pumpTime < 0.36 ? Math.sin((pumpTime / 0.36) * Math.PI) * 0.12 : 0;
      model.pump.position.z = model.pumpRest + pumpTravel;
    }
    if (model.glowParts.length) {
      const charge = Math.min(1, this.timeSinceShot / weapon.fireInterval);
      model.glowParts.forEach((part, index) => {
        part.material.emissiveIntensity = 0.3 + charge * 2.6 + Math.sin(this.idleTime * 6 + index) * 0.25 * charge;
      });
    }

    // Melee slash: sweep from upper right across to lower left.
    let slashYaw = 0;
    let slashRoll = 0;
    let slashX = 0;
    let slashY = 0;
    let slashForward = 0;
    if (this.swingTimer > 0) {
      const progress = 1 - this.swingTimer / this.swingDuration;
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      const arc = Math.sin(progress * Math.PI);
      slashYaw = 0.9 - eased * 2.0;
      slashRoll = -0.9 * arc;
      slashX = 0.12 - eased * 0.38;
      slashY = 0.06 * arc;
      slashForward = -0.18 * arc;
    }

    const switchProgress = this.switchTimer / SWITCH_DURATION;
    const switchOffset = switchProgress * switchProgress * 0.4;
    this.deathLowering += ((player.isAlive ? 0 : 1) - this.deathLowering) * (1 - Math.exp(-deltaSeconds * 8));
    this.healLowering += ((player.isHealing ? 1 : 0) - this.healLowering) * (1 - Math.exp(-deltaSeconds * 10));

    const pose = ARCHETYPE_POSES[model.archetype] || ARCHETYPE_POSES.rifle;
    const basePosition = this.scratchPose.copy(pose.rest).lerp(pose.aim, this.aimBlend);
    this.viewmodelRoot.position.set(
      basePosition.x + bobX + this.swayX + slashX,
      basePosition.y + bobY + breathY + this.swayY + slashY - reloadLower * 0.12 - switchOffset - this.deathLowering * 0.6 - this.healLowering * 0.35,
      basePosition.z + kick * 0.035 + slashForward,
    );
    this.viewmodelRoot.rotation.set(
      pitchKick * 0.045 - reloadLower * 0.55 + switchOffset * 1.2 + this.swayY * 1.5 + this.healLowering * 0.5 + (model.archetype === 'melee' ? 0.35 : 0),
      this.swayX * 2 + slashYaw,
      reloadLower * 0.35 + this.swayX * 1.5 + bobX * 1.5 + slashRoll,
    );
    this.viewmodelRoot.visible = !this.isScoped && this.deathLowering < 0.98;
  }
}
