// =====================================================================
// Inventory — three fixed weapon slots (melee, sidearm, primary) plus
// med-kits. Each slot holds a weapon *instance* that remembers its own
// magazine and reserve ammo, so dropped weapons keep their ammo when
// another player picks them back up.
// =====================================================================

import { LOOT, WEAPONS, WEAPON_SLOTS } from '../config.js';
import { events } from '../core/events.js';

export const SLOT_INDEX = Object.fromEntries(WEAPON_SLOTS.map((slot, index) => [slot.id, index]));

/** Create a weapon instance with full magazine and starting reserve (or given values). */
export function createWeaponItem(weaponId, ammo = null, reserve = null) {
  const definition = WEAPONS[weaponId];
  if (!definition) throw new Error(`Unknown weapon "${weaponId}"`);
  return {
    definition,
    ammo: definition.isMelee ? Infinity : ammo ?? definition.magazineSize,
    reserve: definition.isMelee ? Infinity : reserve ?? definition.startReserve,
  };
}

export class Inventory {
  constructor(loadout) {
    this.slots = WEAPON_SLOTS.map(() => null);
    this.activeSlot = 2;
    this.medkits = LOOT.startingMedkits;
    this.resetToLoadout(loadout);
  }

  /** Respawn state: one weapon per slot from the chosen loadout, primary equipped. */
  resetToLoadout(loadout) {
    for (const slot of WEAPON_SLOTS) this.slots[SLOT_INDEX[slot.id]] = createWeaponItem(loadout[slot.id]);
    this.activeSlot = SLOT_INDEX.primary;
    this.medkits = LOOT.startingMedkits;
    this.notifyChanged();
  }

  get active() {
    return this.slots[this.activeSlot];
  }

  get activeDefinition() {
    return this.active ? this.active.definition : null;
  }

  /** Equip a slot if it holds a weapon. Returns true on change. */
  equip(slotIndex) {
    if (slotIndex === this.activeSlot || !this.slots[slotIndex]) return false;
    this.activeSlot = slotIndex;
    this.notifyChanged();
    return true;
  }

  /** Cycle to the next/previous occupied slot (mouse wheel). */
  cycle(direction) {
    for (let step = 1; step <= this.slots.length; step++) {
      const index = (this.activeSlot + direction * step + this.slots.length * 2) % this.slots.length;
      if (this.slots[index]) return this.equip(index);
    }
    return false;
  }

  /**
   * Put a weapon item into its slot and equip it.
   * Returns the item that previously occupied the slot (to be dropped), or null.
   */
  addWeapon(item) {
    const slotIndex = SLOT_INDEX[item.definition.slot];
    const previous = this.slots[slotIndex];
    this.slots[slotIndex] = item;
    this.activeSlot = slotIndex;
    this.notifyChanged();
    return previous;
  }

  /** Remove the active weapon (melee can't be dropped). Returns the removed item or null. */
  removeActive() {
    const item = this.active;
    if (!item || item.definition.isMelee) return null;
    this.slots[this.activeSlot] = null;
    this.cycle(-1);
    this.notifyChanged();
    return item;
  }

  /** Does any held gun have room for more reserve ammo? */
  canTakeAmmo() {
    return this.slots.some((item) => item && !item.definition.isMelee && item.reserve < item.definition.maxReserve);
  }

  /** Add a number of magazines of reserve ammo to every held gun. */
  addAmmo(magazines) {
    for (const item of this.slots) {
      if (!item || item.definition.isMelee) continue;
      item.reserve = Math.min(item.definition.maxReserve, item.reserve + item.definition.magazineSize * magazines);
    }
    this.notifyChanged();
  }

  addMedkit() {
    if (this.medkits >= LOOT.maxMedkits) return false;
    this.medkits++;
    this.notifyChanged();
    return true;
  }

  consumeMedkit() {
    if (this.medkits <= 0) return false;
    this.medkits--;
    this.notifyChanged();
    return true;
  }

  notifyChanged() {
    events.emit('inventory:changed', { inventory: this });
  }
}
