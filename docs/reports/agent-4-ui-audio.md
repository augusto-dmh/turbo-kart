# Agent 4 — UI (HUD + menus) & Audio

Status: **complete**. All files syntax-check (`node --check`), and the whole layer was
verified in headless Chrome (real DOM + canvas) plus a fake-WebAudio harness that
validates every AudioParam automation for ordering/value errors.

## Files

| File | Lines | Purpose |
| --- | --- | --- |
| `src/ui/hud.js` | 764 | In-race HUD (speedometer, lap/place/timer, item slot, drift meter, banners, countdown, screen FX) |
| `src/ui/menus.js` | 1178 | Title / mode / character / track / difficulty / settings / how-to / pause / results screens |
| `src/ui/minimap.js` | 401 | Canvas-2D minimap (rotating + north-up, HiDPI, allocation-free draw) |
| `src/ui/components.js` | 197 | Shared helpers: formatting, color/ordinal/time, item resolution, DOM setters |
| `src/ui/styles.css` | 1913 | Full visual identity (tokens, glass panels, keyframes, responsive, a11y) |
| `src/audio/audio.js` | 711 | AudioManager: graph, engine voice, SFX voices, bus mapping, volumes |
| `src/audio/synth.js` | 233 | Synth toolkit: oscillators, noise, ADSR, filters, generated IR reverb |
| `src/audio/music.js` | 415 | Procedural soundtrack (look-ahead scheduler, 6 contexts, crossfade) |

No files outside the Agent-4 ownership list were modified.

## Public API

### `new HUD({ bus, container })` — `src/ui/hud.js`
`setTrack(trackApi)` · `setMode(mode)` · `setQuality(q)` · `show()` · `hide()` ·
`showCountdown(value)` · `hideCountdown()` · `update(dt, view)` · `dispose()`

Extra (additive, safe to ignore): `minimap` (the `Minimap` instance), `visible`, `quality`, `mode`.

Bus inputs (all filtered to the player kart where a kart is present):
`RACE_COUNTDOWN`, `RACE_START`, `RACE_LAP`, `RACE_FINAL_LAP`, `KART_FINISHED`,
`KART_DRIFT_BOOST`, `KART_HIT`, `KART_BOOST`, `KART_ROCKET_START`, `ITEM_ROLL`,
`ITEM_USE`, `KART_WRONG_WAY`.
Bus outputs: `AUDIO_SFX` (`ui-click`) when the minimap orientation is toggled.

### `new Menus({ bus, container, characters, settings })` — `src/ui/menus.js`
`showTitle(config)` · `showTrackSelect(config)` · `showCharacterSelect(config)` ·
`showSettings(returnTo?)` · `showPause(settings)` · `hidePause()` ·
`showResults(standings, { config, place, mode })` · `hide()` · `setQuality(q)` · `dispose()`

Extra screens (additive): `showModeSelect()`, `showDifficulty(config)`, `showHowTo()`.
Bus outputs: `UI_RACE_CONFIG`, `UI_RESTART`, `UI_RESUME`, `UI_QUIT`, `UI_SETTINGS`,
`UI_READY` (once, after the title is up), `AUDIO_SFX` (`ui-click` / `ui-move`).
Bus inputs: `GAME_STATE` (not required — the orchestrator drives the screens).

### `new AudioManager({ bus, settings })` — `src/audio/audio.js`
`playMusic(name)` · `playSfx(name, opts)` · `setVolumes({ master, music, sfx })` ·
`update(dt, { kart, camera, state })` · `unlock()` · `dispose()` ·
`setMuted(bool)` · `isMuted()`

Extra (additive): `ready`, `unlocked`, `ctx`, `music` (the `MusicEngine`), `settings`.
`playSfx` opts: `{ kart | position, volume, pitch, value, itemId }` — position enables
stereo panning + distance attenuation relative to the camera.
Bus inputs: `AUDIO_SFX`, `AUDIO_MUSIC`, `audio:unlock` (raw ping), `RACE_*`, `KART_*`,
`ITEM_*`, `GAME_STATE`.

## Menu flow

```
TITLE ──START──▶ MODE ──▶ CHARACTER ──▶ TRACK ──▶ DIFFICULTY ──▶ UI_RACE_CONFIG
  │                │                        ▲
  ├──TIME TRIAL────┴──▶ CHARACTER ──▶ TRACK ─┘ (no difficulty step: solo, no AI)
  ├──SETTINGS (live)
  └──HOW TO PLAY (keyboard / gamepad / touch + tips)

ESC/Back walks the chain backwards.  PAUSE (Resume · Restart · Settings · Quit)
and RESULTS (Race again · Change track · Quit) are separate overlays.
```

* Difficulty is skipped for `TIME_TRIAL` (it only tunes AI); the config still carries
  the last chosen value.
* GP results accumulate a per-character session total (`_gpTotals`) shown in the
  "Total" column and on the title screen.
* Navigation: mouse, keyboard (arrows/WASD, Enter/Space, Escape) and gamepad
  (D-pad/left stick with repeat, A = confirm, B/Start = back). Grids use
  `data-cols` so up/down move a whole row.
* `#boot-overlay` is hidden on the first `showTitle()` and `display:none`d after
  the fade.
* Every field is read defensively: a standings row without `kart`/`character`/
  `finishTime` renders as `Racer N` / `–` (verified in the browser harness).

## SFX inventory (all names in `SFX`, fully synthesized)

| Name | Recipe | Character |
| --- | --- | --- |
| `countdown` | square 560/640/720 Hz (by count) + sine octave | short arcade beep |
| `go` | saw arpeggio C-E-G-C + bandpass noise sweep + 92→42 Hz sub | launch |
| `engine` | saw 58→210 Hz sweep through a resonant lowpass | ignition rev |
| `drift` | bandpass noise 1.9 k→2.6 k + saw 420→560 Hz | tyre squeal |
| `drift-boost` | bandpass sweep 700→5.2 k + saw 210→980 Hz + click | mini-turbo |
| `hop` | sine 300→640 Hz | jump |
| `land` | sine 150→54 Hz + lowpassed thump | touchdown |
| `hit` | bandpass noise + square 260→68 Hz | impact |
| `spin` | saw 760→210 Hz + triangle 520→150 Hz through a bandpass | spin-out |
| `item-roll` | square 1.02 kHz (+ random ±7 %) + sine octave | roulette tick |
| `item-use` | noise sweep 320→2.6 k + triangle 620→940 Hz | throw |
| `item-hit` | highpass noise + square 190→58 Hz + ping | shell hit |
| `item-box` | sine arpeggio 76-81-88 + triangle sweep | pickup sparkle |
| `boost` | lowpass noise sweep + 118→44 Hz sub + bandpass saw | rocket |
| `offroad` | lowpass noise 520→240 Hz | dirt rumble |
| `lap` | sine bells 81/88 | lap chime |
| `final-lap` | square arpeggio 72-76-79-84 + noise | fanfare |
| `finish` | saw arpeggio 67…88 + triangle chord + sparkle | victory |
| `lose` | triangle 72-68-65 + low sine | consolation |
| `ui-click` | highpass click + square 1.25→0.7 kHz | UI press |
| `ui-move` | sine 820→1.12 kHz | UI move |
| `shield-block` | detuned sines 1.32/1.98 kHz + noise tick | metal ping |
| `thunder` | lowpass noise 2.6 k→130 Hz + 74→30 Hz sub + crackle | lightning |

Item pitch flavours: mushroom 1.15, triple-mushroom 1.22, banana 0.95,
green-shell 1.0, red-shell 0.9, triple-shell 0.84, star 1.3, lightning 0.72.

## Music inventory (procedural, look-ahead scheduled)

`menu` (92 BPM, Am7-Fmaj7-Cmaj7-G) · `sunset` (118, C-G-Am-F) ·
`desert` (124, Dm-Bb-C-Dm, phrygian flavour) · `snow` (106, Fmaj7-Dm7-Gm7-Cmaj7) ·
`victory` (132, explicit fanfare melody) · `results` (100, F-C-G-Am).
Unknown names fall back to `menu`. Crossfade ≈1.1 s; notes are scheduled 0.4 s ahead
against `AudioContext.currentTime`, with a recovery path if the tab was throttled.

## Engine audio

Three oscillators (saw/square/saw, detuned) → resonant lowpass → engine gain, plus
looped pink-noise rumble, a bandpass drift squeal, a highpass ice-slide layer and a
turbo whistle. A fake 3.4-ratio gearbox resets the note with speed so acceleration
reads audibly. Every parameter uses `setTargetAtTime` (no direct value writes) so
there are no clicks; sources start once and only gains ramp.

## Verification performed

* `node --check` on all 8 files.
* `node tests/smoke.mjs` (Agent 5) — PASS, no stub markers, all imports resolve.
* Headless Chrome harness (`/tmp/opencode/ui-run.mjs` + `ui-test.mjs`, dev-only, not
  committed — rerun with `--mobile` for the 400×820 pass): full menu flow driven by
  real clicks + keyboard, `UI_RACE_CONFIG` payload asserted, settings emissions
  asserted, pause-over-results restoration, 300 HUD frames, bus juice events,
  minimap/track-preview canvases asserted non-blank via `getImageData`, `dispose()`
  cleanup. Screenshots of every screen were reviewed (desktop 1280×800 + mobile
  400×820).
* Fake-WebAudio harness (`/tmp/opencode/audio-smoke.mjs`): every `SFX` name + every
  event mapping + 30 s of music scheduling (434 scheduled sources), with strict
  AudioParam ordering/value assertions (out-of-order ramps and exponential ramps to
  ≤ 0 throw) plus null-safety calls. PASS.
* Integration re-checked against the landed Agent 1/2/3 code: `standings` shape,
  `raceTime`/`laps`/`countdownValue`, `getItemFor`/`isRolling`/`chargesFor`,
  `ITEM_*` payloads (`itemId`), `kart.input`/`state.driftLevel`/`state.driftCharge`,
  `trackApi.minimap.outline`/`bounds`/`itemBoxRows`, camera modes, the touch layer's
  z-index/button geometry, and the input layer's Escape → `UI_PAUSE` toggle.

## Known gaps / deviations

1. **No contract changes.** Everything added is an extra export or extra method.
2. **GP is a single race** in this build, so the results "Total" column shows the
   player's session cumulative (per character) and the AI's points for that race.
3. **Time trial skips the difficulty screen** (documented above).
4. The HUD speedometer scale is adaptive: it starts at 120 km/h and only ever grows
   (to the next 20 km/h step) when the player exceeds it, so the needle never
   rescales downward mid-race.
5. Touch layouts: on `(pointer: coarse)` the HUD pulls in from the top corners and
   re-centres the bottom row to avoid the input agent's on-screen buttons, and the
   minimap loses pointer events so it can never steal a steering touch. Extreme
   portrait widths can still crowd the bottom row (it wraps).
6. `prefers-reduced-motion` kills all keyframes (including the countdown pop, which
   then shows statically) and suppresses confetti.
7. Escape is handled by the menus only while a menu screen is open (the input agent
   owns Escape during a race). Pressing Escape on the results screen can surface the
   pause menu — `hidePause()` re-renders the last results screen in that case so the
   player can never get stuck.
8. Sound tuning is design-by-ear: the mix was validated structurally (levels, ramps,
   buses) but not auditioned on real hardware in this environment.
9. The race manager re-emits `RACE_COUNTDOWN` every 100 ms; the HUD and the audio
   layer both dedupe by label so a countdown beeps and animates exactly once per
   number (verified — this would otherwise have been 10 beeps/second).
