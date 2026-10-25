// =====================================================================
// Bots — blocky soldiers with articulated limbs and a lively AI:
//   ENGAGE    — a visible enemy: face it, strafe, hold the preferred range
//               of their weapon, fire bursts, dodge with tactical dashes.
//   HUNT      — no enemy in sight but a donkey nearby: chase and shoot it
//               to win a random ability (Hyper-Speed, Teleport, Dead-Eye,
//               Prop Hunt) — exactly like the player.
//   OBJECTIVE — CTF duties (attack, defend, carry the flag home).
//   COLLECT   — walk to the nearest dog tag.
//   ROAM      — wander, investigate gunfire, contest supply drops.
//   DEAD      — topple over, then respawn at a team spawn point.
//
// Every bot carries a real weapon model (AK-47, M4A1, SG-12, M249, RAIL-X,
// G17, Desert Hawk or G18) with its own fire pattern, damage, range and
// sound. Both hands are placed on the gun with two-bone arm IK, so rifles
// are shouldered when aiming and held at low ready while moving.
//
// Multiplayer puppets reuse this class without the AI:
//   isPuppet       — a host-simulated bot mirrored on a guest's screen.
//   isRemotePlayer — another human's soldier (avatar). Its hitboxes are
//                    shootable, but damage is sent to its owner instead.
// Puppets are driven by applyNetState() and interpolate between updates.
// =====================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  ABILITIES, BOT, BOT_ABILITIES, BOT_WEAPONS, BOT_WEAPON_IDS, SUPPLY_DROP, TEAMS, TRAITS, WEAPONS, WORLD, arenaScale, getSpawnPoints,
} from '../config.js';
import { events } from '../core/events.js';
import { createCanvasTexture } from '../world/materials.js';
import { buildWeaponModel } from './weapon.js';

export const BOT_STATE = { ENGAGE: 'engage', HUNT: 'hunt', COLLECT: 'collect', OBJECTIVE: 'objective', ROAM: 'roam', DEAD: 'dead' };
const ABILITY_IDS = ['hyperSpeed', 'teleport', 'deadEye', 'propHunt'];
export const BOT_ABILITY_IDS = ABILITY_IDS;

// Arm segment lengths (shoulder→elbow, elbow→palm) used by the IK solver.
const UPPER_ARM = 0.62;
const FOREARM = 0.7;
const GUN_SCALE = 1.6;

// Where the hands go on each kind of gun, in the weapon model's own space (it points down -Z).
const HOLD_POINTS = {
  rifle: { grip: [0, -0.1, 0.0], fore: [0, -0.05, -0.42] },
  shotgun: { grip: [0, -0.1, 0.04], fore: [0, -0.12, -0.42] },
  lmg: { grip: [0, -0.11, -0.02], fore: [0, -0.04, -0.62] },
  rail: { grip: [0, -0.1, 0.0], fore: [0, -0.05, -0.5] },
  pistol: { grip: [0, -0.1, 0.0], fore: [0.0, -0.13, 0.03] },
};

// Gun placement in the bot's body space (+Z forward). rest = low ready, aim = shouldered.
const GUN_POSES = {
  rifle: { aim: { position: [0.26, 1.96, 0.2], pitch: 0, yaw: 0 }, rest: { position: [0.18, 1.72, 0.36], pitch: 0.45, yaw: -0.35 } },
  pistol: { aim: { position: [0.05, 1.98, 0.9], pitch: 0, yaw: 0 }, rest: { position: [0.42, 1.42, 0.32], pitch: 1.15, yaw: 0 } },
};

// Arm IK pole hints: elbows point outward and down.
const POLE_HOLDING = new THREE.Vector3(1, -0.7, -0.45);
const POLE_SUPPORT = new THREE.Vector3(-1, -0.9, -0.2);
const HIP_REST_SUPPORT = new THREE.Vector3(-0.78, 1.18, 0.12);
const HIP_REST_HOLDING = new THREE.Vector3(0.78, 1.18, 0.12);
const DOWN = new THREE.Vector3(0, -1, 0);

// Shared scratch objects (bots update one at a time).
const scratchDirection = new THREE.Vector3();
const scratchBend = new THREE.Vector3();
const scratchElbow = new THREE.Vector3();
const scratchHand = new THREE.Vector3();
const scratchSegment = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchGrip = new THREE.Vector3();
const scratchFore = new THREE.Vector3();
const scratchPole = new THREE.Vector3();

const FACE_TEXTURE_CACHE = new Map();
function getFaceTexture(team) {
  if (FACE_TEXTURE_CACHE.has(team)) return FACE_TEXTURE_CACHE.get(team);
  const texture = createCanvasTexture(16, (context) => {
    context.fillStyle = '#f0c090';
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = team === 'red' ? '#7a1010' : '#103a7a';
    context.fillRect(2, 5, 12, 3);            // visor band
    context.fillStyle = team === 'red' ? '#ff4040' : '#60c8ff';
    context.fillRect(3, 6, 4, 1);
    context.fillRect(9, 6, 4, 1);             // glowing eyes
    context.fillStyle = '#d9a577';
    context.fillRect(7, 9, 2, 2);             // nose
    context.fillStyle = '#a8553a';
    context.fillRect(5, 12, 6, 1);            // mouth
    context.fillStyle = 'rgba(40,30,20,0.35)';
    context.fillRect(3, 11, 10, 3);           // stubble / grime
  });
  texture.magFilter = THREE.NearestFilter;
  FACE_TEXTURE_CACHE.set(team, texture);
  return texture;
}

function createNameSprite(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.font = 'bold 30px Rajdhani, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = 'rgba(10,20,40,0.55)';
  const textWidth = context.measureText(name).width + 28;
  context.beginPath();
  if (context.roundRect) context.roundRect(128 - textWidth / 2, 12, textWidth, 40, 12);
  else context.rect(128 - textWidth / 2, 12, textWidth, 40);
  context.fill();
  context.fillStyle = color;
  context.fillText(name, 128, 33);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true, fog: false }));
  sprite.scale.set(2.6, 0.65, 1);
  sprite.renderOrder = 10;
  return sprite;
}

const ICON_TEXTURE_CACHE = new Map();
function getAbilityIconMaterial(abilityId) {
  if (ICON_TEXTURE_CACHE.has(abilityId)) return ICON_TEXTURE_CACHE.get(abilityId);
  const icon = (ABILITIES[abilityId] && ABILITIES[abilityId].icon) || '?';
  const texture = createCanvasTexture(64, (context, size) => {
    context.clearRect(0, 0, size, size);
    context.fillStyle = 'rgba(20,16,6,0.75)';
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#ffb21a';
    context.lineWidth = 4;
    context.stroke();
    context.fillStyle = '#ffd23f';
    context.font = 'bold 36px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(icon, size / 2, size / 2 + 2);
  });
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true, fog: false });
  ICON_TEXTURE_CACHE.set(abilityId, material);
  return material;
}

const shortestAngle = (from, to) => {
  let difference = (to - from) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
};

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic weighted weapon choice, so every machine in an online match agrees. */
export function pickBotWeapon(name, generation = 0) {
  const total = BOT_WEAPON_IDS.reduce((sum, id) => sum + BOT_WEAPONS[id].weight, 0);
  let roll = hashString(`${name}#${generation}`) % total;
  for (const id of BOT_WEAPON_IDS) {
    roll -= BOT_WEAPONS[id].weight;
    if (roll < 0) return id;
  }
  return 'ak47';
}

/** Build a weapon model for a bot and merge its parts per material (few draw calls per gun). */
function buildBotGun(weaponId) {
  const definition = WEAPONS[weaponId] || WEAPONS.ak47;
  const model = buildWeaponModel(definition.model);
  const source = model.group;
  source.updateMatrixWorld(true);
  const buckets = new Map();
  source.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
    if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2));
    const key = object.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { material: object.material, geometries: [] });
    buckets.get(key).geometries.push(geometry);
  });
  const group = new THREE.Group();
  for (const { material, geometries } of buckets.values()) {
    let merged = null;
    try {
      merged = mergeGeometries(geometries, false);
    } catch {
      merged = null;
    }
    const parts = merged ? [merged] : geometries;
    for (const geometry of parts) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      group.add(mesh);
    }
  }
  const muzzle = new THREE.Object3D();
  if (model.muzzle) muzzle.position.copy(model.muzzle.position);
  group.add(muzzle);
  const archetype = model.archetype === 'pistol' ? 'pistol' : model.archetype === 'melee' ? 'melee' : 'rifle';
  const hold = HOLD_POINTS[weaponId] || HOLD_POINTS[archetype] || HOLD_POINTS.rifle;
  return { group, muzzle, archetype, hold };
}

export class Bot {
  constructor({ name, team, spawn, scene, showNameTag, isPuppet = false, isRemotePlayer = false, peerId = null, weaponId = null }) {
    this.isPuppet = isPuppet || isRemotePlayer;
    this.isRemotePlayer = isRemotePlayer;
    this.peerId = peerId;
    this.netTarget = null;
    this.netEngage = false;
    this.isCrouching = false;
    this.isDisguised = false;
    this.isGhosted = false;
    this.horizontalSpeed = 0;
    this.timeSinceShot = 99;
    this.name = name;
    this.team = team;
    this.teamConfig = TEAMS[team];
    this.health = BOT.maxHealth;
    this.state = BOT_STATE.ROAM;
    this.deathTimer = 0;
    this.lifeCount = 0;

    this.fireCooldown = Math.random();
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.waypoint = null;
    this.waypointTimer = 0;
    this.strafeDirection = 1;
    this.strafeTimer = 0;
    this.stuckTimer = 0;
    this.lastCheckedX = 0;
    this.lastCheckedZ = 0;
    this.revealTimer = 0;
    this.hitFlash = 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.aimBlend = 0;
    this.currentSpeed = 0;
    this.deathTiltDirection = 1;
    this.recoil = 0;

    this.targetSearchTimer = Math.random() * BOT.targetSearchInterval;
    this.cachedTarget = null;
    this.donkeyTarget = null;
    this.dashTimer = 0;
    this.dashCooldown = BOT.dashCooldownMin * Math.random();
    this.dashDirection = new THREE.Vector3();
    this.ability = null;
    this.teleportCooldown = 0;

    this.hitboxes = [];
    this.flashMaterials = [];
    this.buildModel(scene, showNameTag);
    this.root.position.set(spawn[0], 0, spawn[1]);
    this.setWeapon(weaponId || (isRemotePlayer ? 'ak47' : pickBotWeapon(name, 0)));

    this.scratchEye = new THREE.Vector3();
    this.scratchTarget = new THREE.Vector3();
    this.scratchMuzzle = new THREE.Vector3();
  }

  get position() {
    return this.root.position;
  }

  get isDead() {
    return this.state === BOT_STATE.DEAD;
  }

  get weaponStats() {
    return BOT_WEAPONS[this.weaponId] || BOT_WEAPONS.ak47;
  }

  // ------------------------------------------------------------------ model
  buildModel(scene, showNameTag) {
    const team = this.teamConfig;
    const makeMaterial = (color, options = {}) => {
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05, envMapIntensity: 0.6, ...options });
      this.flashMaterials.push(material);
      return material;
    };
    const bodyMaterial = makeMaterial(team.bodyColor, { roughness: 0.7 });
    const vestMaterial = makeMaterial(new THREE.Color(team.bodyColor).multiplyScalar(0.5).getHex(), { roughness: 0.85 });
    const gearMaterial = makeMaterial(0x3b3f2c, { roughness: 0.9 });
    const pantsMaterial = makeMaterial(0x2c3a4a, { roughness: 0.88 });
    const bootMaterial = makeMaterial(0x1a1a1e, { roughness: 0.55 });
    const skinMaterial = makeMaterial(0xf0c090, { roughness: 0.7 });
    const gloveMaterial = makeMaterial(0x22231f, { roughness: 0.8 });
    const helmetMaterial = makeMaterial(team.accentColor, { roughness: 0.4, metalness: 0.25 });
    const faceMaterial = makeMaterial(0xffffff, { map: getFaceTexture(this.team), roughness: 0.7 });
    const goggleMaterial = new THREE.MeshStandardMaterial({ color: 0x0c1418, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.4 });
    const patchMaterial = new THREE.MeshStandardMaterial({ color: team.tagColor, emissive: team.tagColor, emissiveIntensity: 0.9, roughness: 0.5 });

    this.root = new THREE.Group();
    this.root.name = `bot-${this.name}`;
    this.figure = new THREE.Group();
    this.root.add(this.figure);

    const addBox = (parent, width, height, depth, material, x, y, z, isHead = false, isHitbox = true) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      if (isHitbox) {
        mesh.userData.bot = this;
        mesh.userData.isHead = isHead;
        this.hitboxes.push(mesh);
      }
      return mesh;
    };
    // Small decorative parts are merged per material so the extra detail stays cheap.
    const decorBuckets = new Map();
    const addDecor = (parent, width, height, depth, material, x, y, z, rotationX = 0) => {
      const geometry = new THREE.BoxGeometry(width, height, depth);
      if (rotationX) geometry.rotateX(rotationX);
      geometry.translate(x, y, z);
      const key = `${parent.uuid}|${material.uuid}`;
      if (!decorBuckets.has(key)) decorBuckets.set(key, { parent, material, geometries: [] });
      decorBuckets.get(key).geometries.push(geometry);
    };

    // Legs on hip pivots, with knee pads and laced boots.
    this.leftLeg = new THREE.Group();
    this.rightLeg = new THREE.Group();
    this.leftLeg.position.set(-0.25, 1.3, 0);
    this.rightLeg.position.set(0.25, 1.3, 0);
    for (const leg of [this.leftLeg, this.rightLeg]) {
      addBox(leg, 0.4, 1.1, 0.5, pantsMaterial, 0, -0.55, 0);
      addBox(leg, 0.44, 0.26, 0.6, bootMaterial, 0, -1.17, 0.04);
      addDecor(leg, 0.42, 0.22, 0.12, gearMaterial, 0, -0.62, 0.27);      // knee pad
      addDecor(leg, 0.46, 0.08, 0.62, gearMaterial, 0, -1.02, 0.04);      // boot cuff
      addDecor(leg, 0.12, 0.3, 0.3, gearMaterial, 0.21 * Math.sign(leg.position.x), -0.3, 0); // thigh pouch
      this.figure.add(leg);
    }

    // Torso, plate carrier, belt, pouches, backpack and radio.
    addBox(this.figure, 1, 1.3, 0.6, bodyMaterial, 0, 1.55, 0);
    addBox(this.figure, 1.08, 0.82, 0.7, vestMaterial, 0, 1.72, 0);
    addBox(this.figure, 1.06, 0.15, 0.66, bootMaterial, 0, 1.0, 0);
    for (const pouchX of [-0.3, 0, 0.3]) addDecor(this.figure, 0.26, 0.3, 0.12, gearMaterial, pouchX, 1.5, 0.4);
    addDecor(this.figure, 0.8, 0.12, 0.08, gearMaterial, 0, 2.06, 0.37);    // chest strap
    addDecor(this.figure, 0.82, 0.95, 0.42, gearMaterial, 0, 1.68, -0.52);  // backpack
    addDecor(this.figure, 0.7, 0.24, 0.3, vestMaterial, 0, 2.2, -0.5);      // bedroll
    addDecor(this.figure, 0.2, 0.36, 0.16, bootMaterial, 0.32, 1.95, -0.78); // radio
    addDecor(this.figure, 0.03, 0.9, 0.03, bootMaterial, 0.36, 2.55, -0.8);  // antenna
    addDecor(this.figure, 0.22, 0.16, 0.12, gearMaterial, -0.42, 1.0, 0.25); // belt pouch

    // Head with face texture on the front (+Z) face, helmet, goggles and a glowing team patch.
    const headMaterials = [skinMaterial, skinMaterial, skinMaterial, skinMaterial, faceMaterial, skinMaterial];
    addBox(this.figure, 0.8, 0.8, 0.8, headMaterials, 0, 2.6, 0, true);
    addBox(this.figure, 0.92, 0.32, 0.92, helmetMaterial, 0, 3.1, 0, true);
    addBox(this.figure, 0.94, 0.08, 0.32, helmetMaterial, 0, 2.97, 0.43, true);
    addDecor(this.figure, 0.86, 0.14, 0.12, goggleMaterial, 0, 3.12, 0.44);   // goggles on the helmet
    addDecor(this.figure, 0.06, 0.4, 0.06, gearMaterial, 0.44, 2.85, 0.1);    // chin strap
    addDecor(this.figure, 0.06, 0.4, 0.06, gearMaterial, -0.44, 2.85, 0.1);
    addDecor(this.figure, 0.3, 0.12, 0.06, patchMaterial, 0, 1.95, -0.75);    // team beacon on the pack

    // Arms: two segments each (shoulder → elbow → hand) posed by IK onto the weapon.
    const buildArm = (side) => {
      const upper = new THREE.Group();
      upper.position.set(side * 0.68, 2.12, 0);
      addBox(upper, 0.36, UPPER_ARM, 0.4, bodyMaterial, 0, -UPPER_ARM / 2, 0);
      addDecor(upper, 0.4, 0.22, 0.44, vestMaterial, 0, -0.08, 0);          // shoulder pad
      const fore = new THREE.Group();
      fore.position.set(0, -UPPER_ARM, 0);
      upper.add(fore);
      addBox(fore, 0.32, FOREARM - 0.18, 0.36, bodyMaterial, 0, -(FOREARM - 0.18) / 2, 0);
      addBox(fore, 0.3, 0.24, 0.32, gloveMaterial, 0, -FOREARM + 0.08, 0);
      addDecor(fore, 0.34, 0.08, 0.38, gearMaterial, 0, -FOREARM + 0.24, 0);  // cuff
      this.figure.add(upper);
      return { upper, fore };
    };
    this.holdingArm = buildArm(1);    // +X side: trigger hand
    this.supportArm = buildArm(-1);   // -X side: support hand on the handguard
    addDecor(this.supportArm.upper, 0.38, 0.14, 0.42, patchMaterial, 0, -0.26, 0); // team armband

    // Weapon mount (the model itself is attached by setWeapon).
    this.gunRoot = new THREE.Group();
    this.gunRoot.matrixAutoUpdate = true;
    this.figure.add(this.gunRoot);
    this.muzzleAnchor = new THREE.Object3D();
    this.gunRoot.add(this.muzzleAnchor);

    for (const { parent, material, geometries } of decorBuckets.values()) {
      let merged = null;
      try {
        merged = mergeGeometries(geometries, false);
      } catch {
        merged = null;
      }
      for (const geometry of merged ? [merged] : geometries) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = material !== patchMaterial;
        parent.add(mesh);
      }
    }

    if (showNameTag) {
      this.nameSprite = createNameSprite(this.isRemotePlayer ? `★ ${this.name}` : this.name, this.team === 'blue' ? '#8fc4ff' : '#ff9a92');
      this.nameSprite.position.set(0, 3.85, 0);
      this.root.add(this.nameSprite);
    }

    // Prop Hunt disguise stand-in: a supply crate shown instead of the soldier.
    const crateMaterial = new THREE.MeshStandardMaterial({ color: 0x6b5232, roughness: 0.85 });
    this.propMesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), crateMaterial);
    this.propMesh.position.y = 0.7;
    this.propMesh.castShadow = true;
    this.propMesh.userData.bot = this;
    this.propMesh.userData.isHead = false;
    this.propMesh.visible = false;
    this.root.add(this.propMesh);

    this.abilityIcon = new THREE.Sprite(getAbilityIconMaterial('hyperSpeed'));
    this.abilityIcon.scale.set(0.9, 0.9, 1);
    this.abilityIcon.position.set(0, BOT.abilityIconHeight, 0);
    this.abilityIcon.visible = false;
    this.abilityIcon.renderOrder = 11;
    this.root.add(this.abilityIcon);

    scene.add(this.root);
    this.scene = scene;
    this.carryingFlag = null;
    this.alertPosition = null;
    this.alertTimer = 0;
  }

  /** Equip a weapon model (bots: from BOT_WEAPONS; avatars: whatever the human holds). */
  setWeapon(weaponId) {
    if (!WEAPONS[weaponId]) weaponId = 'ak47';
    if (this.weaponId === weaponId && this.gunModel) return;
    this.weaponId = weaponId;
    if (this.gunModel) this.gunRoot.remove(this.gunModel.group);
    const gun = buildBotGun(weaponId);
    gun.group.scale.setScalar(GUN_SCALE);
    gun.group.rotation.y = Math.PI;             // model points down -Z; bots face +Z
    gun.group.updateMatrix();
    this.gunRoot.add(gun.group);
    this.gunModel = gun;
    this.gunRoot.visible = gun.archetype !== 'melee';
    this.muzzleAnchor = gun.muzzle;
    this.holdGrip = new THREE.Vector3(...gun.hold.grip);
    this.holdFore = new THREE.Vector3(...gun.hold.fore);
  }

  /** Remove from the scene (used when the roster changes between modes). */
  dispose() {
    this.scene.remove(this.root);
    this.isDisposed = true;
  }

  // ------------------------------------------------------------------ network puppets
  /** Host-side state for the network: [name, x, z, yaw, alive, engaging, weaponIndex, effects]. */
  netSnapshot() {
    const abilityIndex = this.ability ? ABILITY_IDS.indexOf(this.ability.id) + 1 : 0;
    const effects = (this.isDisguised ? 1 : 0) | (abilityIndex << 1);
    return [
      this.name, +this.position.x.toFixed(2), +this.position.z.toFixed(2), +this.root.rotation.y.toFixed(2),
      this.isDead ? 0 : 1, this.state === BOT_STATE.ENGAGE || this.state === BOT_STATE.HUNT ? 1 : 0,
      BOT_WEAPON_IDS.indexOf(this.weaponId), effects,
    ];
  }

  /** Puppet: receive a new target state. state: { x, z, yaw, alive, engage, crouch, disguise, y, weaponId, abilityId } */
  applyNetState(state) {
    if (!this.netTarget) {
      this.root.position.set(state.x, state.y || 0, state.z);
      this.root.rotation.y = state.yaw;
    }
    this.netTarget = state;
    this.netEngage = !!state.engage;
    this.isCrouching = !!state.crouch;
    if (state.weaponId) this.setWeapon(state.weaponId);
    if (state.alive && this.isDead) {
      this.respawnAt(state.x, state.z);
      events.emit('bot:respawn', { bot: this });
    } else if (!state.alive && !this.isDead) {
      this.die();
      events.emit('bot:death', { bot: this, killerName: '', position: this.position.clone() });
    }
    this.setDisguised(!!state.disguise && !this.isDead);
    if (state.abilityId !== undefined) this.showAbilityIcon(state.abilityId);
  }

  respawnAt(x, z) {
    this.root.position.set(x, 0, z);
    this.root.visible = true;
    this.figure.rotation.set(0, 0, 0);
    this.figure.position.set(0, 0, 0);
    this.health = BOT.maxHealth;
    this.state = BOT_STATE.ROAM;
    if (this.nameSprite) this.nameSprite.visible = true;
  }

  updatePuppet(deltaSeconds) {
    if (this.isDead) {
      this.updateDeath(deltaSeconds);
      return;
    }
    const target = this.netTarget;
    if (target) {
      const position = this.position;
      const previousX = position.x;
      const previousZ = position.z;
      const blend = 1 - Math.exp(-deltaSeconds * 14);
      // Snap when far off (teleport / respawn), otherwise glide.
      if (Math.hypot(target.x - position.x, target.z - position.z) > 12) position.set(target.x, target.y || 0, target.z);
      else {
        position.x += (target.x - position.x) * blend;
        position.z += (target.z - position.z) * blend;
        position.y += ((target.y || 0) - position.y) * blend;
      }
      this.root.rotation.y += shortestAngle(this.root.rotation.y, target.yaw) * blend;
      const measured = Math.hypot(position.x - previousX, position.z - previousZ) / Math.max(deltaSeconds, 1e-4);
      this.currentSpeed += (measured - this.currentSpeed) * Math.min(1, deltaSeconds * 10);
      this.horizontalSpeed = this.currentSpeed;
    }
    this.state = this.netEngage ? BOT_STATE.ENGAGE : BOT_STATE.ROAM;
    this.timeSinceShot += deltaSeconds;
    this.revealTimer -= deltaSeconds;
    this.animate(deltaSeconds);
    this.figure.scale.y = this.isCrouching ? 0.74 : 1;
  }

  /** Puppet-side recoil kick when a shot from this soldier is replayed. */
  playShotRecoil() {
    this.recoil = 1;
    this.timeSinceShot = 0;
  }

  // ------------------------------------------------------------------ combat state
  /** Apply damage. Returns true if this killed the bot. Called by the match manager. */
  applyDamage(amount) {
    if (this.isDead) return false;
    this.health -= amount;
    this.hitFlash = 1;
    if (this.isDisguised && !this.isPuppet) this.endAbility();   // shot while disguised: blown cover
    if (this.health <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  die() {
    this.state = BOT_STATE.DEAD;
    this.deathTimer = 0;
    this.deathTiltDirection = Math.random() > 0.5 ? 1 : -1;
    this.burstLeft = 0;
    this.dashTimer = 0;
    this.cachedTarget = null;
    this.donkeyTarget = null;
    if (!this.isPuppet) this.endAbility();
    this.setDisguised(false);
    this.showAbilityIcon(null);
    if (this.nameSprite) this.nameSprite.visible = false;
  }

  respawn() {
    const spawnList = getSpawnPoints(this.team);
    const spawn = spawnList[Math.floor(Math.random() * spawnList.length)];
    this.root.position.set(spawn[0] + (Math.random() - 0.5) * 3, 0, spawn[1]);
    this.root.visible = true;
    this.figure.rotation.set(0, 0, 0);
    this.figure.position.set(0, 0, 0);
    this.health = BOT.maxHealth;
    this.state = BOT_STATE.ROAM;
    this.waypoint = null;
    this.lifeCount++;
    // A fresh life can mean a different gun (deterministic, so online guests agree).
    this.setWeapon(pickBotWeapon(this.name, this.lifeCount));
    if (this.nameSprite) this.nameSprite.visible = true;
    events.emit('bot:respawn', { bot: this });
  }

  /** Fresh match: back to a base spawn with the opening weapon and no ability. */
  placeAtSpawn(index) {
    const spawnList = getSpawnPoints(this.team);
    const spawn = spawnList[index % spawnList.length];
    this.endAbility();
    this.setDisguised(false);
    this.root.position.set(spawn[0], 0, spawn[1]);
    this.root.rotation.y = this.team === 'red' ? 0 : Math.PI;
    this.root.visible = true;
    this.figure.rotation.set(0, 0, 0);
    this.figure.position.set(0, 0, 0);
    this.health = BOT.maxHealth;
    this.state = BOT_STATE.ROAM;
    this.waypoint = null;
    this.cachedTarget = null;
    this.donkeyTarget = null;
    this.burstLeft = 0;
    this.lifeCount = 0;
    this.carryingFlag = null;
    this.setWeapon(pickBotWeapon(this.name, 0));
    if (this.nameSprite) this.nameSprite.visible = true;
  }

  getMuzzleWorldPosition() {
    this.root.updateMatrixWorld(true);
    return this.muzzleAnchor.getWorldPosition(this.scratchMuzzle).clone();
  }

  // ------------------------------------------------------------------ abilities
  /** Won from a donkey: the bot uses it just like a player would. */
  grantAbility(abilityId = null) {
    const id = abilityId || ABILITY_IDS[Math.floor(Math.random() * ABILITY_IDS.length)];
    if (this.ability) this.endAbility();
    const definition = BOT_ABILITIES[id];
    this.ability = { id, timeLeft: definition.duration, charges: definition.charges || 0 };
    if (id === 'propHunt') this.setDisguised(true);
    this.showAbilityIcon(id);
    events.emit('bot:ability', { bot: this, id, position: this.position.clone() });
    return id;
  }

  endAbility() {
    if (!this.ability) return;
    if (this.ability.id === 'propHunt') this.setDisguised(false);
    this.ability = null;
    this.showAbilityIcon(null);
  }

  setDisguised(disguised) {
    if (this.isDisguised === disguised) return;
    this.isDisguised = disguised;
    this.propMesh.visible = disguised;
    this.figure.visible = !disguised;
    if (this.nameSprite) this.nameSprite.visible = !disguised && !this.isDead;
    if (this.abilityIcon) this.abilityIcon.visible = !disguised && !!this.abilityIconId;
  }

  showAbilityIcon(abilityId) {
    this.abilityIconId = abilityId || null;
    if (!abilityId) {
      this.abilityIcon.visible = false;
      return;
    }
    this.abilityIcon.material = getAbilityIconMaterial(abilityId);
    this.abilityIcon.visible = !this.isDisguised;
  }

  get abilitySpeedMultiplier() {
    return this.ability && this.ability.id === 'hyperSpeed' ? BOT_ABILITIES.hyperSpeed.speedMultiplier : 1;
  }

  updateAbility(deltaSeconds) {
    this.teleportCooldown -= deltaSeconds;
    if (!this.ability) return;
    this.ability.timeLeft -= deltaSeconds;
    if (this.ability.timeLeft <= 0 || (this.ability.id === 'teleport' && this.ability.charges <= 0)) this.endAbility();
  }

  /** Blink to a free spot. Returns true on success. */
  tryTeleport(x, z, physics) {
    const limit = WORLD.arenaHalfSize - 4;
    const clampedX = THREE.MathUtils.clamp(x, -limit, limit);
    const clampedZ = THREE.MathUtils.clamp(z, -limit, limit);
    if (physics.isPointBlocked(clampedX, clampedZ, 0.8)) return false;
    const from = this.position.clone();
    this.position.set(clampedX, 0, clampedZ);
    this.ability.charges--;
    this.teleportCooldown = BOT.teleportCooldown;
    this.cachedTarget = null;
    this.targetSearchTimer = 0;
    events.emit('bot:teleport', { bot: this, from, to: this.position.clone() });
    return true;
  }

  // ------------------------------------------------------------------ per frame
  /**
   * world: { bots, remotePlayers, player, physics, tags, combat, pointOfInterest, donkeys, pet, visibilityRange, timeScale, getObjective }
   *   combat.damagePlayer / damageBot / damageRemotePlayer / damagePet / damageDonkey / botShotImpact
   */
  update(deltaSeconds, world) {
    if (this.isPuppet) {
      this.updatePuppet(deltaSeconds);
      return;
    }
    if (this.isDead) {
      this.updateDeath(deltaSeconds);
      return;
    }
    this.updateAI(deltaSeconds, world);
    this.animate(deltaSeconds);
  }

  updateDeath(deltaSeconds) {
    this.deathTimer += deltaSeconds;
    const fallProgress = Math.min(1, this.deathTimer / 0.45);
    const eased = 1 - (1 - fallProgress) * (1 - fallProgress);
    this.figure.rotation.x = eased * (Math.PI / 2) * this.deathTiltDirection;
    this.figure.position.y = -eased * 0.3 - Math.max(0, this.deathTimer - 0.7) * 1.5;
    if (this.deathTimer > BOT.deathAnimationTime) this.root.visible = false;
    if (this.deathTimer > BOT.respawnDelay && !this.isPuppet) this.respawn();
    this.updateHitFlash(deltaSeconds);
  }

  // ------------------------------------------------------------------ perception
  findVisibleTarget(world) {
    const myPosition = this.position;
    const candidates = [];
    const distanceTo = (candidate) => Math.hypot(candidate.x - myPosition.x, candidate.z - myPosition.z);
    for (const other of world.bots) {
      if (other === this || other.team === this.team || other.isDead) continue;
      const candidate = { bot: other, x: other.position.x, y: 1.8, z: other.position.z, isPlayer: false };
      // Disguised (Prop Hunt) bots fool everyone unless you bump into them.
      if (other.isDisguised && distanceTo(candidate) > 4) continue;
      candidates.push(candidate);
    }
    // Other humans in an online match (their avatars on the host).
    for (const remote of world.remotePlayers || []) {
      if (remote.team === this.team || remote.isDead) continue;
      const candidate = { bot: remote, x: remote.position.x, y: remote.position.y + (remote.isCrouching ? 0.8 : 1.2), z: remote.position.z, isPlayer: false, isRemote: true };
      const remoteDistance = distanceTo(candidate);
      const disguised = remote.isDisguised && remote.horizontalSpeed < 9 && remote.timeSinceShot > 1.5 && remoteDistance > 3;
      const ghosted = remote.isGhosted && remoteDistance > TRAITS.ghost.crouchedDetectionRange;
      if (!disguised && !ghosted) candidates.push(candidate);
    }
    const player = world.player;
    if (player.team !== this.team && player.isAlive) {
      const playerCandidate = { bot: null, x: player.position.x, y: player.position.y + (player.isCrouching ? 0.8 : 1.2), z: player.position.z, isPlayer: true };
      const playerDistance = distanceTo(playerCandidate);
      // Prop Hunt: a disguised player is ignored unless sprinting, shooting or right in our face.
      const disguiseHolds = player.isDisguised && player.horizontalSpeed < 9 && player.timeSinceShot > 1.5 && playerDistance > 3;
      // Ghost trait: crouched players are only spotted up close.
      const ghostHides = player.isGhosted && playerDistance > TRAITS.ghost.crouchedDetectionRange;
      if (!disguiseHolds && !ghostHides) candidates.push(playerCandidate);
    }
    const pet = world.pet;
    if (pet && pet.isAlive && pet.team !== this.team) {
      candidates.push({ bot: null, pet, x: pet.position.x, y: 0.8, z: pet.position.z, isPlayer: false, isPet: true });
    }
    candidates.sort((first, second) => distanceTo(first) - distanceTo(second));

    // Weather (fog, dust, night) shortens everyone's sight; snipers see farther.
    const sightRange = Math.min(this.weaponStats.sightRange || BOT.sightRange, world.visibilityRange || Infinity);
    const eye = this.scratchEye.set(myPosition.x, 2, myPosition.z);
    for (const candidate of candidates.slice(0, BOT.candidatesChecked + 1)) {
      const distance = distanceTo(candidate);
      if (distance > sightRange) break;
      if (world.physics.hasLineOfSight(eye, this.scratchTarget.set(candidate.x, candidate.y, candidate.z))) {
        candidate.distance = distance;
        return candidate;
      }
    }
    return null;
  }

  /** Full searches are staggered; between them the cached target's position is refreshed. */
  acquireTarget(world, deltaSeconds) {
    this.targetSearchTimer -= deltaSeconds;
    const cached = this.cachedTarget;
    if (cached) {
      const entity = cached.isPlayer ? world.player : cached.pet || cached.bot;
      const alive = cached.isPlayer ? entity.isAlive : cached.isPet ? entity.isAlive : !entity.isDead && !entity.isDisposed;
      if (!alive) {
        this.cachedTarget = null;
        this.targetSearchTimer = 0;
      } else {
        cached.x = entity.position.x;
        cached.z = entity.position.z;
        if (cached.isPlayer) cached.y = entity.position.y + (entity.isCrouching ? 0.8 : 1.2);
        else if (cached.isRemote) cached.y = entity.position.y + (entity.isCrouching ? 0.8 : 1.2);
        cached.distance = Math.hypot(cached.x - this.position.x, cached.z - this.position.z);
      }
    }
    if (this.targetSearchTimer <= 0) {
      this.targetSearchTimer = BOT.targetSearchInterval * (0.8 + Math.random() * 0.4);
      const previous = this.cachedTarget;
      this.cachedTarget = this.findVisibleTarget(world);
      // Reaction time when a new enemy pops into view.
      if (this.cachedTarget && !previous) this.fireCooldown = Math.max(this.fireCooldown, 0.25 + Math.random() * 0.35);
    }
    return this.cachedTarget;
  }

  /** Nearest donkey we can see (only hunted when no enemy is around and we hold no ability). */
  findDonkey(world) {
    if (this.ability || !world.donkeys || !world.donkeys.length) return null;
    let best = null;
    let bestDistance = BOT.donkeyHuntRange;
    const eye = this.scratchEye.set(this.position.x, 2, this.position.z);
    for (const donkey of world.donkeys) {
      if (donkey.isDead) continue;
      const distance = Math.hypot(donkey.position.x - this.position.x, donkey.position.z - this.position.z);
      if (distance >= bestDistance) continue;
      if (!world.physics.hasLineOfSight(eye, this.scratchTarget.set(donkey.position.x, 1.3, donkey.position.z))) continue;
      best = donkey;
      bestDistance = distance;
    }
    return best;
  }

  // ------------------------------------------------------------------ AI
  updateAI(deltaSeconds, world) {
    this.fireCooldown -= deltaSeconds;
    this.strafeTimer -= deltaSeconds;
    this.waypointTimer -= deltaSeconds;
    this.stuckTimer += deltaSeconds;
    this.revealTimer -= deltaSeconds;
    this.dashCooldown -= deltaSeconds;
    this.alertTimer = (this.alertTimer || 0) - deltaSeconds;
    this.timeSinceShot += deltaSeconds;
    this.updateAbility(deltaSeconds);

    const position = this.position;
    const target = this.acquireTarget(world, deltaSeconds);
    const weapon = this.weaponStats;
    let moveX = 0;
    let moveZ = 0;
    let speed = BOT.combatSpeed;
    let desiredYaw = this.root.rotation.y;

    // Prop Hunt: sit still as a crate and ambush anyone who walks too close.
    if (this.isDisguised) {
      if (target && target.distance < BOT_ABILITIES.propHunt.ambushRange) {
        this.endAbility();
        events.emit('bot:ability', { bot: this, id: 'ambush', position: position.clone() });
      } else {
        this.state = BOT_STATE.ROAM;
        this.currentSpeed = 0;
        return;
      }
    }

    if (target) {
      this.state = BOT_STATE.ENGAGE;
      this.donkeyTarget = null;
      const offsetX = target.x - position.x;
      const offsetZ = target.z - position.z;
      const distance = target.distance || 1;
      const [rangeMin, rangeMax] = weapon.range;
      const advance = distance > rangeMax ? 1 : distance < rangeMin ? -0.8 : 0;
      if (this.strafeTimer <= 0) {
        this.strafeDirection *= -1;
        this.strafeTimer = BOT.strafeSwitchMin + Math.random();
      }
      desiredYaw = Math.atan2(offsetX, offsetZ);
      const unitX = offsetX / distance;
      const unitZ = offsetZ / distance;
      moveX = unitX * advance - unitZ * this.strafeDirection * BOT.strafeStrength;
      moveZ = unitZ * advance + unitX * this.strafeDirection * BOT.strafeStrength;
      if (weapon === BOT_WEAPONS.rail && advance === 0) {
        // Snipers plant their feet once in range.
        moveX *= 0.25;
        moveZ *= 0.25;
      }
      if (this.carryingFlag && world.getObjective) {
        // Flag carriers shoot while running home.
        const objective = world.getObjective(this);
        if (objective) {
          const homeX = objective.x - position.x;
          const homeZ = objective.z - position.z;
          const homeLength = Math.hypot(homeX, homeZ) || 1;
          moveX = homeX / homeLength;
          moveZ = homeZ / homeLength;
        }
      }
      // Combat dodge: a sideways or closing dash every few seconds.
      if (this.dashTimer <= 0 && this.dashCooldown <= 0 && Math.random() < deltaSeconds * 1.5) {
        const lateral = Math.random() < 0.7;
        this.startDash(lateral ? -unitZ * this.strafeDirection : unitX * Math.sign(advance || 1), lateral ? unitX * this.strafeDirection : unitZ * Math.sign(advance || 1));
      }
      // Teleport: blink to the target's flank when far away.
      if (this.ability && this.ability.id === 'teleport' && this.teleportCooldown <= 0 && distance > 18) {
        const flank = BOT_ABILITIES.teleport.flankDistance;
        const side = Math.random() < 0.5 ? 1 : -1;
        this.tryTeleport(target.x - unitX * flank - unitZ * side * flank * 0.6, target.z - unitZ * flank + unitX * side * flank * 0.6, world.physics);
      }
      this.handleFiring(target, distance, world, deltaSeconds);
    } else {
      speed = BOT.roamSpeed;
      let goalX;
      let goalZ;
      const objective = world.getObjective ? world.getObjective(this) : null;
      // Donkey hunting (re-evaluated with the target search cadence).
      if (!objective && this.targetSearchTimer >= BOT.targetSearchInterval * 0.75) this.donkeyTarget = this.findDonkey(world);
      if (this.donkeyTarget && (this.donkeyTarget.isDead || this.ability)) this.donkeyTarget = null;
      const donkey = objective ? null : this.donkeyTarget;
      if (!donkey) this.burstLeft = 0;   // nothing to shoot at: drop any half-finished burst
      const tag = objective || donkey ? null : this.findNearestTag(world.tags);
      if (objective) {
        this.state = BOT_STATE.OBJECTIVE;
        goalX = objective.x;
        goalZ = objective.z;
        if (objective.speed) speed *= objective.speed;
      } else if (donkey) {
        this.state = BOT_STATE.HUNT;
        const distance = Math.hypot(donkey.position.x - position.x, donkey.position.z - position.z);
        goalX = donkey.position.x;
        goalZ = donkey.position.z;
        if (distance < 12) speed = 0;
        this.handleFiring({ donkey, x: donkey.position.x, y: 1.3, z: donkey.position.z, isDonkey: true }, distance, world, deltaSeconds);
      } else if (this.alertPosition && this.alertTimer > 0) {
        // Heard gunfire: investigate.
        this.state = BOT_STATE.ROAM;
        goalX = this.alertPosition.x;
        goalZ = this.alertPosition.z;
      } else if (tag) {
        this.state = BOT_STATE.COLLECT;
        goalX = tag.x;
        goalZ = tag.z;
      } else {
        this.state = BOT_STATE.ROAM;
        const reachedWaypoint = this.waypoint && Math.hypot(this.waypoint[0] - position.x, this.waypoint[1] - position.z) < 3;
        if (!this.waypoint || this.waypointTimer <= 0 || reachedWaypoint) {
          const area = BOT.roamAreaHalfSize * arenaScale();
          const interest = world.pointOfInterest;
          if (interest && Math.random() < SUPPLY_DROP.botInterest) {
            // Contest the supply drop.
            this.waypoint = [interest.x + (Math.random() - 0.5) * 10, interest.z + (Math.random() - 0.5) * 10];
          } else {
            this.waypoint = [Math.random() * area * 2 - area, Math.random() * area * 2 - area];
          }
          this.waypointTimer = BOT.waypointTimeout * Math.max(1, arenaScale());
        }
        goalX = this.waypoint[0];
        goalZ = this.waypoint[1];
      }
      const offsetX = goalX - position.x;
      const offsetZ = goalZ - position.z;
      const length = Math.hypot(offsetX, offsetZ) || 1;
      moveX = offsetX / length;
      moveZ = offsetZ / length;
      desiredYaw = Math.atan2(offsetX, offsetZ);
      // Long hikes: sprint-dash now and then, or blink with Teleport.
      if (length > 30 && this.dashTimer <= 0 && this.dashCooldown <= 0 && Math.random() < deltaSeconds * 0.6) this.startDash(moveX, moveZ);
      if (this.ability && this.ability.id === 'teleport' && this.teleportCooldown <= 0 && length > 40) {
        const blink = BOT_ABILITIES.teleport.roamBlink;
        this.tryTeleport(position.x + moveX * blink, position.z + moveZ * blink, world.physics);
      }
    }

    // Smooth turning instead of snapping.
    this.root.rotation.y += shortestAngle(this.root.rotation.y, desiredYaw) * (1 - Math.exp(-deltaSeconds * 12));

    const previousX = position.x;
    const previousZ = position.z;
    speed *= this.abilitySpeedMultiplier;
    if (this.dashTimer > 0) {
      this.dashTimer -= deltaSeconds;
      position.x += this.dashDirection.x * BOT.roamSpeed * BOT.dashSpeedMultiplier * deltaSeconds;
      position.z += this.dashDirection.z * BOT.roamSpeed * BOT.dashSpeedMultiplier * deltaSeconds;
    } else {
      position.x += moveX * speed * deltaSeconds;
      position.z += moveZ * speed * deltaSeconds;
    }
    world.physics.resolveHorizontal(position, 0);
    this.currentSpeed = Math.hypot(position.x - previousX, position.z - previousZ) / Math.max(deltaSeconds, 1e-4);

    // Unstick: if barely moved while trying to, pick a new waypoint and flip strafe.
    if (this.stuckTimer > BOT.stuckCheckInterval) {
      const moved = Math.hypot(position.x - this.lastCheckedX, position.z - this.lastCheckedZ);
      if (moved < BOT.stuckDistance && (moveX || moveZ) && speed > 0) {
        this.waypoint = null;
        this.strafeDirection *= -1;
      }
      this.lastCheckedX = position.x;
      this.lastCheckedZ = position.z;
      this.stuckTimer = 0;
    }
  }

  startDash(directionX, directionZ) {
    const length = Math.hypot(directionX, directionZ);
    if (length < 0.01) return;
    this.dashDirection.set(directionX / length, 0, directionZ / length);
    this.dashTimer = BOT.dashDuration;
    const hyper = this.ability && this.ability.id === 'hyperSpeed' ? BOT_ABILITIES.hyperSpeed.dashCooldownScale : 1;
    this.dashCooldown = (BOT.dashCooldownMin + Math.random() * BOT.dashCooldownJitter) * hyper;
    events.emit('bot:dash', { bot: this, position: this.position.clone(), direction: this.dashDirection.clone() });
  }

  /** Called when gunfire is heard nearby: the bot will investigate that spot. */
  alertAt(position, duration = 6) {
    this.alertPosition = { x: position.x, z: position.z };
    this.alertTimer = duration;
  }

  findNearestTag(tags) {
    let nearestTag = null;
    let nearestWeightedDistance = Infinity;
    for (const tag of tags) {
      const weight = tag.team === this.team ? BOT.ownTagWeight : 1;
      const weightedDistance = Math.hypot(tag.x - this.position.x, tag.z - this.position.z) * weight;
      if (weightedDistance < nearestWeightedDistance && weightedDistance < BOT.tagSearchRadius * Math.max(1, arenaScale())) {
        nearestWeightedDistance = weightedDistance;
        nearestTag = tag;
      }
    }
    return nearestTag;
  }

  // ------------------------------------------------------------------ shooting
  /** Burst-fire controller shared by enemy and donkey targets. */
  handleFiring(target, distance, world, deltaSeconds) {
    const weapon = this.weaponStats;
    if (this.burstLeft > 0) {
      this.burstTimer -= deltaSeconds;
      if (this.burstTimer <= 0) {
        this.fireShot(target, distance, world);
        this.burstLeft--;
        this.burstTimer = weapon.shotInterval;
        if (this.burstLeft <= 0) {
          const focus = this.ability && this.ability.id === 'deadEye' ? BOT_ABILITIES.deadEye.pauseScale : 1;
          this.fireCooldown = (weapon.pauseMin + Math.random() * weapon.pauseJitter) * focus;
        }
      }
    } else if (this.fireCooldown <= 0) {
      this.burstLeft = weapon.burst;
      this.burstTimer = 0;
    }
  }

  fireShot(target, distance, world) {
    const weapon = this.weaponStats;
    const definition = WEAPONS[this.weaponId];
    this.revealTimer = BOT.radarRevealTime;
    this.recoil = 1;
    this.timeSinceShot = 0;

    let accuracy = Math.max(BOT.minAccuracy, BOT.baseAccuracy - distance * BOT.accuracyFalloffPerMetre * weapon.falloff) * weapon.accuracy;
    if (target.isPlayer && world.player.isCrouching) accuracy *= 0.8;
    if (world.timeScale && world.timeScale < 1) accuracy *= 0.75;   // player's Dead-Eye: bots are sluggish
    if (this.ability && this.ability.id === 'deadEye') accuracy *= BOT_ABILITIES.deadEye.accuracyMultiplier;
    if (target.isDonkey) accuracy = Math.max(accuracy, 0.55);
    accuracy = Math.min(0.95, accuracy);

    const origin = this.getMuzzleWorldPosition();
    let hits = 0;
    let headshot = false;
    const tracerEnds = [];
    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      const didHit = Math.random() < accuracy;
      if (didHit) hits++;
      const scatter = didHit ? 0.25 : BOT.missScatter;
      const end = new THREE.Vector3(
        target.x + (Math.random() - 0.5) * scatter,
        target.y + (didHit ? (Math.random() - 0.5) * 0.4 : (Math.random() - 0.3) * 1.2),
        target.z + (Math.random() - 0.5) * scatter,
      );
      if (tracerEnds.length < 3) tracerEnds.push({ end, didHit });
    }
    if (hits > 0 && !target.isDonkey && !target.isPet) headshot = Math.random() < (this.weaponId === 'rail' ? 0.35 : this.weaponId === 'deagle' ? 0.18 : 0.08);

    tracerEnds.forEach(({ end, didHit }, index) => {
      events.emit('bot:fire', {
        bot: this, origin, target: end, didHit, targetIsPlayer: !!target.isPlayer, targetPeerId: target.isRemote ? target.bot.peerId : null,
        weaponId: this.weaponId, sound: definition ? definition.sound : null, silent: index > 0,
      });
    });

    if (hits > 0) {
      const headScale = headshot ? 1.6 : 1;
      const options = { isHeadshot: headshot, weaponName: definition.shortName || definition.name, weaponId: this.weaponId };
      if (target.isPlayer) world.combat.damagePlayer(weapon.damageToPlayer * hits * headScale, this, options);
      else if (target.isRemote) world.combat.damageRemotePlayer(target.bot, weapon.damageToPlayer * hits * headScale, this, options);
      else if (target.isPet) world.combat.damagePet(weapon.damageToBot * hits, this);
      else if (target.isDonkey) {
        if (world.combat.damageDonkey(target.donkey, weapon.damageToBot * hits, this)) this.donkeyTarget = null;
      } else world.combat.damageBot(target.bot, weapon.damageToBot * hits * headScale, this, { ...options, point: tracerEnds[0].end.clone() });
    }
    const firstMiss = tracerEnds.find((entry) => !entry.didHit);
    if (firstMiss && world.combat.botShotImpact) {
      // Stray rounds chip away at voxel cover.
      world.combat.botShotImpact(origin, firstMiss.end.clone().sub(origin).setLength(distance + 8).add(origin));
    }
    if (firstMiss && world.player.isAlive && world.player.team !== this.team) {
      this.checkWhiz(origin, firstMiss.end, distance, world);
    }
  }

  /** A near-miss passing close to the player's head plays a supersonic whiz. */
  checkWhiz(origin, targetPoint, distance, world) {
    const playerHead = new THREE.Vector3(world.player.position.x, world.player.position.y + world.player.eyeHeight, world.player.position.z);
    const segment = new THREE.Line3(origin, targetPoint.clone().sub(origin).setLength(distance + 6).add(origin));
    const closestPoint = segment.closestPointToPoint(playerHead, true, new THREE.Vector3());
    if (closestPoint.distanceTo(playerHead) < BOT.whizRadius) events.emit('bullet:whiz', { position: closestPoint });
  }

  // ------------------------------------------------------------------ animation
  animate(deltaSeconds) {
    const walkAmount = Math.min(1, this.currentSpeed / BOT.roamSpeed);
    this.walkPhase += deltaSeconds * (4 + Math.min(this.currentSpeed, 14) * 1.4);
    const swing = Math.sin(this.walkPhase) * 0.65 * walkAmount;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;

    const aimTarget = this.state === BOT_STATE.ENGAGE || this.state === BOT_STATE.HUNT || this.timeSinceShot < 1 ? 1 : 0;
    this.aimBlend += (aimTarget - this.aimBlend) * (1 - Math.exp(-deltaSeconds * 9));
    this.recoil = Math.max(0, this.recoil - deltaSeconds * 9);

    // Body: slight forward lean while running or dashing, bob with the stride.
    const lean = this.dashTimer > 0 ? 0.28 : walkAmount * 0.08;
    this.figure.rotation.x += (lean - this.figure.rotation.x) * Math.min(1, deltaSeconds * 10);
    this.figure.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.06 * walkAmount;

    this.poseWeapon(swing, walkAmount);
    this.updateHitFlash(deltaSeconds);
    if (this.abilityIcon.visible) this.abilityIcon.position.y = BOT.abilityIconHeight + Math.sin(this.walkPhase * 0.5) * 0.08;
  }

  /** Place the gun for the current aim blend, then reach both hands onto it with IK. */
  poseWeapon(swing, walkAmount) {
    const gun = this.gunModel;
    if (!gun || gun.archetype === 'melee') {
      this.solveArm(this.holdingArm, HIP_REST_HOLDING, POLE_HOLDING);
      this.solveArm(this.supportArm, HIP_REST_SUPPORT, POLE_SUPPORT);
      return;
    }
    const poses = GUN_POSES[gun.archetype] || GUN_POSES.rifle;
    const blend = this.aimBlend;
    const aim = poses.aim;
    const rest = poses.rest;
    const bob = Math.sin(this.walkPhase * 2) * 0.03 * walkAmount;
    this.gunRoot.position.set(
      THREE.MathUtils.lerp(rest.position[0], aim.position[0], blend),
      THREE.MathUtils.lerp(rest.position[1], aim.position[1], blend) + bob,
      THREE.MathUtils.lerp(rest.position[2], aim.position[2], blend) - this.recoil * 0.12,
    );
    this.gunRoot.rotation.set(
      THREE.MathUtils.lerp(rest.pitch, aim.pitch, blend) - this.recoil * 0.14,
      THREE.MathUtils.lerp(rest.yaw, aim.yaw, blend) + swing * 0.05 * (1 - blend),
      0,
    );
    this.gunRoot.updateMatrix();
    const modelMatrix = gun.group.matrix;
    scratchGrip.copy(this.holdGrip).applyMatrix4(modelMatrix).applyMatrix4(this.gunRoot.matrix);
    scratchFore.copy(this.holdFore).applyMatrix4(modelMatrix).applyMatrix4(this.gunRoot.matrix);
    this.solveArm(this.holdingArm, scratchGrip, POLE_HOLDING);
    if (gun.archetype === 'pistol' && blend < 0.5) {
      // One-handed carry: the support arm swings at the side.
      scratchPole.copy(HIP_REST_SUPPORT);
      scratchPole.z += swing * 0.35;
      this.solveArm(this.supportArm, scratchPole, POLE_SUPPORT);
    } else {
      this.solveArm(this.supportArm, scratchFore, POLE_SUPPORT);
    }
  }

  /** Analytic two-bone IK in body space: shoulder → elbow → hand reaching `target`. */
  solveArm(arm, target, pole) {
    const shoulder = arm.upper.position;
    scratchDirection.subVectors(target, shoulder);
    let distance = scratchDirection.length();
    if (distance < 1e-4) return;
    scratchDirection.divideScalar(distance);
    distance = THREE.MathUtils.clamp(distance, Math.abs(UPPER_ARM - FOREARM) + 0.02, UPPER_ARM + FOREARM - 0.001);
    const cosShoulder = (UPPER_ARM * UPPER_ARM + distance * distance - FOREARM * FOREARM) / (2 * UPPER_ARM * distance);
    const sinShoulder = Math.sqrt(Math.max(0, 1 - cosShoulder * cosShoulder));
    scratchBend.copy(pole).addScaledVector(scratchDirection, -pole.dot(scratchDirection));
    if (scratchBend.lengthSq() < 1e-6) scratchBend.set(0, -1, 0);
    scratchBend.normalize();
    scratchElbow.copy(shoulder).addScaledVector(scratchDirection, UPPER_ARM * cosShoulder).addScaledVector(scratchBend, UPPER_ARM * sinShoulder);
    scratchHand.copy(shoulder).addScaledVector(scratchDirection, distance);
    scratchSegment.subVectors(scratchElbow, shoulder).normalize();
    arm.upper.quaternion.setFromUnitVectors(DOWN, scratchSegment);
    scratchSegment.subVectors(scratchHand, scratchElbow).normalize();
    scratchQuaternion.copy(arm.upper.quaternion).invert();
    scratchSegment.applyQuaternion(scratchQuaternion);
    arm.fore.quaternion.setFromUnitVectors(DOWN, scratchSegment);
  }

  updateHitFlash(deltaSeconds) {
    if (this.hitFlash <= 0) return;
    this.hitFlash = Math.max(0, this.hitFlash - deltaSeconds * 6);
    for (const material of this.flashMaterials) {
      material.emissive.setRGB(this.hitFlash * 1.2, this.hitFlash * 0.25, this.hitFlash * 0.2);
    }
  }
}

