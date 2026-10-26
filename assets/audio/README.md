# Custom audio (optional)

BATLZON synthesizes every sound in real time, so this folder can stay empty.

To use your own recordings, drop `.wav`, `.mp3` or `.ogg` files here and map them in
`src/config.js` → `AUDIO_SAMPLES`, for example:

```js
shot_ak47: 'assets/audio/ak47.wav',
music_battle: 'assets/audio/battle-loop.mp3',
```

Available names: shot_ak47, shot_shotgun, shot_rail, reload, empty, weapon_switch,
footstep, jump, land, dash, hitmarker, headshot, kill, hurt, explosion, tag_confirm,
tag_deny, respawn, ui_click, victory, defeat, music_menu, music_battle.

Samples only load when the game is served over http (not file://).
