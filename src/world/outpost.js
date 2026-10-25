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
import { OUTPOST_POSITIONS } from '../config.js';
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

  // ------------------------------------------------------------------ layout helpers
  /** Outposts, scattered crates, extra trees and the perimeter walls shared by every map. */
  buildVerticalLayer(wallColor) {
    let seed = 7;
    const seededRandom = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const arena = 112;
    const isFreeSpot = (x, z) => !(Math.abs(x) < 60 && Math.abs(z) < 60)
      && !(Math.abs(z) > 88 && Math.abs(x) < 32)
      && !OUTPOST_POSITIONS.some(([outpostX, outpostZ]) => Math.hypot(outpostX - x, outpostZ - z) < 24);

    OUTPOST_POSITIONS.forEach(([x, z]) => this.outpost(x, z));

    const crateColors = [0xb98a4a, 0x4a8ab9, 0xb94a4a];
    for (let index = 0; index < 46; index++) {
      const x = (seededRandom() * 2 - 1) * (arena - 8);
      const z = (seededRandom() * 2 - 1) * (arena - 8);
      const size = 2 + seededRandom() * 1.5;
      if (isFreeSpot(x, z)) this.crate(x, z, size, size, crateColors[index % 3]);
    }
    for (let index = 0; index < 18; index++) {
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
      const distance = 122 + this.random() * 110;
      this.tree(Math.cos(angle) * distance, Math.sin(angle) * distance, 1.1 + this.random() * 0.9, { collides: false });
    }
    const mountainColors = [0x5f8f6a, 0x6f9a78, 0x56806a, 0x7a9a82];
    for (let index = 0; index < 34; index++) {
      const angle = (index / 34) * Math.PI * 2 + this.random() * 0.15;
      const distance = 300 + this.random() * 220;
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
