// =====================================================================
// Donkeys — wandering voxel donkeys that bray across the battlefield.
// Shoot one down and it drops a random special ability for you
// (handled by the AbilityManager via the `donkey:killed` event).
// Hit donkeys panic and gallop away. Bots ignore them.
// Events: donkey:spawn, donkey:bray, donkey:hurt, donkey:killed.
// Multiplayer: the host runs donkey AI and broadcasts snapshots; guests
// show puppets and send hits to the host (net:donkeyHit).
// =====================================================================

import * as THREE from 'three';
import { DONKEY } from '../config.js';
import { events } from '../core/events.js';
import { netState } from '../net/netState.js';

class Donkey {
  constructor(scene, position, id) {
    this.scene = scene;
    this.id = id;
    this.isPuppet = !netState.isAuthority;
    this.netTarget = position.clone();
    this.netYaw = 0;
    this.health = DONKEY.health;
    this.isDead = false;
    this.waypoint = null;
    this.waypointTimer = 0;
    this.panicTimer = 0;
    this.brayTimer = DONKEY.brayIntervalMin + Math.random() * (DONKEY.brayIntervalMax - DONKEY.brayIntervalMin);
    this.walkPhase = Math.random() * 6;
    this.hitFlash = 0;
    this.hitboxes = [];
    this.materials = [];
    this.build();
    this.root.position.copy(position);
  }

  get position() {
    return this.root.position;
  }

  build() {
    const material = (color, roughness = 0.85) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness });
      this.materials.push(mat);
      return mat;
    };
    const coat = material(0x8a8580);
    const belly = material(0xd8d2c8);
    const dark = material(0x3a3532);
    const hoof = material(0x1e1c1a, 0.5);
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const box = (parent, width, height, depth, mat, x, y, z, rotationX = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rotationX;
      mesh.castShadow = true;
      mesh.userData.donkey = this;
      parent.add(mesh);
      this.hitboxes.push(mesh);
      return mesh;
    };
    box(this.body, 0.72, 0.78, 1.5, coat, 0, 1.15, 0);
    box(this.body, 0.6, 0.12, 1.2, belly, 0, 0.74, 0);
    box(this.body, 0.16, 0.12, 1.3, dark, 0, 1.58, 0.05);            // dorsal stripe
    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 1.45, 0.75);
    this.body.add(this.headGroup);
    box(this.headGroup, 0.36, 0.7, 0.36, coat, 0, 0.25, 0.08, -0.5);   // neck
    box(this.headGroup, 0.12, 0.5, 0.1, dark, 0, 0.38, -0.08, -0.5);   // mane
    box(this.headGroup, 0.4, 0.42, 0.62, coat, 0, 0.6, 0.42);          // head
    box(this.headGroup, 0.38, 0.3, 0.26, belly, 0, 0.5, 0.78);         // muzzle
    box(this.headGroup, 0.06, 0.06, 0.04, dark, -0.1, 0.5, 0.92);
    box(this.headGroup, 0.06, 0.06, 0.04, dark, 0.1, 0.5, 0.92);
    this.ears = [box(this.headGroup, 0.1, 0.5, 0.08, coat, -0.13, 1.0, 0.3), box(this.headGroup, 0.1, 0.5, 0.08, coat, 0.13, 1.0, 0.3)];
    this.legs = [];
    for (const [x, z] of [[-0.22, 0.55], [0.22, 0.55], [-0.22, -0.55], [0.22, -0.55]]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.85, z);
      box(pivot, 0.16, 0.75, 0.16, coat, 0, -0.37, 0);
      box(pivot, 0.18, 0.12, 0.2, hoof, 0, -0.78, 0.01);
      this.body.add(pivot);
      this.legs.push(pivot);
    }
    this.tail = new THREE.Group();
    this.tail.position.set(0, 1.4, -0.75);
    box(this.tail, 0.07, 0.07, 0.5, coat, 0, -0.1, -0.2, 0.9);
    box(this.tail, 0.14, 0.18, 0.14, dark, 0, -0.33, -0.36);
    this.body.add(this.tail);
    this.scene.add(this.root);
  }

  takeDamage(amount) {
    if (this.isDead) return false;
    this.health -= amount;
    this.hitFlash = 1;
    this.panicTimer = 3;
    this.waypoint = null;
    events.emit('donkey:hurt', { position: this.position.clone() });
    if (this.health <= 0) {
      this.isDead = true;
      return true;
    }
    return false;
  }

  /** Guest: follow host snapshots and animate from the observed motion. */
  updatePuppet(deltaSeconds) {
    const previousX = this.position.x;
    const previousZ = this.position.z;
    this.position.lerp(this.netTarget, Math.min(1, deltaSeconds * 8));
    let difference = (this.netYaw - this.root.rotation.y) % (Math.PI * 2);
    if (difference > Math.PI) difference -= Math.PI * 2;
    if (difference < -Math.PI) difference += Math.PI * 2;
    this.root.rotation.y += difference * Math.min(1, deltaSeconds * 6);
    const speed = Math.hypot(this.position.x - previousX, this.position.z - previousZ) / Math.max(deltaSeconds, 1e-4);
    this.walkPhase += deltaSeconds * (3 + speed * 2.5);
    const swing = Math.sin(this.walkPhase) * 0.5 * (speed > 0.3 ? 1 : 0);
    this.legs[0].rotation.x = swing;
    this.legs[3].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.legs[2].rotation.x = -swing;
    this.headGroup.rotation.x = speed < 0.3 ? 0.6 : 0;
    this.tail.rotation.y = Math.sin(this.walkPhase * 0.9) * 0.4;
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - deltaSeconds * 6);
      for (const mat of this.materials) mat.emissive.setRGB(this.hitFlash, this.hitFlash * 0.3, this.hitFlash * 0.2);
    }
  }

  update(deltaSeconds, physics) {
    if (this.isPuppet) {
      this.updatePuppet(deltaSeconds);
      return;
    }
    this.brayTimer -= deltaSeconds;
    if (this.brayTimer <= 0) {
      this.brayTimer = DONKEY.brayIntervalMin + Math.random() * (DONKEY.brayIntervalMax - DONKEY.brayIntervalMin);
      this.brayAnimation = 1;
      events.emit('donkey:bray', { position: this.position.clone().setY(1.6) });
    }
    this.panicTimer -= deltaSeconds;
    this.waypointTimer -= deltaSeconds;
    const reached = this.waypoint && Math.hypot(this.waypoint.x - this.position.x, this.waypoint.z - this.position.z) < 1.5;
    if (!this.waypoint || reached || this.waypointTimer <= 0) {
      const area = DONKEY.spawnAreaHalfSize;
      const range = this.panicTimer > 0 ? 25 : 12;
      this.waypoint = {
        x: THREE.MathUtils.clamp(this.position.x + (Math.random() - 0.5) * range * 2, -area, area),
        z: THREE.MathUtils.clamp(this.position.z + (Math.random() - 0.5) * range * 2, -area, area),
      };
      this.waypointTimer = 5 + Math.random() * 4;
      this.grazeTimer = this.panicTimer > 0 ? 0 : Math.random() * 3;
    }
    this.grazeTimer = (this.grazeTimer || 0) - deltaSeconds;
    const grazing = this.grazeTimer > 0;
    const speed = grazing ? 0 : DONKEY.speed * (this.panicTimer > 0 ? 3 : 1);
    const offsetX = this.waypoint.x - this.position.x;
    const offsetZ = this.waypoint.z - this.position.z;
    const length = Math.hypot(offsetX, offsetZ) || 1;
    this.position.x += (offsetX / length) * speed * deltaSeconds;
    this.position.z += (offsetZ / length) * speed * deltaSeconds;
    physics.resolveHorizontal(this.position, 0, 0.6);
    if (speed > 0) {
      let difference = (Math.atan2(offsetX, offsetZ) - this.root.rotation.y) % (Math.PI * 2);
      if (difference > Math.PI) difference -= Math.PI * 2;
      if (difference < -Math.PI) difference += Math.PI * 2;
      this.root.rotation.y += difference * Math.min(1, deltaSeconds * 4);
    }

    // Animation: trot, grazing head dip, ear flicks, tail swish, bray head-toss.
    const moving = speed > 0 ? 1 : 0;
    this.walkPhase += deltaSeconds * (3 + speed * 2.5);
    const swing = Math.sin(this.walkPhase) * 0.5 * moving;
    this.legs[0].rotation.x = swing;
    this.legs[3].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.legs[2].rotation.x = -swing;
    this.brayAnimation = Math.max(0, (this.brayAnimation || 0) - deltaSeconds * 0.8);
    this.headGroup.rotation.x = grazing ? 0.75 : -Math.sin(this.brayAnimation * Math.PI) * 0.5;
    this.ears.forEach((ear, index) => { ear.rotation.z = Math.sin(this.walkPhase * 0.7 + index * 2) * 0.15; });
    this.tail.rotation.y = Math.sin(this.walkPhase * 0.9) * 0.4;
    this.body.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.05 * moving;

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - deltaSeconds * 6);
      for (const mat of this.materials) mat.emissive.setRGB(this.hitFlash, this.hitFlash * 0.3, this.hitFlash * 0.2);
    }
  }

  dispose() {
    this.scene.remove(this.root);
  }
}

export class DonkeyManager {
  constructor({ scene, physics }) {
    this.scene = scene;
    this.physics = physics;
    this.donkeys = [];
    this.spawnTimer = 0;
    this.nextId = 1;
  }

  // ------------------------------------------------------------------ network mirror
  snapshot() {
    return this.donkeys.map((donkey) => [donkey.id, +donkey.position.x.toFixed(2), +donkey.position.z.toFixed(2), +donkey.root.rotation.y.toFixed(2)]);
  }

  applySnapshot(list) {
    for (const [id, x, z, yaw] of list) {
      let donkey = this.donkeys.find((candidate) => candidate.id === id);
      if (!donkey) {
        donkey = new Donkey(this.scene, new THREE.Vector3(x, 0, z), id);
        this.donkeys.push(donkey);
      }
      donkey.netTarget.set(x, 0, z);
      donkey.netYaw = yaw;
    }
  }

  /** Guest: the host reported a kill. */
  mirrorKill(id, byPlayer) {
    const donkey = this.donkeys.find((candidate) => candidate.id === id);
    const position = donkey ? donkey.position.clone() : new THREE.Vector3();
    if (donkey) {
      donkey.dispose();
      this.donkeys.splice(this.donkeys.indexOf(donkey), 1);
    }
    events.emit('donkey:killed', { id, position, byPlayer });
  }

  reset() {
    this.donkeys.forEach((donkey) => donkey.dispose());
    this.donkeys = [];
    this.spawnTimer = 6;
  }

  get hitTargets() {
    const targets = [];
    for (const donkey of this.donkeys) if (!donkey.isDead) targets.push(...donkey.hitboxes);
    return targets;
  }

  spawnDonkey() {
    const area = DONKEY.spawnAreaHalfSize;
    for (let attempt = 0; attempt < 40; attempt++) {
      const position = new THREE.Vector3((Math.random() * 2 - 1) * area, 0, (Math.random() * 2 - 1) * area);
      if (this.physics.isPointBlocked(position.x, position.z, 2)) continue;
      const donkey = new Donkey(this.scene, position, this.nextId++);
      this.donkeys.push(donkey);
      events.emit('donkey:spawn', { id: donkey.id, position: position.clone() });
      return donkey;
    }
    return null;
  }

  /** Apply damage from a shot. Returns true when the donkey died. killerPeerId = remote shooter (host only). */
  damage(donkey, amount, byPlayer, killerPeerId = null) {
    if (!netState.isAuthority) {
      donkey.hitFlash = 1;
      events.emit('net:donkeyHit', { id: donkey.id, amount });
      return false;
    }
    if (!donkey.takeDamage(amount)) return false;
    events.emit('donkey:killed', { id: donkey.id, position: donkey.position.clone(), byPlayer, killerPeerId });
    donkey.dispose();
    this.donkeys.splice(this.donkeys.indexOf(donkey), 1);
    this.spawnTimer = DONKEY.respawnDelay;
    return true;
  }

  update(deltaSeconds) {
    if (netState.isAuthority) this.spawnTimer -= deltaSeconds;
    if (this.spawnTimer <= 0 && this.donkeys.length < DONKEY.maxAlive) {
      this.spawnDonkey();
      this.spawnTimer = DONKEY.respawnDelay * 0.5;
    }
    for (const donkey of this.donkeys) donkey.update(deltaSeconds, this.physics);
  }
}
