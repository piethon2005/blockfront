// =====================================================================
// Bots — blocky soldiers with articulated limbs and a simple but lively
// AI state machine:
//   ENGAGE  — a visible enemy is in range: face it, strafe, keep preferred
//             distance, fire with distance-based accuracy.
//   COLLECT — no enemy visible: walk to the nearest dog tag (enemy tags
//             preferred over own-team tags).
//   ROAM    — nothing to do: wander between random waypoints, often
//             converging on an active supply drop.
//   DEAD    — death animation, then respawn at a team spawn point.
// Animation: walk cycle, aiming pose, smooth turning, hit flash, topple-over death.
//
// Multiplayer puppets reuse this class without the AI:
//   isPuppet       — a host-simulated bot mirrored on a guest's screen.
//   isRemotePlayer — another human's soldier (avatar). Its hitboxes are
//                    shootable, but damage is sent to its owner instead.
// Puppets are driven by applyNetState() and interpolate between updates.
// =====================================================================

import * as THREE from 'three';
import { BOT, SPAWN_POINTS, SUPPLY_DROP, TEAMS, TRAITS } from '../config.js';
import { events } from '../core/events.js';
import { createCanvasTexture } from '../world/materials.js';

export const BOT_STATE = { ENGAGE: 'engage', COLLECT: 'collect', OBJECTIVE: 'objective', ROAM: 'roam', DEAD: 'dead' };

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
  context.roundRect ? context.roundRect(128 - textWidth / 2, 12, textWidth, 40, 12) : context.rect(128 - textWidth / 2, 12, textWidth, 40);
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

const shortestAngle = (from, to) => {
  let difference = (to - from) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
};

export class Bot {
  constructor({ name, team, spawn, scene, showNameTag, isPuppet = false, isRemotePlayer = false, peerId = null }) {
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

    this.fireCooldown = Math.random();
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

    this.hitboxes = [];
    this.flashMaterials = [];
    this.buildModel(scene, showNameTag);
    this.root.position.set(spawn[0], 0, spawn[1]);

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

  // ------------------------------------------------------------------ model
  buildModel(scene, showNameTag) {
    const team = this.teamConfig;
    const makeMaterial = (color, options = {}) => {
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05, envMapIntensity: 0.6, ...options });
      this.flashMaterials.push(material);
      return material;
    };
    const bodyMaterial = makeMaterial(team.bodyColor);
    const vestMaterial = makeMaterial(new THREE.Color(team.bodyColor).multiplyScalar(0.65).getHex(), { roughness: 0.8 });
    const pantsMaterial = makeMaterial(0x2c3a66, { roughness: 0.85 });
    const bootMaterial = makeMaterial(0x1a1a1e, { roughness: 0.6 });
    const skinMaterial = makeMaterial(0xf0c090, { roughness: 0.7 });
    const helmetMaterial = makeMaterial(team.accentColor, { roughness: 0.35, metalness: 0.3 });
    const faceMaterial = makeMaterial(0xffffff, { map: getFaceTexture(this.team), roughness: 0.7 });
    const gunMaterial = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.35, metalness: 0.8 });

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

    // Legs on hip pivots.
    this.leftLeg = new THREE.Group();
    this.rightLeg = new THREE.Group();
    this.leftLeg.position.set(-0.25, 1.3, 0);
    this.rightLeg.position.set(0.25, 1.3, 0);
    for (const leg of [this.leftLeg, this.rightLeg]) {
      addBox(leg, 0.4, 1.1, 0.5, pantsMaterial, 0, -0.55, 0);
      addBox(leg, 0.44, 0.26, 0.6, bootMaterial, 0, -1.17, 0.04);
      this.figure.add(leg);
    }

    // Torso, vest, belt.
    addBox(this.figure, 1, 1.3, 0.6, bodyMaterial, 0, 1.55, 0);
    addBox(this.figure, 1.06, 0.8, 0.66, vestMaterial, 0, 1.7, 0);
    addBox(this.figure, 1.04, 0.14, 0.64, bootMaterial, 0, 1.0, 0);
    addBox(this.figure, 0.3, 0.3, 0.12, vestMaterial, -0.25, 1.75, 0.36);
    addBox(this.figure, 0.3, 0.3, 0.12, vestMaterial, 0.25, 1.75, 0.36);

    // Head with face texture on the front (+Z) face, plus helmet.
    const headMaterials = [skinMaterial, skinMaterial, skinMaterial, skinMaterial, faceMaterial, skinMaterial];
    addBox(this.figure, 0.8, 0.8, 0.8, headMaterials, 0, 2.6, 0, true);
    addBox(this.figure, 0.9, 0.3, 0.9, helmetMaterial, 0, 3.1, 0, true);
    addBox(this.figure, 0.92, 0.08, 0.3, helmetMaterial, 0, 2.97, 0.42, true);

    // Arms on shoulder pivots.
    this.leftArm = new THREE.Group();
    this.rightArm = new THREE.Group();
    this.leftArm.position.set(-0.68, 2.12, 0);
    this.rightArm.position.set(0.68, 2.12, 0);
    for (const arm of [this.leftArm, this.rightArm]) {
      addBox(arm, 0.35, 1.0, 0.4, bodyMaterial, 0, -0.45, 0);
      addBox(arm, 0.3, 0.25, 0.32, skinMaterial, 0, -1.05, 0);
      this.figure.add(arm);
    }
    addBox(this.leftArm, 0.37, 0.16, 0.42, helmetMaterial, 0, -0.2, 0, false); // team armband

    // Rifle held at chest height.
    this.gun = new THREE.Group();
    this.gun.position.set(0.2, 1.95, 0.55);
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 1.1), gunMaterial);
    gunBody.castShadow = true;
    this.gun.add(gunBody);
    const gunMagazine = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 0.14), gunMaterial);
    gunMagazine.position.set(0, -0.2, 0.05);
    this.gun.add(gunMagazine);
    this.muzzleAnchor = new THREE.Object3D();
    this.muzzleAnchor.position.set(0, 0.03, 0.62);
    this.gun.add(this.muzzleAnchor);
    this.figure.add(this.gun);

    if (showNameTag) {
      this.nameSprite = createNameSprite(this.isRemotePlayer ? `★ ${this.name}` : this.name, this.team === 'blue' ? '#8fc4ff' : '#ff9a92');
      this.nameSprite.position.set(0, 3.85, 0);
      this.root.add(this.nameSprite);
    }
    if (this.isRemotePlayer) {
      // Prop Hunt disguise stand-in: a supply crate shown instead of the soldier.
      const crateMaterial = new THREE.MeshStandardMaterial({ color: 0x6b5232, roughness: 0.85 });
      this.propMesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), crateMaterial);
      this.propMesh.position.y = 0.7;
      this.propMesh.castShadow = true;
      this.propMesh.userData.bot = this;
      this.propMesh.userData.isHead = false;
      this.propMesh.visible = false;
      this.root.add(this.propMesh);
    }

    scene.add(this.root);
    this.scene = scene;
    this.carryingFlag = null;
    this.alertPosition = null;
    this.alertTimer = 0;
  }

  /** Remove from the scene (used when the roster changes between modes). */
  dispose() {
    this.scene.remove(this.root);
    this.isDisposed = true;
  }

  // ------------------------------------------------------------------ network puppets
  /** Host-side state for the network: [name, x, z, yaw, alive, engaging]. */
  netSnapshot() {
    return [this.name, +this.position.x.toFixed(2), +this.position.z.toFixed(2), +this.root.rotation.y.toFixed(2), this.isDead ? 0 : 1, this.state === BOT_STATE.ENGAGE ? 1 : 0];
  }

  /** Puppet: receive a new target state. state: { x, z, yaw, alive, engage, crouch, disguise, y } */
  applyNetState(state) {
    if (!this.netTarget) {
      this.root.position.set(state.x, state.y || 0, state.z);
      this.root.rotation.y = state.yaw;
    }
    this.netTarget = state;
    this.netEngage = !!state.engage;
    this.isCrouching = !!state.crouch;
    this.isDisguised = !!state.disguise;
    if (state.alive && this.isDead) {
      this.respawnAt(state.x, state.z);
      events.emit('bot:respawn', { bot: this });
    } else if (!state.alive && !this.isDead) {
      this.die();
      events.emit('bot:death', { bot: this, killerName: '', position: this.position.clone() });
    }
    if (this.propMesh) {
      this.propMesh.visible = this.isDisguised && !this.isDead;
      this.figure.visible = !this.isDisguised;
      if (this.nameSprite) this.nameSprite.visible = !this.isDisguised && !this.isDead;
    }
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

  // ------------------------------------------------------------------ combat state
  /** Apply damage. Returns true if this killed the bot. Called by the match manager. */
  applyDamage(amount) {
    if (this.isDead) return false;
    this.health -= amount;
    this.hitFlash = 1;
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
    if (this.nameSprite) this.nameSprite.visible = false;
  }

  respawn() {
    const spawnList = SPAWN_POINTS[this.team];
    const spawn = spawnList[Math.floor(Math.random() * spawnList.length)];
    this.root.position.set(spawn[0], 0, spawn[1]);
    this.root.visible = true;
    this.figure.rotation.set(0, 0, 0);
    this.figure.position.set(0, 0, 0);
    this.health = BOT.maxHealth;
    this.state = BOT_STATE.ROAM;
    this.waypoint = null;
    if (this.nameSprite) this.nameSprite.visible = true;
    events.emit('bot:respawn', { bot: this });
  }

  getMuzzleWorldPosition() {
    this.root.updateMatrixWorld(true);
    return this.muzzleAnchor.getWorldPosition(this.scratchMuzzle).clone();
  }

  // ------------------------------------------------------------------ per frame
  /**
   * world: { bots, player, physics, tags, combat, pointOfInterest }
   *   combat.damagePlayer(amount, attackerBot) / combat.damageBot(targetBot, amount, attackerBot)
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

  findVisibleTarget(world) {
    const myPosition = this.position;
    const candidates = [];
    for (const other of world.bots) {
      if (other !== this && other.team !== this.team && !other.isDead) {
        candidates.push({ bot: other, x: other.position.x, y: 1.8, z: other.position.z, isPlayer: false });
      }
    }
    const player = world.player;
    const distanceTo = (candidate) => Math.hypot(candidate.x - myPosition.x, candidate.z - myPosition.z);
    // Other humans in an online match (their avatars on the host).
    for (const remote of world.remotePlayers || []) {
      if (remote.team === this.team || remote.isDead) continue;
      const candidate = { bot: remote, x: remote.position.x, y: remote.position.y + (remote.isCrouching ? 0.8 : 1.2), z: remote.position.z, isPlayer: false, isRemote: true };
      const remoteDistance = distanceTo(candidate);
      const disguised = remote.isDisguised && remote.horizontalSpeed < 9 && remote.timeSinceShot > 1.5 && remoteDistance > 3;
      const ghosted = remote.isGhosted && remoteDistance > TRAITS.ghost.crouchedDetectionRange;
      if (!disguised && !ghosted) candidates.push(candidate);
    }
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

    // Weather (fog, dust, night) shortens everyone's sight.
    const sightRange = Math.min(BOT.sightRange, world.visibilityRange || Infinity);
    const eye = this.scratchEye.set(myPosition.x, 2, myPosition.z);
    for (const candidate of candidates.slice(0, BOT.candidatesChecked)) {
      const distance = distanceTo(candidate);
      if (distance > sightRange) break;
      if (world.physics.hasLineOfSight(eye, this.scratchTarget.set(candidate.x, candidate.y, candidate.z))) {
        candidate.distance = distance;
        return candidate;
      }
    }
    return null;
  }

  updateAI(deltaSeconds, world) {
    this.fireCooldown -= deltaSeconds;
    this.strafeTimer -= deltaSeconds;
    this.waypointTimer -= deltaSeconds;
    this.stuckTimer += deltaSeconds;
    this.revealTimer -= deltaSeconds;
    this.alertTimer = (this.alertTimer || 0) - deltaSeconds;

    const position = this.position;
    const target = this.findVisibleTarget(world);
    let moveX = 0;
    let moveZ = 0;
    let speed = BOT.combatSpeed;
    let desiredYaw = this.root.rotation.y;

    if (target) {
      this.state = BOT_STATE.ENGAGE;
      const offsetX = target.x - position.x;
      const offsetZ = target.z - position.z;
      const distance = target.distance || 1;
      const advance = distance > BOT.preferredRangeMax ? 1 : distance < BOT.preferredRangeMin ? -0.8 : 0;
      if (this.strafeTimer <= 0) {
        this.strafeDirection *= -1;
        this.strafeTimer = BOT.strafeSwitchMin + Math.random();
      }
      desiredYaw = Math.atan2(offsetX, offsetZ);
      const unitX = offsetX / distance;
      const unitZ = offsetZ / distance;
      moveX = unitX * advance - unitZ * this.strafeDirection * BOT.strafeStrength;
      moveZ = unitZ * advance + unitX * this.strafeDirection * BOT.strafeStrength;
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
      if (this.fireCooldown <= 0) this.fireAt(target, distance, world);
    } else {
      speed = BOT.roamSpeed;
      let goalX;
      let goalZ;
      const objective = world.getObjective ? world.getObjective(this) : null;
      const tag = objective ? null : this.findNearestTag(world.tags);
      if (objective) {
        this.state = BOT_STATE.OBJECTIVE;
        goalX = objective.x;
        goalZ = objective.z;
        if (objective.speed) speed *= objective.speed;
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
          const area = BOT.roamAreaHalfSize;
          const interest = world.pointOfInterest;
          if (interest && Math.random() < SUPPLY_DROP.botInterest) {
            // Contest the supply drop.
            this.waypoint = [interest.x + (Math.random() - 0.5) * 10, interest.z + (Math.random() - 0.5) * 10];
          } else {
            this.waypoint = [Math.random() * area * 2 - area, Math.random() * area * 2 - area];
          }
          this.waypointTimer = BOT.waypointTimeout;
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
    }

    // Smooth turning instead of snapping.
    this.root.rotation.y += shortestAngle(this.root.rotation.y, desiredYaw) * (1 - Math.exp(-deltaSeconds * 12));

    const previousX = position.x;
    const previousZ = position.z;
    position.x += moveX * speed * deltaSeconds;
    position.z += moveZ * speed * deltaSeconds;
    world.physics.resolveHorizontal(position, 0);
    this.currentSpeed = Math.hypot(position.x - previousX, position.z - previousZ) / Math.max(deltaSeconds, 1e-4);

    // Unstick: if barely moved while trying to, pick a new waypoint and flip strafe.
    if (this.stuckTimer > BOT.stuckCheckInterval) {
      const moved = Math.hypot(position.x - this.lastCheckedX, position.z - this.lastCheckedZ);
      if (moved < BOT.stuckDistance && (moveX || moveZ)) {
        this.waypoint = null;
        this.strafeDirection *= -1;
      }
      this.lastCheckedX = position.x;
      this.lastCheckedZ = position.z;
      this.stuckTimer = 0;
    }
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
      if (weightedDistance < nearestWeightedDistance && weightedDistance < BOT.tagSearchRadius) {
        nearestWeightedDistance = weightedDistance;
        nearestTag = tag;
      }
    }
    return nearestTag;
  }

  fireAt(target, distance, world) {
    this.fireCooldown = BOT.fireIntervalMin + Math.random() * BOT.fireIntervalJitter;
    this.revealTimer = BOT.radarRevealTime;
    let accuracy = Math.max(BOT.minAccuracy, BOT.baseAccuracy - distance * BOT.accuracyFalloffPerMetre);
    if (target.isPlayer && world.player.isCrouching) accuracy *= 0.8;
    if (world.timeScale && world.timeScale < 1) accuracy *= 0.75; // Dead-Eye: bots are sluggish
    const didHit = Math.random() < accuracy;
    const scatter = didHit ? 0 : (Math.random() - 0.5) * BOT.missScatter;
    const targetPoint = new THREE.Vector3(target.x + scatter, target.y + (didHit ? 0 : (Math.random() - 0.3) * 1.2), target.z + (didHit ? 0 : (Math.random() - 0.5) * BOT.missScatter));
    const origin = this.getMuzzleWorldPosition();

    events.emit('bot:fire', { bot: this, origin, target: targetPoint, didHit, targetIsPlayer: target.isPlayer, targetPeerId: target.isRemote ? target.bot.peerId : null });

    if (didHit) {
      if (target.isPlayer) world.combat.damagePlayer(BOT.damageToPlayer, this);
      else if (target.isRemote) world.combat.damageRemotePlayer(target.bot, BOT.damageToPlayer, this);
      else if (target.isPet) world.combat.damagePet(BOT.damageToBot, this);
      else world.combat.damageBot(target.bot, BOT.damageToBot, this, { point: targetPoint });
    } else if (world.combat.botShotImpact) {
      // Stray rounds chip away at voxel cover.
      world.combat.botShotImpact(origin, targetPoint.clone().sub(origin).setLength(distance + 8).add(origin));
    }
    if (!didHit && world.player.isAlive && world.player.team !== this.team) {
      this.checkWhiz(origin, targetPoint, distance, world);
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
    this.walkPhase += deltaSeconds * (4 + this.currentSpeed * 1.4);
    const swing = Math.sin(this.walkPhase) * 0.65 * walkAmount;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;

    const aimTarget = this.state === BOT_STATE.ENGAGE ? 1 : 0;
    this.aimBlend += (aimTarget - this.aimBlend) * (1 - Math.exp(-deltaSeconds * 8));
    const relaxedRight = -0.9 - swing * 0.2;
    const relaxedLeft = -0.75 + swing * 0.3;
    this.rightArm.rotation.x = THREE.MathUtils.lerp(relaxedRight, -1.45, this.aimBlend);
    this.leftArm.rotation.x = THREE.MathUtils.lerp(relaxedLeft, -1.35, this.aimBlend);
    this.leftArm.rotation.z = THREE.MathUtils.lerp(0, 0.45, this.aimBlend);
    this.gun.position.y = THREE.MathUtils.lerp(1.75, 1.98, this.aimBlend);
    this.gun.rotation.x = THREE.MathUtils.lerp(0.35, 0, this.aimBlend);

    // Body bob while walking.
    this.figure.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.06 * walkAmount;
    this.updateHitFlash(deltaSeconds);
  }

  updateHitFlash(deltaSeconds) {
    if (this.hitFlash <= 0) return;
    this.hitFlash = Math.max(0, this.hitFlash - deltaSeconds * 6);
    for (const material of this.flashMaterials) {
      material.emissive.setRGB(this.hitFlash * 1.2, this.hitFlash * 0.25, this.hitFlash * 0.2);
    }
  }
}
