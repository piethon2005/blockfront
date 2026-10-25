// =====================================================================
// NetClient — WebSocket connection to the BLOCKFRONT server.
// Handles lobby messages (create / join / team / ready / settings /
// chat / start) and the in-match relay. Everything the server sends is
// re-emitted on the event bus as `net:<type>` so UI and game code stay
// decoupled from the socket.
// =====================================================================

import { events } from '../core/events.js';
import { netState } from './netState.js';

export function defaultServerUrl(savedUrl = '') {
  if (savedUrl) return savedUrl;
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  return 'ws://localhost:8080/ws';
}

/** Accept "myserver.onrender.com", "https://…", "ws://…:8080" and normalise to a ws(s)://…/ws URL. */
export function normalizeServerUrl(input) {
  let url = String(input || '').trim();
  if (!url) return defaultServerUrl();
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(url)) url = `${/localhost|127\.0\.0\.1|^\d+\.\d+\.\d+\.\d+/.test(url) ? 'ws' : 'wss'}://${url}`;
  if (!/\/ws$/.test(url)) url = url.replace(/\/+$/, '') + '/ws';
  return url;
}

export class NetClient {
  constructor() {
    this.socket = null;
    this.room = null;
    this.pingTimer = null;
  }

  get isConnected() {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  connect(url) {
    this.disconnect();
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('Connection timed out. Is the server running / awake?'));
        }
      }, 9000);
      socket.onopen = () => {
        settled = true;
        clearTimeout(timeout);
        this.pingTimer = setInterval(() => this.send({ t: 'ping', time: performance.now() }), 2000);
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Could not reach the server.'));
        }
      };
      socket.onclose = () => {
        clearInterval(this.pingTimer);
        if (this.socket === socket) {
          this.socket = null;
          this.room = null;
          events.emit('net:disconnected', {});
        }
      };
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.handle(message);
      };
    });
  }

  disconnect() {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close();
    }
    clearInterval(this.pingTimer);
    this.room = null;
  }

  handle(message) {
    switch (message.t) {
      case 'welcome':
        netState.myId = message.id;
        break;
      case 'joined':
        netState.myId = message.you;
        netState.roomCode = message.code;
        netState.myName = message.name;
        break;
      case 'room':
      case 'start':
        this.room = message;
        netState.hostId = message.hostId;
        break;
      case 'pong':
        netState.ping = Math.round(performance.now() - message.time);
        break;
      default:
        break;
    }
    events.emit(`net:${message.t}`, message);
  }

  send(message) {
    if (this.isConnected) this.socket.send(JSON.stringify(message));
  }

  // Lobby helpers.
  createRoom(name, gender) { this.send({ t: 'create', name, gender }); }
  joinRoom(code, name, gender) { this.send({ t: 'join', code, name, gender }); }
  leaveRoom() { this.send({ t: 'leave' }); }
  setTeam(team) { this.send({ t: 'team', team }); }
  setReady(ready) { this.send({ t: 'ready', ready }); }
  updateSettings(settings) { this.send({ t: 'settings', settings }); }
  chat(text) { this.send({ t: 'chat', text }); }
  startMatch() { this.send({ t: 'start' }); }
  endMatch() { this.send({ t: 'end' }); }

  /** In-match message. to: 'all' | 'host' | playerId */
  relay(to, data) {
    this.send({ t: 'relay', to, data });
  }
}
