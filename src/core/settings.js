// =====================================================================
// Persistent user settings and career stats (volume, sensitivity,
// graphics quality, callsign, loadout, mission progress).
// localStorage can be unavailable (private mode, some file:// pages),
// so every access is guarded and the game works without it.
// =====================================================================

import { AUDIO_DEFAULTS, DEFAULT_LOADOUT, GENDERS, STORAGE_KEY, TRAITS, WEAPONS } from '../config.js';

const defaultStats = {
  bestMatchKills: 0,
  tagsConfirmed: 0,
  wins: 0,
  headshotKills: 0,
  meleeKills: 0,
  barrelKills: 0,
  suppliesOpened: 0,
  medkitsUsed: 0,
  totalKills: 0,
  matchesPlayed: 0,
  donkeysHunted: 0,
  flagsCaptured: 0,
  voxelsDestroyed: 0,
  tripleKills: 0,
};

const defaultSettings = {
  volumeMaster: AUDIO_DEFAULTS.master,
  volumeMusic: AUDIO_DEFAULTS.music,
  volumeSfx: AUDIO_DEFAULTS.sfx,
  mouseSensitivityScale: 1,
  graphicsQuality: 'high',
  nickname: 'PlayerOne',
  gender: 'male',
  trait: 'none',
  loadout: { ...DEFAULT_LOADOUT },
  stats: { ...defaultStats },
};

function readStoredSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Drop any loadout entry that no longer names a valid loadout weapon for its slot. */
function sanitizeLoadout(loadout = {}) {
  const clean = { ...DEFAULT_LOADOUT };
  for (const slot of Object.keys(DEFAULT_LOADOUT)) {
    const weapon = WEAPONS[loadout[slot]];
    if (weapon && weapon.slot === slot && weapon.loadout) clean[slot] = weapon.id;
  }
  return clean;
}

const stored = readStoredSettings();
export const settings = {
  ...defaultSettings,
  ...stored,
  loadout: sanitizeLoadout(stored.loadout),
  stats: { ...defaultStats, ...(stored.stats || {}) },
};
if (!GENDERS[settings.gender]) settings.gender = 'male';
if (!TRAITS[settings.trait]) settings.trait = 'none';

export function saveSettings(partialSettings = {}) {
  Object.assign(settings, partialSettings);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked — settings simply won't persist between sessions.
  }
}
