// =====================================================================
// Materials — procedural PBR surface library.
//
// Every surface type (block, brick, planks, metal, asphalt, ...) gets a
// procedurally painted detail texture and a matching normal map, generated
// once on a canvas at startup. Textures are grayscale so one texture can be
// tinted any color via material.color. Box UVs are rescaled to world units so
// detail density stays constant no matter how big a block is.
//
// Also provides a wind-sway shader patch for foliage and grass.
// =====================================================================

import * as THREE from 'three';
import { RENDER } from '../config.js';

const TEXTURE_SIZE = 256;
const textureCache = new Map();
const materialCache = new Map();
let anisotropyLevel = 4;

/** Shared clock uniform for all wind-swayed materials. Updated by the game loop. */
export const windUniforms = { windTime: { value: 0 } };

export function configureMaterials({ maxAnisotropy }) {
  anisotropyLevel = Math.min(8, maxAnisotropy || 4);
}

// ------------------------------------------------------------------ helpers
function createSeededRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

function grayscale(value) {
  const channel = Math.max(0, Math.min(255, Math.round(value)));
  return `rgb(${channel},${channel},${channel})`;
}

function sprinkleNoise(context, random, count, minValue, maxValue, maxSize) {
  for (let index = 0; index < count; index++) {
    context.fillStyle = grayscale(minValue + random() * (maxValue - minValue));
    const size = 1 + random() * maxSize;
    context.fillRect(random() * TEXTURE_SIZE, random() * TEXTURE_SIZE, size, size);
  }
}

// Each painter draws a tileable grayscale detail pattern (bright = base color).
const SURFACE_PAINTERS = {
  block(context, random) {
    context.fillStyle = grayscale(246);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    sprinkleNoise(context, random, 2600, 220, 255, 2);
    // Voxel panel seams: one panel per texture tile.
    context.strokeStyle = grayscale(196);
    context.lineWidth = 6;
    context.strokeRect(3, 3, TEXTURE_SIZE - 6, TEXTURE_SIZE - 6);
    context.strokeStyle = grayscale(255);
    context.lineWidth = 2;
    context.strokeRect(9, 9, TEXTURE_SIZE - 18, TEXTURE_SIZE - 18);
  },
  plaster(context, random) {
    context.fillStyle = grayscale(244);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    sprinkleNoise(context, random, 5000, 215, 255, 3);
  },
  brick(context, random) {
    context.fillStyle = grayscale(232);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    const rows = 8;
    const rowHeight = TEXTURE_SIZE / rows;
    const brickWidth = TEXTURE_SIZE / 4;
    for (let row = 0; row < rows; row++) {
      const offset = row % 2 ? brickWidth / 2 : 0;
      for (let column = -1; column < 5; column++) {
        context.fillStyle = grayscale(200 + random() * 50);
        context.fillRect(column * brickWidth + offset + 2, row * rowHeight + 2, brickWidth - 4, rowHeight - 4);
      }
    }
    sprinkleNoise(context, random, 1800, 170, 240, 2);
  },
  planks(context, random) {
    const plankCount = 4;
    const plankWidth = TEXTURE_SIZE / plankCount;
    for (let plank = 0; plank < plankCount; plank++) {
      context.fillStyle = grayscale(205 + random() * 45);
      context.fillRect(plank * plankWidth, 0, plankWidth, TEXTURE_SIZE);
      for (let grain = 0; grain < 18; grain++) {
        context.fillStyle = grayscale(180 + random() * 50);
        context.fillRect(plank * plankWidth + random() * plankWidth, 0, 1 + random() * 2, TEXTURE_SIZE);
      }
      context.fillStyle = grayscale(140);
      context.fillRect(plank * plankWidth, 0, 3, TEXTURE_SIZE);
      context.fillStyle = grayscale(150);
      context.fillRect(plank * plankWidth + plankWidth * 0.5, random() * TEXTURE_SIZE, plankWidth * 0.5, 3);
    }
  },
  metal(context, random) {
    // Corrugated container siding.
    const ribs = 16;
    for (let rib = 0; rib < ribs; rib++) {
      const gradient = context.createLinearGradient(rib * (TEXTURE_SIZE / ribs), 0, (rib + 1) * (TEXTURE_SIZE / ribs), 0);
      gradient.addColorStop(0, grayscale(190));
      gradient.addColorStop(0.5, grayscale(255));
      gradient.addColorStop(1, grayscale(185));
      context.fillStyle = gradient;
      context.fillRect(rib * (TEXTURE_SIZE / ribs), 0, TEXTURE_SIZE / ribs, TEXTURE_SIZE);
    }
    sprinkleNoise(context, random, 900, 150, 230, 3);
  },
  asphalt(context, random) {
    context.fillStyle = grayscale(225);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    sprinkleNoise(context, random, 9000, 160, 255, 2);
  },
  concrete(context, random) {
    context.fillStyle = grayscale(238);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    sprinkleNoise(context, random, 4000, 200, 255, 3);
    context.strokeStyle = grayscale(200);
    context.lineWidth = 3;
    context.strokeRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    context.strokeStyle = grayscale(185);
    context.lineWidth = 1.5;
    context.beginPath();
    let crackX = random() * TEXTURE_SIZE;
    let crackY = 0;
    context.moveTo(crackX, crackY);
    while (crackY < TEXTURE_SIZE) {
      crackX += (random() - 0.5) * 30;
      crackY += 10 + random() * 20;
      context.lineTo(crackX, crackY);
    }
    context.stroke();
  },
  bark(context, random) {
    context.fillStyle = grayscale(220);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    for (let streak = 0; streak < 70; streak++) {
      context.fillStyle = grayscale(150 + random() * 90);
      context.fillRect(random() * TEXTURE_SIZE, 0, 2 + random() * 5, TEXTURE_SIZE);
    }
  },
  grass(context, random) {
    context.fillStyle = grayscale(232);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    sprinkleNoise(context, random, 3000, 190, 255, 3);
    for (let blade = 0; blade < 2600; blade++) {
      context.fillStyle = grayscale(185 + random() * 70);
      context.fillRect(random() * TEXTURE_SIZE, random() * TEXTURE_SIZE, 1, 3 + random() * 5);
    }
    // Soft large-scale patches so the field doesn't look uniform.
    for (let patch = 0; patch < 14; patch++) {
      const centerX = random() * TEXTURE_SIZE;
      const centerY = random() * TEXTURE_SIZE;
      const radius = 20 + random() * 50;
      const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
      gradient.addColorStop(0, `rgba(${random() > 0.5 ? '255,255,255' : '160,160,160'},0.18)`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    }
  },
  roof(context, random) {
    context.fillStyle = grayscale(230);
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    const rows = 8;
    const rowHeight = TEXTURE_SIZE / rows;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < 8; column++) {
        const x = column * 32 + (row % 2 ? 16 : 0);
        context.fillStyle = grayscale(195 + random() * 55);
        context.beginPath();
        context.ellipse(x, row * rowHeight + rowHeight, 15, rowHeight, 0, Math.PI, 0);
        context.fill();
      }
    }
  },
  crate(context, random) {
    SURFACE_PAINTERS.planks(context, random);
    context.strokeStyle = grayscale(120);
    context.lineWidth = 14;
    context.strokeRect(7, 7, TEXTURE_SIZE - 14, TEXTURE_SIZE - 14);
    context.beginPath();
    context.moveTo(10, 10);
    context.lineTo(TEXTURE_SIZE - 10, TEXTURE_SIZE - 10);
    context.stroke();
  },
};

/** Build a normal map from the luminance of a painted canvas (Sobel-like central differences). */
function buildNormalCanvas(sourceCanvas, strength) {
  const size = sourceCanvas.width;
  const sourcePixels = sourceCanvas.getContext('2d').getImageData(0, 0, size, size).data;
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  const normalContext = normalCanvas.getContext('2d');
  const normalImage = normalContext.createImageData(size, size);
  const heightAt = (x, y) => sourcePixels[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const slopeX = (heightAt(x - 1, y) - heightAt(x + 1, y)) * strength;
      const slopeY = (heightAt(x, y - 1) - heightAt(x, y + 1)) * strength;
      const length = Math.hypot(slopeX, slopeY, 1);
      const pixelIndex = (y * size + x) * 4;
      normalImage.data[pixelIndex] = ((slopeX / length) * 0.5 + 0.5) * 255;
      normalImage.data[pixelIndex + 1] = ((slopeY / length) * 0.5 + 0.5) * 255;
      normalImage.data[pixelIndex + 2] = ((1 / length) * 0.5 + 0.5) * 255;
      normalImage.data[pixelIndex + 3] = 255;
    }
  }
  normalContext.putImageData(normalImage, 0, 0);
  return normalCanvas;
}

function getSurfaceTextures(surfaceName) {
  if (textureCache.has(surfaceName)) return textureCache.get(surfaceName);
  const painter = SURFACE_PAINTERS[surfaceName];
  if (!painter) return null;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  painter(context, createSeededRandom(surfaceName.length * 7919 + 13));

  const colorTexture = new THREE.CanvasTexture(canvas);
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  const normalTexture = new THREE.CanvasTexture(buildNormalCanvas(canvas, SURFACE_DEFINITIONS[surfaceName].normalStrength));
  for (const texture of [colorTexture, normalTexture]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = anisotropyLevel;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
  }
  const textures = { colorTexture, normalTexture };
  textureCache.set(surfaceName, textures);
  return textures;
}

// PBR response per surface. unitsPerTile = world metres covered by one texture repeat.
export const SURFACE_DEFINITIONS = {
  block: { roughness: 0.62, metalness: 0.0, normalStrength: 3.0, normalScale: 0.6, unitsPerTile: 2 },
  plaster: { roughness: 0.92, metalness: 0.0, normalStrength: 2.0, normalScale: 0.5, unitsPerTile: 3 },
  brick: { roughness: 0.88, metalness: 0.0, normalStrength: 4.0, normalScale: 0.9, unitsPerTile: 2.5 },
  planks: { roughness: 0.8, metalness: 0.0, normalStrength: 3.0, normalScale: 0.7, unitsPerTile: 2 },
  metal: { roughness: 0.38, metalness: 0.6, normalStrength: 5.0, normalScale: 0.9, unitsPerTile: 2 },
  asphalt: { roughness: 0.96, metalness: 0.0, normalStrength: 2.5, normalScale: 0.6, unitsPerTile: 3 },
  concrete: { roughness: 0.85, metalness: 0.0, normalStrength: 2.5, normalScale: 0.6, unitsPerTile: 4 },
  bark: { roughness: 0.95, metalness: 0.0, normalStrength: 4.0, normalScale: 1.0, unitsPerTile: 1.5 },
  grass: { roughness: 0.97, metalness: 0.0, normalStrength: 2.0, normalScale: 0.5, unitsPerTile: 6 },
  roof: { roughness: 0.75, metalness: 0.05, normalStrength: 4.0, normalScale: 0.9, unitsPerTile: 2.5 },
  crate: { roughness: 0.85, metalness: 0.0, normalStrength: 3.0, normalScale: 0.8, unitsPerTile: 3 },
};

/**
 * Get (cached) a textured MeshStandardMaterial for a surface type and tint.
 * extraOptions are merged into the material parameters (e.g. { side: THREE.DoubleSide }).
 */
export function getSurfaceMaterial(surfaceName, color, extraOptions = {}) {
  const definition = SURFACE_DEFINITIONS[surfaceName] || SURFACE_DEFINITIONS.block;
  const cacheKey = `${surfaceName}|${color}|${JSON.stringify(extraOptions)}`;
  if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);

  const textures = getSurfaceTextures(surfaceName in SURFACE_DEFINITIONS ? surfaceName : 'block');
  const material = new THREE.MeshStandardMaterial({
    color,
    map: textures.colorTexture,
    normalMap: textures.normalTexture,
    normalScale: new THREE.Vector2(definition.normalScale, definition.normalScale),
    roughness: definition.roughness,
    metalness: definition.metalness,
    envMapIntensity: RENDER.environmentIntensity,
    ...extraOptions,
  });
  materialCache.set(cacheKey, material);
  return material;
}

/** Untextured standard material (cached). */
export function getPlainMaterial(color, { roughness = 0.7, metalness = 0, flatShading = false, emissive = 0x000000, emissiveIntensity = 1, transparent = false, opacity = 1 } = {}) {
  const cacheKey = `plain|${color}|${roughness}|${metalness}|${flatShading}|${emissive}|${emissiveIntensity}|${transparent}|${opacity}`;
  if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);
  const material = new THREE.MeshStandardMaterial({
    color, roughness, metalness, flatShading, emissive, emissiveIntensity, transparent, opacity,
    envMapIntensity: RENDER.environmentIntensity,
  });
  materialCache.set(cacheKey, material);
  return material;
}

/** Glowing material whose brightness exceeds 1.0 so bloom picks it up. */
export function getGlowMaterial(color, intensity = 3) {
  return getPlainMaterial(color, { emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}

/** Rescale a BoxGeometry's UVs so one texture tile covers `unitsPerTile` metres on every face. */
export function applyWorldUVs(geometry, width, height, depth, unitsPerTile) {
  const uvAttribute = geometry.attributes.uv;
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (4 vertices each with 1 segment).
  const faceDimensions = [[depth, height], [depth, height], [width, depth], [width, depth], [width, height], [width, height]];
  for (let face = 0; face < 6; face++) {
    const [uSize, vSize] = faceDimensions[face];
    for (let corner = 0; corner < 4; corner++) {
      const vertexIndex = face * 4 + corner;
      uvAttribute.setXY(vertexIndex, (uvAttribute.getX(vertexIndex) * uSize) / unitsPerTile, (uvAttribute.getY(vertexIndex) * vSize) / unitsPerTile);
    }
  }
  uvAttribute.needsUpdate = true;
  return geometry;
}

/**
 * Patch a material so its vertices sway in the wind.
 * Height above the local origin (or world height for merged geometry) drives the sway amount:
 *   offset = sin(time + position) * height^power * strength
 */
export function applyWindSway(material, { strength = 0.05, power = 1.0, speed = 1.6 } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windUniforms.windTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 swayReference = position;
        #ifdef USE_INSTANCING
          swayReference = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif
        float swayHeight = max(position.y, 0.0);
        float swayPhase = windTime * ${speed.toFixed(3)} + swayReference.x * 0.23 + swayReference.z * 0.19;
        float swayAmount = pow(swayHeight, ${power.toFixed(3)}) * ${strength.toFixed(4)};
        transformed.x += sin(swayPhase) * swayAmount;
        transformed.z += cos(swayPhase * 0.83) * swayAmount * 0.6;`,
      );
  };
  material.customProgramCacheKey = () => `wind-${strength}-${power}-${speed}`;
  return material;
}

/** Small canvas helper used by sprites/decals elsewhere. */
export function createCanvasTexture(size, drawFunction, { colorSpace = THREE.SRGBColorSpace } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  drawFunction(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  return texture;
}
