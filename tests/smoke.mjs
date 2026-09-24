#!/usr/bin/env node
/**
 * ============================================================================
 * TURBO KART — smoke test (owned by Agent 5, the QA agent)
 * ============================================================================
 * Plain Node, no dependencies, no browser:
 *
 *   node tests/smoke.mjs        (or: npm run smoke)
 *
 * Exit code 0 = everything passed, 1 = at least one FAIL.
 * Warnings never fail the run (they are reported for the orchestrator).
 *
 * Checks
 *   1. module inventory: every expected file exists and is non-empty
 *   2. `node --check` parses every module
 *   3. required exports exist per module (regex scan)
 *   4. `src/contracts.js` integrity: frozen EVENTS list, 8 characters, 3+ tracks
 *   5. every relative import in `src/**` resolves to a real file
 *   6. no leftover stub markers (`STUB —`) anywhere in `src/`
 *   7. no banned patterns in `src/` (http imports, fetch, XHR, require)
 *   8. ownership guard (warning only): files changed vs the baseline commit
 *   9. summary table
 *  10. headless FX behaviour test (`tests/fx-headless.mjs`) — skipped when the
 *      `three` dependency is not installed
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: COLOR ? '\x1b[0m' : '',
  bold: COLOR ? '\x1b[1m' : '',
  dim: COLOR ? '\x1b[2m' : '',
  red: COLOR ? '\x1b[31m' : '',
  green: COLOR ? '\x1b[32m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  cyan: COLOR ? '\x1b[36m' : '',
};

/** @typedef {{id:string, name:string, status:'pass'|'fail'|'warn', detail:string, lines:string[]}} CheckResult */

/** @type {CheckResult[]} */
const results = [];
let current = null;

function startCheck(id, name) {
  current = { id, name, status: 'pass', detail: '', lines: [] };
  results.push(current);
  return current;
}

function fail(msg) {
  current.status = 'fail';
  current.lines.push(msg);
}

function warn(msg) {
  if (current.status !== 'fail') current.status = 'warn';
  current.lines.push(msg);
}

function info(msg) {
  current.lines.push(msg);
}

function setDetail(msg) {
  current.detail = msg;
}

function rel(p) {
  return path.relative(ROOT, p) || p;
}

/** Recursively list files under a directory. */
function listFiles(dir, filter = () => true) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** Read a file, returning '' on failure. */
function read(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Check 1 — module inventory
// ---------------------------------------------------------------------------
const EXPECTED_FILES = [
  'src/main.js',
  'src/contracts.js',
  'src/core/engine.js',
  'src/core/events.js',
  'src/core/input.js',
  'src/kart/kart.js',
  'src/kart/kartFactory.js',
  'src/track/trackData.js',
  'src/track/trackBuilder.js',
  'src/track/environment.js',
  'src/ai/aiDriver.js',
  'src/race/raceManager.js',
  'src/items/itemSystem.js',
  'src/ui/hud.js',
  'src/ui/menus.js',
  'src/audio/audio.js',
  'src/fx/effects.js',
  'src/fx/postprocessing.js',
];

function checkInventory() {
  startCheck(1, 'module inventory');
  const missing = [];
  const empty = [];
  for (const file of EXPECTED_FILES) {
    const full = path.join(ROOT, file);
    if (!existsSync(full) || !statSync(full).isFile()) {
      missing.push(file);
      continue;
    }
    if (statSync(full).size === 0) empty.push(file);
  }
  if (missing.length) fail(`missing files: ${missing.join(', ')}`);
  if (empty.length) fail(`empty files: ${empty.join(', ')}`);
  const actual = listFiles(SRC, (f) => f.endsWith('.js')).map(rel).sort();
  const extra = actual.filter((f) => !EXPECTED_FILES.includes(f));
  if (extra.length) info(`extra modules (allowed): ${extra.join(', ')}`);
  setDetail(`${actual.length} JS modules, ${missing.length} missing, ${empty.length} empty`);
}

// ---------------------------------------------------------------------------
// Check 2 — syntax (`node --check`)
// ---------------------------------------------------------------------------
function checkSyntax() {
  startCheck(2, 'syntax (node --check)');
  const files = listFiles(SRC, (f) => f.endsWith('.js')).sort();
  let failed = 0;
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      failed++;
      const msg = (res.stderr || res.stdout || 'unknown error').trim().split('\n').slice(0, 3).join(' | ');
      fail(`${rel(file)} → ${msg}`);
    }
  }
  setDetail(`${files.length} files checked, ${failed} failed`);
}

// ---------------------------------------------------------------------------
// Check 3 — required exports
// ---------------------------------------------------------------------------
const REQUIRED_EXPORTS = {
  'src/core/engine.js': ['Engine'],
  'src/core/input.js': ['createInput'],
  'src/kart/kart.js': ['Kart'],
  'src/kart/kartFactory.js': ['createKartMesh'],
  'src/track/trackData.js': ['getTrack', 'TRACK_DEFS'],
  'src/track/trackBuilder.js': ['TrackBuilder'],
  'src/track/environment.js': ['createEnvironment'],
  'src/ai/aiDriver.js': ['AIDriver'],
  'src/race/raceManager.js': ['RaceManager'],
  'src/items/itemSystem.js': ['ItemSystem'],
  'src/ui/hud.js': ['HUD'],
  'src/ui/menus.js': ['Menus'],
  'src/audio/audio.js': ['AudioManager'],
  'src/fx/effects.js': ['Effects'],
  'src/fx/postprocessing.js': ['PostFX'],
};

function hasExport(source, name) {
  const escaped = name.replace(/[$]/g, '\\$');
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?(?:class|function|const|let|var)\\s+${escaped}\\b`),
    new RegExp(`export\\s+default\\s+(?:async\\s+)?(?:class|function)\\s+${escaped}\\b`),
    new RegExp(`export\\s*\\{[\\s\\S]*?\\b${escaped}\\b[\\s\\S]*?\\}`),
  ];
  return patterns.some((re) => re.test(source));
}

function checkExports() {
  startCheck(3, 'required exports');
  let missing = 0;
  for (const [file, names] of Object.entries(REQUIRED_EXPORTS)) {
    const source = read(path.join(ROOT, file));
    if (!source) {
      fail(`${file} → unreadable`);
      missing += names.length;
      continue;
    }
    for (const name of names) {
      if (!hasExport(source, name)) {
        fail(`${file} → missing export "${name}"`);
        missing++;
      }
    }
  }
  setDetail(`${Object.keys(REQUIRED_EXPORTS).length} modules, ${missing} missing exports`);
}

// ---------------------------------------------------------------------------
// Check 4 — contracts integrity
// ---------------------------------------------------------------------------
const FROZEN_EVENTS = {
  GAME_STATE: 'game:state',
  UI_RACE_CONFIG: 'ui:race-config',
  UI_PAUSE: 'ui:pause',
  UI_RESUME: 'ui:resume',
  UI_RESTART: 'ui:restart',
  UI_QUIT: 'ui:quit',
  UI_SETTINGS: 'ui:settings',
  UI_READY: 'ui:ready',
  RACE_COUNTDOWN: 'race:countdown',
  RACE_START: 'race:start',
  RACE_LAP: 'race:lap',
  RACE_FINAL_LAP: 'race:final-lap',
  RACE_FINISH: 'race:finish',
  RACE_COMPLETE: 'race:complete',
  RACE_TIMER: 'race:timer',
  KART_BOOST: 'kart:boost',
  KART_DRIFT_START: 'kart:drift-start',
  KART_DRIFT_CHARGE: 'kart:drift-charge',
  KART_DRIFT_BOOST: 'kart:drift-boost',
  KART_HOP: 'kart:hop',
  KART_LAND: 'kart:land',
  KART_OFFROAD: 'kart:offroad',
  KART_HIT: 'kart:hit',
  KART_SPIN: 'kart:spin',
  KART_SQUASH: 'kart:squash',
  KART_ROCKET_START: 'kart:rocket-start',
  KART_WRONG_WAY: 'kart:wrong-way',
  KART_FINISHED: 'kart:finished',
  ITEM_BOX: 'item:box',
  ITEM_ROLL: 'item:roll',
  ITEM_USE: 'item:use',
  ITEM_HIT: 'item:hit',
  ITEM_BLOCKED: 'item:blocked',
  ITEM_EXPIRE: 'item:expire',
  FX_SPAWN: 'fx:spawn',
  AUDIO_SFX: 'audio:sfx',
  AUDIO_MUSIC: 'audio:music',
  CAMERA_SHAKE: 'camera:shake',
};

async function checkContracts() {
  startCheck(4, 'contracts integrity');
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'src/contracts.js')).href);
  } catch (err) {
    fail(`src/contracts.js failed to import: ${err?.message || err}`);
    return;
  }
  const events = mod.EVENTS || {};
  const frozenKeys = Object.keys(FROZEN_EVENTS).sort();
  const actualKeys = Object.keys(events).sort();
  if (frozenKeys.join(',') !== actualKeys.join(',')) {
    const missing = frozenKeys.filter((k) => !actualKeys.includes(k));
    const extra = actualKeys.filter((k) => !frozenKeys.includes(k));
    fail(`EVENTS keys changed${missing.length ? ` (missing: ${missing.join(', ')})` : ''}${extra.length ? ` (extra: ${extra.join(', ')})` : ''}`);
  }
  for (const [key, value] of Object.entries(FROZEN_EVENTS)) {
    if (events[key] !== value) fail(`EVENTS.${key} = ${JSON.stringify(events[key])}, expected ${JSON.stringify(value)}`);
  }
  const characters = mod.CHARACTERS;
  if (!Array.isArray(characters) || characters.length !== 8) {
    fail(`CHARACTERS.length = ${characters?.length}, expected 8`);
  } else {
    const ids = new Set(characters.map((ch) => ch?.id));
    if (ids.size !== 8) fail('CHARACTERS ids are not unique');
    for (const ch of characters) {
      if (!ch?.name || typeof ch?.color !== 'number' || !ch?.stats) fail(`character "${ch?.id}" is missing required fields`);
    }
  }
  const tracks = mod.TRACKS;
  if (!Array.isArray(tracks) || tracks.length < 3) fail(`TRACKS.length = ${tracks?.length}, expected >= 3`);
  if (!Array.isArray(mod.QUALITY_PRESETS) || mod.QUALITY_PRESETS.join(',') !== 'low,medium,high,ultra') {
    fail(`QUALITY_PRESETS = ${JSON.stringify(mod.QUALITY_PRESETS)}`);
  }
  if (!mod.RACE || mod.RACE.KART_COUNT !== 8) fail(`RACE.KART_COUNT = ${mod.RACE?.KART_COUNT}, expected 8`);

  // Cross-module usage: no subsystem may reference an EVENTS/SFX key that does
  // not exist (typos are silent runtime no-ops otherwise).
  const eventKeys = new Set(Object.keys(events));
  const sfxKeys = new Set(Object.keys(mod.SFX || {}));
  let badRefs = 0;
  for (const file of listFiles(SRC, (f) => f.endsWith('.js')).sort()) {
    const source = stripComments(read(file));
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bEVENTS\.([A-Z0-9_]+)/g)) {
        if (!eventKeys.has(m[1])) {
          badRefs++;
          fail(`${rel(file)}:${i + 1} → EVENTS.${m[1]} is not in the frozen contract`);
        }
      }
      for (const m of line.matchAll(/\bSFX\.([A-Z0-9_]+)/g)) {
        if (!sfxKeys.has(m[1])) {
          badRefs++;
          fail(`${rel(file)}:${i + 1} → SFX.${m[1]} is not in the frozen contract`);
        }
      }
    });
  }
  setDetail(`${actualKeys.length} events, ${characters?.length ?? '?'} characters, ${tracks?.length ?? '?'} tracks, ${badRefs} bad refs`);
}

// ---------------------------------------------------------------------------
// Check 5 — relative imports resolve
// ---------------------------------------------------------------------------
const FROM_RE = /\bfrom\s*['"](\.[^'"]+)['"]/g;
const BARE_IMPORT_RE = /^\s*import\s+['"](\.[^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function checkImports() {
  startCheck(5, 'relative imports resolve');
  const files = listFiles(SRC, (f) => f.endsWith('.js')).sort();
  let total = 0;
  let broken = 0;
  for (const file of files) {
    const source = read(file);
    const dir = path.dirname(file);
    const specs = new Set();
    for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(source)) !== null) specs.add(m[1]);
    }
    for (const spec of specs) {
      total++;
      const base = path.resolve(dir, spec);
      const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
      if (!candidates.some((p) => existsSync(p) && statSync(p).isFile())) {
        broken++;
        fail(`${rel(file)} → unresolved import "${spec}"`);
      }
    }
  }
  setDetail(`${total} relative imports in ${files.length} modules, ${broken} unresolved`);
}

// ---------------------------------------------------------------------------
// Check 6 — stub markers
// ---------------------------------------------------------------------------
function checkStubs() {
  startCheck(6, 'no stub markers');
  const files = listFiles(SRC, (f) => f.endsWith('.js')).sort();
  const patterns = [
    { re: /STUB\s*[—–-]/g, label: 'STUB marker' },
    { re: /Replace with the full implementation/g, label: 'stub instruction text' },
  ];
  let hits = 0;
  for (const file of files) {
    const source = read(file);
    const lines = source.split('\n');
    for (const { re, label } of patterns) {
      re.lastIndex = 0;
      lines.forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) {
          hits++;
          fail(`${rel(file)}:${i + 1} → ${label}: "${line.trim().slice(0, 80)}"`);
        }
      });
    }
  }
  setDetail(`${files.length} modules scanned, ${hits} stub markers`);
}

// ---------------------------------------------------------------------------
// Check 7 — banned patterns
// ---------------------------------------------------------------------------
const BANNED = [
  { re: /\bimport\b[^\n;]*\bfrom\s*['"]https?:/g, label: 'remote import' },
  { re: /\bfetch\s*\(/g, label: 'fetch()' },
  { re: /\bXMLHttpRequest\b/g, label: 'XMLHttpRequest' },
  { re: /\brequire\s*\(/g, label: 'require()' },
  { re: /\bnew\s+WebSocket\s*\(/g, label: 'WebSocket' },
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function checkBanned() {
  startCheck(7, 'no banned patterns');
  const files = listFiles(SRC, (f) => f.endsWith('.js')).sort();
  let hits = 0;
  for (const file of files) {
    const source = stripComments(read(file));
    const lines = source.split('\n');
    for (const { re, label } of BANNED) {
      lines.forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) {
          hits++;
          fail(`${rel(file)}:${i + 1} → ${label}: "${line.trim().slice(0, 80)}"`);
        }
      });
    }
  }
  setDetail(`${files.length} modules scanned, ${hits} banned patterns`);
}

// ---------------------------------------------------------------------------
// Check 8 — ownership guard (warnings only)
// ---------------------------------------------------------------------------
const OWNERSHIP = [
  { owner: 'Agent 1 (Engine & Kart)', prefixes: ['src/core/', 'src/kart/'] },
  { owner: 'Agent 2 (Track)', prefixes: ['src/track/'] },
  { owner: 'Agent 3 (AI & Race)', prefixes: ['src/ai/', 'src/race/', 'src/items/'] },
  { owner: 'Agent 4 (Items, UI & Audio)', prefixes: ['src/ui/', 'src/audio/'] },
  { owner: 'Agent 5 (FX, PostFX & QA)', prefixes: ['src/fx/', 'tests/', 'QA_REPORT.md'] },
];
const FROZEN_FILES = [
  'src/main.js', 'src/contracts.js', 'src/core/events.js',
  'index.html', 'package.json', 'vite.config.js', 'package-lock.json',
  'docs/CONVENTIONS.md',
];

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return (res.stdout || '').trim();
}

function checkOwnership() {
  startCheck(8, 'ownership guard');
  const baselineEnv = process.env.TK_BASELINE;
  const rootCommit = git(['rev-list', '--max-parents=0', 'HEAD']);
  const baseline = baselineEnv || (rootCommit ? rootCommit.split('\n')[0] : null);
  if (!baseline) {
    warn('not a git repository (or no commits) — ownership guard skipped');
    return;
  }
  const tracked = git(['diff', '--name-only', baseline, '--']) || '';
  const untracked = git(['ls-files', '--others', '--exclude-standard']) || '';
  const changed = [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort();
  const outside = [];
  const frozen = [];
  const reports = [];
  const byOwner = new Map();
  for (const file of changed) {
    if (file.startsWith('docs/reports/')) {
      reports.push(file);
      continue;
    }
    if (FROZEN_FILES.includes(file) || file.startsWith('docs/')) {
      frozen.push(file);
      continue;
    }
    const owner = OWNERSHIP.find((o) => o.prefixes.some((p) => file.startsWith(p) || file === p));
    if (owner) {
      if (!byOwner.has(owner.owner)) byOwner.set(owner.owner, []);
      byOwner.get(owner.owner).push(file);
    } else {
      outside.push(file);
    }
  }
  for (const [owner, files] of byOwner) info(`${owner}: ${files.length} file(s)`);
  if (reports.length) info(`agent reports: ${reports.length} file(s)`);
  if (frozen.length) warn(`frozen/shared files modified (orchestrator must review): ${frozen.join(', ')}`);
  if (outside.length) warn(`files outside every ownership area: ${outside.join(', ')}`);
  info(`baseline ${baseline.slice(0, 9)}, ${changed.length} file(s) changed`);
  setDetail(`${changed.length} changed vs ${baseline.slice(0, 7)}, ${frozen.length} frozen, ${outside.length} unknown`);
}

// ---------------------------------------------------------------------------
// Check 10 — headless FX behaviour (skipped without `three`)
// ---------------------------------------------------------------------------
function checkHeadlessFx() {
  startCheck(10, 'headless FX behaviour');
  let threeAvailable = true;
  try {
    // eslint-disable-next-line no-undef
    const res = spawnSync(process.execPath, ['-e', "import('three').then(()=>process.exit(0)).catch(()=>process.exit(9))"], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
    });
    threeAvailable = res.status === 0;
  } catch (err) {
    threeAvailable = false;
  }
  if (!threeAvailable) {
    warn('the `three` dependency is not installed — headless FX test skipped (run `npm install`)');
    setDetail('skipped (three missing)');
    return;
  }
  const res = spawnSync(process.execPath, ['tests/fx-headless.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  const lines = out.split('\n');
  const resultLine = lines.find((l) => l.startsWith('RESULT:')) || 'no RESULT line';
  if (res.status !== 0) {
    fail(`tests/fx-headless.mjs failed (${resultLine})`);
    for (const line of lines.filter((l) => l.trim().startsWith('FAIL'))) fail(line.trim());
  } else {
    info(resultLine);
  }
  setDetail(resultLine.replace('RESULT: ', ''));
}

// ---------------------------------------------------------------------------
// Check 11 — headless integration (skipped without `three`)
// ---------------------------------------------------------------------------
function checkHeadlessIntegration() {
  startCheck(11, 'headless integration (race sim)');
  let threeAvailable = true;
  try {
    const res = spawnSync(process.execPath, ['-e', "import('three').then(()=>process.exit(0)).catch(()=>process.exit(9))"], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
    });
    threeAvailable = res.status === 0;
  } catch (err) {
    threeAvailable = false;
  }
  if (!threeAvailable) {
    warn('the `three` dependency is not installed — integration test skipped (run `npm install`)');
    setDetail('skipped (three missing)');
    return;
  }
  const res = spawnSync(process.execPath, ['tests/integration-headless.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  const lines = out.split('\n');
  const resultLine = lines.find((l) => l.startsWith('RESULT:')) || 'no RESULT line';
  const crash = lines.find((l) => l.includes('crashed:'));
  if (res.status !== 0) {
    fail(`tests/integration-headless.mjs failed (${resultLine})`);
    if (crash) fail(crash.trim().slice(0, 200));
    for (const line of lines.filter((l) => l.trim().startsWith('FAIL'))) fail(line.trim());
    for (const line of lines.filter((l) => l.trim().startsWith('info'))) info(line.trim());
  } else {
    for (const line of lines.filter((l) => l.trim().startsWith('info'))) info(line.trim());
    info(resultLine);
  }
  setDetail(resultLine.replace('RESULT: ', ''));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function printReport(elapsedMs) {
  const width = 64;
  console.log('');
  console.log(`${c.bold}${c.cyan}╔${'═'.repeat(width)}╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║${c.reset} ${c.bold}TURBO KART — SMOKE TEST${c.reset}${' '.repeat(width - 24)}${c.bold}${c.cyan}║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚${'═'.repeat(width)}╝${c.reset}`);
  console.log('');
  for (const r of results) {
    const tag = r.status === 'pass'
      ? `${c.green}PASS${c.reset}`
      : r.status === 'warn' ? `${c.yellow}WARN${c.reset}` : `${c.red}FAIL${c.reset}`;
    console.log(`${tag}  ${c.bold}${r.id}. ${r.name}${c.reset}  ${c.dim}${r.detail}${c.reset}`);
    for (const line of r.lines) {
      const bullet = r.status === 'fail' ? `${c.red}  ✗${c.reset}` : `${c.yellow}  !${c.reset}`;
      console.log(`${bullet} ${line}`);
    }
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log('');
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`  checks : ${results.length}   ${c.green}pass ${passed}${c.reset}   ${c.yellow}warn ${warned}${c.reset}   ${c.red}fail ${failed}${c.reset}`);
  console.log(`  time   : ${elapsedMs} ms`);
  console.log('');
  if (failed === 0) {
    console.log(`${c.green}${c.bold}RESULT: PASS${c.reset}${warned ? ` ${c.yellow}(${warned} warning${warned === 1 ? '' : 's'})${c.reset}` : ''}`);
  } else {
    console.log(`${c.red}${c.bold}RESULT: FAIL — ${failed} check${failed === 1 ? '' : 's'} failed${c.reset}`);
  }
  console.log('');
  return failed === 0 ? 0 : 1;
}

async function main() {
  const t0 = Date.now();
  checkInventory();
  checkSyntax();
  checkExports();
  await checkContracts();
  checkImports();
  checkStubs();
  checkBanned();
  checkOwnership();
  checkHeadlessFx();
  checkHeadlessIntegration();
  const code = printReport(Date.now() - t0);
  process.exit(code);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
