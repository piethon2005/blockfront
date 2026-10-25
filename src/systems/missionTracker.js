// =====================================================================
// Mission tracker — listens to gameplay events, updates persistent
// career stats (saved in settings.stats) and announces completed missions.
// The Missions panel in the menu reads progress through getProgress().
// =====================================================================

import { MISSIONS, WEAPONS } from '../config.js';
import { events } from '../core/events.js';
import { saveSettings, settings } from '../core/settings.js';

export class MissionTracker {
  constructor() {
    this.matchKills = 0;
    this.bindEvents();
  }

  get stats() {
    return settings.stats;
  }

  /** [{ mission, value, complete }] for the menu. */
  getProgress() {
    return MISSIONS.map((mission) => {
      const value = Math.min(mission.goal, this.stats[mission.stat] || 0);
      return { mission, value, complete: value >= mission.goal };
    });
  }

  increment(stat, amount = 1) {
    this.setStat(stat, (this.stats[stat] || 0) + amount);
  }

  setStat(stat, value) {
    const completedBefore = new Set(this.getProgress().filter((entry) => entry.complete).map((entry) => entry.mission.id));
    settings.stats[stat] = value;
    saveSettings({ stats: settings.stats });
    for (const entry of this.getProgress()) {
      if (entry.complete && !completedBefore.has(entry.mission.id)) {
        events.emit('notify', { text: `MISSION COMPLETE: ${entry.mission.title}`, tone: 'elite' });
        events.emit('mission:complete', { mission: entry.mission });
      }
    }
  }

  flushVoxels() {
    if (!this.pendingVoxels) return;
    const amount = this.pendingVoxels;
    this.pendingVoxels = 0;
    this.increment('voxelsDestroyed', amount);
  }

  bindEvents() {
    events.on('match:start', () => {
      this.matchKills = 0;
      this.increment('matchesPlayed');
    });
    events.on('feed:add', ({ killer, killerTeam, victimTeam, weaponId, isHeadshot }) => {
      if (killer !== 'You' || (killerTeam && victimTeam === killerTeam)) return;
      this.matchKills++;
      this.increment('totalKills');
      if (this.matchKills > (this.stats.bestMatchKills || 0)) this.setStat('bestMatchKills', this.matchKills);
      if (isHeadshot) this.increment('headshotKills');
      if (weaponId === 'barrel') this.increment('barrelKills');
      if (weaponId && WEAPONS[weaponId] && WEAPONS[weaponId].isMelee) this.increment('meleeKills');
    });
    events.on('tag:pickup', ({ isPlayer, denied }) => {
      if (isPlayer && !denied) this.increment('tagsConfirmed');
    });
    events.on('supply:opened', () => this.increment('suppliesOpened'));
    events.on('medkit:used', () => this.increment('medkitsUsed'));
    events.on('match:end', ({ result }) => {
      if (result === 'victory') this.increment('wins');
      this.flushVoxels();
    });
    events.on('donkey:killed', ({ byPlayer }) => byPlayer && this.increment('donkeysHunted'));
    events.on('flag:captured', ({ isPlayer }) => isPlayer && this.increment('flagsCaptured'));
    events.on('announce:triple', () => this.increment('tripleKills'));
    // Voxel destruction is very frequent: batch it and save every few seconds.
    this.pendingVoxels = 0;
    events.on('voxel:destroyed', ({ byPlayer }) => { if (byPlayer) this.pendingVoxels++; });
    setInterval(() => this.flushVoxels(), 4000);
  }
}
