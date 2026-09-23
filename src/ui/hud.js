// STUB — owned by Agent 4 (UI, HUD & Audio). Replace with the full HUD.
import './styles.css';

export class HUD {
  constructor({ bus, container }) {
    this.bus = bus;
    this.container = container;
    this.root = document.createElement('div');
    this.root.className = 'hud clickable';
    this.root.style.cssText = 'position:absolute;inset:0;display:none;pointer-events:none;font-weight:700;text-shadow:0 2px 6px #000a;';
    this.root.innerHTML = `
      <div data-speed style="position:absolute;right:24px;bottom:20px;font-size:44px"></div>
      <div data-lap style="position:absolute;left:24px;bottom:20px;font-size:28px"></div>
      <div data-place style="position:absolute;left:24px;top:20px;font-size:40px"></div>
      <div data-item style="position:absolute;left:50%;top:16px;transform:translateX(-50%);font-size:40px"></div>
      <div data-count style="position:absolute;inset:0;display:grid;place-items:center;font-size:120px"></div>`;
    container.appendChild(this.root);
    this.el = {
      speed: this.root.querySelector('[data-speed]'),
      lap: this.root.querySelector('[data-lap]'),
      place: this.root.querySelector('[data-place]'),
      item: this.root.querySelector('[data-item]'),
      count: this.root.querySelector('[data-count]'),
    };
  }

  setTrack() {}
  setMode() {}
  setQuality() {}
  show() { this.root.style.display = 'block'; }
  hide() { this.root.style.display = 'none'; }
  showCountdown(v) { this.el.count.textContent = String(v); }
  hideCountdown() { this.el.count.textContent = ''; }
  update(dt, view) {
    this.el.speed.textContent = `${Math.round(view.speed * 3.6)} km/h`;
    this.el.lap.textContent = `LAP ${view.lap}/${view.laps}`;
    this.el.place.textContent = `${view.place}/${view.totalKarts}`;
    this.el.item.textContent = view.item ? view.item.icon : '';
  }
}
