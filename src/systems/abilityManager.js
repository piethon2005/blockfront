// =====================================================================
// Ability manager — special abilities dropped by hunted donkeys.
//   PROP HUNT   : you become a map prop (tree, lamp post, crate or oil drum).
//                 Bots ignore you unless you sprint, shoot or get too close.
//   TELEPORT    : [V] blinks you to your crosshair (3 charges).
//   HYPER-SPEED : huge run speed and dashes with no cooldown.
//   DEAD-EYE    : [V] slows the world to a crawl while you aim at full speed.
// Exposes `timeScale` (used by main.js to slow the world) and drives the
// player's ability modifiers every frame.
// Events: ability:granted, ability:activated, ability:teleport,
//         ability:deadeye, ability:end.
// =====================================================================

import * as THREE from 'three';
import { ABILITIES } from '../config.js';
import { events } from '../core/events.js';
import { getPlainMaterial, getSurfaceMaterial } from '../world/materials.js';

const PROP_LAYER = 1;

function buildProp(kind) {
  const group = new THREE.Group();
  const add = (geometry, material, y) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.castShadow = true;
    mesh.layers.set(PROP_LAYER);
    group.add(mesh);
  };
  if (kind === 'TREE') {
    add(new THREE.BoxGeometry(0.9, 2.2, 0.9), getSurfaceMaterial('bark', 0x6b4423), 1.1);
    for (let layer = 0; layer < 3; layer++) add(new THREE.ConeGeometry(2.4 - layer * 0.6, 2.2, 7), getPlainMaterial(layer % 2 ? 0x1fa83a : 0x2fc24a, { flatShading: true }), 2.8 + layer * 1.4);
  } else if (kind === 'LAMP POST') {
    add(new THREE.BoxGeometry(0.22, 3.6, 0.22), getPlainMaterial(0x2a2d33, { metalness: 0.8, roughness: 0.4 }), 1.8);
    add(new THREE.BoxGeometry(0.7, 0.2, 0.7), getPlainMaterial(0x2a2d33, { metalness: 0.8, roughness: 0.4 }), 3.7);
  } else if (kind === 'SUPPLY CRATE') {
    add(new THREE.BoxGeometry(1.6, 1.6, 1.6), getSurfaceMaterial('crate', 0xb98a4a), 0.8);
  } else {
    add(new THREE.CylinderGeometry(0.62, 0.62, 1.5, 16), getPlainMaterial(0x3a5a3a, { metalness: 0.5, roughness: 0.4 }), 0.75);
  }
  return group;
}

export class AbilityManager {
  constructor({ scene, camera, player, physics, gameRenderer }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.physics = physics;
    this.active = null;
    this.slowTimer = 0;
    this.prop = null;
    // Let the sun's shadow camera see the disguise prop (the player camera never renders it).
    gameRenderer.sunLight.shadow.camera.layers.enable(PROP_LAYER);
    events.on('donkey:killed', ({ byPlayer }) => byPlayer && this.grantRandom());
    events.on('player:death', () => this.end());
  }

  get timeScale() {
    return this.slowTimer > 0 ? ABILITIES.deadEye.timeScale : 1;
  }

  get isDeadEye() {
    return this.slowTimer > 0;
  }

  /** HUD snapshot: { definition, timeLeft, charges, slowTimer } or null. */
  get status() {
    if (!this.active) return null;
    return { ...this.active, slowTimer: this.slowTimer };
  }

  grantRandom() {
    const ids = Object.keys(ABILITIES);
    this.grant(ids[Math.floor(Math.random() * ids.length)]);
  }

  grant(abilityId) {
    this.end(true);
    const definition = ABILITIES[abilityId];
    this.active = { definition, timeLeft: definition.duration, charges: definition.charges || 0 };
    if (abilityId === 'propHunt') this.startDisguise();
    events.emit('ability:granted', { ability: definition });
    events.emit('toast', { text: `${definition.icon} ${definition.name}`, style: 'gold' });
    events.emit('notify', { text: definition.description, tone: 'elite' });
  }

  startDisguise() {
    const kinds = ['TREE', 'LAMP POST', 'SUPPLY CRATE', 'OIL DRUM'];
    this.propKind = kinds[Math.floor(Math.random() * kinds.length)];
    this.prop = buildProp(this.propKind);
    this.scene.add(this.prop);
    this.player.isDisguised = true;
    events.emit('ability:activated', { ability: ABILITIES.propHunt, propKind: this.propKind, position: this.player.position.clone() });
  }

  /** [V] pressed. */
  activate() {
    if (!this.active || !this.player.isAlive) return;
    const id = this.active.definition.id;
    if (id === 'propHunt') {
      this.end();
    } else if (id === 'teleport' && this.active.charges > 0) {
      this.teleport();
      this.active.charges--;
      if (this.active.charges <= 0) this.end();
    } else if (id === 'deadEye' && this.active.charges > 0 && this.slowTimer <= 0) {
      this.active.charges--;
      this.slowTimer = ABILITIES.deadEye.slowDuration;
      events.emit('ability:deadeye', { active: true });
    }
  }

  teleport() {
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const range = ABILITIES.teleport.range;
    const hit = this.physics.raycastFirst(origin, direction, range);
    const from = this.player.position.clone();
    const destination = hit ? hit.point.clone().addScaledVector(direction, -0.9) : origin.clone().addScaledVector(direction, range);
    const landedOnTop = hit && ((hit.voxel && hit.voxel.normal.y > 0.7) || (hit.face && hit.face.normal.y > 0.7));
    this.player.position.set(destination.x, landedOnTop ? hit.point.y : Math.max(0, destination.y - this.player.eyeHeight), destination.z);
    this.player.verticalVelocity = 0;
    this.player.isGrounded = false;
    this.physics.resolveHorizontal(this.player.position, this.player.position.y);
    events.emit('ability:teleport', { from, to: this.player.position.clone() });
  }

  end(silent = false) {
    if (!this.active) return;
    const definition = this.active.definition;
    this.active = null;
    if (this.prop) {
      this.scene.remove(this.prop);
      this.prop = null;
    }
    this.player.isDisguised = false;
    if (this.slowTimer > 0) {
      this.slowTimer = 0;
      events.emit('ability:deadeye', { active: false });
    }
    if (!silent) events.emit('ability:end', { ability: definition });
  }

  /** realDeltaSeconds: unscaled frame time. */
  update(realDeltaSeconds) {
    const player = this.player;
    player.abilitySpeedMultiplier = 1;
    player.unlimitedDash = false;
    if (this.slowTimer > 0) {
      this.slowTimer -= realDeltaSeconds;
      if (this.slowTimer <= 0) {
        this.slowTimer = 0;
        events.emit('ability:deadeye', { active: false });
        if (this.active && this.active.definition.id === 'deadEye' && this.active.charges <= 0) this.end();
      }
    }
    if (!this.active) return;
    if (this.slowTimer <= 0) this.active.timeLeft -= realDeltaSeconds;
    const id = this.active.definition.id;
    if (id === 'hyperSpeed') {
      player.abilitySpeedMultiplier = ABILITIES.hyperSpeed.speedMultiplier;
      player.unlimitedDash = true;
    }
    if (this.prop) {
      this.prop.position.set(player.position.x, player.position.y, player.position.z);
      this.prop.rotation.y = player.yaw;
    }
    if (this.active.timeLeft <= 0) this.end();
  }
}
