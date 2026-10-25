// =====================================================================
// Battle ambience — makes the arena feel like part of a bigger war:
//   • Distant artillery: shells land far beyond the walls with a
//     fireball and a towering smoke column; the boom arrives later,
//     delayed by the speed of sound.
//   • Jet flybys: a pair of fighters screams overhead trailing vapour.
// Purely cosmetic and local to each player (never affects gameplay).
// FRONTLINE ('war' ambience) gets it much more often than the other maps.
// Events: ambience:artillery { position, delay }, ambience:jet { position }.
// =====================================================================

import * as THREE from 'three';
import { WORLD } from '../config.js';
import { events } from '../core/events.js';
import { getPlainMaterial } from '../world/materials.js';

const SPEED_OF_SOUND = 340;
const JET_SPEED = 115;

const PROFILES = {
  war: { artillery: [5, 11], jets: [32, 58] },
  calm: { artillery: [14, 28], jets: [70, 120] },
};

function buildJet() {
  const jet = new THREE.Group();
  const hull = getPlainMaterial(0x6a7078, { roughness: 0.45, metalness: 0.7 });
  const dark = getPlainMaterial(0x2a2e33, { roughness: 0.5, metalness: 0.6 });
  const canopy = getPlainMaterial(0x1a2a3a, { roughness: 0.05, metalness: 0.9 });
  const glow = getPlainMaterial(0xff8a2a, { emissive: 0xff8a2a, emissiveIntensity: 6, roughness: 0.3 });
  const part = (width, height, depth, material, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    jet.add(mesh);
    return mesh;
  };
  part(1.3, 1.1, 10, hull, 0, 0, 0);            // fuselage (nose toward -Z)
  part(0.9, 0.8, 1.6, dark, 0, -0.05, -5.6);    // nose cone
  part(0.8, 0.55, 2.2, canopy, 0, 0.7, -2.6);   // cockpit
  part(10, 0.16, 2.8, hull, 0, -0.1, 0.6);      // wings
  part(4.2, 0.12, 1.3, hull, 0, 0.1, 4.4);      // tailplane
  part(0.16, 2, 1.8, hull, 0, 1.2, 4.2);        // fin
  part(0.9, 0.9, 0.4, glow, 0, 0, 5.1);         // afterburner
  jet.scale.setScalar(1.6);
  return jet;
}

export class BattleAmbience {
  constructor({ scene, effects, camera }) {
    this.scene = scene;
    this.effects = effects;
    this.camera = camera;
    this.jets = [buildJet(), buildJet()];
    this.jets.forEach((jet) => {
      jet.visible = false;
      this.scene.add(jet);
    });
    this.flight = null;
    this.reset('calm');
  }

  reset(profileName = 'calm') {
    this.profile = PROFILES[profileName] || PROFILES.calm;
    this.artilleryTimer = 4 + Math.random() * 4;
    this.jetTimer = 18 + Math.random() * 12;
    this.flight = null;
    this.jets.forEach((jet) => { jet.visible = false; });
  }

  randomBetween([min, max]) {
    return min + Math.random() * (max - min);
  }

  fireArtillery() {
    const angle = Math.random() * Math.PI * 2;
    const distance = WORLD.arenaHalfSize * (1.5 + Math.random() * 1.1);
    const position = new THREE.Vector3(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    const delay = position.distanceTo(this.camera.position) / SPEED_OF_SOUND;
    events.emit('ambience:artillery', { position, delay });
    // Barrages: sometimes a second and third shell follow.
    if (Math.random() < 0.45) {
      for (let shell = 1; shell <= 2; shell++) {
        setTimeout(() => {
          const offset = position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 40, 0, (Math.random() - 0.5) * 40));
          events.emit('ambience:artillery', { position: offset, delay });
        }, shell * (350 + Math.random() * 400));
      }
    }
  }

  launchJets() {
    const half = WORLD.arenaHalfSize;
    const angle = Math.random() * Math.PI * 2;
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const lateral = new THREE.Vector3(-direction.z, 0, direction.x);
    const offset = (Math.random() - 0.5) * half;
    const altitude = 50 + Math.random() * 25;
    const start = direction.clone().multiplyScalar(-half * 3.2).addScaledVector(lateral, offset).setY(altitude);
    this.flight = { start, direction, lateral, travelled: 0, length: half * 6.4 };
    this.jets.forEach((jet, index) => {
      jet.visible = true;
      jet.userData.offset = new THREE.Vector3().addScaledVector(lateral, index * 14).addScaledVector(direction, -index * 12).setY(index * 3);
      jet.position.copy(start).add(jet.userData.offset);
      jet.lookAt(jet.position.clone().sub(direction));     // +Z backward, so the nose (-Z) leads
    });
    const closest = start.clone().addScaledVector(direction, half * 3.2);
    events.emit('ambience:jet', { position: closest.setY(altitude * 0.5) });
  }

  update(deltaSeconds) {
    this.artilleryTimer -= deltaSeconds;
    if (this.artilleryTimer <= 0) {
      this.artilleryTimer = this.randomBetween(this.profile.artillery);
      this.fireArtillery();
    }
    this.jetTimer -= deltaSeconds;
    if (this.jetTimer <= 0 && !this.flight) {
      this.jetTimer = this.randomBetween(this.profile.jets);
      this.launchJets();
    }
    if (!this.flight) return;
    const flight = this.flight;
    flight.travelled += JET_SPEED * deltaSeconds;
    for (const jet of this.jets) {
      jet.position.copy(flight.start).addScaledVector(flight.direction, flight.travelled).add(jet.userData.offset);
      jet.rotation.z = Math.sin(flight.travelled * 0.01) * 0.15;
      // Vapour trail from the wingtips.
      if (Math.random() < 0.8) {
        for (const side of [-1, 1]) {
          const tip = jet.position.clone().addScaledVector(flight.lateral, side * 7.5);
          this.effects.smoke.spawn(tip, this.effects.scratchVelocity.set(0, 0, 0), {
            color: this.effects.scratchColor.setRGB(0.92, 0.94, 0.97), lifetime: 2.6, startSize: 0.8, endSize: 3.2, alpha: 0.45, drag: 0,
          });
        }
      }
    }
    if (flight.travelled > flight.length) {
      this.flight = null;
      this.jets.forEach((jet) => { jet.visible = false; });
    }
  }
}
