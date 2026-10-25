// =====================================================================
// VoxelStructure — one destructible object (wall, crate, house, fence...)
// stored as an axis-aligned grid of cells with per-cell health.
//
//   • Rendering: one InstancedMesh per structure; only cells with at least
//     one exposed face are drawn, so thick walls stay cheap. Damaged cells
//     darken; destroyed cells vanish.
//   • Collision: bodies collide against individual cells (see resolveBody
//     and columnQuery), so blasted holes become real passages.
//   • Raycasting: exact grid traversal (Amanatides & Woo DDA) instead of
//     triangle tests — fast enough for every bullet and bot sight check.
//   • Integrity: cells no longer connected to the ground collapse.
// =====================================================================

import * as THREE from 'three';
import { VOXEL, WORLD } from '../config.js';
import { applyWorldUVs, getSurfaceMaterial } from './materials.js';

const geometryCache = new Map();
function getCellGeometry(cellSize) {
  const key = cellSize.toFixed(3);
  if (!geometryCache.has(key)) {
    // One texture tile per voxel face gives each cell visible panel seams.
    geometryCache.set(key, applyWorldUVs(new THREE.BoxGeometry(cellSize, cellSize, cellSize), cellSize, cellSize, cellSize, cellSize));
  }
  return geometryCache.get(key);
}

const NEIGHBOR_OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class VoxelStructure {
  /**
   * options: { minX, minY, minZ, cellsX, cellsY, cellsZ, cellSize, materialType, color,
   *            isSolidAt(i,j,k) -> bool, colorAt(i,j,k) -> hex|null, parent }
   */
  constructor({ minX, minY = 0, minZ, cellsX, cellsY, cellsZ, cellSize, materialType = 'block', color = 0xffffff, isSolidAt = null, colorAt = null, parent }) {
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.cellsX = cellsX;
    this.cellsY = cellsY;
    this.cellsZ = cellsZ;
    this.cellSize = cellSize;
    this.maxX = minX + cellsX * cellSize;
    this.maxY = minY + cellsY * cellSize;
    this.maxZ = minZ + cellsZ * cellSize;
    this.materialType = materialType;
    this.materialDefinition = VOXEL.materials[materialType] || VOXEL.materials.block;
    this.isGrounded = minY <= 0.05;
    this.isDirty = true;
    this.needsIntegrityCheck = false;

    const cellCount = cellsX * cellsY * cellsZ;
    this.cellMaxHealth = this.materialDefinition.health * Math.max(0.45, cellSize);
    this.health = new Float32Array(cellCount);
    this.baseColors = new Float32Array(cellCount * 3);

    const baseColor = new THREE.Color();
    let solidCount = 0;
    let seed = Math.floor(Math.abs(minX * 73 + minZ * 151 + cellsX * 7)) + 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < cellsZ; k++) {
      for (let j = 0; j < cellsY; j++) {
        for (let i = 0; i < cellsX; i++) {
          if (isSolidAt && !isSolidAt(i, j, k)) continue;
          const index = this.index(i, j, k);
          this.health[index] = this.cellMaxHealth;
          baseColor.set((colorAt && colorAt(i, j, k)) ?? color);
          baseColor.offsetHSL(0, 0, (random() - 0.5) * 0.06);
          this.baseColors[index * 3] = baseColor.r;
          this.baseColors[index * 3 + 1] = baseColor.g;
          this.baseColors[index * 3 + 2] = baseColor.b;
          solidCount++;
        }
      }
    }
    this.initialSolidCount = solidCount;

    const material = getSurfaceMaterial(this.materialDefinition.surface, 0xffffff);
    this.mesh = new THREE.InstancedMesh(getCellGeometry(cellSize), material, Math.max(1, solidCount));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.voxelStructure = this;
    parent.add(this.mesh);
    this.rebuildMesh();
  }

  // ------------------------------------------------------------------ cell helpers
  index(i, j, k) {
    return i + this.cellsX * (j + this.cellsY * k);
  }

  inBounds(i, j, k) {
    return i >= 0 && j >= 0 && k >= 0 && i < this.cellsX && j < this.cellsY && k < this.cellsZ;
  }

  isSolid(i, j, k) {
    return this.inBounds(i, j, k) && this.health[this.index(i, j, k)] > 0;
  }

  cellCenter(i, j, k, target = new THREE.Vector3()) {
    const size = this.cellSize;
    return target.set(this.minX + (i + 0.5) * size, this.minY + (j + 0.5) * size, this.minZ + (k + 0.5) * size);
  }

  get centerX() { return (this.minX + this.maxX) / 2; }
  get centerZ() { return (this.minZ + this.maxZ) / 2; }
  get width() { return this.maxX - this.minX; }
  get depth() { return this.maxZ - this.minZ; }

  /** A solid cell is drawn when any neighbour is empty (the ground counts as covering the bottom row). */
  isExposed(i, j, k) {
    for (const [offsetX, offsetY, offsetZ] of NEIGHBOR_OFFSETS) {
      const neighborJ = j + offsetY;
      if (neighborJ < 0 && this.isGrounded) continue;
      if (!this.isSolid(i + offsetX, neighborJ, k + offsetZ)) return true;
    }
    return false;
  }

  rebuildMesh() {
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const position = new THREE.Vector3();
    let visible = 0;
    for (let k = 0; k < this.cellsZ; k++) {
      for (let j = 0; j < this.cellsY; j++) {
        for (let i = 0; i < this.cellsX; i++) {
          const index = this.index(i, j, k);
          if (this.health[index] <= 0 || !this.isExposed(i, j, k)) continue;
          this.cellCenter(i, j, k, position);
          matrix.makeTranslation(position.x, position.y, position.z);
          this.mesh.setMatrixAt(visible, matrix);
          const damage = 1 - this.health[index] / this.cellMaxHealth;
          const shade = 1 - damage * 0.55;
          color.setRGB(this.baseColors[index * 3] * shade, this.baseColors[index * 3 + 1] * shade, this.baseColors[index * 3 + 2] * shade);
          this.mesh.setColorAt(visible, color);
          visible++;
        }
      }
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.isDirty = false;
  }

  // ------------------------------------------------------------------ damage
  /** Returns true when the cell was destroyed by this damage. */
  damageCell(i, j, k, amount) {
    if (!this.isSolid(i, j, k)) return false;
    const index = this.index(i, j, k);
    this.health[index] -= amount;
    this.isDirty = true;
    if (this.health[index] <= 0) {
      this.health[index] = 0;
      this.needsIntegrityCheck = true;
      return true;
    }
    return false;
  }

  /**
   * Remove every cell that is no longer connected (6-neighbour) to a cell resting on the ground.
   * Returns world positions of the cells that collapsed.
   */
  collapseFloatingCells() {
    this.needsIntegrityCheck = false;
    if (!this.isGrounded) return [];
    const supported = new Uint8Array(this.health.length);
    const queue = [];
    for (let k = 0; k < this.cellsZ; k++) {
      for (let i = 0; i < this.cellsX; i++) {
        if (this.isSolid(i, 0, k)) {
          const index = this.index(i, 0, k);
          supported[index] = 1;
          queue.push(i, 0, k);
        }
      }
    }
    for (let head = 0; head < queue.length; head += 3) {
      const i = queue[head];
      const j = queue[head + 1];
      const k = queue[head + 2];
      for (const [offsetX, offsetY, offsetZ] of NEIGHBOR_OFFSETS) {
        const neighborI = i + offsetX;
        const neighborJ = j + offsetY;
        const neighborK = k + offsetZ;
        if (!this.isSolid(neighborI, neighborJ, neighborK)) continue;
        const neighborIndex = this.index(neighborI, neighborJ, neighborK);
        if (supported[neighborIndex]) continue;
        supported[neighborIndex] = 1;
        queue.push(neighborI, neighborJ, neighborK);
      }
    }
    const collapsed = [];
    for (let k = 0; k < this.cellsZ; k++) {
      for (let j = 0; j < this.cellsY; j++) {
        for (let i = 0; i < this.cellsX; i++) {
          const index = this.index(i, j, k);
          if (this.health[index] > 0 && !supported[index]) {
            this.health[index] = 0;
            collapsed.push(this.cellCenter(i, j, k));
          }
        }
      }
    }
    if (collapsed.length) this.isDirty = true;
    return collapsed;
  }

  // ------------------------------------------------------------------ collision
  /** Push a body (position with x/z) out of every solid cell it overlaps. */
  resolveBody(position, feetHeight, radius) {
    const size = this.cellSize;
    const bottomLimit = feetHeight + WORLD.stepHeight;
    const topLimit = feetHeight + WORLD.bodyHeight;
    if (topLimit <= this.minY || bottomLimit >= this.maxY) return;
    const minJ = Math.max(0, Math.floor((bottomLimit - this.minY) / size));
    const maxJ = Math.min(this.cellsY - 1, Math.floor((topLimit - 0.001 - this.minY) / size));
    const minI = Math.max(0, Math.floor((position.x - radius - this.minX) / size));
    const maxI = Math.min(this.cellsX - 1, Math.floor((position.x + radius - this.minX) / size));
    const minK = Math.max(0, Math.floor((position.z - radius - this.minZ) / size));
    const maxK = Math.min(this.cellsZ - 1, Math.floor((position.z + radius - this.minZ) / size));
    const half = size / 2;

    for (let j = minJ; j <= maxJ; j++) {
      // Only cells whose top is actually above the step height block the body.
      if (this.minY + (j + 1) * size <= bottomLimit) continue;
      for (let k = minK; k <= maxK; k++) {
        for (let i = minI; i <= maxI; i++) {
          if (!this.isSolid(i, j, k)) continue;
          const centerX = this.minX + (i + 0.5) * size;
          const centerZ = this.minZ + (k + 0.5) * size;
          const offsetX = position.x - centerX;
          const offsetZ = position.z - centerZ;
          const overlapX = half + radius - Math.abs(offsetX);
          const overlapZ = half + radius - Math.abs(offsetZ);
          if (overlapX <= 0 || overlapZ <= 0) continue;
          const pushSignX = Math.sign(offsetX || 1);
          const pushSignZ = Math.sign(offsetZ || 1);
          // Never push into a neighbouring solid cell — this keeps wall-sliding smooth across cell seams.
          const blockedX = this.isSolid(i + pushSignX, j, k);
          const blockedZ = this.isSolid(i, j, k + pushSignZ);
          let pushAlongX = overlapX < overlapZ;
          if (pushAlongX && blockedX && !blockedZ) pushAlongX = false;
          else if (!pushAlongX && blockedZ && !blockedX) pushAlongX = true;
          if (pushAlongX) position.x += pushSignX * overlapX;
          else position.z += pushSignZ * overlapZ;
        }
      }
    }
  }

  /** Highest walkable top under (x, z) reachable from previousHeight, and the lowest ceiling above. */
  columnQuery(x, z, previousHeight) {
    const size = this.cellSize;
    const pad = 0.2;
    let floor = -Infinity;
    let ceiling = Infinity;
    if (x < this.minX - pad || x > this.maxX + pad || z < this.minZ - pad || z > this.maxZ + pad) return { floor, ceiling };
    const minI = Math.max(0, Math.floor((x - pad - this.minX) / size));
    const maxI = Math.min(this.cellsX - 1, Math.floor((x + pad - this.minX) / size));
    const minK = Math.max(0, Math.floor((z - pad - this.minZ) / size));
    const maxK = Math.min(this.cellsZ - 1, Math.floor((z + pad - this.minZ) / size));
    for (let k = minK; k <= maxK; k++) {
      for (let i = minI; i <= maxI; i++) {
        for (let j = 0; j < this.cellsY; j++) {
          if (!this.isSolid(i, j, k)) continue;
          const top = this.minY + (j + 1) * size;
          const bottom = this.minY + j * size;
          if (top <= previousHeight + WORLD.stepHeight) floor = Math.max(floor, top);
          else if (bottom >= previousHeight + WORLD.bodyHeight - 0.1) ceiling = Math.min(ceiling, bottom);
        }
      }
    }
    return { floor, ceiling };
  }

  // ------------------------------------------------------------------ raycast
  /** Ray vs bounding box. Returns [tEnter, tExit, enterAxis] or null. */
  intersectBounds(origin, direction, maxDistance) {
    let tEnter = 0;
    let tExit = maxDistance;
    let enterAxis = -1;
    const minimums = [this.minX, this.minY, this.minZ];
    const maximums = [this.maxX, this.maxY, this.maxZ];
    const origins = [origin.x, origin.y, origin.z];
    const directions = [direction.x, direction.y, direction.z];
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(directions[axis]) < 1e-9) {
        if (origins[axis] < minimums[axis] || origins[axis] > maximums[axis]) return null;
        continue;
      }
      let near = (minimums[axis] - origins[axis]) / directions[axis];
      let far = (maximums[axis] - origins[axis]) / directions[axis];
      if (near > far) [near, far] = [far, near];
      if (near > tEnter) { tEnter = near; enterAxis = axis; }
      if (far < tExit) tExit = far;
      if (tEnter > tExit) return null;
    }
    return [tEnter, tExit, enterAxis];
  }

  /** First solid cell along the ray: { distance, point, normal, cell: [i,j,k], exitDistance } or null. */
  raycast(origin, direction, maxDistance) {
    const bounds = this.intersectBounds(origin, direction, maxDistance);
    if (!bounds) return null;
    const [tEnter, tExit, enterAxis] = bounds;
    const size = this.cellSize;
    const startT = tEnter + 1e-6;
    const startX = origin.x + direction.x * startT;
    const startY = origin.y + direction.y * startT;
    const startZ = origin.z + direction.z * startT;
    let i = Math.min(this.cellsX - 1, Math.max(0, Math.floor((startX - this.minX) / size)));
    let j = Math.min(this.cellsY - 1, Math.max(0, Math.floor((startY - this.minY) / size)));
    let k = Math.min(this.cellsZ - 1, Math.max(0, Math.floor((startZ - this.minZ) / size)));
    const stepX = direction.x > 0 ? 1 : -1;
    const stepY = direction.y > 0 ? 1 : -1;
    const stepZ = direction.z > 0 ? 1 : -1;
    const nextBoundary = (cell, step, min, originComponent, directionComponent) => {
      if (Math.abs(directionComponent) < 1e-9) return Infinity;
      return (min + (cell + (step > 0 ? 1 : 0)) * size - originComponent) / directionComponent;
    };
    let tMaxX = nextBoundary(i, stepX, this.minX, origin.x, direction.x);
    let tMaxY = nextBoundary(j, stepY, this.minY, origin.y, direction.y);
    let tMaxZ = nextBoundary(k, stepZ, this.minZ, origin.z, direction.z);
    const tDeltaX = Math.abs(direction.x) < 1e-9 ? Infinity : size / Math.abs(direction.x);
    const tDeltaY = Math.abs(direction.y) < 1e-9 ? Infinity : size / Math.abs(direction.y);
    const tDeltaZ = Math.abs(direction.z) < 1e-9 ? Infinity : size / Math.abs(direction.z);

    let t = tEnter;
    const normal = new THREE.Vector3();
    if (enterAxis === 0) normal.set(-stepX, 0, 0);
    else if (enterAxis === 1) normal.set(0, -stepY, 0);
    else if (enterAxis === 2) normal.set(0, 0, -stepZ);
    else normal.copy(direction).negate();

    for (let guard = 0; guard < 512 && t <= tExit; guard++) {
      if (this.isSolid(i, j, k)) {
        return {
          distance: t,
          point: new THREE.Vector3(origin.x + direction.x * t, origin.y + direction.y * t, origin.z + direction.z * t),
          normal,
          cell: [i, j, k],
          exitDistance: tExit,
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        t = tMaxX; i += stepX; tMaxX += tDeltaX; normal.set(-stepX, 0, 0);
      } else if (tMaxY < tMaxZ) {
        t = tMaxY; j += stepY; tMaxY += tDeltaY; normal.set(0, -stepY, 0);
      } else {
        t = tMaxZ; k += stepZ; tMaxZ += tDeltaZ; normal.set(0, 0, -stepZ);
      }
      if (!this.inBounds(i, j, k)) return null;
    }
    return null;
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.dispose && this.mesh.dispose();
  }
}
