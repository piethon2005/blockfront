# BATLZON — modular Three.js FPS

Blocky team shooter (solo vs bots, or **online with up to 8 friends**) with a war-room command hub,
pre-game loadouts, slot-based inventory with weapon dropping, world loot, timed supply
drops, armor/shield, med-kits (no passive regen), PBR graphics and a fully synthesized
sound engine.

## Gameplay systems

- **Loadout & inventory** — three fixed slots: Melee (1), Sidearm (2), Primary (3). Pick
  each in the Loadout Room before deploying. Weapons keep their own magazine + reserve.
- **Weapon dropping** — press **E** over a ground weapon to take it; the weapon in that
  slot drops at your feet (so anyone can swap back). **G** drops your current gun.
- **World loot** — ammo boxes, med-kits, Tier-1 (+25) and Tier-2 (+50) armor and standard
  weapons spawn around the map and drop from eliminated bots. Consumables auto-collect.
- **Supply drops** — every 75 s (first at 40 s) a pod parachutes in under red smoke.
  Press **E** at the pod for elite loot: RAIL-X sniper, G18 auto pistol or M249 LMG,
  heavy armor, med-kits and ammo. Bots go to contest it.
- **Health** — no regeneration. Press **Q** to use a med-kit (+60 HP, 1.4 s channel).
  Armor absorbs damage before health.
- **Missions** — twelve persistent challenges with progress saved in the browser.
- **Modes** — Kill Confirmed (7v8), Team Deathmatch (7v8), 1v1 Arena, 4v4 Team Battle, Capture
  the Flag (7v7) and **Warzone 12v12** (8-minute all-out battle, picks FRONTLINE automatically).
- **Maps** — BRICKYARD, POXELTOWN and **FRONTLINE**: a 336 m war-torn valley with trench lines,
  barbed wire, concrete bunkers, a shelled village with a bell-tower church, craters and burning
  tank wrecks — all destructible. Distant artillery and fighter-jet flybys rumble overhead.
- **Smarter bots** — every bot carries a real gun (AK-47, M4A1, SG-12 shotgun, M249, RAIL-X sniper,
  G17, Desert Hawk, G18) held with both hands, with its own burst pattern, range, damage and sound.
  Bots dash to dodge, hunt donkeys and use the abilities they win (Hyper-Speed, Teleport flanks,
  Dead-Eye focus, Prop Hunt ambushes), and drop the gun they carried.
- **Voxel destruction** — houses, cover blocks, crates, containers and fences are grids of
  destructible cells. Bullets chip them, wood is shoot-through, the M249 / RAIL-X / shotgun
  hit harder, barrels blast holes, and unsupported cells collapse.
- **Attack pet** — K9 Razor follows you, charges visible enemies and bites (kills count as yours).
- **Donkeys** — a herd of 6 (9 on FRONTLINE) wander and bray; kill one for a random ability: Prop Hunt, Teleport (3 blinks),
  Hyper-Speed, or Dead-Eye slow motion. **V** uses the ability.
- **Weather** — halfway through a match fog, a dust storm or nightfall rolls in, cutting
  visibility for everyone (bots included). **L** toggles your flashlight.
- **Traits & stance** — Scavenger (magnet pickups), Juggernaut (+25 armor, slower), Ghost
  (crouched = invisible to radar pings and bots beyond 12 m, silent shots). **C** crouches.
- **Announcer** — Headshot, Single/Double/Triple/Quad/Multi Kill and kill-streak banners.
- **Operator** — callsign plus male/female selection (3D armory model, first-person arms, voice).

## Multiplayer (play with friends online)

Up to **8 players per room**. Everyone opens the game, clicks **MULTIPLAYER** in the
command hub, and meets in the **War Room**:

1. One player clicks **CREATE ROOM** and gets a 4-letter code (or **COPY INVITE** for a
   link like `https://your-server/?join=ABCD` that opens the War Room with the code filled in).
2. Friends type the code and click **JOIN**.
3. Pick teams (**SWITCH TEAM**), hit **READY**, chat in **COMMS**.
4. The host picks map, mode, **bot fill** (bots take empty slots) and **co-op**
   (every human on blue vs a bot army), then presses **START OP**.

Everything works online: all five modes, PvP and co-op, shared voxel destruction (a wall
one player blows up is gone for everyone), loot / supply drops / donkeys / barrels / weather
synced from the host, kill feed, announcer, dog tags and flags. In-game, press **T** to chat;
the ping shows next to the timer. The match keeps running while your pause menu is open.

**How it works.** `server/server.js` is a zero-dependency Node server that serves the game
*and* runs the WebSocket lobby/relay. The host's browser simulates the world (bots, scoring,
loot, drops); every player simulates their own soldier and dog; hits on another human are
applied by the victim's browser. See `src/net/replicator.js` for the details.

### Option A — free hosting on Render (best for friends in different places)

1. Put this folder in a GitHub repository.
2. On [render.com](https://render.com) → **New → Web Service** → pick the repo.
   Runtime **Node**, build command *(leave empty)*, start command `npm start`, plan **Free**.
   (Or **New → Blueprint** and Render reads the included `render.yaml`.)
3. Open the URL Render gives you (e.g. `https://batlzon-xyz.onrender.com`) and share it.
   The War Room connects to the same address automatically.

Free instances sleep after ~15 minutes without visitors; the first connection then takes
up to a minute while it wakes — just press CREATE/JOIN again. Any Node host works the same
way (Railway, Fly.io, a VPS): run `npm start`, it listens on `$PORT` (default 8080).

### Option B — host from your own computer

```bash
cd batlzon
node server/server.js        # needs Node 18+, no npm install required
```

Open `http://localhost:8080`. Friends on the **same Wi-Fi** open `http://YOUR-LAN-IP:8080`.
Friends **over the internet** need a tunnel or port forward, e.g.
`npx localtunnel --port 8080` / `ngrok http 8080` / `cloudflared tunnel --url http://localhost:8080`,
then everyone opens the public URL it prints.

### Tips

- The host's tab runs the bots: keep it in the foreground (browsers freeze background tabs,
  which pauses the world for everybody).
- `batlzon-standalone.html` opened as a file can still join: type the server address
  (e.g. `batlzon-xyz.onrender.com`) in **SERVER ADDRESS**.
- `GET /health` returns room and player counts.

## Running it

Easiest: `node server/server.js` and open http://localhost:8080 (also enables multiplayer).
ES modules do not load from `file://`, so otherwise either:

- **Double-click `batlzon-standalone.html`** — everything bundled in one file (needs internet for Three.js), or
- **Serve the folder** (recommended while developing):
  ```bash
  cd batlzon
  python -m http.server 8000      # then open http://localhost:8000
  # or: npx serve .   /  VS Code "Live Server"
  ```

After editing anything in `src/` or `css/`, rebuild the single-file version with
`python tools/build_standalone.py`.

## Folder structure

```
index.html                  HTML structure & UI layout (HUD, menu, overlays) + import map
css/styles.css              All styling: HUD, menu, overlays, animations
src/
  main.js                   Entry point: boot, game-state machine, input, combat wiring, main loop
  config.js                 Every tunable: weapons, bots, maps, modes, graphics presets, audio files
  core/
    events.js               Event bus + catalogue of every game event (the hook system)
    settings.js             Persistent settings (volume, sensitivity, quality, nickname)
  engine/
    renderer.js             Renderer, camera, PBR lights, soft shadows, gradient sky + IBL, fog,
                            post-processing (GTAO ambient occlusion, bloom, ACES output)
    physics.js              Box/ramp colliders, horizontal resolution, gravity/steps, raycasts
  entities/
    player.js               First-person movement, dash, jump, health, armor, med-kit healing
    inventory.js            Three weapon slots, weapon instances with ammo, med-kits
    pet.js                  K9 attack dog: follow, target, bite, respawn
    bot.js                  Articulated bot models + AI state machine (engage/collect/roam/dead)
    weapon.js               All weapon models (knives, pistols, rifles, elite guns), melee slashes,
                            semi/full-auto fire, reserve-ammo reloads, recoil & animations
  world/
    materials.js            Procedural PBR texture/normal-map library, world-scale UVs, wind shader
    outpost.js              Structure builder: blocks, ramps, decks, outposts, houses, containers,
                            trees, bushes, lamps, mountains; merges decor to cut draw calls
    mapBuilder.js           BRICKYARD & POXELTOWN layouts, ground, instanced grass, flowers, clouds
    voxelStructure.js       One destructible cell grid: instanced rendering, per-cell collision, DDA raycast, collapse
    voxelWorld.js           All voxel structures: world raycasts, bullet/explosion damage, rebuilds
  systems/
    matchManager.js         Rules: damage & kill credit, scores, dog tags, timer, victory
    hazardManager.js        Explosive barrels with chain reactions
    lootManager.js          Ground weapons, ammo, med-kits, armor; pickups, swaps and drops
    supplyDropManager.js    Timed parachute supply pods with elite loot
    missionTracker.js       Persistent career stats and mission completion
    flagManager.js          Capture the Flag rules, waving flags, bot CTF objectives
    donkeyManager.js        Wandering, braying donkeys that drop abilities
    abilityManager.js       Prop Hunt, Teleport, Hyper-Speed, Dead-Eye (world time scale)
    weatherManager.js       Mid-match fog / dust storm / nightfall + flashlight
    announcer.js            Headshot, multi-kill and streak announcements
    battleAmbience.js       Distant artillery strikes and fighter-jet flybys (cosmetic)
    effectsManager.js       GPU particles, tracers, muzzle flashes + lights, decals, debris,
                            shell casings, explosions, shockwaves, screen shake
    audioManager.js         Web Audio engine: synthesized SFX, 3D HRTF positional audio, reverb,
                            procedural music sequencer, ambience, low-health muffle, sample overrides
  ui/
    hud.js                  Scoreboard, kill feed, toasts, health, ammo, crosshair, hit markers,
                            damage direction, vignettes, sniper scope, radar
    menu.js                 War-room command hub, Loadout Room, modals, loading, pause, after-action
    menuScene.js            3D armory backdrop: operator with your loadout, lamp, dust, smoke
    lobby.js                Multiplayer War Room: connect, create/join, teams, ready, host settings, chat
  net/
    netState.js             offline / host / client mode flags every system checks (isAuthority)
    netClient.js            WebSocket client: lobby messages, relay, ping
    replicator.js           In-match sync: player states, shots, hits, deaths, bot/match/flag/donkey
                            snapshots, world events, shared voxel destruction, guest requests
server/server.js            Zero-dependency Node server: static files + WebSocket rooms/lobby/relay
render.yaml                 One-click Render.com deploy (Blueprint)
tools/build_standalone.py   Bundles everything into batlzon-standalone.html
assets/audio/               Drop-in folder for your own recorded sounds (optional)
```

## Extending

**Hooks / events.** Gameplay only emits facts; audio, VFX and HUD subscribe. The full list
of events and payloads is documented at the top of `src/core/events.js`. Example — add a
camera flinch animation whenever the player is hit:

```js
import { events } from './core/events.js';
events.on('player:hurt', ({ amount }) => myCameraRig.flinch(amount));
```

**Custom sound files.** Put files in `assets/audio/` and set the path in `AUDIO_SAMPLES`
inside `src/config.js` (e.g. `shot_ak47: 'assets/audio/ak47.wav'`). A loaded sample
automatically replaces the synthesized recipe; leave it empty to keep the synth.
Music works the same way (`music_menu`, `music_battle`).

**New weapon.** Add an entry to `WEAPONS` in `config.js` (choose its `slot`, `tier` and
whether it is `loadout`-selectable), a builder in `MODEL_BUILDERS` in `entities/weapon.js`,
and a sound recipe named after its `sound` field in `systems/audioManager.js`. It then shows
up automatically in the Loadout Room, ground loot pools (if listed in `LOOT`) or supply
drops (if listed in `SUPPLY_DROP.eliteWeapons`).

**New map.** Add an atmosphere entry to `MAPS` in `config.js`, a `buildYourMap(builder)`
method in `world/mapBuilder.js` using the `StructureBuilder` primitives, and a menu button.

**New mode.** Add to `MODES` in `config.js`; scoring rules live in `systems/matchManager.js`.

## Controls

WASD move · Mouse aim · Left click fire / slash · Right click aim · Space jump · X dash ·
R reload · 1/2/3 or mouse wheel switch slots · E pick up / swap / open supply drop ·
G drop weapon · Q use med-kit · C crouch · V use ability · L flashlight · T chat (online) · Esc pause · Enter deploy/resume.

Graphics presets (menu → GFX): LOW (no post-processing), MEDIUM (bloom, MSAA, cinematic grade),
ULTRA (adds GTAO ambient occlusion, 4K shadow map, dense grass). The cinematic grade adds contrast,
split-toning, vignette, lens fringing and film grain, and shifts mood with the weather.
On slower laptops pick MEDIUM or LOW for Warzone on FRONTLINE (23 bots).
