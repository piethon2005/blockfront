// =====================================================================
// Physics — lightweight kinematic collision for blocky worlds.
//
// Colliders are axis-aligned boxes and axis-aligned ramps on the XZ plane.
// Bodies are vertical capsules approximated by a circle (radius) and a
// height. Horizontal resolution pushes bodies out along the axis of least
// penetration; vertical stepping finds the floor/ceiling under the body.
// Destructible VoxelStructures register a "voxel" collider: bodies then
// collide with their individual cells, so blasted holes become passable.
// Raycasting (shots, line of sight) uses Three.js meshes registered as solids
// plus an exact grid traversal through the VoxelWorld.
// =====================================================================

import * as THREE from 'three';
import { WORLD } from '../config.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class PhysicsWorld {
  constructor() {
    this.colliders = [];
    this.solidMeshes = [];
    this.raycaster = new THREE.Raycaster();
    this.scratchDirection = new THREE.Vector3();
    this.voxelWorld = null;
  }

  setVoxelWorld(voxelWorld) {
    this.voxelWorld = voxelWorld;
  }

  reset() {
    this.colliders.length = 0;
    this.solidMeshes.length = 0;
  }

  // ------------------------------------------------------------------ registration
  /** Axis-aligned box. bottom/top are absolute heights. */
  addBoxCollider({ x, z, width, depth, bottom, top }) {
    const collider = { x, z, width, depth, bottom, top, isRamp: false, enabled: true };
    this.colliders.push(collider);
    return collider;
  }

  /**
   * Ramp rising along (slopeX, slopeZ) — a unit axis direction.
   * Its surface height goes from `bottom` at the low end to `top` at the high end.
   */
  addRampCollider({ x, z, width, depth, bottom, top, slopeX, slopeZ, run }) {
    const collider = { x, z, width, depth, bottom, top, isRamp: true, slopeX, slopeZ, run, enabled: true };
    this.colliders.push(collider);
    return collider;
  }

  /** Collider whose collision shape is the live cell grid of a VoxelStructure. */
  addVoxelCollider(structure) {
    const collider = {
      x: structure.centerX, z: structure.centerZ, width: structure.width, depth: structure.depth,
      bottom: structure.minY, top: structure.maxY, isRamp: false, structure, enabled: true,
    };
    this.colliders.push(collider);
    return collider;
  }

  addSolidMesh(mesh) {
    this.solidMeshes.push(mesh);
  }

  removeSolidMesh(mesh) {
    const index = this.solidMeshes.indexOf(mesh);
    if (index >= 0) this.solidMeshes.splice(index, 1);
  }

  // ------------------------------------------------------------------ queries
  /** Height of the walkable surface of a collider at (x, z). */
  surfaceHeightAt(collider, x, z) {
    if (!collider.isRamp) return collider.top;
    const clampedX = clamp(x, collider.x - collider.width / 2, collider.x + collider.width / 2);
    const clampedZ = clamp(z, collider.z - collider.depth / 2, collider.z + collider.depth / 2);
    const alongSlope = ((clampedX - collider.x) * collider.slopeX + (clampedZ - collider.z) * collider.slopeZ) / collider.run + 0.5;
    return collider.bottom + (collider.top - collider.bottom) * clamp(alongSlope, 0, 1);
  }

  /** Is (x, z) inside any collider footprint (with optional padding)? Used for decoration placement. */
  isPointBlocked(x, z, padding = 0) {
    for (const collider of this.colliders) {
      if (!collider.enabled) continue;
      if (Math.abs(x - collider.x) < collider.width / 2 + padding && Math.abs(z - collider.z) < collider.depth / 2 + padding) return true;
    }
    return false;
  }

  /**
   * Push a position out of every collider it overlaps horizontally.
   * `position` must expose x and z (a Vector3 or plain object) and is modified in place.
   */
  resolveHorizontal(position, feetHeight, radius = WORLD.bodyRadius) {
    for (const collider of this.colliders) {
      if (!collider.enabled) continue;
      if (collider.structure) {
        if (Math.abs(position.x - collider.x) > collider.width / 2 + radius) continue;
        if (Math.abs(position.z - collider.z) > collider.depth / 2 + radius) continue;
        collider.structure.resolveBody(position, feetHeight, radius);
        continue;
      }
      // Ignore colliders entirely above our head or low enough to step onto.
      if (feetHeight + WORLD.bodyHeight <= collider.bottom) continue;
      if (feetHeight >= this.surfaceHeightAt(collider, position.x, position.z) - WORLD.stepHeight) continue;

      const offsetX = position.x - collider.x;
      const offsetZ = position.z - collider.z;
      const overlapX = collider.width / 2 + radius - Math.abs(offsetX);
      const overlapZ = collider.depth / 2 + radius - Math.abs(offsetZ);
      if (overlapX > 0 && overlapZ > 0) {
        if (overlapX < overlapZ) position.x += Math.sign(offsetX || 1) * overlapX;
        else position.z += Math.sign(offsetZ || 1) * overlapZ;
      }
    }
    const limit = WORLD.arenaHalfSize - 1;
    position.x = clamp(position.x, -limit, limit);
    position.z = clamp(position.z, -limit, limit);
  }

  /**
   * Integrate gravity, jumping, floors and ceilings for a body.
   * body: { position: {x, y, z}, verticalVelocity, isGrounded }
   * Returns { jumped, landed, fallSpeed } so callers can trigger sounds/animations.
   */
  stepVertical(body, deltaSeconds, wantsJump) {
    const previousHeight = body.position.y;
    const wasGrounded = body.isGrounded;
    let floorHeight = 0;
    let ceilingHeight = Infinity;

    for (const collider of this.colliders) {
      if (!collider.enabled) continue;
      if (Math.abs(body.position.x - collider.x) > collider.width / 2 + 0.2) continue;
      if (Math.abs(body.position.z - collider.z) > collider.depth / 2 + 0.2) continue;
      if (collider.structure) {
        const column = collider.structure.columnQuery(body.position.x, body.position.z, previousHeight);
        floorHeight = Math.max(floorHeight, column.floor);
        ceilingHeight = Math.min(ceilingHeight, column.ceiling);
        continue;
      }
      const surfaceHeight = this.surfaceHeightAt(collider, body.position.x, body.position.z);
      if (surfaceHeight <= previousHeight + WORLD.stepHeight) floorHeight = Math.max(floorHeight, surfaceHeight);
      else if (collider.bottom >= previousHeight + WORLD.bodyHeight - 0.1) ceilingHeight = Math.min(ceilingHeight, collider.bottom);
    }

    let jumped = false;
    if (wasGrounded && wantsJump) {
      body.verticalVelocity = WORLD.jumpVelocity;
      body.isGrounded = false;
      jumped = true;
    }

    body.verticalVelocity = Math.max(-WORLD.terminalVelocity, body.verticalVelocity - WORLD.gravity * deltaSeconds);
    let nextHeight = previousHeight + body.verticalVelocity * deltaSeconds;

    if (body.verticalVelocity > 0 && nextHeight + WORLD.bodyHeight > ceilingHeight) {
      nextHeight = ceilingHeight - WORLD.bodyHeight;
      body.verticalVelocity = 0;
    }

    const fallSpeed = -body.verticalVelocity;
    body.isGrounded = false;
    const touchesFloor = nextHeight <= floorHeight;
    const snapsToFloor = wasGrounded && previousHeight - floorHeight < WORLD.groundSnapDistance;
    if (body.verticalVelocity <= 0 && (touchesFloor || snapsToFloor)) {
      nextHeight = floorHeight;
      body.verticalVelocity = 0;
      body.isGrounded = true;
    }
    body.position.y = nextHeight;

    return { jumped, landed: !wasGrounded && body.isGrounded, fallSpeed: Math.max(0, fallSpeed), floorHeight };
  }

  /** True when nothing solid blocks the segment from → to. */
  hasLineOfSight(from, to) {
    this.scratchDirection.subVectors(to, from);
    const distance = this.scratchDirection.length();
    if (distance < 0.001) return true;
    this.raycaster.set(from, this.scratchDirection.divideScalar(distance));
    this.raycaster.far = distance;
    const blocked = this.raycaster.intersectObjects(this.solidMeshes, false).length > 0;
    this.raycaster.far = Infinity;
    if (blocked) return false;
    return !(this.voxelWorld && this.voxelWorld.raycast(from, this.scratchDirection, distance));
  }

  /**
   * First hit along a ray against solids, voxels and any extra targets (bot hitboxes, barrels, donkeys).
   * Voxel hits come back as { point, distance, voxel: { structure, cell, normal, exitDistance, ... } }.
   */
  raycastFirst(origin, direction, maxDistance, extraTargets = []) {
    this.raycaster.set(origin, direction);
    this.raycaster.far = maxDistance;
    const targets = extraTargets.length ? this.solidMeshes.concat(extraTargets) : this.solidMeshes;
    const meshHit = this.raycaster.intersectObjects(targets, false)[0] || null;
    this.raycaster.far = Infinity;
    const voxelHit = this.voxelWorld ? this.voxelWorld.raycast(origin, direction, meshHit ? meshHit.distance : maxDistance) : null;
    if (voxelHit) return { point: voxelHit.point, distance: voxelHit.distance, voxel: voxelHit, object: voxelHit.structure.mesh, face: null };
    return meshHit;
  }

  /** Voxel-only segment test used for stray bot bullets chipping cover. */
  raycastVoxels(from, to) {
    if (!this.voxelWorld) return null;
    this.scratchDirection.subVectors(to, from);
    const distance = this.scratchDirection.length();
    if (distance < 0.01) return null;
    return this.voxelWorld.raycast(from, this.scratchDirection.clone().divideScalar(distance), distance);
  }
}
