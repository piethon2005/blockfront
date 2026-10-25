// =====================================================================
// Match manager — rules of the game: damage & kill credit, team scores,
// personal points, coins, the match timer, dog tags (Kill Confirmed),
// and victory/defeat for every mode (tags / kills / flags). It never touches the DOM: it emits events that the
// HUD, audio and effects systems listen to.
//
// Multiplayer: the host is the referee. Remote humans (avatars) take part
// in scoring and tag pickups; guests mirror timer/scores/points from host
// snapshots and spawn/remove tags by id.
// =====================================================================

import * as THREE from 'three';
import { MATCH, MODES, TEAMS } from '../config.js';
import { events } from '../core/events.js';
import { createCanvasTexture } from '../world/materials.js';
import { netState } from '../net/netState.js';

// ------------------------------------------------------------------ dog tag visuals
let sharedTagAssets = null;
function getTagAssets() {
  if (sharedTagAssets) return sharedTagAssets;

  const outline = new THREE.Shape();
  const width = 0.5;
  const height = 0.72;
  const radius = 0.14;
  outline.moveTo(-width / 2 + radius, -height / 2);
  outline.lineTo(width / 2 - radius, -height / 2);
  outline.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
  outline.lineTo(width / 2, height / 2 - radius);
  outline.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
  outline.lineTo(-width / 2 + radius, height / 2);
  outline.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
  outline.lineTo(-width / 2, -height / 2 + radius);
  outline.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
  const hole = new THREE.Path();
  hole.absarc(0, height / 2 - 0.12, 0.05, 0, Math.PI * 2, true);
  outline.holes.push(hole);
  const tagGeometry = new THREE.ExtrudeGeometry(outline, { depth: 0.05, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2 });
  tagGeometry.center();

  // Vertical fade texture for the light beam.
  const beamTexture = createCanvasTexture(64, (context, size) => {
    const gradient = context.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    gradient.addColorStop(1, 'rgba(255,255,255,0.9)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  });

  const materialsByTeam = {};
  for (const teamId of Object.keys(TEAMS)) {
    const color = new THREE.Color(TEAMS[teamId].tagColor);
    materialsByTeam[teamId] = {
      tag: new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.4, metalness: 0.6, roughness: 0.3 }),
      beam: new THREE.MeshBasicMaterial({
        color: color.clone().multiplyScalar(1.6), map: beamTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }),
      ring: new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    };
  }

  sharedTagAssets = {
    tagGeometry,
    beamGeometry: new THREE.CylinderGeometry(0.32, 0.32, 5, 20, 1, true).translate(0, 2.5, 0),
    ringGeometry: new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2),
    materialsByTeam,
  };
  return sharedTagAssets;
}

class DogTag {
  constructor(scene, x, z, team) {
    const assets = getTagAssets();
    const materials = assets.materialsByTeam[team];
    this.team = team;
    this.x = x;
    this.z = z;
    this.lifetime = MATCH.tagLifetime;
    this.age = 0;

    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    this.tagMesh = new THREE.Mesh(assets.tagGeometry, materials.tag);
    this.tagMesh.position.y = 1;
    this.tagMesh.castShadow = true;
    this.beamMesh = new THREE.Mesh(assets.beamGeometry, materials.beam);
    this.ringMesh = new THREE.Mesh(assets.ringGeometry, materials.ring);
    this.ringMesh.position.y = 0.04;
    this.group.add(this.tagMesh, this.beamMesh, this.ringMesh);
    scene.add(this.group);
    this.scene = scene;
  }

  update(deltaSeconds) {
    this.lifetime -= deltaSeconds;
    this.age += deltaSeconds;
    const popIn = Math.min(1, this.age * 4);
    this.tagMesh.rotation.y += deltaSeconds * 3;
    this.tagMesh.position.y = 1 + Math.sin(this.age * 4) * 0.15;
    this.tagMesh.scale.setScalar(popIn);
    const pulse = 1 + Math.sin(this.age * 6) * 0.12;
    this.ringMesh.scale.set(pulse, 1, pulse);
    // Blink during the final 4 seconds.
    this.group.visible = this.lifetime > 4 || Math.sin(this.age * 20) > -0.3;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

// ------------------------------------------------------------------ match manager
export class MatchManager {
  constructor({ scene, player, bots, remotePlayers = [] }) {
    this.scene = scene;
    this.player = player;
    this.bots = bots;
    this.remotePlayers = remotePlayers;
    this.nextTagId = 1;
    this.modeIndex = 0;
    this.tags = [];
    this.reset();
  }

  get mode() {
    return MODES[this.modeIndex];
  }

  setMode(modeIndex) {
    this.modeIndex = modeIndex;
  }

  reset() {
    this.tags.forEach((tag) => tag.dispose());
    this.tags = [];
    this.scores = { red: 0, blue: 0 };
    this.timeRemaining = MATCH.durationSeconds;
    this.isOver = false;
    this.playerKills = 0;
    this.coins = 0;
    this.lastCountdownSecond = -1;
    this.points = { [this.player.internalName]: 0 };
    for (const bot of this.bots) this.points[bot.name] = 0;
    for (const remote of this.remotePlayers) this.points[remote.name] = 0;
  }

  // ------------------------------------------------------------------ network
  snapshot() {
    return { scores: this.scores, time: +this.timeRemaining.toFixed(2), points: this.points, over: this.isOver };
  }

  /** Guest: adopt the host's referee state. */
  applySnapshot({ scores, time, points }) {
    const scoreChanged = scores.red !== this.scores.red || scores.blue !== this.scores.blue;
    const changedTeam = scores.red !== this.scores.red ? 'red' : 'blue';
    this.scores = { ...scores };
    if (Math.abs(this.timeRemaining - time) > 0.5) this.timeRemaining = time;
    this.points = points;
    if (scoreChanged) events.emit('score:changed', { scores: this.scores, team: changedTeam });
    events.emit('board:changed', { points: this.points });
  }

  removeTagById(id) {
    const index = this.tags.findIndex((tag) => tag.id === id);
    if (index < 0) return;
    this.tags[index].dispose();
    this.tags.splice(index, 1);
  }

  /** Host: a remote human died (victim-authoritative report). */
  onRemotePlayerDeath(avatar, killer, options = {}) {
    if (this.isOver) return;
    const killerInfo = this.attackerInfo(killer);
    if (this.mode.rules === 'tags') this.spawnTag(avatar.position.x, avatar.position.z, avatar.team);
    else if (this.mode.rules === 'kills' && killerInfo.team && killerInfo.team !== avatar.team) this.addScore(killerInfo.team);
    if (killerInfo.team && killerInfo.team !== avatar.team) this.addPoints(killerInfo.name, MATCH.pointsPerKill);
    if (killerInfo.isPlayer) {
      this.playerKills++;
      this.addCoins(MATCH.coinsPerKill);
      events.emit('hit:confirm', { isHeadshot: !!options.isHeadshot, isKill: true });
    } else if (killerInfo.peerId && killerInfo.peerId !== avatar.peerId) {
      events.emit('net:hitConfirm', { peerId: killerInfo.peerId, isHeadshot: !!options.isHeadshot, isKill: true });
    }
    this.pushFeed(killerInfo, { name: avatar.name, team: avatar.team }, options);
  }

  start(mapConfig) {
    events.emit('match:start', { mode: this.mode, map: mapConfig });
    events.emit('score:changed', { scores: this.scores, team: null });
    events.emit('board:changed', { points: this.points });
  }

  attackerInfo(attacker) {
    // attacker may be the Player, a Bot, a remote human avatar, or plain { name, team } info.
    if (!attacker) return { name: 'World', team: null, isPlayer: false };
    if (attacker === this.player) return { name: this.player.internalName, team: this.player.team, isPlayer: true };
    return { name: attacker.name, team: attacker.team, isPlayer: false, peerId: attacker.peerId ?? null };
  }

  // ------------------------------------------------------------------ damage
  /**
   * Damage a bot. options: { isHeadshot, weaponName, point, isExplosion }
   * Returns true if the bot died.
   */
  damageBot(bot, amount, attacker, options = {}) {
    if (this.isOver || bot.isDead) return false;
    const attackerInfo = this.attackerInfo(attacker);
    if (attackerInfo.team === bot.team && !options.isExplosion) return false;

    const killed = bot.applyDamage(amount);
    events.emit('bot:hurt', { bot, amount, point: options.point, isHeadshot: !!options.isHeadshot });
    if (attackerInfo.isPlayer) events.emit('hit:confirm', { isHeadshot: !!options.isHeadshot, isKill: killed });
    else if (attackerInfo.peerId && killed) events.emit('net:hitConfirm', { peerId: attackerInfo.peerId, isHeadshot: !!options.isHeadshot, isKill: true });
    if (!killed) return false;

    const deathPosition = bot.position.clone();
    events.emit('bot:death', { bot, killerName: attackerInfo.name, position: deathPosition });
    if (this.mode.rules === 'tags') this.spawnTag(deathPosition.x, deathPosition.z, bot.team);
    else if (this.mode.rules === 'kills' && attackerInfo.team && attackerInfo.team !== bot.team) this.addScore(attackerInfo.team);

    if (attackerInfo.team !== bot.team) this.addPoints(attackerInfo.name, MATCH.pointsPerKill);
    this.pushFeed(attackerInfo, { name: bot.name, team: bot.team }, options);

    if (attackerInfo.isPlayer) {
      this.playerKills++;
      this.addCoins(MATCH.coinsPerKill);
      // Kill banners (headshot / multi-kill / streak) come from the Announcer.
    }
    return true;
  }

  /** Damage the player. Returns true if the player died. */
  damagePlayer(amount, attacker, options = {}) {
    if (this.isOver || !this.player.isAlive) return false;
    const attackerInfo = this.attackerInfo(attacker);
    const sourcePosition = attacker && attacker.position ? attacker.position.clone() : options.sourcePosition || null;
    const killed = this.player.takeDamage(amount, attackerInfo.name, sourcePosition);
    if (!killed) return false;
    if (!netState.isAuthority) {
      // Guest: report the death; the host referees score, tags and the kill feed.
      events.emit('net:death', { killer: { name: attackerInfo.name, team: attackerInfo.team, peerId: attackerInfo.peerId || null }, options: { isHeadshot: !!options.isHeadshot, weaponName: options.weaponName || null, weaponId: options.weaponId || null, isExplosion: !!options.isExplosion } });
      events.emit('toast', { text: 'YOU WERE ELIMINATED', style: 'danger' });
      return true;
    }
    if (attackerInfo.peerId) events.emit('net:hitConfirm', { peerId: attackerInfo.peerId, isHeadshot: !!options.isHeadshot, isKill: true });

    if (this.mode.rules === 'tags') this.spawnTag(this.player.position.x, this.player.position.z, this.player.team);
    else if (this.mode.rules === 'kills' && attackerInfo.team && attackerInfo.team !== this.player.team) this.addScore(attackerInfo.team);
    if (attackerInfo.team && attackerInfo.team !== this.player.team) this.addPoints(attackerInfo.name, MATCH.pointsPerKill);
    this.pushFeed(attackerInfo, { name: this.player.internalName, team: this.player.team }, options);
    events.emit('toast', { text: attackerInfo.isPlayer ? 'SELF-ELIMINATED' : 'YOU WERE ELIMINATED', style: 'danger' });
    return true;
  }

  pushFeed(attackerInfo, victim, options) {
    events.emit('feed:add', {
      killer: attackerInfo.name,
      killerTeam: attackerInfo.team,
      victim: victim.name,
      victimTeam: victim.team,
      weaponName: options.isExplosion ? 'BARREL' : options.weaponName || 'RIFLE',
      weaponId: options.isExplosion ? 'barrel' : options.weaponId || null,
      isHeadshot: !!options.isHeadshot,
    });
  }

  // ------------------------------------------------------------------ scoring
  addScore(team) {
    if (this.isOver) return;
    this.scores[team]++;
    events.emit('score:changed', { scores: this.scores, team });
    if (this.scores[team] >= this.mode.scoreGoal) this.end();
  }

  addPoints(name, amount) {
    if (!(name in this.points)) return;
    this.points[name] += amount;
    events.emit('board:changed', { points: this.points });
  }

  addCoins(amount) {
    this.coins += amount;
    events.emit('coins:changed', { coins: this.coins });
  }

  // ------------------------------------------------------------------ tags
  spawnTag(x, z, team, id = null) {
    const tag = new DogTag(this.scene, x, z, team);
    tag.id = id ?? this.nextTagId++;
    this.tags.push(tag);
    events.emit('tag:spawn', { tag, id: tag.id, x, z, team });
  }

  collectTag(tag, collectorTeam, collectorName, isPlayer) {
    const denied = collectorTeam === tag.team;
    events.emit('tag:pickup', {
      tag, collectorName, collectorTeam, isPlayer, denied, position: new THREE.Vector3(tag.x, 1, tag.z), ourTeam: this.player.team,
    });
    if (denied) {
      if (isPlayer) events.emit('toast', { text: 'TAG DENIED', style: 'default' });
      return;
    }
    this.addPoints(collectorName, MATCH.pointsPerTag);
    if (isPlayer) {
      this.addCoins(MATCH.coinsPerTag);
      events.emit('toast', { text: 'TAG CONFIRMED', style: 'gold' });
    }
    this.addScore(collectorTeam);
  }

  updateTags(deltaSeconds) {
    for (let index = this.tags.length - 1; index >= 0 && !this.isOver; index--) {
      const tag = this.tags[index];
      tag.update(deltaSeconds);
      let consumed = tag.lifetime <= 0;

      if (!consumed && this.player.isAlive && Math.hypot(this.player.position.x - tag.x, this.player.position.z - tag.z) < MATCH.tagPickupRadius) {
        this.collectTag(tag, this.player.team, this.player.internalName, true);
        consumed = true;
      }
      if (!consumed) {
        for (const bot of this.bots.concat(this.remotePlayers)) {
          if (!bot.isDead && Math.hypot(bot.position.x - tag.x, bot.position.z - tag.z) < MATCH.tagPickupRadius) {
            this.collectTag(tag, bot.team, bot.name, false);
            consumed = true;
            break;
          }
        }
      }
      if (consumed) {
        tag.dispose();
        this.tags.splice(index, 1);
        events.emit('tag:removed', { id: tag.id });
      }
    }
  }

  // ------------------------------------------------------------------ frame & end
  update(deltaSeconds) {
    if (this.isOver) return;
    this.timeRemaining = Math.max(0, this.timeRemaining - deltaSeconds);
    if (!netState.isAuthority) {
      // Guests only animate tags and run the countdown beeps; the host referees.
      for (const tag of this.tags) tag.update(deltaSeconds);
      const secondsLeftGuest = Math.ceil(this.timeRemaining);
      if (secondsLeftGuest <= MATCH.countdownBeepFrom && secondsLeftGuest > 0 && secondsLeftGuest !== this.lastCountdownSecond) {
        this.lastCountdownSecond = secondsLeftGuest;
        events.emit('match:countdown', { secondsLeft: secondsLeftGuest });
      }
      return;
    }
    const secondsLeft = Math.ceil(this.timeRemaining);
    if (secondsLeft <= MATCH.countdownBeepFrom && secondsLeft > 0 && secondsLeft !== this.lastCountdownSecond) {
      this.lastCountdownSecond = secondsLeft;
      events.emit('match:countdown', { secondsLeft });
    }
    this.updateTags(deltaSeconds);
    if (this.timeRemaining <= 0) this.end();
  }

  end() {
    if (this.isOver) return;
    this.isOver = true;
    const playerTeam = this.player.team;
    const enemyTeam = playerTeam === 'blue' ? 'red' : 'blue';
    const result = this.scores[playerTeam] > this.scores[enemyTeam] ? 'victory' : this.scores[playerTeam] === this.scores[enemyTeam] ? 'draw' : 'defeat';
    events.emit('match:end', { result, scores: { ...this.scores }, kills: this.playerKills, scoreLabel: this.mode.scoreLabel });
  }
}
