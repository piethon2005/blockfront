// =====================================================================
// Map builder — assembles BRICKYARD, POXELTOWN and FRONTLINE from structure
// primitives (most of them destructible voxel structures), then adds
// ground, instanced swaying grass, voxel flowers, drifting clouds and the
// distant horizon. Maps can be bigger than the classic 112 m arena
// (MAPS[].halfSize); the active size is written to WORLD.arenaHalfSize
// so spawns, roaming, loot and scenery scale with it.
// =====================================================================

import * as THREE from 'three';
import { MAPS, WORLD } from '../config.js';
import { StructureBuilder } from './outpost.js';
import { applyWindSway, createCanvasTexture, getPlainMaterial, getSurfaceMaterial, SURFACE_DEFINITIONS } from './materials.js';

function createSeededRandom(seed) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

let grassMaterial = null;
function getGrassMaterial() {
  if (grassMaterial) return grassMaterial;
  // Tapered blades on a transparent card, brighter toward the tips.
  const bladeTexture = createCanvasTexture(64, (context, size) => {
    context.clearRect(0, 0, size, size);
    for (let blade = 0; blade < 9; blade++) {
      const baseX = 4 + Math.random() * (size - 8);
      const tipX = baseX + (Math.random() - 0.5) * 14;
      const tipY = 2 + Math.random() * 18;
      const gradient = context.createLinearGradient(0, size, 0, tipY);
      gradient.addColorStop(0, 'rgb(110,110,110)');
      gradient.addColorStop(1, 'rgb(255,255,255)');
      context.fillStyle = gradient;
      context.beginPath();
      context.moveTo(baseX - 3, size);
      context.lineTo(tipX, tipY);
      context.lineTo(baseX + 3, size);
      context.closePath();
      context.fill();
    }
  });
  grassMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: bladeTexture, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, envMapIntensity: 0.3,
  });
  applyWindSway(grassMaterial, { strength: 0.22, power: 1.5, speed: 2.1 });
  return grassMaterial;
}

/** Three crossed quads with upward normals so blades light like the ground they sit on. */
function createGrassTuftGeometry() {
  const quads = [];
  for (let index = 0; index < 3; index++) {
    const quad = new THREE.PlaneGeometry(0.9, 0.7);
    quad.translate(0, 0.35, 0);
    quad.rotateY((index / 3) * Math.PI);
    quads.push(quad);
  }
  const positions = [];
  const uvs = [];
  const indices = [];
  let vertexOffset = 0;
  for (const quad of quads) {
    positions.push(...quad.attributes.position.array);
    uvs.push(...quad.attributes.uv.array);
    for (const index of quad.index.array) indices.push(index + vertexOffset);
    vertexOffset += quad.attributes.position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const normals = new Float32Array(positions.length);
  for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

export class MapBuilder {
  constructor({ scene, physics, voxelWorld }) {
    this.scene = scene;
    this.physics = physics;
    this.voxelWorld = voxelWorld;
    this.group = null;
    this.clouds = [];
    this.currentMapIndex = 0;
    this.fireSpots = [];
  }

  get currentMap() {
    return MAPS[this.currentMapIndex];
  }

  dispose() {
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
    });
    this.group = null;
    this.clouds = [];
  }

  /** Build a map by index with a graphics preset (controls grass density, scenery, clouds). */
  build(mapIndex, preset) {
    this.dispose();
    this.physics.reset();
    this.currentMapIndex = mapIndex;
    const mapConfig = MAPS[mapIndex];
    WORLD.arenaHalfSize = mapConfig.halfSize || WORLD.baseHalfSize;
    this.fireSpots = mapConfig.fires || [];

    this.group = new THREE.Group();
    this.group.name = `map-${mapConfig.id}`;
    this.scene.add(this.group);
    this.voxelWorld.reset(this.group);

    const builder = new StructureBuilder({ group: this.group, physics: this.physics, voxelWorld: this.voxelWorld, random: createSeededRandom(1234 + mapIndex * 77) });
    this.buildGround(mapConfig);

    if (mapConfig.id === 'brickyard') this.buildBrickyard(builder);
    else if (mapConfig.id === 'frontline') this.buildFrontline(builder);
    else this.buildPoxeltown(builder);

    builder.buildVerticalLayer(mapConfig.wallColor);
    builder.buildScenery(preset.outerTrees);
    builder.finalize();

    const scale = WORLD.arenaHalfSize / WORLD.baseHalfSize;
    this.scatterGrass(mapIndex, Math.round(preset.grassClusters * Math.min(2.2, scale * scale)));
    this.buildClouds(preset.clouds);
    return mapConfig;
  }

  // ------------------------------------------------------------------ ground
  buildGround(mapConfig) {
    const arenaSize = WORLD.arenaHalfSize * 2 + 16;
    const grassTile = SURFACE_DEFINITIONS.grass.unitsPerTile;
    const groundGeometry = new THREE.PlaneGeometry(arenaSize, arenaSize);
    const uvAttribute = groundGeometry.attributes.uv;
    for (let index = 0; index < uvAttribute.count; index++) {
      uvAttribute.setXY(index, (uvAttribute.getX(index) * arenaSize) / grassTile, (uvAttribute.getY(index) * arenaSize) / grassTile);
    }
    const ground = new THREE.Mesh(groundGeometry, getSurfaceMaterial('grass', mapConfig.groundColor));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.matrixAutoUpdate = false;
    ground.updateMatrix();
    this.group.add(ground);
    this.physics.addSolidMesh(ground);

    const outerSize = 1800;
    const outerGeometry = new THREE.PlaneGeometry(outerSize, outerSize);
    const outerUv = outerGeometry.attributes.uv;
    for (let index = 0; index < outerUv.count; index++) {
      outerUv.setXY(index, (outerUv.getX(index) * outerSize) / 12, (outerUv.getY(index) * outerSize) / 12);
    }
    const outerGround = new THREE.Mesh(outerGeometry, getSurfaceMaterial('grass', mapConfig.outerGroundColor));
    outerGround.rotation.x = -Math.PI / 2;
    outerGround.position.y = -0.03;
    outerGround.receiveShadow = true;
    outerGround.matrixAutoUpdate = false;
    outerGround.updateMatrix();
    this.group.add(outerGround);
  }

  // ------------------------------------------------------------------ BRICKYARD
  buildBrickyard(builder) {
    const flat = { collides: false, castShadow: false };
    // Arena floor paint.
    builder.block(0, 0, 30, 0.1, 30, 0x58c8f2, { ...flat, surface: 'concrete' });
    builder.block(0, 0, 6, 0.12, 30, 0xffe14a, { ...flat, surface: 'concrete' });

    // Big bright cover blocks — fully destructible voxels.
    builder.voxelBlock(-14, -18, 18, 9, 3, 0xe03030);
    builder.voxelBlock(16, -20, 12, 14, 4, 0xf2a31b);
    builder.voxelBlock(0, -30, 40, 10, 3, 0x2f78e6, { material: 'concrete' });
    builder.voxelBlock(-24, 6, 3, 8, 20, 0xf26a1b);
    builder.voxelBlock(26, 8, 3, 12, 18, 0xffd23f);
    builder.voxelBlock(0, 22, 14, 5, 3, 0x9b59d6);
    builder.voxelBlock(-8, 6, 4, 2, 4, 0xfff0b0);
    builder.voxelBlock(9, -4, 5, 3, 3, 0xfff0b0);
    builder.voxelBlock(-4, -8, 3, 1.5, 3, 0x3ec4c4);
    builder.voxelBlock(12, 12, 3, 2, 6, 0xe03030);

    builder.container(-16, 16, 7, 3, 3, 0x1f6f86);
    builder.container(18, 22, 3, 3, 7, 0x1f6f86);

    builder.house(-34, -6, 0xf4ecd8);
    builder.house(36, -4, 0xe8d2a6);

    const treeSpots = [[-30, 18], [-36, 30], [30, -30], [40, 16], [-20, -40], [8, 38], [34, 34], [-42, -30], [44, -18]];
    treeSpots.forEach(([x, z]) => builder.tree(x, z, 1 + builder.random() * 0.6));
    [[-6, 28], [12, -12], [-28, -18], [24, -8], [-12, -24]].forEach(([x, z]) => builder.bush(x, z, 3));
    builder.lampPost(-16, 0);
    builder.lampPost(16, 0);

    // Wooden fences: bullets pass straight through.
    builder.fence(-10, 40, 15, true);
    builder.fence(30, -42, 13.5, true);
    builder.fence(-46, 15, 12, false);
    builder.fence(46, 2, 9, false);
  }

  // ------------------------------------------------------------------ POXELTOWN
  buildPoxeltown(builder) {
    const flat = { collides: false, castShadow: false };
    builder.block(0, 0, 10, 0.1, 100, 0x55555e, { ...flat, surface: 'asphalt' });
    builder.block(0, 0, 100, 0.1, 10, 0x55555e, { ...flat, surface: 'asphalt' });
    for (let offset = -44; offset <= 44; offset += 8) {
      if (Math.abs(offset) < 6) continue;
      builder.block(offset, 0, 3, 0.12, 0.5, 0xfff0b0, flat);
      builder.block(0, offset, 0.5, 0.12, 3, 0xfff0b0, flat);
    }
    // Sidewalk curbs.
    const curbMaterial = getSurfaceMaterial('concrete', 0xc8c4bc);
    for (const side of [-1, 1]) {
      builder.decorBox(side * 5.3, 0.1, -28, 0.6, 0.2, 44, curbMaterial, { castShadow: false });
      builder.decorBox(side * 5.3, 0.1, 28, 0.6, 0.2, 44, curbMaterial, { castShadow: false });
      builder.decorBox(-28, 0.1, side * 5.3, 44, 0.2, 0.6, curbMaterial, { castShadow: false });
      builder.decorBox(28, 0.1, side * 5.3, 44, 0.2, 0.6, curbMaterial, { castShadow: false });
    }

    builder.house(-22, -22, 0xf4ecd8);
    builder.house(22, -22, 0xe8d2a6);
    builder.house(-26, 18, 0xd8e8f4);
    builder.house(26, 20, 0xf4d8d8);
    builder.house(-42, 0, 0xe8d2a6);
    builder.house(42, 2, 0xf4ecd8);

    builder.container(0, -8, 6, 3, 6, 0x1f6f86);
    builder.container(0, 12, 6, 3, 6, 0x1f6f86);
    builder.voxelBlock(-12, 0, 2, 3, 10, 0xb0a89a, { material: 'concrete' });
    builder.voxelBlock(12, 0, 2, 3, 10, 0xb0a89a, { material: 'concrete' });
    builder.voxelBlock(-8, -30, 14, 2, 2, 0xb0a89a, { material: 'concrete' });
    builder.voxelBlock(10, 32, 14, 2, 2, 0xb0a89a, { material: 'concrete' });
    builder.voxelBlock(-34, -16, 3, 5, 3, 0xe03030);
    builder.voxelBlock(34, -14, 3, 5, 3, 0x2f78e6);
    builder.fence(-10, -36, 12, true);
    builder.fence(15, 38, 12, true);
    builder.fence(-36, -9, 9, false);
    builder.fence(34, 30, 9, false);

    [[-14, -14], [16, -10], [-16, 12], [18, 14], [-34, 20], [36, 26], [-36, -34], [38, -32]]
      .forEach(([x, z]) => builder.tree(x, z, 1 + builder.random() * 0.5));
    [[-6, 16], [6, -18], [-20, -4], [22, 4]].forEach(([x, z]) => builder.bush(x, z, 3));
    for (const [x, z] of [[-7, -7], [7, 7], [-7, 20], [7, -20], [20, -7], [-20, 7]]) builder.lampPost(x, z);
  }

  // ------------------------------------------------------------------ FRONTLINE
  /**
   * A big war-torn valley (336 m across). Blue holds the south (+Z), red the north (-Z).
   *   • Base lines: bunkers and supply stacks near each spawn.
   *   • Trench lines: long sandbag walls with gaps and barbed wire facing no-man's land.
   *   • No-man's land: craters, mud and burning tank wrecks.
   *   • Centre: a shelled village around a church with a bell tower.
   */
  buildFrontline(builder) {
    const flat = { collides: false, castShadow: false };
    const half = WORLD.arenaHalfSize;
    const dirtRoad = 0x7a6648;
    // Supply road down the middle and a village street across it.
    builder.block(0, 0, 8, 0.08, half * 2, dirtRoad, { ...flat, surface: 'asphalt' });
    builder.block(0, 0, 160, 0.08, 7, dirtRoad, { ...flat, surface: 'asphalt' });

    // Trenches (sandbags + barbed wire facing the enemy).
    builder.trenchLine(64, 120, -1);
    builder.trenchLine(-64, 120, 1);
    // Second-line bunkers guarding each base.
    for (const side of [-1, 1]) {
      builder.bunker(-52, side * 112, -side);
      builder.bunker(52, side * 112, -side);
      builder.bunker(0, side * 96, -side);
      builder.sandbagWall(-26, side * 120, 12, true);
      builder.sandbagWall(26, side * 120, 12, true);
      builder.container(-84, side * 128, 7, 3, 3, side > 0 ? 0x2f5a3a : 0x5a3a2f);
      builder.container(84, side * 128, 7, 3, 3, side > 0 ? 0x2f5a3a : 0x5a3a2f);
      builder.crate(-36, side * 132, 3, 3, 0x7a6a3a);
      builder.crate(36, side * 132, 3, 3, 0x7a6a3a);
      builder.crate(-32, side * 134, 2, 2, 0x7a6a3a);
    }

    // Shelled village around the church.
    builder.church(-6, -2);
    const houseColors = [0xd8ccb0, 0xc8b890, 0xb8a888, 0xd0c4a8];
    [[-34, -26], [30, -24], [-36, 24], [34, 26], [-62, 4], [62, -4], [18, 40], [-18, -42]]
      .forEach(([x, z], index) => builder.ruinedHouse(x, z, houseColors[index % houseColors.length], index + 3));
    for (const [x, z] of [[-14, 14], [16, -14], [48, 12], [-48, -14], [6, 30], [-4, -30]]) builder.rubble(x, z, 0x7a5a4a);
    builder.fence(-24, 10, 12, true);
    builder.fence(24, -10, 12, true);
    builder.fence(44, 40, 10, false);
    builder.fence(-44, -40, 10, false);

    // No-man's land: burning wrecks, craters and mud.
    const wrecks = MAPS.find((map) => map.id === 'frontline').fires || [];
    wrecks.forEach(([x, z], index) => builder.tankWreck(x, z, index % 2 === 0));
    const random = createSeededRandom(4242);
    for (let index = 0; index < 34; index++) {
      const x = (random() * 2 - 1) * (half - 20);
      const z = (random() * 2 - 1) * 54;
      if (this.physics.isPointBlocked(x, z, 3)) continue;
      builder.crater(x, z, 1.8 + random() * 2.8);
    }
    for (let index = 0; index < 26; index++) {
      builder.mudPatch((random() * 2 - 1) * (half - 10), (random() * 2 - 1) * (half - 30), 4 + random() * 9);
    }

    // Tree lines on the flanks and shattered stumps in the open.
    for (let index = 0; index < 26; index++) {
      const side = index % 2 ? 1 : -1;
      const x = side * (110 + random() * (half - 118));
      const z = (random() * 2 - 1) * (half - 20);
      if (!this.physics.isPointBlocked(x, z, 2)) builder.tree(x, z, 1 + random() * 0.6);
    }
    for (let index = 0; index < 12; index++) {
      const x = (random() * 2 - 1) * 90;
      const z = (random() * 2 - 1) * 50;
      if (!this.physics.isPointBlocked(x, z, 1.5)) builder.block(x, z, 0.8, 1.2 + random() * 1.6, 0.8, 0x3a2a1c, { surface: 'bark' });
    }
    [[-92, 40], [92, -40], [-100, -60], [100, 60]].forEach(([x, z]) => builder.bush(x, z, 3));
    for (const [x, z] of [[-10, 8], [10, -8], [-40, 0], [40, 0]]) builder.lampPost(x, z);
  }

  // ------------------------------------------------------------------ grass & flowers
  scatterGrass(mapIndex, clusterCount) {
    if (clusterCount <= 0) return;
    const random = createSeededRandom(99 + mapIndex);
    const limit = WORLD.arenaHalfSize - 2;
    const mapId = MAPS[mapIndex].id;
    const isOnPavement = (x, z) => {
      if (mapId === 'brickyard') return Math.abs(x) < 15.5 && Math.abs(z) < 15.5;
      if (mapId === 'frontline') return Math.abs(x) < 5 || (Math.abs(z) < 4.5 && Math.abs(x) < 80);
      return (Math.abs(x) < 6 && Math.abs(z) < 51) || (Math.abs(z) < 6 && Math.abs(x) < 51);
    };

    const transforms = [];
    let attempts = 0;
    while (transforms.length < clusterCount && attempts < clusterCount * 4) {
      attempts++;
      const x = (random() * 2 - 1) * limit;
      const z = (random() * 2 - 1) * limit;
      if (isOnPavement(x, z) || this.physics.isPointBlocked(x, z, 0.4)) continue;
      transforms.push({ x, z, scale: 0.7 + random() * 0.8, rotation: random() * Math.PI, shade: random() });
    }

    const grassMesh = new THREE.InstancedMesh(createGrassTuftGeometry(), getGrassMaterial(), transforms.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const baseColor = new THREE.Color(this.currentMap.groundColor);
    const tint = new THREE.Color();
    transforms.forEach((transform, index) => {
      quaternion.setFromAxisAngle(yAxis, transform.rotation);
      matrix.compose(new THREE.Vector3(transform.x, 0, transform.z), quaternion, new THREE.Vector3(transform.scale, transform.scale, transform.scale));
      grassMesh.setMatrixAt(index, matrix);
      tint.copy(baseColor).offsetHSL((transform.shade - 0.5) * 0.04, 0.05, (transform.shade - 0.5) * 0.12);
      grassMesh.setColorAt(index, tint);
    });
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    grassMesh.receiveShadow = true;
    grassMesh.frustumCulled = false;
    this.group.add(grassMesh);

    // Voxel flowers sprinkled in the grass.
    const flowerCount = Math.floor(clusterCount / 12);
    const flowerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), getPlainMaterial(0xffffff, { roughness: 0.6 }), flowerCount);
    const flowerColors = [0xffffff, 0xffe14a, 0xff7ab8, 0xff5a4a, 0xa98bff];
    for (let index = 0; index < flowerCount; index++) {
      const transform = transforms[Math.floor(random() * transforms.length)] || { x: 0, z: 0 };
      matrix.makeTranslation(transform.x + (random() - 0.5), 0.45 + random() * 0.2, transform.z + (random() - 0.5));
      flowerMesh.setMatrixAt(index, matrix);
      flowerMesh.setColorAt(index, tint.set(flowerColors[index % flowerColors.length]));
    }
    flowerMesh.instanceMatrix.needsUpdate = true;
    if (flowerMesh.instanceColor) flowerMesh.instanceColor.needsUpdate = true;
    flowerMesh.frustumCulled = false;
    this.group.add(flowerMesh);
  }

  // ------------------------------------------------------------------ clouds
  buildClouds(cloudCount) {
    const random = createSeededRandom(555);
    const cloudMaterial = getPlainMaterial(0xffffff, { roughness: 1, emissive: 0xffffff, emissiveIntensity: 0.35, flatShading: true });
    for (let index = 0; index < cloudCount; index++) {
      const puffs = [];
      const puffCount = 4 + Math.floor(random() * 5);
      for (let puff = 0; puff < puffCount; puff++) {
        const width = 10 + random() * 16;
        const height = 4 + random() * 5;
        const depth = 8 + random() * 12;
        const puffGeometry = new THREE.BoxGeometry(width, height, depth);
        puffGeometry.translate((random() - 0.5) * 30, random() * 4, (random() - 0.5) * 18);
        puffs.push(puffGeometry);
      }
      const geometry = puffs.reduce((merged, next) => (merged ? mergeTwo(merged, next) : next), null);
      const cloud = new THREE.Mesh(geometry, cloudMaterial);
      const angle = random() * Math.PI * 2;
      const distance = 40 + random() * (WORLD.arenaHalfSize * 2.9);
      cloud.position.set(Math.cos(angle) * distance, 90 + random() * 50, Math.sin(angle) * distance);
      cloud.userData.driftSpeed = 1.5 + random() * 2.5;
      this.group.add(cloud);
      this.clouds.push(cloud);
    }
  }

  /** Per-frame world animation (cloud drift). */
  update(deltaSeconds) {
    for (const cloud of this.clouds) {
      cloud.position.x += cloud.userData.driftSpeed * deltaSeconds;
      if (cloud.position.x > 420) cloud.position.x = -420;
    }
  }
}

/** Minimal two-geometry merge for cloud puffs (keeps this module free of extra imports). */
function mergeTwo(first, second) {
  const merged = new THREE.BufferGeometry();
  const firstIndexed = first.index ? first.toNonIndexed() : first;
  const secondIndexed = second.index ? second.toNonIndexed() : second;
  for (const attributeName of ['position', 'normal']) {
    const a = firstIndexed.attributes[attributeName].array;
    const b = secondIndexed.attributes[attributeName].array;
    const combined = new Float32Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    merged.setAttribute(attributeName, new THREE.BufferAttribute(combined, 3));
  }
  return merged;
}
