// =====================================================================
// Menu — the tactical command hub and every non-HUD screen:
//   • 3D armory backdrop (MenuScene) with the operator holding the loadout
//   • operator profile: dog-tag callsign, gender, rank & promotion progress
//   • operation briefing: map cards with tactical thumbnails, mission types,
//     graphics fidelity
//   • active loadout strip + Loadout Room (per-slot weapon picker with stats
//     plus a passive trait picker)
//   • Missions / Field Manual / Credits modals
//   • DEPLOY, loading insertion screen, pause/settings, after-action report
// Game actions are forwarded through callbacks supplied by main.js.
// =====================================================================

import { CREDITS, DEFAULT_LOADOUT, FIELD_MANUAL, GENDERS, MAPS, MENU_TIPS, MODES, TRAITS, WEAPONS, WEAPON_SLOTS } from '../config.js';
import { MenuScene } from './menuScene.js';

const getElement = (id) => document.getElementById(id);

const RANKS = [
  { name: 'PRIVATE', kills: 0 },
  { name: 'PRIVATE 1ST CLASS', kills: 5 },
  { name: 'CORPORAL', kills: 15 },
  { name: 'SERGEANT', kills: 35 },
  { name: 'STAFF SERGEANT', kills: 60 },
  { name: 'LIEUTENANT', kills: 100 },
  { name: 'CAPTAIN', kills: 150 },
  { name: 'MAJOR', kills: 220 },
  { name: 'COLONEL', kills: 320 },
];

// Simplified top-down layouts for the briefing thumbnails (x, z, width, depth, color).
const MAP_THUMBNAILS = [
  [[0, 0, 30, 30, '#3f8fb0'], [0, 0, 6, 30, '#c8a83a'], [-14, -18, 18, 3, '#b03a2a'], [16, -20, 12, 4, '#c88a20'], [0, -30, 40, 3, '#2a5ab0'],
    [-24, 6, 3, 20, '#c86a20'], [26, 8, 3, 18, '#c8a83a'], [0, 22, 14, 3, '#7a4ab0'], [-16, 16, 7, 3, '#1f5f70'], [18, 22, 3, 7, '#1f5f70'],
    [-34, -6, 9, 8, '#d8d0b8'], [36, -4, 9, 8, '#c8b890']],
  [[0, 0, 10, 100, '#4a4a50'], [0, 0, 100, 10, '#4a4a50'], [-22, -22, 9, 8, '#d8d0b8'], [22, -22, 9, 8, '#c8b890'], [-26, 18, 9, 8, '#b8c8d8'],
    [26, 20, 9, 8, '#d8b8b8'], [-42, 0, 9, 8, '#c8b890'], [42, 2, 9, 8, '#d8d0b8'], [0, -8, 6, 6, '#1f5f70'], [0, 12, 6, 6, '#1f5f70'],
    [-12, 0, 2, 10, '#9a9488'], [12, 0, 2, 10, '#9a9488']],
];

export class Menu {
  constructor({ settings, missionTracker, callbacks }) {
    this.settings = settings;
    this.missionTracker = missionTracker;
    this.callbacks = callbacks;
    this.selectedMapIndex = 0;
    this.selectedModeIndex = 0;
    this.loadout = { ...settings.loadout };
    this.gender = settings.gender || 'male';
    this.trait = settings.trait || 'none';
    this.isMenuVisible = true;
    this.hasStartedMatch = false;
    this.lastHoverTime = 0;

    this.elements = {
      menu: getElement('menu'),
      nickname: getElement('nickname'),
      dogtagMeta: getElement('dogtag-meta'),
      clock: getElement('menu-clock'),
      careerKills: getElement('career-kills'),
      careerWins: getElement('career-wins'),
      careerMatches: getElement('career-matches'),
      rankName: getElement('rank-name'),
      rankChevrons: getElement('rank-chevrons'),
      xpFill: getElement('xp-fill'),
      xpText: getElement('xp-text'),
      missionsBadge: getElement('missions-badge'),
      mapOptions: getElement('map-options'),
      modeOptions: getElement('mode-options'),
      briefText: getElement('brief-text'),
      loadoutStrip: getElement('loadout-strip'),
      loadoutRoom: getElement('loadout-room'),
      loadoutColumns: getElement('loadout-columns'),
      playButton: getElement('play-button'),
      modal: getElement('modal'),
      modalTitle: getElement('modal-title'),
      modalKicker: getElement('modal-kicker'),
      modalBody: getElement('modal-body'),
      loading: getElement('loading'),
      loadingTitle: getElement('loading-title'),
      loadingBriefing: getElement('loading-briefing'),
      loadingFill: getElement('loading-fill'),
      loadingTip: getElement('loading-tip'),
      pause: getElement('pause-overlay'),
      pauseKicker: getElement('pause-kicker'),
      deployButton: getElement('deploy-button'),
      newMatchButton: getElement('new-match-button'),
      modeDescription: getElement('mode-description'),
      endScreen: getElement('end-screen'),
      endTitle: getElement('end-title'),
      endStats: getElement('end-stats'),
      playAgainButton: getElement('play-again-button'),
    };
    this.elements.nickname.value = settings.nickname || 'PlayerOne';

    try {
      this.scene = new MenuScene(getElement('armory-canvas'));
      this.scene.setLoadout(this.loadout);
      this.scene.setGender(this.gender);
    } catch (error) {
      console.warn('[menu] 3D armory unavailable', error);
      this.scene = null;
    }

    this.renderMapCards();
    this.renderModeCards();
    this.renderLoadoutStrip();
    this.renderCareer();
    this.updateDogtagMeta();
    this.setGender(this.gender, false);
    this.bindMenu();
    this.bindPause();
    this.startClock();
  }

  get nickname() {
    return (this.elements.nickname.value || 'Player').trim().slice(0, 12) || 'Player';
  }

  click() {
    if (this.callbacks.onUiClick) this.callbacks.onUiClick();
  }

  // ------------------------------------------------------------------ hub rendering
  renderMapCards() {
    this.elements.mapOptions.innerHTML = MAPS.map((map, index) => `
      <button class="map-card" data-map="${index}">
        <canvas width="160" height="84"></canvas>
        <b>${map.name}</b><small>${map.codename} · ${map.terrain}</small>
      </button>`).join('');
    this.elements.mapOptions.querySelectorAll('.map-card').forEach((card, index) => {
      drawMapThumbnail(card.querySelector('canvas'), index);
      card.addEventListener('click', () => {
        this.click();
        this.selectMap(index);
        this.callbacks.onMapChange(index);
      });
    });
    this.selectMap(this.selectedMapIndex);
  }

  renderModeCards() {
    this.elements.modeOptions.innerHTML = MODES.map((mode, index) => `
      <button class="mode-card" data-mode="${index}"><b>${mode.name}</b><small>${mode.codename} · FIRST TO ${mode.scoreGoal}</small></button>`).join('');
    this.elements.modeOptions.querySelectorAll('.mode-card').forEach((card, index) => {
      card.addEventListener('click', () => {
        this.click();
        this.selectMode(index);
        this.callbacks.onModeChange(index);
      });
    });
    this.selectMode(this.selectedModeIndex);
  }

  selectMap(index) {
    this.selectedMapIndex = index;
    this.elements.mapOptions.querySelectorAll('.map-card').forEach((card, cardIndex) => card.classList.toggle('active', cardIndex === index));
    this.updateBriefing();
  }

  selectMode(index) {
    this.selectedModeIndex = index;
    this.elements.modeOptions.querySelectorAll('.mode-card').forEach((card, cardIndex) => card.classList.toggle('active', cardIndex === index));
    this.elements.modeDescription.textContent = MODES[index].description;
    this.updateBriefing();
  }

  updateBriefing() {
    const map = MAPS[this.selectedMapIndex];
    const mode = MODES[this.selectedModeIndex];
    const squad = mode.roster.blue === 0 ? 'Solo + K9' : `${mode.roster.blue + 1}v${mode.roster.red}`;
    this.elements.briefText.textContent = `${map.briefing} Objective: ${mode.codename.toLowerCase()} — first to ${mode.scoreGoal}. Squad: ${squad}.`;
  }

  setActiveQuality(qualityName) {
    document.querySelectorAll('#quality-options button').forEach((button) => button.classList.toggle('active', button.dataset.quality === qualityName));
  }

  renderLoadoutStrip() {
    const trait = TRAITS[this.trait];
    this.elements.loadoutStrip.innerHTML = WEAPON_SLOTS.map((slot) => {
      const weapon = WEAPONS[this.loadout[slot.id]];
      return `<div class="loadout-card" data-slot="${slot.id}"><small>${slot.key} · ${slot.label}</small><b>${weapon.name}</b></div>`;
    }).join('') + `<div class="loadout-card trait-card" data-slot="trait"><small>PASSIVE TRAIT</small><b>${trait.icon} ${trait.name}</b></div>`;
    this.elements.loadoutStrip.querySelectorAll('.loadout-card').forEach((card) => {
      card.addEventListener('click', () => {
        this.click();
        this.openLoadoutRoom();
      });
    });
  }

  renderCareer() {
    const stats = this.settings.stats;
    this.elements.careerKills.textContent = stats.totalKills || 0;
    this.elements.careerWins.textContent = stats.wins || 0;
    this.elements.careerMatches.textContent = stats.matchesPlayed || 0;

    const kills = stats.totalKills || 0;
    let rankIndex = 0;
    RANKS.forEach((rank, index) => { if (kills >= rank.kills) rankIndex = index; });
    const rank = RANKS[rankIndex];
    const nextRank = RANKS[rankIndex + 1];
    this.elements.rankName.textContent = rank.name;
    const chevronCount = Math.min(4, rankIndex + 1);
    this.elements.rankChevrons.innerHTML = Array.from({ length: 4 }, (_, index) => `<i class="${index < chevronCount ? '' : 'is-dim'}"></i>`).join('');
    if (nextRank) {
      const progress = (kills - rank.kills) / (nextRank.kills - rank.kills);
      this.elements.xpFill.style.width = `${Math.min(100, progress * 100)}%`;
      this.elements.xpText.textContent = `${kills} / ${nextRank.kills} ELIMS TO ${nextRank.name}`;
    } else {
      this.elements.xpFill.style.width = '100%';
      this.elements.xpText.textContent = 'MAXIMUM RANK ACHIEVED';
    }

    const progress = this.missionTracker.getProgress();
    this.elements.missionsBadge.textContent = `${progress.filter((entry) => entry.complete).length}/${progress.length}`;
  }

  setGender(gender, notify = true) {
    this.gender = GENDERS[gender] ? gender : 'male';
    document.querySelectorAll('#gender-options button').forEach((button) => button.classList.toggle('active', button.dataset.gender === this.gender));
    if (this.scene) this.scene.setGender(this.gender);
    this.updateDogtagMeta();
    if (notify && this.callbacks.onGenderChange) this.callbacks.onGenderChange(this.gender);
  }

  setTrait(traitId) {
    this.trait = TRAITS[traitId] ? traitId : 'none';
    this.renderLoadoutStrip();
    if (this.callbacks.onTraitChange) this.callbacks.onTraitChange(this.trait);
  }

  updateDogtagMeta() {
    let hash = 0;
    for (const character of this.nickname) hash = (hash * 31 + character.charCodeAt(0)) % 10000;
    const bloodTypes = ['O POS', 'A POS', 'B POS', 'AB POS', 'O NEG', 'A NEG'];
    const sex = this.gender === 'female' ? 'F' : 'M';
    this.elements.dogtagMeta.textContent = `BRAVO SQUAD · ${sex} · ${bloodTypes[hash % bloodTypes.length]} · ID ${String(hash).padStart(4, '0')}`;
  }

  startClock() {
    const tick = () => {
      const now = new Date();
      this.elements.clock.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------ hub events
  bindMenu() {
    const { callbacks, elements } = this;

    elements.playButton.addEventListener('click', () => {
      if (callbacks.onDeployPressed) callbacks.onDeployPressed();
      callbacks.onPlay(this.nickname);
    });

    elements.nickname.addEventListener('keydown', (event) => event.stopPropagation());
    elements.nickname.addEventListener('input', () => this.updateDogtagMeta());
    document.querySelectorAll('#gender-options button').forEach((button) => {
      button.addEventListener('click', () => {
        this.click();
        this.setGender(button.dataset.gender);
      });
    });

    document.querySelectorAll('#quality-options button').forEach((button) => {
      button.addEventListener('click', () => {
        this.click();
        this.setActiveQuality(button.dataset.quality);
        callbacks.onQualityChange(button.dataset.quality);
      });
    });
    this.setActiveQuality(this.settings.graphicsQuality);

    document.querySelectorAll('[data-modal]').forEach((button) => {
      button.addEventListener('click', () => {
        this.click();
        this.openModal(button.dataset.modal);
      });
    });
    getElement('modal-close').addEventListener('click', () => this.closeModal());
    elements.modal.addEventListener('click', (event) => { if (event.target === elements.modal) this.closeModal(); });

    getElement('open-loadout').addEventListener('click', () => {
      this.click();
      this.openLoadoutRoom();
    });
    getElement('loadout-confirm').addEventListener('click', () => {
      this.click();
      this.closeLoadoutRoom();
    });
    getElement('loadout-reset').addEventListener('click', () => {
      this.click();
      this.setLoadout({ ...DEFAULT_LOADOUT });
      this.renderLoadoutRoom();
    });

    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') return;
      if (!elements.modal.classList.contains('is-hidden')) this.closeModal();
      else if (!elements.loadoutRoom.classList.contains('is-hidden')) this.closeLoadoutRoom();
    });

    // Subtle hover ticks on every interactive control in the hub.
    const hoverTargets = '.nav-button, .map-card, .mode-card, .loadout-card, .loadout-open, .deploy-button, .picker-arrow, .segmented-control button, .primary-btn, .secondary-btn';
    document.addEventListener('mouseover', (event) => {
      const target = event.target.closest && event.target.closest(hoverTargets);
      if (!target || target.contains(event.relatedTarget)) return;
      const now = performance.now();
      if (now - this.lastHoverTime < 60) return;
      this.lastHoverTime = now;
      if (callbacks.onUiHover) callbacks.onUiHover();
    });
  }

  hideMenu() {
    this.isMenuVisible = false;
    this.elements.menu.classList.add('is-hidden');
    this.elements.loadoutRoom.classList.add('is-hidden');
    this.closeModal();
    if (this.scene) this.scene.setActive(false);
  }

  // ------------------------------------------------------------------ loadout room
  setLoadout(loadout) {
    this.loadout = loadout;
    if (this.scene) this.scene.setLoadout(loadout);
    this.renderLoadoutStrip();
    this.callbacks.onLoadoutChange({ ...loadout });
  }

  openLoadoutRoom() {
    this.renderLoadoutRoom();
    this.elements.loadoutRoom.classList.remove('is-hidden');
    this.elements.menu.querySelectorAll('.menu-left, .menu-right, .menu-bottom, .menu-topbar').forEach((element) => { element.style.visibility = 'hidden'; });
    if (this.scene) this.scene.setLoadoutFocus(true);
  }

  closeLoadoutRoom() {
    this.elements.loadoutRoom.classList.add('is-hidden');
    this.elements.menu.querySelectorAll('.menu-left, .menu-right, .menu-bottom, .menu-topbar').forEach((element) => { element.style.visibility = ''; });
    if (this.scene) this.scene.setLoadoutFocus(false);
  }

  renderLoadoutRoom() {
    this.elements.loadoutColumns.innerHTML = WEAPON_SLOTS.map((slot) => {
      const options = Object.values(WEAPONS).filter((weapon) => weapon.slot === slot.id && weapon.loadout);
      const eliteOptions = Object.values(WEAPONS).filter((weapon) => weapon.slot === slot.id && weapon.tier === 'elite');
      const current = WEAPONS[this.loadout[slot.id]];
      const currentIndex = options.indexOf(current);
      return `
        <section class="panel weapon-picker" data-slot="${slot.id}">
          <div class="picker-slot"><span>SLOT ${slot.key} // ${slot.label}</span><span>${currentIndex + 1}/${options.length}</span></div>
          <div class="picker-head">
            <button class="picker-arrow" data-direction="-1" aria-label="Previous">◀</button>
            <div class="picker-name">${current.name}</div>
            <button class="picker-arrow" data-direction="1" aria-label="Next">▶</button>
          </div>
          <div class="picker-dots">${options.map((option) => `<i class="${option === current ? 'active' : ''}"></i>`).join('')}</div>
          <p class="picker-desc">${current.description}</p>
          ${weaponStatRows(current)}
          <div class="elite-intel">${eliteOptions.length ? `SUPPLY DROP INTEL: ${eliteOptions.map((weapon) => `★ ${weapon.name}`).join(' · ')}` : 'NO ELITE VARIANTS IN THIS SLOT'}</div>
        </section>`;
    }).join('') + this.traitPickerMarkup();
    this.elements.loadoutColumns.classList.add('has-trait');
    const traitPicker = this.elements.loadoutColumns.querySelector('.trait-picker');
    traitPicker.querySelectorAll('.picker-arrow').forEach((arrow) => {
      arrow.addEventListener('click', () => {
        this.click();
        const ids = Object.keys(TRAITS);
        const nextIndex = (ids.indexOf(this.trait) + Number(arrow.dataset.direction) + ids.length) % ids.length;
        this.setTrait(ids[nextIndex]);
        this.renderLoadoutRoom();
      });
    });

    this.elements.loadoutColumns.querySelectorAll('.weapon-picker[data-slot]').forEach((picker) => {
      const slotId = picker.dataset.slot;
      const options = Object.values(WEAPONS).filter((weapon) => weapon.slot === slotId && weapon.loadout);
      picker.querySelectorAll('.picker-arrow').forEach((arrow) => {
        arrow.addEventListener('click', () => {
          this.click();
          const currentIndex = options.indexOf(WEAPONS[this.loadout[slotId]]);
          const nextIndex = (currentIndex + Number(arrow.dataset.direction) + options.length) % options.length;
          this.setLoadout({ ...this.loadout, [slotId]: options[nextIndex].id });
          this.renderLoadoutRoom();
        });
      });
    });
  }

  traitPickerMarkup() {
    const ids = Object.keys(TRAITS);
    const trait = TRAITS[this.trait];
    return `
      <section class="panel weapon-picker trait-picker">
        <div class="picker-slot"><span>PASSIVE // TRAIT</span><span>${ids.indexOf(this.trait) + 1}/${ids.length}</span></div>
        <div class="picker-head">
          <button class="picker-arrow" data-direction="-1" aria-label="Previous trait">◀</button>
          <div class="picker-name">${trait.name}</div>
          <button class="picker-arrow" data-direction="1" aria-label="Next trait">▶</button>
        </div>
        <div class="picker-dots">${ids.map((id) => `<i class="${id === this.trait ? 'active' : ''}"></i>`).join('')}</div>
        <div class="trait-icon">${trait.icon}</div>
        <p class="picker-desc">${trait.description}</p>
        <div class="elite-intel">ONE TRAIT PER DEPLOYMENT · APPLIES ON EVERY RESPAWN</div>
      </section>`;
  }

  // ------------------------------------------------------------------ modals
  openModal(name) {
    const { modalTitle, modalKicker, modalBody, modal } = this.elements;
    if (name === 'missions') {
      modalKicker.textContent = 'OPERATIONS COMMAND // CHALLENGES';
      modalTitle.textContent = 'MISSIONS';
      modalBody.innerHTML = this.missionTracker.getProgress().map(({ mission, value, complete }) => `
        <div class="mission-item ${complete ? 'is-complete' : ''}">
          <b>${complete ? '✔ ' : ''}${mission.title}</b>
          <span class="mission-count">${value}/${mission.goal}</span>
          <small>${mission.description}</small>
          <div class="mission-bar"><i style="width:${(value / mission.goal) * 100}%"></i></div>
        </div>`).join('');
    } else if (name === 'manual') {
      modalKicker.textContent = 'STANDARD OPERATING PROCEDURE';
      modalTitle.textContent = 'FIELD MANUAL';
      modalBody.innerHTML = FIELD_MANUAL.map(([heading, text]) => `<div class="manual-row"><b>${heading}</b><span>${text}</span></div>`).join('')
        + `<div class="manual-row"><b>TIPS</b><span>${MENU_TIPS.slice(1, 5).join('<br>')}</span></div>`;
    } else {
      modalKicker.textContent = 'PERSONNEL FILE';
      modalTitle.textContent = 'CREDITS';
      modalBody.innerHTML = '<div class="credits-logo">BLOCK<span>FRONT</span></div>'
        + CREDITS.map(([heading, text]) => `<div class="manual-row"><b>${heading}</b><span>${text}</span></div>`).join('');
    }
    modal.classList.remove('is-hidden');
  }

  closeModal() {
    this.elements.modal.classList.add('is-hidden');
  }

  // ------------------------------------------------------------------ loading
  runLoading(prepare) {
    const { loading, loadingFill, loadingTip, loadingTitle, loadingBriefing } = this.elements;
    const map = MAPS[this.selectedMapIndex];
    loadingTitle.textContent = map.codename;
    loadingBriefing.textContent = `${map.name} · ${MODES[this.selectedModeIndex].name} — ${map.briefing}`;
    loading.classList.remove('is-hidden');
    let progress = 0;
    let prepared = false;
    return new Promise((resolve) => {
      Promise.resolve()
        .then(() => new Promise((frame) => requestAnimationFrame(frame)))
        .then(prepare)
        .catch((error) => console.error('[menu] loading task failed', error))
        .finally(() => { prepared = true; });

      const interval = setInterval(() => {
        const ceiling = prepared ? 100 : 90;
        progress = Math.min(ceiling, progress + 2.5 + Math.random() * 5);
        loadingFill.style.width = `${progress}%`;
        loadingTip.textContent = MENU_TIPS[Math.min(MENU_TIPS.length - 1, Math.floor((progress / 100) * MENU_TIPS.length))];
        if (progress >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            loading.classList.add('is-hidden');
            resolve();
          }, 250);
        }
      }, 90);
    });
  }

  // ------------------------------------------------------------------ pause / deploy
  bindPause() {
    const { callbacks, elements } = this;
    elements.deployButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.click();
      callbacks.onDeploy();
    });
    elements.pause.addEventListener('click', (event) => {
      if (event.target === elements.pause && this.hasStartedMatch) callbacks.onDeploy();
    });
    elements.newMatchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onNewMatch();
    });
    elements.playAgainButton.addEventListener('click', () => callbacks.onNewMatch());

    const sliders = [
      ['volume-master', 'volumeMaster', (value) => callbacks.onVolumeChange('master', value)],
      ['volume-music', 'volumeMusic', (value) => callbacks.onVolumeChange('music', value)],
      ['volume-sfx', 'volumeSfx', (value) => callbacks.onVolumeChange('sfx', value)],
      ['mouse-sensitivity', 'mouseSensitivityScale', (value) => callbacks.onSensitivityChange(value)],
    ];
    for (const [elementId, settingKey, onChange] of sliders) {
      const slider = getElement(elementId);
      slider.value = this.settings[settingKey];
      slider.addEventListener('input', () => onChange(Number(slider.value)));
    }
    elements.pause.querySelector('.pause-card').addEventListener('click', (event) => event.stopPropagation());
  }

  showPause() {
    this.elements.pause.classList.remove('is-hidden');
  }

  hidePause() {
    this.elements.pause.classList.add('is-hidden');
  }

  markMatchStarted() {
    if (this.hasStartedMatch) return;
    this.hasStartedMatch = true;
    this.elements.deployButton.textContent = 'RESUME OPERATION';
    this.elements.pauseKicker.textContent = 'OPERATION PAUSED';
    this.elements.newMatchButton.classList.remove('is-hidden');
  }

  // ------------------------------------------------------------------ after-action
  showEnd({ result, scores, kills, scoreLabel, ourTeam = 'blue', isOnline = false }) {
    const enemyTeam = ourTeam === 'blue' ? 'red' : 'blue';
    const { endScreen, endTitle, endStats } = this.elements;
    endTitle.textContent = result === 'victory' ? 'MISSION ACCOMPLISHED' : result === 'draw' ? 'STALEMATE' : 'MISSION FAILED';
    endTitle.style.color = result === 'victory' ? '#ffb21a' : result === 'draw' ? '#e8e2cf' : '#e0452f';
    const stats = [
      [`${scoreLabel.toUpperCase()} (YOU – THEM)`, `${scores[ourTeam]} – ${scores[enemyTeam]}`],
      ['YOUR ELIMINATIONS', kills],
      ['CAREER ELIMS', this.settings.stats.totalKills || 0],
      ['MISSIONS DONE', this.missionTracker.getProgress().filter((entry) => entry.complete).length],
    ];
    endStats.innerHTML = stats.map(([label, value]) => `<div><small>${label}</small><b>${value}</b></div>`).join('');
    this.elements.playAgainButton.textContent = isOnline ? 'BACK TO WAR ROOM' : 'RETURN TO HQ';
    endScreen.classList.remove('is-hidden');
  }

  hideEnd() {
    this.elements.endScreen.classList.add('is-hidden');
  }

  /** Bring the command hub back (after an online match). */
  showMenu() {
    this.isMenuVisible = true;
    this.elements.menu.classList.remove('is-hidden');
    if (this.scene) this.scene.setActive(true);
  }

  /** Pause card wording for online matches. */
  setOnlinePause(isOnline) {
    document.getElementById('pause-online-note').classList.toggle('is-hidden', !isOnline);
    this.elements.newMatchButton.textContent = isOnline ? 'LEAVE MATCH · WAR ROOM' : 'ABORT · RETURN TO HQ';
    if (isOnline) {
      this.elements.newMatchButton.classList.remove('is-hidden');
      this.elements.deployButton.textContent = 'DEPLOY';
      this.elements.pauseKicker.textContent = 'ONLINE OPERATION';
    }
  }
}

// ------------------------------------------------------------------ helpers
function weaponStatRows(weapon) {
  const damage = weapon.damage * (weapon.pellets || 1);
  const rpm = Math.round(60 / weapon.fireInterval);
  const rows = [
    ['DAMAGE', damage / 140, damage],
    ['FIRE RATE', rpm / 1100, `${rpm}`],
    ['RANGE', weapon.range / 140, `${weapon.range}m`],
    ['MAGAZINE', weapon.isMelee ? 0 : weapon.magazineSize / 100, weapon.isMelee ? '—' : weapon.magazineSize],
    ['MOBILITY', ((weapon.mobility || 1) - 0.8) / 0.3, `${Math.round((weapon.mobility || 1) * 100)}%`],
  ];
  return rows.map(([label, ratio, value]) => `
    <div class="stat-row"><span>${label}</span><div class="stat-bar"><i style="width:${Math.max(4, Math.min(100, ratio * 100))}%"></i></div><b>${value}</b></div>`).join('');
}

function drawMapThumbnail(canvas, mapIndex) {
  const context = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const map = MAPS[mapIndex];
  const scale = width / 110;
  context.fillStyle = `#${map.groundColor.toString(16).padStart(6, '0')}`;
  context.fillRect(0, 0, width, height);
  context.fillStyle = 'rgba(0,0,0,0.25)';
  context.fillRect(0, 0, width, height);
  for (const [x, z, rectWidth, rectDepth, color] of MAP_THUMBNAILS[mapIndex]) {
    context.fillStyle = color;
    context.fillRect(width / 2 + (x - rectWidth / 2) * scale, height / 2 + (z - rectDepth / 2) * scale * 0.75, rectWidth * scale, rectDepth * scale * 0.75);
  }
  // Tactical grid + objective markers.
  context.strokeStyle = 'rgba(255,178,26,0.25)';
  context.lineWidth = 1;
  for (let line = 0; line <= width; line += 16) {
    context.beginPath(); context.moveTo(line, 0); context.lineTo(line, height); context.stroke();
  }
  for (let line = 0; line <= height; line += 16) {
    context.beginPath(); context.moveTo(0, line); context.lineTo(width, line); context.stroke();
  }
  context.fillStyle = '#4a9cf0';
  context.fillRect(width / 2 - 3, height - 8, 6, 6);
  context.fillStyle = '#e0452f';
  context.fillRect(width / 2 - 3, 2, 6, 6);
}
