// =====================================================================
// HUD — tactical in-match overlay: timer, team scores, scoreboard,
// coins, kill feed, toasts, pickup notifications, shield + health bars,
// med-kit counter and heal channel, dash meter, magazine / reserve ammo,
// inventory slots, interaction prompts, dynamic crosshair, hit markers,
// damage direction, vignettes, sniper scope and a radar with
// supply-drop tracking. Discrete facts arrive through events;
// continuous values are pushed each frame through update().
// =====================================================================

import { BOT, CTF, LOOT, MATCH, PET, PLAYER, TEAMS, WEAPON_SLOTS } from '../config.js';
import { events } from '../core/events.js';

const getElement = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = getElement('hud');
    this.elements = {
      timer: getElement('timer-value'),
      timerBox: document.querySelector('.hud-timer'),
      scoreboard: getElement('scoreboard'),
      scoreRed: getElement('score-red'),
      scoreBlue: getElement('score-blue'),
      scoreGoal: getElement('score-goal'),
      coins: getElement('coin-count'),
      killfeed: getElement('killfeed'),
      notifications: getElement('notifications'),
      playerName: getElement('player-name'),
      healthValue: getElement('health-value'),
      healthBar: getElement('health-bar'),
      shieldValue: getElement('shield-value'),
      shieldBar: getElement('shield-bar'),
      shieldRow: getElement('shield-row'),
      medkitCount: getElement('medkit-count'),
      medkitBox: getElement('medkit-box'),
      healBar: getElement('heal-bar'),
      healFill: getElement('heal-fill'),
      dashBar: getElement('dash-bar'),
      ammoPanel: getElement('ammo-panel'),
      ammoCurrent: getElement('ammo-current'),
      ammoReserve: getElement('ammo-reserve'),
      weaponName: getElement('weapon-name'),
      weaponSlots: getElement('weapon-slots'),
      reloadBar: getElement('reload-bar'),
      reloadFill: getElement('reload-fill'),
      prompt: getElement('interact-prompt'),
      promptText: getElement('interact-text'),
      crosshair: getElement('crosshair'),
      hitmarker: getElement('hitmarker'),
      toast: getElement('toast'),
      damageIndicator: getElement('damage-indicator'),
      damageVignette: getElement('damage-vignette'),
      lowHealthVignette: getElement('lowhp-vignette'),
      scope: getElement('scope-overlay'),
      radar: getElement('radar'),
      supplyTracker: getElement('supply-tracker'),
      flagStatus: getElement('flag-status'),
      weatherBadge: getElement('weather-badge'),
      announce: getElement('announce'),
      announceTitle: getElement('announce-title'),
      announceSubtitle: getElement('announce-subtitle'),
      abilityPanel: getElement('ability-panel'),
      abilityIcon: getElement('ability-icon'),
      abilityName: getElement('ability-name'),
      abilityHint: getElement('ability-hint'),
      abilityFill: getElement('ability-fill'),
      petStatus: getElement('pet-status'),
      petState: getElement('pet-state'),
      petBar: getElement('pet-bar'),
      traitBadge: getElement('trait-badge'),
      stance: getElement('stance-indicator'),
      deadeyeOverlay: getElement('deadeye-overlay'),
      speedLines: getElement('speed-lines'),
      disguiseOverlay: getElement('disguise-overlay'),
      disguiseText: getElement('disguise-text'),
    };
    this.radarContext = this.elements.radar.getContext('2d');
    this.feedEntries = [];
    this.notificationEntries = [];
    this.damageFlash = 0;
    this.damageIndicatorTimer = 0;
    this.damageSourcePosition = null;
    this.displayName = PLAYER.displayNameFallback;
    this.lastPoints = {};
    this.frameCounter = 0;
    this.slotSignature = '';
    this.bindEvents();
  }

  show() {
    this.root.classList.remove('is-hidden');
  }

  // ------------------------------------------------------------------ online: network badge + chat
  setOnline(isOnline, roomCode = '') {
    document.getElementById('hud-net').classList.toggle('is-hidden', !isOnline);
    document.getElementById('hud-net-room').textContent = `ROOM ${roomCode}`;
    this.chatLines = this.chatLines || [];
    if (!isOnline) {
      document.getElementById('hud-chat-log').innerHTML = '';
      this.chatLines = [];
      this.closeChat();
    }
  }

  setPing(ping) {
    const element = document.getElementById('hud-net-ping');
    element.textContent = `${ping} ms`;
    element.classList.toggle('is-bad', ping > 180);
  }

  addChatLine({ name, text, system, team }) {
    const log = document.getElementById('hud-chat-log');
    const line = document.createElement('div');
    if (system) {
      line.className = 'is-system';
      line.textContent = `» ${text}`;
    } else {
      line.className = team ? `team-${team}` : '';
      line.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
    }
    log.appendChild(line);
    this.chatLines = this.chatLines || [];
    this.chatLines.push({ element: line, timeLeft: 9 });
    while (this.chatLines.length > 7) this.chatLines.shift().element.remove();
  }

  get isChatOpen() {
    return !document.getElementById('hud-chat-form').classList.contains('is-hidden');
  }

  openChat() {
    const form = document.getElementById('hud-chat-form');
    form.classList.remove('is-hidden');
    document.getElementById('hud-chat').classList.add('is-open');
    const input = document.getElementById('hud-chat-input');
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }

  closeChat() {
    document.getElementById('hud-chat-form').classList.add('is-hidden');
    document.getElementById('hud-chat').classList.remove('is-open');
    const input = document.getElementById('hud-chat-input');
    input.blur();
  }

  updateChat(deltaSeconds) {
    if (!this.chatLines) return;
    for (const line of this.chatLines) {
      line.timeLeft -= deltaSeconds;
      line.element.classList.toggle('is-faded', line.timeLeft <= 0);
    }
  }

  hide() {
    this.root.classList.add('is-hidden');
    this.elements.scope.classList.remove('is-active');
  }

  setPlayerName(name) {
    this.displayName = name;
    this.elements.playerName.textContent = name;
    this.renderScoreboard(this.lastPoints);
  }

  setScoreGoal(mode) {
    this.elements.scoreGoal.textContent = `FIRST TO ${mode.scoreGoal}`;
  }

  /** names: Map(name -> team) for everyone except the local player. */
  setTeams(teamByName, ourTeam = 'blue') {
    this.teamByName = teamByName;
    this.ourTeam = ourTeam;
    const redLabel = document.getElementById('score-red-label');
    const blueLabel = document.getElementById('score-blue-label');
    if (redLabel) redLabel.textContent = ourTeam === 'red' ? 'RED SQUAD (YOU)' : 'HOSTILES';
    if (blueLabel) blueLabel.textContent = ourTeam === 'blue' ? 'BRAVO SQUAD' : 'BLUE HOSTILES';
    this.renderScoreboard(this.lastPoints);
  }

  // ------------------------------------------------------------------ events
  bindEvents() {
    events.on('score:changed', ({ scores, team }) => {
      this.elements.scoreRed.textContent = scores.red;
      this.elements.scoreBlue.textContent = scores.blue;
      if (team) this.bump(team === 'red' ? this.elements.scoreRed : this.elements.scoreBlue);
    });
    events.on('board:changed', ({ points }) => this.renderScoreboard(points));
    events.on('coins:changed', ({ coins }) => { this.elements.coins.textContent = coins; });
    events.on('feed:add', (entry) => this.addFeedEntry(entry));
    events.on('toast', ({ text, style }) => this.showToast(text, style));
    events.on('notify', ({ text, tone }) => this.addNotification(text, tone));
    events.on('hit:confirm', ({ isKill, isHeadshot }) => this.showHitmarker(isKill, isHeadshot));
    events.on('player:hurt', ({ sourcePosition, absorbed, amount }) => {
      this.damageFlash = absorbed >= amount ? 0.35 : 0.85;
      this.elements.damageVignette.classList.toggle('is-shield', absorbed >= amount);
      if (sourcePosition) {
        this.damageSourcePosition = sourcePosition;
        this.damageIndicatorTimer = 1.2;
      }
    });
    events.on('armor:changed', ({ gained }) => {
      if (gained > 0) this.bump(this.elements.shieldRow);
    });
    events.on('player:respawn', () => this.showToast('DEPLOYED', 'default'));
    events.on('inventory:changed', ({ inventory }) => this.renderSlots(inventory));
    events.on('announce', (payload) => this.showAnnouncement(payload));
    events.on('weather:start', ({ event }) => {
      this.elements.weatherBadge.textContent = `⚠ ${event.name}`;
      this.elements.weatherBadge.classList.add('is-visible');
    });
    events.on('ability:activated', ({ propKind }) => { this.elements.disguiseText.textContent = `DISGUISED AS ${propKind} — DON'T SPRINT OR SHOOT`; });
  }

  bump(element) {
    element.classList.remove('is-bumped');
    void element.offsetWidth;
    element.classList.add('is-bumped');
    setTimeout(() => element.classList.remove('is-bumped'), 220);
  }

  renderScoreboard(points) {
    this.lastPoints = points;
    const teamOf = (name) => {
      if (name === 'You') return 'you';
      return (this.teamByName && this.teamByName.get(name)) || 'blue';
    };
    this.elements.scoreboard.innerHTML = Object.entries(points)
      .sort((first, second) => second[1] - first[1])
      .map(([name, value]) => {
        const label = name === 'You' ? this.displayName : name;
        return `<div class="is-${teamOf(name)}"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
      })
      .join('');
  }

  /** Rebuild the three inventory slot cards when contents or selection change. */
  renderSlots(inventory) {
    const signature = inventory.slots.map((item) => (item ? item.definition.id : '-')).join('|') + inventory.activeSlot;
    this.elements.medkitCount.textContent = `${inventory.medkits}/${LOOT.maxMedkits}`;
    this.elements.medkitBox.classList.toggle('is-empty', inventory.medkits === 0);
    if (signature === this.slotSignature) return;
    this.slotSignature = signature;
    this.elements.weaponSlots.innerHTML = WEAPON_SLOTS.map((slot, index) => {
      const item = inventory.slots[index];
      const classes = [index === inventory.activeSlot ? 'active' : '', item ? '' : 'empty', item && item.definition.tier === 'elite' ? 'elite' : ''].join(' ');
      return `<span class="${classes}"><b>${slot.key} · ${slot.label}</b>${item ? escapeHtml(item.definition.shortName) : '— EMPTY —'}</span>`;
    }).join('');
  }

  nameMarkup(name, team) {
    if (name === 'You') return `<span class="you">${escapeHtml(this.displayName)}</span>`;
    const cssClass = team ? TEAMS[team].cssClass : '';
    return `<span class="${cssClass}">${escapeHtml(name)}</span>`;
  }

  addFeedEntry({ killer, killerTeam, victim, victimTeam, weaponName, isHeadshot }) {
    const element = document.createElement('div');
    element.className = 'feed-entry';
    element.innerHTML = `${this.nameMarkup(killer, killerTeam)}<span class="weapon">[${escapeHtml(weaponName)}]</span>${this.nameMarkup(victim, victimTeam)}${isHeadshot ? '<span class="headshot">◎</span>' : ''}`;
    this.elements.killfeed.prepend(element);
    this.feedEntries.push({ element, timeLeft: MATCH.killfeedLifetime });
    while (this.feedEntries.length > MATCH.killfeedMaxEntries) this.feedEntries.shift().element.remove();
  }

  /** Floating tactical pickup/status message. tone: info | heal | armor | rare | elite | danger | muted */
  addNotification(text, tone = 'info') {
    const element = document.createElement('div');
    element.className = `notice notice-${tone}`;
    element.textContent = text;
    this.elements.notifications.prepend(element);
    this.notificationEntries.push({ element, timeLeft: 3.2 });
    while (this.notificationEntries.length > 5) this.notificationEntries.shift().element.remove();
  }

  showAnnouncement({ title, subtitle, tier, kind }) {
    const { announce, announceTitle, announceSubtitle } = this.elements;
    announceTitle.textContent = title;
    announceSubtitle.textContent = subtitle || '';
    announce.className = `hud announce tier-${tier}${kind === 'headshot' ? ' is-headshot' : ''}`;
    void announce.offsetWidth;
    announce.classList.add('is-showing');
  }

  setTrait(trait) {
    this.elements.traitBadge.textContent = trait && trait.id !== 'none' ? `${trait.icon} ${trait.name}` : '';
  }

  showToast(text, style = 'default') {
    const toast = this.elements.toast;
    toast.textContent = text;
    toast.classList.remove('is-showing', 'is-danger', 'is-gold');
    void toast.offsetWidth;
    if (style === 'danger') toast.classList.add('is-danger');
    if (style === 'gold') toast.classList.add('is-gold');
    toast.classList.add('is-showing');
  }

  showHitmarker(isKill, isHeadshot) {
    const marker = this.elements.hitmarker;
    marker.classList.remove('is-showing', 'is-kill', 'is-headshot');
    void marker.offsetWidth;
    if (isKill) marker.classList.add('is-kill');
    else if (isHeadshot) marker.classList.add('is-headshot');
    marker.classList.add('is-showing');
  }

  clearFeed() {
    this.feedEntries.forEach((entry) => entry.element.remove());
    this.feedEntries = [];
    this.notificationEntries.forEach((entry) => entry.element.remove());
    this.notificationEntries = [];
  }

  // ------------------------------------------------------------------ per frame
  /**
   * state: { deltaSeconds, player, weapons, inventory, match, bots, tags, barrels, supplyDrop, prompt }
   */
  update(state) {
    const { deltaSeconds, player, weapons, inventory, match, prompt } = state;
    const elements = this.elements;
    this.frameCounter++;
    this.updateChat(deltaSeconds);

    const seconds = Math.ceil(match.timeRemaining);
    elements.timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    elements.timerBox.classList.toggle('is-urgent', seconds <= 30);

    // Health & shield.
    elements.healthValue.textContent = Math.ceil(player.health);
    elements.healthBar.style.width = `${(player.health / PLAYER.maxHealth) * 100}%`;
    elements.healthBar.classList.toggle('is-low', player.health < 35);
    elements.shieldValue.textContent = Math.ceil(player.shield);
    elements.shieldBar.style.width = `${(player.shield / PLAYER.maxShield) * 100}%`;
    elements.shieldRow.classList.toggle('is-empty', player.shield <= 0);
    const lowHealthOpacity = player.isAlive && player.health < 35 ? 1 - player.health / 35 : 0;
    elements.lowHealthVignette.style.opacity = lowHealthOpacity.toFixed(2);
    elements.lowHealthVignette.classList.toggle('is-active', lowHealthOpacity > 0.05);

    // Med-kit channel.
    elements.healBar.classList.toggle('is-active', player.isHealing);
    elements.healFill.style.width = `${player.healProgress * 100}%`;
    if (inventory) this.renderSlots(inventory);

    this.damageFlash = Math.max(0, this.damageFlash - deltaSeconds * 1.8);
    elements.damageVignette.style.opacity = this.damageFlash.toFixed(2);

    this.damageIndicatorTimer = Math.max(0, this.damageIndicatorTimer - deltaSeconds);
    if (this.damageIndicatorTimer > 0 && this.damageSourcePosition) {
      const offsetX = this.damageSourcePosition.x - player.position.x;
      const offsetZ = this.damageSourcePosition.z - player.position.z;
      const worldAngle = Math.atan2(-offsetX, -offsetZ);
      elements.damageIndicator.style.transform = `rotate(${player.yaw - worldAngle}rad)`;
      elements.damageIndicator.style.opacity = Math.min(1, this.damageIndicatorTimer * 1.5).toFixed(2);
    } else {
      elements.damageIndicator.style.opacity = '0';
    }

    elements.dashBar.style.width = `${Math.max(0, Math.min(1, player.dashReadiness)) * 100}%`;

    // Ammo: magazine / reserve; melee shows a blade glyph.
    const weapon = weapons.weapon;
    if (weapon) {
      if (weapon.isMelee) {
        elements.ammoCurrent.textContent = '⚔';
        elements.ammoReserve.textContent = '∞';
      } else {
        elements.ammoCurrent.textContent = weapons.isReloading ? '··' : weapons.ammo;
        elements.ammoReserve.textContent = weapons.reserve;
      }
      elements.weaponName.textContent = weapon.name;
      elements.ammoPanel.classList.toggle('is-empty', !weapon.isMelee && weapons.ammo === 0 && !weapons.isReloading);
      elements.ammoPanel.classList.toggle('is-low-reserve', !weapon.isMelee && weapons.reserve === 0);
      elements.ammoPanel.classList.toggle('is-elite', weapon.tier === 'elite');
    }
    elements.reloadBar.classList.toggle('is-active', weapons.isReloading);
    elements.reloadFill.style.width = `${weapons.reloadProgress * 100}%`;

    // Interaction prompt.
    if (prompt && player.isAlive) {
      elements.promptText.textContent = prompt.text;
      elements.prompt.className = `hud interact-prompt is-visible rarity-${prompt.rarity}`;
    } else {
      elements.prompt.className = 'hud interact-prompt';
    }

    // Crosshair.
    const spread = weapons.currentSpread(player);
    const recoil = weapon && weapon.recoil ? weapon.recoil : 0.5;
    const recoilBloom = Math.max(0, 1 - weapons.timeSinceShot / 0.25) * recoil * 3;
    elements.crosshair.style.setProperty('--crosshair-gap', `${(4 + spread * 280 + recoilBloom).toFixed(1)}px`);
    elements.crosshair.classList.toggle('is-hidden-soft', weapons.isScoped || !player.isAlive || player.isHealing);
    elements.scope.classList.toggle('is-active', weapons.isScoped && player.isAlive);

    for (const list of [this.feedEntries, this.notificationEntries]) {
      for (let index = list.length - 1; index >= 0; index--) {
        const entry = list[index];
        entry.timeLeft -= deltaSeconds;
        if (entry.timeLeft <= 0) {
          entry.element.remove();
          list.splice(index, 1);
        }
      }
    }

    // Supply drop tracker text.
    const drop = state.supplyDrop;
    if (drop && drop.state !== 'opened') {
      const distance = Math.round(Math.hypot(drop.position.x - player.position.x, drop.position.z - player.position.z));
      elements.supplyTracker.textContent = drop.state === 'incoming' ? `▼ SUPPLY DROP INBOUND · ${distance}m` : `▣ SUPPLY DROP · ${distance}m`;
      elements.supplyTracker.classList.add('is-visible');
    } else {
      elements.supplyTracker.classList.remove('is-visible');
    }

    this.updateModeAndAbilities(state);
    if (this.frameCounter % 2 === 0) this.drawRadar(state);
  }

  /** Ability panel, pet card, CTF flags, stance badge and screen overlays. */
  updateModeAndAbilities({ player, abilities, pet, flagStatus }) {
    const elements = this.elements;
    const ability = abilities ? abilities.status : null;
    elements.abilityPanel.classList.toggle('is-active', !!ability);
    if (ability) {
      const definition = ability.definition;
      elements.abilityIcon.textContent = definition.icon;
      elements.abilityName.textContent = definition.name;
      if (ability.slowTimer > 0) {
        elements.abilityHint.textContent = `TIME SLOWED · ${ability.slowTimer.toFixed(1)}s`;
        elements.abilityFill.style.width = `${(ability.slowTimer / definition.slowDuration) * 100}%`;
      } else {
        const hint = definition.id === 'teleport' ? `[V] BLINK · ${ability.charges} CHARGES`
          : definition.id === 'deadEye' ? '[V] SLOW TIME'
            : definition.id === 'propHunt' ? '[V] DROP DISGUISE' : 'UNLIMITED DASH [X]';
        elements.abilityHint.textContent = `${hint} · ${Math.ceil(ability.timeLeft)}s`;
        elements.abilityFill.style.width = `${(ability.timeLeft / definition.duration) * 100}%`;
      }
    }
    elements.deadeyeOverlay.classList.toggle('is-active', !!(abilities && abilities.isDeadEye));
    document.body.classList.toggle('is-deadeye', !!(abilities && abilities.isDeadEye));
    elements.speedLines.classList.toggle('is-active', player.abilitySpeedMultiplier > 1 && player.isMoving);
    elements.disguiseOverlay.classList.toggle('is-active', player.isDisguised);

    elements.stance.textContent = player.isGhosted ? 'GHOST' : player.isCrouching ? 'CROUCH' : 'STAND';
    elements.stance.className = `stance${player.isGhosted ? ' is-ghost' : player.isCrouching ? ' is-crouched' : ''}`;

    if (pet) {
      elements.petStatus.classList.toggle('is-down', !pet.isAlive);
      elements.petBar.style.width = `${(pet.health / PET.maxHealth) * 100}%`;
      elements.petState.textContent = !pet.isAlive ? 'DOWN — REDEPLOYING' : pet.state === 'attack' ? `ATTACKING ${pet.target ? pet.target.name.toUpperCase() : ''}` : 'FOLLOWING';
    }

    elements.flagStatus.classList.toggle('is-hidden', !flagStatus);
    if (flagStatus) {
      const ourTeam = flagStatus.ourTeam || 'blue';
      const enemyTeam = ourTeam === 'blue' ? 'red' : 'blue';
      const describe = (team, status) => {
        const label = status.state === 'home' ? 'AT BASE' : status.state === 'dropped' ? 'DROPPED' : `${status.carrierName === 'You' ? 'YOU HAVE IT' : (status.carrierName || '').toUpperCase()}`;
        const alert = team === ourTeam && status.state !== 'home';
        const carrying = team === enemyTeam && status.carrierName === 'You';
        return `<span class="flag-chip ${team}${alert ? ' is-alert' : ''}${carrying ? ' is-carrying' : ''}"><i></i>${team === ourTeam ? 'OUR FLAG' : 'ENEMY FLAG'}: ${escapeHtml(label)}</span>`;
      };
      const markup = describe(ourTeam, flagStatus[ourTeam]) + describe(enemyTeam, flagStatus[enemyTeam]);
      if (markup !== this.lastFlagMarkup) {
        this.lastFlagMarkup = markup;
        elements.flagStatus.innerHTML = markup;
      }
    }
  }

  drawRadar(state) {
    const { player, bots, tags, barrels = [], supplyDrop = null } = state;
    const context = this.radarContext;
    const size = this.elements.radar.width;
    const center = size / 2;
    const radius = center - 4;
    const range = 60;
    const scale = radius / range;

    context.clearRect(0, 0, size, size);
    context.save();
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.clip();
    const background = context.createRadialGradient(center, center, 0, center, center, radius);
    background.addColorStop(0, 'rgba(40,52,34,0.82)');
    background.addColorStop(1, 'rgba(14,18,12,0.9)');
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);

    context.strokeStyle = 'rgba(255,178,26,0.16)';
    context.lineWidth = 1;
    for (const ringFraction of [0.33, 0.66]) {
      context.beginPath();
      context.arc(center, center, radius * ringFraction, 0, Math.PI * 2);
      context.stroke();
    }
    context.beginPath();
    context.moveTo(center, 0); context.lineTo(center, size);
    context.moveTo(0, center); context.lineTo(size, center);
    context.stroke();
    const sweepAngle = (performance.now() / 1000) * 2.2;
    if (context.createConicGradient) {
      const sweep = context.createConicGradient(sweepAngle, center, center);
      sweep.addColorStop(0, 'rgba(255,178,26,0.22)');
      sweep.addColorStop(0.12, 'rgba(255,178,26,0)');
      sweep.addColorStop(1, 'rgba(255,178,26,0)');
      context.fillStyle = sweep;
      context.fillRect(0, 0, size, size);
    }

    const sinYaw = Math.sin(player.yaw);
    const cosYaw = Math.cos(player.yaw);
    const toRadar = (x, z) => {
      const offsetX = x - player.position.x;
      const offsetZ = z - player.position.z;
      const right = offsetX * cosYaw - offsetZ * sinYaw;
      const forward = -offsetX * sinYaw - offsetZ * cosYaw;
      return { x: center + right * scale, y: center - forward * scale, distance: Math.hypot(offsetX, offsetZ), right, forward };
    };

    for (const barrel of barrels) {
      if (barrel.isDestroyed) continue;
      const point = toRadar(barrel.position.x, barrel.position.z);
      if (point.distance > range) continue;
      context.fillStyle = 'rgba(255,120,40,0.8)';
      context.fillRect(point.x - 2, point.y - 2, 4, 4);
    }
    for (const donkey of state.donkeys || []) {
      const point = toRadar(donkey.position.x, donkey.position.z);
      if (point.distance > range) continue;
      context.fillStyle = '#ffd23f';
      context.font = 'bold 11px sans-serif';
      context.fillText('D', point.x - 4, point.y + 4);
    }
    if (state.pet && state.pet.isAlive) {
      const point = toRadar(state.pet.position.x, state.pet.position.z);
      context.fillStyle = '#9ad8ff';
      context.fillRect(point.x - 2.5, point.y - 2.5, 5, 5);
    }
    if (state.flagStatus) {
      for (const team of ['blue', 'red']) {
        const [flagX, flagZ] = CTF.flagPositions[team];
        const point = toRadar(flagX, flagZ);
        if (point.distance > range) continue;
        context.fillStyle = team === 'blue' ? '#4a9cf0' : '#e0452f';
        context.fillRect(point.x - 1, point.y - 7, 2, 10);
        context.fillRect(point.x + 1, point.y - 7, 6, 4);
      }
    }
    for (const tag of tags) {
      const point = toRadar(tag.x, tag.z);
      if (point.distance > range) continue;
      context.fillStyle = tag.team === 'red' ? '#ff5a4f' : '#5aa8ff';
      context.save();
      context.translate(point.x, point.y);
      context.rotate(Math.PI / 4);
      context.fillRect(-3.5, -3.5, 7, 7);
      context.restore();
    }
    for (const bot of bots) {
      if (bot.isDead) continue;
      const isAlly = bot.team === player.team;
      if (!isAlly && bot.revealTimer <= 0) continue;
      const point = toRadar(bot.position.x, bot.position.z);
      if (point.distance > range) continue;
      context.fillStyle = isAlly ? '#5aa8ff' : `rgba(255,70,60,${Math.min(1, bot.revealTimer / BOT.radarRevealTime + 0.2)})`;
      context.beginPath();
      context.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    // Supply drop: clamped to the radar edge when out of range.
    if (supplyDrop && supplyDrop.state !== 'opened') {
      const point = toRadar(supplyDrop.position.x, supplyDrop.position.z);
      let markerX = point.x;
      let markerY = point.y;
      if (point.distance > range) {
        const edgeScale = (radius - 8) / Math.hypot(point.right, point.forward);
        markerX = center + point.right * edgeScale;
        markerY = center - point.forward * edgeScale;
      }
      const pulse = 5 + Math.sin(performance.now() / 150) * 1.5;
      context.fillStyle = '#ffb21a';
      context.strokeStyle = '#1a1a10';
      context.lineWidth = 2;
      context.beginPath();
      context.rect(markerX - pulse, markerY - pulse, pulse * 2, pulse * 2);
      context.fill();
      context.stroke();
    }

    context.fillStyle = '#ffb21a';
    context.beginPath();
    context.moveTo(center, center - 8);
    context.lineTo(center + 6, center + 6);
    context.lineTo(center, center + 3);
    context.lineTo(center - 6, center + 6);
    context.closePath();
    context.fill();
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
