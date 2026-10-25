// =====================================================================
// Structure builder — the building blocks of every map:
// blocks, ramps, decks, outposts, houses, containers, crates, trees,
// bushes, lamp posts and far-away scenery.
//
// Destructible pieces (cover blocks, crates, containers, houses, fences)
// are VoxelStructures registered with the VoxelWorld. Indestructible
// structure (decks, ramps, boundary walls, tree trunks) are individual
// meshes that act as raycast targets and colliders. Purely decorative pieces (window frames, roof trims, tree
// canopies, mountains) are collected into buckets and merged into a handful
// of large meshes at the end, which keeps draw calls low on rich maps.
// =====================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OUTPOST_POSITIONS, WORLD, arenaScale, scalePoint } from '../config.js';
import {
  SURFACE_DEFINITIONS, applyWindSway, applyWorldUVs, getGlowMaterial, getPlainMaterial, getSurfaceMaterial,
} from './materials.js';

// Shared non-cached materials (they carry the wind shader patch).
let foliageMaterialsByColor = null;
function getFoliageMaterial(color) {
  if (!foliageMaterialsByColor) foliageMaterialsByColor = new Map();
  if (!foliageMaterialsByColor.has(color)) {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, envMapIntensity: 0.4 });
    applyWindSway(material, { strength: 0.0045, power: 2.0, speed: 1.3 });
    foliageMaterialsByColor.set(color, material);
  }
  return foliageMaterialsByColor.get(color);
}

export class StructureBuilder {
  constructor({ group, physics, random, voxelWorld }) {
    this.group = group;
    this.physics = physics;
    this.voxelWorld = voxelWorld;
    this.random = random;
    // bucketKey -> { material, geometries[], castShadow, receiveShadow }
    this.mergeBuckets = new Map();
  }

  // ------------------------------------------------------------------ primitives
  /**
   * A structural box. Registers a collider (unless collides=false) and a raycast
   * solid (unless solid=false). bottom = height of the box's base.
   */
  block(x, z, width, height, depth, color, {
    bottom = 0, surface = 'block', collides = true, solid = true, castShadow = true, receiveShadow = true, rotationY = 0, material = null,
  } = {}) {
    const unitsPerTile = (SURFACE_DEFINITIONS[surface] || SURFACE_DEFINITIONS.block).unitsPerTile;
    const geometry = applyWorldUVs(new THREE.BoxGeometry(width, height, depth), width, height, depth, unitsPerTile);
    const mesh = new THREE.Mesh(geometry, material || getSurfaceMaterial(surface, color));
    mesh.position.set(x, bottom + height / 2, z);
    mesh.rotation.y = rotationY;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    if (solid) this.physics.addSolidMesh(mesh);
    if (collides) this.physics.addBoxCollider({ x, z, width, depth, bottom, top: bottom + height });
    return mesh;
  }

  /**
   * Destructible voxel box centred on (x, z). Dimensions snap to the cell grid.
   * options: { bottom, material: 'block'|'brick'|'plaster'|'concrete'|'metal'|'wood', cellSize, isSolidAt, colorAt }
   */
  voxelBlock(x, z, width, height, depth, color, { bottom = 0, material = 'block', cellSize = null, isSolidAt = null, colorAt = null } = {}) {
    const isWhole = (value) => Math.abs(value - Math.round(value)) < 0.01;
    const size = cellSize || (isWhole(width) && isWhole(height) && isWhole(depth) ? 1 : 0.5);
    const cellsX = Math.max(1, Math.round(width / size));
    const cellsY = Math.max(1, Math.round(height / size));
    const cellsZ = Math.max(1, Math.round(depth / size));
    const structure = this.voxelWorld.addStructure({
      minX: x - (cellsX * size) / 2, minY: bottom, minZ: z - (cellsZ * size) / 2,
      cellsX, cellsY, cellsZ, cellSize: size, materialType: material, color, isSolidAt, colorAt,
    });
    this.physics.addVoxelCollider(structure);
    return structure;
  }

  /** Wooden fence (shoot-through): posts every 1.5 m, a rail at hip height, gap underneath. */
  fence(x, z, length, alongX) {
    const cellSize = 0.5;
    const cellsLong = Math.round(length / cellSize);
    return this.voxelBlock(x, z, alongX ? length : cellSize, 1.5, alongX ? cellSize : length, 0x9a7444, {
      material: 'wood',
      cellSize,
      isSolidAt: (i, j, k) => {
        const along = alongX ? i : k;
        const isPost = along % 3 === 0 || along === cellsLong - 1;
        return isPost || j === 1;
      },
    });
  }

  /** Decorative box merged into a shared mesh (no collision, not a raycast target). */
  decorBox(x, y, z, width, height, depth, material, { rotationY = 0, castShadow = true, unitsPerTile = 2 } = {}) {
    const geometry = applyWorldUVs(new THREE.BoxGeometry(width, height, depth), width, height, depth, unitsPerTile);
    if (rotationY) geometry.rotateY(rotationY);
    geometry.translate(x, y, z);
    this.addToBucket(geometry, material, castShadow);
  }

  addToBucket(geometry, material, castShadow = true, receiveShadow = true) {
    const bucketKey = `${material.uuid}|${castShadow}|${receiveShadow}`;
    if (!this.mergeBuckets.has(bucketKey)) this.mergeBuckets.set(bucketKey, { material, geometries: [], castShadow, receiveShadow });
    this.mergeBuckets.get(bucketKey).geometries.push(geometry);
  }

  /**
   * Wedge ramp. direction: 0 rises toward +X, 1 toward -X, 2 toward +Z, 3 toward -Z.
   */
  ramp(x, z, run, width, height, direction, color, bottom = 0) {
    const slopeX = [1, -1, 0, 0][direction];
    const slopeZ = [0, 0, 1, -1][direction];
    const profile = new THREE.Shape();
    profile.moveTo(0, 0);
    profile.lineTo(run, 0);
    profile.lineTo(run, height);
    profile.lineTo(0, 0);
    const geometry = new THREE.ExtrudeGeometry(profile, { depth: width, bevelEnabled: false });
    geometry.translate(-run / 2, 0, -width / 2);
    const uvAttribute = geometry.attributes.uv;
    const unitsPerTile = SURFACE_DEFINITIONS.concrete.unitsPerTile;
    for (let index = 0; index < uvAttribute.count; index++) {
      uvAttribute.setXY(index, uvAttribute.getX(index) / unitsPerTile, uvAttribute.getY(index) / unitsPerTile);
    }
    const mesh = new THREE.Mesh(geometry, getSurfaceMaterial('concrete', color, { side: THREE.DoubleSide }));
    mesh.rotation.y = [0, Math.PI, -Math.PI / 2, Math.PI / 2][direction];
    mesh.position.set(x, bottom, z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.physics.addSolidMesh(mesh);

    const alongX = slopeX !== 0;
    this.physics.addRampCollider({
      x, z, width: alongX ? run : width, depth: alongX ? width : run, bottom, top: bottom + height, slopeX, slopeZ, run,
    });

    // Yellow hazard edge strips along both sides of the ramp.
    const edgeMaterial = getPlainMaterial(0xffc21a, { roughness: 0.5 });
    const sideOffset = width / 2 - 0.08;
    const slopeLength = Math.hypot(run, height);
    const slopeAngle = Math.atan2(height, run);
    for (const side of [-1, 1]) {
      const edgeGeometry = new THREE.BoxGeometry(slopeLength, 0.08, 0.16);
      edgeGeometry.rotateZ(slopeAngle);
      edgeGeometry.translate(0, height / 2 + 0.04, side * sideOffset);
      edgeGeometry.rotateY(mesh.rotation.y);
      edgeGeometry.translate(x, bottom, z);
      this.addToBucket(edgeGeometry, edgeMaterial, false);
    }
    return mesh;
  }

  /** Raised platform on four posts with a plank floor. */
  deck(x, z, width, depth, height, color) {
    this.block(x, z, width, 0.6, depth, color, { bottom: height - 0.6, surface: 'planks' });
    for (const [cornerX, cornerZ] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      this.block(x + cornerX * (width / 2 - 0.6), z + cornerZ * (depth / 2 - 0.6), 0.9, height - 0.6, 0.9, 0x7a5a3a, { surface: 'planks' });
    }
    // Trim around the floor edge.
    const trimMaterial = getSurfaceMaterial('planks', 0x6a4a2a);
    this.decorBox(x, height - 0.65, z + depth / 2, width + 0.2, 0.3, 0.2, trimMaterial);
    this.decorBox(x, height - 0.65, z - depth / 2, width + 0.2, 0.3, 0.2, trimMaterial);
    this.decorBox(x + width / 2, height - 0.65, z, 0.2, 0.3, depth, trimMaterial);
    this.decorBox(x - width / 2, height - 0.65, z, 0.2, 0.3, depth, trimMaterial);
  }

  /** Two-storey sniper outpost with ramps, a railing, crates and a lamp. Mirrored toward the arena centre. */
  outpost(centerX, centerZ) {
    const signX = Math.sign(centerX) || 1;
    const signZ = Math.sign(centerZ) || 1;
    const localX = (offset) => centerX + signX * offset;
    const localZ = (offset) => centerZ + signZ * offset;

    this.deck(centerX, centerZ, 16, 16, 4, 0xd9a441);
    this.deck(localX(4), localZ(4), 8, 8, 8, 0xe05a3a);
    this.ramp(localX(-14), centerZ, 12, 5, 4, signX > 0 ? 0 : 1, 0xc9c9d6);
    this.ramp(localX(4), localZ(-4), 8, 4, 4, signZ > 0 ? 2 : 3, 0xc9c9d6, 4);
    this.block(localX(-3), localZ(6), 4, 1.8, 0.8, 0x8a5a2e, { bottom: 4, surface: 'planks' });
    this.crate(localX(0), localZ(15), 3, 1.5, 0xb98a4a);
    this.crate(localX(0), localZ(11.5), 3, 3, 0xb98a4a);
    this.lampPost(localX(-7), localZ(-7), 4);
    this.lampPost(localX(7.5), localZ(7.5), 8);
  }

  /** Destructible, shoot-through wooden crate (3 cells wide). */
  crate(x, z, size, height, color, bottom = 0) {
    const cellSize = size / 3;
    return this.voxelBlock(x, z, size, Math.max(cellSize, Math.round(height / cellSize) * cellSize), size, color, { material: 'wood', cellSize, bottom });
  }

  lampPost(x, z, baseHeight = 0) {
    const poleMaterial = getPlainMaterial(0x2a2d33, { roughness: 0.4, metalness: 0.8 });
    this.decorBox(x, baseHeight + 1.6, z, 0.22, 3.2, 0.22, poleMaterial);
    this.decorBox(x, baseHeight + 3.25, z, 0.7, 0.18, 0.7, poleMaterial);
    this.decorBox(x, baseHeight + 3.05, z, 0.45, 0.25, 0.45, getGlowMaterial(0xfff0b0, 4), { castShadow: false });
  }

  /**
   * Destructible voxel house: hollow brick/plaster shell with a walk-in doorway, open windows
   * (instant sniper nests), a roof slab and an upper roof tier. Blast your own openings anywhere.
   */
  house(x, z, wallColor) {
    const wallMaterial = this.random() > 0.5 ? 'brick' : 'plaster';
    this.decorBox(x, 0.04, z, 9.8, 0.08, 8.8, getSurfaceMaterial('concrete', 0x9a9a9a), { unitsPerTile: 4, castShadow: false });
    const frontK = z > 0 ? 0 : 7;          // doorway faces the arena centre
    const roofColor = 0x7a4a2a;
    this.voxelBlock(x, z, 9, 8, 8, wallColor, {
      material: wallMaterial,
      cellSize: 1,
      isSolidAt: (i, j, k) => {
        if (j <= 5) {
          const isShell = i === 0 || i === 8 || k === 0 || k === 7;
          if (!isShell) return false;
          if (k === frontK && i >= 3 && i <= 5 && j <= 2) return false;                       // doorway
          if (k === frontK && j === 3 && (i === 1 || i === 2 || i === 6 || i === 7)) return false; // front windows
          if ((i === 0 || i === 8) && j === 3 && (k === 3 || k === 4)) return false;           // side windows
          return true;
        }
        if (j === 6) return true;                                                                // roof slab
        return i >= 2 && i <= 6 && k >= 2 && k <= 5;                                            // upper tier
      },
      colorAt: (i, j) => (j >= 6 ? roofColor : null),
    });
  }

  /** Destructible shipping container (corrugated metal voxels, the toughest material). */
  container(x, z, width, height, depth, color) {
    return this.voxelBlock(x, z, width, height, depth, color, { material: 'metal', cellSize: 1 });
  }

  /** Pine tree: solid trunk (collides) + layered swaying canopy (merged). */
  tree(x, z, scale = 1, { collides = true } = {}) {
    const trunkWidth = 1.1 * scale;
    const trunkHeight = 2.5 * scale;
    if (collides) {
      this.block(x, z, trunkWidth, trunkHeight, trunkWidth, 0x6b4423, { surface: 'bark' });
    } else {
      this.decorBox(x, trunkHeight / 2, z, trunkWidth, trunkHeight, trunkWidth, getSurfaceMaterial('bark', 0x6b4423), { castShadow: false });
    }
    const spin = this.random() * Math.PI;
    for (let layer = 0; layer < 4; layer++) {
      const radius = (3.2 - layer * 0.7) * scale;
      const height = 2.6 * scale;
      const geometry = new THREE.ConeGeometry(radius, height, 7);
      geometry.rotateY(spin + layer * 0.4);
      geometry.translate(x, (3 + layer * 1.7) * scale, z);
      const shade = layer % 2 ? 0x1fa83a : 0x2fc24a;
      this.addToBucket(geometry, getFoliageMaterial(shade), collides);
    }
  }

  /** Leafy bush: a solid cube with a few lumpy cubes on top. */
  bush(x, z, size = 3) {
    this.block(x, z, size, size, size, 0x2fa83a, { surface: 'grass' });
    const leafMaterial = getFoliageMaterial(0x3cbd48);
    for (let lump = 0; lump < 3; lump++) {
      const lumpSize = size * (0.35 + this.random() * 0.2);
      const geometry = new THREE.BoxGeometry(lumpSize, lumpSize, lumpSize);
      geometry.rotateY(this.random() * Math.PI);
      geometry.translate(x + (this.random() - 0.5) * size * 0.5, size + lumpSize * 0.3, z + (this.random() - 0.5) * size * 0.5);
      this.addToBucket(geometry, leafMaterial, true);
    }
  }

  /** Arena boundary wall with a concrete cap. */
  boundaryWall(x, z, width, depth, color) {
    this.block(x, z, width, 10, depth, color, { surface: 'concrete' });
    this.decorBox(x, 10.2, z, width + 0.4, 0.4, depth + 0.4, getSurfaceMaterial('concrete', 0xd8d8d8), { unitsPerTile: 4 });
  }

  /** Low-poly mountain on the horizon (no shadows; they are outside the shadow frustum). */
  mountain(x, z, radius, height, color, withSnow) {
    const geometry = new THREE.ConeGeometry(radius, height, 5 + Math.floor(this.random() * 3));
    geometry.rotateY(this.random() * Math.PI);
    geometry.translate(x, height / 2 - 2, z);
    this.addToBucket(geometry, getPlainMaterial(color, { roughness: 1, flatShading: true }), false, false);
    if (withSnow) {
      const capHeight = height * 0.28;
      const capGeometry = new THREE.ConeGeometry(radius * 0.28 + 0.5, capHeight, 5);
      capGeometry.rotateY(this.random() * Math.PI);
      capGeometry.translate(x, height - capHeight / 2 - 1.6, z);
      this.addToBucket(capGeometry, getPlainMaterial(0xf4f8ff, { roughness: 0.9, flatShading: true }), false, false);
    }
  }

  // ------------------------------------------------------------------ battlefield pieces (FRONTLINE)
  /** Waist-high sandbag wall (crouch to hide, stand to shoot over). */
  sandbagWall(x, z, length, alongX, { height = 1.5 } = {}) {
    const cellSize = 0.5;
    const cellsLong = Math.round(length / cellSize);
    return this.voxelBlock(x, z, alongX ? length : 1, height, alongX ? 1 : length, 0xb59a6a, {
      material: 'sandbag',
      cellSize,
      // Staggered courses with slightly varied bag colours.
      colorAt: (i, j, k) => {
        const along = alongX ? i : k;
        const shade = ((along + j * 3) * 2654435761) % 7;
        return [0xb59a6a, 0xa88d5e, 0xbfa678, 0x9e855a, 0xb09363, 0xc2aa7c, 0xa38a5f][shade];
      },
      isSolidAt: (i, j, k) => {
        const along = alongX ? i : k;
        // Firing notches along the top course.
        return !(j === Math.round(height / cellSize) - 1 && along % 6 === 3 && along > 0 && along < cellsLong - 1);
      },
    });
  }

  /** A trench line: segments of sandbag wall with gaps to run through, plus barbed wire in front. */
  trenchLine(z, halfWidth, facing) {
    const segment = 16;
    const gap = 5;
    for (let start = -halfWidth; start + segment <= halfWidth; start += segment + gap) {
      this.sandbagWall(start + segment / 2, z, segment, true);
      // Duckboards behind the wall.
      this.decorBox(start + segment / 2, 0.06, z - facing * 1.4, segment, 0.1, 1.6, getSurfaceMaterial('planks', 0x6a5236), { castShadow: false });
      this.barbedWire(start + segment / 2, z + facing * 7, segment - 2);
    }
  }

  /** Barbed-wire entanglement (decor only: posts and sagging coils). */
  barbedWire(x, z, length) {
    const postMaterial = getSurfaceMaterial('planks', 0x4a3a28);
    const wireMaterial = getPlainMaterial(0x6e6a62, { roughness: 0.35, metalness: 0.9 });
    const posts = Math.max(2, Math.round(length / 3));
    for (let post = 0; post <= posts; post++) {
      const postX = x - length / 2 + (post / posts) * length;
      const lean = (this.random() - 0.5) * 0.3;
      const geometry = new THREE.BoxGeometry(0.12, 1.3, 0.12).rotateZ(lean).translate(postX, 0.6, z);
      this.addToBucket(geometry, postMaterial, true);
      if (post === posts) continue;
      for (const [height, sag] of [[0.35, 0.08], [0.75, 0.12], [1.1, 0.06]]) {
        const span = length / posts;
        const wire = new THREE.BoxGeometry(span, 0.03, 0.03).rotateY((this.random() - 0.5) * 0.25).translate(postX + span / 2, height - sag, z + (this.random() - 0.5) * 0.3);
        this.addToBucket(wire, wireMaterial, false);
      }
      // Coiled loops between posts.
      for (let loop = 0; loop < 3; loop++) {
        const ring = new THREE.TorusGeometry(0.32, 0.02, 4, 10).rotateY(Math.PI / 2 + (this.random() - 0.5) * 0.6)
          .translate(postX + (loop + 0.5) * (length / posts / 3), 0.4 + this.random() * 0.15, z);
        this.addToBucket(ring, wireMaterial, false);
      }
    }
  }

  /** Concrete bunker with firing slits and a rear doorway. facing: +1 = slits look toward +Z. */
  bunker(x, z, facing) {
    const frontK = facing > 0 ? 7 : 0;
    const backK = facing > 0 ? 0 : 7;
    this.decorBox(x, 0.05, z, 11, 0.1, 9, getSurfaceMaterial('concrete', 0x7a786e), { castShadow: false, unitsPerTile: 4 });
    return this.voxelBlock(x, z, 10, 4, 8, 0x8e8b80, {
      material: 'concrete',
      cellSize: 1,
      isSolidAt: (i, j, k) => {
        if (j === 3) return true;                                                      // thick roof
        const isShell = i === 0 || i === 9 || k === 0 || k === 7;
        if (!isShell) return false;
        if (k === frontK && j === 2 && i >= 2 && i <= 7) return false;                 // wide firing slit
        if ((i === 0 || i === 9) && j === 2 && k >= 3 && k <= 4) return false;         // side slits
        if (k === backK && i >= 4 && i <= 5 && j <= 1) return false;                   // doorway
        return true;
      },
      colorAt: (i, j) => (j === 3 ? 0x6e6c62 : null),
    });
  }

  /** Burnt-out tank: one destructible metal voxel structure (hull, turret, barrel). */
  tankWreck(x, z, alongX) {
    const cellSize = 0.5;
    const long = 16;   // 8 m
    const wide = 8;    // 4 m
    const hullColor = 0x3d4232;
    this.decorBox(x, 0.03, z, alongX ? 10 : 6, 0.05, alongX ? 6 : 10, getPlainMaterial(0x1d1a16, { roughness: 1 }), { castShadow: false }); // scorch mark
    this.tankBarrel(x, z, alongX);
    return this.voxelBlock(x, z, (alongX ? long : wide) * cellSize, 3.5, (alongX ? wide : long) * cellSize, hullColor, {
      material: 'metal',
      cellSize,
      isSolidAt: (i, j, k) => {
        const a = alongX ? i : k;     // along the hull
        const b = alongX ? k : i;     // across the hull
        if (j <= 1) return (b <= 1 || b >= wide - 2) || (j === 1 && a > 0 && a < long - 1);   // tracks + lower hull
        if (j <= 3) return a > 0 && a < long - 1 && !(j === 3 && (a === 1 || a === long - 2));
        if (j <= 5) return a >= 5 && a <= 10 && b >= 2 && b <= wide - 3;                       // turret
        if (j === 6) return a >= 6 && a <= 9 && b >= 3 && b <= wide - 4 && !(a === 7);          // hatch ring
        return false;
      },
      colorAt: (i, j, k) => {
        const a = alongX ? i : k;
        const b = alongX ? k : i;
        if (j <= 1 && (b <= 1 || b >= wide - 2)) return 0x1e1f1b;                             // tracks
        if ((a + b + j) % 5 === 0) return 0x24261f;                                           // soot streaks
        return a % 7 === 2 && j === 3 ? 0x6a3a22 : null;                                      // rust
      },
    });
  }

  /** The gun barrel sticks out of the turret (decor, so it never floats on its own). */
  tankBarrel(x, z, alongX) {
    const material = getPlainMaterial(0x2c2f26, { roughness: 0.6, metalness: 0.6 });
    const geometry = new THREE.BoxGeometry(alongX ? 4.2 : 0.35, 0.35, alongX ? 0.35 : 4.2);
    geometry.rotateX(alongX ? 0 : -0.12).rotateZ(alongX ? 0.12 : 0);
    geometry.translate(x + (alongX ? 3.6 : 0), 2.65, z + (alongX ? 0 : 3.6));
    this.addToBucket(geometry, material, true);
  }

  /** A house that has already taken shell hits: holes, missing roof sections, rubble at its feet. */
  ruinedHouse(x, z, wallColor, seed) {
    let state = seed * 9301 + 49297;
    const random = () => ((state = (state * 9301 + 49297) % 233280) / 233280);
    const holes = Array.from({ length: 4 }, () => [Math.floor(random() * 9), Math.floor(random() * 6), Math.floor(random() * 8), 1 + Math.floor(random() * 2)]);
    const roofGone = random() > 0.4;
    const frontK = z > 0 ? 0 : 7;
    this.decorBox(x, 0.04, z, 9.8, 0.08, 8.8, getSurfaceMaterial('concrete', 0x8a8a84), { unitsPerTile: 4, castShadow: false });
    this.voxelBlock(x, z, 9, 7, 8, wallColor, {
      material: random() > 0.5 ? 'brick' : 'plaster',
      cellSize: 1,
      isSolidAt: (i, j, k) => {
        for (const [holeI, holeJ, holeK, radius] of holes) {
          if (Math.abs(i - holeI) + Math.abs(j - holeJ) + Math.abs(k - holeK) <= radius && j >= 1) return false;
        }
        if (j <= 5) {
          const isShell = i === 0 || i === 8 || k === 0 || k === 7;
          if (!isShell) return false;
          if (k === frontK && i >= 3 && i <= 5 && j <= 2) return false;
          if (k === frontK && j === 3 && (i === 1 || i === 2 || i === 6 || i === 7)) return false;
          if ((i === 0 || i === 8) && j === 3 && (k === 3 || k === 4)) return false;
          return true;
        }
        if (roofGone) return (i + k) % 3 === 0 && i > 0 && i < 8 && k > 0 && k < 7 ? false : i <= 3;   // half the roof collapsed
        return true;
      },
      colorAt: (i, j) => (j >= 6 ? 0x5a3a24 : (i + j) % 6 === 0 ? 0x3a3530 : null),   // scorched patches
    });
    this.rubble(x + (random() - 0.5) * 8, z + (z > 0 ? -6 : 6), 0x7a5a4a);
  }

  /** Low heap of broken masonry. */
  rubble(x, z, color) {
    return this.voxelBlock(x, z, 3, 1, 2, color, {
      material: 'brick',
      cellSize: 0.5,
      isSolidAt: (i, j, k) => j === 0 || (j === 1 && (i + k) % 2 === 0 && i > 0 && i < 5),
    });
  }

  /** Village church with a bell tower: a big destructible landmark in the middle of the battlefield. */
  church(x, z) {
    this.decorBox(x, 0.05, z, 20, 0.1, 13, getSurfaceMaterial('concrete', 0x8a867a), { castShadow: false, unitsPerTile: 4 });
    // Nave: long hollow hall with tall windows and doors at both ends.
    this.voxelBlock(x, z, 16, 8, 10, 0xd8ccb0, {
      material: 'plaster',
      cellSize: 1,
      isSolidAt: (i, j, k) => {
        if (j === 7) return i % 4 !== 1;                                                 // shell-holed roof
        const isShell = i === 0 || i === 15 || k === 0 || k === 9;
        if (!isShell) return false;
        if ((i === 0 || i === 15) && k >= 4 && k <= 5 && j <= 3) return false;           // doors
        if ((k === 0 || k === 9) && i % 3 === 1 && j >= 3 && j <= 5) return false;        // tall windows
        return true;
      },
      colorAt: (i, j) => (j === 7 ? 0x6a4030 : (i + j) % 7 === 0 ? 0xb8ac90 : null),
    });
    // Bell tower: tall hollow shaft with belfry openings.
    this.voxelBlock(x + 10, z, 4, 16, 4, 0xcfc2a4, {
      material: 'brick',
      cellSize: 1,
      isSolidAt: (i, j, k) => {
        const isShell = i === 0 || i === 3 || k === 0 || k === 3;
        if (j === 15) return true;
        if (!isShell) return false;
        if (j >= 12 && j <= 13 && (i === 1 || i === 2 || k === 1 || k === 2)) return false; // belfry arches
        if (i === 0 && (k === 1 || k === 2) && j <= 2) return false;                        // doorway
        return true;
      },
      colorAt: (i, j) => (j === 15 ? 0x5a3424 : null),
    });
    this.decorBox(x + 10, 16.6, z, 0.25, 1.4, 0.25, getPlainMaterial(0x2a2a2a, { metalness: 0.8, roughness: 0.4 }));   // cross
    this.decorBox(x + 10, 16.9, z, 0.9, 0.22, 0.25, getPlainMaterial(0x2a2a2a, { metalness: 0.8, roughness: 0.4 }));
  }

  /** Shell crater: dark scorched disc with a raised earth rim (decor). */
  crater(x, z, radius) {
    const scorch = new THREE.CylinderGeometry(radius, radius * 1.05, 0.06, 18).translate(x, 0.03, z);
    this.addToBucket(scorch, getPlainMaterial(0x2e261c, { roughness: 1 }), false);
    const rim = new THREE.TorusGeometry(radius * 1.05, radius * 0.18, 4, 18).rotateX(Math.PI / 2).scale(1, 1, 0.35).translate(x, 0.08, z);
    this.addToBucket(rim, getPlainMaterial(0x5a4a32, { roughness: 1, flatShading: true }), false);
  }

  /** Muddy patch to break up the grass (decor). */
  mudPatch(x, z, radius) {
    const geometry = new THREE.CircleGeometry(radius, 16).rotateX(-Math.PI / 2).translate(x, 0.015, z);
    this.addToBucket(geometry, getPlainMaterial(0x5e4e34, { roughness: 1 }), false);
  }

  // ------------------------------------------------------------------ layout helpers
  /** Outposts, scattered crates, extra trees and the perimeter walls shared by every map. */
  buildVerticalLayer(wallColor) {
    let seed = 7;
    const seededRandom = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const arena = WORLD.arenaHalfSize;
    const scale = arenaScale();
    const outposts = OUTPOST_POSITIONS.map(scalePoint);
    const isFreeSpot = (x, z) => !(Math.abs(x) < 60 * scale && Math.abs(z) < 60 * scale)
      && !(Math.abs(z) > arena - 24 * scale && Math.abs(x) < 50 * scale)          // keep spawn zones clear
      && !outposts.some(([outpostX, outpostZ]) => Math.hypot(outpostX - x, outpostZ - z) < 24)
      && !this.physics.isPointBlocked(x, z, 3);

    outposts.forEach(([x, z]) => this.outpost(x, z));

    const crateColors = [0xb98a4a, 0x4a8ab9, 0xb94a4a];
    for (let index = 0; index < Math.round(46 * scale * scale); index++) {
      const x = (seededRandom() * 2 - 1) * (arena - 8);
      const z = (seededRandom() * 2 - 1) * (arena - 8);
      const size = 2 + seededRandom() * 1.5;
      if (isFreeSpot(x, z)) this.crate(x, z, size, size, crateColors[index % 3]);
    }
    for (let index = 0; index < Math.round(18 * scale * scale); index++) {
      const x = (seededRandom() * 2 - 1) * (arena - 8);
      const z = (seededRandom() * 2 - 1) * (arena - 8);
      if (isFreeSpot(x, z)) this.tree(x, z, 1.2);
    }

    const wallLength = 2 * arena + 6;
    this.boundaryWall(0, arena + 1.5, wallLength, 2, wallColor);
    this.boundaryWall(0, -arena - 1.5, wallLength, 2, wallColor);
    this.boundaryWall(arena + 1.5, 0, 2, wallLength, wallColor);
    this.boundaryWall(-arena - 1.5, 0, 2, wallLength, wallColor);
  }

  /** Forest ring and mountains outside the walls so the horizon never looks empty. */
  buildScenery(outerTreeCount) {
    for (let index = 0; index < outerTreeCount; index++) {
      const angle = this.random() * Math.PI * 2;
      const distance = WORLD.arenaHalfSize + 10 + this.random() * 110;
      this.tree(Math.cos(angle) * distance, Math.sin(angle) * distance, 1.1 + this.random() * 0.9, { collides: false });
    }
    const mountainColors = [0x5f8f6a, 0x6f9a78, 0x56806a, 0x7a9a82];
    for (let index = 0; index < 34; index++) {
      const angle = (index / 34) * Math.PI * 2 + this.random() * 0.15;
      const distance = WORLD.arenaHalfSize * 2.7 + this.random() * 220;
      const height = 50 + this.random() * 110;
      this.mountain(Math.cos(angle) * distance, Math.sin(angle) * distance, 50 + this.random() * 60, height, mountainColors[index % 4], height > 120);
    }
  }

  // ------------------------------------------------------------------ finalize
  /** Merge every decor bucket into one mesh per material. Call once after building. */
  finalize() {
    for (const bucket of this.mergeBuckets.values()) {
      let mergedGeometry = null;
      try {
        mergedGeometry = mergeGeometries(bucket.geometries, false);
      } catch (error) {
        mergedGeometry = null;
      }
      if (mergedGeometry) {
        const mesh = new THREE.Mesh(mergedGeometry, bucket.material);
        mesh.castShadow = bucket.castShadow;
        mesh.receiveShadow = bucket.receiveShadow;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
      } else {
        // Fallback: add individually if merging failed (mismatched attributes).
        for (const geometry of bucket.geometries) {
          const mesh = new THREE.Mesh(geometry, bucket.material);
          mesh.castShadow = bucket.castShadow;
          mesh.receiveShadow = bucket.receiveShadow;
          mesh.matrixAutoUpdate = false;
          this.group.add(mesh);
        }
        continue;
      }
      bucket.geometries.forEach((geometry) => geometry.dispose());
    }
    this.mergeBuckets.clear();
  }
}
