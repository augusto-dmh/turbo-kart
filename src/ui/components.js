/**
 * Small DOM / formatting helpers shared by the HUD, the minimap and the menus.
 * Owned by Agent 4. No dependencies, no side effects on import.
 */

import { ITEMS, getCharacter } from '../contracts.js';

/** Clamp a number into [min, max]. */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Linear interpolation. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** English ordinal suffix for a positive integer: 1 → 'st', 11 → 'th'. */
export function ordinalSuffix(n) {
  const v = Math.abs(Math.round(n)) % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (v % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/** 3 → '3rd'. */
export function ordinal(n) {
  const v = Math.max(1, Math.round(Number(n) || 1));
  return `${v}${ordinalSuffix(v)}`;
}

/**
 * Race clock formatting: `1:23.45`, or `23.45` when under a minute.
 * @param {number} seconds
 */
export function formatTime(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(t / 60);
  const secs = t - mins * 60;
  const ss = secs < 10 ? `0${secs.toFixed(2)}` : secs.toFixed(2);
  return mins > 0 ? `${mins}:${ss}` : secs.toFixed(2);
}

/** `0xff3b30` / `'#ff3b30'` / `123` → `'#ff3b30'`. Always returns a safe color. */
export function hexColor(value, fallback = '#ffffff') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (s.startsWith('#')) return s.length >= 4 ? s : fallback;
    const n = Number(s);
    if (Number.isFinite(n)) return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  return fallback;
}

/**
 * Normalize whatever the item system hands us into an `ItemDef`-ish object.
 * Accepts an id string, a full def, or null.
 */
export function resolveItem(item) {
  if (!item) return null;
  if (typeof item === 'string') return ITEMS[item] || { id: item, name: item, icon: '❔', color: 0xffffff, offensive: false };
  const id = item.id || item.name || 'unknown';
  const def = ITEMS[id] || {};
  return {
    id,
    name: item.name || def.name || id,
    icon: item.icon || def.icon || '❔',
    color: item.color ?? def.color ?? 0xffffff,
    offensive: item.offensive ?? def.offensive ?? false,
    count: item.count ?? item.charges ?? item.quantity ?? null,
  };
}

/** How many charges a held item has (triple items default to 3). */
export function itemCount(item) {
  if (!item) return 0;
  const explicit = item.count ?? item.charges ?? item.quantity;
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const id = String(item.id || '');
  if (id.startsWith('triple')) return 3;
  return 1;
}

/** Character lookup that never throws. */
export function characterOf(kartOrId) {
  const id = typeof kartOrId === 'string' ? kartOrId : kartOrId?.characterId;
  if (!id) return null;
  try {
    return getCharacter(id);
  } catch {
    return null;
  }
}

/** `'★★★☆☆'` style rating string. */
export function stars(count, max = 5) {
  const n = clamp(Math.round(count) || 0, 0, max);
  return '★'.repeat(n) + '☆'.repeat(max - n);
}

/** Create an element with an optional class and inner HTML/text. */
export function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.innerHTML = content;
  return node;
}

/** Turn an HTML string into a single element. */
export function fromHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

/** Escape user/AI-provided text before injecting it into innerHTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** True when the user asked for reduced motion. */
export function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch {
    return false;
  }
}

/**
 * Restart a CSS animation on an element (removes the class, forces a reflow,
 * re-adds it). Returns false when the element is missing.
 */
export function restartAnimation(node, className) {
  if (!node) return false;
  node.classList.remove(className);
  // eslint-disable-next-line no-unused-expressions
  void node.offsetWidth; // force style flush so the animation replays
  node.classList.add(className);
  return true;
}

/** Set text only when it actually changed (keeps DOM writes cheap). */
export function setText(node, value) {
  if (!node) return;
  const text = value == null ? '' : String(value);
  if (node.__tkText === text) return;
  node.__tkText = text;
  node.textContent = text;
}

/** Toggle a class only when needed. */
export function setClass(node, className, on) {
  if (!node) return;
  if (on) {
    if (!node.classList.contains(className)) node.classList.add(className);
  } else if (node.classList.contains(className)) {
    node.classList.remove(className);
  }
}

/** Toggle the `hidden` attribute cheaply. */
export function setHidden(node, hidden) {
  if (!node) return;
  if (hidden) {
    if (!node.hasAttribute('hidden')) node.setAttribute('hidden', '');
  } else if (node.hasAttribute('hidden')) {
    node.removeAttribute('hidden');
  }
}

/**
 * Deterministic pseudo-random generator (mulberry32). Used for decorative
 * elements (confetti, previews) so screens look stable between re-renders.
 */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
