// =====================================================================
// BATLZON multiplayer server — zero dependencies (Node 18+).
//
//   node server/server.js            → http://localhost:8080
//   PORT=3000 node server/server.js
//
// One process does everything:
//   • serves the game files (index.html, css/, src/, assets/)
//   • WebSocket endpoint at /ws (hand-written RFC 6455, no npm packages)
//   • rooms with 4-letter codes, lobby (teams, ready-up, host settings),
//     text chat, and a message relay used for in-match sync
//
// The server is deliberately "dumb": the room host's browser simulates
// bots, scoring, loot and supply drops; the server only routes messages.
// =====================================================================

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.resolve(__dirname, '..');
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_MESSAGE_BYTES = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 15000;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.md': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------ static files
function serveStatic(request, response) {
  const urlPath = decodeURIComponent((request.url || '/').split('?')[0]);
  if (urlPath === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, players: clients.size }));
    return;
  }
  let filePath = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}server${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.stat(filePath, (statError, stats) => {
    if (!statError && stats.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(data);
    });
  });
}

// ------------------------------------------------------------------ minimal WebSocket
class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.isOpen = true;
    this.isAlive = true;
    this.onMessage = () => {};
    this.onClose = () => {};
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => this.handleClose());
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const isFinal = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (payloadLength > MAX_MESSAGE_BYTES) {
        this.close();
        return;
      }
      const maskLength = isMasked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + payloadLength) return;
      const mask = isMasked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + payloadLength));
      if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      this.buffer = this.buffer.subarray(offset + maskLength + payloadLength);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        this.isAlive = true;
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(payload);
        if (isFinal) {
          const message = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.isAlive = true;
          this.onMessage(message);
        }
      }
    }
  }

  sendFrame(opcode, payload) {
    if (!this.isOpen) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.handleClose();
    }
  }

  send(object) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(object), 'utf8'));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close() {
    if (!this.isOpen) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.handleClose();
  }

  handleClose() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }
}

// ------------------------------------------------------------------ rooms
const rooms = new Map();     // code -> room
const clients = new Map();   // id -> client
let nextClientId = 1;

function createRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name, room) {
  let clean = String(name || 'Player').replace(/[^\w\- ]/g, '').trim().slice(0, 12) || 'Player';
  if (room) {
    const taken = new Set([...room.players.values()].map((player) => player.name.toLowerCase()));
    const base = clean.slice(0, 10);
    let suffix = 2;
    while (taken.has(clean.toLowerCase())) clean = `${base}${suffix++}`;
  }
  return clean;
}

function publicRoomState(room) {
  return {
    t: 'room',
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    players: [...room.players.values()].map(({ id, name, team, ready, gender }) => ({ id, name, team, ready, gender })),
  };
}

function broadcast(room, message, exceptId = null) {
  for (const player of room.players.values()) {
    if (player.id !== exceptId) player.connection.send(message);
  }
}

function leaveRoom(client) {
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;
  room.players.delete(client.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  broadcast(room, { t: 'left', id: client.id, name: client.name });
  if (room.hostId === client.id) {
    // Host migration: the next player becomes host. A running match returns to the lobby
    // because the simulation lived in the old host's browser.
    room.hostId = room.players.keys().next().value;
    if (room.phase === 'playing') {
      room.phase = 'lobby';
      broadcast(room, { t: 'aborted', reason: 'Host left the match. Back to the lobby.' });
    }
    broadcast(room, { t: 'chat', system: true, text: `${room.players.get(room.hostId).name} is now the host.` });
  }
  broadcast(room, publicRoomState(room));
}

function joinRoom(client, room, name, gender) {
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    client.connection.send({ t: 'error', message: 'Room is full (8 players).' });
    return;
  }
  if (client.roomCode) leaveRoom(client);
  client.name = sanitizeName(name, room);
  client.roomCode = room.code;
  const blueCount = [...room.players.values()].filter((player) => player.team === 'blue').length;
  const redCount = room.players.size - blueCount;
  room.players.set(client.id, {
    id: client.id, name: client.name, team: room.settings.coop || blueCount <= redCount ? 'blue' : 'red', ready: false,
    gender: gender === 'female' ? 'female' : 'male', connection: client.connection,
  });
  client.connection.send({ t: 'joined', you: client.id, code: room.code, name: client.name });
  broadcast(room, { t: 'chat', system: true, text: `${client.name} joined the squad.` });
  broadcast(room, publicRoomState(room));
}

function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const room = rooms.get(client.roomCode);
  const isHost = room && room.hostId === client.id;

  switch (message.t) {
    case 'create': {
      const code = createRoomCode();
      const newRoom = {
        code, hostId: client.id, phase: 'lobby', players: new Map(),
        settings: { mapIndex: 0, modeIndex: 1, botFill: true, coop: false },
      };
      rooms.set(code, newRoom);
      joinRoom(client, newRoom, message.name, message.gender);
      break;
    }
    case 'join': {
      const target = rooms.get(String(message.code || '').toUpperCase().trim());
      if (!target) {
        client.connection.send({ t: 'error', message: 'No room with that code.' });
        return;
      }
      if (target.phase === 'playing') {
        client.connection.send({ t: 'error', message: 'That match is already in progress. Wait for it to end.' });
        return;
      }
      joinRoom(client, target, message.name, message.gender);
      break;
    }
    case 'leave':
      leaveRoom(client);
      client.connection.send({ t: 'leftRoom' });
      break;
    case 'team': {
      if (!room || room.phase !== 'lobby') return;
      const player = room.players.get(client.id);
      if (room.settings.coop) player.team = 'blue';
      else if (message.team === 'blue' || message.team === 'red') player.team = message.team;
      player.ready = false;
      broadcast(room, publicRoomState(room));
      break;
    }
    case 'ready': {
      if (!room) return;
      room.players.get(client.id).ready = !!message.ready;
      broadcast(room, publicRoomState(room));
      break;
    }
    case 'settings': {
      if (!isHost || room.phase !== 'lobby') return;
      const settings = message.settings || {};
      room.settings = {
        mapIndex: Math.max(0, Math.min(5, Number(settings.mapIndex) || 0)),
        modeIndex: Math.max(0, Math.min(10, Number(settings.modeIndex) || 0)),
        botFill: settings.botFill !== false,
        coop: !!settings.coop,
      };
      if (room.settings.coop) for (const player of room.players.values()) player.team = 'blue';
      broadcast(room, publicRoomState(room));
      break;
    }
    case 'chat': {
      if (!room) return;
      const text = String(message.text || '').slice(0, 160).trim();
      if (text) broadcast(room, { t: 'chat', from: client.id, name: client.name, text });
      break;
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      room.phase = 'playing';
      room.seed = Math.floor(Math.random() * 1e9);
      broadcast(room, { ...publicRoomState(room), t: 'start', seed: room.seed });
      break;
    }
    case 'end': {
      if (!isHost || !room) return;
      room.phase = 'lobby';
      for (const player of room.players.values()) player.ready = false;
      broadcast(room, publicRoomState(room));
      break;
    }
    case 'relay': {
      // In-match sync. to: 'all' (everyone else) | 'host' | <player id>
      if (!room) return;
      const envelope = { t: 'relay', from: client.id, data: message.data };
      if (message.to === 'all') broadcast(room, envelope, client.id);
      else if (message.to === 'host') {
        const host = room.players.get(room.hostId);
        if (host && host.id !== client.id) host.connection.send(envelope);
      } else {
        const target = room.players.get(Number(message.to));
        if (target) target.connection.send(envelope);
      }
      break;
    }
    case 'ping':
      client.connection.send({ t: 'pong', time: message.time });
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ http + upgrade
const server = http.createServer(serveStatic);

server.on('upgrade', (request, socket) => {
  if ((request.url || '').split('?')[0] !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  socket.setNoDelay(true);

  const connection = new WebSocketConnection(socket);
  const client = { id: nextClientId++, name: 'Player', roomCode: null, connection };
  clients.set(client.id, client);
  connection.onMessage = (raw) => handleMessage(client, raw);
  connection.onClose = () => {
    leaveRoom(client);
    clients.delete(client.id);
  };
  connection.send({ t: 'welcome', id: client.id });
});

setInterval(() => {
  for (const client of clients.values()) {
    if (!client.connection.isAlive) {
      client.connection.close();
      continue;
    }
    client.connection.isAlive = false;
    client.connection.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`BATLZON server running → http://localhost:${PORT}  (WebSocket: ws://localhost:${PORT}/ws)`);
});
