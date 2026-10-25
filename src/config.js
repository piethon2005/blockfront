// =====================================================================
// BLOCKFRONT — central configuration.
// Every tunable number in the game lives here so balance changes,
// new weapons, new maps and new modes never require touching logic.
// =====================================================================

export const WORLD = {
  arenaHalfSize: 112,       // playable area is [-112, 112] on X and Z
  stepHeight: 0.6,          // max ledge height the player/bots walk up without jumping
  bodyHeight: 1.8,          // collision height of a body
  bodyRadius: 0.45,         // collision radius of a body
  gravity: 26,
  jumpVelocity: 9,
  terminalVelocity: 40,
  groundSnapDistance: 0.6,  // how far a grounded body is pulled down to stay glued to slopes
};

export const PLAYER = {
  spawn: { x: 0, z: 92 },
  maxHealth: 100,
  maxShield: 100,           // armor points absorb damage before health
  walkSpeed: 8,
  dashSpeed: 24,
  dashDuration: 0.2,
  dashCooldown: 3,
  // No passive health regeneration: health only comes back from med-kits.
  respawnDelay: 3,
  eyeHeight: 1.7,
  deadEyeHeight: 0.5,
  baseFov: 78,
  dashFovBoost: 7,
  mouseSensitivity: 0.0022,
  arrowYawSpeed: 2,
  arrowPitchSpeed: 1.5,
  maxPitch: 1.5,
  footstepStride: 2.4,      // metres walked between footstep events
  crouchEyeHeight: 1.05,
  crouchSpeedMultiplier: 0.55,
  crouchSpreadMultiplier: 0.65,
  flashlightIntensity: 60,
  displayNameFallback: 'Player',
};

// ---------------------------------------------------------------------
// Inventory slots. Every player always spawns with one weapon per slot.
// ---------------------------------------------------------------------
export const WEAPON_SLOTS = [
  { id: 'melee', label: 'MELEE', key: '1' },
  { id: 'secondary', label: 'SIDEARM', key: '2' },
  { id: 'primary', label: 'PRIMARY', key: '3' },
];

// Weapon catalog. `loadout: true` = selectable in the Loadout Room.
// `tier: 'elite'` weapons only appear in supply drops.
// Add a weapon: an entry here + a model builder in weapon.js + a sound recipe in audioManager.js.
export const WEAPONS = {
  knife: {
    id: 'knife', name: 'COMBAT KNIFE', shortName: 'KNIFE', slot: 'melee', tier: 'standard', loadout: true, isMelee: true,
    fireInterval: 0.42, damage: 55, range: 2.8, headshotMultiplier: 1.4, mobility: 1.08, automatic: true,
    model: 'knife', sound: 'knife_swing', description: 'Fast, silent, always ready. Two slashes drop a bot.',
  },
  machete: {
    id: 'machete', name: 'KUKRI MACHETE', shortName: 'KUKRI', slot: 'melee', tier: 'standard', loadout: true, isMelee: true,
    fireInterval: 0.72, damage: 85, range: 3.3, headshotMultiplier: 1.4, mobility: 1.02, automatic: true,
    model: 'machete', sound: 'knife_swing', description: 'Heavy chopping blade. Slower swing, one-hit on a wounded target.',
  },
  pistol: {
    id: 'pistol', name: 'G17 SIDEARM', shortName: 'G17', slot: 'secondary', tier: 'standard', loadout: true,
    fireInterval: 0.16, damage: 26, spread: 0.012, pellets: 1, magazineSize: 15, maxReserve: 75, startReserve: 45,
    reloadTime: 1.1, range: 70, recoil: 0.8, cameraKick: 0.012, zoomFov: 66, automatic: false, mobility: 1.04,
    headshotMultiplier: 1.8, tracerEvery: 1, model: 'pistol', sound: 'shot_pistol', casingColor: 0xd4a33a,
    description: 'Reliable 9mm sidearm. Accurate, quick reload, semi-automatic.',
  },
  deagle: {
    id: 'deagle', name: 'DESERT HAWK .50', shortName: 'HAWK', slot: 'secondary', tier: 'standard', loadout: true,
    fireInterval: 0.42, damage: 58, spread: 0.016, pellets: 1, magazineSize: 7, maxReserve: 35, startReserve: 21,
    reloadTime: 1.5, range: 80, recoil: 2.6, cameraKick: 0.05, zoomFov: 62, automatic: false, mobility: 1.0,
    headshotMultiplier: 2.0, tracerEvery: 1, model: 'deagle', sound: 'shot_deagle', casingColor: 0xe0b84a,
    description: 'Hand cannon. Brutal headshots, punishing recoil.',
  },
  glock18: {
    id: 'glock18', name: 'G18 AUTO', shortName: 'G18', slot: 'secondary', tier: 'elite', loadout: false,
    fireInterval: 0.055, damage: 20, spread: 0.03, pellets: 1, magazineSize: 33, maxReserve: 132, startReserve: 99,
    reloadTime: 1.3, range: 55, recoil: 0.7, cameraKick: 0.008, zoomFov: 66, automatic: true, mobility: 1.04,
    headshotMultiplier: 1.6, tracerEvery: 2, model: 'glock18', sound: 'shot_glock18', casingColor: 0xd4a33a,
    description: 'Supply-drop machine pistol. Empties a 33-round mag in under two seconds.',
  },
  ak47: {
    id: 'ak47', name: 'AK-47', shortName: 'AK-47', slot: 'primary', tier: 'standard', loadout: true,
    fireInterval: 0.11, damage: 34, spread: 0.012, pellets: 1, magazineSize: 25, maxReserve: 150, startReserve: 100,
    reloadTime: 1.4, range: 90, recoil: 1, cameraKick: 0.010, zoomFov: 62, automatic: true, mobility: 0.96,
    headshotMultiplier: 1.5, tracerEvery: 1, model: 'ak47', sound: 'shot_ak47', casingColor: 0xd4a33a,
    description: 'Hard-hitting 7.62 rifle. The squad standard.',
  },
  m4: {
    id: 'm4', name: 'M4A1 CARBINE', shortName: 'M4A1', slot: 'primary', tier: 'standard', loadout: true,
    fireInterval: 0.09, damage: 28, spread: 0.009, pellets: 1, magazineSize: 30, maxReserve: 180, startReserve: 120,
    reloadTime: 1.6, range: 100, recoil: 0.75, cameraKick: 0.008, zoomFov: 58, automatic: true, mobility: 0.98,
    headshotMultiplier: 1.5, tracerEvery: 1, model: 'm4', sound: 'shot_m4', casingColor: 0xd4a33a,
    description: 'Fast, flat-shooting carbine. Less punch, more control.',
  },
  shotgun: {
    id: 'shotgun', name: 'SG-12 SHOTGUN', shortName: 'SG-12', slot: 'primary', tier: 'standard', loadout: true,
    fireInterval: 0.85, damage: 20, spread: 0.07, pellets: 7, magazineSize: 6, maxReserve: 36, startReserve: 24,
    reloadTime: 2.2, range: 20, recoil: 3, cameraKick: 0.045, zoomFov: 62, automatic: true, mobility: 0.95,
    headshotMultiplier: 1.25, tracerEvery: 2, model: 'shotgun', sound: 'shot_shotgun', casingColor: 0xc8302a,
    description: 'Seven pellets of close-quarters authority.',
  },
  rail: {
    id: 'rail', name: 'RAIL-X SNIPER', shortName: 'RAIL-X', slot: 'primary', tier: 'elite', loadout: false,
    fireInterval: 1.2, damage: 100, spread: 0.01, pellets: 1, magazineSize: 5, maxReserve: 15, startReserve: 10,
    reloadTime: 2, range: 140, recoil: 4, cameraKick: 0.06, zoomFov: 26, zoomRemovesSpread: true, hideViewmodelWhenZoomed: true,
    automatic: true, mobility: 0.9, headshotMultiplier: 1.0, tracerEvery: 1, model: 'rail', sound: 'shot_rail', casingColor: 0x4fd0ff,
    description: 'Supply-drop railgun. One shot, one elimination, any range.',
  },
  lmg: {
    id: 'lmg', name: 'M249 SAW', shortName: 'M249', slot: 'primary', tier: 'elite', loadout: false,
    fireInterval: 0.075, damage: 30, spread: 0.02, pellets: 1, magazineSize: 100, maxReserve: 200, startReserve: 100,
    reloadTime: 3.4, range: 100, recoil: 1.1, cameraKick: 0.012, zoomFov: 60, automatic: true, mobility: 0.84,
    headshotMultiplier: 1.4, tracerEvery: 2, model: 'lmg', sound: 'shot_lmg', casingColor: 0xd4a33a,
    description: 'Supply-drop light machine gun. 100-round belt of suppression.',
  },
};

export const DEFAULT_LOADOUT = { melee: 'knife', secondary: 'pistol', primary: 'ak47' };

// ---------------------------------------------------------------------
// Loot, armor, med-kits and supply drops.
// ---------------------------------------------------------------------
export const LOOT = {
  pickupRadius: 1.6,            // consumables are collected automatically within this radius
  interactRadius: 2.4,          // weapons need [E] within this radius
  worldItemCount: 18,           // world loot kept on the map at all times
  worldRespawnInterval: 10,     // seconds between world loot top-ups
  droppedLifetime: 60,          // dropped items vanish after this long
  maxMedkits: 3,
  startingMedkits: 1,
  medkitHeal: 60,
  medkitUseTime: 1.4,
  armorTiers: {
    1: { amount: 25, label: 'LIGHT VEST', rarity: 'uncommon' },
    2: { amount: 50, label: 'HEAVY VEST', rarity: 'rare' },
  },
  ammoBoxMagazines: 2,          // ammo boxes add this many magazines to every gun you hold
  worldWeaponPool: ['shotgun', 'm4', 'deagle', 'ak47', 'machete', 'pistol'],
  worldWeights: { ammo: 28, medkit: 24, armor1: 18, armor2: 7, weapon: 23 },
  botDropChance: 0.8,           // chance an eliminated bot drops something
  botWeaponDropChance: 0.35,    // ...and that the drop is its weapon
  botDropWeapons: ['ak47', 'm4', 'shotgun', 'deagle'],
  rarityColors: { common: 0xd8d8d8, uncommon: 0x6fdc4a, rare: 0x3aa0ff, elite: 0xffb21a },
};

export const SUPPLY_DROP = {
  firstDropDelay: 40,
  interval: 75,
  fallTime: 9,
  dropHeight: 110,
  interactRadius: 3.2,
  lingerTime: 60,
  landingAreaHalfSize: 70,
  eliteWeapons: ['rail', 'glock18', 'lmg'],
  botInterest: 0.5,             // chance a roaming bot heads to an active drop
};

// Persistent challenges shown in the Missions panel. `stat` keys live in settings.stats.
export const MISSIONS = [
  { id: 'elims', title: 'TRIGGER DISCIPLINE', description: 'Get 10 eliminations in a single match', stat: 'bestMatchKills', goal: 10 },
  { id: 'tags', title: 'NO ONE LEFT BEHIND', description: 'Confirm 25 dog tags', stat: 'tagsConfirmed', goal: 25 },
  { id: 'wins', title: 'MISSION ACCOMPLISHED', description: 'Win 3 matches', stat: 'wins', goal: 3 },
  { id: 'heads', title: 'MARKSMAN', description: 'Land 25 headshot eliminations', stat: 'headshotKills', goal: 25 },
  { id: 'blade', title: 'SILENT BLADE', description: 'Eliminate 5 enemies with a melee weapon', stat: 'meleeKills', goal: 5 },
  { id: 'boom', title: 'DEMOLITIONS EXPERT', description: 'Eliminate 5 enemies with explosive barrels', stat: 'barrelKills', goal: 5 },
  { id: 'drops', title: 'AIRDROP HUNTER', description: 'Open 5 supply drops', stat: 'suppliesOpened', goal: 5 },
  { id: 'medic', title: 'FIELD MEDIC', description: 'Use 10 med-kits', stat: 'medkitsUsed', goal: 10 },
  { id: 'donkey', title: 'DONKEY WHISPERER', description: 'Hunt 5 donkeys for abilities', stat: 'donkeysHunted', goal: 5 },
  { id: 'flags', title: 'COLOR GUARD', description: 'Capture 3 flags in CTF', stat: 'flagsCaptured', goal: 3 },
  { id: 'demo', title: 'URBAN RENEWAL', description: 'Destroy 500 voxel blocks', stat: 'voxelsDestroyed', goal: 500 },
  { id: 'multi', title: 'TRIPLE THREAT', description: 'Score a Triple Kill', stat: 'tripleKills', goal: 1 },
];

export const BOT = {
  maxHealth: 100,
  respawnDelay: 4,
  deathAnimationTime: 1.1,
  combatSpeed: 5,
  roamSpeed: 6,
  sightRange: 90,
  candidatesChecked: 2,         // nearest N enemies get a line-of-sight test each frame
  preferredRangeMax: 16,        // advance when farther than this
  preferredRangeMin: 8,         // back off when closer than this
  strafeStrength: 0.7,
  strafeSwitchMin: 1,
  fireIntervalMin: 0.5,
  fireIntervalJitter: 0.4,
  baseAccuracy: 0.62,
  accuracyFalloffPerMetre: 0.012,
  minAccuracy: 0.1,
  missScatter: 3,
  damageToPlayer: 9,
  damageToBot: 14,
  roamAreaHalfSize: 70,
  waypointTimeout: 6,
  tagSearchRadius: 70,
  ownTagWeight: 2,              // own-team tags are treated as twice as far (less attractive)
  stuckCheckInterval: 0.6,
  stuckDistance: 0.5,
  radarRevealTime: 1.6,         // seconds an enemy stays on the radar after firing
  whizRadius: 2.5,              // missed shots this close to the player play a bullet whiz
};

export const TEAMS = {
  red: { id: 'red', label: 'ENEMY', bodyColor: 0xd63b3b, accentColor: 0x222222, tagColor: 0xff3a3a, cssClass: 'red' },
  blue: { id: 'blue', label: 'ALLY', bodyColor: 0x2f6fe0, accentColor: 0xffd23f, tagColor: 0x3aa0ff, cssClass: 'blue' },
};

export const PLAYER_TEAM = 'blue';

export const SPAWN_POINTS = {
  red: [[-30, -100], [0, -102], [30, -100], [-12, -98]],
  blue: [[-10, 98], [14, 98], [0, 94]],
};

// Name pools; each mode decides how many bots per team (see MODES[].roster).
export const ROSTER = {
  red: ['PoxelKing68', 'PoxelGamer52', 'PoxelWarrior41', 'HungryChick', 'IronVandal', 'RustViper'],
  blue: ['PoxelNinja7', 'BlockBuddy', 'SteelWolf', 'AmberHawk'],
};

// Game modes. roster = number of bots per team (the player is always on blue).
// rules: 'tags' (Kill Confirmed), 'kills' (every elimination scores), 'flags' (Capture the Flag).
export const MODES = [
  {
    id: 'kill-confirmed', name: 'KILL CONFIRMED', codename: 'RECOVER TAGS', scoreGoal: 20, rules: 'tags', usesTags: true, usesFlags: false,
    roster: { red: 4, blue: 2 }, scoreLabel: 'Tags confirmed',
    description: 'Kill Confirmed: kill an enemy, then walk over the dropped red tag to confirm it for +1. Blue tags are your team\'s: grab them to deny the enemy. First to 20 wins.',
  },
  {
    id: 'team-deathmatch', name: 'TEAM DEATHMATCH', codename: 'ATTRITION', scoreGoal: 25, rules: 'kills', usesTags: false, usesFlags: false,
    roster: { red: 4, blue: 2 }, scoreLabel: 'Team kills',
    description: 'Team Deathmatch: every elimination scores a point for your team. First to 25 kills wins.',
  },
  {
    id: 'arena-1v1', name: '1V1 ARENA', codename: 'DUEL', scoreGoal: 10, rules: 'kills', usesTags: false, usesFlags: false,
    roster: { red: 1, blue: 0 }, scoreLabel: 'Duel score',
    description: '1v1 Arena: you against a single elite hostile. Just your pet at your side. First to 10 eliminations wins.',
  },
  {
    id: 'team-battle-4v4', name: '4V4 TEAM BATTLE', codename: 'FULL PLATOON', scoreGoal: 30, rules: 'kills', usesTags: false, usesFlags: false,
    roster: { red: 4, blue: 3 }, scoreLabel: 'Team kills',
    description: '4v4 Team Battle: you and three allies against four hostiles. First team to 30 eliminations wins.',
  },
  {
    id: 'ctf', name: 'CAPTURE THE FLAG', codename: 'SEIZE COLORS', scoreGoal: 3, rules: 'flags', usesTags: false, usesFlags: true,
    roster: { red: 4, blue: 3 }, scoreLabel: 'Flags captured',
    description: 'Capture the Flag: steal the red flag from the enemy base and carry it to your own flag. Your flag must be home to score. First to 3 captures wins.',
  },
];

export const CTF = {
  flagPositions: { blue: [0, 104], red: [0, -104] },
  pickupRadius: 2.0,
  autoReturnTime: 20,
  carrierSpeedMultiplier: 0.9,
  defenderShare: 0.34,          // fraction of bots that guard their own flag
};

// Multi-kill window and announcer titles.
export const ANNOUNCER = {
  multiKillWindow: 4.5,
  titles: { 1: 'SINGLE KILL', 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL', 5: 'MULTI KILL' },
  streaks: { 5: 'KILLING SPREE', 8: 'RAMPAGE', 12: 'UNSTOPPABLE', 16: 'WAR MACHINE' },
};

// Passive traits selectable in the Loadout Room.
export const TRAITS = {
  none: { id: 'none', name: 'NO TRAIT', icon: '—', description: 'Standard issue. No passive bonus.' },
  scavenger: {
    id: 'scavenger', name: 'SCAVENGER', icon: '⟲', description: 'Magnetically pulls in ammo, med-kits and armor from up to 7m away.',
    pickupRadius: 7,
  },
  juggernaut: {
    id: 'juggernaut', name: 'JUGGERNAUT', icon: '⛨', description: 'Spawns with +25 armor. Moves 15% slower.',
    speedMultiplier: 0.85, spawnShield: 25,
  },
  ghost: {
    id: 'ghost', name: 'GHOST', icon: '◌', description: 'While crouched (C) you never show up on enemy radar pings and bots only spot you within 12m.',
    crouchedDetectionRange: 12,
  },
};

export const GENDERS = {
  male: { id: 'male', label: 'MALE', voicePitch: 1.0 },
  female: { id: 'female', label: 'FEMALE', voicePitch: 1.45 },
};

// Combat pet (attack dog) that follows the player.
export const PET = {
  name: 'K9 RAZOR',
  maxHealth: 90,
  followDistance: 3.2,
  runSpeed: 11,
  walkSpeed: 7,
  aggroRange: 22,
  biteRange: 1.8,
  biteDamage: 16,
  biteInterval: 0.75,
  respawnDelay: 15,
  leashDistance: 30,            // gives up a chase if it strays this far from the player
};

// Donkeys wander the map; eliminating one grants a random special ability.
export const DONKEY = {
  maxAlive: 2,
  health: 45,
  speed: 2.2,
  respawnDelay: 22,
  brayIntervalMin: 5,
  brayIntervalMax: 11,
  spawnAreaHalfSize: 75,
};

export const ABILITIES = {
  propHunt: { id: 'propHunt', name: 'PROP HUNT', icon: '▣', mode: 'timed', duration: 20, description: 'You look like a map prop. Bots ignore you unless you sprint or shoot. [V] cancel.' },
  teleport: { id: 'teleport', name: 'TELEPORT', icon: '⌁', mode: 'charges', charges: 3, duration: 30, range: 45, description: 'Press [V] to blink to your crosshair (3 charges).' },
  hyperSpeed: { id: 'hyperSpeed', name: 'HYPER-SPEED', icon: '»', mode: 'timed', duration: 15, speedMultiplier: 2.1, description: 'Massive speed and unlimited dashes.' },
  deadEye: { id: 'deadEye', name: 'DEAD-EYE', icon: '◎', mode: 'charges', charges: 1, duration: 30, slowDuration: 7, timeScale: 0.22, description: 'Press [V] to slow time for 7 seconds and line up perfect shots.' },
};

// Mid-match weather events.
export const WEATHER = {
  triggerAtFraction: 0.5,       // fraction of match time elapsed
  transitionTime: 12,
  events: {
    fog: { id: 'fog', name: 'DENSE FOG', alert: 'WEATHER ALERT: DENSE FOG ROLLING IN — VISIBILITY 30M', fogColor: 0xb4bcc0, fogDensity: 0.05, skyTop: 0x9aa4aa, skyHorizon: 0xc4cacc, skyBottom: 0x8a9294, sunIntensity: 0.9, hemisphereIntensity: 0.9, visibility: 32 },
    duststorm: { id: 'duststorm', name: 'DUST STORM', alert: 'WEATHER ALERT: DUST STORM INBOUND — VISIBILITY 40M', fogColor: 0xc89a5a, fogDensity: 0.036, skyTop: 0xa0703a, skyHorizon: 0xd8a868, skyBottom: 0x8a6a40, sunIntensity: 1.1, hemisphereIntensity: 0.75, visibility: 42 },
    night: { id: 'night', name: 'NIGHTFALL', alert: 'NIGHTFALL — FLASHLIGHTS ON [L]', fogColor: 0x0a1020, fogDensity: 0.02, skyTop: 0x02040c, skyHorizon: 0x0e1830, skyBottom: 0x05070c, sunIntensity: 0.12, hemisphereIntensity: 0.14, visibility: 45, isNight: true },
  },
};

// Destructible voxel materials (health per cell, colour of debris, can bullets pass through?).
export const VOXEL = {
  materials: {
    block: { surface: 'block', health: 90, penetrable: false, debrisColor: null },
    brick: { surface: 'brick', health: 120, penetrable: false, debrisColor: 0x9a4a32 },
    plaster: { surface: 'plaster', health: 70, penetrable: false, debrisColor: 0xd8d0b8 },
    concrete: { surface: 'concrete', health: 150, penetrable: false, debrisColor: 0x9a968c },
    metal: { surface: 'metal', health: 170, penetrable: false, debrisColor: 0x3a4a50 },
    wood: { surface: 'crate', health: 45, penetrable: true, debrisColor: 0x8a6a3a },
  },
  penetrationDamageFactor: 0.6,   // damage kept after passing through a penetrable cell
  maxPenetrations: 2,
  heavyWeaponMultiplier: { lmg: 1.6, rail: 2.5, shotgun: 1.2 },
  explosionRadius: 3.4,
  explosionDamage: 320,
  botMissDamage: 10,
};



export const MATCH = {
  durationSeconds: 300,
  tagLifetime: 25,
  tagPickupRadius: 1.7,
  pointsPerKill: 100,
  pointsPerTag: 50,
  coinsPerTag: 5,
  coinsPerKill: 2,
  killfeedLifetime: 5,
  killfeedMaxEntries: 5,
  countdownBeepFrom: 10,
};

export const HAZARDS = {
  barrelHealth: 40,
  explosionRadius: 7.5,
  explosionMaxDamage: 130,
  barrelRespawnTime: 25,
  chainReactionDelay: 0.18,
};

// Atmosphere per map. Colors are sRGB hex; the renderer converts them.
export const MAPS = [
  {
    id: 'brickyard', name: 'BRICKYARD', codename: 'OP. IRON YARD', terrain: 'INDUSTRIAL', briefing: 'Container yard with painted cover blocks and twin sniper outposts. Mid-range firefights.',
    groundColor: 0x6fcf3a, outerGroundColor: 0x5cae35, wallColor: 0x3a5ea8,
    sky: { top: 0x2b7fe0, horizon: 0xbfe4ff, bottom: 0x8fbf8a, sunColor: 0xfff1d0, sunElevation: 42, sunAzimuth: 145 },
    fogDensity: 0.0042,
    sunIntensity: 2.6, hemisphereIntensity: 0.8,
    hemisphereSky: 0xcfe8ff, hemisphereGround: 0x4f8a2a,
    barrels: [[-20, -6], [20, 12], [4, 30], [-30, -26], [30, -12], [-6, -40], [40, 38]],
  },
  {
    id: 'poxeltown', name: 'POXELTOWN', codename: 'OP. DUSK STREET', terrain: 'URBAN', briefing: 'Crossroads village at golden hour. Houses and road barriers favour flanking routes.',
    groundColor: 0x63b83a, outerGroundColor: 0x4e9a30, wallColor: 0x4a7a3a,
    sky: { top: 0x3a6fc8, horizon: 0xffd2a0, bottom: 0x9a8a6a, sunColor: 0xffc890, sunElevation: 20, sunAzimuth: 210 },
    fogDensity: 0.0048,
    sunIntensity: 2.8, hemisphereIntensity: 0.7,
    hemisphereSky: 0xffe2c4, hemisphereGround: 0x4a7a2a,
    barrels: [[-8, -12], [8, 16], [-30, 4], [30, -6], [0, -36], [16, 40], [-40, -20]],
  },
];

export const OUTPOST_POSITIONS = [[75, 75], [-75, 75], [75, -75], [-75, -75], [96, 0], [-96, 0]];

// Graphics presets. "high" is the drastic-graphics default.
export const GRAPHICS_PRESETS = {
  low: {
    label: 'LOW', maxPixelRatio: 1, shadowMapSize: 1024, shadows: true, postProcessing: false,
    ambientOcclusion: false, bloom: false, msaaSamples: 0, grassClusters: 1200, outerTrees: 50, clouds: 6,
  },
  medium: {
    label: 'MEDIUM', maxPixelRatio: 1.5, shadowMapSize: 2048, shadows: true, postProcessing: true,
    ambientOcclusion: false, bloom: true, msaaSamples: 4, grassClusters: 3500, outerTrees: 110, clouds: 12,
  },
  high: {
    label: 'ULTRA', maxPixelRatio: 1.5, shadowMapSize: 4096, shadows: true, postProcessing: true,
    ambientOcclusion: true, bloom: true, msaaSamples: 4, grassClusters: 7000, outerTrees: 170, clouds: 16,
  },
};

export const RENDER = {
  toneMappingExposure: 0.86,
  environmentIntensity: 0.55,
  shadowCameraHalfSize: 60,
  shadowBias: -0.00035,
  shadowNormalBias: 0.035,
  bloomStrength: 0.42,
  bloomRadius: 0.55,
  bloomThreshold: 1.05,
  cameraNear: 0.08,
  cameraFar: 1200,
  skyRadius: 900,
};

// Optional audio files. Leave a value empty to use the built-in synthesizer.
// Drop files into assets/audio/ and fill in the path to override a sound, e.g.
//   shot_ak47: 'assets/audio/ak47.wav'
export const AUDIO_SAMPLES = {
  shot_ak47: '', shot_m4: '', shot_shotgun: '', shot_rail: '', shot_lmg: '', shot_pistol: '', shot_deagle: '', shot_glock18: '',
  knife_swing: '', knife_hit: '', pickup_weapon: '', pickup_armor: '', pickup_medkit: '', pickup_ammo: '', medkit_use: '', heal: '',
  shield_hit: '', shield_break: '', weapon_drop: '', supply_incoming: '', supply_land: '', supply_open: '', ui_hover: '', deploy: '', donkey_bray: '', dog_bark: '', voxel_break: '', teleport: '', deadeye_in: '', announcer: '', flag_taken: '', flag_captured: '', reload: '', empty: '', weapon_switch: '',
  footstep: '', jump: '', land: '', dash: '', hitmarker: '', headshot: '', kill: '', hurt: '',
  explosion: '', tag_confirm: '', tag_deny: '', respawn: '', ui_click: '', victory: '', defeat: '',
  music_menu: '', music_battle: '',
};

export const AUDIO_DEFAULTS = { master: 0.8, music: 0.35, sfx: 0.9 };

export const MENU_TIPS = [
  'Collect enemy dog tags to confirm your kills.',
  'Health no longer regenerates. Carry med-kits and press Q to heal.',
  'Armor absorbs damage first. Heavy vests add 50 shield.',
  'Watch for red smoke: a supply drop with elite weapons is landing.',
  'Press E over a weapon to swap it. Your old weapon drops at your feet.',
  'Shoot explosive barrels when enemies group up.',
  'Melee is silent and instant: press 1 for your blade.',
  'Wooden crates stop nothing. Shoot right through them.',
  'Hear a donkey? Hunt it for a random special ability.',
  'Mid-match weather can kill sniper sightlines. Bring a close-range backup.',
];

export const FIELD_MANUAL = [
  ['MOVEMENT', 'WASD move · Space jump · X tactical dash · Mouse look'],
  ['COMBAT', 'Left click fire · Right click aim / scope · R reload'],
  ['INVENTORY', '1 Melee · 2 Sidearm · 3 Primary · Mouse wheel cycle · G drop weapon'],
  ['SURVIVAL', 'Q use med-kit (+60 HP) · Armor absorbs damage before health · No passive regeneration'],
  ['MULTIPLAYER', 'MULTIPLAYER → War Room: create a room and share the 4-letter code, or join a friend’s · T chat in-game · Online Dead-Eye boosts damage instead of slowing time'],
  ['LOOT', 'Walk over ammo, med-kits and armor to collect · E to pick up / swap weapons and open supply drops'],
  ['STANCE', 'C crouch (quieter, more accurate, Ghost trait hides you) · L flashlight'],
  ['DONKEYS', 'Hunt wandering donkeys for a random ability: Prop Hunt, Teleport, Hyper-Speed or Dead-Eye · V use ability'],
  ['DESTRUCTION', 'Every wall, crate and house is made of voxels. Shoot through wood, blast holes with barrels and heavy weapons'],
  ['OBJECTIVE', 'Kill Confirmed: grab enemy tags (+1) and deny your own. Team Deathmatch: every elimination scores.'],
];

export const CREDITS = [
  ['GAME DESIGN', 'Game Design Open Elective · B.Tech Sem V'],
  ['ENGINE', 'Three.js r160 · WebGL 2 · Web Audio API'],
  ['AUDIO', 'Fully synthesised in real time — no sample files'],
  ['ART', 'Procedural PBR textures, voxel models, GPU particles'],
];

export const STORAGE_KEY = 'blockfront.settings.v1';
