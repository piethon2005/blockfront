// =====================================================================
// Replicator — keeps an online match in sync.
//
// Model (host-authoritative world, owner-authoritative players):
//   • Every browser simulates its OWN soldier (movement, shooting, pet)
//     and streams it to everyone ('ps' ~20 Hz, 'fire' per shot).
//   • The HOST simulates the world: bots, scoring, dog tags, flags,
//     loot, supply drops, donkeys, barrels and weather, and streams
//     snapshots ('bs', 'ms', 'fl', 'ds') plus one-off world events ('ev').
//   • Damage is victim-authoritative: the shooter sends 'hit' to the
//     victim's owner, who applies it and reports its own 'death'.
//     Shots at bots go to the host as 'botHit'.
//   • Destruction is shared: everyone broadcasts the voxel damage they
//     cause ('vx'); explosions are replayed from the host's 'explosion'.
//
// Guests ask the host for anything that changes the world
// (loot pickups/drops, opening supply drops, hitting donkeys/barrels).
// =====================================================================

import * as THREE from 'three';
import { BOT, BOT_WEAPON_IDS, MATCH, WEAPONS } from '../config.js';
import { BOT_ABILITY_IDS } from '../entities/bot.js';
import { events } from '../core/events.js';
import { netState } from './netState.js';

const SNAPSHOT_KINDS = new Set(['ps', 'bs', 'ms', 'fl', 'ds']);
const RATES = { player: 1 / 20, bots: 1 / 12, match: 1 / 3, flags: 1 / 6, donkeys: 1 / 6 };
const round = (value) => Math.round(value * 100) / 100;
const vec = (vector) => [round(vector.x), round(vector.y), round(vector.z)];
const toVector = (array) => new THREE.Vector3(array[0], array[1], array[2]);

export class Replicator {
  /**
   * game: { net, player, pet, inventory, weapons, abilities, bots, remotePlayers, match, flags, loot,
   *         supplyDrops, donkeys, hazards, weather, voxelWorld, createAvatar(peer), removeAvatar(avatar),
   *         createRemotePet(), onMatchEnd(payload) }
   */
  constructor(game) {
    this.game = game;
    this.active = false;
    this.queue = [];
    this.latestSnapshots = new Map();
    this.timers = { player: 0, bots: 0, match: 0, flags: 0, donkeys: 0 };
    this.voxelOps = [];
    this.avatarsByPeer = new Map();
    this.remotePets = new Map();
    this.unsubscribers = [];
    events.on('net:relay', ({ from, data }) => this.receive(from, data));
    this.bindLocalEvents();
  }

  get net() {
    return this.game.net;
  }

  // ------------------------------------------------------------------ lifecycle
  /** Step 1 (before the match resets): create a soldier + dog for every other human. players: [{ id, name, team }] */
  prepare(players) {
    this.clearAvatars();
    for (const peer of players) {
      if (peer.id === netState.myId) continue;
      const avatar = this.game.createAvatar(peer);
      this.avatarsByPeer.set(peer.id, avatar);
      this.remotePets.set(peer.id, this.game.createRemotePet());
    }
  }

  /** Step 2 (match reset done): start streaming and replay what arrived while loading. */
  activate() {
    this.active = true;
    this.timers = { player: 0, bots: 0, match: 0, flags: 0, donkeys: 0 };
    if (netState.isClient) this.send('host', { k: 'hello' });
    const pending = this.queue;
    const latest = this.latestSnapshots;
    this.queue = [];
    this.latestSnapshots = new Map();
    for (const { from, data } of pending) this.receive(from, data);
    for (const { from, data } of latest.values()) this.receive(from, data);
  }

  stop() {
    this.active = false;
    this.queue = [];
    this.latestSnapshots = new Map();
    this.voxelOps = [];
    this.clearAvatars();
  }

  clearAvatars() {
    for (const avatar of this.avatarsByPeer.values()) this.game.removeAvatar(avatar);
    for (const pet of this.remotePets.values()) pet.dispose();
    this.avatarsByPeer.clear();
    this.remotePets.clear();
  }

  /** A player left mid-match. */
  removePeer(peerId) {
    const avatar = this.avatarsByPeer.get(peerId);
    if (avatar) {
      if (netState.isAuthority) this.game.flags.dropFlagOf(avatar);
      this.game.removeAvatar(avatar);
      this.avatarsByPeer.delete(peerId);
    }
    const pet = this.remotePets.get(peerId);
    if (pet) {
      pet.dispose();
      this.remotePets.delete(peerId);
    }
  }

  send(to, data) {
    if (this.net) this.net.relay(to, data);
  }

  // ------------------------------------------------------------------ name / entity mapping
  /** Outgoing: the local player's internal name 'You' becomes their callsign. */
  outName(name) {
    return name === this.game.player.internalName ? netState.myName : name;
  }

  /** Incoming: our own callsign becomes 'You' again. */
  inName(name) {
    return name === netState.myName ? this.game.player.internalName : name;
  }

  mapPoints(points, mapper) {
    const result = {};
    for (const [name, value] of Object.entries(points)) result[mapper(name)] = value;
    return result;
  }

  /** Stable network key for the player, an avatar or a bot. */
  keyOf(entity) {
    if (entity === this.game.player) return `p:${netState.myId}`;
    if (entity.isRemotePlayer) return `p:${entity.peerId}`;
    return `b:${entity.name}`;
  }

  resolveKey(key) {
    if (!key) return null;
    if (key === `p:${netState.myId}`) return this.game.player;
    if (key.startsWith('p:')) return this.avatarsByPeer.get(key.slice(2)) || null;
    return this.game.bots.find((bot) => bot.name === key.slice(2)) || null;
  }

  /** Turn { name, team, peerId } into the local entity when possible (for positions and kill credit). */
  resolveAttacker(info) {
    if (!info) return null;
    if (info.peerId) {
      if (info.peerId === netState.myId) return this.game.player;
      const avatar = this.avatarsByPeer.get(info.peerId);
      if (avatar) return avatar;
    }
    const bot = this.game.bots.find((candidate) => candidate.name === info.name);
    if (bot) return bot;
    return { name: this.inName(info.name), team: info.team, peerId: info.peerId || null };
  }

  attackerPayload(attacker) {
    if (!attacker) return null;
    if (attacker === this.game.player) return { name: netState.myName, team: attacker.team, peerId: netState.myId };
    return { name: attacker.name, team: attacker.team, peerId: attacker.peerId || null };
  }

  // ------------------------------------------------------------------ outgoing (local events)
  bindLocalEvents() {
    const on = (name, handler) => events.on(name, (payload) => {
      if (this.active && netState.isOnline) handler(payload);
    });
    const onHost = (name, handler) => on(name, (payload) => netState.isHost && handler(payload));
    const forward = (e, d) => this.send('all', { k: 'ev', e, d });

    // Our own soldier.
    on('weapon:fire', ({ weapon, muzzlePosition, tracerEnds }) => {
      this.send('all', { k: 'fire', w: weapon.id, o: vec(muzzlePosition), e: tracerEnds.slice(0, 3).map(vec) });
    });
    on('net:death', ({ killer, options }) => this.send('all', { k: 'death', killer, options }));

    // Guest requests to the host.
    on('net:lootRequest', ({ id }) => this.send('host', { k: 'lootReq', id }));
    on('net:lootDrop', (data) => this.send('host', { k: 'lootDrop', ...data }));
    on('net:supplyOpen', () => this.send('host', { k: 'supplyOpen' }));
    on('net:donkeyHit', ({ id, amount }) => this.send('host', { k: 'donkeyHit', id, amount }));
    on('net:barrelHit', ({ index, amount }) => this.send('host', { k: 'barrelHit', index, amount }));

    // Host: referee results that concern one guest.
    onHost('net:hitConfirm', ({ peerId, isKill, isHeadshot }) => {
      if (peerId !== netState.myId) this.send(peerId, { k: 'hc', isKill, isHeadshot });
    });

    // Host: world events everyone must see.
    onHost('feed:add', (entry) => forward('feed', { ...entry, killer: this.outName(entry.killer), victim: this.outName(entry.victim) }));
    onHost('tag:spawn', ({ id, x, z, team }) => forward('tagSpawn', { id, x, z, team }));
    onHost('tag:removed', ({ id }) => forward('tagRemoved', { id }));
    onHost('tag:pickup', ({ tag, collectorName, collectorTeam, denied }) => forward('tagPickup', { id: tag.id, x: tag.x, z: tag.z, team: tag.team, collectorName: this.outName(collectorName), collectorTeam, denied }));
    onHost('net:flagCaptured', ({ team, flagTeam, byKey }) => forward('flagCap', { team, flagTeam, byKey }));
    onHost('supply:incoming', ({ position }) => forward('supplyIn', { x: position.x, z: position.z }));
    onHost('supply:opened', () => forward('supplyOpen', {}));
    onHost('loot:spawned', ({ item }) => forward('lootSpawn', item));
    onHost('loot:removed', ({ id }) => forward('lootRemove', { id }));
    onHost('donkey:killed', ({ id, killerPeerId, byPlayer }) => forward('donkeyKilled', { id, killer: byPlayer ? netState.myId : killerPeerId }));
    onHost('barrel:state', ({ index, destroyed }) => forward('barrel', { index, destroyed }));
    onHost('explosion', ({ position, radius }) => forward('explosion', { p: vec(position), radius }));
    onHost('weather:start', ({ event }) => forward('weather', { id: event.id }));
    onHost('bot:fire', ({ bot, origin, target, didHit, silent }) => {
      if (bot.isPuppet) return;
      this.send('all', { k: 'bf', n: bot.name, o: vec(origin), t: vec(target), h: didHit ? 1 : 0, s: silent ? 1 : 0 });
    });
    // Bot moves everyone should see: dashes, teleports and donkey abilities.
    onHost('bot:dash', ({ bot, direction }) => !bot.isPuppet && forward('botFx', { e: 'dash', n: bot.name, d: vec(direction) }));
    onHost('bot:teleport', ({ bot, from, to }) => !bot.isPuppet && forward('botFx', { e: 'tp', n: bot.name, f: vec(from), t: vec(to) }));
    onHost('bot:ability', ({ bot, id }) => !bot.isPuppet && forward('botFx', { e: 'ab', n: bot.name, id }));
    onHost('match:end', ({ scores, scoreLabel }) => {
      forward('end', { scores, scoreLabel });
      if (this.net) this.net.endMatch();
    });
  }

  /** Damage to a voxel cell caused on this machine: apply locally and share it. */
  queueVoxelOp(structure, cell, damage) {
    if (!this.active || !netState.isOnline) return;
    const index = this.game.voxelWorld.structures.indexOf(structure);
    if (index < 0) return;
    this.voxelOps.push([index, cell[0], cell[1], cell[2], round(damage)]);
  }

  /** Host or guest: a bot / explosion / player hurt someone else's soldier. */
  damageRemotePlayer(avatar, amount, attacker, options = {}) {
    if (!avatar || avatar.isDead || !avatar.peerId) return;
    avatar.hitFlash = 1;
    const sourcePosition = attacker && attacker.position ? attacker.position : options.sourcePosition;
    this.send(avatar.peerId, {
      k: 'hit',
      amount: round(amount),
      from: this.attackerPayload(attacker),
      src: sourcePosition ? [round(sourcePosition.x), round(sourcePosition.z)] : null,
      options: { isHeadshot: !!options.isHeadshot, weaponName: options.weaponName || null, weaponId: options.weaponId || null, isExplosion: !!options.isExplosion },
    });
  }

  /** Guest: we shot a host bot — the host applies the damage. */
  requestBotHit(bot, amount, options = {}) {
    bot.hitFlash = 1;
    events.emit('bot:hurt', { bot, amount, point: options.point, isHeadshot: !!options.isHeadshot });
    events.emit('hit:confirm', { isHeadshot: !!options.isHeadshot, isKill: false });
    this.send('host', {
      k: 'botHit', name: bot.name, amount: round(amount),
      options: { isHeadshot: !!options.isHeadshot, weaponName: options.weaponName || null, weaponId: options.weaponId || null, point: options.point ? vec(options.point) : null },
    });
  }

  // ------------------------------------------------------------------ per-frame streaming
  update(deltaSeconds) {
    if (!this.active) return;
    const game = this.game;
    for (const key of Object.keys(this.timers)) this.timers[key] -= deltaSeconds;

    if (this.timers.player <= 0) {
      this.timers.player = RATES.player;
      const player = game.player;
      this.send('all', {
        k: 'ps',
        p: [round(player.position.x), round(player.position.y), round(player.position.z), round(player.yaw), round(player.pitch)],
        a: player.isAlive ? 1 : 0,
        c: player.isCrouching ? 1 : 0,
        d: player.isDisguised ? 1 : 0,
        g: player.isGhosted ? 1 : 0,
        s: round(player.horizontalSpeed || 0),
        f: player.timeSinceShot < 1.5 ? 1 : 0,
        pet: game.pet ? game.pet.netSnapshot() : null,
        w: game.weapons.weapon ? game.weapons.weapon.id : null,
      });
    }

    if (this.voxelOps.length) {
      this.send('all', { k: 'vx', ops: this.voxelOps });
      this.voxelOps = [];
    }

    // Remote puppets animate locally between snapshots.
    for (const pet of this.remotePets.values()) pet.updatePuppet(deltaSeconds);

    if (!netState.isHost) return;
    if (this.timers.bots <= 0) {
      this.timers.bots = RATES.bots;
      this.send('all', { k: 'bs', b: game.bots.map((bot) => bot.netSnapshot()) });
    }
    if (this.timers.match <= 0) {
      this.timers.match = RATES.match;
      const snapshot = game.match.snapshot();
      this.send('all', { k: 'ms', ...snapshot, points: this.mapPoints(snapshot.points, (name) => this.outName(name)) });
    }
    if (this.timers.flags <= 0 && game.flags.isActive) {
      this.timers.flags = RATES.flags;
      this.send('all', { k: 'fl', s: game.flags.snapshot() });
    }
    if (this.timers.donkeys <= 0) {
      this.timers.donkeys = RATES.donkeys;
      this.send('all', { k: 'ds', d: game.donkeys.snapshot() });
    }
  }

  /** Host: full world state for a guest that just finished loading. */
  sendInit(peerId) {
    const game = this.game;
    const drop = game.supplyDrops.activeDrop;
    this.send(peerId, {
      k: 'init',
      loot: game.loot.items.map((item) => game.loot.serialize(item)),
      tags: game.match.tags.map((tag) => [tag.id, tag.x, tag.z, tag.team]),
      barrels: game.hazards.barrels.filter((barrel) => barrel.isDestroyed).map((barrel) => barrel.index),
      supply: drop && drop.state !== 'opened' ? { x: drop.position.x, z: drop.position.z } : null,
      weather: game.weather.event ? game.weather.event.id : null,
      time: game.match.timeRemaining,
    });
  }

  // ------------------------------------------------------------------ incoming
  receive(from, data) {
    if (!data || typeof data !== 'object') return;
    if (!this.active) {
      // While loading: keep every one-off message, but only the newest of each snapshot stream.
      if (SNAPSHOT_KINDS.has(data.k)) this.latestSnapshots.set(`${from}:${data.k}`, { from, data });
      else if (this.queue.length < 3000) this.queue.push({ from, data });
      return;
    }
    const game = this.game;
    const isHost = netState.isHost;
    const fromHost = from === netState.hostId;
    switch (data.k) {
      case 'ps': this.onPlayerState(from, data); break;
      case 'fire': this.onRemoteFire(from, data); break;
      case 'death': this.onRemoteDeath(from, data); break;
      case 'vx': this.onVoxelOps(data.ops); break;
      case 'hit': this.onHit(data); break;
      case 'hc': {
        events.emit('hit:confirm', { isHeadshot: !!data.isHeadshot, isKill: !!data.isKill });
        if (data.isKill) {
          game.match.playerKills++;
          game.match.addCoins(MATCH.coinsPerKill);
        }
        break;
      }
      // ---- host-only requests
      case 'hello': if (isHost) this.sendInit(from); break;
      case 'botHit': if (isHost) this.onBotHit(from, data); break;
      case 'lootReq': {
        if (!isHost) break;
        const granted = game.loot.grantToRemote(data.id);
        this.send(from, { k: 'grant', id: data.id, item: granted });
        break;
      }
      case 'lootDrop': {
        if (!isHost) break;
        if (data.weaponId && WEAPONS[data.weaponId]) game.loot.spawnDroppedWeapon(data);
        break;
      }
      case 'supplyOpen': if (isHost) game.supplyDrops.openDrop(true); break;
      case 'donkeyHit': {
        if (!isHost) break;
        const donkey = game.donkeys.donkeys.find((candidate) => candidate.id === data.id);
        if (donkey) game.donkeys.damage(donkey, Number(data.amount) || 0, false, from);
        break;
      }
      case 'barrelHit': {
        if (!isHost) break;
        const barrel = game.hazards.barrels[data.index];
        if (barrel) barrel.takeDamage(Number(data.amount) || 0, this.avatarsByPeer.get(from) || null);
        break;
      }
      // ---- host → guests
      case 'grant': {
        game.loot.clearPending(data.id);
        if (data.item) {
          game.loot.applyGrant(data.item, game.player, game.inventory);
          game.weapons.syncWithInventory();
        }
        break;
      }
      case 'init': if (fromHost) this.onInit(data); break;
      case 'bs': if (fromHost) this.onBotSnapshot(data.b); break;
      case 'bf': if (fromHost) this.onBotFire(data); break;
      case 'ms': if (fromHost) game.match.applySnapshot({ ...data, points: this.mapPoints(data.points, (name) => this.inName(name)) }); break;
      case 'fl': if (fromHost) game.flags.applySnapshot(data.s); break;
      case 'ds': if (fromHost) game.donkeys.applySnapshot(data.d); break;
      case 'ev': if (fromHost) this.onWorldEvent(data.e, data.d); break;
      default: break;
    }
  }

  onPlayerState(from, data) {
    const avatar = this.avatarsByPeer.get(from);
    if (avatar) {
      const [x, y, z, yaw] = data.p;
      // Avatars face +Z at rotation 0; a camera with yaw 0 looks down -Z.
      avatar.applyNetState({ x, y, z, yaw: yaw + Math.PI, alive: !!data.a, engage: !!data.f, crouch: !!data.c, disguise: !!data.d, weaponId: data.w && WEAPONS[data.w] ? data.w : null });
      avatar.isGhosted = !!data.g;
      avatar.horizontalSpeed = data.s || 0;
      if (data.f) avatar.timeSinceShot = Math.min(avatar.timeSinceShot, 0.5);
    }
    const pet = this.remotePets.get(from);
    if (pet && data.pet) pet.applyNetState(data.pet);
  }

  onRemoteFire(from, data) {
    const avatar = this.avatarsByPeer.get(from);
    if (!avatar) return;
    avatar.timeSinceShot = 0;
    avatar.revealTimer = BOT.radarRevealTime;
    const definition = WEAPONS[data.w];
    const origin = toVector(data.o);
    avatar.playShotRecoil();
    (data.e || []).forEach((end, index) => {
      events.emit('bot:fire', { bot: avatar, origin, target: toVector(end), didHit: false, sound: definition ? definition.sound : null, weaponId: data.w, silent: index > 0, isRemoteHuman: true });
    });
    // Host: remote gunfire alerts nearby bots just like ours does.
    if (netState.isHost && !avatar.isGhosted) {
      for (const bot of this.game.bots) {
        if (bot.team !== avatar.team && !bot.isDead && bot.position.distanceTo(avatar.position) < 40) bot.alertAt(avatar.position);
      }
    }
  }

  onRemoteDeath(from, data) {
    const avatar = this.avatarsByPeer.get(from);
    if (!avatar) return;
    if (!avatar.isDead) avatar.applyNetState({ ...(avatar.netTarget || { x: avatar.position.x, z: avatar.position.z, yaw: 0 }), alive: false });
    if (!netState.isHost) return;
    const killer = this.resolveAttacker(data.killer);
    this.game.flags.dropFlagOf(avatar);
    this.game.match.onRemotePlayerDeath(avatar, killer, data.options || {});
  }

  onHit(data) {
    const game = this.game;
    const attacker = this.resolveAttacker(data.from);
    const options = { ...(data.options || {}) };
    if (data.src) options.sourcePosition = new THREE.Vector3(data.src[0], 1, data.src[1]);
    // Friendly fire is off: ignore hits from our own team (e.g. stale team data).
    if (attacker && attacker !== game.player && attacker.team === game.player.team && !options.isExplosion) return;
    const source = attacker && attacker.position ? attacker : { name: 'World', team: null, ...(attacker || {}), position: options.sourcePosition || null };
    game.match.damagePlayer(Number(data.amount) || 0, source, options);
  }

  onBotHit(from, data) {
    const bot = this.game.bots.find((candidate) => candidate.name === data.name);
    const avatar = this.avatarsByPeer.get(from);
    if (!bot || !avatar || bot.isDead) return;
    const options = { ...(data.options || {}) };
    if (options.point) options.point = toVector(options.point);
    this.game.match.damageBot(bot, Number(data.amount) || 0, avatar, options);
  }

  onVoxelOps(ops) {
    const world = this.game.voxelWorld;
    if (!Array.isArray(ops)) return;
    const normal = new THREE.Vector3(0, 1, 0);
    for (const [structureIndex, i, j, k, damage] of ops) {
      const structure = world.structures[structureIndex];
      if (!structure || !structure.inBounds(i, j, k) || !structure.isSolid(i, j, k)) continue;
      const point = structure.cellCenter(i, j, k);
      world.damageHit({ structure, cell: [i, j, k], point, normal }, damage, { byPlayer: false });
    }
  }

  onInit(data) {
    const game = this.game;
    game.loot.clear();
    for (const item of data.loot || []) game.loot.spawnFromNetwork(item);
    for (const [id, x, z, team] of data.tags || []) if (!game.match.tags.some((tag) => tag.id === id)) game.match.spawnTag(x, z, team, id);
    for (const index of data.barrels || []) game.hazards.applyState(index, true);
    if (data.supply) game.supplyDrops.launchDrop(data.supply);
    if (data.weather && !game.weather.event) game.weather.start(data.weather);
    if (typeof data.time === 'number') game.match.timeRemaining = data.time;
  }

  onBotSnapshot(list) {
    if (!Array.isArray(list)) return;
    const byName = new Map(this.game.bots.map((bot) => [bot.name, bot]));
    for (const [name, x, z, yaw, alive, engage, weaponIndex = -1, effects = 0] of list) {
      const bot = byName.get(name);
      if (!bot) continue;
      const abilityIndex = effects >> 1;
      bot.applyNetState({
        x, z, yaw, alive: !!alive, engage: !!engage,
        weaponId: BOT_WEAPON_IDS[weaponIndex] || null,
        disguise: !!(effects & 1),
        abilityId: abilityIndex > 0 ? BOT_ABILITY_IDS[abilityIndex - 1] : null,
      });
    }
  }

  onBotFire({ n, o, t, h, s }) {
    const bot = this.game.bots.find((candidate) => candidate.name === n);
    if (!bot) return;
    bot.revealTimer = BOT.radarRevealTime;
    bot.netEngage = true;
    const origin = toVector(o);
    const target = toVector(t);
    const definition = WEAPONS[bot.weaponId];
    if (!s) bot.playShotRecoil();
    events.emit('bot:fire', { bot, origin, target, didHit: !!h, weaponId: bot.weaponId, sound: definition ? definition.sound : null, silent: !!s });
    if (s) return;
    const player = this.game.player;
    if (!h && player.isAlive && player.team !== bot.team) bot.checkWhiz(origin, target, origin.distanceTo(target), { player });
  }

  onWorldEvent(name, data) {
    const game = this.game;
    switch (name) {
      case 'feed': {
        const entry = { ...data, killer: this.inName(data.killer), victim: this.inName(data.victim) };
        events.emit('feed:add', entry);
        break;
      }
      case 'tagSpawn':
        if (!game.match.tags.some((tag) => tag.id === data.id)) game.match.spawnTag(data.x, data.z, data.team, data.id);
        break;
      case 'tagRemoved':
        game.match.removeTagById(data.id);
        break;
      case 'tagPickup': {
        const tag = game.match.tags.find((candidate) => candidate.id === data.id) || { id: data.id, x: data.x, z: data.z, team: data.team };
        const isPlayer = data.collectorName === netState.myName;
        events.emit('tag:pickup', {
          tag, collectorName: this.inName(data.collectorName), collectorTeam: data.collectorTeam, isPlayer, denied: data.denied,
          position: new THREE.Vector3(data.x, 1, data.z), ourTeam: game.player.team,
        });
        if (isPlayer) {
          if (data.denied) events.emit('toast', { text: 'TAG DENIED', style: 'default' });
          else {
            game.match.addCoins(MATCH.coinsPerTag);
            events.emit('toast', { text: 'TAG CONFIRMED', style: 'gold' });
          }
        }
        game.match.removeTagById(data.id);
        break;
      }
      case 'flagCap': game.flags.applyCapture(data); break;
      case 'supplyIn': game.supplyDrops.launchDrop({ x: data.x, z: data.z }); break;
      case 'supplyOpen': game.supplyDrops.openDrop(false); break;
      case 'lootSpawn': game.loot.spawnFromNetwork(data); break;
      case 'lootRemove': game.loot.removeById(data.id); break;
      case 'donkeyKilled': game.donkeys.mirrorKill(data.id, data.killer === netState.myId); break;
      case 'barrel': game.hazards.applyState(data.index, data.destroyed); break;
      case 'explosion': events.emit('explosion', { position: toVector(data.p), radius: data.radius, byPlayer: false }); break;
      case 'weather': if (!game.weather.event) game.weather.start(data.id); break;
      case 'botFx': {
        const bot = game.bots.find((candidate) => candidate.name === data.n);
        if (!bot) break;
        if (data.e === 'dash') events.emit('bot:dash', { bot, position: bot.position.clone(), direction: toVector(data.d) });
        else if (data.e === 'tp') events.emit('bot:teleport', { bot, from: toVector(data.f), to: toVector(data.t) });
        else if (data.e === 'ab') events.emit('bot:ability', { bot, id: data.id, position: bot.position.clone() });
        break;
      }
      case 'end': game.onMatchEnd(data); break;
      default: break;
    }
  }
}
