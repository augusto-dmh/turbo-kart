// STUB — owned by Agent 4 (UI, HUD & Audio). Replace with the full menu system.
import { EVENTS, MODES, TRACKS, DIFFICULTIES } from '../contracts.js';
import './styles.css';

export class Menus {
  constructor({ bus, container, characters = [], settings = {} }) {
    this.bus = bus;
    this.container = container;
    this.characters = characters;
    this.settings = settings;
    this.root = document.createElement('div');
    this.root.className = 'menus clickable';
    this.root.style.cssText = 'position:absolute;inset:0;display:none;place-items:center;background:#0b1020cc;';
    container.appendChild(this.root);
    this._hidden = true;
  }

  _mount(html) {
    this.root.innerHTML = html;
    this.root.style.display = 'grid';
    this.root.querySelectorAll('[data-click]').forEach((el) => {
      el.addEventListener('click', () => this.bus?.emit?.(EVENTS.AUDIO_SFX, { name: 'ui-click' }));
    });
    document.getElementById('boot-overlay')?.classList.add('hidden');
  }

  showTitle(config = {}) {
    this._mount(`
      <div style="text-align:center">
        <h1 style="font-size:64px;letter-spacing:.2em;margin:0">TURBO KART</h1>
        <p style="opacity:.8">Three.js kart racer — scaffold running</p>
        <button data-start data-click style="font-size:22px;padding:14px 36px;margin-top:20px;cursor:pointer">START RACE</button>
      </div>`);
    this.root.querySelector('[data-start]')?.addEventListener('click', () => {
      this.hide();
      this.bus?.emit?.(EVENTS.UI_RACE_CONFIG, { trackId: TRACKS[0].id, characterId: this.characters[0]?.id, difficulty: DIFFICULTIES[1], mode: MODES.GP });
    });
  }

  hide() { this.root.style.display = 'none'; }

  showPause() {
    this._mount(`<div style="text-align:center"><h2>PAUSED</h2>
      <button data-resume data-click>Resume</button>
      <button data-quit data-click>Quit</button></div>`);
    this.root.querySelector('[data-resume]')?.addEventListener('click', () => this.bus?.emit?.(EVENTS.UI_RESUME));
    this.root.querySelector('[data-quit]')?.addEventListener('click', () => this.bus?.emit?.(EVENTS.UI_QUIT));
  }

  hidePause() { if (!this._hidden) this.root.style.display = 'none'; }

  showResults(standings = [], opts = {}) {
    const rows = standings.map((s) => `<tr><td>${s.place}</td><td>${s.kart?.name || 'Kart'}</td><td>${(s.finishTime || 0).toFixed(2)}s</td></tr>`).join('');
    this._mount(`<div style="text-align:center;background:#111c;padding:24px;border-radius:16px">
      <h2>RESULTS</h2><table>${rows}</table>
      <button data-again data-click>Race again</button>
      <button data-menu data-click>Menu</button></div>`);
    this.root.querySelector('[data-again]')?.addEventListener('click', () => { this.hide(); this.bus?.emit?.(EVENTS.UI_RESTART); });
    this.root.querySelector('[data-menu]')?.addEventListener('click', () => { this.hide(); this.bus?.emit?.(EVENTS.UI_QUIT); });
  }
}
