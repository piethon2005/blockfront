// =====================================================================
// Combat pet — a voxel attack dog in a tactical vest.
//   FOLLOW : trots at the player's side, sprints to catch up.
//   ATTACK : locks onto the nearest visible enemy bot within range (and
//            within leash distance of the player), charges and bites.
//   DEAD   : topples over, respawns beside the player after a delay.
// Bites are credited to the player, so they count as your eliminations.
// Events: pet:bark, pet:bite, pet:hurt, pet:death, pet:respawn.
// =====================================================================

import * as THREE from 'three';
import { PET, PLAYER_TEAM } from '../config.js';
import { events } from '../core/events.js';

const PET_STATE = { FOLLOW: 'follow', ATTACK: 'attack', DEAD: 'dead' };

const shortestAngle = (from, to) => {
  let difference = (to - from) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
};

export class Pet {
  constructor({ scene, isPuppet = false }) {
    this.scene = scene;
    // Puppet = another player's dog in an online match (visual only).
    this.isPuppet = isPuppet;
    this.netTarget = null;
    this.team = PLAYER_TEAM;
    this.name = PET.name;
    this.health = PET.maxHealth;
    this.state = PET_STATE.FOLLOW;
    this.target = null;
    this.biteCooldown = 0;
    this.barkCooldown = 0;
    this.deathTimer = 0;
    this.walkPhase = 0;
    this.currentSpeed = 0;
    this.hitFlash = 0;
    this.flashMaterials = [];
    this.hitboxes = [];
    this.scratchEye = new THREE.Vector3();
    this.scratchTarget = new THREE.Vector3();
    this.buildModel();
  }

  get position() {
    return this.root.position;
  }

  get isAlive() {
    return this.state !== PET_STATE.DEAD;
  }

  buildModel() {
    const material = (color, roughness = 0.8) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness, envMapIntensity: 0.5 });
      this.flashMaterials.push(mat);
      return mat;
    };
    const tan = material(0xb07a3e);
    const black = material(0x1e1a16);
    const vest = material(0x3a4a2a);
    const collar = material(0xffb21a, 0.4);
    const nose = material(0x0a0a0a, 0.3);

    this.root = new THREE.Group();
    this.figure = new THREE.Group();
    this.root.add(this.figure);
    const box = (parent, width, height, depth, mat, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.userData.pet = this;
      parent.add(mesh);
      this.hitboxes.push(mesh);
      return mesh;
    };
    // Torso with black saddle and a tactical vest.
    box(this.figure, 0.48, 0.46, 1.1, tan, 0, 0.72, 0);
    box(this.figure, 0.5, 0.16, 0.8, black, 0, 0.98, -0.05);
    box(this.figure, 0.54, 0.3, 0.55, vest, 0, 0.78, 0.05);
    box(this.figure, 0.56, 0.06, 0.2, material(0x4a9cf0, 0.5), 0, 0.95, 0.05);   // team stripe
    // Head group (for bite lunges).
    this.head = new THREE.Group();
    this.head.position.set(0, 1.0, 0.58);
    this.figure.add(this.head);
    box(this.head, 0.36, 0.34, 0.36, tan, 0, 0.08, 0.1);
    box(this.head, 0.22, 0.18, 0.28, tan, 0, 0.0, 0.38);
    box(this.head, 0.1, 0.08, 0.06, nose, 0, 0.06, 0.53);
    box(this.head, 0.09, 0.2, 0.06, black, -0.12, 0.32, 0.02);
    box(this.head, 0.09, 0.2, 0.06, black, 0.12, 0.32, 0.02);
    box(this.head, 0.38, 0.06, 0.08, collar, 0, -0.08, -0.04);
    // Legs on pivots.
    this.legs = [];
    for (const [x, z] of [[-0.16, 0.42], [0.16, 0.42], [-0.16, -0.42], [0.16, -0.42]]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.55, z);
      box(pivot, 0.13, 0.55, 0.14, tan, 0, -0.27, 0);
      box(pivot, 0.15, 0.08, 0.18, black, 0, -0.52, 0.02);
      this.figure.add(pivot);
      this.legs.push(pivot);
    }
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.88, -0.56);
    box(this.tail, 0.09, 0.09, 0.42, black, 0, 0.05, -0.18);
    this.tail.rotation.x = 0.6;
    this.figure.add(this.tail);
    this.scene.add(this.root);
  }

  // ------------------------------------------------------------------ lifecycle
  spawnNear(player) {
    const angle = player.yaw + Math.PI * 0.75;
    this.root.position.set(player.position.x - Math.sin(angle) * 2, 0, player.position.z - Math.cos(angle) * 2);
    this.root.visible = true;
    this.figure.rotation.set(0, 0, 0);
    this.figure.position.set(0, 0, 0);
    this.health = PET.maxHealth;
    this.state = PET_STATE.FOLLOW;
    this.target = null;
  }

  takeDamage(amount, attackerName) {
    if (!this.isAlive) return false;
    this.health -= amount;
    this.hitFlash = 1;
    events.emit('pet:hurt', { amount, health: Math.max(0, this.health), position: this.position.clone() });
    if (this.health <= 0) {
      this.health = 0;
      this.state = PET_STATE.DEAD;
      this.deathTimer = 0;
      events.emit('pet:death', { attackerName, position: this.position.clone() });
      events.emit('notify', { text: `${PET.name} IS DOWN — BACK IN ${PET.respawnDelay}s`, tone: 'danger' });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ network
  netSnapshot() {
    return [+this.position.x.toFixed(2), +this.position.z.toFixed(2), +this.root.rotation.y.toFixed(2), this.isAlive ? 1 : 0, this.state === PET_STATE.ATTACK ? 1 : 0];
  }

  /** Puppet: [x, z, yaw, alive, attacking] */
  applyNetState([x, z, yaw, alive, attacking]) {
    if (!this.netTarget) this.root.position.set(x, 0, z);
    this.netTarget = { x, z, yaw };
    if (alive && !this.isAlive) {
      this.root.visible = true;
      this.figure.rotation.set(0, 0, 0);
      this.root.position.set(x, 0, z);
      this.health = PET.maxHealth;
    }
    if (!alive && this.isAlive) this.deathTimer = 0;
    this.state = !alive ? PET_STATE.DEAD : attacking ? PET_STATE.ATTACK : PET_STATE.FOLLOW;
  }

  updatePuppet(deltaSeconds) {
    if (!this.isAlive) {
      this.deathTimer += deltaSeconds;
      this.figure.rotation.z = Math.min(1, this.deathTimer / 0.4) * (Math.PI / 2);
      if (this.deathTimer > 2) this.root.visible = false;
      return;
    }
    if (!this.netTarget) return;
    const position = this.position;
    const previousX = position.x;
    const previousZ = position.z;
    const blend = 1 - Math.exp(-deltaSeconds * 12);
    if (Math.hypot(this.netTarget.x - position.x, this.netTarget.z - position.z) > 15) position.set(this.netTarget.x, 0, this.netTarget.z);
    position.x += (this.netTarget.x - position.x) * blend;
    position.z += (this.netTarget.z - position.z) * blend;
    this.root.rotation.y += shortestAngle(this.root.rotation.y, this.netTarget.yaw) * blend;
    this.currentSpeed = Math.hypot(position.x - previousX, position.z - previousZ) / Math.max(deltaSeconds, 1e-4);
    this.animate(deltaSeconds);
  }

  dispose() {
    this.scene.remove(this.root);
  }

  // ------------------------------------------------------------------ per frame
  /** world: { player, bots, physics, combat, disabled } */
  update(deltaSeconds, world) {
    if (this.isPuppet) {
      this.updatePuppet(deltaSeconds);
      return;
    }
    const { player } = world;
    this.team = player.team;
    this.updateHitFlash(deltaSeconds);
    if (!this.isAlive) {
      this.deathTimer += deltaSeconds;
      const fall = Math.min(1, this.deathTimer / 0.4);
      this.figure.rotation.z = fall * (Math.PI / 2);
      if (this.deathTimer > 2) this.root.visible = false;
      if (this.deathTimer > PET.respawnDelay && player.isAlive) {
        this.spawnNear(player);
        events.emit('pet:respawn', {});
      }
      return;
    }

    this.biteCooldown -= deltaSeconds;
    this.barkCooldown -= deltaSeconds;
    const position = this.position;
    const distanceToPlayer = Math.hypot(player.position.x - position.x, player.position.z - position.z);
    if (distanceToPlayer > 45) this.spawnNear(player); // teleported away: catch up instantly

    // Acquire / validate target.
    if (this.target && (this.target.isDead || Math.hypot(this.target.position.x - player.position.x, this.target.position.z - player.position.z) > PET.leashDistance)) {
      this.target = null;
    }
    if (!this.target && player.isAlive) this.target = this.findTarget(world);
    this.state = this.target ? PET_STATE.ATTACK : PET_STATE.FOLLOW;

    let goalX;
    let goalZ;
    let speed = 0;
    if (this.state === PET_STATE.ATTACK) {
      goalX = this.target.position.x;
      goalZ = this.target.position.z;
      const distance = Math.hypot(goalX - position.x, goalZ - position.z);
      speed = distance > PET.biteRange * 0.8 ? PET.runSpeed : 0;
      if (distance <= PET.biteRange && this.biteCooldown <= 0) this.bite(world);
    } else {
      // Heel position: just behind and to the left of the player.
      const heelAngle = player.yaw + Math.PI * 0.8;
      goalX = player.position.x - Math.sin(heelAngle) * PET.followDistance;
      goalZ = player.position.z - Math.cos(heelAngle) * PET.followDistance;
      const distance = Math.hypot(goalX - position.x, goalZ - position.z);
      speed = distance > 7 ? PET.runSpeed : distance > 0.8 ? PET.walkSpeed * Math.min(1, distance / 2) : 0;
    }

    const offsetX = goalX - position.x;
    const offsetZ = goalZ - position.z;
    const length = Math.hypot(offsetX, offsetZ) || 1;
    const previousX = position.x;
    const previousZ = position.z;
    if (speed > 0) {
      position.x += (offsetX / length) * speed * deltaSeconds;
      position.z += (offsetZ / length) * speed * deltaSeconds;
      this.root.rotation.y += shortestAngle(this.root.rotation.y, Math.atan2(offsetX, offsetZ)) * Math.min(1, deltaSeconds * 10);
    } else if (this.state === PET_STATE.FOLLOW) {
      this.root.rotation.y += shortestAngle(this.root.rotation.y, player.yaw + Math.PI) * Math.min(1, deltaSeconds * 3);
    }
    world.physics.resolveHorizontal(position, 0, 0.35);
    this.currentSpeed = Math.hypot(position.x - previousX, position.z - previousZ) / Math.max(deltaSeconds, 1e-4);
    this.animate(deltaSeconds);
  }

  findTarget(world) {
    let best = null;
    let bestDistance = PET.aggroRange;
    const eye = this.scratchEye.set(this.position.x, 1.0, this.position.z);
    for (const bot of world.bots.concat(world.remotePlayers || [])) {
      if (bot.isDead || bot.team === this.team || bot.isDisguised) continue;
      const distance = Math.hypot(bot.position.x - this.position.x, bot.position.z - this.position.z);
      if (distance >= bestDistance) continue;
      if (Math.hypot(bot.position.x - world.player.position.x, bot.position.z - world.player.position.z) > PET.leashDistance) continue;
      if (!world.physics.hasLineOfSight(eye, this.scratchTarget.set(bot.position.x, 1.5, bot.position.z))) continue;
      best = bot;
      bestDistance = distance;
    }
    if (best && this.barkCooldown <= 0) {
      this.barkCooldown = 2.5;
      events.emit('pet:bark', { position: this.position.clone() });
    }
    return best;
  }

  bite(world) {
    this.biteCooldown = PET.biteInterval;
    this.lungeTimer = 0.25;
    const point = this.target.position.clone().setY(1.2);
    events.emit('pet:bite', { position: point });
    world.combat.damageBot(this.target, PET.biteDamage, world.player, { weaponName: 'K9', weaponId: 'pet', point });
  }

  animate(deltaSeconds) {
    const moveAmount = Math.min(1, this.currentSpeed / PET.runSpeed);
    this.walkPhase += deltaSeconds * (6 + this.currentSpeed * 1.6);
    const swing = Math.sin(this.walkPhase) * 0.8 * moveAmount;
    this.legs[0].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.legs[2].rotation.x = -swing;
    this.legs[3].rotation.x = swing;
    this.figure.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.06 * moveAmount;
    this.tail.rotation.y = Math.sin(this.walkPhase * (this.state === PET_STATE.FOLLOW ? 1.6 : 0.6)) * 0.5;
    this.lungeTimer = Math.max(0, (this.lungeTimer || 0) - deltaSeconds);
    this.head.position.z = 0.58 + Math.sin((this.lungeTimer / 0.25) * Math.PI) * 0.22;
    this.head.rotation.x = this.state === PET_STATE.ATTACK ? 0.15 : -0.05 + Math.sin(this.walkPhase * 0.25) * 0.05;
  }

  updateHitFlash(deltaSeconds) {
    if (this.hitFlash <= 0) return;
    this.hitFlash = Math.max(0, this.hitFlash - deltaSeconds * 6);
    for (const material of this.flashMaterials) material.emissive.setRGB(this.hitFlash, this.hitFlash * 0.2, this.hitFlash * 0.15);
  }
}
