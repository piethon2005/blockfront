// =====================================================================
// Event bus — the glue that keeps modules decoupled.
//
// Gameplay modules only *emit* facts ("weapon:fire", "bot:death", ...).
// Audio, VFX, HUD and any future system *subscribe* to those facts.
// Adding a new sound or animation never requires editing gameplay code.
//
// Event catalogue (payload fields in braces):
//   weapon:fire          { weapon, muzzlePosition, direction, muzzleAnchor, ejectPosition, ejectDirection, floorHeight }
//   weapon:impact        { point, normal, surfaceObject, hitBot, hitBarrel, weapon }
//   weapon:reload-start  { weapon, duration }
//   weapon:reload-end    { weapon }
//   weapon:switch        { weapon, index }
//   weapon:empty         { weapon }
//   weapon:zoom          { weapon, zoomed }
//   player:step          { surface, speed }
//   player:jump          {}
//   player:land          { fallSpeed }
//   player:dash          {}
//   player:hurt          { amount, health, sourcePosition, attackerName }
//   player:death         { attackerName }
//   player:respawn       {}
//   bot:fire             { bot, origin, target, didHit, targetIsPlayer }
//   bot:hurt             { bot, amount, point, isHeadshot }
//   bot:death            { bot, killerName, position }
//   bot:respawn          { bot }
//   hit:confirm          { isHeadshot, isKill }
//   bullet:whiz          { position }
//   tag:spawn            { tag }
//   tag:pickup           { tag, collectorName, collectorTeam, isPlayer, denied, position }
//   score:changed        { scores, team }
//   board:changed        { points }
//   feed:add             { killer, killerTeam, victim, victimTeam, weaponName, isHeadshot }
//   toast                { text, style }
//   coins:changed        { coins }
//   barrel:hit           { barrel, point }
//   explosion            { position, radius }
//   match:start          { mode, map }
//   match:countdown      { secondsLeft }
//   match:end            { result, scores, kills }
//   game:pause           {}
//   game:resume          {}
//   ui:click             {}
// =====================================================================

const listenersByEvent = new Map();

export const events = {
  /** Subscribe. Returns an unsubscribe function. */
  on(eventName, handler) {
    if (!listenersByEvent.has(eventName)) listenersByEvent.set(eventName, new Set());
    listenersByEvent.get(eventName).add(handler);
    return () => this.off(eventName, handler);
  },

  /** Subscribe for a single emission. */
  once(eventName, handler) {
    const unsubscribe = this.on(eventName, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  },

  off(eventName, handler) {
    const listeners = listenersByEvent.get(eventName);
    if (listeners) listeners.delete(handler);
  },

  emit(eventName, payload = {}) {
    const listeners = listenersByEvent.get(eventName);
    if (!listeners) return;
    for (const handler of [...listeners]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[events] handler for "${eventName}" failed:`, error);
      }
    }
  },
};
