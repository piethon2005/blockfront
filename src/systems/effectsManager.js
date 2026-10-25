// =====================================================================
// Effects manager — all visual feedback, driven purely by events:
//   • GPU point-particle pools (additive sparks/fire, alpha-blended smoke)
//   • glowing bullet tracers that travel at bullet speed
//   • muzzle flashes (viewmodel + bots) with a real point-light flash
//   • bullet-hole decals, impact dust, hit sparks
//   • voxel debris (bot shatter on death) and ejected shell casings
//   • dog-tag pickup bursts, explosions with shockwave rings
//   • supply-drop smoke beacons, landing dust, loot pickup sparkles
//   • screen shake requests (read by main.js)
// =====================================================================

import * as THREE from 'three';
import { getFlagPosition, LOOT } from '../config.js';
import { events } from '../core/events.js';
import { createCanvasTexture } from '../world/materials.js';

// ------------------------------------------------------------------ particle pool
const PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute float particleSize;
  attribute float particleAlpha;
  attribute vec3 particleColor;
  uniform float pointScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = particleColor;
    vAlpha = particleAlpha;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = particleSize * pointScale / max(-viewPosition.z, 0.1);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  uniform float softness;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float distanceFromCenter = length(centered);
    if (distanceFromCenter > 0.5) discard;
    float falloff = pow(1.0 - distanceFromCenter * 2.0, softness);
    gl_FragColor = vec4(vColor, vAlpha * falloff);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

class ParticlePool {
  constructor(scene, capacity, { additive = true, softness = 1.5 } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    this.startSizes = new Float32Array(capacity);
    this.endSizes = new Float32Array(capacity);
    this.startAlphas = new Float32Array(capacity);
    this.gravities = new Float32Array(capacity);
    this.drags = new Float32Array(capacity);
    this.activeCount = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('particleColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('particleSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('particleAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: { pointScale: { value: 400 }, softness: { value: softness } },
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
    scene.add(this.points);
  }

  /** Spawn one particle. color is a THREE.Color (linear, may exceed 1 for HDR glow). */
  spawn(position, velocity, { color, lifetime = 0.5, startSize = 0.2, endSize = 0, alpha = 1, gravity = 0, drag = 0 }) {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const offset = index * 3;
    this.positions[offset] = position.x;
    this.positions[offset + 1] = position.y;
    this.positions[offset + 2] = position.z;
    this.velocities[offset] = velocity.x;
    this.velocities[offset + 1] = velocity.y;
    this.velocities[offset + 2] = velocity.z;
    this.colors[offset] = color.r;
    this.colors[offset + 1] = color.g;
    this.colors[offset + 2] = color.b;
    this.ages[index] = 0;
    this.lifetimes[index] = lifetime;
    this.startSizes[index] = startSize;
    this.endSizes[index] = endSize;
    this.startAlphas[index] = alpha;
    this.gravities[index] = gravity;
    this.drags[index] = drag;
    this.sizes[index] = startSize;
    this.alphas[index] = alpha;
  }

  update(deltaSeconds) {
    for (let index = 0; index < this.capacity; index++) {
      if (this.lifetimes[index] <= 0) continue;
      this.ages[index] += deltaSeconds;
      const progress = this.ages[index] / this.lifetimes[index];
      const offset = index * 3;
      if (progress >= 1) {
        this.lifetimes[index] = 0;
        this.alphas[index] = 0;
        this.sizes[index] = 0;
        continue;
      }
      const dragFactor = Math.max(0, 1 - this.drags[index] * deltaSeconds);
      this.velocities[offset] *= dragFactor;
      this.velocities[offset + 1] = this.velocities[offset + 1] * dragFactor - this.gravities[index] * deltaSeconds;
      this.velocities[offset + 2] *= dragFactor;
      this.positions[offset] += this.velocities[offset] * deltaSeconds;
      this.positions[offset + 1] += this.velocities[offset + 1] * deltaSeconds;
      this.positions[offset + 2] += this.velocities[offset + 2] * deltaSeconds;
      this.sizes[index] = this.startSizes[index] + (this.endSizes[index] - this.startSizes[index]) * progress;
      this.alphas[index] = this.startAlphas[index] * (1 - progress * progress);
    }
    for (const attributeName of ['position', 'particleColor', 'particleSize', 'particleAlpha']) {
      this.geometry.attributes[attributeName].needsUpdate = true;
    }
  }

  setPointScale(scale) {
    this.material.uniforms.pointScale.value = scale;
  }
}

// ------------------------------------------------------------------ voxel debris (instanced cubes)
class DebrisPool {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.cursor = 0;
    this.items = Array.from({ length: capacity }, () => ({
      active: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), rotation: new THREE.Euler(), spin: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1), age: 0, lifetime: 1, floor: 0, bounciness: 0.3,
    }));
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 }),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    const white = new THREE.Color(0xffffff);
    for (let index = 0; index < capacity; index++) {
      this.mesh.setMatrixAt(index, hiddenMatrix);
      this.mesh.setColorAt(index, white);
    }
    scene.add(this.mesh);
    this.scratchMatrix = new THREE.Matrix4();
    this.scratchQuaternion = new THREE.Quaternion();
    this.scratchColor = new THREE.Color();
  }

  spawn(position, velocity, { color, size, lifetime = 2, floor = 0, bounciness = 0.3 }) {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const item = this.items[index];
    item.active = true;
    item.position.copy(position);
    item.velocity.copy(velocity);
    item.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    item.spin.set((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18);
    if (typeof size === 'number') item.scale.setScalar(size);
    else item.scale.copy(size);
    item.age = 0;
    item.lifetime = lifetime;
    item.floor = floor;
    item.bounciness = bounciness;
    this.mesh.setColorAt(index, this.scratchColor.set(color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(deltaSeconds) {
    let anyActive = false;
    this.items.forEach((item, index) => {
      if (!item.active) return;
      anyActive = true;
      item.age += deltaSeconds;
      if (item.age >= item.lifetime) {
        item.active = false;
        this.mesh.setMatrixAt(index, this.scratchMatrix.makeScale(0, 0, 0));
        return;
      }
      item.velocity.y -= 22 * deltaSeconds;
      item.position.addScaledVector(item.velocity, deltaSeconds);
      const halfHeight = item.scale.y / 2;
      if (item.position.y < item.floor + halfHeight) {
        item.position.y = item.floor + halfHeight;
        item.velocity.y = -item.velocity.y * item.bounciness;
        item.velocity.x *= 0.6;
        item.velocity.z *= 0.6;
        item.spin.multiplyScalar(0.5);
      }
      item.rotation.x += item.spin.x * deltaSeconds;
      item.rotation.y += item.spin.y * deltaSeconds;
      item.rotation.z += item.spin.z * deltaSeconds;
      const shrink = item.age > item.lifetime - 0.4 ? (item.lifetime - item.age) / 0.4 : 1;
      this.scratchQuaternion.setFromEuler(item.rotation);
      this.scratchMatrix.compose(item.position, this.scratchQuaternion, item.scale.clone().multiplyScalar(shrink));
      this.mesh.setMatrixAt(index, this.scratchMatrix);
    });
    if (anyActive) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ effects manager
export class EffectsManager {
  constructor({ scene, camera }) {
    this.scene = scene;
    this.camera = camera;
    this.elapsed = 0;
    this.shakeIntensity = 0;

    this.sparks = new ParticlePool(scene, 900, { additive: true, softness: 1.2 });
    this.fire = new ParticlePool(scene, 900, { additive: true, softness: 2.0 });
    this.smoke = new ParticlePool(scene, 3000, { additive: false, softness: 1.6 });
    this.debris = new DebrisPool(scene, 420);

    this.createTracerPool();
    this.createDecalPool();
    this.createMuzzleFlashes();
    this.createLights();
    this.createShockwavePool();
    this.bindEvents();

    this.scratchVector = new THREE.Vector3();
    this.scratchVelocity = new THREE.Vector3();
    this.scratchColor = new THREE.Color();
  }

  // ------------------------------------------------------------------ setup
  createTracerPool() {
    this.tracers = [];
    const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5);
    for (let index = 0; index < 110; index++) {
      const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3, 1.4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.tracers.push({ mesh, start: new THREE.Vector3(), end: new THREE.Vector3(), direction: new THREE.Vector3(), length: 0, travelled: 0, active: false, speed: 380, trail: 7 });
    }
    this.tracerCursor = 0;
  }

  createDecalPool() {
    const holeTexture = createCanvasTexture(64, (context, size) => {
      const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(10,10,10,1)');
      gradient.addColorStop(0.28, 'rgba(25,22,20,0.95)');
      gradient.addColorStop(0.45, 'rgba(60,55,50,0.6)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    });
    this.decalMaterial = new THREE.MeshStandardMaterial({
      map: holeTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1,
    });
    this.decals = [];
    const geometry = new THREE.PlaneGeometry(0.26, 0.26);
    for (let index = 0; index < 90; index++) {
      const mesh = new THREE.Mesh(geometry, this.decalMaterial);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.decals.push(mesh);
    }
    this.decalCursor = 0;
  }

  createMuzzleFlashes() {
    const flashTexture = createCanvasTexture(128, (context, size) => {
      const center = size / 2;
      const glow = context.createRadialGradient(center, center, 0, center, center, center);
      glow.addColorStop(0, 'rgba(255,255,230,1)');
      glow.addColorStop(0.25, 'rgba(255,210,90,0.9)');
      glow.addColorStop(0.6, 'rgba(255,120,20,0.25)');
      glow.addColorStop(1, 'rgba(255,80,0,0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, size, size);
      context.fillStyle = 'rgba(255,240,180,0.9)';
      for (let spike = 0; spike < 6; spike++) {
        const angle = (spike / 6) * Math.PI * 2;
        context.beginPath();
        context.moveTo(center, center);
        context.lineTo(center + Math.cos(angle - 0.12) * center * 0.35, center + Math.sin(angle - 0.12) * center * 0.35);
        context.lineTo(center + Math.cos(angle) * center * 0.98, center + Math.sin(angle) * center * 0.98);
        context.lineTo(center + Math.cos(angle + 0.12) * center * 0.35, center + Math.sin(angle + 0.12) * center * 0.35);
        context.closePath();
        context.fill();
      }
    });
    const makeFlashMaterial = () => new THREE.MeshBasicMaterial({
      map: flashTexture, color: new THREE.Color(3, 2.6, 1.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });

    // Viewmodel flash: two crossed quads + a front-facing star, reparented to the active muzzle.
    this.viewmodelFlash = new THREE.Group();
    const sideQuadA = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.5).rotateX(-Math.PI / 2).translate(0, 0, -0.2), makeFlashMaterial());
    const sideQuadB = sideQuadA.clone();
    sideQuadB.rotation.z = Math.PI / 2;
    const frontStar = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), makeFlashMaterial());
    this.viewmodelFlash.add(sideQuadA, sideQuadB, frontStar);
    this.viewmodelFlash.visible = false;
    this.viewmodelFlash.traverse((object) => {
      object.frustumCulled = false;
      object.renderOrder = 20;
    });
    this.viewmodelFlashTimer = 0;

    // World flashes for bots (camera-facing quads).
    this.worldFlashes = [];
    for (let index = 0; index < 24; index++) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), makeFlashMaterial());
      mesh.visible = false;
      this.scene.add(mesh);
      this.worldFlashes.push({ mesh, timer: 0 });
    }
    this.worldFlashCursor = 0;
  }

  createLights() {
    // Lights are created once and only change intensity (adding/removing lights recompiles shaders).
    this.muzzleLight = new THREE.PointLight(0xffc870, 0, 9, 2);
    this.botMuzzleLight = new THREE.PointLight(0xffc870, 0, 10, 2);
    this.explosionLight = new THREE.PointLight(0xff8a3a, 0, 28, 2);
    this.beaconLight = new THREE.PointLight(0xff3a2a, 0, 16, 2);
    this.scene.add(this.muzzleLight, this.botMuzzleLight, this.explosionLight, this.beaconLight);
    this.emitters = [];
  }

  createShockwavePool() {
    this.shockwaves = [];
    const geometry = new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2);
    for (let index = 0; index < 4; index++) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: new THREE.Color(3, 1.8, 0.8), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.visible = false;
      this.scene.add(mesh);
      this.shockwaves.push({ mesh, age: 0, active: false, color: null });
    }
  }

  // ------------------------------------------------------------------ event wiring
  bindEvents() {
    events.on('weapon:fire', (payload) => this.onPlayerFire(payload));
    events.on('weapon:impact', (payload) => this.onImpact(payload));
    events.on('bot:fire', (payload) => this.onBotFire(payload));
    events.on('bot:hurt', (payload) => payload.point && this.hitSparks(payload.point, payload.isHeadshot));
    events.on('bot:death', (payload) => this.botShatter(payload.bot, payload.position));
    events.on('bot:respawn', (payload) => this.spawnBeam(payload.bot.position, payload.bot.teamConfig.tagColor));
    events.on('tag:pickup', (payload) => this.tagBurst(payload.position, payload.tag.team === 'red' ? 0xff3a3a : 0x3aa0ff));
    events.on('explosion', (payload) => this.explosion(payload.position, payload.radius));
    events.on('barrel:hit', (payload) => this.metalSparks(payload.point));
    events.on('player:land', (payload) => {
      if (payload.fallSpeed > 12) this.addShake(Math.min(0.35, payload.fallSpeed * 0.012));
    });
    events.on('player:hurt', () => this.addShake(0.18));
    events.on('supply:incoming', ({ position, eta }) => this.addEmitter({ kind: 'beacon', position, duration: eta + 30 }));
    events.on('supply:landed', ({ position }) => this.supplyLanding(position));
    events.on('supply:opened', ({ position }) => {
      this.tagBurst(position.clone().setY(1.4), LOOT.rarityColors.elite);
      this.emitters = this.emitters.filter((emitter) => emitter.kind !== 'beacon');
      this.beaconLight.intensity = 0;
    });
    events.on('loot:pickup', ({ position, rarity }) => this.pickupSparkle(position, LOOT.rarityColors[rarity] || 0xffffff));
    events.on('medkit:used', () => this.addShake(0.02));
    events.on('voxel:hit', ({ position, normal, color }) => this.voxelChips(position, normal, color));
    events.on('voxel:destroyed', (payload) => this.voxelBreak(payload));
    events.on('ability:teleport', ({ from, to }) => {
      this.teleportBurst(from);
      this.teleportBurst(to);
    });
    events.on('ability:activated', ({ position }) => this.poof(position, 0xd8d8d0, 0xffd23f));
    events.on('donkey:killed', ({ position }) => {
      this.poof(position, 0x8a8580, 0xffb21a);
      this.tagBurst(position.clone().setY(1.4), LOOT.rarityColors.elite);
    });
    events.on('pet:bite', ({ position }) => this.hitSparks(position, false));
    events.on('bot:dash', ({ position, direction }) => this.dashDust(position, direction));
    events.on('bot:teleport', ({ from, to }) => {
      this.teleportBurst(from);
      this.teleportBurst(to);
    });
    events.on('bot:ability', ({ id, position }) => {
      if (id === 'propHunt' || id === 'ambush') this.poof(position, 0xd8d8d0, 0xffd23f);
      else this.tagBurst(position.clone().setY(1.6), 0xffb21a);
    });
    events.on('ambience:artillery', ({ position }) => this.distantBlast(position));
    events.on('flag:captured', ({ team }) => {
      const [flagX, flagZ] = getFlagPosition(team);
      this.tagBurst(new THREE.Vector3(flagX, 2, flagZ), team === 'blue' ? 0x3aa0ff : 0xff3a3a);
    });
    events.on('weather:update', ({ type, intensity }) => {
      this.weatherType = type;
      this.weatherIntensity = intensity;
    });
    this.debrisBudget = 0;
  }

  // ------------------------------------------------------------------ public helpers
  addShake(amount) {
    this.shakeIntensity = Math.min(1.2, this.shakeIntensity + amount);
  }

  /** Random camera offset for this frame; main.js adds it to the camera position. */
  getShakeOffset(target) {
    const magnitude = this.shakeIntensity * this.shakeIntensity * 0.25;
    return target.set((Math.random() - 0.5) * magnitude, (Math.random() - 0.5) * magnitude, (Math.random() - 0.5) * magnitude);
  }

  setViewportHeight(drawingHeight, fovDegrees) {
    const scale = drawingHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2));
    this.sparks.setPointScale(scale);
    this.fire.setPointScale(scale);
    this.smoke.setPointScale(scale);
  }

  // ------------------------------------------------------------------ emitters
  onPlayerFire({ weapon, muzzlePosition, muzzleAnchor, tracerEnds, ejectPosition, ejectDirection, floorHeight, isScoped }) {
    // Viewmodel flash attached to the muzzle.
    if (!isScoped) {
      muzzleAnchor.add(this.viewmodelFlash);
      this.viewmodelFlash.visible = true;
      this.viewmodelFlash.rotation.z = Math.random() * Math.PI;
      const flashScale = weapon.id === 'shotgun' ? 1.6 : weapon.id === 'rail' ? 1.3 : 1;
      this.viewmodelFlash.scale.setScalar(flashScale * (0.85 + Math.random() * 0.3));
      this.viewmodelFlashTimer = 0.05;
    }
    this.muzzleLight.position.copy(muzzlePosition);
    this.muzzleLight.color.set(weapon.id === 'rail' ? 0x6fdcff : 0xffc870);
    this.muzzleLight.intensity = weapon.id === 'shotgun' ? 26 : 16;

    const tracerColor = weapon.id === 'rail' ? new THREE.Color(0.8, 3, 5) : new THREE.Color(4, 3, 1.4);
    for (const end of tracerEnds) {
      this.spawnTracer(muzzlePosition, end, { color: tracerColor, speed: weapon.id === 'rail' ? 900 : 380, trail: weapon.id === 'rail' ? 140 : 7, thickness: weapon.id === 'rail' ? 0.06 : 0.035 });
    }
    if (weapon.id === 'rail') this.railTrail(muzzlePosition, tracerEnds[0]);

    // Muzzle smoke wisps.
    for (let index = 0; index < (weapon.id === 'shotgun' ? 6 : 2); index++) {
      this.smoke.spawn(muzzlePosition, this.scratchVelocity.set((Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6), {
        color: this.scratchColor.setRGB(0.55, 0.55, 0.58), lifetime: 0.8 + Math.random() * 0.4, startSize: 0.12, endSize: 0.55, alpha: 0.35, drag: 2,
      });
    }

    // Ejected casing (rail ejects a glowing cell instead).
    if (weapon.id !== 'rail' || Math.random() < 0.5) {
      const casingVelocity = ejectDirection.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.8, (Math.random() - 0.5) * 0.8));
      const casingSize = weapon.id === 'shotgun' ? new THREE.Vector3(0.05, 0.05, 0.11) : new THREE.Vector3(0.025, 0.025, 0.07);
      this.debris.spawn(ejectPosition, casingVelocity, { color: weapon.casingColor, size: casingSize, lifetime: 1.6, floor: floorHeight, bounciness: 0.35 });
    }
    this.addShake(weapon.id === 'shotgun' ? 0.2 : weapon.id === 'rail' ? 0.22 : 0.035);
  }

  onBotFire({ origin, target, weaponId, silent }) {
    if (silent) {
      // Extra shotgun pellets: tracer only.
      this.spawnTracer(origin, target, { color: new THREE.Color(4, 2.2, 1.0), speed: 300, trail: 4, thickness: 0.03 });
      return;
    }
    const flash = this.worldFlashes[this.worldFlashCursor];
    this.worldFlashCursor = (this.worldFlashCursor + 1) % this.worldFlashes.length;
    flash.mesh.position.copy(origin);
    flash.mesh.quaternion.copy(this.camera.quaternion);
    flash.mesh.rotateZ(Math.random() * Math.PI);
    flash.mesh.visible = true;
    flash.timer = 0.06;
    this.botMuzzleLight.position.copy(origin);
    this.botMuzzleLight.intensity = 14;
    if (weaponId === 'rail') {
      this.spawnTracer(origin, target, { color: new THREE.Color(0.8, 3, 5), speed: 900, trail: 120, thickness: 0.06 });
      this.railTrail(origin, target);
    } else {
      this.spawnTracer(origin, target, { color: new THREE.Color(4, 2.2, 1.0), speed: 300, trail: 6, thickness: 0.04 });
    }
    flash.mesh.scale.setScalar(weaponId === 'shotgun' || weaponId === 'deagle' ? 1.5 : weaponId === 'lmg' ? 1.2 : 1);
    // A thin wisp of muzzle smoke.
    if (Math.random() < 0.5) {
      this.smoke.spawn(origin, this.scratchVelocity.set((Math.random() - 0.5) * 0.5, 0.5, (Math.random() - 0.5) * 0.5), {
        color: this.scratchColor.setRGB(0.6, 0.6, 0.62), lifetime: 0.8, startSize: 0.2, endSize: 0.8, alpha: 0.3, drag: 2,
      });
    }
  }

  /** Kicked-up dirt when a soldier dashes. */
  dashDust(position, direction) {
    for (let index = 0; index < 8; index++) {
      const start = position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.15, (Math.random() - 0.5) * 0.8));
      this.smoke.spawn(start, this.scratchVelocity.set(-direction.x * 2 + (Math.random() - 0.5) * 2, 0.4 + Math.random() * 0.6, -direction.z * 2 + (Math.random() - 0.5) * 2), {
        color: this.scratchColor.setRGB(0.55, 0.5, 0.42), lifetime: 0.9 + Math.random() * 0.4, startSize: 0.4, endSize: 1.6, alpha: 0.4, drag: 2.5,
      });
    }
  }

  /** Artillery landing far outside the arena: a flash, a fireball and a towering smoke column. */
  distantBlast(position) {
    for (let index = 0; index < 26; index++) {
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
      this.fire.spawn(position, direction.multiplyScalar(6 + Math.random() * 10), {
        color: this.scratchColor.setRGB(6, 2.2, 0.5), lifetime: 0.6 + Math.random() * 0.5, startSize: 6 + Math.random() * 4, endSize: 1, drag: 2.5, gravity: -3,
      });
    }
    for (let index = 0; index < 22; index++) {
      const direction = new THREE.Vector3((Math.random() - 0.5) * 0.6, 1, (Math.random() - 0.5) * 0.6).normalize();
      this.smoke.spawn(position.clone().addScaledVector(direction, Math.random() * 3), direction.multiplyScalar(5 + Math.random() * 8), {
        color: this.scratchColor.setRGB(0.16, 0.15, 0.14), lifetime: 5 + Math.random() * 3, startSize: 7, endSize: 22, alpha: 0.55, drag: 0.8, gravity: -0.4,
      });
    }
  }

  spawnTracer(start, end, { color, speed, trail, thickness }) {
    const tracer = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
    tracer.start.copy(start);
    tracer.end.copy(end);
    tracer.direction.subVectors(end, start);
    tracer.length = tracer.direction.length();
    if (tracer.length < 0.5) return;
    tracer.direction.divideScalar(tracer.length);
    tracer.travelled = 0;
    tracer.speed = speed;
    tracer.trail = trail;
    tracer.active = true;
    tracer.mesh.material.color.copy(color);
    tracer.mesh.material.opacity = 0.95;
    tracer.mesh.scale.set(thickness, thickness, 0.01);
    tracer.mesh.visible = true;
  }

  railTrail(start, end) {
    if (!end) return;
    const direction = this.scratchVector.subVectors(end, start);
    const length = direction.length();
    const steps = Math.min(120, Math.floor(length / 0.6));
    for (let step = 0; step < steps; step++) {
      const point = start.clone().addScaledVector(direction, step / steps);
      const swirl = step * 0.7;
      point.x += Math.cos(swirl) * 0.08;
      point.y += Math.sin(swirl) * 0.08;
      this.sparks.spawn(point, this.scratchVelocity.set((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4), {
        color: this.scratchColor.setRGB(0.6, 2.4, 4.0), lifetime: 0.5 + Math.random() * 0.4, startSize: 0.12, endSize: 0.02, alpha: 0.9, drag: 1,
      });
    }
  }

  onImpact({ point, normal, hitBot, hitBarrel, hitVoxel, weapon, surfaceObject }) {
    if (hitBot) return; // bot:hurt spawns hit sparks
    const surfaceNormal = normal || this.scratchVector.set(0, 1, 0);
    // Sparks.
    const sparkCount = weapon.id === 'rail' ? 18 : 6;
    for (let index = 0; index < sparkCount; index++) {
      const velocity = this.scratchVelocity.copy(surfaceNormal).multiplyScalar(2 + Math.random() * 3)
        .add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4));
      this.sparks.spawn(point, velocity, {
        color: weapon.id === 'rail' ? this.scratchColor.setRGB(0.6, 2.5, 4) : this.scratchColor.setRGB(4, 2.6, 1.0),
        lifetime: 0.25 + Math.random() * 0.25, startSize: 0.07, endSize: 0.01, gravity: 14, drag: 1.5,
      });
    }
    // Dust puff tinted by the surface color.
    let surfaceColor = surfaceObject && surfaceObject.material && surfaceObject.material.color ? surfaceObject.material.color : null;
    if (hitVoxel && arguments[0].surfaceColor !== undefined) surfaceColor = new THREE.Color(arguments[0].surfaceColor);
    for (let index = 0; index < 3; index++) {
      const dustColor = surfaceColor ? this.scratchColor.copy(surfaceColor).lerp(new THREE.Color(0.6, 0.58, 0.55), 0.5) : this.scratchColor.setRGB(0.6, 0.58, 0.55);
      this.smoke.spawn(point.clone().addScaledVector(surfaceNormal, 0.05), this.scratchVelocity.copy(surfaceNormal).multiplyScalar(0.6 + Math.random()).add(new THREE.Vector3(0, 0.3, 0)), {
        color: dustColor, lifetime: 0.6 + Math.random() * 0.5, startSize: 0.15, endSize: 0.7, alpha: 0.5, drag: 3,
      });
    }
    if (!hitBarrel && normal && !weapon.isMelee) this.placeDecal(point, normal);
  }

  placeDecal(point, normal) {
    const decal = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;
    decal.position.copy(point).addScaledVector(normal, 0.012);
    decal.lookAt(this.scratchVector.copy(decal.position).add(normal));
    decal.rotateZ(Math.random() * Math.PI);
    decal.scale.setScalar(0.7 + Math.random() * 0.6);
    decal.visible = true;
  }

  hitSparks(point, isHeadshot) {
    const count = isHeadshot ? 16 : 9;
    for (let index = 0; index < count; index++) {
      this.sparks.spawn(point, this.scratchVelocity.set((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5), {
        color: isHeadshot ? this.scratchColor.setRGB(4, 2.4, 0.4) : this.scratchColor.setRGB(4, 0.7, 0.4),
        lifetime: 0.3 + Math.random() * 0.2, startSize: 0.09, endSize: 0.01, gravity: 10, drag: 1,
      });
    }
    this.smoke.spawn(point, this.scratchVelocity.set(0, 0.6, 0), {
      color: this.scratchColor.setRGB(0.9, 0.35, 0.3), lifetime: 0.45, startSize: 0.25, endSize: 0.9, alpha: 0.45, drag: 2,
    });
  }

  metalSparks(point) {
    for (let index = 0; index < 10; index++) {
      this.sparks.spawn(point, this.scratchVelocity.set((Math.random() - 0.5) * 6, Math.random() * 5, (Math.random() - 0.5) * 6), {
        color: this.scratchColor.setRGB(4, 3, 1.5), lifetime: 0.35, startSize: 0.06, endSize: 0.01, gravity: 16,
      });
    }
  }

  botShatter(bot, position) {
    const palette = [bot.teamConfig.bodyColor, bot.teamConfig.bodyColor, 0x2c3a66, 0xf0c090, bot.teamConfig.accentColor];
    for (let index = 0; index < 22; index++) {
      const start = position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 2.4, (Math.random() - 0.5) * 0.8));
      const velocity = new THREE.Vector3((Math.random() - 0.5) * 9, 3 + Math.random() * 6, (Math.random() - 0.5) * 9);
      this.debris.spawn(start, velocity, { color: palette[index % palette.length], size: 0.18 + Math.random() * 0.22, lifetime: 1.8 + Math.random(), floor: 0, bounciness: 0.4 });
    }
    for (let index = 0; index < 10; index++) {
      this.smoke.spawn(position.clone().setY(1 + Math.random() * 1.5), this.scratchVelocity.set((Math.random() - 0.5) * 2, 0.5 + Math.random(), (Math.random() - 0.5) * 2), {
        color: this.scratchColor.setRGB(0.75, 0.75, 0.78), lifetime: 1 + Math.random() * 0.5, startSize: 0.5, endSize: 1.8, alpha: 0.45, drag: 1.5,
      });
    }
  }

  spawnBeam(position, color) {
    const beamColor = new THREE.Color(color).multiplyScalar(3);
    for (let index = 0; index < 26; index++) {
      const angle = (index / 26) * Math.PI * 2;
      const start = new THREE.Vector3(position.x + Math.cos(angle) * 0.9, 0.1, position.z + Math.sin(angle) * 0.9);
      this.sparks.spawn(start, this.scratchVelocity.set(0, 3 + Math.random() * 3, 0), {
        color: beamColor, lifetime: 0.7, startSize: 0.14, endSize: 0.02, alpha: 1, drag: 0.5,
      });
    }
  }

  tagBurst(position, color) {
    const burstColor = new THREE.Color(color).multiplyScalar(3.5);
    for (let index = 0; index < 34; index++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 3;
      this.sparks.spawn(position, this.scratchVelocity.set(Math.cos(angle) * speed, 2 + Math.random() * 4, Math.sin(angle) * speed), {
        color: burstColor, lifetime: 0.6 + Math.random() * 0.4, startSize: 0.16, endSize: 0.02, gravity: 6, drag: 1,
      });
    }
    this.startShockwave(position.clone().setY(0.08), color, 3);
  }

  explosion(position, radius) {
    for (let index = 0; index < 70; index++) {
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize();
      this.fire.spawn(position, direction.multiplyScalar(3 + Math.random() * 7), {
        color: this.scratchColor.setRGB(5, 1.8 + Math.random() * 1.5, 0.4), lifetime: 0.5 + Math.random() * 0.5, startSize: 1.2 + Math.random(), endSize: 0.2, drag: 3.5, gravity: -2,
      });
    }
    for (let index = 0; index < 45; index++) {
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize();
      this.smoke.spawn(position.clone().addScaledVector(direction, Math.random()), direction.multiplyScalar(1.5 + Math.random() * 3), {
        color: this.scratchColor.setRGB(0.18, 0.17, 0.17), lifetime: 2 + Math.random() * 1.5, startSize: 1.4, endSize: 4.2, alpha: 0.65, drag: 1.4, gravity: -0.6,
      });
    }
    for (let index = 0; index < 60; index++) {
      this.sparks.spawn(position, this.scratchVelocity.set((Math.random() - 0.5) * 22, Math.random() * 16, (Math.random() - 0.5) * 22), {
        color: this.scratchColor.setRGB(5, 3, 1), lifetime: 0.6 + Math.random() * 0.6, startSize: 0.1, endSize: 0.01, gravity: 14, drag: 0.6,
      });
    }
    for (let index = 0; index < 12; index++) {
      this.debris.spawn(position, new THREE.Vector3((Math.random() - 0.5) * 14, 6 + Math.random() * 8, (Math.random() - 0.5) * 14), {
        color: index % 2 ? 0xd12d22 : 0x2a2a2a, size: 0.15 + Math.random() * 0.25, lifetime: 2.5, floor: 0, bounciness: 0.3,
      });
    }
    this.startShockwave(position.clone().setY(0.1), 0xffa040, radius * 1.4);
    this.explosionLight.position.copy(position).setY(position.y + 1.2);
    this.explosionLight.intensity = 320;

    const distanceToCamera = this.camera.position.distanceTo(position);
    this.addShake(Math.max(0, 1.1 - distanceToCamera / 30));
  }

  startShockwave(position, color, maxScale) {
    const shockwave = this.shockwaves.find((candidate) => !candidate.active) || this.shockwaves[0];
    shockwave.active = true;
    shockwave.age = 0;
    shockwave.maxScale = maxScale;
    shockwave.mesh.position.copy(position);
    shockwave.mesh.material.color.copy(new THREE.Color(color).multiplyScalar(3));
    shockwave.mesh.visible = true;
  }

  addEmitter({ kind, position, duration }) {
    this.emitters.push({ kind, position: position.clone(), timeLeft: duration, spawnAccumulator: 0 });
  }

  updateEmitters(deltaSeconds) {
    for (let index = this.emitters.length - 1; index >= 0; index--) {
      const emitter = this.emitters[index];
      emitter.timeLeft -= deltaSeconds;
      if (emitter.timeLeft <= 0) {
        this.emitters.splice(index, 1);
        if (emitter.kind === 'beacon') this.beaconLight.intensity = 0;
        continue;
      }
      if (emitter.kind === 'fire') {
        this.updateFireEmitter(emitter, deltaSeconds);
        continue;
      }
      if (emitter.kind !== 'beacon') continue;
      // Thick red signal smoke rising and drifting with the wind, plus a sputtering flare.
      emitter.spawnAccumulator += deltaSeconds;
      while (emitter.spawnAccumulator > 0.05) {
        emitter.spawnAccumulator -= 0.05;
        const base = emitter.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4));
        this.smoke.spawn(base, this.scratchVelocity.set(0.6 + Math.random() * 0.5, 3 + Math.random() * 2, (Math.random() - 0.5) * 0.6), {
          color: this.scratchColor.setRGB(0.85, 0.12 + Math.random() * 0.08, 0.08), lifetime: 4 + Math.random() * 2, startSize: 0.8, endSize: 5.5, alpha: 0.55, drag: 0.35,
        });
        this.sparks.spawn(base, this.scratchVelocity.set((Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2), {
          color: this.scratchColor.setRGB(5, 1.2, 0.6), lifetime: 0.4, startSize: 0.12, endSize: 0.02, gravity: 4,
        });
      }
      this.beaconLight.position.copy(emitter.position).setY(1);
      this.beaconLight.intensity = 22 + Math.random() * 18;
    }
  }

  /** Burning wreck: licking flames, embers and a thick black smoke column. */
  updateFireEmitter(emitter, deltaSeconds) {
    // Skip the work for fires far from the camera (they are hidden by fog anyway).
    if (emitter.position.distanceTo(this.camera.position) > 170) return;
    emitter.spawnAccumulator += deltaSeconds;
    while (emitter.spawnAccumulator > 0.045) {
      emitter.spawnAccumulator -= 0.045;
      const base = emitter.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.2, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 2.2));
      this.fire.spawn(base, this.scratchVelocity.set((Math.random() - 0.5) * 0.8, 2 + Math.random() * 2, (Math.random() - 0.5) * 0.8), {
        color: this.scratchColor.setRGB(5, 1.6 + Math.random() * 1.2, 0.35), lifetime: 0.5 + Math.random() * 0.4, startSize: 1.1 + Math.random() * 0.8, endSize: 0.2, drag: 1.5, gravity: -2,
      });
      if (Math.random() < 0.55) {
        this.smoke.spawn(base.clone().setY(base.y + 1.2), this.scratchVelocity.set(0.7 + Math.random() * 0.6, 2.4 + Math.random() * 1.5, (Math.random() - 0.5) * 0.6), {
          color: this.scratchColor.setRGB(0.09, 0.085, 0.08), lifetime: 5 + Math.random() * 2, startSize: 1.4, endSize: 8, alpha: 0.6, drag: 0.3,
        });
      }
      if (Math.random() < 0.25) {
        this.sparks.spawn(base, this.scratchVelocity.set((Math.random() - 0.5) * 2, 3 + Math.random() * 3, (Math.random() - 0.5) * 2), {
          color: this.scratchColor.setRGB(5, 2, 0.4), lifetime: 1 + Math.random(), startSize: 0.08, endSize: 0.01, gravity: -0.5, drag: 0.4,
        });
      }
    }
  }

  /** Small chips knocked off a voxel face. */
  voxelChips(position, normal, color) {
    if (this.debrisBudget <= 0) return;
    this.debrisBudget -= 2;
    for (let index = 0; index < 2; index++) {
      const velocity = normal.clone().multiplyScalar(2 + Math.random() * 2).add(new THREE.Vector3((Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3));
      this.debris.spawn(position.clone().addScaledVector(normal, 0.05), velocity, { color, size: 0.05 + Math.random() * 0.06, lifetime: 1.2, floor: 0, bounciness: 0.3 });
    }
  }

  /** A voxel cell breaks: chunky debris and a dust cloud; nearby bullet holes disappear with it. */
  voxelBreak({ position, color, cellSize = 1, collapsed }) {
    for (const decal of this.decals) {
      if (decal.visible && decal.position.distanceTo(position) < cellSize * 0.95) decal.visible = false;
    }
    if (this.debrisBudget <= 0) return;
    const pieces = collapsed ? 2 : 4;
    this.debrisBudget -= pieces;
    for (let index = 0; index < pieces; index++) {
      const start = position.clone().add(new THREE.Vector3((Math.random() - 0.5) * cellSize * 0.6, (Math.random() - 0.5) * cellSize * 0.6, (Math.random() - 0.5) * cellSize * 0.6));
      const velocity = new THREE.Vector3((Math.random() - 0.5) * 5, collapsed ? -1 : 2 + Math.random() * 4, (Math.random() - 0.5) * 5);
      this.debris.spawn(start, velocity, { color, size: cellSize * (0.22 + Math.random() * 0.22), lifetime: 2.2 + Math.random(), floor: 0, bounciness: 0.25 });
    }
    const dustColor = new THREE.Color(color).lerp(new THREE.Color(0.7, 0.68, 0.64), 0.6);
    this.smoke.spawn(position, this.scratchVelocity.set((Math.random() - 0.5), 0.5, (Math.random() - 0.5)), {
      color: dustColor, lifetime: 1.4, startSize: cellSize * 0.9, endSize: cellSize * 2.6, alpha: 0.5, drag: 2,
    });
  }

  teleportBurst(position) {
    const center = position.clone().setY(position.y + 1);
    for (let index = 0; index < 40; index++) {
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.sparks.spawn(center.clone().addScaledVector(direction, 0.4), direction.multiplyScalar(3 + Math.random() * 3), {
        color: this.scratchColor.setRGB(0.6, 2.5, 5), lifetime: 0.5, startSize: 0.16, endSize: 0.01, drag: 2,
      });
    }
    this.startShockwave(position.clone().setY(position.y + 0.1), 0x4fd0ff, 3);
  }

  poof(position, smokeColor, sparkleColor) {
    const center = position.clone().setY(position.y + 1);
    for (let index = 0; index < 16; index++) {
      this.smoke.spawn(center, this.scratchVelocity.set((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3), {
        color: new THREE.Color(smokeColor), lifetime: 1 + Math.random() * 0.5, startSize: 0.6, endSize: 2.2, alpha: 0.6, drag: 2.5,
      });
    }
    this.pickupSparkle(center, sparkleColor);
  }

  updateWeatherParticles() {
    if (!this.weatherType || this.weatherIntensity < 0.2) return;
    const cameraPosition = this.camera.position;
    if (this.weatherType === 'duststorm') {
      for (let index = 0; index < 6; index++) {
        const start = new THREE.Vector3(cameraPosition.x - 14 + Math.random() * 6, cameraPosition.y - 1 + Math.random() * 4, cameraPosition.z + (Math.random() - 0.5) * 24);
        this.smoke.spawn(start, this.scratchVelocity.set(14 + Math.random() * 6, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 3), {
          color: this.scratchColor.setRGB(0.75, 0.55, 0.32), lifetime: 1.6, startSize: 0.25 + Math.random() * 0.6, endSize: 1.2, alpha: 0.35 * this.weatherIntensity, drag: 0.2,
        });
      }
    } else if (this.weatherType === 'fog' && Math.random() < 0.4) {
      const angle = Math.random() * Math.PI * 2;
      const start = new THREE.Vector3(cameraPosition.x + Math.cos(angle) * 10, 0.6 + Math.random(), cameraPosition.z + Math.sin(angle) * 10);
      this.smoke.spawn(start, this.scratchVelocity.set(0.4, 0.05, 0.2), {
        color: this.scratchColor.setRGB(0.78, 0.8, 0.82), lifetime: 5, startSize: 4, endSize: 7, alpha: 0.18 * this.weatherIntensity, drag: 0.1,
      });
    }
  }

  supplyLanding(position) {
    for (let index = 0; index < 40; index++) {
      const angle = (index / 40) * Math.PI * 2;
      const speed = 4 + Math.random() * 4;
      this.smoke.spawn(position.clone().setY(0.4), this.scratchVelocity.set(Math.cos(angle) * speed, 0.6 + Math.random(), Math.sin(angle) * speed), {
        color: this.scratchColor.setRGB(0.55, 0.5, 0.42), lifetime: 1.6 + Math.random(), startSize: 0.8, endSize: 3, alpha: 0.55, drag: 2.5,
      });
    }
    for (let index = 0; index < 10; index++) {
      this.debris.spawn(position.clone().setY(0.3), new THREE.Vector3((Math.random() - 0.5) * 8, 3 + Math.random() * 4, (Math.random() - 0.5) * 8), {
        color: 0x5a4a32, size: 0.12 + Math.random() * 0.15, lifetime: 1.6, floor: 0, bounciness: 0.25,
      });
    }
    this.startShockwave(position.clone().setY(0.1), 0xffd28a, 6);
    this.addShake(Math.max(0, 0.8 - this.camera.position.distanceTo(position) / 40));
  }

  pickupSparkle(position, color) {
    const sparkleColor = new THREE.Color(color).multiplyScalar(3);
    for (let index = 0; index < 18; index++) {
      const angle = Math.random() * Math.PI * 2;
      this.sparks.spawn(position, this.scratchVelocity.set(Math.cos(angle) * 1.6, 1 + Math.random() * 2.5, Math.sin(angle) * 1.6), {
        color: sparkleColor, lifetime: 0.5 + Math.random() * 0.3, startSize: 0.12, endSize: 0.01, gravity: 3, drag: 1.5,
      });
    }
  }

  // ------------------------------------------------------------------ per frame
  update(deltaSeconds) {
    this.elapsed += deltaSeconds;
    this.debrisBudget = 60;
    this.updateEmitters(deltaSeconds);
    this.updateWeatherParticles();
    this.updateAmbientParticles(deltaSeconds);
    this.sparks.update(deltaSeconds);
    this.fire.update(deltaSeconds);
    this.smoke.update(deltaSeconds);
    this.debris.update(deltaSeconds);

    for (const tracer of this.tracers) {
      if (!tracer.active) continue;
      tracer.travelled += tracer.speed * deltaSeconds;
      const headDistance = Math.min(tracer.travelled, tracer.length);
      const tailDistance = Math.max(0, tracer.travelled - tracer.trail);
      if (tailDistance >= tracer.length) {
        tracer.active = false;
        tracer.mesh.visible = false;
        continue;
      }
      const head = this.scratchVector.copy(tracer.start).addScaledVector(tracer.direction, headDistance);
      tracer.mesh.position.copy(head);
      tracer.mesh.lookAt(head.clone().add(tracer.direction));
      tracer.mesh.scale.z = Math.max(0.01, headDistance - tailDistance);
      // lookAt points +Z toward the target; geometry extends along -Z, so the streak trails behind the head.
      tracer.mesh.material.opacity = Math.max(0, 0.95 - (tailDistance / tracer.length) * 0.3);
    }

    if (this.viewmodelFlashTimer > 0) {
      this.viewmodelFlashTimer -= deltaSeconds;
      if (this.viewmodelFlashTimer <= 0) this.viewmodelFlash.visible = false;
    }
    for (const flash of this.worldFlashes) {
      if (flash.timer <= 0) continue;
      flash.timer -= deltaSeconds;
      if (flash.timer <= 0) flash.mesh.visible = false;
    }

    const lightFade = Math.exp(-deltaSeconds * 30);
    this.muzzleLight.intensity *= lightFade;
    this.botMuzzleLight.intensity *= lightFade;
    this.explosionLight.intensity *= Math.exp(-deltaSeconds * 5);

    for (const shockwave of this.shockwaves) {
      if (!shockwave.active) continue;
      shockwave.age += deltaSeconds;
      const progress = shockwave.age / 0.55;
      if (progress >= 1) {
        shockwave.active = false;
        shockwave.mesh.visible = false;
        continue;
      }
      const scale = 0.5 + (1 - (1 - progress) * (1 - progress)) * shockwave.maxScale;
      shockwave.mesh.scale.set(scale, 1, scale);
      shockwave.mesh.material.opacity = 1 - progress;
    }

    this.shakeIntensity = Math.max(0, this.shakeIntensity - deltaSeconds * 2.4);
  }

  /**
   * Floating particles around the camera for atmosphere:
   *   'dust' — slow golden motes catching the sun.
   *   'ash'  — grey ash flakes drifting down plus the odd glowing ember (FRONTLINE).
   */
  setAmbientParticles(kind) {
    this.ambientParticles = kind;
  }

  updateAmbientParticles(deltaSeconds) {
    if (!this.ambientParticles) return;
    this.ambientAccumulator = (this.ambientAccumulator || 0) + deltaSeconds;
    const interval = this.ambientParticles === 'ash' ? 0.03 : 0.09;
    const cameraPosition = this.camera.position;
    while (this.ambientAccumulator > interval) {
      this.ambientAccumulator -= interval;
      const start = new THREE.Vector3(cameraPosition.x + (Math.random() - 0.5) * 30, cameraPosition.y + Math.random() * 9 - 1, cameraPosition.z + (Math.random() - 0.5) * 30);
      if (this.ambientParticles === 'ash') {
        this.smoke.spawn(start, this.scratchVelocity.set(0.8 + Math.random() * 0.6, -0.5 - Math.random() * 0.4, (Math.random() - 0.5) * 0.6), {
          color: this.scratchColor.setRGB(0.42, 0.4, 0.38), lifetime: 5, startSize: 0.07, endSize: 0.05, alpha: 0.7, drag: 0,
        });
        if (Math.random() < 0.12) {
          this.sparks.spawn(start, this.scratchVelocity.set(0.6 + Math.random(), 0.3 + Math.random() * 0.5, (Math.random() - 0.5)), {
            color: this.scratchColor.setRGB(4, 1.3, 0.3), lifetime: 3, startSize: 0.05, endSize: 0.02, drag: 0.1,
          });
        }
      } else {
        this.sparks.spawn(start, this.scratchVelocity.set((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.3), {
          color: this.scratchColor.setRGB(0.9, 0.78, 0.5), lifetime: 4, startSize: 0.035, endSize: 0.035, alpha: 0.5, drag: 0,
        });
      }
    }
  }

  /** Remove transient visuals (used when a new match starts). */
  clear() {
    this.emitters = [];
    this.beaconLight.intensity = 0;
    this.decals.forEach((decal) => { decal.visible = false; });
    this.tracers.forEach((tracer) => { tracer.active = false; tracer.mesh.visible = false; });
  }
}
