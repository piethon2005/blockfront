// =====================================================================
// Renderer — Three.js setup: scene, camera, physically based lighting,
// soft shadows, procedural gradient sky, image-based lighting from that
// sky, exponential fog, and an optional post-processing chain:
//   RenderPass (MSAA, HDR) → GTAO ambient occlusion → Unreal bloom → OutputPass (ACES + sRGB)
//   → cinematic grade (contrast, split-toning, vignette, lens fringing, film grain)
// Post-processing modules are loaded dynamically so a missing addon
// degrades gracefully to plain rendering instead of breaking the game.
// =====================================================================

import * as THREE from 'three';
import { GRAPHICS_PRESETS, PLAYER, RENDER } from '../config.js';

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vSkyDirection;
  void main() {
    vSkyDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 bottomColor;
  uniform vec3 sunColor;
  uniform vec3 sunDirection;
  uniform float sunDiscIntensity;
  varying vec3 vSkyDirection;

  void main() {
    vec3 direction = normalize(vSkyDirection);
    float height = direction.y;

    vec3 color;
    if (height >= 0.0) {
      color = mix(horizonColor, topColor, pow(smoothstep(0.0, 1.0, height), 0.55));
    } else {
      color = mix(horizonColor, bottomColor, smoothstep(0.0, 0.22, -height));
    }

    float sunAlignment = max(dot(direction, sunDirection), 0.0);
    color += sunColor * pow(sunAlignment, 6.0) * 0.28;        // wide atmospheric glow
    color += sunColor * pow(sunAlignment, 90.0) * 0.75;       // tight halo
    color += sunColor * smoothstep(0.99935, 0.99965, sunAlignment) * sunDiscIntensity; // HDR disc (blooms)

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Final "film look" pass, applied in display space after tone mapping.
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: RENDER.gradeVignette },
    grain: { value: RENDER.gradeGrain },
    aberration: { value: RENDER.gradeAberration },
    saturation: { value: RENDER.gradeSaturation },
    contrast: { value: RENDER.gradeContrast },
    warmth: { value: RENDER.gradeWarmth },
    shadowTint: { value: new THREE.Vector3(...RENDER.gradeShadowTint) },
    resolution: { value: new THREE.Vector2(1920, 1080) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float vignette;
    uniform float grain;
    uniform float aberration;
    uniform float saturation;
    uniform float contrast;
    uniform float warmth;
    uniform vec3 shadowTint;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash(vec2 point) {
      return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 centered = vUv - 0.5;
      float edge = dot(centered, centered);
      // Lens fringing that grows toward the corners.
      vec2 fringe = centered * aberration * edge * 4.0;
      vec3 color = vec3(
        texture2D(tDiffuse, vUv + fringe).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - fringe).b
      );
      // Gentle S-curve contrast and saturation.
      color = clamp((color - 0.5) * contrast + 0.5, 0.0, 1.0);
      color = color * color * (3.0 - 2.0 * color) * 0.18 + color * 0.82;
      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(vec3(luma), color, saturation);
      // Split toning: cool steel shadows, warm sunlit highlights.
      color += shadowTint * (1.0 - smoothstep(0.0, 0.55, luma));
      color += vec3(warmth, warmth * 0.45, -warmth * 0.55) * smoothstep(0.35, 1.0, luma);
      // Vignette.
      color *= 1.0 - vignette * smoothstep(0.12, 0.62, edge * 1.7);
      // Animated film grain, stronger in the shadows.
      float noise = hash(floor(vUv * resolution) + fract(time * 13.7) * 91.0) - 0.5;
      color += noise * grain * (1.15 - luma);
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

export class GameRenderer {
  constructor() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(PLAYER.baseFov, window.innerWidth / window.innerHeight, RENDER.cameraNear, RENDER.cameraFar);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.webglRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.webglRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.webglRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.webglRenderer.toneMappingExposure = RENDER.toneMappingExposure;
    this.webglRenderer.shadowMap.enabled = true;
    this.webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webglRenderer.setSize(window.innerWidth, window.innerHeight);
    this.webglRenderer.domElement.id = 'game-canvas';
    document.body.prepend(this.webglRenderer.domElement);

    this.maxAnisotropy = this.webglRenderer.capabilities.getMaxAnisotropy();
    this.pmremGenerator = new THREE.PMREMGenerator(this.webglRenderer);
    this.environmentTarget = null;

    this.postProcessingModules = null;
    this.composer = null;
    this.bloomPass = null;
    this.ambientOcclusionPass = null;
    this.qualityName = 'high';
    this.activePreset = GRAPHICS_PRESETS.high;

    this.createLights();
    this.createSky();
  }

  // ------------------------------------------------------------------ lights
  createLights() {
    this.hemisphereLight = new THREE.HemisphereLight(0xcfe8ff, 0x4f8a2a, 0.8);
    this.scene.add(this.hemisphereLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d0, 2.6);
    this.sunLight.castShadow = true;
    this.sunOffset = new THREE.Vector3(30, 50, 20).normalize().multiplyScalar(90);
    const shadowCamera = this.sunLight.shadow.camera;
    const halfSize = RENDER.shadowCameraHalfSize;
    shadowCamera.left = -halfSize;
    shadowCamera.right = halfSize;
    shadowCamera.top = halfSize;
    shadowCamera.bottom = -halfSize;
    shadowCamera.near = 1;
    shadowCamera.far = 220;
    this.sunLight.shadow.bias = RENDER.shadowBias;
    this.sunLight.shadow.normalBias = RENDER.shadowNormalBias;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sunLight, this.sunLight.target);
  }

  // ------------------------------------------------------------------ sky
  createSky() {
    this.skyUniforms = {
      topColor: { value: new THREE.Color(0x2b7fe0) },
      horizonColor: { value: new THREE.Color(0xbfe4ff) },
      bottomColor: { value: new THREE.Color(0x8fbf8a) },
      sunColor: { value: new THREE.Color(0xfff1d0) },
      sunDirection: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      sunDiscIntensity: { value: 7.0 },
    };
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const skyGeometry = new THREE.SphereGeometry(RENDER.skyRadius, 48, 24);
    this.skyMesh = new THREE.Mesh(skyGeometry, this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -1000;
    this.scene.add(this.skyMesh);

    // A separate scene holding only the sky, used to bake image-based lighting.
    this.environmentScene = new THREE.Scene();
    this.environmentScene.add(new THREE.Mesh(skyGeometry, this.skyMaterial));

    this.scene.fog = new THREE.FogExp2(0xbfe4ff, 0.0042);
  }

  /** Apply a map's sky colors, sun direction, light strengths and fog, then rebake the environment map. */
  applyAtmosphere(mapConfig) {
    const sky = mapConfig.sky;
    // Sky colors are pre-scaled so they read correctly after ACES tone mapping.
    this.skyUniforms.topColor.value.set(sky.top).multiplyScalar(0.8);
    this.skyUniforms.horizonColor.value.set(sky.horizon).multiplyScalar(0.8);
    this.skyUniforms.bottomColor.value.set(sky.bottom).multiplyScalar(0.8);
    this.skyUniforms.sunColor.value.set(sky.sunColor);

    const elevation = THREE.MathUtils.degToRad(sky.sunElevation);
    const azimuth = THREE.MathUtils.degToRad(sky.sunAzimuth);
    const sunDirection = new THREE.Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    ).normalize();
    this.skyUniforms.sunDirection.value.copy(sunDirection);
    this.sunOffset.copy(sunDirection).multiplyScalar(90);

    this.sunLight.color.set(sky.sunColor);
    this.sunLight.intensity = mapConfig.sunIntensity;
    this.hemisphereLight.color.set(mapConfig.hemisphereSky);
    this.hemisphereLight.groundColor.set(mapConfig.hemisphereGround);
    this.hemisphereLight.intensity = mapConfig.hemisphereIntensity;

    this.scene.fog.color.copy(this.skyUniforms.horizonColor.value);
    this.scene.fog.density = mapConfig.fogDensity;

    this.rebuildEnvironmentMap();
  }

  rebuildEnvironmentMap() {
    if (this.environmentTarget) this.environmentTarget.dispose();
    this.environmentTarget = this.pmremGenerator.fromScene(this.environmentScene, 0.035, 1, RENDER.skyRadius * 2);
    this.scene.environment = this.environmentTarget.texture;
  }

  // ------------------------------------------------------------------ post-processing
  async loadPostProcessing() {
    const importOptional = async (path) => {
      try {
        return await import(path);
      } catch (error) {
        console.warn(`[renderer] optional module failed to load: ${path}`, error);
        return null;
      }
    };
    const [composerModule, renderPassModule, bloomModule, outputModule, aoModule, shaderPassModule] = await Promise.all([
      importOptional('three/addons/postprocessing/EffectComposer.js'),
      importOptional('three/addons/postprocessing/RenderPass.js'),
      importOptional('three/addons/postprocessing/UnrealBloomPass.js'),
      importOptional('three/addons/postprocessing/OutputPass.js'),
      importOptional('three/addons/postprocessing/GTAOPass.js'),
      importOptional('three/addons/postprocessing/ShaderPass.js'),
    ]);
    if (!composerModule || !renderPassModule || !outputModule) {
      this.postProcessingModules = null;
      return;
    }
    this.postProcessingModules = {
      EffectComposer: composerModule.EffectComposer,
      RenderPass: renderPassModule.RenderPass,
      OutputPass: outputModule.OutputPass,
      UnrealBloomPass: bloomModule ? bloomModule.UnrealBloomPass : null,
      GTAOPass: aoModule ? aoModule.GTAOPass : null,
      ShaderPass: shaderPassModule ? shaderPassModule.ShaderPass : null,
    };
  }

  async init(qualityName) {
    await this.loadPostProcessing();
    this.setQuality(qualityName);
  }

  setQuality(qualityName) {
    const preset = GRAPHICS_PRESETS[qualityName] || GRAPHICS_PRESETS.high;
    this.qualityName = GRAPHICS_PRESETS[qualityName] ? qualityName : 'high';
    this.activePreset = preset;

    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio));
    this.webglRenderer.shadowMap.enabled = preset.shadows;
    this.sunLight.castShadow = preset.shadows;

    const shadowSize = Math.min(preset.shadowMapSize, this.webglRenderer.capabilities.maxTextureSize);
    if (this.sunLight.shadow.mapSize.x !== shadowSize) {
      this.sunLight.shadow.mapSize.set(shadowSize, shadowSize);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }

    this.buildComposer(preset);
    this.resize();
  }

  buildComposer(preset) {
    if (this.composer) {
      this.composer.passes.forEach((pass) => pass.dispose && pass.dispose());
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.composer = null;
    }
    this.bloomPass = null;
    this.ambientOcclusionPass = null;
    this.gradePass = null;

    const modules = this.postProcessingModules;
    if (!preset.postProcessing || !modules) return;

    try {
      const drawingSize = this.webglRenderer.getDrawingBufferSize(new THREE.Vector2());
      const isWebGL2 = this.webglRenderer.capabilities.isWebGL2;
      const hdrTarget = new THREE.WebGLRenderTarget(drawingSize.x, drawingSize.y, {
        type: THREE.HalfFloatType,
        samples: isWebGL2 ? preset.msaaSamples : 0,
      });
      this.composer = new modules.EffectComposer(this.webglRenderer, hdrTarget);
      this.composer.addPass(new modules.RenderPass(this.scene, this.camera));

      if (preset.ambientOcclusion && modules.GTAOPass) {
        try {
          const aoPass = new modules.GTAOPass(this.scene, this.camera, drawingSize.x, drawingSize.y);
          if (typeof aoPass.updateGtaoMaterial === 'function') {
            aoPass.updateGtaoMaterial({ radius: 1.1, distanceExponent: 1.4, thickness: 2.2, scale: 1.15, samples: 16 });
          }
          if (typeof aoPass.updatePdMaterial === 'function') {
            aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 });
          }
          if ('blendIntensity' in aoPass) aoPass.blendIntensity = 0.9;
          this.composer.addPass(aoPass);
          this.ambientOcclusionPass = aoPass;
        } catch (error) {
          console.warn('[renderer] ambient occlusion unavailable:', error);
        }
      }

      if (preset.bloom && modules.UnrealBloomPass) {
        this.bloomPass = new modules.UnrealBloomPass(
          new THREE.Vector2(drawingSize.x, drawingSize.y),
          RENDER.bloomStrength, RENDER.bloomRadius, RENDER.bloomThreshold,
        );
        this.composer.addPass(this.bloomPass);
      }

      this.composer.addPass(new modules.OutputPass());

      if (preset.grading && modules.ShaderPass) {
        try {
          this.gradePass = new modules.ShaderPass(GRADE_SHADER);
          this.gradePass.uniforms.resolution.value.set(drawingSize.x, drawingSize.y);
          this.composer.addPass(this.gradePass);
        } catch (error) {
          console.warn('[renderer] grading pass unavailable:', error);
          this.gradePass = null;
        }
      }
    } catch (error) {
      console.warn('[renderer] post-processing disabled:', error);
      this.composer = null;
    }
  }

  // ------------------------------------------------------------------ per frame
  /** Keep the shadow frustum and sky dome centred on the camera. */
  followCamera(focusX, focusZ) {
    // Snap to shadow texels so shadows don't shimmer while moving.
    const texelSize = (RENDER.shadowCameraHalfSize * 2) / this.sunLight.shadow.mapSize.x;
    const snappedX = Math.round(focusX / texelSize) * texelSize;
    const snappedZ = Math.round(focusZ / texelSize) * texelSize;
    this.sunLight.position.set(snappedX + this.sunOffset.x, this.sunOffset.y, snappedZ + this.sunOffset.z);
    this.sunLight.target.position.set(snappedX, 0, snappedZ);
    this.skyMesh.position.copy(this.camera.position);
  }

  setFov(fieldOfView) {
    if (Math.abs(this.camera.fov - fieldOfView) < 0.01) return;
    this.camera.fov = fieldOfView;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.webglRenderer.setSize(width, height);
    if (this.composer) {
      this.composer.setPixelRatio(this.webglRenderer.getPixelRatio());
      this.composer.setSize(width, height);
    }
    if (this.gradePass && this.gradePass.uniforms) {
      const pixelRatio = this.webglRenderer.getPixelRatio();
      this.gradePass.uniforms.resolution.value.set(width * pixelRatio, height * pixelRatio);
    }
  }

  /** Pre-compile shaders so the first seconds of a match don't stutter. */
  warmUp() {
    try {
      this.webglRenderer.compile(this.scene, this.camera);
    } catch (error) {
      console.warn('[renderer] shader warm-up skipped:', error);
    }
  }

  get drawingHeight() {
    return window.innerHeight * this.webglRenderer.getPixelRatio();
  }

  /** Night and storms get a moodier grade. */
  setGradeMood({ vignette = RENDER.gradeVignette, warmth = RENDER.gradeWarmth, saturation = RENDER.gradeSaturation } = {}) {
    if (!this.gradePass || !this.gradePass.uniforms) return;
    this.gradePass.uniforms.vignette.value = vignette;
    this.gradePass.uniforms.warmth.value = warmth;
    this.gradePass.uniforms.saturation.value = saturation;
  }

  render(deltaSeconds) {
    if (this.gradePass && this.gradePass.uniforms) this.gradePass.uniforms.time.value += deltaSeconds;
    if (this.composer) this.composer.render(deltaSeconds);
    else this.webglRenderer.render(this.scene, this.camera);
  }
}
