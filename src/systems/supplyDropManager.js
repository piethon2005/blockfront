// =====================================================================
// Supply drops — timed cargo pods that parachute into the arena.
//   INCOMING : a red smoke beacon marks the landing zone, the pod falls
//              under a striped parachute.
//   LANDED   : the pod becomes solid cover. Press [E] nearby to open it.
//   OPENED   : elite loot bursts out (sniper / auto pistol / LMG, heavy
//              armor, med-kits, ammo). The empty pod lingers, then leaves.
// Bots are drawn toward active drops via `pointOfInterest`.
// Multiplayer: only the host launches drops and spawns their loot; guests
// mirror the pod (launchDrop(position) / openDrop) and request opening.
// =====================================================================

import * as THREE from 'three';
import { SUPPLY_DROP, arenaScale } from '../config.js';
import { events } from '../core/events.js';
import { createWeaponItem } from '../entities/inventory.js';
import { getPlainMaterial, getSurfaceMaterial, applyWorldUVs } from '../world/materials.js';
import { netState } from '../net/netState.js';

const STATE = { INCOMING: 'incoming', LANDED: 'landed', OPENED: 'opened' };

function buildPod() {
  const pod = new THREE.Group();
  const body = new THREE.Group();
  pod.add(body);
  const shell = getSurfaceMaterial('metal', 0x3d4a33);
  const trim = getPlainMaterial(0x1b1d17, { roughness: 0.5, metalness: 0.7 });
  const hazard = getPlainMaterial(0xffb21a, { roughness: 0.5, emissive: 0xffb21a, emissiveIntensity: 0.5 });
  const addBox = (parent, width, height, depth, material, x, y, z) => {
    const mesh = new THREE.Mesh(applyWorldUVs(new THREE.BoxGeometry(width, height, depth), width, height, depth, 1.5), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  addBox(body, 2.2, 1.3, 2.2, shell, 0, 0.65, 0);
  for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addBox(body, 0.2, 1.4, 0.2, trim, corner[0] * 1.05, 0.7, corner[1] * 1.05);
  addBox(body, 2.26, 0.14, 2.26, hazard, 0, 0.35, 0);
  const lid = new THREE.Group();
  lid.position.set(0, 1.3, -1.1);
  addBox(lid, 2.3, 0.22, 2.3, shell, 0, 0.11, 1.1);
  addBox(lid, 0.5, 0.06, 0.5, hazard, 0, 0.25, 1.1);
  body.add(lid);
  const beaconMaterial = new THREE.MeshStandardMaterial({ color: 0xff3a2a, emissive: 0xff3a2a, emissiveIntensity: 4 });
  const beacon = addBox(lid, 0.18, 0.2, 0.18, beaconMaterial, 0.85, 0.3, 1.95);

  // Parachute: striped half-dome with suspension lines.
  const chute = new THREE.Group();
  const canopyGeometry = new THREE.SphereGeometry(3.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.4);
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide, vertexColors: true });
  const colors = [];
  const positionAttribute = canopyGeometry.attributes.position;
  const stripeA = new THREE.Color(0xd8d2c0);
  const stripeB = new THREE.Color(0xc85a1e);
  for (let index = 0; index < positionAttribute.count; index++) {
    const angle = Math.atan2(positionAttribute.getZ(index), positionAttribute.getX(index));
    const stripe = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 12) % 2 ? stripeA : stripeB;
    colors.push(stripe.r, stripe.g, stripe.b);
  }
  canopyGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const canopy = new THREE.Mesh(canopyGeometry, canopyMaterial);
  canopy.position.y = 6;
  canopy.castShadow = true;
  chute.add(canopy);
  const linePoints = [];
  for (let line = 0; line < 8; line++) {
    const angle = (line / 8) * Math.PI * 2;
    linePoints.push(new THREE.Vector3(Math.cos(angle) * 1, 1.4, Math.sin(angle) * 1), new THREE.Vector3(Math.cos(angle) * 2.9, 7.2, Math.sin(angle) * 2.9));
  }
  chute.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePoints), new THREE.LineBasicMaterial({ color: 0x222222 })));
  pod.add(chute);

  return { pod, body, lid, chute, beacon };
}

export class SupplyDropManager {
  constructor({ scene, physics, loot }) {
    this.scene = scene;
    this.physics = physics;
    this.loot = loot;
    this.drop = null;
    this.reset();
  }

  reset() {
    this.removeDrop();
    this.nextDropTimer = SUPPLY_DROP.firstDropDelay;
  }

  /** Position bots should converge on (null when no drop is active). */
  get pointOfInterest() {
    return this.drop && this.drop.state !== STATE.OPENED ? this.drop.position : null;
  }

  get activeDrop() {
    return this.drop;
  }

  removeDrop() {
    if (!this.drop) return;
    this.scene.remove(this.drop.visual.pod);
    if (this.drop.collider) this.drop.collider.enabled = false;
    if (this.drop.solidMesh) this.physics.removeSolidMesh(this.drop.solidMesh);
    this.drop = null;
  }

  pickLandingSpot() {
    const limit = SUPPLY_DROP.landingAreaHalfSize * arenaScale();
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = (Math.random() * 2 - 1) * limit;
      const z = (Math.random() * 2 - 1) * limit;
      if (!this.physics.isPointBlocked(x, z, 2.5)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(0, 0, 0);
  }

  launchDrop(forcedPosition = null) {
    this.removeDrop();
    const position = forcedPosition ? new THREE.Vector3(forcedPosition.x, 0, forcedPosition.z) : this.pickLandingSpot();
    const visual = buildPod();
    visual.pod.position.set(position.x, SUPPLY_DROP.dropHeight, position.z);
    this.scene.add(visual.pod);
    this.drop = { state: STATE.INCOMING, position, visual, fallTimer: SUPPLY_DROP.fallTime, lingerTimer: SUPPLY_DROP.lingerTime, age: 0, collider: null, solidMesh: null, chuteDetachTime: 0 };
    events.emit('supply:incoming', { position: position.clone(), eta: SUPPLY_DROP.fallTime });
    events.emit('toast', { text: 'SUPPLY DROP INBOUND', style: 'gold' });
    events.emit('notify', { text: 'FOLLOW THE RED SMOKE — ELITE LOOT', tone: 'elite' });
  }

  land() {
    const drop = this.drop;
    drop.state = STATE.LANDED;
    drop.visual.pod.position.y = 0;
    drop.collider = this.physics.addBoxCollider({ x: drop.position.x, z: drop.position.z, width: 2.2, depth: 2.2, bottom: 0, top: 1.5 });
    drop.solidMesh = drop.visual.body.children[0];
    this.physics.addSolidMesh(drop.solidMesh);
    drop.chuteDetachTime = 0.001;
    events.emit('supply:landed', { position: drop.position.clone() });
  }

  /** Prompt for the HUD when standing at a closed landed pod. */
  getPrompt(player) {
    const drop = this.drop;
    if (!drop || drop.state !== STATE.LANDED || !player.isAlive) return null;
    if (Math.hypot(player.position.x - drop.position.x, player.position.z - drop.position.z) > SUPPLY_DROP.interactRadius) return null;
    return { text: 'OPEN SUPPLY DROP', rarity: 'elite', isElite: true };
  }

  /** [E] pressed. Returns true if handled. */
  interact(player) {
    if (!this.getPrompt(player)) return false;
    if (!netState.isAuthority) {
      events.emit('net:supplyOpen', {});
      return true;
    }
    this.openDrop(true);
    return true;
  }

  /** Open the pod. Only the authority spawns the loot; guests just play the visuals. */
  openDrop(spawnLoot) {
    const drop = this.drop;
    if (!drop || drop.state === STATE.OPENED) return;
    drop.state = STATE.OPENED;
    drop.openAge = 0;
    events.emit('supply:opened', { position: drop.position.clone() });
    events.emit('toast', { text: 'SUPPLY DROP SECURED', style: 'gold' });
    if (!spawnLoot) return;

    const eliteId = SUPPLY_DROP.eliteWeapons[Math.floor(Math.random() * SUPPLY_DROP.eliteWeapons.length)];
    const around = (angle, distance = 2.4) => new THREE.Vector3(drop.position.x + Math.cos(angle) * distance, 0, drop.position.z + Math.sin(angle) * distance);
    this.loot.spawnItem({ kind: 'weapon', weaponItem: createWeaponItem(eliteId), position: around(0), lifetime: 90 });
    this.loot.spawnItem({ kind: 'armor', armorTier: 2, position: around(Math.PI * 0.5), lifetime: 90 });
    this.loot.spawnItem({ kind: 'medkit', position: around(Math.PI), lifetime: 90 });
    this.loot.spawnItem({ kind: 'medkit', position: around(Math.PI * 1.25), lifetime: 90 });
    this.loot.spawnItem({ kind: 'ammo', position: around(Math.PI * 1.5), lifetime: 90 });
  }

  update(deltaSeconds) {
    if (netState.isAuthority) this.nextDropTimer -= deltaSeconds;
    if (this.nextDropTimer <= 0) {
      this.nextDropTimer = SUPPLY_DROP.interval;
      this.launchDrop();
    }
    const drop = this.drop;
    if (!drop) return;
    drop.age += deltaSeconds;
    const { pod, chute, lid, beacon } = drop.visual;
    beacon.material.emissiveIntensity = 2 + Math.max(0, Math.sin(drop.age * 8)) * 6;

    if (drop.state === STATE.INCOMING) {
      drop.fallTimer -= deltaSeconds;
      const progress = 1 - Math.max(0, drop.fallTimer) / SUPPLY_DROP.fallTime;
      pod.position.y = SUPPLY_DROP.dropHeight * (1 - progress);
      // Pendulum sway under the canopy.
      pod.rotation.z = Math.sin(drop.age * 1.3) * 0.08 * (1 - progress);
      pod.rotation.x = Math.cos(drop.age * 1.1) * 0.06 * (1 - progress);
      chute.rotation.y += deltaSeconds * 0.4;
      if (drop.fallTimer <= 0) this.land();
      return;
    }

    pod.rotation.set(0, pod.rotation.y, 0);
    if (drop.chuteDetachTime > 0 && chute.visible) {
      // Collapsing parachute drifts away and sinks.
      drop.chuteDetachTime += deltaSeconds;
      chute.position.x += deltaSeconds * 3;
      chute.position.y -= deltaSeconds * 2.4;
      chute.scale.y = Math.max(0.05, 1 - drop.chuteDetachTime * 0.6);
      chute.rotation.z = Math.min(1.2, drop.chuteDetachTime * 0.8);
      if (drop.chuteDetachTime > 2.2) chute.visible = false;
    }

    if (drop.state === STATE.OPENED) {
      drop.openAge += deltaSeconds;
      lid.rotation.x = -Math.min(1.9, drop.openAge * 6);
      drop.lingerTimer -= deltaSeconds;
      if (drop.lingerTimer <= 0) this.removeDrop();
    }
  }
}
