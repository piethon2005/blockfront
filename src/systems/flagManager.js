// =====================================================================
// Capture the Flag — two team flags with waving cloth on a pole.
//   • Touch the enemy flag to take it; carry it to your own flag to score.
//   • Your own flag must be at home to capture.
//   • A killed carrier drops the flag. Touching your own dropped flag
//     returns it instantly; otherwise it returns after a timeout.
// Also hands bots their CTF objective (attack, defend, chase, run home).
// Events: flag:taken, flag:dropped, flag:returned, flag:captured
// (every payload carries `ourTeam` so listeners can tell friend from foe).
// Multiplayer: the host runs the rules; guests mirror flag state from
// snapshots and replay the same toasts/events on each state change.
// =====================================================================

import * as THREE from 'three';
import { CTF, TEAMS, getFlagPosition } from '../config.js';
import { events } from '../core/events.js';
import { netState } from '../net/netState.js';

const FLAG_STATE = { HOME: 'home', CARRIED: 'carried', DROPPED: 'dropped' };

function buildFlagVisual(team) {
  const color = new THREE.Color(TEAMS[team].tagColor);
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 8), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.9, roughness: 0.3 }));
  pole.position.y = 2;
  pole.castShadow = true;
  group.add(pole);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: 1, roughness: 0.25 }));
  finial.position.y = 4.05;
  group.add(finial);

  const clothGeometry = new THREE.PlaneGeometry(1.7, 1.05, 14, 7);
  clothGeometry.translate(0.85, 0, 0);
  const cloth = new THREE.Mesh(clothGeometry, new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.8,
  }));
  cloth.position.set(0.05, 3.4, 0);
  cloth.castShadow = true;
  group.add(cloth);
  const restPositions = Float32Array.from(clothGeometry.attributes.position.array);
  return { group, cloth, restPositions };
}

function buildBasePad(team, x, z) {
  const color = new THREE.Color(TEAMS[team].tagColor);
  const pad = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.18, 32), new THREE.MeshStandardMaterial({ color: 0x2a2d28, roughness: 0.7, metalness: 0.4 }));
  disc.position.y = 0.09;
  disc.receiveShadow = true;
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.0, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
    color: color.clone().multiplyScalar(2.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  ring.position.y = 0.2;
  pad.add(disc, ring);
  pad.position.set(x, 0, z);
  pad.userData.ring = ring;
  return pad;
}

export class FlagManager {
  constructor({ scene, player, bots, remotePlayers = [] }) {
    this.scene = scene;
    this.player = player;
    this.bots = bots;
    this.remotePlayers = remotePlayers;
    // Network helpers, installed by the replicator: entity <-> string key.
    this.keyOf = (entity) => (entity === this.player ? 'me' : entity.name);
    this.resolveKey = (key) => (key === 'me' ? this.player : this.bots.find((bot) => bot.name === key) || null);
    this.flags = {};
    this.isActive = false;
    this.elapsed = 0;
    this.defenderWaypoints = new Map();
    events.on('bot:death', ({ bot }) => netState.isAuthority && this.dropFlagOf(bot));
    events.on('player:death', () => netState.isAuthority && this.dropFlagOf(this.player));
  }

  get ourTeam() {
    return this.player.team;
  }

  isOurs(team) {
    return team === this.player.team;
  }

  displayName(entity) {
    return entity === this.player ? 'You' : entity.name;
  }

  // ------------------------------------------------------------------ network
  snapshot() {
    if (!this.isActive) return null;
    const pack = (flag) => [flag.state, +flag.position.x.toFixed(2), +flag.position.z.toFixed(2), flag.carrier ? this.keyOf(flag.carrier) : null];
    return { blue: pack(this.flags.blue), red: pack(this.flags.red) };
  }

  /** Guest: adopt host flag state, replaying events on transitions. */
  applySnapshot(snapshot) {
    if (!this.isActive || !snapshot) return;
    for (const team of ['blue', 'red']) {
      const flag = this.flags[team];
      const [state, x, z, carrierKey] = snapshot[team];
      const carrier = carrierKey ? this.resolveKey(carrierKey) : null;
      const previousState = flag.state;
      const previousCarrier = flag.carrier;
      if (previousCarrier && previousCarrier !== carrier) previousCarrier.carryingFlag = null;
      flag.state = state;
      flag.carrier = state === FLAG_STATE.CARRIED ? carrier : null;
      if (flag.carrier) flag.carrier.carryingFlag = flag;
      if (state !== FLAG_STATE.CARRIED || !flag.carrier) flag.position.set(x, 0, z);
      if (previousState === state && previousCarrier === flag.carrier) continue;
      if (state === FLAG_STATE.CARRIED && flag.carrier) this.announceTaken(flag, flag.carrier);
      else if (state === FLAG_STATE.DROPPED) this.announceDropped(flag);
      else if (state === FLAG_STATE.HOME && previousState === FLAG_STATE.DROPPED) this.announceReturned(flag, null);
      // HOME after CARRIED = captured; the host sends a dedicated capture message.
    }
  }

  /** Guest: replay a capture announced by the host. */
  applyCapture({ team, flagTeam, byKey }) {
    const carrier = byKey ? this.resolveKey(byKey) : null;
    const byName = carrier ? this.displayName(carrier) : '';
    this.announceCaptured(team, flagTeam, byName, carrier === this.player);
  }

  // ------------------------------------------------------------------ announcements
  announceTaken(flag, carrier) {
    const isPlayer = carrier === this.player;
    events.emit('flag:taken', { flagTeam: flag.team, byTeam: carrier.team, carrierName: this.displayName(carrier), isPlayer, ourTeam: this.ourTeam });
    const ourFlag = this.isOurs(flag.team);
    events.emit('toast', {
      text: isPlayer ? 'YOU HAVE THE FLAG — RETURN TO BASE' : ourFlag ? 'OUR FLAG IS TAKEN!' : 'ALLY HAS THE ENEMY FLAG',
      style: ourFlag ? 'danger' : 'gold',
    });
  }

  announceDropped(flag) {
    events.emit('flag:dropped', { flagTeam: flag.team, position: flag.position.clone(), ourTeam: this.ourTeam });
    events.emit('notify', { text: `${this.isOurs(flag.team) ? 'YOUR' : 'ENEMY'} FLAG DROPPED`, tone: this.isOurs(flag.team) ? 'danger' : 'info' });
  }

  announceReturned(flag, byName) {
    events.emit('flag:returned', { flagTeam: flag.team, byName, ourTeam: this.ourTeam });
    events.emit('notify', { text: `${this.isOurs(flag.team) ? 'YOUR' : 'ENEMY'} FLAG RETURNED`, tone: 'muted' });
  }

  announceCaptured(team, flagTeam, byName, isPlayer) {
    events.emit('flag:captured', { team, flagTeam, byName, isPlayer, ourTeam: this.ourTeam });
    events.emit('toast', { text: this.isOurs(team) ? 'FLAG CAPTURED!' : 'ENEMY CAPTURED OUR FLAG', style: this.isOurs(team) ? 'gold' : 'danger' });
  }

  /** Build or remove the flags depending on the selected mode. */
  setActive(active) {
    this.clear();
    this.isActive = active;
    if (!active) return;
    for (const team of ['blue', 'red']) {
      const [x, z] = getFlagPosition(team);
      const visual = buildFlagVisual(team);
      const pad = buildBasePad(team, x, z);
      this.scene.add(visual.group, pad);
      visual.group.position.set(x, 0, z);
      this.flags[team] = {
        team, home: new THREE.Vector3(x, 0, z), position: new THREE.Vector3(x, 0, z), state: FLAG_STATE.HOME, carrier: null, dropTimer: 0, visual, pad,
      };
    }
  }

  clear() {
    for (const flag of Object.values(this.flags)) {
      this.scene.remove(flag.visual.group, flag.pad);
      if (flag.carrier) flag.carrier.carryingFlag = null;
    }
    this.flags = {};
    this.defenderWaypoints.clear();
  }

  /** Put both flags back at their bases (new match). */
  reset() {
    if (this.isActive) this.setActive(true);
  }

  getStatus() {
    if (!this.isActive) return null;
    const describe = (flag) => ({ state: flag.state, carrierName: flag.carrier ? this.displayName(flag.carrier) : null });
    return { blue: describe(this.flags.blue), red: describe(this.flags.red), ourTeam: this.ourTeam };
  }

  // ------------------------------------------------------------------ rules
  participants() {
    const list = [];
    if (this.player.isAlive) list.push({ entity: this.player, team: this.player.team, position: this.player.position, name: 'You', isPlayer: true });
    for (const bot of this.bots.concat(this.remotePlayers)) {
      if (!bot.isDead) list.push({ entity: bot, team: bot.team, position: bot.position, name: bot.name, isPlayer: false });
    }
    return list;
  }

  dropFlagOf(entity) {
    if (!this.isActive || !entity || !entity.carryingFlag) return;
    const flag = entity.carryingFlag;
    entity.carryingFlag = null;
    flag.carrier = null;
    flag.state = FLAG_STATE.DROPPED;
    flag.dropTimer = CTF.autoReturnTime;
    flag.position.set(entity.position.x, 0, entity.position.z);
    this.announceDropped(flag);
  }

  returnFlag(flag, byName = null, silent = false) {
    flag.state = FLAG_STATE.HOME;
    flag.carrier = null;
    flag.position.copy(flag.home);
    if (silent) return;
    this.announceReturned(flag, byName);
  }

  update(deltaSeconds, match) {
    if (!this.isActive || match.isOver) return;
    this.elapsed += deltaSeconds;
    if (!netState.isAuthority) {
      // Guests: carried flags follow their (locally interpolated) carrier.
      for (const flag of Object.values(this.flags)) {
        if (flag.state === FLAG_STATE.CARRIED && flag.carrier) flag.position.set(flag.carrier.position.x, 0, flag.carrier.position.z);
      }
      this.animate();
      return;
    }
    const participants = this.participants();

    for (const flag of Object.values(this.flags)) {
      if (flag.state === FLAG_STATE.CARRIED) {
        const carrier = flag.carrier;
        const carrierDead = carrier === this.player ? !carrier.isAlive : carrier.isDead || carrier.isDisposed;
        if (carrierDead) {
          this.dropFlagOf(carrier);
        } else {
          flag.position.set(carrier.position.x, 0, carrier.position.z);
          // Capture: carrier reaches its own team's flag while that flag is home.
          const ownFlag = this.flags[flag.team === 'blue' ? 'red' : 'blue'];
          if (ownFlag.state === FLAG_STATE.HOME && carrier.position.distanceTo(ownFlag.home) < CTF.pickupRadius + 0.6) {
            carrier.carryingFlag = null;
            this.returnFlag(flag, null, true);
            this.announceCaptured(ownFlag.team, flag.team, this.displayName(carrier), carrier === this.player);
            events.emit('net:flagCaptured', { team: ownFlag.team, flagTeam: flag.team, byKey: this.keyOf(carrier) });
            match.addScore(ownFlag.team);
          }
        }
        continue;
      }

      if (flag.state === FLAG_STATE.DROPPED) {
        flag.dropTimer -= deltaSeconds;
        if (flag.dropTimer <= 0) {
          this.returnFlag(flag);
          continue;
        }
      }

      for (const participant of participants) {
        if (Math.hypot(participant.position.x - flag.position.x, participant.position.z - flag.position.z) > CTF.pickupRadius) continue;
        if (participant.team === flag.team) {
          if (flag.state === FLAG_STATE.DROPPED) this.returnFlag(flag, participant.name);
        } else if (!participant.entity.carryingFlag) {
          flag.state = FLAG_STATE.CARRIED;
          flag.carrier = participant.entity;
          participant.entity.carryingFlag = flag;
          this.announceTaken(flag, participant.entity);
        }
        break;
      }
    }
    this.animate();
  }

  animate() {
    for (const flag of Object.values(this.flags)) {
      const { group, cloth, restPositions } = flag.visual;
      const positions = cloth.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) {
        const restX = restPositions[index * 3];
        const restY = restPositions[index * 3 + 1];
        const wave = Math.sin(restX * 3.2 - this.elapsed * 6 + restY * 0.8) * 0.16 * (restX / 1.7);
        positions.setZ(index, wave);
        positions.setY(index, restY - (restX / 1.7) * 0.08);
      }
      positions.needsUpdate = true;
      cloth.geometry.computeVertexNormals();

      if (flag.state === FLAG_STATE.CARRIED) {
        group.position.set(flag.position.x, flag.carrier === this.player ? 0.6 : 1.2, flag.position.z);
        group.scale.setScalar(0.6);
      } else {
        group.position.copy(flag.position);
        group.scale.setScalar(1);
        group.rotation.y += 0.004;
      }
      flag.pad.userData.ring.material.opacity = flag.state === FLAG_STATE.HOME ? 0.9 : 0.35 + Math.sin(this.elapsed * 8) * 0.25;
    }
  }

  // ------------------------------------------------------------------ bot objectives
  /** CTF goal for a bot, or null outside CTF. */
  getObjectiveFor(bot) {
    if (!this.isActive) return null;
    const ownFlag = this.flags[bot.team];
    const enemyFlag = this.flags[bot.team === 'blue' ? 'red' : 'blue'];
    if (bot.carryingFlag) return { x: ownFlag.home.x, z: ownFlag.home.z, speed: 1.05 };

    const teammates = this.bots.filter((other) => other.team === bot.team);
    const defenderCount = Math.max(teammates.length > 1 ? 1 : 0, Math.floor(teammates.length * CTF.defenderShare));
    const isDefender = teammates.indexOf(bot) < defenderCount;

    // Own flag in danger: defenders and odd-indexed attackers chase it.
    if (ownFlag.state !== FLAG_STATE.HOME && (isDefender || teammates.indexOf(bot) % 2 === 1)) {
      return { x: ownFlag.position.x, z: ownFlag.position.z, speed: 1.1 };
    }
    if (isDefender) {
      let waypoint = this.defenderWaypoints.get(bot);
      if (!waypoint || Math.hypot(waypoint.x - bot.position.x, waypoint.z - bot.position.z) < 2.5) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 4 + Math.random() * 9;
        waypoint = { x: ownFlag.home.x + Math.cos(angle) * radius, z: ownFlag.home.z + Math.sin(angle) * radius * 0.6 - Math.sign(ownFlag.home.z) * 5 };
        this.defenderWaypoints.set(bot, waypoint);
      }
      return { x: waypoint.x, z: waypoint.z, speed: 0.7 };
    }
    // Attackers: go for the enemy flag, or escort a friendly carrier.
    if (enemyFlag.state === FLAG_STATE.CARRIED && enemyFlag.carrier !== bot) {
      return { x: enemyFlag.position.x + 3, z: enemyFlag.position.z, speed: 1 };
    }
    return { x: enemyFlag.position.x, z: enemyFlag.position.z, speed: 1.05 };
  }
}
