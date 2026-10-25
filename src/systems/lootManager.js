// =====================================================================
// Loot manager — everything lying on the ground:
//   • weapons (keep their own magazine/reserve ammo; [E] to pick up/swap)
//   • ammo boxes, med-kits, Tier-1 / Tier-2 armor (collected by walking over)
// World loot is scattered at match start and topped up over time; bots
// drop loot when eliminated; supply drops spawn elite items through
// spawnItem(). Each item floats, spins and glows in its rarity colour.
// =====================================================================

import * as THREE from 'three';
import { LOOT, PLAYER, WEAPONS, WORLD } from '../config.js';
import { events } from '../core/events.js';
import { buildWeaponModel } from '../entities/weapon.js';
import { createWeaponItem } from '../entities/inventory.js';
import { getPlainMaterial } from '../world/materials.js';
import { netState } from '../net/netState.js';

const rarityOfWeapon = (definition) => (definition.tier === 'elite' ? 'elite' : 'common');

let sharedVisuals = null;
function getSharedVisuals() {
  if (sharedVisuals) return sharedVisuals;
  const ringMaterials = {};
  const beamMaterials = {};
  for (const [rarity, color] of Object.entries(LOOT.rarityColors)) {
    const hdr = new THREE.Color(color).multiplyScalar(2.2);
    ringMaterials[rarity] = new THREE.MeshBasicMaterial({ color: hdr, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    beamMaterials[rarity] = new THREE.MeshBasicMaterial({ color: hdr, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  }
  sharedVisuals = {
    ringGeometry: new THREE.RingGeometry(0.5, 0.62, 36).rotateX(-Math.PI / 2),
    beamGeometry: new THREE.CylinderGeometry(0.12, 0.3, 3.2, 12, 1, true).translate(0, 1.6, 0),
    ringMaterials,
    beamMaterials,
  };
  return sharedVisuals;
}

// ------------------------------------------------------------------ item models
function boxPart(parent, width, height, depth, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function buildMedkitModel() {
  const group = new THREE.Group();
  const caseMaterial = getPlainMaterial(0xf2f2ee, { roughness: 0.45 });
  const crossMaterial = getPlainMaterial(0xe02020, { roughness: 0.4, emissive: 0xe02020, emissiveIntensity: 0.6 });
  boxPart(group, 0.56, 0.36, 0.36, caseMaterial, 0, 0, 0);
  boxPart(group, 0.22, 0.06, 0.06, getPlainMaterial(0x2a2a2a), 0, 0.21, 0);                 // handle
  for (const side of [-1, 1]) {
    boxPart(group, 0.24, 0.07, 0.01, crossMaterial, 0, 0, side * 0.185);
    boxPart(group, 0.07, 0.24, 0.01, crossMaterial, 0, 0, side * 0.185);
  }
  boxPart(group, 0.07, 0.01, 0.24, crossMaterial, 0, 0.185, 0);
  boxPart(group, 0.24, 0.01, 0.07, crossMaterial, 0, 0.185, 0);
  return group;
}

function buildArmorModel(tier) {
  const group = new THREE.Group();
  const vestColor = tier === 2 ? 0x2c3e50 : 0x56653a;
  const vest = getPlainMaterial(vestColor, { roughness: 0.8 });
  const strap = getPlainMaterial(0x1b1d17, { roughness: 0.8 });
  const plate = getPlainMaterial(tier === 2 ? 0x3aa0ff : 0x6fdc4a, { roughness: 0.35, metalness: 0.4, emissive: tier === 2 ? 0x3aa0ff : 0x6fdc4a, emissiveIntensity: 0.5 });
  boxPart(group, 0.62, 0.72, 0.22, vest, 0, 0, 0);
  boxPart(group, 0.16, 0.2, 0.2, vest, -0.22, 0.42, 0);
  boxPart(group, 0.16, 0.2, 0.2, vest, 0.22, 0.42, 0);
  boxPart(group, 0.64, 0.07, 0.24, strap, 0, -0.18, 0);
  boxPart(group, 0.36, 0.28, 0.04, plate, 0, 0.06, 0.12);
  if (tier === 2) {
    for (const pouchX of [-0.2, 0, 0.2]) boxPart(group, 0.15, 0.16, 0.08, strap, pouchX, -0.3, 0.14);
    boxPart(group, 0.66, 0.06, 0.26, plate, 0, 0.26, 0);
  }
  return group;
}

function buildAmmoModel() {
  const group = new THREE.Group();
  const crate = getPlainMaterial(0x4a5a32, { roughness: 0.75, metalness: 0.2 });
  const stripe = getPlainMaterial(0xffb21a, { roughness: 0.5, emissive: 0xffb21a, emissiveIntensity: 0.5 });
  const brass = getPlainMaterial(0xd4a33a, { roughness: 0.25, metalness: 1 });
  boxPart(group, 0.6, 0.3, 0.34, crate, 0, 0, 0);
  boxPart(group, 0.61, 0.06, 0.35, stripe, 0, 0.05, 0);
  boxPart(group, 0.06, 0.06, 0.35, getPlainMaterial(0x222222), -0.22, 0.17, 0);
  for (let round = 0; round < 5; round++) boxPart(group, 0.05, 0.14, 0.05, brass, -0.1 + round * 0.06, 0.22, 0.06);
  return group;
}

export class LootManager {
  constructor({ scene, physics }) {
    this.scene = scene;
    this.physics = physics;
    this.items = [];
    this.respawnTimer = LOOT.worldRespawnInterval;
    this.elapsed = 0;
    this.nextItemId = 1;
    events.on('bot:death', ({ bot, position }) => netState.isAuthority && !(bot && bot.isRemotePlayer) && this.dropFromBot(position));
  }

  /** Plain data for the network. */
  serialize(item) {
    return {
      id: item.id, kind: item.kind, armorTier: item.armorTier, x: item.position.x, z: item.position.z,
      lifetime: Number.isFinite(item.lifetime) ? item.lifetime : -1, isWorld: item.isWorld,
      weaponId: item.weaponItem ? item.weaponItem.definition.id : null,
      ammo: item.weaponItem ? item.weaponItem.ammo : null, reserve: item.weaponItem ? item.weaponItem.reserve : null,
    };
  }

  /** Guest side: create an item described by the host. */
  spawnFromNetwork(data) {
    if (this.items.some((item) => item.id === data.id)) return;
    this.spawnItem({
      id: data.id, kind: data.kind, armorTier: data.armorTier, isWorld: data.isWorld, lifetime: data.lifetime < 0 ? Infinity : data.lifetime,
      weaponItem: data.weaponId ? createWeaponItem(data.weaponId, data.ammo, data.reserve) : null,
      position: new THREE.Vector3(data.x, 0, data.z), fromNetwork: true,
    });
  }

  removeById(id) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) this.removeItem(item, false);
  }

  // ------------------------------------------------------------------ setup
  clear() {
    this.items.forEach((item) => this.scene.remove(item.group));
    this.items = [];
  }

  /** Scatter initial world loot for a freshly built map. */
  build() {
    this.clear();
    if (!netState.isAuthority) return; // guests receive the host's items
    for (let index = 0; index < LOOT.worldItemCount; index++) this.spawnRandomWorldItem();
    this.respawnTimer = LOOT.worldRespawnInterval;
  }

  randomFreePosition(limit = WORLD.arenaHalfSize - 10, padding = 1.4) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (Math.random() * 2 - 1) * limit;
      const z = (Math.random() * 2 - 1) * limit;
      if (!this.physics.isPointBlocked(x, z, padding)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(0, 0, 0);
  }

  spawnRandomWorldItem() {
    const weights = LOOT.worldWeights;
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    let roll = Math.random() * total;
    let kind = 'ammo';
    for (const [candidate, weight] of Object.entries(weights)) {
      roll -= weight;
      if (roll <= 0) { kind = candidate; break; }
    }
    const position = this.randomFreePosition();
    if (kind === 'weapon') {
      const weaponId = LOOT.worldWeaponPool[Math.floor(Math.random() * LOOT.worldWeaponPool.length)];
      return this.spawnItem({ kind: 'weapon', weaponItem: createWeaponItem(weaponId), position, isWorld: true });
    }
    if (kind === 'armor1') return this.spawnItem({ kind: 'armor', armorTier: 1, position, isWorld: true });
    if (kind === 'armor2') return this.spawnItem({ kind: 'armor', armorTier: 2, position, isWorld: true });
    return this.spawnItem({ kind, position, isWorld: true });
  }

  /**
   * Create a ground item.
   * options: { kind: 'weapon'|'ammo'|'medkit'|'armor', weaponItem, armorTier, position, isWorld, lifetime }
   */
  spawnItem({ kind, weaponItem = null, armorTier = 1, position, isWorld = false, lifetime = null, id = null, fromNetwork = false }) {
    const visuals = getSharedVisuals();
    let model;
    let rarity;
    let label;
    if (kind === 'weapon') {
      const definition = weaponItem.definition;
      model = buildWeaponModel(definition.model).group;
      model.scale.setScalar(1.8);
      model.rotation.set(0, Math.PI / 2, 0.15);
      rarity = rarityOfWeapon(definition);
      label = definition.name;
    } else if (kind === 'medkit') {
      model = buildMedkitModel();
      rarity = 'uncommon';
      label = 'MED-KIT';
    } else if (kind === 'armor') {
      model = buildArmorModel(armorTier);
      rarity = LOOT.armorTiers[armorTier].rarity;
      label = `${LOOT.armorTiers[armorTier].label} (+${LOOT.armorTiers[armorTier].amount})`;
    } else {
      model = buildAmmoModel();
      rarity = 'common';
      label = 'AMMO BOX';
    }
    model.traverse((object) => { if (object.isMesh) object.castShadow = true; });

    const group = new THREE.Group();
    group.position.copy(position).setY(0);
    const floater = new THREE.Group();
    floater.add(model);
    floater.position.y = 0.85;
    group.add(floater);
    const ring = new THREE.Mesh(visuals.ringGeometry, visuals.ringMaterials[rarity]);
    ring.position.y = 0.05;
    group.add(ring);
    if (rarity === 'elite' || rarity === 'rare') group.add(new THREE.Mesh(visuals.beamGeometry, visuals.beamMaterials[rarity]));
    this.scene.add(group);

    const item = {
      id: id ?? this.nextItemId++, kind, weaponItem, armorTier, rarity, label, group, floater, ring, isWorld,
      position: group.position, age: Math.random() * 3, lifetime: lifetime ?? (isWorld ? Infinity : LOOT.droppedLifetime), pendingUntil: 0,
    };
    this.items.push(item);
    if (!fromNetwork && netState.isHost) events.emit('loot:spawned', { item: this.serialize(item) });
    return item;
  }

  removeItem(item, broadcast = true) {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
    this.scene.remove(item.group);
    if (broadcast && netState.isHost) events.emit('loot:removed', { id: item.id });
  }

  /** Host: a guest asked for item `id`. Removes it and returns its data, or null if already taken. */
  grantToRemote(id) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    const data = this.serialize(item);
    this.removeItem(item);
    return data;
  }

  /** Guest: the host granted an item — apply its effect locally. */
  applyGrant(data, player, inventory) {
    if (data.kind === 'weapon') {
      const weaponItem = createWeaponItem(data.weaponId, data.ammo, data.reserve);
      const previous = inventory.addWeapon(weaponItem);
      if (previous) this.dropWeapon(previous, player.position);
      const definition = weaponItem.definition;
      events.emit('loot:pickup', { kind: 'weapon', rarity: rarityOfWeapon(definition), label: definition.name, weaponId: definition.id, position: new THREE.Vector3(data.x, 0.9, data.z) });
      events.emit('notify', { text: `${definition.tier === 'elite' ? '★ ELITE ' : ''}${definition.name} EQUIPPED`, tone: definition.tier === 'elite' ? 'elite' : 'info' });
      return;
    }
    const pseudoItem = { kind: data.kind, armorTier: data.armorTier, rarity: data.kind === 'armor' ? LOOT.armorTiers[data.armorTier].rarity : 'common', label: data.kind, position: new THREE.Vector3(data.x, 0, data.z) };
    this.tryAutoPickup(pseudoItem, player, inventory);
  }

  /** Guest: a pickup request was answered (granted or refused) — allow new requests. */
  clearPending(id) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) item.pendingUntil = 0;
  }

  /** Host: place a weapon a guest dropped. */
  spawnDroppedWeapon({ weaponId, ammo, reserve, x, z }) {
    return this.spawnItem({ kind: 'weapon', weaponItem: createWeaponItem(weaponId, ammo, reserve), position: new THREE.Vector3(Number(x) || 0, 0, Number(z) || 0) });
  }

  // ------------------------------------------------------------------ drops
  /** Drop a weapon instance near a position (keeps its ammo). */
  dropWeapon(weaponItem, position) {
    if (!weaponItem || weaponItem.definition.isMelee) return null;
    const angle = Math.random() * Math.PI * 2;
    const dropPosition = new THREE.Vector3(position.x + Math.cos(angle) * 1.1, 0, position.z + Math.sin(angle) * 1.1);
    if (!netState.isAuthority) {
      // Guests ask the host to place the weapon so everyone sees it.
      events.emit('net:lootDrop', { weaponId: weaponItem.definition.id, ammo: weaponItem.ammo, reserve: weaponItem.reserve, x: dropPosition.x, z: dropPosition.z });
      events.emit('weapon:dropped', { weapon: weaponItem.definition, position: dropPosition });
      return null;
    }
    const item = this.spawnItem({ kind: 'weapon', weaponItem, position: dropPosition });
    events.emit('weapon:dropped', { weapon: weaponItem.definition, position: dropPosition });
    return item;
  }

  dropFromBot(position) {
    if (Math.random() > LOOT.botDropChance) return;
    const dropPosition = new THREE.Vector3(position.x, 0, position.z);
    if (Math.random() < LOOT.botWeaponDropChance) {
      const weaponId = LOOT.botDropWeapons[Math.floor(Math.random() * LOOT.botDropWeapons.length)];
      const definition = WEAPONS[weaponId];
      const partialMagazine = Math.max(1, Math.floor(definition.magazineSize * (0.4 + Math.random() * 0.6)));
      this.spawnItem({ kind: 'weapon', weaponItem: createWeaponItem(weaponId, partialMagazine, definition.magazineSize), position: dropPosition });
      return;
    }
    const roll = Math.random();
    if (roll < 0.45) this.spawnItem({ kind: 'ammo', position: dropPosition });
    else if (roll < 0.8) this.spawnItem({ kind: 'medkit', position: dropPosition });
    else this.spawnItem({ kind: 'armor', armorTier: 1, position: dropPosition });
  }

  // ------------------------------------------------------------------ interaction
  findNearestWeapon(position) {
    let nearest = null;
    let nearestDistance = LOOT.interactRadius;
    for (const item of this.items) {
      if (item.kind !== 'weapon') continue;
      const distance = Math.hypot(item.position.x - position.x, item.position.z - position.z);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = item;
      }
    }
    return nearest;
  }

  /** Prompt text for the HUD, or null. */
  getPrompt(player, inventory) {
    if (!player.isAlive) return null;
    const item = this.findNearestWeapon(player.position);
    if (!item) return null;
    const definition = item.weaponItem.definition;
    const slotIndex = ['melee', 'secondary', 'primary'].indexOf(definition.slot);
    const current = inventory.slots[slotIndex];
    const action = current ? `SWAP ${current.definition.shortName} ⇄` : 'PICK UP';
    const ammoText = definition.isMelee ? '' : ` · ${item.weaponItem.ammo}/${item.weaponItem.reserve}`;
    return { text: `${action} ${definition.name}${ammoText}`, rarity: item.rarity, isElite: definition.tier === 'elite' };
  }

  /** [E] pressed: pick up the nearest weapon, dropping whatever was in its slot. Returns true if handled. */
  interact(player, inventory) {
    if (!player.isAlive) return false;
    const item = this.findNearestWeapon(player.position);
    if (!item) return false;
    if (!netState.isAuthority) {
      if (item.pendingUntil < performance.now()) {
        item.pendingUntil = performance.now() + 1500;
        events.emit('net:lootRequest', { id: item.id });
      }
      return true;
    }
    this.removeItem(item);
    const previous = inventory.addWeapon(item.weaponItem);
    if (previous) this.dropWeapon(previous, player.position);
    const definition = item.weaponItem.definition;
    events.emit('loot:pickup', { kind: 'weapon', rarity: item.rarity, label: definition.name, weaponId: definition.id, position: item.position.clone().setY(0.9) });
    events.emit('notify', { text: `${definition.tier === 'elite' ? '★ ELITE ' : ''}${definition.name} EQUIPPED`, tone: definition.tier === 'elite' ? 'elite' : 'info' });
    return true;
  }

  canAutoPickup(item, player, inventory) {
    if (item.kind === 'ammo') return inventory.canTakeAmmo();
    if (item.kind === 'medkit') return inventory.medkits < LOOT.maxMedkits;
    if (item.kind === 'armor') return player.shield < PLAYER.maxShield;
    return false;
  }

  tryAutoPickup(item, player, inventory) {
    if (item.kind === 'ammo') {
      if (!inventory.canTakeAmmo()) return false;
      inventory.addAmmo(LOOT.ammoBoxMagazines);
      events.emit('notify', { text: 'AMMO RESUPPLIED', tone: 'info' });
    } else if (item.kind === 'medkit') {
      if (!inventory.addMedkit()) return false;
      events.emit('notify', { text: `+1 MED-KIT  (${inventory.medkits}/${LOOT.maxMedkits})`, tone: 'heal' });
    } else if (item.kind === 'armor') {
      if (player.shield >= PLAYER.maxShield) return false;
      const gained = player.addShield(LOOT.armorTiers[item.armorTier].amount);
      events.emit('notify', { text: `+${Math.round(gained)} ARMOR ACQUIRED`, tone: item.armorTier === 2 ? 'rare' : 'armor' });
    } else {
      return false;
    }
    events.emit('loot:pickup', { kind: item.kind, rarity: item.rarity, label: item.label, armorTier: item.armorTier, position: item.position.clone().setY(0.9) });
    return true;
  }

  // ------------------------------------------------------------------ per frame
  update(deltaSeconds, player, inventory) {
    this.elapsed += deltaSeconds;
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      item.age += deltaSeconds;
      item.lifetime -= deltaSeconds;
      item.floater.position.y = 0.85 + Math.sin(item.age * 2.4) * 0.08;
      item.floater.rotation.y += deltaSeconds * 1.2;
      const pulse = 1 + Math.sin(item.age * 4) * 0.08;
      item.ring.scale.set(pulse, 1, pulse);
      item.group.visible = item.lifetime > 5 || Math.sin(item.age * 18) > -0.2;
      if (item.lifetime <= 0) {
        this.removeItem(item, false);
        continue;
      }
      if (item.kind !== 'weapon' && player.isAlive) {
        const distance = Math.hypot(item.position.x - player.position.x, item.position.z - player.position.z);
        const magnetRadius = player.trait && player.trait.pickupRadius ? player.trait.pickupRadius : 0;
        // Scavenger trait: wanted items within range glide toward the player.
        if (magnetRadius && distance < magnetRadius && distance > LOOT.pickupRadius * 0.6 && this.canAutoPickup(item, player, inventory)) {
          const pull = Math.min(1, deltaSeconds * 6);
          item.position.x += (player.position.x - item.position.x) * pull;
          item.position.z += (player.position.z - item.position.z) * pull;
        }
        const inReach = distance < LOOT.pickupRadius && Math.abs(player.position.y - item.position.y) < 2.5;
        if (inReach && !netState.isAuthority) {
          if (item.pendingUntil < performance.now() && this.canAutoPickup(item, player, inventory)) {
            item.pendingUntil = performance.now() + 1500;
            events.emit('net:lootRequest', { id: item.id });
          }
        } else if (inReach && this.tryAutoPickup(item, player, inventory)) {
          this.removeItem(item);
        }
      }
    }

    if (!netState.isAuthority) return;
    this.respawnTimer -= deltaSeconds;
    if (this.respawnTimer <= 0) {
      this.respawnTimer = LOOT.worldRespawnInterval;
      const worldCount = this.items.filter((item) => item.isWorld).length;
      if (worldCount < LOOT.worldItemCount) this.spawnRandomWorldItem();
    }
  }
}
