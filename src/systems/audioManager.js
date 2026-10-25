// =====================================================================
// Audio manager — a complete sound engine built on the Web Audio API.
//
// No audio files are required: every sound is synthesised in real time
// from noise and oscillators (gunshots, reloads, footsteps, explosions,
// UI, music, ambience). To use recorded audio instead, fill in paths in
// AUDIO_SAMPLES (config.js); a loaded sample always overrides its recipe.
//
// Signal graph:
//   sources ─► [per-sound gain] ─► [distance lowpass + HRTF panner] ─► sfxBus ─┐
//                                     └► reverb send ─► convolver ─► sfxBus    │
//   music sequencer ─► musicBus (+ feedback delay) ───────────────────────────┤
//   ambience (wind, birds) ─► ambientBus ─► sfxBus                            │
//                                         masterGain ◄────────────────────────┘
//                                         ─► low-health lowpass ─► compressor ─► speakers
// =====================================================================

import { AUDIO_SAMPLES } from '../config.js';
import { events } from '../core/events.js';

const midiToFrequency = (midiNote) => 440 * Math.pow(2, (midiNote - 69) / 12);
const randomBetween = (min, max) => min + Math.random() * (max - min);

const MUSIC_TRACKS = {
  menu: {
    bpm: 88,
    chords: [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]],
    bassRoots: [45, 41, 48, 43],
    kickSteps: [0, 8],
    snareSteps: [],
    hatEvery: 4,
    bassSteps: [0, 8],
    arpEvery: 2,
    padLevel: 0.05,
    arpLevel: 0.03,
  },
  battle: {
    bpm: 118,
    chords: [[57, 60, 64, 69], [53, 57, 60, 65], [55, 60, 64, 67], [55, 59, 62, 67]],
    bassRoots: [45, 41, 48, 43],
    kickSteps: [0, 6, 8, 14],
    snareSteps: [4, 12],
    hatEvery: 2,
    bassSteps: [0, 3, 6, 8, 11, 14],
    arpEvery: 1,
    padLevel: 0.025,
    arpLevel: 0.028,
  },
};

export class AudioManager {
  constructor(initialVolumes) {
    this.context = null;
    this.volumes = { master: initialVolumes.master, music: initialVolumes.music, sfx: initialVolumes.sfx };
    this.samples = new Map();
    this.listenerPosition = { x: 0, y: 0, z: 0 };

    this.musicTrackName = null;
    this.musicSampleSource = null;
    this.musicTimer = null;
    this.musicStep = 0;
    this.nextMusicStepTime = 0;

    this.ambientNodes = null;
    this.birdTimer = null;
    this.voicePitch = 1;
    this.isSlowMotion = false;
    this.weatherType = null;
    this.lastVoxelSoundTime = 0;
    this.heartbeatTimer = 0;
    this.lowHealthAmount = 0;
    this.isPaused = false;
    this.eventsBound = false;
  }

  // ------------------------------------------------------------------ setup
  /** Must be called from a user gesture (click/keypress) — browsers block audio until then. */
  unlock() {
    if (!this.context) this.createContext();
    if (this.context && this.context.state === 'suspended') this.context.resume();
  }

  createContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    this.context = context;

    this.masterGain = context.createGain();
    this.masterGain.gain.value = this.volumes.master;
    this.lowHealthFilter = context.createBiquadFilter();
    this.lowHealthFilter.type = 'lowpass';
    this.lowHealthFilter.frequency.value = 20000;
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.2;
    this.masterGain.connect(this.lowHealthFilter).connect(this.compressor).connect(context.destination);

    this.sfxBus = context.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.sfxBus.connect(this.masterGain);

    this.musicBus = context.createGain();
    this.musicBus.gain.value = this.volumes.music;
    this.musicBus.connect(this.masterGain);

    this.ambientBus = context.createGain();
    this.ambientBus.gain.value = 0.7;
    this.ambientBus.connect(this.sfxBus);

    this.reverb = context.createConvolver();
    this.reverb.buffer = this.createImpulseResponse(2.4, 2.8);
    this.reverbReturn = context.createGain();
    this.reverbReturn.gain.value = 0.42;
    this.reverb.connect(this.reverbReturn).connect(this.sfxBus);

    // Tempo-synced echo for the music arpeggio.
    this.musicDelay = context.createDelay(1.0);
    this.musicDelayFeedback = context.createGain();
    this.musicDelayFeedback.gain.value = 0.32;
    this.musicDelay.connect(this.musicDelayFeedback).connect(this.musicDelay);
    this.musicDelay.connect(this.musicBus);

    this.noiseBuffer = this.createNoiseBuffer(3);
    this.loadSamples();
  }

  createNoiseBuffer(seconds) {
    const length = Math.floor(this.context.sampleRate * seconds);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Exponentially decaying stereo noise = a convincing outdoor reverb tail. */
  createImpulseResponse(seconds, decay) {
    const length = Math.floor(this.context.sampleRate * seconds);
    const buffer = this.context.createBuffer(2, length, this.context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index++) {
        data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, decay);
      }
    }
    return buffer;
  }

  async loadSamples() {
    const entries = Object.entries(AUDIO_SAMPLES).filter(([, path]) => path);
    await Promise.all(entries.map(async ([name, path]) => {
      try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const audioBuffer = await this.context.decodeAudioData(await response.arrayBuffer());
        this.samples.set(name, audioBuffer);
      } catch (error) {
        console.warn(`[audio] could not load sample "${name}" from ${path}; using synth.`, error);
      }
    }));
  }

  // ------------------------------------------------------------------ volume & state
  setVolume(kind, value) {
    this.volumes[kind] = value;
    if (!this.context) return;
    const now = this.context.currentTime;
    if (kind === 'master') this.masterGain.gain.setTargetAtTime(value, now, 0.05);
    if (kind === 'sfx') this.sfxBus.gain.setTargetAtTime(this.isPaused ? value * 0.3 : value, now, 0.05);
    if (kind === 'music') this.musicBus.gain.setTargetAtTime(this.isPaused ? value * 0.45 : value, now, 0.05);
  }

  setPaused(paused) {
    this.isPaused = paused;
    if (!this.context) return;
    const now = this.context.currentTime;
    this.sfxBus.gain.setTargetAtTime(paused ? this.volumes.sfx * 0.3 : this.volumes.sfx, now, 0.15);
    this.musicBus.gain.setTargetAtTime(paused ? this.volumes.music * 0.45 : this.volumes.music, now, 0.15);
  }

  /** Called every frame: listener transform, low-health muffle and heartbeat. */
  update(deltaSeconds, { camera, playerHealth, playerAlive }) {
    if (!this.context) return;
    this.updateListener(camera);

    const targetLowHealth = playerAlive && playerHealth < 35 ? 1 - playerHealth / 35 : playerAlive ? 0 : 0.8;
    this.lowHealthAmount += (targetLowHealth - this.lowHealthAmount) * Math.min(1, deltaSeconds * 3);
    const healthCutoff = 20000 * Math.pow(0.06, this.lowHealthAmount);
    const cutoff = this.isSlowMotion ? Math.min(healthCutoff, 1100) : healthCutoff;
    this.lowHealthFilter.frequency.setTargetAtTime(cutoff, this.context.currentTime, 0.08);
    if (this.isSlowMotion) {
      this.slowHeartbeat = (this.slowHeartbeat || 0) - deltaSeconds;
      if (this.slowHeartbeat <= 0) {
        this.slowHeartbeat = 0.85;
        this.play('heartbeat');
      }
    }

    if (playerAlive && playerHealth < 35) {
      this.heartbeatTimer -= deltaSeconds;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 0.55 + playerHealth / 60;
        this.play('heartbeat');
      }
    }
  }

  updateListener(camera) {
    const listener = this.context.listener;
    const position = camera.position;
    const forward = { x: 0, y: 0, z: -1 };
    const up = { x: 0, y: 1, z: 0 };
    // Rotate the basis vectors by the camera quaternion.
    const rotate = (vector) => {
      const q = camera.quaternion;
      const ix = q.w * vector.x + q.y * vector.z - q.z * vector.y;
      const iy = q.w * vector.y + q.z * vector.x - q.x * vector.z;
      const iz = q.w * vector.z + q.x * vector.y - q.y * vector.x;
      const iw = -q.x * vector.x - q.y * vector.y - q.z * vector.z;
      return {
        x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
        y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
        z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
      };
    };
    const worldForward = rotate(forward);
    const worldUp = rotate(up);
    this.listenerPosition = { x: position.x, y: position.y, z: position.z };
    const time = this.context.currentTime;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(position.x, time, 0.02);
      listener.positionY.setTargetAtTime(position.y, time, 0.02);
      listener.positionZ.setTargetAtTime(position.z, time, 0.02);
      listener.forwardX.setTargetAtTime(worldForward.x, time, 0.02);
      listener.forwardY.setTargetAtTime(worldForward.y, time, 0.02);
      listener.forwardZ.setTargetAtTime(worldForward.z, time, 0.02);
      listener.upX.setTargetAtTime(worldUp.x, time, 0.02);
      listener.upY.setTargetAtTime(worldUp.y, time, 0.02);
      listener.upZ.setTargetAtTime(worldUp.z, time, 0.02);
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(worldForward.x, worldForward.y, worldForward.z, worldUp.x, worldUp.y, worldUp.z);
    }
  }

  // ------------------------------------------------------------------ routing helpers
  /**
   * Create the input node for one sound.
   * position → HRTF panner + distance-based lowpass (far sounds get duller).
   * reverb   → send amount into the convolver.
   */
  createOutput({ position = null, reverb = 0, volume = 1, bus = null, lifetime = 2 } = {}) {
    const context = this.context;
    const inputGain = context.createGain();
    inputGain.gain.value = volume;
    const target = bus || this.sfxBus;
    const createdNodes = [inputGain];

    let tail = inputGain;
    if (position) {
      const distance = Math.hypot(position.x - this.listenerPosition.x, position.y - this.listenerPosition.y, position.z - this.listenerPosition.z);
      const distanceFilter = context.createBiquadFilter();
      distanceFilter.type = 'lowpass';
      distanceFilter.frequency.value = Math.max(900, 20000 * Math.exp(-distance / 45));
      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 4;
      panner.maxDistance = 250;
      panner.rolloffFactor = 1.05;
      if (panner.positionX) {
        panner.positionX.value = position.x;
        panner.positionY.value = position.y;
        panner.positionZ.value = position.z;
      } else {
        panner.setPosition(position.x, position.y, position.z);
      }
      inputGain.connect(distanceFilter).connect(panner);
      tail = panner;
      createdNodes.push(distanceFilter, panner);
    }
    tail.connect(target);
    if (reverb > 0) {
      const send = context.createGain();
      send.gain.value = reverb;
      tail.connect(send).connect(this.reverb);
      createdNodes.push(send);
    }
    setTimeout(() => createdNodes.forEach((node) => node.disconnect()), (lifetime + 0.5) * 1000);
    return inputGain;
  }

  /** Filtered noise burst with an exponential envelope. */
  noise({ start, duration, destination, filterType = 'bandpass', frequency = 1000, frequencyEnd = null, q = 1, gain = 0.5, attack = 0.002, playbackRate = 1 }) {
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.playbackRate.value = playbackRate;
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, start);
    if (frequencyEnd) filter.frequency.exponentialRampToValueAtTime(Math.max(20, frequencyEnd), start + duration);
    filter.Q.value = q;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(envelope).connect(destination);
    source.start(start, Math.random() * 2);
    source.stop(start + duration + 0.05);
  }

  /** Oscillator tone with optional pitch glide and an exponential envelope. */
  tone({ start, duration, destination, type = 'sine', frequency = 440, frequencyEnd = null, gain = 0.3, attack = 0.003, detune = 0, release = null }) {
    const context = this.context;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (frequencyEnd) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequencyEnd), start + duration);
    oscillator.detune.value = detune;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
    if (release) envelope.gain.setValueAtTime(Math.max(0.0002, gain), start + duration - release);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope).connect(destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.05);
  }

  // ------------------------------------------------------------------ public API
  /** Play a named sound. options: { position, volume, ... } (recipe-specific extras allowed). */
  play(name, options = {}) {
    if (!this.context || this.context.state !== 'running') return;
    if (this.samples.has(name)) {
      this.playSample(name, options);
      return;
    }
    const recipe = this.recipes[name];
    if (recipe) {
      try {
        recipe.call(this, this.context.currentTime + 0.005, options);
      } catch (error) {
        console.warn(`[audio] recipe "${name}" failed`, error);
      }
    }
  }

  playSample(name, options) {
    const buffer = this.samples.get(name);
    const destination = this.createOutput({ position: options.position, volume: options.volume ?? 1, reverb: 0.15, lifetime: buffer.duration });
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.playbackRate ?? randomBetween(0.97, 1.03);
    source.connect(destination);
    source.start();
  }

  // ------------------------------------------------------------------ sound recipes
  get recipes() {
    return SOUND_RECIPES;
  }

  // ------------------------------------------------------------------ music
  startMusic(trackName) {
    if (!this.context) return;
    if (this.musicTrackName === trackName) return;
    this.stopMusic();
    this.musicTrackName = trackName;

    const sampleName = `music_${trackName}`;
    if (this.samples.has(sampleName)) {
      const source = this.context.createBufferSource();
      source.buffer = this.samples.get(sampleName);
      source.loop = true;
      source.connect(this.musicBus);
      source.start();
      this.musicSampleSource = source;
      return;
    }

    const track = MUSIC_TRACKS[trackName];
    this.musicTrack = track;
    this.sixteenthDuration = 60 / track.bpm / 4;
    this.musicDelay.delayTime.value = this.sixteenthDuration * 3;
    this.musicStep = 0;
    this.nextMusicStepTime = this.context.currentTime + 0.1;
    this.musicTimer = setInterval(() => this.scheduleMusic(), 25);
  }

  stopMusic() {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
    if (this.musicSampleSource) {
      try { this.musicSampleSource.stop(); } catch { /* already stopped */ }
      this.musicSampleSource = null;
    }
    this.musicTrackName = null;
  }

  scheduleMusic() {
    if (!this.context || !this.musicTrack) return;
    while (this.nextMusicStepTime < this.context.currentTime + 0.15) {
      this.playMusicStep(this.musicStep, this.nextMusicStepTime);
      this.nextMusicStepTime += this.sixteenthDuration;
      this.musicStep = (this.musicStep + 1) % 64;
    }
  }

  playMusicStep(step, time) {
    const track = this.musicTrack;
    const bar = Math.floor(step / 16);
    const sixteenth = step % 16;
    const chord = track.chords[bar];
    const bus = this.musicBus;

    if (track.kickSteps.includes(sixteenth)) {
      this.tone({ start: time, duration: 0.32, destination: bus, frequency: 150, frequencyEnd: 42, gain: 0.55, attack: 0.002 });
      this.noise({ start: time, duration: 0.02, destination: bus, filterType: 'highpass', frequency: 3000, gain: 0.08 });
    }
    if (track.snareSteps.includes(sixteenth)) {
      this.noise({ start: time, duration: 0.18, destination: bus, filterType: 'bandpass', frequency: 1800, q: 0.7, gain: 0.22 });
      this.tone({ start: time, duration: 0.1, destination: bus, type: 'triangle', frequency: 220, frequencyEnd: 160, gain: 0.12 });
    }
    if (sixteenth % track.hatEvery === 0) {
      const isOpen = sixteenth === 14 && bar % 2 === 1;
      this.noise({ start: time, duration: isOpen ? 0.2 : 0.035, destination: bus, filterType: 'highpass', frequency: 7500, gain: sixteenth % 4 === 2 ? 0.07 : 0.04 });
    }
    if (track.bassSteps.includes(sixteenth)) {
      const root = track.bassRoots[bar] + (sixteenth === 8 ? 12 : 0);
      this.musicSynthNote(midiToFrequency(root), time, this.sixteenthDuration * 1.8, 0.11, 'sawtooth', 520);
    }
    if (sixteenth % track.arpEvery === 0) {
      const noteIndex = (step / track.arpEvery) % chord.length;
      const octave = sixteenth >= 8 ? 12 : 0;
      this.musicSynthNote(midiToFrequency(chord[Math.floor(noteIndex)] + 12 + octave), time, this.sixteenthDuration * 0.9, track.arpLevel, 'triangle', 3200, true);
    }
    if (sixteenth === 0) {
      const barDuration = this.sixteenthDuration * 16;
      chord.slice(0, 3).forEach((midiNote, index) => {
        this.musicSynthNote(midiToFrequency(midiNote), time, barDuration, track.padLevel, 'sawtooth', 1100, false, 0.35, index * 7 - 7);
      });
    }
  }

  musicSynthNote(frequency, start, duration, gain, type, filterFrequency, sendToDelay = false, attack = 0.005, detune = 0) {
    const context = this.context;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    oscillator.detune.value = detune;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFrequency;
    filter.Q.value = 2;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(filter).connect(envelope).connect(this.musicBus);
    if (sendToDelay) envelope.connect(this.musicDelay);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.05);
  }

  // ------------------------------------------------------------------ ambience
  startAmbient() {
    if (!this.context || this.ambientNodes) return;
    const context = this.context;
    const windSource = context.createBufferSource();
    windSource.buffer = this.noiseBuffer;
    windSource.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 380;
    windFilter.Q.value = 0.8;
    const gustOscillator = context.createOscillator();
    gustOscillator.frequency.value = 0.07;
    const gustDepth = context.createGain();
    gustDepth.gain.value = 220;
    gustOscillator.connect(gustDepth).connect(windFilter.frequency);
    const windGain = context.createGain();
    windGain.gain.value = 0.09;
    windSource.connect(windFilter).connect(windGain).connect(this.ambientBus);
    this.windGain = windGain;
    this.windFilter = windFilter;
    windSource.start();
    gustOscillator.start();
    this.ambientNodes = { windSource, gustOscillator };

    const scheduleBird = () => {
      this.birdTimer = setTimeout(() => {
        this.play(this.weatherType === 'night' ? 'cricket' : 'bird');
        scheduleBird();
      }, randomBetween(3500, 9000));
    };
    scheduleBird();
  }

  stopAmbient() {
    if (!this.ambientNodes) return;
    this.ambientNodes.windSource.stop();
    this.ambientNodes.gustOscillator.stop();
    this.ambientNodes = null;
    clearTimeout(this.birdTimer);
  }

  /** Weather changes the ambience: howling wind in dust storms, muffled air in fog, crickets at night. */
  setWeather(type) {
    this.weatherType = type;
    if (!this.context || !this.windGain) return;
    const now = this.context.currentTime;
    const windLevel = { duststorm: 0.32, fog: 0.13, night: 0.05 }[type] ?? 0.09;
    const windCutoff = { duststorm: 950, fog: 260, night: 300 }[type] ?? 380;
    this.windGain.gain.setTargetAtTime(windLevel, now, 2.5);
    this.windFilter.frequency.setTargetAtTime(windCutoff, now, 2.5);
  }

  setSlowMotion(active) {
    this.isSlowMotion = active;
    this.play(active ? 'deadeye_in' : 'deadeye_out');
  }

  /** Throttled crumble so explosions don't stack hundreds of sounds. */
  playVoxelBreak(materialType, position) {
    const now = performance.now();
    if (now - this.lastVoxelSoundTime < 70) return;
    this.lastVoxelSoundTime = now;
    this.play('voxel_break', { materialType, position });
  }

  // ------------------------------------------------------------------ event wiring
  bindGameEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    events.on('weapon:fire', ({ weapon }) => this.play(weapon.sound));
    events.on('weapon:reload-start', ({ weapon, duration }) => this.play('reload', { weaponId: weapon.id, duration }));
    events.on('weapon:empty', () => this.play('empty'));
    events.on('weapon:switch', () => this.play('weapon_switch'));
    events.on('weapon:zoom', ({ zoomed }) => zoomed && this.play('zoom'));
    events.on('weapon:impact', ({ point, hitBot, hitBarrel }) => {
      if (!hitBot && !hitBarrel) this.play('impact', { position: point });
    });
    events.on('player:step', ({ surface }) => this.play('footstep', { surface }));
    events.on('player:jump', () => this.play('jump'));
    events.on('player:land', ({ fallSpeed }) => fallSpeed > 5 && this.play('land', { fallSpeed }));
    events.on('player:dash', () => this.play('dash'));
    events.on('player:hurt', ({ absorbed, amount }) => this.play(absorbed >= amount ? 'shield_hit' : 'hurt'));
    events.on('armor:break', () => this.play('shield_break'));
    events.on('weapon:melee-swing', () => this.play('knife_swing'));
    events.on('weapon:melee', ({ didHit, hitBot }) => didHit && this.play(hitBot ? 'knife_hit' : 'knife_clang'));
    events.on('loot:pickup', ({ kind }) => this.play({ weapon: 'pickup_weapon', armor: 'pickup_armor', medkit: 'pickup_medkit', ammo: 'pickup_ammo' }[kind]));
    events.on('medkit:start', ({ duration }) => this.play('medkit_use', { duration }));
    events.on('medkit:used', () => this.play('heal'));
    events.on('weapon:dropped', ({ position }) => this.play('weapon_drop', { position: { x: position.x, y: 0.5, z: position.z } }));
    events.on('supply:incoming', () => this.play('supply_incoming'));
    events.on('supply:landed', ({ position }) => this.play('supply_land', { position }));
    events.on('supply:opened', ({ position }) => this.play('supply_open', { position }));
    events.on('mission:complete', () => this.play('mission_complete'));
    events.on('ui:hover', () => this.play('ui_hover'));
    events.on('ui:deploy', () => this.play('deploy'));
    events.on('voxel:destroyed', ({ materialType, position }) => this.playVoxelBreak(materialType, position));
    events.on('donkey:bray', ({ position }) => this.play('donkey_bray', { position }));
    events.on('donkey:hurt', ({ position }) => this.play('donkey_hurt', { position: { x: position.x, y: 1.5, z: position.z } }));
    events.on('donkey:killed', () => this.play('ability_granted'));
    events.on('pet:bark', ({ position }) => this.play('dog_bark', { position }));
    events.on('pet:bite', ({ position }) => this.play('dog_bite', { position }));
    events.on('pet:death', ({ position }) => this.play('dog_whimper', { position }));
    events.on('ability:teleport', () => this.play('teleport'));
    events.on('ability:activated', () => this.play('prop_transform'));
    events.on('ability:granted', ({ ability }) => ability.id === 'hyperSpeed' && this.play('hyperspeed'));
    events.on('ability:deadeye', ({ active }) => this.setSlowMotion(active));
    events.on('announce', ({ tier, kind }) => this.play('announcer', { tier, kind }));
    events.on('flag:taken', ({ flagTeam, ourTeam = 'blue' }) => this.play(flagTeam === ourTeam ? 'flag_alarm' : 'flag_taken'));
    events.on('flag:captured', ({ team, ourTeam = 'blue' }) => this.play(team === ourTeam ? 'victory' : 'flag_alarm'));
    events.on('flag:returned', () => this.play('tag_deny'));
    events.on('weather:start', ({ event }) => {
      this.setWeather(event.id);
      this.play(event.isNight ? 'thunder' : 'weather_alert');
    });
    events.on('flashlight:toggle', () => this.play('flashlight_click'));
    events.on('player:death', () => this.play('death'));
    events.on('player:respawn', () => this.play('respawn'));
    events.on('bot:fire', ({ origin, sound }) => this.play(sound && this.recipes[sound] ? sound : 'shot_ak47', { position: origin, volume: 0.8 }));
    events.on('bot:death', ({ position }) => this.play('shatter', { position: { x: position.x, y: 1.5, z: position.z } }));
    events.on('hit:confirm', ({ isKill, isHeadshot }) => this.play(isKill ? 'kill' : isHeadshot ? 'headshot' : 'hitmarker'));
    events.on('bullet:whiz', ({ position }) => this.play('whiz', { position }));
    events.on('tag:pickup', ({ isPlayer, denied, collectorTeam, position, ourTeam }) => {
      if (isPlayer) this.play(denied ? 'tag_deny' : 'tag_confirm');
      else this.play(collectorTeam === (ourTeam || 'blue') ? 'tag_ally' : 'tag_lost', { position });
    });
    events.on('explosion', ({ position }) => this.play('explosion', { position }));
    events.on('barrel:hit', ({ point }) => this.play('barrel_hit', { position: point }));
    events.on('match:countdown', ({ secondsLeft }) => this.play('countdown', { secondsLeft }));
    events.on('match:start', () => {
      this.startMusic('battle');
      this.startAmbient();
    });
    events.on('match:end', ({ result }) => {
      this.stopMusic();
      this.stopAmbient();
      this.play(result === 'victory' ? 'victory' : 'defeat');
    });
    events.on('game:pause', () => this.setPaused(true));
    events.on('game:resume', () => this.setPaused(false));
    events.on('ui:click', () => this.play('ui_click'));
  }
}

// =====================================================================
// Sound recipes. Each receives (startTime, options) with `this` bound to
// the AudioManager. Pitches are lightly randomised so repeats never sound
// identical. Add a new sound by adding a function here.
// =====================================================================
const SOUND_RECIPES = {
  shot_ak47(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.28, volume, lifetime: 1 });
    const pitch = randomBetween(0.94, 1.06);
    this.noise({ start, duration: 0.05, destination: output, filterType: 'highpass', frequency: 2600 * pitch, gain: 0.85 });
    this.noise({ start, duration: 0.17, destination: output, frequency: 1150 * pitch, frequencyEnd: 380, q: 0.9, gain: 1.1 });
    this.tone({ start, duration: 0.13, destination: output, frequency: 150 * pitch, frequencyEnd: 45, gain: 0.95 });
    this.noise({ start: start + 0.01, duration: 0.38, destination: output, filterType: 'lowpass', frequency: 1300, frequencyEnd: 180, gain: 0.25, attack: 0.012 });
    this.noise({ start: start + 0.03, duration: 0.03, destination: output, frequency: 4200, q: 4, gain: 0.12 }); // bolt clack
  },

  shot_shotgun(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.4, volume, lifetime: 1.6 });
    const pitch = randomBetween(0.95, 1.05);
    this.noise({ start, duration: 0.07, destination: output, filterType: 'highpass', frequency: 2000, gain: 1 });
    this.noise({ start, duration: 0.38, destination: output, frequency: 750 * pitch, frequencyEnd: 170, q: 0.7, gain: 1.45 });
    this.tone({ start, duration: 0.28, destination: output, frequency: 105 * pitch, frequencyEnd: 30, gain: 1.25 });
    this.noise({ start: start + 0.02, duration: 0.75, destination: output, filterType: 'lowpass', frequency: 900, frequencyEnd: 120, gain: 0.35, attack: 0.02 });
    // Pump: back...
    const pumpTime = start + 0.42;
    this.noise({ start: pumpTime, duration: 0.09, destination: output, frequency: 900, frequencyEnd: 1600, q: 2, gain: 0.22 });
    this.noise({ start: pumpTime + 0.08, duration: 0.03, destination: output, frequency: 2600, q: 5, gain: 0.5 });
    // ...and forward.
    this.noise({ start: pumpTime + 0.16, duration: 0.08, destination: output, frequency: 1500, frequencyEnd: 800, q: 2, gain: 0.2 });
    this.noise({ start: pumpTime + 0.23, duration: 0.03, destination: output, frequency: 1900, q: 5, gain: 0.55 });
    this.tone({ start: pumpTime + 0.23, duration: 0.05, destination: output, type: 'triangle', frequency: 420, frequencyEnd: 260, gain: 0.25 });
  },

  shot_rail(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.55, volume, lifetime: 2 });
    this.tone({ start, duration: 0.45, destination: output, type: 'sawtooth', frequency: 3400, frequencyEnd: 110, gain: 0.32 });
    this.tone({ start, duration: 0.5, destination: output, type: 'square', frequency: 1700, frequencyEnd: 70, gain: 0.12, detune: 12 });
    this.noise({ start, duration: 0.07, destination: output, filterType: 'highpass', frequency: 3500, gain: 0.9 });
    this.noise({ start, duration: 0.3, destination: output, frequency: 2400, frequencyEnd: 500, q: 1.5, gain: 0.5 });
    this.tone({ start, duration: 0.55, destination: output, frequency: 75, frequencyEnd: 32, gain: 1.0 });
    this.tone({ start: start + 0.02, duration: 0.9, destination: output, frequency: 2350, frequencyEnd: 2650, gain: 0.045, attack: 0.05 });
    // Capacitor recharge whine.
    this.tone({ start: start + 0.5, duration: 0.65, destination: output, frequency: 280, frequencyEnd: 1900, gain: 0.05, attack: 0.2, release: 0.1 });
  },

  reload(start, { weaponId = 'ak47', duration = 1.4 } = {}) {
    const output = this.createOutput({ reverb: 0.08, lifetime: duration + 0.5 });
    const click = (time, frequency, gain = 0.45) => {
      this.noise({ start: time, duration: 0.03, destination: output, frequency, q: 4, gain });
      this.tone({ start: time, duration: 0.04, destination: output, type: 'triangle', frequency: frequency * 0.3, frequencyEnd: frequency * 0.18, gain: gain * 0.5 });
    };
    const slide = (time, from, to, length = 0.12, gain = 0.22) => this.noise({ start: time, duration: length, destination: output, frequency: from, frequencyEnd: to, q: 1.5, gain });
    const clunk = (time, gain = 0.5) => {
      this.tone({ start: time, duration: 0.07, destination: output, frequency: 260, frequencyEnd: 120, gain });
      this.noise({ start: time, duration: 0.05, destination: output, frequency: 2200, q: 2, gain: gain * 1.1 });
    };

    if (weaponId === 'pistol' || weaponId === 'deagle' || weaponId === 'glock18') {
      click(start + 0.08, 3400, 0.45);                // mag release
      slide(start + 0.12, 1600, 900, 0.1, 0.18);      // mag out
      clunk(start + duration * 0.55, 0.4);            // mag in
      click(start + duration * 0.58, 2600, 0.4);
      slide(start + duration * 0.78, 2000, 3600, 0.07, 0.3); // slide racked
      click(start + duration * 0.86, 3000, 0.55);
      return;
    }
    if (weaponId === 'lmg') {
      clunk(start + 0.15, 0.4);                       // feed cover up
      slide(start + duration * 0.25, 900, 500, 0.3, 0.2); // old belt out
      clunk(start + duration * 0.45, 0.6);            // box mag in
      for (let link = 0; link < 4; link++) click(start + duration * (0.55 + link * 0.04), 2200 + link * 200, 0.25); // belt laid
      clunk(start + duration * 0.78, 0.6);            // cover slammed
      slide(start + duration * 0.86, 1600, 3000, 0.1, 0.3);
      click(start + duration * 0.92, 2500, 0.6);
      return;
    }
    if (weaponId === 'shotgun') {
      for (let shell = 0; shell < 4; shell++) {
        const time = start + duration * (0.12 + shell * 0.16);
        slide(time, 1200, 2000, 0.06, 0.15);
        click(time + 0.06, 2400, 0.4);
      }
      slide(start + duration * 0.82, 900, 1600, 0.09);
      click(start + duration * 0.86, 2600, 0.55);
      slide(start + duration * 0.9, 1500, 800, 0.08);
      click(start + duration * 0.94, 1900, 0.6);
    } else if (weaponId === 'rail') {
      this.tone({ start, duration: 0.35, destination: output, frequency: 1400, frequencyEnd: 180, gain: 0.08 });
      clunk(start + duration * 0.3, 0.45);
      slide(start + duration * 0.35, 2000, 700);
      clunk(start + duration * 0.6, 0.55);
      this.tone({ start: start + duration * 0.65, duration: duration * 0.3, destination: output, frequency: 200, frequencyEnd: 2600, gain: 0.07, attack: 0.05 });
      this.tone({ start: start + duration * 0.95, duration: 0.25, destination: output, frequency: 2600, gain: 0.08 });
    } else {
      click(start + 0.12, 3000, 0.5);                 // magazine release
      slide(start + 0.2, 1400, 700, 0.14);            // magazine out
      clunk(start + duration * 0.62, 0.55);           // fresh magazine in
      click(start + duration * 0.66, 2200, 0.45);
      slide(start + duration * 0.8, 1800, 3200, 0.1, 0.3);  // bolt back
      click(start + duration * 0.88, 2600, 0.6);      // bolt forward
    }
  },

  empty(start) {
    const output = this.createOutput({ lifetime: 0.3 });
    this.noise({ start, duration: 0.02, destination: output, frequency: 4200, q: 6, gain: 0.45 });
    this.tone({ start, duration: 0.03, destination: output, type: 'square', frequency: 1300, frequencyEnd: 900, gain: 0.06 });
  },

  weapon_switch(start) {
    const output = this.createOutput({ lifetime: 0.5 });
    this.noise({ start, duration: 0.18, destination: output, filterType: 'lowpass', frequency: 1000, gain: 0.25, attack: 0.03 });
    this.noise({ start: start + 0.13, duration: 0.03, destination: output, frequency: 3400, q: 5, gain: 0.45 });
    this.tone({ start: start + 0.13, duration: 0.05, destination: output, type: 'triangle', frequency: 700, frequencyEnd: 420, gain: 0.15 });
  },

  zoom(start) {
    const output = this.createOutput({ lifetime: 0.3 });
    this.noise({ start, duration: 0.06, destination: output, frequency: 2500, frequencyEnd: 1200, q: 3, gain: 0.12 });
  },

  footstep(start, { surface = 'grass' } = {}) {
    const output = this.createOutput({ volume: randomBetween(0.7, 1), lifetime: 0.3 });
    if (surface === 'wood') {
      this.noise({ start, duration: 0.07, destination: output, frequency: randomBetween(1200, 1600), q: 1.2, gain: 0.32 });
      this.tone({ start, duration: 0.08, destination: output, type: 'triangle', frequency: randomBetween(170, 200), frequencyEnd: 110, gain: 0.25 });
    } else {
      this.noise({ start, duration: 0.11, destination: output, filterType: 'lowpass', frequency: randomBetween(900, 1300), frequencyEnd: 300, gain: 0.3 });
      this.noise({ start: start + 0.02, duration: 0.06, destination: output, filterType: 'highpass', frequency: 4500, gain: 0.05 });
      this.tone({ start, duration: 0.06, destination: output, frequency: 85, frequencyEnd: 55, gain: 0.18 });
    }
  },

  jump(start) {
    const output = this.createOutput({ lifetime: 0.4 });
    this.noise({ start, duration: 0.16, destination: output, frequency: 500, frequencyEnd: 1300, q: 1, gain: 0.14, attack: 0.03 });
  },

  land(start, { fallSpeed = 8 } = {}) {
    const intensity = Math.min(1, fallSpeed / 18);
    const output = this.createOutput({ lifetime: 0.5 });
    this.tone({ start, duration: 0.16, destination: output, frequency: 120, frequencyEnd: 40, gain: 0.35 + intensity * 0.6 });
    this.noise({ start, duration: 0.14, destination: output, filterType: 'lowpass', frequency: 700, gain: 0.25 + intensity * 0.3 });
  },

  dash(start) {
    const output = this.createOutput({ reverb: 0.1, lifetime: 0.6 });
    this.noise({ start, duration: 0.32, destination: output, frequency: 450, frequencyEnd: 3000, q: 1.6, gain: 0.45, attack: 0.05 });
    this.noise({ start: start + 0.08, duration: 0.25, destination: output, frequency: 3200, frequencyEnd: 600, q: 1.2, gain: 0.2, attack: 0.04 });
    this.tone({ start, duration: 0.25, destination: output, frequency: 160, frequencyEnd: 90, gain: 0.15 });
  },

  hitmarker(start) {
    const output = this.createOutput({ lifetime: 0.2 });
    this.tone({ start, duration: 0.05, destination: output, frequency: 2200, gain: 0.3, attack: 0.001 });
    this.tone({ start, duration: 0.035, destination: output, frequency: 3300, gain: 0.12, attack: 0.001 });
  },

  headshot(start) {
    const output = this.createOutput({ lifetime: 0.6 });
    this.tone({ start, duration: 0.05, destination: output, frequency: 2600, gain: 0.3, attack: 0.001 });
    this.tone({ start: start + 0.02, duration: 0.32, destination: output, type: 'triangle', frequency: 1760, gain: 0.22 });
    this.tone({ start: start + 0.02, duration: 0.28, destination: output, frequency: 2637, gain: 0.08 });
  },

  kill(start) {
    const output = this.createOutput({ reverb: 0.15, lifetime: 0.8 });
    this.tone({ start, duration: 0.1, destination: output, frequency: 170, frequencyEnd: 80, gain: 0.45 });
    this.tone({ start, duration: 0.12, destination: output, type: 'triangle', frequency: 880, gain: 0.3 });
    this.tone({ start: start + 0.075, duration: 0.24, destination: output, type: 'triangle', frequency: 1320, gain: 0.3 });
    this.tone({ start: start + 0.075, duration: 0.24, destination: output, frequency: 1980, gain: 0.06 });
  },

  hurt(start) {
    const output = this.createOutput({ lifetime: 0.4 });
    const pitch = this.voicePitch;
    this.tone({ start, duration: 0.2, destination: output, frequency: 170 * pitch, frequencyEnd: 65 * pitch, gain: 0.55 });
    this.tone({ start, duration: 0.16, destination: output, type: 'sawtooth', frequency: 210 * pitch, frequencyEnd: 150 * pitch, gain: 0.05 }); // grunt
    this.noise({ start, duration: 0.15, destination: output, filterType: 'lowpass', frequency: 800, gain: 0.35 });
  },

  death(start) {
    const output = this.createOutput({ reverb: 0.5, lifetime: 2 });
    this.tone({ start, duration: 1.2, destination: output, frequency: 110, frequencyEnd: 30, gain: 0.6 });
    this.tone({ start, duration: 1.4, destination: output, type: 'triangle', frequency: 440, frequencyEnd: 110, gain: 0.08, attack: 0.05 });
    this.noise({ start, duration: 0.6, destination: output, filterType: 'lowpass', frequency: 500, frequencyEnd: 80, gain: 0.4 });
  },

  heartbeat(start) {
    const output = this.createOutput({ volume: 0.8, lifetime: 0.6 });
    this.tone({ start, duration: 0.13, destination: output, frequency: 62, frequencyEnd: 40, gain: 0.55 });
    this.tone({ start: start + 0.19, duration: 0.12, destination: output, frequency: 56, frequencyEnd: 38, gain: 0.38 });
  },

  respawn(start) {
    const output = this.createOutput({ reverb: 0.4, lifetime: 1.2 });
    this.tone({ start, duration: 0.55, destination: output, frequency: 220, frequencyEnd: 880, gain: 0.16, attack: 0.05 });
    this.tone({ start: start + 0.1, duration: 0.6, destination: output, type: 'triangle', frequency: 660, frequencyEnd: 1320, gain: 0.08, attack: 0.05 });
    this.noise({ start, duration: 0.5, destination: output, filterType: 'highpass', frequency: 5000, gain: 0.05, attack: 0.1 });
  },

  shatter(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.2, lifetime: 1 });
    for (let piece = 0; piece < 7; piece++) {
      const time = start + randomBetween(0, 0.25);
      this.noise({ start: time, duration: 0.04, destination: output, frequency: randomBetween(1500, 3500), q: 3, gain: 0.3 });
      this.tone({ start: time, duration: 0.05, destination: output, type: 'triangle', frequency: randomBetween(300, 700), frequencyEnd: 200, gain: 0.12 });
    }
    this.tone({ start, duration: 0.2, destination: output, frequency: 140, frequencyEnd: 60, gain: 0.4 });
  },

  whiz(start, { position = null } = {}) {
    const output = this.createOutput({ position, lifetime: 0.4 });
    this.noise({ start, duration: 0.2, destination: output, frequency: 3600, frequencyEnd: 800, q: 3.5, gain: 0.55, attack: 0.03 });
    this.noise({ start: start + 0.01, duration: 0.03, destination: output, filterType: 'highpass', frequency: 6000, gain: 0.25 }); // supersonic crack
  },

  impact(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.1, volume: 0.8, lifetime: 0.6 });
    this.noise({ start, duration: 0.05, destination: output, frequency: randomBetween(1800, 3200), q: 1.5, gain: 0.35 });
    this.noise({ start, duration: 0.1, destination: output, filterType: 'lowpass', frequency: 700, gain: 0.15 });
    if (Math.random() < 0.22) {
      this.tone({ start: start + 0.01, duration: 0.28, destination: output, frequency: randomBetween(3200, 4200), frequencyEnd: randomBetween(1800, 2400), gain: 0.06 }); // ricochet
    }
  },

  barrel_hit(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.25, lifetime: 0.8 });
    this.tone({ start, duration: 0.35, destination: output, type: 'triangle', frequency: 520, gain: 0.25 });
    this.tone({ start, duration: 0.28, destination: output, frequency: 1370, gain: 0.1 });
    this.tone({ start, duration: 0.22, destination: output, frequency: 2210, gain: 0.05 });
    this.noise({ start, duration: 0.04, destination: output, frequency: 4000, q: 2, gain: 0.35 });
  },

  explosion(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.85, volume: 1.2, lifetime: 3 });
    this.tone({ start, duration: 1.5, destination: output, frequency: 75, frequencyEnd: 22, gain: 1.4, attack: 0.004 });
    this.noise({ start, duration: 1.7, destination: output, filterType: 'lowpass', frequency: 3200, frequencyEnd: 120, gain: 1.6, attack: 0.004 });
    this.noise({ start, duration: 0.12, destination: output, filterType: 'highpass', frequency: 1800, gain: 0.9 });
    for (let crackle = 0; crackle < 16; crackle++) {
      this.noise({ start: start + randomBetween(0.05, 0.9), duration: 0.03, destination: output, frequency: randomBetween(1200, 4000), q: 2, gain: randomBetween(0.1, 0.35) });
    }
    for (let debris = 0; debris < 6; debris++) {
      const time = start + randomBetween(0.6, 1.6);
      this.tone({ start: time, duration: 0.08, destination: output, type: 'triangle', frequency: randomBetween(400, 900), frequencyEnd: 250, gain: 0.08 });
    }
  },

  shot_m4(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.26, volume, lifetime: 1 });
    const pitch = randomBetween(0.95, 1.05);
    this.noise({ start, duration: 0.04, destination: output, filterType: 'highpass', frequency: 3200 * pitch, gain: 0.85 });
    this.noise({ start, duration: 0.13, destination: output, frequency: 1500 * pitch, frequencyEnd: 520, q: 1.0, gain: 0.95 });
    this.tone({ start, duration: 0.1, destination: output, frequency: 175 * pitch, frequencyEnd: 55, gain: 0.8 });
    this.noise({ start: start + 0.01, duration: 0.3, destination: output, filterType: 'lowpass', frequency: 1600, frequencyEnd: 220, gain: 0.22, attack: 0.01 });
  },

  shot_lmg(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.32, volume, lifetime: 1.1 });
    const pitch = randomBetween(0.93, 1.04);
    this.noise({ start, duration: 0.05, destination: output, filterType: 'highpass', frequency: 2300 * pitch, gain: 0.9 });
    this.noise({ start, duration: 0.2, destination: output, frequency: 950 * pitch, frequencyEnd: 300, q: 0.8, gain: 1.25 });
    this.tone({ start, duration: 0.16, destination: output, frequency: 125 * pitch, frequencyEnd: 38, gain: 1.05 });
    this.noise({ start: start + 0.02, duration: 0.45, destination: output, filterType: 'lowpass', frequency: 1100, frequencyEnd: 150, gain: 0.3, attack: 0.015 });
    this.noise({ start: start + 0.035, duration: 0.025, destination: output, frequency: 3600, q: 5, gain: 0.15 }); // belt link
  },

  shot_pistol(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.22, volume, lifetime: 0.8 });
    const pitch = randomBetween(0.95, 1.06);
    this.noise({ start, duration: 0.035, destination: output, filterType: 'highpass', frequency: 3600 * pitch, gain: 0.75 });
    this.noise({ start, duration: 0.1, destination: output, frequency: 1800 * pitch, frequencyEnd: 700, q: 1.1, gain: 0.8 });
    this.tone({ start, duration: 0.07, destination: output, frequency: 230 * pitch, frequencyEnd: 80, gain: 0.55 });
    this.noise({ start: start + 0.03, duration: 0.02, destination: output, frequency: 4800, q: 6, gain: 0.18 }); // slide snap
  },

  shot_deagle(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.45, volume, lifetime: 1.5 });
    const pitch = randomBetween(0.95, 1.04);
    this.noise({ start, duration: 0.06, destination: output, filterType: 'highpass', frequency: 2200, gain: 1.0 });
    this.noise({ start, duration: 0.28, destination: output, frequency: 900 * pitch, frequencyEnd: 220, q: 0.8, gain: 1.35 });
    this.tone({ start, duration: 0.22, destination: output, frequency: 120 * pitch, frequencyEnd: 34, gain: 1.15 });
    this.noise({ start: start + 0.02, duration: 0.6, destination: output, filterType: 'lowpass', frequency: 1200, frequencyEnd: 140, gain: 0.32, attack: 0.02 });
  },

  shot_glock18(start, { position = null, volume = 1 } = {}) {
    const output = this.createOutput({ position, reverb: 0.18, volume: volume * 0.85, lifetime: 0.6 });
    const pitch = randomBetween(0.97, 1.08);
    this.noise({ start, duration: 0.03, destination: output, filterType: 'highpass', frequency: 3800 * pitch, gain: 0.7 });
    this.noise({ start, duration: 0.07, destination: output, frequency: 2000 * pitch, frequencyEnd: 900, q: 1.2, gain: 0.7 });
    this.tone({ start, duration: 0.05, destination: output, frequency: 260 * pitch, frequencyEnd: 110, gain: 0.45 });
  },

  knife_swing(start) {
    const output = this.createOutput({ lifetime: 0.5 });
    this.noise({ start, duration: 0.2, destination: output, frequency: randomBetween(1800, 2400), frequencyEnd: 600, q: 2.5, gain: 0.35, attack: 0.04 });
    this.noise({ start: start + 0.03, duration: 0.12, destination: output, filterType: 'highpass', frequency: 5000, gain: 0.07, attack: 0.03 });
  },

  knife_hit(start) {
    const output = this.createOutput({ reverb: 0.08, lifetime: 0.5 });
    this.tone({ start, duration: 0.12, destination: output, frequency: 150, frequencyEnd: 70, gain: 0.7 });
    this.noise({ start, duration: 0.09, destination: output, filterType: 'lowpass', frequency: 1400, frequencyEnd: 300, gain: 0.5 });
    this.noise({ start, duration: 0.04, destination: output, frequency: 3000, q: 1.5, gain: 0.25 });
  },

  knife_clang(start) {
    const output = this.createOutput({ reverb: 0.2, lifetime: 0.6 });
    this.tone({ start, duration: 0.25, destination: output, type: 'triangle', frequency: 1850, gain: 0.12 });
    this.tone({ start, duration: 0.2, destination: output, frequency: 3120, gain: 0.06 });
    this.noise({ start, duration: 0.04, destination: output, frequency: 4200, q: 3, gain: 0.35 });
  },

  pickup_weapon(start) {
    const output = this.createOutput({ lifetime: 0.6 });
    this.noise({ start, duration: 0.12, destination: output, filterType: 'lowpass', frequency: 1200, gain: 0.25, attack: 0.02 });
    this.noise({ start: start + 0.1, duration: 0.03, destination: output, frequency: 2800, q: 5, gain: 0.55 });
    this.tone({ start: start + 0.1, duration: 0.06, destination: output, type: 'triangle', frequency: 520, frequencyEnd: 300, gain: 0.2 });
    this.noise({ start: start + 0.22, duration: 0.03, destination: output, frequency: 3400, q: 5, gain: 0.5 });
  },

  pickup_armor(start) {
    const output = this.createOutput({ reverb: 0.15, lifetime: 0.9 });
    this.noise({ start, duration: 0.22, destination: output, frequency: 1600, frequencyEnd: 3800, q: 0.8, gain: 0.3, attack: 0.01 }); // velcro rip
    this.tone({ start: start + 0.18, duration: 0.18, destination: output, type: 'triangle', frequency: 660, gain: 0.18 });
    this.tone({ start: start + 0.26, duration: 0.3, destination: output, type: 'triangle', frequency: 990, gain: 0.18 });
    this.tone({ start: start + 0.26, duration: 0.3, destination: output, frequency: 1980, gain: 0.04 });
  },

  pickup_medkit(start) {
    const output = this.createOutput({ reverb: 0.1, lifetime: 0.6 });
    this.noise({ start, duration: 0.08, destination: output, filterType: 'lowpass', frequency: 1800, gain: 0.2 });
    this.tone({ start: start + 0.04, duration: 0.14, destination: output, frequency: 880, gain: 0.15 });
    this.tone({ start: start + 0.12, duration: 0.18, destination: output, frequency: 1320, gain: 0.13 });
  },

  pickup_ammo(start) {
    const output = this.createOutput({ lifetime: 0.6 });
    for (let round = 0; round < 4; round++) {
      const time = start + round * 0.045 + randomBetween(0, 0.015);
      this.noise({ start: time, duration: 0.025, destination: output, frequency: randomBetween(3000, 4500), q: 6, gain: 0.3 });
      this.tone({ start: time, duration: 0.05, destination: output, type: 'triangle', frequency: randomBetween(2400, 3200), gain: 0.04 });
    }
    this.tone({ start, duration: 0.1, destination: output, frequency: 180, frequencyEnd: 110, gain: 0.25 });
  },

  medkit_use(start, { duration = 1.4 } = {}) {
    const output = this.createOutput({ lifetime: duration + 0.3 });
    this.noise({ start, duration: 0.25, destination: output, frequency: 2600, frequencyEnd: 4200, q: 0.9, gain: 0.25 }); // zipper
    this.noise({ start: start + 0.35, duration: 0.18, destination: output, frequency: 1200, frequencyEnd: 3000, q: 0.7, gain: 0.3 }); // bandage rip
    this.noise({ start: start + duration * 0.6, duration: 0.05, destination: output, filterType: 'highpass', frequency: 5500, gain: 0.15 }); // injector hiss
    this.noise({ start: start + duration * 0.62, duration: 0.3, destination: output, filterType: 'highpass', frequency: 6500, gain: 0.06, attack: 0.02 });
  },

  heal(start) {
    const output = this.createOutput({ reverb: 0.4, lifetime: 1.2 });
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
      this.tone({ start: start + index * 0.06, duration: 0.5, destination: output, frequency, gain: 0.1, attack: 0.02 });
    });
    this.tone({ start, duration: 0.7, destination: output, frequency: 260, frequencyEnd: 520, gain: 0.08, attack: 0.1 });
  },

  shield_hit(start) {
    const output = this.createOutput({ lifetime: 0.4 });
    this.tone({ start, duration: 0.14, destination: output, type: 'triangle', frequency: randomBetween(1500, 1800), gain: 0.16 });
    this.tone({ start, duration: 0.1, destination: output, frequency: randomBetween(2600, 3000), gain: 0.06 });
    this.noise({ start, duration: 0.05, destination: output, frequency: 3500, q: 2, gain: 0.25 });
  },

  shield_break(start) {
    const output = this.createOutput({ reverb: 0.35, lifetime: 1.2 });
    for (let shard = 0; shard < 9; shard++) {
      const time = start + randomBetween(0, 0.18);
      this.tone({ start: time, duration: 0.18, destination: output, type: 'triangle', frequency: randomBetween(2000, 4200), gain: 0.07 });
    }
    this.noise({ start, duration: 0.3, destination: output, filterType: 'highpass', frequency: 3000, gain: 0.4 });
    this.tone({ start, duration: 0.4, destination: output, frequency: 420, frequencyEnd: 90, gain: 0.3 });
  },

  weapon_drop(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.15, lifetime: 0.8 });
    for (let bounce = 0; bounce < 3; bounce++) {
      const time = start + bounce * (0.12 - bounce * 0.02);
      const gain = 0.45 / (bounce + 1);
      this.noise({ start: time, duration: 0.05, destination: output, frequency: randomBetween(1400, 2400), q: 1.5, gain });
      this.tone({ start: time, duration: 0.07, destination: output, type: 'triangle', frequency: randomBetween(300, 500), frequencyEnd: 200, gain: gain * 0.5 });
    }
  },

  supply_incoming(start) {
    const output = this.createOutput({ reverb: 0.3, lifetime: 5 });
    // Radio chirp + beeps.
    this.noise({ start, duration: 0.15, destination: output, frequency: 2500, q: 2, gain: 0.15 });
    [0.2, 0.42, 0.64].forEach((offset) => this.tone({ start: start + offset, duration: 0.14, destination: output, type: 'square', frequency: 1175, gain: 0.05 }));
    // Distant cargo plane flyby: rumbling noise sweeping through a lowpass.
    this.noise({ start: start + 0.4, duration: 4.2, destination: output, filterType: 'lowpass', frequency: 180, frequencyEnd: 520, q: 1.5, gain: 0.35, attack: 1.6 });
    this.tone({ start: start + 0.4, duration: 4.2, destination: output, type: 'sawtooth', frequency: 68, frequencyEnd: 52, gain: 0.04, attack: 1.6 });
  },

  supply_land(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.6, volume: 1.1, lifetime: 2 });
    this.tone({ start, duration: 0.6, destination: output, frequency: 90, frequencyEnd: 30, gain: 1.2 });
    this.noise({ start, duration: 0.5, destination: output, filterType: 'lowpass', frequency: 1800, frequencyEnd: 150, gain: 0.9 });
    this.noise({ start: start + 0.05, duration: 0.08, destination: output, frequency: 2400, q: 2, gain: 0.4 });
  },

  supply_open(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.35, lifetime: 1.5 });
    this.noise({ start, duration: 0.03, destination: output, frequency: 3000, q: 5, gain: 0.5 });          // latch
    this.noise({ start: start + 0.05, duration: 0.5, destination: output, filterType: 'highpass', frequency: 4000, frequencyEnd: 1500, gain: 0.35, attack: 0.02 }); // pressure hiss
    this.tone({ start: start + 0.15, duration: 0.25, destination: output, frequency: 220, frequencyEnd: 120, gain: 0.35 }); // lid thunk
    [784, 988, 1175, 1568].forEach((frequency, index) => this.tone({ start: start + 0.3 + index * 0.07, duration: 0.35, destination: output, type: 'triangle', frequency, gain: 0.12 }));
  },

  mission_complete(start) {
    const output = this.createOutput({ reverb: 0.4, lifetime: 1.6 });
    [659.25, 783.99, 987.77, 1318.5].forEach((frequency, index) => {
      this.tone({ start: start + index * 0.09, duration: 0.45, destination: output, type: 'triangle', frequency, gain: 0.14 });
    });
  },

  ui_hover(start) {
    const output = this.createOutput({ volume: 0.6, lifetime: 0.15 });
    this.tone({ start, duration: 0.035, destination: output, frequency: 2400, gain: 0.05, attack: 0.001 });
    this.noise({ start, duration: 0.02, destination: output, filterType: 'highpass', frequency: 6000, gain: 0.03 });
  },

  deploy(start) {
    const output = this.createOutput({ reverb: 0.5, volume: 1.1, lifetime: 2 });
    this.noise({ start, duration: 0.6, destination: output, frequency: 300, frequencyEnd: 3500, q: 1.2, gain: 0.4, attack: 0.25 }); // rising whoosh
    this.tone({ start: start + 0.5, duration: 0.7, destination: output, frequency: 80, frequencyEnd: 32, gain: 1.0 });                 // impact
    this.noise({ start: start + 0.5, duration: 0.4, destination: output, filterType: 'lowpass', frequency: 1500, frequencyEnd: 120, gain: 0.6 });
    this.tone({ start: start + 0.5, duration: 0.9, destination: output, type: 'sawtooth', frequency: 110, gain: 0.05, attack: 0.02, release: 0.4 });
    this.tone({ start: start + 0.5, duration: 0.9, destination: output, type: 'sawtooth', frequency: 164.8, gain: 0.04, attack: 0.02, release: 0.4 });
  },

  donkey_bray(start, { position = null } = {}) {
    // "Hee-haw": alternating high inhale and low exhale through vowel-like formant filters.
    const output = this.createOutput({ position, reverb: 0.3, volume: 1.2, lifetime: 2.4 });
    const context = this.context;
    const cycles = 2 + Math.floor(Math.random() * 2);
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const [offset, frequencyStart, frequencyEnd, formant, length] of [[0, 640, 820, 1500, 0.3], [0.32, 300, 210, 750, 0.42]]) {
        const time = start + cycle * 0.78 + offset;
        const oscillator = context.createOscillator();
        oscillator.type = 'sawtooth';
        oscillator.frequency.setValueAtTime(frequencyStart, time);
        oscillator.frequency.exponentialRampToValueAtTime(frequencyEnd, time + length);
        const vibrato = context.createOscillator();
        vibrato.frequency.value = 22;
        const vibratoDepth = context.createGain();
        vibratoDepth.gain.value = frequencyStart * 0.05;
        vibrato.connect(vibratoDepth).connect(oscillator.frequency);
        const filter = context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = formant;
        filter.Q.value = 3;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0.0001, time);
        envelope.gain.exponentialRampToValueAtTime(0.5, time + 0.05);
        envelope.gain.exponentialRampToValueAtTime(0.0001, time + length);
        oscillator.connect(filter).connect(envelope).connect(output);
        oscillator.start(time);
        vibrato.start(time);
        oscillator.stop(time + length + 0.05);
        vibrato.stop(time + length + 0.05);
        this.noise({ start: time, duration: length, destination: output, frequency: formant * 1.6, q: 1.2, gain: 0.06 });
      }
    }
  },

  donkey_hurt(start, { position = null } = {}) {
    const output = this.createOutput({ position, lifetime: 0.6 });
    this.tone({ start, duration: 0.3, destination: output, type: 'sawtooth', frequency: 700, frequencyEnd: 420, gain: 0.12 });
  },

  ability_granted(start) {
    const output = this.createOutput({ reverb: 0.5, lifetime: 2 });
    [880, 1108.7, 1318.5, 1760, 2217.5].forEach((frequency, index) => {
      this.tone({ start: start + index * 0.07, duration: 0.6, destination: output, type: 'triangle', frequency, gain: 0.12 });
    });
    this.noise({ start, duration: 0.8, destination: output, filterType: 'highpass', frequency: 6000, gain: 0.08, attack: 0.1 });
    this.tone({ start, duration: 0.9, destination: output, frequency: 110, frequencyEnd: 220, gain: 0.2, attack: 0.05 });
  },

  dog_bark(start, { position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.2, volume: 1.1, lifetime: 1 });
    for (const offset of [0, 0.22]) {
      const time = start + offset;
      this.tone({ start: time, duration: 0.12, destination: output, type: 'sawtooth', frequency: randomBetween(380, 440), frequencyEnd: 190, gain: 0.25 });
      this.noise({ start: time, duration: 0.1, destination: output, frequency: 1100, q: 2, gain: 0.35 });
    }
  },

  dog_bite(start, { position = null } = {}) {
    const output = this.createOutput({ position, lifetime: 0.6 });
    this.noise({ start, duration: 0.05, destination: output, frequency: 2600, q: 3, gain: 0.5 });
    this.tone({ start: start + 0.03, duration: 0.3, destination: output, type: 'sawtooth', frequency: 110, frequencyEnd: 85, gain: 0.12, attack: 0.02 }); // growl
  },

  dog_whimper(start, { position = null } = {}) {
    const output = this.createOutput({ position, lifetime: 1 });
    this.tone({ start, duration: 0.5, destination: output, frequency: 1200, frequencyEnd: 600, gain: 0.12 });
  },

  voxel_break(start, { materialType = 'block', position = null } = {}) {
    const output = this.createOutput({ position, reverb: 0.25, lifetime: 1.2 });
    if (materialType === 'wood') {
      this.noise({ start, duration: 0.12, destination: output, frequency: 1600, q: 1.5, gain: 0.5 });              // crack
      for (let splinter = 0; splinter < 4; splinter++) this.noise({ start: start + randomBetween(0.02, 0.18), duration: 0.03, destination: output, frequency: randomBetween(2500, 4500), q: 4, gain: 0.2 });
      this.tone({ start, duration: 0.1, destination: output, type: 'triangle', frequency: 240, frequencyEnd: 140, gain: 0.25 });
    } else if (materialType === 'metal') {
      this.tone({ start, duration: 0.5, destination: output, type: 'triangle', frequency: randomBetween(360, 460), gain: 0.18 });
      this.tone({ start, duration: 0.35, destination: output, frequency: randomBetween(1100, 1300), gain: 0.06 });
      this.noise({ start, duration: 0.08, destination: output, frequency: 3000, q: 2, gain: 0.3 });
    } else {
      this.noise({ start, duration: 0.45, destination: output, filterType: 'lowpass', frequency: 900, frequencyEnd: 180, gain: 0.55 }); // crumble
      for (let rock = 0; rock < 5; rock++) this.noise({ start: start + randomBetween(0.05, 0.4), duration: 0.03, destination: output, frequency: randomBetween(1200, 2600), q: 3, gain: 0.15 });
      this.tone({ start, duration: 0.18, destination: output, frequency: 90, frequencyEnd: 45, gain: 0.35 });
    }
  },

  teleport(start) {
    const output = this.createOutput({ reverb: 0.45, lifetime: 1.2 });
    this.tone({ start, duration: 0.35, destination: output, frequency: 220, frequencyEnd: 2600, gain: 0.25 });
    this.tone({ start: start + 0.05, duration: 0.4, destination: output, type: 'square', frequency: 1800, frequencyEnd: 300, gain: 0.05 });
    this.noise({ start, duration: 0.3, destination: output, frequency: 3000, frequencyEnd: 600, q: 2, gain: 0.3 });
  },

  prop_transform(start) {
    const output = this.createOutput({ reverb: 0.3, lifetime: 1 });
    this.noise({ start, duration: 0.4, destination: output, filterType: 'lowpass', frequency: 2400, frequencyEnd: 300, gain: 0.4 }); // poof
    this.tone({ start: start + 0.05, duration: 0.3, destination: output, type: 'triangle', frequency: 520, frequencyEnd: 1040, gain: 0.12 });
  },

  hyperspeed(start) {
    const output = this.createOutput({ reverb: 0.2, lifetime: 1.5 });
    this.noise({ start, duration: 1.0, destination: output, frequency: 400, frequencyEnd: 4000, q: 1, gain: 0.4, attack: 0.3 });
    this.tone({ start, duration: 0.9, destination: output, type: 'sawtooth', frequency: 90, frequencyEnd: 360, gain: 0.08, attack: 0.2 });
  },

  deadeye_in(start) {
    const output = this.createOutput({ reverb: 0.6, volume: 1.2, lifetime: 2 });
    this.noise({ start, duration: 0.7, destination: output, frequency: 3500, frequencyEnd: 200, q: 1.5, gain: 0.5, attack: 0.02 }); // reverse-whoosh down
    this.tone({ start, duration: 1.4, destination: output, frequency: 60, frequencyEnd: 40, gain: 0.6 });
    this.tone({ start: start + 0.1, duration: 1.4, destination: output, type: 'sawtooth', frequency: 110, frequencyEnd: 98, gain: 0.04, attack: 0.3 });
  },

  deadeye_out(start) {
    const output = this.createOutput({ reverb: 0.3, lifetime: 1 });
    this.noise({ start, duration: 0.45, destination: output, frequency: 300, frequencyEnd: 3500, q: 1.5, gain: 0.35, attack: 0.15 });
  },

  announcer(start, { tier = 1, kind = 'multikill' } = {}) {
    const output = this.createOutput({ reverb: 0.45, volume: 1.1, lifetime: 2 });
    const roots = [0, 220, 261.6, 293.7, 329.6, 392];
    const root = roots[Math.min(5, tier)] || 220;
    this.tone({ start, duration: 0.5, destination: output, frequency: 70, frequencyEnd: 40, gain: 0.7 });                       // impact
    this.noise({ start, duration: 0.25, destination: output, filterType: 'lowpass', frequency: 2000, frequencyEnd: 200, gain: 0.4 });
    if (kind === 'headshot') {
      this.tone({ start, duration: 0.6, destination: output, type: 'triangle', frequency: 2093, gain: 0.16 });
      this.tone({ start, duration: 0.5, destination: output, frequency: 3136, gain: 0.06 });
      return;
    }
    // Rising brass-like stab chord, bigger for higher multi-kills.
    [1, 1.26, 1.5, tier >= 3 ? 2 : null, tier >= 4 ? 2.52 : null].filter(Boolean).forEach((ratio) => {
      this.tone({ start: start + 0.02, duration: 0.7, destination: output, type: 'sawtooth', frequency: root * ratio, gain: 0.05, attack: 0.02, release: 0.3 });
      this.tone({ start: start + 0.02, duration: 0.7, destination: output, type: 'triangle', frequency: root * ratio * 2, gain: 0.06, attack: 0.01 });
    });
  },

  flag_taken(start) {
    const output = this.createOutput({ reverb: 0.3, lifetime: 1.2 });
    [659.25, 987.77].forEach((frequency, index) => this.tone({ start: start + index * 0.12, duration: 0.3, destination: output, type: 'triangle', frequency, gain: 0.16 }));
  },

  flag_alarm(start) {
    const output = this.createOutput({ reverb: 0.3, lifetime: 1.6 });
    for (let pulse = 0; pulse < 3; pulse++) {
      this.tone({ start: start + pulse * 0.32, duration: 0.15, destination: output, type: 'square', frequency: 880, gain: 0.07 });
      this.tone({ start: start + pulse * 0.32 + 0.16, duration: 0.15, destination: output, type: 'square', frequency: 660, gain: 0.07 });
    }
  },

  weather_alert(start) {
    const output = this.createOutput({ reverb: 0.6, lifetime: 3 });
    this.tone({ start, duration: 2.4, destination: output, type: 'sawtooth', frequency: 320, frequencyEnd: 520, gain: 0.05, attack: 0.8, release: 0.8 }); // siren swell
    this.noise({ start, duration: 2.6, destination: output, filterType: 'lowpass', frequency: 300, frequencyEnd: 900, gain: 0.25, attack: 1.2 });
  },

  thunder(start) {
    const output = this.createOutput({ reverb: 0.9, volume: 1.3, lifetime: 4 });
    this.noise({ start, duration: 0.15, destination: output, filterType: 'highpass', frequency: 1500, gain: 0.5 });
    this.noise({ start: start + 0.05, duration: 3.2, destination: output, filterType: 'lowpass', frequency: 600, frequencyEnd: 60, gain: 1.0, attack: 0.08 });
    this.tone({ start: start + 0.05, duration: 2.5, destination: output, frequency: 55, frequencyEnd: 28, gain: 0.6 });
  },

  cricket(start) {
    const output = this.createOutput({ bus: this.ambientBus, volume: 0.4, lifetime: 1.5 });
    for (let chirp = 0; chirp < 6; chirp++) {
      this.tone({ start: start + chirp * 0.08, duration: 0.04, destination: output, frequency: randomBetween(4200, 4600), gain: 0.05, attack: 0.005 });
    }
  },

  flashlight_click(start) {
    const output = this.createOutput({ lifetime: 0.2 });
    this.noise({ start, duration: 0.02, destination: output, frequency: 3800, q: 6, gain: 0.35 });
  },

  tag_confirm(start) {
    const output = this.createOutput({ reverb: 0.35, lifetime: 1 });
    [1046.5, 1318.5, 1568, 2093].forEach((frequency, index) => {
      this.tone({ start: start + index * 0.065, duration: 0.28, destination: output, type: 'triangle', frequency, gain: 0.2 });
      this.tone({ start: start + index * 0.065, duration: 0.2, destination: output, frequency: frequency * 2, gain: 0.04 });
    });
    this.noise({ start, duration: 0.35, destination: output, filterType: 'highpass', frequency: 7000, gain: 0.06, attack: 0.05 });
  },

  tag_deny(start) {
    const output = this.createOutput({ reverb: 0.2, lifetime: 0.6 });
    this.tone({ start, duration: 0.14, destination: output, type: 'triangle', frequency: 784, gain: 0.2 });
    this.tone({ start: start + 0.11, duration: 0.2, destination: output, type: 'triangle', frequency: 1175, gain: 0.2 });
  },

  tag_ally(start, { position = null } = {}) {
    const output = this.createOutput({ position, volume: 0.6, lifetime: 0.6 });
    this.tone({ start, duration: 0.18, destination: output, type: 'triangle', frequency: 1318, gain: 0.15 });
    this.tone({ start: start + 0.07, duration: 0.2, destination: output, type: 'triangle', frequency: 1760, gain: 0.12 });
  },

  tag_lost(start) {
    const output = this.createOutput({ volume: 0.7, lifetime: 0.6 });
    this.tone({ start, duration: 0.18, destination: output, type: 'square', frequency: 330, frequencyEnd: 220, gain: 0.06 });
    this.tone({ start: start + 0.14, duration: 0.22, destination: output, type: 'square', frequency: 247, frequencyEnd: 165, gain: 0.06 });
  },

  countdown(start, { secondsLeft = 10 } = {}) {
    const output = this.createOutput({ lifetime: 0.3 });
    this.tone({ start, duration: 0.12, destination: output, type: 'square', frequency: secondsLeft <= 3 ? 1320 : 880, gain: 0.07 });
  },

  ui_click(start) {
    const output = this.createOutput({ lifetime: 0.2 });
    this.tone({ start, duration: 0.05, destination: output, frequency: 1250, gain: 0.14, attack: 0.001 });
    this.tone({ start: start + 0.02, duration: 0.04, destination: output, frequency: 1870, gain: 0.07, attack: 0.001 });
  },

  bird(start) {
    const angle = Math.random() * Math.PI * 2;
    const distance = randomBetween(18, 45);
    const position = {
      x: this.listenerPosition.x + Math.cos(angle) * distance,
      y: this.listenerPosition.y + randomBetween(6, 14),
      z: this.listenerPosition.z + Math.sin(angle) * distance,
    };
    const output = this.createOutput({ position, bus: this.ambientBus, volume: 0.5, lifetime: 1.5 });
    const chirps = 2 + Math.floor(Math.random() * 4);
    const baseFrequency = randomBetween(2400, 3600);
    for (let chirp = 0; chirp < chirps; chirp++) {
      const time = start + chirp * randomBetween(0.09, 0.14);
      this.tone({ start: time, duration: 0.07, destination: output, frequency: baseFrequency, frequencyEnd: baseFrequency * randomBetween(1.15, 1.4), gain: 0.06 });
    }
  },

  victory(start) {
    const output = this.createOutput({ reverb: 0.5, bus: this.musicBus, volume: 2.2, lifetime: 3 });
    const melody = [60, 64, 67, 72, 76, 79];
    melody.forEach((midiNote, index) => {
      this.tone({ start: start + index * 0.11, duration: 0.35, destination: output, type: 'triangle', frequency: midiToFrequency(midiNote), gain: 0.18 });
    });
    [72, 76, 79, 84].forEach((midiNote) => {
      this.tone({ start: start + 0.7, duration: 1.8, destination: output, type: 'sawtooth', frequency: midiToFrequency(midiNote), gain: 0.05, attack: 0.05, release: 0.6 });
      this.tone({ start: start + 0.7, duration: 1.8, destination: output, type: 'triangle', frequency: midiToFrequency(midiNote), gain: 0.1, attack: 0.02 });
    });
  },

  defeat(start) {
    const output = this.createOutput({ reverb: 0.6, bus: this.musicBus, volume: 2.2, lifetime: 3 });
    [67, 63, 60, 55].forEach((midiNote, index) => {
      this.tone({ start: start + index * 0.28, duration: 0.6, destination: output, type: 'triangle', frequency: midiToFrequency(midiNote), gain: 0.18 });
    });
    [48, 51, 55].forEach((midiNote) => {
      this.tone({ start: start + 1.1, duration: 1.8, destination: output, type: 'sawtooth', frequency: midiToFrequency(midiNote), gain: 0.05, attack: 0.1, release: 0.8 });
    });
  },
};
