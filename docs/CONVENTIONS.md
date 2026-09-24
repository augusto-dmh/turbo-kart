# Turbo Kart — engineering conventions (frozen)

Shared rules for every subsystem agent. **Read this before writing code.**

## Coordinates & units
- Meters, seconds, radians. Y is up. Right-handed (Three.js default).
- `u` = normalized progress along the track centerline, `[0, 1)`, increasing in the
  direction of travel.
- `lateral` offset is signed. **Verified 2026-09-23:** the shipped `TrackApi` reports
  **positive = RIGHT of travel** (`pointAt(u, +1)` sits to the driver's right). Use
  `|lateral|` for widths and let the AI's `_latSign` calibration handle sides.
- Steering is a *separate* convention and **is** "positive = left": `input.steer > 0`
  turns the kart left (yaw increases), and keyboard/gamepad/touch all map left → +1.

## Kart convention (frozen — Agent 1 owns, everyone relies on it)
- A kart's local **forward is +Z**.
- `object3D.rotation.y = yaw` where `forward = (sin(yaw), 0, cos(yaw))`.
- `kart.forward` returns a **world-space unit vector** (read-only copy is fine).
- `kart.position` returns a world-space `THREE.Vector3`.
- `kart.speed` is signed m/s (forward positive).
- Grid slots from `trackApi.startGrid[i]` are `{ position: THREE.Vector3, heading: number }`
  where `heading` is the yaw described above. Index 0 = pole.

## Track API
- Implemented by `TrackBuilder.build()` and must match the `TrackApi` typedef in
  `src/contracts.js` exactly. Karts, AI, items, HUD and FX all consume it.
- `project(pos)` is the hot path (called for every kart, every frame) — it must be
  O(1)-ish (sample table + local refinement), never a full-curve scan.
- `pointAt(u, lateral)` returns a `THREE.Vector3`; `tangentAt(u)` a unit `THREE.Vector3`.

## Events
- Cross-subsystem communication happens **only** through the shared `bus`
  (`src/core/events.js`) using the names in `EVENTS` (`src/contracts.js`).
- Never import another subsystem's module to make something happen at runtime —
  emit an event and let its owner react. (Exceptions: the integration APIs listed
  in your brief, e.g. `Kart`, `TrackBuilder`.)

## File ownership
- Only edit files in **your** ownership list. Never touch `src/main.js`,
  `src/contracts.js`, `src/core/events.js`, `index.html`, `package.json`,
  `vite.config.js`, `docs/CONVENTIONS.md`.
- If you need a contract change: keep backwards compatibility, add new exports, and
  document it in your report. The orchestrator integrates.
- Put your report at `docs/reports/agent-<n>-<area>.md`.

## Quality bar
- 60 fps target at `high` quality on a mid-range laptop; `ultra` may push further.
- Every quality preset must degrade gracefully (fewer particles, no post FX on `low`).
- No external assets, no network calls at runtime: geometry, textures (CanvasTexture /
  DataTexture) and audio (WebAudio synthesis) are generated procedurally.
- No `console.log` spam in the hot loop. Use `console.debug` sparingly.
- Guard optional subsystems with `?.` and feature checks — the game must never
  hard-crash because one subsystem is missing.
- Keep files focused; split large modules instead of one giant file.

## Style
- ES modules, `const`/`let`, 2-space indent, single quotes, semicolons.
- JSDoc on exported classes/functions.
- Deterministic randomness where gameplay matters (`Math.random()` is fine for FX,
  but AI/items should use a seeded RNG so races are reproducible in tests).
