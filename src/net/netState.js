// =====================================================================
// Network state shared by every module.
//   offline : single player — this browser simulates everything.
//   host    : multiplayer host — simulates bots, scoring, loot, supply
//             drops, donkeys, barrels and weather, and broadcasts them.
//   client  : multiplayer guest — simulates only its own player and
//             mirrors everything else from the host.
// Systems check `netState.isAuthority` before running world logic.
// =====================================================================

export const netState = {
  mode: 'offline',
  myId: null,
  hostId: null,
  roomCode: null,
  myName: '',
  ping: 0,

  get isOnline() {
    return this.mode !== 'offline';
  },

  get isHost() {
    return this.mode === 'host';
  },

  get isClient() {
    return this.mode === 'client';
  },

  /** True when this browser owns the world simulation. */
  get isAuthority() {
    return this.mode !== 'client';
  },

  reset() {
    this.mode = 'offline';
    this.myId = null;
    this.hostId = null;
    this.roomCode = null;
  },
};
