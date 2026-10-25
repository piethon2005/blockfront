// =====================================================================
// Announcer — tracks the player's kills and announces combat feats:
//   Headshot, Single / Double / Triple / Quad / Multi kill (kills chained
//   inside a short window) and kill streaks (Killing Spree, Rampage...).
// Emits `announce` { title, subtitle, tier, kind } for the HUD banner and
// the audio stinger.
// =====================================================================

import { ANNOUNCER } from '../config.js';
import { events } from '../core/events.js';

export class Announcer {
  constructor() {
    this.chainCount = 0;
    this.chainTimer = 0;
    this.streak = 0;
    events.on('feed:add', (entry) => this.onKillFeed(entry));
    events.on('player:death', () => { this.streak = 0; });
    events.on('match:start', () => {
      this.chainCount = 0;
      this.chainTimer = 0;
      this.streak = 0;
    });
  }

  onKillFeed({ killer, killerTeam, victimTeam, isHeadshot, weaponId }) {
    if (killer !== 'You' || (killerTeam && victimTeam === killerTeam)) return;
    this.chainCount = this.chainTimer > 0 ? this.chainCount + 1 : 1;
    this.chainTimer = ANNOUNCER.multiKillWindow;
    this.streak++;

    const chainTitle = ANNOUNCER.titles[Math.min(5, this.chainCount)];
    const streakTitle = ANNOUNCER.streaks[this.streak];
    const subtitle = [isHeadshot ? 'HEADSHOT' : null, weaponId === 'pet' ? 'K9 TAKEDOWN' : null, streakTitle].filter(Boolean).join(' · ');

    if (isHeadshot && this.chainCount === 1) {
      events.emit('announce', { title: 'HEADSHOT', subtitle: streakTitle || 'SINGLE KILL', tier: 1, kind: 'headshot' });
    } else {
      events.emit('announce', { title: chainTitle, subtitle, tier: Math.min(5, this.chainCount), kind: 'multikill' });
    }
    if (this.chainCount === 3) events.emit('announce:triple', {});
  }

  update(deltaSeconds) {
    if (this.chainTimer > 0) this.chainTimer -= deltaSeconds;
  }
}
