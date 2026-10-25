// =====================================================================
// Weather manager — a dynamic event rolls in midway through each match:
//   DENSE FOG  : pale wall of fog, ~30 m visibility.
//   DUST STORM : orange haze and blowing grit, ~40 m visibility.
//   NIGHTFALL  : the sun sets, emissive lights take over, flashlights on.
// Sky, fog, sun and ambient light blend over a few seconds; the
// environment map is re-baked so reflections match. Bots' sight range
// shrinks too, so long-range rifles lose their edge.
// Also owns the player's flashlight (toggle with L).
// Events: weather:start { event }, weather:update { type, intensity }.
// =====================================================================

import * as THREE from 'three';
import { MATCH, PLAYER, WEATHER } from '../config.js';
import { events } from '../core/events.js';
import { netState } from '../net/netState.js';

export class WeatherManager {
  constructor({ gameRenderer }) {
    this.gameRenderer = gameRenderer;
    this.event = null;
    this.progress = 0;
    this.triggered = false;
    this.rebakedAt = new Set();

    // Flashlight: created once (intensity toggled) so shaders never recompile.
    this.flashlight = new THREE.SpotLight(0xfff2d8, 0, 40, Math.PI / 7, 0.45, 1.4);
    this.flashlight.position.set(0.25, -0.15, 0);
    this.flashlight.target.position.set(0.1, -0.2, -6);
    gameRenderer.camera.add(this.flashlight, this.flashlight.target);
    this.flashlightOn = false;
  }

  /** Capture the map's clear-weather look so we can blend away from it. */
  reset() {
    const renderer = this.gameRenderer;
    this.base = {
      top: renderer.skyUniforms.topColor.value.clone(),
      horizon: renderer.skyUniforms.horizonColor.value.clone(),
      bottom: renderer.skyUniforms.bottomColor.value.clone(),
      sunDisc: renderer.skyUniforms.sunDiscIntensity.value,
      fogColor: renderer.scene.fog.color.clone(),
      fogDensity: renderer.scene.fog.density,
      sunIntensity: renderer.sunLight.intensity,
      hemisphereIntensity: renderer.hemisphereLight.intensity,
    };
    this.event = null;
    this.progress = 0;
    this.triggered = false;
    this.rebakedAt.clear();
    this.autoFlashlightDone = false;
    this.setFlashlight(false);
    this.gameRenderer.setGradeMood({});
  }

  get visibilityRange() {
    if (!this.event || this.progress < 0.5) return Infinity;
    return this.event.visibility;
  }

  get isNight() {
    return !!(this.event && this.event.isNight && this.progress > 0.5);
  }

  setFlashlight(on) {
    this.flashlightOn = on;
    this.flashlight.intensity = on ? PLAYER.flashlightIntensity : 0;
    events.emit('flashlight:toggle', { on });
  }

  toggleFlashlight() {
    this.setFlashlight(!this.flashlightOn);
  }

  start(eventId = null) {
    const ids = Object.keys(WEATHER.events);
    this.event = WEATHER.events[eventId || ids[Math.floor(Math.random() * ids.length)]];
    this.progress = 0;
    this.triggered = true;
    events.emit('weather:start', { event: this.event });
    // Moodier film grade to match the weather.
    const moods = {
      night: { vignette: 0.5, warmth: -0.03, saturation: 0.82 },
      duststorm: { vignette: 0.42, warmth: 0.075, saturation: 0.92 },
      fog: { vignette: 0.38, warmth: 0.0, saturation: 0.84 },
    };
    this.gameRenderer.setGradeMood(moods[this.event.id] || {});
    events.emit('toast', { text: this.event.name, style: 'danger' });
    events.emit('notify', { text: this.event.alert, tone: 'danger' });
  }

  update(deltaSeconds, match) {
    if (!this.base) return;
    const elapsedFraction = 1 - match.timeRemaining / (match.duration || MATCH.durationSeconds);
    // Only the authority rolls the weather; guests receive it via 'weather:start'.
    if (!this.triggered && netState.isAuthority && elapsedFraction >= WEATHER.triggerAtFraction) this.start();
    if (!this.event) return;

    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + deltaSeconds / WEATHER.transitionTime);
      this.applyBlend(this.progress);
      // Re-bake image-based lighting a couple of times during the transition.
      for (const checkpoint of [0.5, 1]) {
        if (this.progress >= checkpoint && !this.rebakedAt.has(checkpoint)) {
          this.rebakedAt.add(checkpoint);
          this.gameRenderer.rebuildEnvironmentMap();
        }
      }
      if (this.event.isNight && this.progress > 0.55 && !this.flashlightOn && !this.autoFlashlightDone) {
        this.autoFlashlightDone = true;
        this.setFlashlight(true);
      }
    }
    events.emit('weather:update', { type: this.event.id, intensity: this.progress });
  }

  applyBlend(progress) {
    const eased = progress * progress * (3 - 2 * progress);
    const renderer = this.gameRenderer;
    const event = this.event;
    const target = (hex, scale = 0.8) => new THREE.Color(hex).multiplyScalar(scale);
    renderer.skyUniforms.topColor.value.copy(this.base.top).lerp(target(event.skyTop), eased);
    renderer.skyUniforms.horizonColor.value.copy(this.base.horizon).lerp(target(event.skyHorizon), eased);
    renderer.skyUniforms.bottomColor.value.copy(this.base.bottom).lerp(target(event.skyBottom), eased);
    renderer.skyUniforms.sunDiscIntensity.value = this.base.sunDisc * (1 - eased);
    renderer.scene.fog.color.copy(this.base.fogColor).lerp(target(event.fogColor), eased);
    renderer.scene.fog.density = THREE.MathUtils.lerp(this.base.fogDensity, event.fogDensity, eased);
    renderer.sunLight.intensity = THREE.MathUtils.lerp(this.base.sunIntensity, event.sunIntensity, eased);
    renderer.hemisphereLight.intensity = THREE.MathUtils.lerp(this.base.hemisphereIntensity, event.hemisphereIntensity, eased);
  }
}
