// =====================================================================
// VoxelWorld — registry of every destructible structure on the map.
// Provides world-level raycasts, cell damage from bullets, area damage
// from explosions, deferred mesh rebuilds and structural collapse.
// Emits:
//   voxel:hit        { position, normal, color, materialType }
//   voxel:destroyed  { position, color, materialType, byPlayer, collapsed }
// =====================================================================

import * as THREE from 'three';
import { VOXEL } from '../config.js';
import { events } from '../core/events.js';
import { VoxelStructure } from './voxelStructure.js';

export class VoxelWorld {
  constructor({ scene }) {
    this.scene = scene;
    this.structures = [];
    this.group = null;
    this.scratchColor = new THREE.Color();
  }

  /** Called by the map builder before a new map is built. */
  reset(parentGroup) {
    this.structures.forEach((structure) => structure.dispose());
    this.structures = [];
    this.group = parentGroup;
  }

  addStructure(options) {
    const structure = new VoxelStructure({ ...options, parent: this.group });
    this.structures.push(structure);
    return structure;
  }

  /** Nearest voxel hit along a ray across all structures. */
  raycast(origin, direction, maxDistance) {
    let best = null;
    for (const structure of this.structures) {
      const hit = structure.raycast(origin, direction, best ? best.distance : maxDistance);
      if (hit && (!best || hit.distance < best.distance)) {
        hit.structure = structure;
        best = hit;
      }
    }
    return best;
  }

  cellColor(structure, cell) {
    const index = structure.index(cell[0], cell[1], cell[2]);
    const debris = structure.materialDefinition.debrisColor;
    if (debris) return debris;
    return this.scratchColor.setRGB(structure.baseColors[index * 3], structure.baseColors[index * 3 + 1], structure.baseColors[index * 3 + 2]).getHex();
  }

  /** Damage the cell a raycast hit. Returns true when the cell broke. */
  damageHit(hit, amount, { byPlayer = false } = {}) {
    const { structure, cell } = hit;
    const color = this.cellColor(structure, cell);
    const destroyed = structure.damageCell(cell[0], cell[1], cell[2], amount);
    events.emit('voxel:hit', { position: hit.point.clone(), normal: hit.normal.clone(), color, materialType: structure.materialType });
    if (destroyed) {
      events.emit('voxel:destroyed', {
        position: structure.cellCenter(cell[0], cell[1], cell[2]), color, materialType: structure.materialType, byPlayer, collapsed: false, cellSize: structure.cellSize,
      });
    }
    return destroyed;
  }

  /** Spherical area damage with linear falloff (explosions). */
  explode(center, radius = VOXEL.explosionRadius, damage = VOXEL.explosionDamage, { byPlayer = false } = {}) {
    const cellCenter = new THREE.Vector3();
    for (const structure of this.structures) {
      if (center.x < structure.minX - radius || center.x > structure.maxX + radius) continue;
      if (center.z < structure.minZ - radius || center.z > structure.maxZ + radius) continue;
      if (center.y < structure.minY - radius || center.y > structure.maxY + radius) continue;
      const size = structure.cellSize;
      const minI = Math.max(0, Math.floor((center.x - radius - structure.minX) / size));
      const maxI = Math.min(structure.cellsX - 1, Math.floor((center.x + radius - structure.minX) / size));
      const minJ = Math.max(0, Math.floor((center.y - radius - structure.minY) / size));
      const maxJ = Math.min(structure.cellsY - 1, Math.floor((center.y + radius - structure.minY) / size));
      const minK = Math.max(0, Math.floor((center.z - radius - structure.minZ) / size));
      const maxK = Math.min(structure.cellsZ - 1, Math.floor((center.z + radius - structure.minZ) / size));
      for (let k = minK; k <= maxK; k++) {
        for (let j = minJ; j <= maxJ; j++) {
          for (let i = minI; i <= maxI; i++) {
            if (!structure.isSolid(i, j, k)) continue;
            structure.cellCenter(i, j, k, cellCenter);
            const distance = cellCenter.distanceTo(center);
            if (distance > radius) continue;
            const color = this.cellColor(structure, [i, j, k]);
            if (structure.damageCell(i, j, k, damage * (1 - distance / radius))) {
              events.emit('voxel:destroyed', { position: cellCenter.clone(), color, materialType: structure.materialType, byPlayer, collapsed: false, cellSize: size });
            }
          }
        }
      }
    }
  }

  /** Deferred work, once per frame: structural collapse and mesh rebuilds. */
  update() {
    for (const structure of this.structures) {
      if (structure.needsIntegrityCheck) {
        const collapsed = structure.collapseFloatingCells();
        collapsed.forEach((position, index) => {
          if (index % 2 === 0 || collapsed.length < 12) {
            events.emit('voxel:destroyed', {
              position, color: structure.materialDefinition.debrisColor || 0x888888, materialType: structure.materialType, byPlayer: false, collapsed: true, cellSize: structure.cellSize,
            });
          }
        });
      }
      if (structure.isDirty) structure.rebuildMesh();
    }
  }
}
