// =====================================================================
// War Room — the multiplayer lobby.
//   Step 1: pick a server, create a room or join one with a 5-letter code.
//   Step 2: the room: two team columns, ready toggles, host-only
//           operation settings (map, mode, bot fill, co-op), chat, START.
// Talks to the server through NetClient and renders whatever room state
// the server broadcasts ('net:room'). The match itself is started by
// main.js when 'net:start' arrives.
// =====================================================================

import { MAPS, MODES } from '../config.js';
import { events } from '../core/events.js';
import { saveSettings } from '../core/settings.js';
import { defaultServerUrl, normalizeServerUrl } from '../net/netClient.js';
import { netState } from '../net/netState.js';

const getElement = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export class Lobby {
  /**
   * options: { net, settings, getCallsign(), getGender(), onUiClick(), onOpen(), onClose() }
   */
  constructor(options) {
    this.options = options;
    this.net = options.net;
    this.room = null;
    this.isReady = false;
    this.isBusy = false;
    this.elements = {
      root: getElement('lobby'),
      link: getElement('lobby-link'),
      linkText: getElement('lobby-link-text'),
      connect: getElement('lobby-connect'),
      server: getElement('lobby-server'),
      callsign: getElement('lobby-callsign'),
      create: getElement('lobby-create'),
      code: getElement('lobby-code'),
      join: getElement('lobby-join'),
      status: getElement('lobby-status'),
      roomPanel: getElement('lobby-room'),
      roomCode: getElement('lobby-room-code'),
      copy: getElement('lobby-copy'),
      phase: getElement('lobby-phase'),
      teamBlue: getElement('lobby-team-blue'),
      teamRed: getElement('lobby-team-red'),
      switchTeam: getElement('lobby-switch-team'),
      ready: getElement('lobby-ready'),
      settingsPanel: document.querySelector('.lobby-settings'),
      hostNote: getElement('lobby-host-note'),
      map: getElement('lobby-map'),
      mode: getElement('lobby-mode'),
      bots: getElement('lobby-bots'),
      coop: getElement('lobby-coop'),
      modeHelp: getElement('lobby-mode-help'),
      chatLog: getElement('lobby-chat-log'),
      chatForm: getElement('lobby-chat-form'),
      chatInput: getElement('lobby-chat-input'),
      leave: getElement('lobby-leave'),
      start: getElement('lobby-start'),
      startNote: getElement('lobby-start-note'),
    };
    this.populateSelects();
    this.bindUi();
    this.bindNet();
    this.prefillFromUrl();
  }

  get isOpen() {
    return !this.elements.root.classList.contains('is-hidden');
  }

  // ------------------------------------------------------------------ setup
  populateSelects() {
    this.elements.map.innerHTML = MAPS.map((map, index) => `<option value="${index}">${escapeHtml(map.name)} — ${escapeHtml(map.codename)}</option>`).join('');
    this.elements.mode.innerHTML = MODES.map((mode, index) => `<option value="${index}">${escapeHtml(mode.name)}</option>`).join('');
  }

  /** Invite links look like …/?join=ABCDE (optionally &server=host). */
  prefillFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('join');
      const server = params.get('server');
      if (server) this.elements.server.value = server;
      if (code) {
        this.elements.code.value = code.toUpperCase().slice(0, 5);
        this.pendingAutoOpen = true;
      }
    } catch {
      // No URL params available (file://).
    }
  }

  bindUi() {
    const { elements } = this;
    const click = () => this.options.onUiClick && this.options.onUiClick();
    for (const input of [elements.server, elements.callsign, elements.code, elements.chatInput]) {
      // Keep typing out of the game's key handlers.
      input.addEventListener('keydown', (event) => event.stopPropagation());
    }
    getElement('lobby-close').addEventListener('click', () => { click(); this.close(); });
    elements.create.addEventListener('click', () => { click(); this.connectThen((name, gender) => this.net.createRoom(name, gender)); });
    elements.join.addEventListener('click', () => {
      click();
      const code = elements.code.value.trim().toUpperCase();
      if (code.length < 4) {
        this.setStatus('Enter the room code your friend sent you.', true);
        return;
      }
      this.connectThen((name, gender) => this.net.joinRoom(code, name, gender));
    });
    elements.code.addEventListener('keydown', (event) => { if (event.key === 'Enter') elements.join.click(); });
    elements.switchTeam.addEventListener('click', () => {
      click();
      const me = this.me;
      if (me) this.net.setTeam(me.team === 'blue' ? 'red' : 'blue');
    });
    elements.ready.addEventListener('click', () => {
      click();
      this.isReady = !this.isReady;
      this.net.setReady(this.isReady);
    });
    const pushSettings = () => {
      if (!this.isHost) return;
      this.net.updateSettings({
        mapIndex: Number(elements.map.value), modeIndex: Number(elements.mode.value), botFill: elements.bots.checked, coop: elements.coop.checked,
      });
    };
    for (const control of [elements.map, elements.mode, elements.bots, elements.coop]) control.addEventListener('change', () => { click(); pushSettings(); });
    elements.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = elements.chatInput.value.trim();
      if (text) this.net.chat(text);
      elements.chatInput.value = '';
    });
    elements.leave.addEventListener('click', () => {
      click();
      this.net.leaveRoom();
      this.room = null;
      this.showConnect();
    });
    elements.start.addEventListener('click', () => {
      click();
      if (this.isHost && this.room && this.room.phase === 'lobby') this.net.startMatch();
    });
    elements.copy.addEventListener('click', () => {
      click();
      const invite = this.inviteLink();
      const done = () => this.addChatLine({ system: true, text: `Invite copied: ${invite}` });
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(invite).then(done, () => this.addChatLine({ system: true, text: `Share this: ${invite}` }));
      else this.addChatLine({ system: true, text: `Share this: ${invite}` });
    });
  }

  bindNet() {
    events.on('net:room', (room) => this.renderRoom(room));
    events.on('net:joined', () => {
      this.isReady = false;
      this.elements.chatLog.innerHTML = '';
      this.addChatLine({ system: true, text: 'Channel secured. Share the room code with your squad.' });
    });
    events.on('net:chat', (message) => this.addChatLine(message));
    events.on('net:leftRoom', () => {
      this.room = null;
      this.showConnect();
    });
    events.on('net:error', ({ message }) => this.setStatus(message, true));
    events.on('net:aborted', ({ reason }) => this.addChatLine({ system: true, text: reason || 'Match aborted.' }));
    events.on('net:left', ({ name }) => this.addChatLine({ system: true, text: `${name} left the room.` }));
    events.on('net:disconnected', () => {
      this.room = null;
      this.setLink('offline');
      if (this.isOpen) {
        this.showConnect();
        this.setStatus('Connection lost. Check the server address and try again.', true);
      }
    });
  }

  // ------------------------------------------------------------------ open / close
  open() {
    const { elements, options } = this;
    if (!elements.server.value) elements.server.value = defaultServerUrl(options.settings.serverUrl || '').replace(/^wss?:\/\//, '').replace(/\/ws$/, '');
    elements.callsign.value = options.getCallsign();
    elements.root.classList.remove('is-hidden');
    if (this.room) this.showRoom();
    else this.showConnect();
    if (options.onOpen) options.onOpen();
  }

  close() {
    this.elements.root.classList.add('is-hidden');
    if (this.options.onClose) this.options.onClose();
  }

  /** Called by main when the match starts (hide) or ends (back to the room). */
  hide() {
    this.elements.root.classList.add('is-hidden');
  }

  showConnect() {
    this.elements.connect.classList.remove('is-hidden');
    this.elements.roomPanel.classList.add('is-hidden');
  }

  showRoom() {
    this.elements.connect.classList.add('is-hidden');
    this.elements.roomPanel.classList.remove('is-hidden');
  }

  setStatus(text, isError = false) {
    this.elements.status.textContent = text || '';
    this.elements.status.classList.toggle('is-error', !!isError);
  }

  setLink(state) {
    const { link, linkText } = this.elements;
    link.classList.toggle('is-online', state === 'online');
    link.classList.toggle('is-busy', state === 'busy');
    linkText.textContent = state === 'online' ? `CONNECTED${netState.ping ? ` · ${netState.ping} MS` : ''}` : state === 'busy' ? 'CONNECTING…' : 'OFFLINE';
  }

  async connectThen(action) {
    if (this.isBusy) return;
    const callsign = (this.elements.callsign.value || '').trim().slice(0, 12) || this.options.getCallsign();
    const url = normalizeServerUrl(this.elements.server.value);
    this.isBusy = true;
    this.setLink('busy');
    this.setStatus(`Raising ${url} …`);
    try {
      if (!this.net.isConnected || this.connectedUrl !== url) {
        await this.net.connect(url);
        this.connectedUrl = url;
        saveSettings({ serverUrl: url, nickname: callsign });
      }
      this.setLink('online');
      this.setStatus('');
      action(callsign, this.options.getGender());
    } catch (error) {
      this.setLink('offline');
      this.setStatus(`${error.message} Free servers can take ~50 s to wake up — try again.`, true);
    } finally {
      this.isBusy = false;
    }
  }

  // ------------------------------------------------------------------ room
  get me() {
    return this.room ? this.room.players.find((player) => player.id === netState.myId) : null;
  }

  get isHost() {
    return !!this.room && this.room.hostId === netState.myId;
  }

  inviteLink() {
    const code = this.room ? this.room.code : '';
    if (/^https?:$/.test(location.protocol)) {
      const base = `${location.origin}${location.pathname}`;
      const sameServer = this.connectedUrl && this.connectedUrl.includes(location.host);
      return `${base}?join=${code}${sameServer ? '' : `&server=${encodeURIComponent(this.elements.server.value.trim())}`}`;
    }
    return `Room ${code} on ${this.elements.server.value.trim()}`;
  }

  renderRoom(room) {
    this.room = room;
    const { elements } = this;
    this.setLink('online');
    if (this.isOpen) this.showRoom();
    elements.roomCode.textContent = room.code;
    const playing = room.phase === 'playing';
    elements.phase.textContent = playing ? 'OPERATION IN PROGRESS' : `${room.players.length}/8 ASSEMBLING`;
    elements.phase.classList.toggle('is-playing', playing);

    const coop = !!room.settings.coop;
    const listFor = (team) => {
      const members = room.players.filter((player) => player.team === team);
      const rows = members.map((player) => `
        <li class="${player.id === netState.myId ? 'is-me' : ''}">
          <span class="tag"></span>
          <span>${escapeHtml(player.name)}</span>
          ${player.id === room.hostId ? '<span class="host">★ HOST</span>' : ''}
          <span class="state ${player.ready ? 'is-ready' : ''}">${player.ready ? 'READY' : 'STANDBY'}</span>
        </li>`);
      if (!rows.length) rows.push(`<li class="is-empty">${team === 'red' && coop ? 'BOTS ONLY (CO-OP)' : room.settings.botFill ? 'BOTS FILL IN' : 'EMPTY'}</li>`);
      return rows.join('');
    };
    elements.teamBlue.innerHTML = listFor('blue');
    elements.teamRed.innerHTML = listFor('red');
    elements.switchTeam.disabled = coop;
    elements.ready.textContent = this.isReady ? '✔ READY' : 'READY';
    elements.ready.classList.toggle('is-ready', this.isReady);

    elements.map.value = String(room.settings.mapIndex);
    elements.mode.value = String(room.settings.modeIndex);
    elements.bots.checked = !!room.settings.botFill;
    elements.coop.checked = coop;
    elements.settingsPanel.classList.toggle('is-locked', !this.isHost);
    elements.hostNote.textContent = this.isHost ? '(YOU ARE HOST)' : '(HOST CONTROLS)';
    const mode = MODES[room.settings.modeIndex] || MODES[0];
    elements.modeHelp.textContent = `${mode.description || ''} ${coop ? 'Co-op: every human joins BLUE against a bot army.' : 'Teams: humans on both sides, bots fill empty slots if enabled.'}`;

    elements.start.disabled = !this.isHost || playing;
    elements.startNote.textContent = playing ? 'MATCH RUNNING' : this.isHost
      ? (room.players.every((player) => player.ready || player.id === room.hostId) ? 'ALL SQUADS READY — LAUNCH' : 'LAUNCH ANY TIME (NOT EVERYONE IS READY)')
      : 'WAITING FOR HOST TO LAUNCH';

    if (this.pendingAutoOpen) this.pendingAutoOpen = false;
  }

  addChatLine(message) {
    const line = document.createElement('div');
    if (message.system) {
      line.className = 'is-system';
      line.textContent = `» ${message.text}`;
    } else {
      line.innerHTML = `<b>${escapeHtml(message.name)}:</b> ${escapeHtml(message.text)}`;
    }
    const log = this.elements.chatLog;
    log.appendChild(line);
    while (log.children.length > 80) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  /** ?join=CODE links open the war room straight away. */
  get wantsAutoOpen() {
    return !!this.pendingAutoOpen;
  }
}
