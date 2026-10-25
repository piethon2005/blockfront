// =====================================================================
// Hazard manager — explosive barrels: a new gameplay mechanic that also
// showcases the explosion audio/VFX hooks.
// Shoot a barrel enough and it explodes, dealing falloff damage in a radius
// (credited to whoever shot it), chain-reacting into nearby barrels, then
// respawning after a delay.
// =====================================================================

import * as THREE from 'three';
import { HAZARDS } from '../config.js';
import { events } from '../core/events.js';
import { createCanvasTexture } from '../world/materials.js';
import { netState } from '../net/netState.js';

let barrelAssets = null;
function getBarrelAssets() {
  if (barrelAssets) return barrelAssets;
  const stripeTexture = createCanvasTexture(128, (context, size) => {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#bdbdbd';
    context.fillRect(0, size * 0.18, size, size * 0.06);
    context.fillRect(0, size * 0.76, size, size * 0.06);
    // Hazard label.
    context.fillStyle = '#ffd23f';
    context.fillRect(size * 0.3, size * 0.36, size * 0.4, size * 0.28);
    context.fillStyle = '#1a1a1a';
    context.beginPath();
    context.moveTo(size * 0.5, size * 0.39);
    context.lineTo(size * 0.62, size * 0.6);
    context.lineTo(size * 0.38, size * 0.6);
    context.closePath();
    context.fill();
  });
  barrelAssets = {
    bodyGeometry: new THREE.CylinderGeometry(0.62, 0.62, 1.5, 18),
    rimGeometry: new THREE.TorusGeometry(0.62, 0.05, 6, 24).rotateX(Math.PI / 2),
    bodyMaterial: new THREE.MeshStandardMaterial({ color: 0xd12d22, map: stripeTexture, roughness: 0.42, metalness: 0.55 }),
    rimMaterial: new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.4, metalness: 0.8 }),
  };
  return barrelAssets;
}

class ExplosiveBarrel {
  constructor({ scene, physics, x, z }) {
    const assets = getBarrelAssets();
    this.scene = scene;
    this.physics = physics;
    this.position = new THREE.Vector3(x, 0, z);
    this.health = HAZARDS.barrelHealth;
    this.isDestroyed = false;
    this.respawnTimer = 0;
    this.pendingDetonation = null;
    this.flash = 0;

    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    this.bodyMesh = new THREE.Mesh(assets.bodyGeometry, assets.bodyMaterial.clone());
    this.bodyMesh.position.y = 0.75;
    this.bodyMesh.castShadow = this.bodyMesh.receiveShadow = true;
    this.bodyMesh.userData.barrel = this;
    this.group.add(this.bodyMesh);
    for (const rimHeight of [0.05, 1.45]) {
      const rim = new THREE.Mesh(assets.rimGeometry, assets.rimMaterial);
      rim.position.y = rimHeight;
      this.group.add(rim);
    }
    scene.add(this.group);

    this.collider = physics.addBoxCollider({ x, z, width: 1.2, depth: 1.2, bottom: 0, top: 1.5 });
    physics.addSolidMesh(this.bodyMesh);
  }

  /** Returns true if this damage made the barrel detonate. */
  takeDamage(amount, attacker) {
    if (this.isDestroyed || this.pendingDetonation) return false;
    if (!netState.isAuthority) {
      // Guests: show the hit, let the host decide whether it blows.
      this.flash = 1;
      events.emit('barrel:hit', { barrel: this, point: this.position.clone().setY(0.9) });
      events.emit('net:barrelHit', { index: this.index, amount });
      return false;
    }
    this.health -= amount;
    this.flash = 1;
    events.emit('barrel:hit', { barrel: this, point: this.position.clone().setY(0.9) });
    if (this.health <= 0) {
      this.pendingDetonation = { attacker, delay: 0.05 };
      return true;
    }
    return false;
  }

  destroy() {
    this.isDestroyed = true;
    this.pendingDetonation = null;
    this.group.visible = false;
    this.collider.enabled = false;
    this.physics.removeSolidMesh(this.bodyMesh);
    this.respawnTimer = HAZARDS.barrelRespawnTime;
  }

  restore() {
    this.isDestroyed = false;
    this.health = HAZARDS.barrelHealth;
    this.group.visible = true;
    this.collider.enabled = true;
    this.physics.addSolidMesh(this.bodyMesh);
  }

  dispose() {
    this.scene.remove(this.group);
    this.bodyMesh.material.dispose();
  }
}

export class HazardManager {
  constructor({ scene, physics }) {
    this.scene = scene;
    this.physics = physics;
    this.barrels = [];
    this.combat = null;
  }

  /** Spawn barrels for a map (call after the map's colliders are built). */
  build(mapConfig) {
    this.barrels.forEach((barrel) => barrel.dispose());
    this.barrels = (mapConfig.barrels || []).map(([x, z], index) => {
      const barrel = new ExplosiveBarrel({ scene: this.scene, physics: this.physics, x, z });
      barrel.index = index;
      return barrel;
    });
  }

  /** combat: { player, bots, damagePlayer(amount, attacker, options), damageBot(bot, amount, attacker, options) } */
  setCombat(combat) {
    this.combat = combat;
  }

  get hitTargets() {
    return this.barrels.filter((barrel) => !barrel.isDestroyed).map((barrel) => barrel.bodyMesh);
  }

  detonate(barrel, attacker) {
    const center = barrel.position.clone().setY(0.8);
    barrel.destroy();
    events.emit('barrel:state', { index: barrel.index, destroyed: true });
    events.emit('explosion', { position: center, radius: HAZARDS.explosionRadius, byPlayer: !!this.combat && attacker === this.combat.player });
    if (!this.combat) return;

    const radius = HAZARDS.explosionRadius;
    const damageAt = (distance) => HAZARDS.explosionMaxDamage * Math.max(0, 1 - distance / radius);

    const player = this.combat.player;
    if (player.isAlive) {
      const distance = center.distanceTo(new THREE.Vector3(player.position.x, player.position.y + 1, player.position.z));
      if (distance < radius) this.combat.damagePlayer(Math.round(damageAt(distance)), attacker, { isExplosion: true, sourcePosition: center });
    }
    for (const bot of this.combat.bots) {
      if (bot.isDead) continue;
      const distance = center.distanceTo(new THREE.Vector3(bot.position.x, 1.5, bot.position.z));
      if (distance < radius) this.combat.damageBot(bot, Math.round(damageAt(distance)), attacker, { isExplosion: true, point: bot.position.clone().setY(1.5) });
    }
    // Multiplayer: other humans caught in the blast.
    for (const remote of this.combat.remotePlayers || []) {
      if (remote.isDead) continue;
      const distance = center.distanceTo(new THREE.Vector3(remote.position.x, 1.2, remote.position.z));
      if (distance < radius) this.combat.damageRemotePlayer(remote, Math.round(damageAt(distance)), attacker, { isExplosion: true, sourcePosition: center });
    }
    // Chain reaction.
    for (const other of this.barrels) {
      if (other === barrel || other.isDestroyed || other.pendingDetonation) continue;
      if (other.position.distanceTo(barrel.position) < radius) {
        other.health = 0;
        other.pendingDetonation = { attacker, delay: HAZARDS.chainReactionDelay };
      }
    }
  }

  /** Guest: apply a barrel state change sent by the host. */
  applyState(index, destroyed) {
    const barrel = this.barrels[index];
    if (!barrel) return;
    if (destroyed && !barrel.isDestroyed) barrel.destroy();
    else if (!destroyed && barrel.isDestroyed) barrel.restore();
  }

  update(deltaSeconds, elapsedSeconds) {
    for (const barrel of this.barrels) {
      if (barrel.isDestroyed) {
        if (!netState.isAuthority) continue;
        barrel.respawnTimer -= deltaSeconds;
        if (barrel.respawnTimer <= 0) {
          barrel.restore();
          events.emit('barrel:state', { index: barrel.index, destroyed: false });
        }
        continue;
      }
      if (barrel.pendingDetonation) {
        barrel.pendingDetonation.delay -= deltaSeconds;
        if (barrel.pendingDetonation.delay <= 0) this.detonate(barrel, barrel.pendingDetonation.attacker);
        continue;
      }
      // Damaged barrels flicker a warning glow.
      const damageRatio = 1 - barrel.health / HAZARDS.barrelHealth;
      barrel.flash = Math.max(0, barrel.flash - deltaSeconds * 5);
      const warning = damageRatio > 0 ? (Math.sin(elapsedSeconds * (8 + damageRatio * 20)) * 0.5 + 0.5) * damageRatio : 0;
      barrel.bodyMesh.material.emissive.setRGB(barrel.flash + warning * 0.9, (barrel.flash + warning) * 0.25, 0);
    }
  }
}
