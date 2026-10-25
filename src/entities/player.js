// =====================================================================
// Player — first-person body: look, movement, jumping, dashing, health,
// armor/shield, med-kit healing, death and respawn. Health never
// regenerates on its own. Emits events for footsteps, jumps, landings,
// dashes, damage, armor, healing and death so audio/animation can react.
// =====================================================================

import * as THREE from 'three';
import { arenaScale, CTF, LOOT, PLAYER, PLAYER_TEAM, TRAITS } from '../config.js';
import { events } from '../core/events.js';

export class Player {
  constructor() {
    this.team = PLAYER_TEAM;
    this.internalName = 'You';
    this.displayName = PLAYER.displayNameFallback;
    this.spawnJitter = 0;

    this.position = new THREE.Vector3(PLAYER.spawn.x, 0, PLAYER.spawn.z);
    this.verticalVelocity = 0;
    this.isGrounded = true;
    this.yaw = 0;
    this.pitch = 0;

    this.health = PLAYER.maxHealth;
    this.shield = 0;
    this.healTimer = 0;
    this.isAlive = true;
    this.timeSinceDamage = 0;
    this.respawnTimer = 0;

    this.dashTimer = 0;
    this.dashCooldownTimer = 0;

    this.horizontalSpeed = 0;
    this.distanceSinceStep = 0;
    this.isMoving = false;
    this.sensitivityScale = 1;

    // Customisation and modifiers.
    this.gender = 'male';
    this.trait = TRAITS.none;
    this.isCrouching = false;
    this.currentEyeHeight = PLAYER.eyeHeight;
    this.abilitySpeedMultiplier = 1;   // set each frame by the ability manager
    this.unlimitedDash = false;
    this.isDisguised = false;
    this.carryingFlag = null;          // set by the CTF flag manager
    this.timeSinceShot = 99;           // used by Prop Hunt / Ghost reveal checks
  }

  setTrait(traitId) {
    this.trait = TRAITS[traitId] || TRAITS.none;
  }

  get eyeHeight() {
    return this.isAlive ? this.currentEyeHeight : PLAYER.deadEyeHeight;
  }

  /** True when the Ghost trait currently hides this player (crouched). */
  get isGhosted() {
    return this.trait.id === 'ghost' && this.isCrouching;
  }

  get isHealing() {
    return this.healTimer > 0;
  }

  get healProgress() {
    return this.isHealing ? 1 - this.healTimer / LOOT.medkitUseTime : 0;
  }

  /** Start using a med-kit from the inventory. Returns true if healing began. */
  startMedkit(inventory) {
    if (!this.isAlive || this.isHealing) return false;
    if (inventory.medkits <= 0) {
      events.emit('notify', { text: 'NO MED-KITS', tone: 'danger' });
      return false;
    }
    if (this.health >= PLAYER.maxHealth) {
      events.emit('notify', { text: 'HEALTH FULL', tone: 'muted' });
      return false;
    }
    this.healTimer = LOOT.medkitUseTime;
    this.healingInventory = inventory;
    events.emit('medkit:start', { duration: LOOT.medkitUseTime });
    return true;
  }

  /** Add armor points. Returns how many were actually added. */
  addShield(amount) {
    const before = this.shield;
    this.shield = Math.min(PLAYER.maxShield, this.shield + amount);
    const gained = this.shield - before;
    if (gained > 0) events.emit('armor:changed', { shield: this.shield, gained });
    return gained;
  }

  get isDashing() {
    return this.dashTimer > 0;
  }

  get dashReadiness() {
    return 1 - Math.max(0, this.dashCooldownTimer) / PLAYER.dashCooldown;
  }

  /** Mouse-look from pointer-lock movement deltas (scaled down while zoomed by the caller). */
  applyLookDelta(deltaX, deltaY, fovScale) {
    const sensitivity = PLAYER.mouseSensitivity * this.sensitivityScale * fovScale;
    this.yaw -= deltaX * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - deltaY * sensitivity, -PLAYER.maxPitch, PLAYER.maxPitch);
  }

  tryDash() {
    if (!this.isAlive || this.dashCooldownTimer > 0) return false;
    this.dashTimer = PLAYER.dashDuration;
    this.dashCooldownTimer = this.unlimitedDash ? 0.25 : PLAYER.dashCooldown;
    events.emit('player:dash', {});
    return true;
  }

  /**
   * Advance the player one frame.
   * input: { keys: {KeyW...}, jumpHeld }
   */
  update(deltaSeconds, input, physics, mobility = 1) {
    const keys = input.keys;

    // Arrow-key look fallback (works even if pointer lock is blocked).
    this.yaw += ((keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0)) * PLAYER.arrowYawSpeed * deltaSeconds;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + ((keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0)) * PLAYER.arrowPitchSpeed * deltaSeconds,
      -PLAYER.maxPitch, PLAYER.maxPitch,
    );

    const forwardInput = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const strafeInput = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const inputLength = Math.hypot(forwardInput, strafeInput) || 1;
    // Stance: crouch lowers the camera and slows you down.
    this.isCrouching = this.isAlive && !!(keys.KeyC || keys.ControlLeft);
    const targetEye = this.isCrouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    this.currentEyeHeight += (targetEye - this.currentEyeHeight) * Math.min(1, deltaSeconds * 12);
    this.timeSinceShot += deltaSeconds;

    const healSlowdown = this.isHealing ? 0.55 : 1;
    const crouchSlowdown = this.isCrouching ? PLAYER.crouchSpeedMultiplier : 1;
    const traitSpeed = this.trait.speedMultiplier || 1;
    const flagSpeed = this.carryingFlag ? CTF.carrierSpeedMultiplier : 1;
    const modifiers = mobility * healSlowdown * crouchSlowdown * traitSpeed * flagSpeed * this.abilitySpeedMultiplier;
    const speed = !this.isAlive ? 0 : this.isDashing ? PLAYER.dashSpeed * Math.max(1, this.abilitySpeedMultiplier * 0.7) : PLAYER.walkSpeed * modifiers;

    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    const previousX = this.position.x;
    const previousZ = this.position.z;

    this.position.x += ((-sinYaw * forwardInput + cosYaw * strafeInput) / inputLength) * speed * deltaSeconds;
    this.position.z += ((-cosYaw * forwardInput - sinYaw * strafeInput) / inputLength) * speed * deltaSeconds;

    // Dashing without movement input lunges forward.
    if (this.isDashing && !forwardInput && !strafeInput) {
      this.position.x -= sinYaw * PLAYER.dashSpeed * deltaSeconds;
      this.position.z -= cosYaw * PLAYER.dashSpeed * deltaSeconds;
    }

    this.dashTimer -= deltaSeconds;
    this.dashCooldownTimer -= deltaSeconds;

    physics.resolveHorizontal(this.position, this.position.y);
    const verticalResult = physics.stepVertical(this, deltaSeconds, input.jumpHeld && this.isAlive);
    if (verticalResult.jumped) events.emit('player:jump', {});
    if (verticalResult.landed) events.emit('player:land', { fallSpeed: verticalResult.fallSpeed });

    // Footsteps are distance-based so they match the actual movement speed.
    const movedDistance = Math.hypot(this.position.x - previousX, this.position.z - previousZ);
    this.horizontalSpeed = movedDistance / Math.max(deltaSeconds, 1e-4);
    this.isMoving = this.horizontalSpeed > 0.5;
    if (this.isGrounded && this.isAlive) {
      this.distanceSinceStep += movedDistance;
      if (this.distanceSinceStep >= PLAYER.footstepStride) {
        this.distanceSinceStep = 0;
        events.emit('player:step', { surface: this.position.y > 0.05 ? 'wood' : 'grass', speed: this.horizontalSpeed });
      }
    }

    this.updateHealth(deltaSeconds);
  }

  updateHealth(deltaSeconds) {
    this.timeSinceDamage += deltaSeconds;
    // Med-kit channel: heal applies when the timer completes.
    if (this.isHealing) {
      this.healTimer -= deltaSeconds;
      if (this.healTimer <= 0) {
        this.healTimer = 0;
        if (this.isAlive && this.healingInventory && this.healingInventory.consumeMedkit()) {
          const before = this.health;
          this.health = Math.min(PLAYER.maxHealth, this.health + LOOT.medkitHeal);
          events.emit('medkit:used', { healed: Math.round(this.health - before), health: this.health });
          events.emit('notify', { text: `MED-KIT USED  +${Math.round(this.health - before)} HP`, tone: 'heal' });
        }
      }
    }
    if (!this.isAlive) {
      this.respawnTimer -= deltaSeconds;
      if (this.respawnTimer <= 0) this.respawn();
    }
  }

  /** Armor absorbs damage first, the rest hits health. Returns true if this damage killed the player. */
  takeDamage(amount, attackerName, sourcePosition) {
    if (!this.isAlive) return false;
    const absorbed = Math.min(this.shield, amount);
    const hadShield = this.shield > 0;
    this.shield -= absorbed;
    this.health -= amount - absorbed;
    this.timeSinceDamage = 0;
    events.emit('player:hurt', { amount, absorbed, health: Math.max(0, this.health), shield: this.shield, sourcePosition, attackerName });
    if (absorbed > 0) events.emit('armor:changed', { shield: this.shield, gained: -absorbed });
    if (hadShield && this.shield <= 0) {
      events.emit('armor:break', {});
      events.emit('notify', { text: 'ARMOR BROKEN', tone: 'danger' });
    }
    if (this.health <= 0) {
      this.health = 0;
      this.healTimer = 0;
      this.isAlive = false;
      this.respawnTimer = PLAYER.respawnDelay;
      events.emit('player:death', { attackerName });
      return true;
    }
    return false;
  }

  respawn() {
    this.isAlive = true;
    this.health = PLAYER.maxHealth;
    this.shield = Math.min(PLAYER.maxShield, this.trait.spawnShield || 0);
    this.healTimer = 0;
    this.isCrouching = false;
    this.isDisguised = false;
    this.carryingFlag = null;
    // Blue deploys at the south base facing north; red at the north base facing south.
    // `spawnJitter` (set for online matches) spreads human squadmates apart.
    const side = this.team === 'red' ? -1 : 1;
    const jitter = this.spawnJitter ? (Math.random() * 2 - 1) * this.spawnJitter : 0;
    this.position.set(PLAYER.spawn.x + jitter, 0, PLAYER.spawn.z * arenaScale() * side);
    this.verticalVelocity = 0;
    this.isGrounded = true;
    this.yaw = side === 1 ? 0 : Math.PI;
    this.pitch = 0;
    events.emit('player:respawn', {});
  }
}
