// =====================================================================
// BATLZON — entry point.
// Boots every system, owns the game-state machine
// (menu → loading → ready → playing ⇄ paused → ended), routes input,
// wires combat (bullets, voxels, donkeys, pet), loot, supply drops,
// CTF flags, abilities and weather together, and runs the main loop
// with a world time-scale for Dead-Eye slow motion.
//
// Online play: the War Room lobby (ui/lobby.js) talks to the Node server
// through NetClient; when the host launches, every browser builds the
// same map/roster and the Replicator keeps the match in sync (see
// net/replicator.js for the authority model).
// =====================================================================

import * as THREE from 'three';
import { ABILITIES, GENDERS, MAPS, MODES, PLAYER, ROSTER, TRAITS, VOXEL, getSpawnPoints } from './config.js';
import { events } from './core/events.js';
import { saveSettings, settings } from './core/settings.js';
import { GameRenderer } from './engine/renderer.js';
import { PhysicsWorld } from './engine/physics.js';
import { Player } from './entities/player.js';
import { Bot } from './entities/bot.js';
import { Pet } from './entities/pet.js';
import { Inventory } from './entities/inventory.js';
import { WeaponSystem } from './entities/weapon.js';
import { MapBuilder } from './world/mapBuilder.js';
import { VoxelWorld } from './world/voxelWorld.js';
import { configureMaterials, windUniforms } from './world/materials.js';
import { MatchManager } from './systems/matchManager.js';
import { HazardManager } from './systems/hazardManager.js';
import { LootManager } from './systems/lootManager.js';
import { SupplyDropManager } from './systems/supplyDropManager.js';
import { MissionTracker } from './systems/missionTracker.js';
import { FlagManager } from './systems/flagManager.js';
import { DonkeyManager } from './systems/donkeyManager.js';
import { AbilityManager } from './systems/abilityManager.js';
import { WeatherManager } from './systems/weatherManager.js';
import { Announcer } from './systems/announcer.js';
import { EffectsManager } from './systems/effectsManager.js';
import { BattleAmbience } from './systems/battleAmbience.js';
import { AudioManager } from './systems/audioManager.js';
import { Hud } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Lobby } from './ui/lobby.js';
import { netState } from './net/netState.js';
import { NetClient } from './net/netClient.js';
import { Replicator } from './net/replicator.js';

const GAME_STATE = { MENU: 'menu', LOADING: 'loading', READY: 'ready', PLAYING: 'playing', PAUSED: 'paused', ENDED: 'ended' };
const GUNFIRE_HEARING_RANGE = 40;
const ONLINE_SPAWN_JITTER = 8;
const ONLINE_DEADEYE_DAMAGE = 1.5;

// Input fed to the player while an online match runs behind the pause menu.
const idleInput = { keys: {}, firing: false, firePressed: false, aiming: false, jumpHeld: false, lookDeltaX: 0, lookDeltaY: 0, pointerLocked: false, everLocked: false };

const input = {
  keys: {},
  firing: false,
  firePressed: false,   // true only on the frame the trigger went down (semi-auto weapons)
  aiming: false,
  jumpHeld: false,
  lookDeltaX: 0,
  lookDeltaY: 0,
  pointerLocked: false,
  everLocked: false,
};

async function boot() {
  window.__batlzonBooted = true;

  // ------------------------------------------------------------------ core systems
  const gameRenderer = new GameRenderer();
  await gameRenderer.init(settings.graphicsQuality);
  configureMaterials({ maxAnisotropy: gameRenderer.maxAnisotropy });
  const { scene, camera } = gameRenderer;

  const physics = new PhysicsWorld();
  const voxelWorld = new VoxelWorld({ scene });
  physics.setVoxelWorld(voxelWorld);
  const mapBuilder = new MapBuilder({ scene, physics, voxelWorld });
  const hazards = new HazardManager({ scene, physics });
  const loot = new LootManager({ scene, physics });
  const supplyDrops = new SupplyDropManager({ scene, physics, loot });
  const donkeys = new DonkeyManager({ scene, physics });
  const weather = new WeatherManager({ gameRenderer });

  let currentMapIndex = Math.min(MAPS.length - 1, Math.max(0, settings.lastMapIndex || 0));
  let currentModeIndex = Math.min(MODES.length - 1, Math.max(0, settings.lastModeIndex || 0));

  const buildWorld = () => {
    const mapConfig = mapBuilder.build(currentMapIndex, gameRenderer.activePreset);
    gameRenderer.applyAtmosphere(mapConfig);
    hazards.build(mapConfig);
    loot.build();
    supplyDrops.reset();
    donkeys.reset();
    weather.reset();
    return mapConfig;
  };
  buildWorld();

  // ------------------------------------------------------------------ entities
  const player = new Player();
  player.sensitivityScale = settings.mouseSensitivityScale;
  const applyCustomisation = () => {
    player.setTrait(settings.trait);
    player.gender = settings.gender;
  };
  applyCustomisation();
  const inventory = new Inventory(settings.loadout);
  const weapons = new WeaponSystem({ camera, inventory });
  weapons.setGender(settings.gender);
  const pet = new Pet({ scene });
  pet.spawnNear(player);

  // Bot roster depends on the mode (1v1, 4v4...). The array object is shared, so it is mutated in place.
  // Online, humans take bot slots: counts[team] overrides the mode's roster.
  // On guests the bots are puppets mirrored from the host.
  const bots = [];
  const spawnRoster = (mode, counts = null) => {
    bots.forEach((bot) => bot.dispose());
    bots.length = 0;
    for (const team of ['red', 'blue']) {
      const count = counts ? counts[team] : mode.roster[team];
      for (let index = 0; index < count; index++) {
        const spawnList = getSpawnPoints(team);
        const spawn = spawnList[index % spawnList.length];
        const name = ROSTER[team][index % ROSTER[team].length] + (index >= ROSTER[team].length ? `-${Math.floor(index / ROSTER[team].length) + 1}` : '');
        bots.push(new Bot({ name, team, spawn, scene, showNameTag: team === player.team, isPuppet: netState.isClient }));
      }
    }
  };
  spawnRoster(MODES[currentModeIndex]);

  // Other humans in an online match (their soldiers, driven by the network).
  const remotePlayers = [];

  const match = new MatchManager({ scene, player, bots, remotePlayers });
  match.setMode(currentModeIndex);
  const flags = new FlagManager({ scene, player, bots, remotePlayers });

  // ------------------------------------------------------------------ feedback systems
  const effects = new EffectsManager({ scene, camera });
  const ambience = new BattleAmbience({ scene, effects, camera });
  const audio = new AudioManager({ master: settings.volumeMaster, music: settings.volumeMusic, sfx: settings.volumeSfx });
  audio.bindGameEvents();
  audio.voicePitch = GENDERS[settings.gender].voicePitch;
  const missionTracker = new MissionTracker();
  const announcer = new Announcer();
  const abilities = new AbilityManager({ scene, camera, player, physics, gameRenderer });
  const hud = new Hud();
  const refreshHudRoster = () => {
    const teamByName = new Map();
    for (const bot of bots) teamByName.set(bot.name, bot.team);
    for (const remote of remotePlayers) teamByName.set(remote.name, remote.team);
    hud.setTeams(teamByName, player.team);
  };
  refreshHudRoster();
  hud.setScoreGoal(MODES[currentModeIndex]);
  hud.setTrait(TRAITS[settings.trait]);
  hud.renderSlots(inventory);

  // ------------------------------------------------------------------ combat wiring
  const scratchNormalMatrix = new THREE.Matrix3();
  const combat = {
    player,
    bots,
    /** Raycast a player shot or slash against the world, voxels, enemy bots, barrels and donkeys. */
    traceShot(origin, direction, range) {
      const targets = [];
      for (const bot of bots) {
        if (bot.isDead || bot.team === player.team) continue;
        targets.push(...bot.hitboxes);
        if (bot.isDisguised) targets.push(bot.propMesh);
      }
      for (const remote of remotePlayers) {
        if (remote.isDead || remote.team === player.team) continue;
        if (remote.isDisguised && remote.propMesh) targets.push(remote.propMesh);
        else targets.push(...remote.hitboxes);
      }
      targets.push(...hazards.hitTargets, ...donkeys.hitTargets);
      const hit = physics.raycastFirst(origin, direction, range, targets);
      if (!hit) return null;
      if (hit.voxel) {
        return {
          point: hit.point, object: hit.object, distance: hit.distance, worldNormal: hit.voxel.normal.clone(), voxel: hit.voxel,
          surfaceColor: voxelWorld.cellColor(hit.voxel.structure, hit.voxel.cell), bot: null, isHead: false, barrel: null, donkey: null,
        };
      }
      let worldNormal = null;
      if (hit.face) {
        scratchNormalMatrix.getNormalMatrix(hit.object.matrixWorld);
        worldNormal = hit.face.normal.clone().applyMatrix3(scratchNormalMatrix).normalize();
      }
      return {
        point: hit.point,
        object: hit.object,
        distance: hit.distance,
        worldNormal,
        voxel: null,
        bot: hit.object.userData.bot || null,
        isHead: !!hit.object.userData.isHead,
        barrel: hit.object.userData.barrel || null,
        donkey: hit.object.userData.donkey || null,
      };
    },
    applyShotHit(hit, weapon, damageScale = 1) {
      // Online Dead-Eye can't slow other players' worlds, so it sharpens your rounds instead.
      const deadEyeBonus = netState.isOnline && abilities.isDeadEye ? ONLINE_DEADEYE_DAMAGE : 1;
      const damage = weapon.damage * damageScale * deadEyeBonus;
      if (hit.bot && !hit.bot.isDead) {
        combat.damageBot(hit.bot, damage * (hit.isHead ? weapon.headshotMultiplier : 1), player, {
          isHeadshot: hit.isHead && weapon.headshotMultiplier > 1, weaponName: weapon.shortName || weapon.name, weaponId: weapon.id, point: hit.point.clone(),
        });
      } else if (hit.barrel) {
        hit.barrel.takeDamage(damage, player);
      } else if (hit.donkey) {
        donkeys.damage(hit.donkey, damage, true);
      } else if (hit.voxel) {
        const heavy = VOXEL.heavyWeaponMultiplier[weapon.id] || 1;
        combat.damageVoxel(hit.voxel, damage * heavy, true);
      }
    },
    damagePlayer: (amount, attacker, options) => match.damagePlayer(amount, attacker, options),
    /** Any damage to a soldier other than ours: bots (local or host-owned) and other humans. */
    damageBot(bot, amount, attacker, options = {}) {
      if (bot.isRemotePlayer) {
        if (attacker === player) events.emit('hit:confirm', { isHeadshot: !!options.isHeadshot, isKill: false });
        replicator.damageRemotePlayer(bot, amount, attacker, options);
        return false;
      }
      if (!netState.isAuthority) {
        if (attacker === player) replicator.requestBotHit(bot, amount, options);
        return false;
      }
      return match.damageBot(bot, amount, attacker, options);
    },
    damageRemotePlayer: (avatar, amount, attacker, options) => replicator.damageRemotePlayer(avatar, amount, attacker, options),
    damagePet: (amount, attacker) => pet.takeDamage(amount, attacker ? attacker.name : 'World'),
    /** A bot shooting a donkey (authority only). Returns true when the donkey died. */
    damageDonkey: (donkey, amount, bot) => donkeys.damage(donkey, amount, false, null, bot),
    /** Voxel damage caused on this machine — shared with everyone online. */
    damageVoxel(voxelHit, amount, byPlayer) {
      voxelWorld.damageHit(voxelHit, amount, { byPlayer });
      replicator.queueVoxelOp(voxelHit.structure, voxelHit.cell, amount);
    },
    /** Stray bot rounds chip the first voxel they meet. */
    botShotImpact(from, to) {
      const hit = physics.raycastVoxels(from, to);
      if (hit) combat.damageVoxel({ ...hit, structure: hit.structure }, VOXEL.botMissDamage, false);
    },
  };
  hazards.setCombat(combat);

  const botWorld = {
    bots,
    remotePlayers,
    player,
    physics,
    combat,
    get tags() { return match.tags; },
    get pointOfInterest() { return supplyDrops.pointOfInterest; },
    // Online, bots leave the K9s alone (only the host's dog would be visible to them).
    get pet() { return netState.isOnline ? null : pet; },
    get donkeys() { return donkeys.donkeys; },
    get visibilityRange() { return weather.visibilityRange; },
    get timeScale() { return netState.isOnline ? 1 : abilities.timeScale; },
    getObjective: (bot) => flags.getObjectiveFor(bot),
  };
  const petWorld = { player, bots, remotePlayers, physics, combat };

  // Explosions blast holes in voxel structures.
  events.on('explosion', ({ position, byPlayer }) => voxelWorld.explode(position, VOXEL.explosionRadius, VOXEL.explosionDamage, { byPlayer }));

  // Bots that hunt a donkey get a random ability, just like the player.
  events.on('donkey:killed', ({ killerBot }) => {
    if (killerBot && !killerBot.isDead && netState.isAuthority) killerBot.grantAbility();
  });
  let lastAbilityNotice = 0;
  events.on('bot:ability', ({ bot, id }) => {
    if (!ABILITIES[id]) return;
    // In big battles only nearby or allied hunters are worth a notice, and never more than one every few seconds.
    const now = performance.now();
    if (now - lastAbilityNotice < 4000) return;
    if (bot.team !== player.team && bot.position.distanceTo(player.position) > 70) return;
    lastAbilityNotice = now;
    const isFriendly = bot.team === player.team;
    events.emit('notify', { text: `${bot.name.toUpperCase()} ${isFriendly ? '(ALLY)' : '(ENEMY)'} GOT ${ABILITIES[id].icon} ${ABILITIES[id].name}`, tone: isFriendly ? 'info' : 'danger' });
  });

  // Gunfire alerts nearby enemies — unless a crouched Ghost is shooting.
  events.on('weapon:fire', () => {
    player.timeSinceShot = 0;
    if (player.isGhosted) return;
    for (const bot of bots) {
      if (bot.team === player.team || bot.isDead) continue;
      if (bot.position.distanceTo(player.position) < GUNFIRE_HEARING_RANGE) bot.alertAt(player.position);
    }
  });

  // Death drops the player's primary; respawn re-issues the chosen loadout.
  events.on('player:death', () => {
    const primary = inventory.slots[2];
    if (primary) loot.dropWeapon(primary, player.position);
    if (inventory.medkits > 0 && netState.isAuthority) loot.spawnItem({ kind: 'medkit', position: player.position.clone().add(new THREE.Vector3(0.8, 0, -0.6)) });
  });
  events.on('player:respawn', () => {
    inventory.resetToLoadout(settings.loadout);
    weapons.syncWithInventory(true);
    if (!pet.isAlive || pet.position.distanceTo(player.position) > 30) pet.spawnNear(player);
  });

  // ------------------------------------------------------------------ state machine
  let gameState = GAME_STATE.MENU;

  const requestPointerLock = () => {
    try {
      const result = gameRenderer.webglRenderer.domElement.requestPointerLock();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Pointer lock unavailable (e.g. sandboxed iframe) — arrow keys still work.
    }
  };

  /** Reset every system for a fresh match (offline deploy or online launch). */
  const beginMatch = () => {
    const mode = MODES[currentModeIndex];
    applyCustomisation();
    match.reset();
    effects.clear();
    hud.clearFeed();
    loot.build();
    supplyDrops.reset();
    donkeys.reset();
    weather.reset();
    abilities.end(true);
    flags.setActive(!!mode.usesFlags);
    if (netState.isAuthority) bots.forEach((bot, index) => bot.placeAtSpawn(index));
    player.respawn();
    ambience.reset(MAPS[currentMapIndex].ambience || 'calm');
    effects.setAmbientParticles(MAPS[currentMapIndex].ambience === 'war' ? 'ash' : 'dust');
    for (const [x, z] of mapBuilder.fireSpots) effects.addEmitter({ kind: 'fire', position: new THREE.Vector3(x, 2.2, z), duration: Infinity });
    pet.spawnNear(player);
    match.start(MAPS[currentMapIndex]);
    menu.markMatchStarted();
    hud.show();
  };

  const startOrResume = () => {
    audio.unlock();
    if (gameState === GAME_STATE.READY) {
      beginMatch();
    } else if (gameState !== GAME_STATE.PAUSED) {
      return;
    }
    gameState = GAME_STATE.PLAYING;
    menu.hidePause();
    events.emit('game:resume', {});
    requestPointerLock();
  };

  const pauseGame = () => {
    if (gameState !== GAME_STATE.PLAYING) return;
    gameState = GAME_STATE.PAUSED;
    input.firing = false;
    input.aiming = false;
    if (hud.isChatOpen) hud.closeChat();
    menu.showPause();
    events.emit('game:pause', {});
  };

  // ------------------------------------------------------------------ multiplayer
  const net = new NetClient();
  const replicator = new Replicator({
    net, player, pet, inventory, weapons, abilities, bots, remotePlayers, match, flags, loot, supplyDrops, donkeys, hazards, weather, voxelWorld,
    createAvatar: (peer) => {
      const spawn = getSpawnPoints(peer.team)[0];
      const avatar = new Bot({ name: peer.name, team: peer.team, spawn, scene, showNameTag: peer.team === player.team, isRemotePlayer: true, peerId: peer.id });
      remotePlayers.push(avatar);
      return avatar;
    },
    removeAvatar: (avatar) => {
      avatar.dispose();
      const index = remotePlayers.indexOf(avatar);
      if (index >= 0) remotePlayers.splice(index, 1);
      refreshHudRoster();
    },
    createRemotePet: () => new Pet({ scene, isPuppet: true }),
    onMatchEnd: ({ scores, scoreLabel }) => {
      if (match.isOver) return;
      match.isOver = true;
      match.scores = { ...scores };
      const enemyTeam = player.team === 'blue' ? 'red' : 'blue';
      const result = scores[player.team] > scores[enemyTeam] ? 'victory' : scores[player.team] === scores[enemyTeam] ? 'draw' : 'defeat';
      events.emit('match:end', { result, scores: { ...scores }, kills: match.playerKills, scoreLabel });
    },
  });
  // Flags identify carriers by network key so every screen agrees who holds them.
  flags.keyOf = (entity) => replicator.keyOf(entity);
  flags.resolveKey = (key) => replicator.resolveKey(key);

  const lobby = new Lobby({
    net,
    settings,
    getCallsign: () => menu.nickname,
    getGender: () => settings.gender,
    onUiClick: () => events.emit('ui:click', {}),
  });

  /** Humans per team decide how many bots fill in. */
  const rosterCountsFor = (mode, room) => {
    const humans = { red: 0, blue: 0 };
    for (const peer of room.players) humans[peer.team]++;
    if (!room.settings.botFill) return { red: 0, blue: 0 };
    // Offline, the player is the extra blue soldier on top of mode.roster.blue.
    return { red: Math.max(0, mode.roster.red - humans.red), blue: Math.max(0, mode.roster.blue + 1 - humans.blue) };
  };

  /** The host pressed START: build the shared battlefield and drop in. */
  const startOnlineMatch = async (room) => {
    if (gameState === GAME_STATE.LOADING) return;
    netState.mode = room.hostId === netState.myId ? 'host' : 'client';
    netState.roomCode = room.code;
    const me = room.players.find((peer) => peer.id === netState.myId);
    if (!me) return;
    player.team = room.settings.coop ? 'blue' : me.team;
    player.displayName = me.name;
    player.spawnJitter = ONLINE_SPAWN_JITTER;
    netState.myName = me.name;
    hud.setPlayerName(me.name);

    replicator.stop();
    currentMapIndex = Math.min(MAPS.length - 1, room.settings.mapIndex);
    currentModeIndex = Math.min(MODES.length - 1, room.settings.modeIndex);
    const mode = MODES[currentModeIndex];
    menu.selectedMapIndex = currentMapIndex;
    menu.selectedModeIndex = currentModeIndex;

    gameState = GAME_STATE.LOADING;
    lobby.hide();
    menu.hideMenu();
    menu.hideEnd();
    menu.hidePause();
    audio.stopMusic();
    await menu.runLoading(async () => {
      buildWorld();
      match.setMode(currentModeIndex);
      spawnRoster(mode, rosterCountsFor(mode, room));
      hud.setScoreGoal(mode);
      inventory.resetToLoadout(settings.loadout);
      weapons.syncWithInventory(true);
      gameRenderer.warmUp();
    });
    replicator.prepare(room.players);
    beginMatch();
    replicator.activate();
    refreshHudRoster();
    hud.setOnline(true, room.code);
    hud.addChatLine({ system: true, text: `${netState.isHost ? 'You are hosting.' : 'Connected to host.'} Press T to chat.` });
    menu.setOnlinePause(true);
    // A network start has no click to grab the mouse, so wait on the deploy card (the battle is already live).
    gameState = GAME_STATE.PAUSED;
    menu.showPause();
  };

  /** Leave the battlefield and go back to the War Room (or the hub if disconnected). */
  const returnToLobby = (message = null) => {
    replicator.stop();
    netState.mode = 'offline';
    player.spawnJitter = 0;
    player.team = 'blue';
    player.displayName = menu.nickname;
    hud.setPlayerName(menu.nickname);
    // Restore a normal single-player roster (guests were holding host-driven puppets).
    spawnRoster(MODES[currentModeIndex]);
    refreshHudRoster();
    flags.setActive(false);
    match.reset();
    match.isOver = true;
    abilities.end(true);
    gameState = GAME_STATE.MENU;
    input.firing = false;
    try { document.exitPointerLock(); } catch { /* not locked */ }
    hud.hide();
    hud.setOnline(false);
    menu.hidePause();
    menu.hideEnd();
    menu.setOnlinePause(false);
    menu.showMenu();
    audio.startMusic('menu');
    if (net.isConnected) {
      lobby.open();
      if (message) lobby.addChatLine({ system: true, text: message });
    }
  };

  events.on('net:start', (room) => startOnlineMatch(room));
  events.on('net:left', ({ id }) => {
    replicator.removePeer(id);
    if (netState.isOnline) refreshHudRoster();
  });
  events.on('net:aborted', ({ reason }) => {
    if (netState.isOnline) returnToLobby(reason || 'The host left — match aborted.');
  });
  events.on('net:disconnected', () => {
    if (netState.isOnline) returnToLobby();
    netState.reset();
  });
  events.on('net:chat', (message) => {
    if (!netState.isOnline) return;
    const sender = message.from ? (message.from === netState.myId ? player : remotePlayers.find((remote) => remote.peerId === message.from)) : null;
    hud.addChatLine({ ...message, team: sender ? sender.team : null });
    events.emit('ui:click', {});
  });
  events.on('net:pong', () => {
    if (netState.isOnline) hud.setPing(netState.ping);
    if (lobby.isOpen) lobby.setLink('online');
  });

  const menu = new Menu({
    settings,
    missionTracker,
    callbacks: {
      onUiClick: () => events.emit('ui:click', {}),
      onUiHover: () => events.emit('ui:hover', {}),
      onDeployPressed: () => {
        audio.unlock();
        events.emit('ui:deploy', {});
      },
      onPlay: async (nickname) => {
        if (gameState !== GAME_STATE.MENU) return;
        gameState = GAME_STATE.LOADING;
        player.displayName = nickname;
        hud.setPlayerName(nickname);
        saveSettings({ nickname });
        menu.hideMenu();
        audio.stopMusic();
        await menu.runLoading(async () => {
          inventory.resetToLoadout(settings.loadout);
          weapons.syncWithInventory(true);
          camera.position.set(PLAYER.spawn.x, PLAYER.eyeHeight, PLAYER.spawn.z);
          camera.rotation.set(0, 0, 0);
          camera.updateMatrixWorld(true);
          gameRenderer.warmUp();
          gameRenderer.render(0);
        });
        gameState = GAME_STATE.READY;
        menu.showPause();
      },
      onDeploy: startOrResume,
      onNewMatch: () => {
        if (netState.isOnline) {
          // Leaving mid-match drops us from the room; after the match we stay in it.
          if (!match.isOver) net.leaveRoom();
          returnToLobby();
          return;
        }
        saveSettings({ lastMapIndex: currentMapIndex, lastModeIndex: currentModeIndex });
        window.location.reload();
      },
      onMapChange: (mapIndex) => {
        currentMapIndex = mapIndex;
        saveSettings({ lastMapIndex: mapIndex });
        buildWorld();
        spawnRoster(MODES[currentModeIndex]);
        refreshHudRoster();
      },
      onModeChange: (modeIndex) => {
        currentModeIndex = modeIndex;
        // Warzone wants the big map: switch to it automatically (the player can still pick another).
        const preferredMap = MODES[modeIndex].preferredMap;
        const preferredIndex = preferredMap ? MAPS.findIndex((map) => map.id === preferredMap) : -1;
        if (preferredIndex >= 0 && preferredIndex !== currentMapIndex) {
          currentMapIndex = preferredIndex;
          menu.selectMap(preferredIndex);
          saveSettings({ lastMapIndex: preferredIndex });
          buildWorld();
        }
        match.setMode(modeIndex);
        spawnRoster(MODES[modeIndex]);
        refreshHudRoster();
        hud.setScoreGoal(MODES[modeIndex]);
        saveSettings({ lastModeIndex: modeIndex });
      },
      onQualityChange: (qualityName) => {
        saveSettings({ graphicsQuality: qualityName });
        gameRenderer.setQuality(qualityName);
        buildWorld();
      },
      onLoadoutChange: (loadout) => saveSettings({ loadout }),
      onGenderChange: (gender) => {
        saveSettings({ gender });
        player.gender = gender;
        weapons.setGender(gender);
        audio.voicePitch = GENDERS[gender].voicePitch;
      },
      onTraitChange: (trait) => {
        saveSettings({ trait });
        player.setTrait(trait);
        hud.setTrait(TRAITS[trait]);
      },
      onVolumeChange: (kind, value) => {
        audio.setVolume(kind, value);
        const settingKey = { master: 'volumeMaster', music: 'volumeMusic', sfx: 'volumeSfx' }[kind];
        saveSettings({ [settingKey]: value });
      },
      onSensitivityChange: (value) => {
        player.sensitivityScale = value;
        saveSettings({ mouseSensitivityScale: value });
      },
    },
  });
  menu.selectMap(currentMapIndex);
  menu.selectMode(currentModeIndex);
  document.getElementById('open-lobby').addEventListener('click', () => {
    events.emit('ui:click', {});
    audio.unlock();
    lobby.open();
  });
  if (lobby.wantsAutoOpen) lobby.open();

  events.on('match:end', (payload) => {
    gameState = GAME_STATE.ENDED;
    input.firing = false;
    abilities.end(true);
    if (hud.isChatOpen) hud.closeChat();
    try { document.exitPointerLock(); } catch { /* not locked */ }
    setTimeout(() => menu.showEnd({ ...payload, ourTeam: player.team, isOnline: netState.isOnline }), 600);
  });

  // ------------------------------------------------------------------ input
  const isTypingInField = (event) => event.target instanceof HTMLInputElement && event.target.type !== 'range';

  const interact = () => {
    if (supplyDrops.interact(player)) return;
    loot.interact(player, inventory);
    weapons.syncWithInventory();
  };

  // In-game chat (online): T opens, Enter sends, Escape cancels.
  const chatInput = document.getElementById('hud-chat-input');
  document.getElementById('hud-chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (text) net.chat(text);
    hud.closeChat();
    if (gameState === GAME_STATE.PLAYING) requestPointerLock();
  });
  chatInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.code === 'Escape') {
      hud.closeChat();
      if (gameState === GAME_STATE.PLAYING) requestPointerLock();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (isTypingInField(event)) return;
    if (event.code === 'KeyT' && netState.isOnline && (gameState === GAME_STATE.PLAYING || gameState === GAME_STATE.ENDED) && !event.repeat) {
      event.preventDefault();
      for (const code of Object.keys(input.keys)) input.keys[code] = false;
      input.firing = false;
      hud.openChat();
      return;
    }
    input.keys[event.code] = true;
    if (event.code === 'Space') {
      input.jumpHeld = true;
      event.preventDefault();
    }
    if (event.code === 'ControlLeft' && gameState === GAME_STATE.PLAYING) event.preventDefault();
    if (gameState !== GAME_STATE.PLAYING) {
      if (event.code === 'Enter' && (gameState === GAME_STATE.READY || gameState === GAME_STATE.PAUSED)) startOrResume();
      return;
    }
    if (event.repeat) return;
    if (event.code === 'KeyR') weapons.startReload();
    if (/^Digit[1-3]$/.test(event.code)) weapons.switchToSlot(Number(event.code.slice(5)) - 1);
    if (event.code === 'KeyX') player.tryDash();
    if (event.code === 'KeyE' || event.code === 'KeyF') interact();
    if (event.code === 'KeyQ') player.startMedkit(inventory);
    if (event.code === 'KeyV') abilities.activate();
    if (event.code === 'KeyL') weather.toggleFlashlight();
    if (event.code === 'KeyG' && player.isAlive) {
      const dropped = inventory.removeActive();
      if (dropped) {
        loot.dropWeapon(dropped, player.position);
        weapons.syncWithInventory();
        events.emit('notify', { text: `${dropped.definition.name} DROPPED`, tone: 'muted' });
      }
    }
    if ((event.code === 'Escape' || event.code === 'KeyP') && !input.pointerLocked) pauseGame();
  });
  window.addEventListener('keyup', (event) => {
    input.keys[event.code] = false;
    if (event.code === 'Space') input.jumpHeld = false;
  });

  window.addEventListener('mousedown', (event) => {
    if (gameState !== GAME_STATE.PLAYING) return;
    if (event.button === 0) {
      input.firing = true;
      input.firePressed = true;
    }
    if (event.button === 2) input.aiming = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) input.firing = false;
    if (event.button === 2) input.aiming = false;
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('wheel', (event) => {
    if (gameState !== GAME_STATE.PLAYING) return;
    weapons.cycleWeapon(Math.sign(event.deltaY));
  }, { passive: true });

  window.addEventListener('mousemove', (event) => {
    if (!input.pointerLocked || gameState !== GAME_STATE.PLAYING) return;
    input.lookDeltaX += event.movementX;
    input.lookDeltaY += event.movementY;
  });

  document.addEventListener('pointerlockchange', () => {
    input.pointerLocked = document.pointerLockElement === gameRenderer.webglRenderer.domElement;
    if (input.pointerLocked) input.everLocked = true;
    else if (input.everLocked && gameState === GAME_STATE.PLAYING && !hud.isChatOpen) pauseGame();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
  });

  // First interaction anywhere unlocks audio and starts the menu theme.
  const unlockAudioOnce = () => {
    audio.unlock();
    if (gameState === GAME_STATE.MENU && !netState.isOnline) audio.startMusic('menu');
    window.removeEventListener('pointerdown', unlockAudioOnce);
  };
  window.addEventListener('pointerdown', unlockAudioOnce);

  window.addEventListener('resize', () => gameRenderer.resize());

  // ------------------------------------------------------------------ main loop
  const shakeOffset = new THREE.Vector3();
  let lastFrameTime = performance.now();
  let elapsedSeconds = 0;
  let currentFov = PLAYER.baseFov;

  function frame(now) {
    requestAnimationFrame(frame);
    const realDelta = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    // The command hub renders its own armory scene; skip the battlefield behind it.
    if (gameState === GAME_STATE.MENU || gameState === GAME_STATE.LOADING) return;

    // Dead-Eye slows the world; the player still aims and fires at full speed.
    // Online the world can't slow down for everyone, so time always runs at 1x.
    const isOnline = netState.isOnline;
    const timeScale = isOnline ? 1 : abilities.timeScale;
    const worldDelta = realDelta * timeScale;
    const playerDelta = realDelta * (timeScale < 1 ? 0.55 : 1);
    elapsedSeconds += worldDelta;
    windUniforms.windTime.value = elapsedSeconds;

    // Online matches keep running behind the pause menu and after the final whistle (for chat).
    const isRunning = gameState === GAME_STATE.PLAYING || (isOnline && (gameState === GAME_STATE.PAUSED || gameState === GAME_STATE.ENDED));
    const frameInput = gameState === GAME_STATE.PLAYING && !hud.isChatOpen ? input : idleInput;
    mapBuilder.update(worldDelta);

    if (isRunning) {
      abilities.update(realDelta);
      player.applyLookDelta(frameInput.lookDeltaX, frameInput.lookDeltaY, camera.fov / PLAYER.baseFov);
      player.update(playerDelta, frameInput, physics, weapons.mobility);
      weapons.setZoom(frameInput.aiming && player.isAlive && !player.isHealing);
      for (const bot of bots) bot.update(worldDelta, botWorld);
      for (const remote of remotePlayers) remote.update(worldDelta, botWorld);
      pet.update(worldDelta, petWorld);
      donkeys.update(worldDelta);
      flags.update(worldDelta, match);
      hazards.update(worldDelta, elapsedSeconds);
      loot.update(worldDelta, player, inventory);
      supplyDrops.update(worldDelta);
      weather.update(worldDelta, match);
      announcer.update(realDelta);
      match.update(worldDelta);
      voxelWorld.update();
      replicator.update(realDelta);
      ambience.update(realDelta);
    }

    effects.getShakeOffset(shakeOffset);
    camera.position.set(player.position.x + shakeOffset.x, player.position.y + player.eyeHeight + shakeOffset.y, player.position.z + shakeOffset.z);
    camera.rotation.set(player.pitch + weapons.cameraKickPitch, player.yaw, 0);
    camera.updateMatrixWorld(true);

    if (isRunning) {
      const mayFire = input.pointerLocked || !input.everLocked;
      weapons.update(realDelta, {
        firing: frameInput.firing && mayFire,
        firePressed: frameInput.firePressed && mayFire,
        canFire: !match.isOver,
        player,
        combat,
        lookDeltaX: frameInput.lookDeltaX,
        lookDeltaY: frameInput.lookDeltaY,
      });
    }

    const speedBoost = player.abilitySpeedMultiplier > 1 && player.isMoving ? 10 : 0;
    const targetFov = weapons.targetFov + (player.isDashing ? PLAYER.dashFovBoost : 0) + speedBoost - (timeScale < 1 ? 6 : 0);
    currentFov += (targetFov - currentFov) * Math.min(1, realDelta * 12);
    gameRenderer.setFov(currentFov);
    effects.setViewportHeight(gameRenderer.drawingHeight, camera.fov);
    effects.update(worldDelta);
    gameRenderer.followCamera(player.position.x, player.position.z);
    audio.update(realDelta, { camera, playerHealth: player.health, playerAlive: player.isAlive });

    if (gameState !== GAME_STATE.READY) {
      const prompt = supplyDrops.getPrompt(player) || loot.getPrompt(player, inventory);
      hud.update({
        deltaSeconds: realDelta, player, weapons, inventory, match, bots: remotePlayers.length ? bots.concat(remotePlayers) : bots, tags: match.tags, barrels: hazards.barrels,
        supplyDrop: supplyDrops.activeDrop, prompt, abilities, pet, flagStatus: flags.getStatus(), donkeys: donkeys.donkeys,
      });
    }

    gameRenderer.render(realDelta);
    input.lookDeltaX = 0;
    input.lookDeltaY = 0;
    input.firePressed = false;
  }
  requestAnimationFrame(frame);

  // Exposed for debugging in the browser console.
  window.batlzon = {
    gameRenderer, physics, voxelWorld, mapBuilder, hazards, loot, supplyDrops, donkeys, weather, flags, abilities, announcer,
    player, pet, inventory, bots, weapons, match, effects, audio, hud, menu, missionTracker, events,
    net, netState, replicator, lobby, remotePlayers, botWorld, combat, ambience,
  };
}

boot().catch((error) => {
  console.error(error);
  const panel = document.getElementById('fatal-error');
  panel.innerHTML = `<div><b>BATLZON failed to start.</b><br>${String(error && error.message ? error.message : error)}<br><small>Serve the folder over http (see README) and check the browser console.</small></div>`;
  panel.classList.remove('is-hidden');
});
