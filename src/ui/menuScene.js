// =====================================================================
// Menu scene — the 3D armory behind the command hub.
// A dim locker room with crates, sandbags, a weapon rack and a hanging
// work lamp. The operator stands under a dusty spotlight holding the
// currently selected primary; the sidearm and blade hang on the rack.
// Floating dust motes, drifting smoke wisps, a flickering lamp and
// subtle mouse parallax keep it alive.
// =====================================================================

import * as THREE from 'three';
import { WEAPONS } from '../config.js';
import { buildWeaponModel } from '../entities/weapon.js';
import { applyWorldUVs, createCanvasTexture, getPlainMaterial, getSurfaceMaterial } from '../world/materials.js';

const CAMERA_HOME = new THREE.Vector3(0, 2.25, 9.6);
const CAMERA_LOADOUT = new THREE.Vector3(0.5, 2.7, 7.4);

export class MenuScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.isActive = true;
    this.pointer = { x: 0, y: 0 };
    this.loadoutFocus = 0;
    this.loadoutFocusTarget = 0;
    this.elapsed = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d0a);
    this.scene.fog = new THREE.Fog(0x0b0d0a, 10, 26);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    this.camera.position.copy(CAMERA_HOME);
    this.lookTarget = new THREE.Vector3(0, 1.95, 0);

    this.buildLighting();
    this.buildRoom();
    this.buildOperator();
    this.buildAtmosphere();

    window.addEventListener('pointermove', (event) => {
      this.pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    });
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.lastTime = performance.now();
    const loop = (time) => {
      requestAnimationFrame(loop);
      const deltaSeconds = Math.min(0.05, (time - this.lastTime) / 1000);
      this.lastTime = time;
      if (this.isActive) this.update(deltaSeconds);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setActive(active) {
    this.isActive = active;
  }

  /** 0 = command hub framing, 1 = close-up for the loadout room. */
  setLoadoutFocus(focused) {
    this.loadoutFocusTarget = focused ? 1 : 0;
  }

  // ------------------------------------------------------------------ lighting
  buildLighting() {
    this.scene.add(new THREE.HemisphereLight(0x6a7a8a, 0x1a1408, 0.35));

    // Hanging work lamp: warm spotlight straight down onto the operator.
    this.lampLight = new THREE.SpotLight(0xffd59a, 140, 18, Math.PI / 6.5, 0.55, 1.6);
    this.lampLight.position.set(0, 7.2, 0.6);
    this.lampLight.target.position.set(0, 0, 0.3);
    this.lampLight.castShadow = true;
    this.lampLight.shadow.mapSize.set(1024, 1024);
    this.lampLight.shadow.bias = -0.0005;
    this.scene.add(this.lampLight, this.lampLight.target);

    // Amber rim from behind-left and a cold steel-blue fill from the right.
    const rimLight = new THREE.DirectionalLight(0xffa040, 2.2);
    rimLight.position.set(-6, 5, -5);
    const fillLight = new THREE.DirectionalLight(0x5a7a9a, 0.9);
    fillLight.position.set(6, 3, 6);
    this.scene.add(rimLight, fillLight);

    // Red emergency light by the lockers.
    this.alarmLight = new THREE.PointLight(0xff3020, 6, 9, 2);
    this.alarmLight.position.set(-5.5, 4.6, -3.2);
    this.scene.add(this.alarmLight);
  }

  // ------------------------------------------------------------------ room
  addBox(width, height, depth, material, x, y, z, { castShadow = true, receiveShadow = true, unitsPerTile = 2 } = {}) {
    const geometry = applyWorldUVs(new THREE.BoxGeometry(width, height, depth), width, height, depth, unitsPerTile);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    this.scene.add(mesh);
    return mesh;
  }

  buildRoom() {
    // Floor plates and back wall.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), getSurfaceMaterial('concrete', 0x3a3d36));
    const floorUv = floor.geometry.attributes.uv;
    for (let index = 0; index < floorUv.count; index++) floorUv.setXY(index, floorUv.getX(index) * 10, floorUv.getY(index) * 10);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.addBox(40, 12, 0.5, getSurfaceMaterial('concrete', 0x2a2d28), 0, 6, -4.6, { castShadow: false, unitsPerTile: 4 });
    // Painted hazard stripe along the floor.
    const stripeTexture = createCanvasTexture(64, (context, size) => {
      for (let stripe = -2; stripe < 4; stripe++) {
        context.fillStyle = stripe % 2 ? '#141414' : '#c8901a';
        context.beginPath();
        context.moveTo(stripe * 22, size);
        context.lineTo(stripe * 22 + 22, size);
        context.lineTo(stripe * 22 + 22 + size, 0);
        context.lineTo(stripe * 22 + size, 0);
        context.fill();
      }
    });
    stripeTexture.wrapS = THREE.RepeatWrapping;
    stripeTexture.repeat.set(20, 1);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(40, 0.5), new THREE.MeshStandardMaterial({ map: stripeTexture, roughness: 0.8 }));
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.01, -3.4);
    stripe.receiveShadow = true;
    this.scene.add(stripe);

    // Locker bank along the back wall.
    const lockerMaterial = getSurfaceMaterial('metal', 0x3a4a56);
    const lockerTrim = getPlainMaterial(0x1c2228, { roughness: 0.45, metalness: 0.8 });
    const handleMaterial = getPlainMaterial(0xb0b4b8, { roughness: 0.3, metalness: 1 });
    for (let locker = -6; locker <= 6; locker++) {
      if (Math.abs(locker) <= 1) continue; // leave space behind the operator
      const x = locker * 1.25;
      this.addBox(1.18, 4.4, 0.9, lockerMaterial, x, 2.2, -3.9);
      this.addBox(1.2, 0.08, 0.92, lockerTrim, x, 4.4, -3.9, { castShadow: false });
      for (let vent = 0; vent < 4; vent++) this.addBox(0.7, 0.05, 0.02, lockerTrim, x, 3.9 - vent * 0.12, -3.44, { castShadow: false });
      this.addBox(0.06, 0.4, 0.06, handleMaterial, x + 0.42, 2.3, -3.42, { castShadow: false });
    }

    // Weapon rack behind the operator (sidearm + blade are mounted here).
    const rackWood = getSurfaceMaterial('planks', 0x5a3e24);
    this.addBox(3.4, 2.4, 0.2, getSurfaceMaterial('planks', 0x3a2a1a), 0, 3.3, -4.2, { castShadow: false });
    this.addBox(3.5, 0.12, 0.35, rackWood, 0, 2.05, -4.05);
    this.addBox(3.5, 0.12, 0.35, rackWood, 0, 4.5, -4.05);
    this.rackGroup = new THREE.Group();
    this.rackGroup.position.set(0, 3.3, -3.95);
    this.scene.add(this.rackGroup);

    // Crates and sandbags framing the scene.
    const crateMaterial = getSurfaceMaterial('crate', 0x7a5a32);
    this.addBox(1.6, 1.6, 1.6, crateMaterial, -4.4, 0.8, -1.6);
    this.addBox(1.2, 1.2, 1.2, crateMaterial, -4.6, 2.2, -1.7).rotation.y = 0.3;
    this.addBox(1.6, 1.0, 1.1, getSurfaceMaterial('metal', 0x3d4a33), 4.3, 0.5, -1.2).rotation.y = -0.25;
    this.addBox(1.4, 0.7, 1.0, getSurfaceMaterial('metal', 0x3d4a33), 4.4, 1.35, -1.25).rotation.y = -0.1;
    const sandbag = getSurfaceMaterial('plaster', 0x7a7050);
    for (let row = 0; row < 3; row++) {
      for (let bag = 0; bag < 4 - row; bag++) {
        const mesh = this.addBox(0.95, 0.38, 0.55, sandbag, 2.6 + bag * 0.92 + row * 0.46, 0.19 + row * 0.36, 1.6);
        mesh.rotation.y = (bag % 2 ? 0.06 : -0.05);
      }
    }
    // Ammo cans.
    const can = getPlainMaterial(0x4a5a32, { roughness: 0.6, metalness: 0.4 });
    this.addBox(0.6, 0.4, 0.3, can, -2.7, 0.2, 1.2).rotation.y = 0.5;
    this.addBox(0.6, 0.4, 0.3, can, -2.4, 0.6, 1.25).rotation.y = 0.2;

    // Hanging lamp housing and glowing bulb.
    const lampMetal = getPlainMaterial(0x23272b, { roughness: 0.5, metalness: 0.7 });
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.55, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c3a2c, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide }));
    shade.position.set(0, 7.35, 0.6);
    this.scene.add(shade);
    this.addBox(0.04, 2, 0.04, lampMetal, 0, 8.6, 0.6, { castShadow: false });
    this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 8), new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0xffd080, emissiveIntensity: 6 }));
    this.bulb.position.set(0, 7.15, 0.6);
    this.scene.add(this.bulb);

    // Emergency light housing.
    this.alarmBulb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.2), new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 4 }));
    this.alarmBulb.position.set(-5.5, 4.75, -3.35);
    this.scene.add(this.alarmBulb);
  }

  // ------------------------------------------------------------------ operator
  buildOperator() {
    const figure = new THREE.Group();
    const material = (color, roughness = 0.75, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const box = (parent, width, height, depth, mat, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const isFemale = this.gender === 'female';
    const faceTexture = createCanvasTexture(16, (context) => {
      context.fillStyle = '#d9a577'; context.fillRect(0, 0, 16, 16);
      context.fillStyle = '#b8845a'; context.fillRect(7, 8, 2, 2);
      context.fillStyle = '#1a1a14'; context.fillRect(2, 5, 12, 3);
      context.fillStyle = '#ffb21a'; context.fillRect(3, 6, 4, 1); context.fillRect(9, 6, 4, 1);
      if (isFemale) {
        context.fillStyle = '#3a2416'; context.fillRect(0, 2, 16, 2);         // fringe under the helmet
        context.fillStyle = '#a8483a'; context.fillRect(6, 11, 4, 1);         // lips
        context.fillStyle = '#3a4a2a'; context.fillRect(0, 14, 16, 2);        // neck gaiter
      } else {
        context.fillStyle = '#5a3a26'; context.fillRect(5, 11, 6, 1);
        context.fillStyle = '#3a4a2a'; context.fillRect(0, 13, 16, 3);        // face wrap
      }
    });
    faceTexture.magFilter = THREE.NearestFilter;
    const skin = material(0xd9a577, 0.7);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), [skin, skin, skin, skin, new THREE.MeshStandardMaterial({ map: faceTexture, roughness: 0.7 }), skin]);
    head.position.y = 2.95;
    head.castShadow = true;
    figure.add(head);

    const fatigues = getSurfaceMaterial('plaster', 0x4a5a32);
    const vest = getSurfaceMaterial('plaster', 0x2b3a2b);
    const boots = material(0x1a1a16, 0.6);
    const helmet = material(0x3a4a2a, 0.55, 0.15);
    box(figure, 0.5, 1.2, 0.5, fatigues, -0.28, 0.75, 0);
    box(figure, 0.5, 1.2, 0.5, fatigues, 0.28, 0.75, 0);
    box(figure, 0.54, 0.32, 0.8, boots, -0.28, 0.16, 0.12);
    box(figure, 0.54, 0.32, 0.8, boots, 0.28, 0.16, 0.12);
    const torsoWidth = isFemale ? 1.0 : 1.15;
    box(figure, torsoWidth, 1.35, 0.62, fatigues, 0, 1.95, 0);
    box(figure, torsoWidth + 0.09, 0.95, 0.72, vest, 0, 2.05, 0);
    if (isFemale) {
      // Braided ponytail hanging from under the helmet.
      const hair = material(0x3a2416, 0.85);
      box(figure, 0.42, 0.3, 0.2, hair, 0, 3.2, -0.5);
      box(figure, 0.2, 0.55, 0.18, hair, 0, 2.8, -0.56);
      box(figure, 0.16, 0.3, 0.16, hair, 0, 2.42, -0.58);
    }
    for (const pouchX of [-0.35, 0, 0.35]) box(figure, 0.28, 0.3, 0.14, getSurfaceMaterial('plaster', 0x3d4a2e), pouchX, 1.78, 0.42);
    box(figure, 1.24, 0.14, 0.75, boots, 0, 1.38, 0);
    box(figure, 1.0, 0.36, 1.0, helmet, 0, 3.5, 0);
    box(figure, 0.92, 0.1, 0.6, helmet, 0, 3.34, 0.7);
    box(figure, 0.5, 0.16, 0.12, getPlainMaterial(0x1a1d17, { roughness: 0.3, metalness: 0.6 }), 0, 3.55, 0.52);   // NVG mount
    box(figure, 0.36, 0.36, 0.3, vest, -0.66, 2.45, 0);                                                              // shoulder pads
    box(figure, 0.36, 0.36, 0.3, vest, 0.66, 2.45, 0);
    box(figure, 0.38, 0.14, 0.32, getPlainMaterial(0xffb21a, { roughness: 0.5 }), -0.66, 2.2, 0);                     // squad band

    const limb = (from, to, thickness, mat) => {
      const start = new THREE.Vector3(...from);
      const end = new THREE.Vector3(...to);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, start.distanceTo(end)), mat);
      mesh.position.copy(start).add(end).multiplyScalar(0.5);
      mesh.lookAt(end);
      mesh.castShadow = true;
      figure.add(mesh);
    };
    const shoulder = isFemale ? 0.62 : 0.7;
    const armThickness = isFemale ? 0.29 : 0.34;
    limb([shoulder, 2.35, 0], [0.42, 1.95, 0.4], armThickness, fatigues);
    limb([-shoulder, 2.35, 0], [0.18, 1.98, 1.1], armThickness, fatigues);
    box(figure, 0.3, 0.3, 0.3, material(0x2a2420), 0.42, 1.95, 0.42);
    box(figure, 0.3, 0.3, 0.3, material(0x2a2420), 0.18, 1.98, 1.12);

    this.weaponMount = new THREE.Group();
    this.weaponMount.position.set(0.32, 2.0, 0.55);
    figure.add(this.weaponMount);

    this.operator = figure;
    this.operator.position.set(0, 0, 0.4);
    this.scene.add(figure);
  }

  /** Update the held primary and the rack display for a loadout { melee, secondary, primary }. */
  /** Rebuild the operator for 'male' / 'female' and re-equip the current loadout. */
  setGender(gender) {
    if (gender === this.gender && this.operator) return;
    this.gender = gender;
    if (this.operator) this.scene.remove(this.operator);
    this.buildOperator();
    if (this.currentLoadout) this.setLoadout(this.currentLoadout);
  }

  setLoadout(loadout) {
    this.currentLoadout = { ...loadout };
    this.weaponMount.clear();
    const primary = buildWeaponModel(WEAPONS[loadout.primary].model);
    primary.group.scale.setScalar(1.75);
    primary.group.rotation.y = Math.PI;
    primary.group.traverse((object) => { if (object.isMesh) object.castShadow = true; });
    this.weaponMount.add(primary.group);

    this.rackGroup.clear();
    const secondary = buildWeaponModel(WEAPONS[loadout.secondary].model);
    secondary.group.scale.setScalar(2.4);
    secondary.group.rotation.set(0, Math.PI / 2, 0);
    secondary.group.position.set(-0.8, 0.2, 0.1);
    const melee = buildWeaponModel(WEAPONS[loadout.melee].model);
    melee.group.scale.setScalar(2.4);
    melee.group.rotation.set(0, Math.PI / 2, Math.PI / 2);
    melee.group.position.set(0.85, 0.1, 0.1);
    this.rackGroup.add(secondary.group, melee.group);
  }

  // ------------------------------------------------------------------ atmosphere
  buildAtmosphere() {
    // Dust motes: a slowly drifting point cloud that sparkles in the lamp beam.
    const moteCount = 520;
    const positions = new Float32Array(moteCount * 3);
    this.moteSpeeds = new Float32Array(moteCount);
    for (let index = 0; index < moteCount; index++) {
      positions[index * 3] = (Math.random() - 0.5) * 12;
      positions[index * 3 + 1] = Math.random() * 7;
      positions[index * 3 + 2] = (Math.random() - 0.5) * 8;
      this.moteSpeeds[index] = 0.05 + Math.random() * 0.15;
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const moteTexture = createCanvasTexture(32, (context, size) => {
      const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(255,240,210,1)');
      gradient.addColorStop(1, 'rgba(255,240,210,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    });
    this.motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({
      size: 0.05, map: moteTexture, color: 0xffe2b0, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.motes);

    // Volumetric-looking light cone under the lamp.
    const beamTexture = createCanvasTexture(64, (context, size) => {
      const gradient = context.createLinearGradient(0, 0, 0, size);
      gradient.addColorStop(0, 'rgba(255,220,160,0.55)');
      gradient.addColorStop(1, 'rgba(255,220,160,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    });
    this.beam = new THREE.Mesh(
      new THREE.ConeGeometry(2.6, 7, 32, 1, true),
      new THREE.MeshBasicMaterial({ map: beamTexture, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }),
    );
    this.beam.position.set(0, 3.6, 0.6);
    this.scene.add(this.beam);

    // Low smoke wisps drifting across the floor.
    const smokeTexture = createCanvasTexture(128, (context, size) => {
      for (let puff = 0; puff < 9; puff++) {
        const x = size * (0.25 + Math.random() * 0.5);
        const y = size * (0.3 + Math.random() * 0.4);
        const radius = size * (0.15 + Math.random() * 0.2);
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(200,200,190,0.35)');
        gradient.addColorStop(1, 'rgba(200,200,190,0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
      }
    });
    this.smokeWisps = [];
    for (let index = 0; index < 7; index++) {
      const wisp = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: smokeTexture, transparent: true, opacity: 0.22, depthWrite: false, color: 0x8a8a80 }));
      wisp.position.set((Math.random() - 0.5) * 14, 0.6 + Math.random() * 1.2, -2 + Math.random() * 4);
      wisp.userData.speed = 0.15 + Math.random() * 0.25;
      wisp.userData.spin = (Math.random() - 0.5) * 0.1;
      this.scene.add(wisp);
      this.smokeWisps.push(wisp);
    }
  }

  // ------------------------------------------------------------------ frame
  update(deltaSeconds) {
    this.elapsed += deltaSeconds;
    const time = this.elapsed;

    // Idle sway of the operator.
    this.operator.rotation.y = -0.38 + Math.sin(time * 0.5) * 0.12 + this.pointer.x * 0.15;
    this.operator.position.y = Math.sin(time * 1.6) * 0.02;

    // Lamp flicker and a gentle swing.
    const flicker = Math.random() < 0.015 ? 0.35 : 1;
    this.lampLight.intensity = 140 * flicker * (0.95 + Math.sin(time * 13) * 0.03);
    this.bulb.material.emissiveIntensity = 6 * flicker;
    this.beam.material.opacity = 0.32 * flicker;
    const swing = Math.sin(time * 0.7) * 0.04;
    this.beam.rotation.z = swing;
    this.lampLight.target.position.x = swing * 6;

    // Emergency light pulse.
    const alarm = Math.max(0, Math.sin(time * 2.4));
    this.alarmLight.intensity = 2 + alarm * 9;
    this.alarmBulb.material.emissiveIntensity = 1 + alarm * 5;

    // Dust motes drift upward and loop.
    const positions = this.motes.geometry.attributes.position;
    for (let index = 0; index < positions.count; index++) {
      let y = positions.getY(index) + this.moteSpeeds[index] * deltaSeconds;
      if (y > 7) y = 0;
      positions.setY(index, y);
      positions.setX(index, positions.getX(index) + Math.sin(time * 0.3 + index) * 0.002);
    }
    positions.needsUpdate = true;

    for (const wisp of this.smokeWisps) {
      wisp.position.x += wisp.userData.speed * deltaSeconds;
      wisp.rotation.z += wisp.userData.spin * deltaSeconds;
      if (wisp.position.x > 9) wisp.position.x = -9;
      wisp.lookAt(this.camera.position);
    }

    // Camera: blend between hub and loadout framing, plus mouse parallax.
    this.loadoutFocus += (this.loadoutFocusTarget - this.loadoutFocus) * (1 - Math.exp(-deltaSeconds * 4));
    const basePosition = CAMERA_HOME.clone().lerp(CAMERA_LOADOUT, this.loadoutFocus);
    this.camera.position.set(
      basePosition.x + this.pointer.x * 0.35 + Math.sin(time * 0.2) * 0.08,
      basePosition.y - this.pointer.y * 0.2 + Math.sin(time * 0.33) * 0.04,
      basePosition.z,
    );
    this.lookTarget.set(0.2 * this.loadoutFocus, 1.95 - this.loadoutFocus * 0.8, 0);
    this.camera.lookAt(this.lookTarget);
    this.renderer.render(this.scene, this.camera);
  }
}
