/**
 * Orchestrator probe — pause/resume behaviour.
 * node tools/browser-qa.mjs --gpu --eval-file tools/probe-pause.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = window.__TURBO_KART__;
  const press = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }))
    && window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  const menuVisible = () => {
    const root = document.querySelector('#ui-root');
    const txt = (root?.innerText || '').replace(/\s+/g, ' ');
    return /PAUSED|RESUME/i.test(txt) ? txt.slice(0, 60) : null;
  };
  const steps = [];
  const snap = (label) => steps.push({ label, paused: g.paused, state: g.state, menu: menuVisible() });

  g.startRace({ ...g.config });
  await sleep(2500);
  snap('after-start');

  press('Escape'); await sleep(500); snap('escape-1');
  press('Escape'); await sleep(500); snap('escape-2');
  press('Escape'); await sleep(500); snap('escape-3');

  // click the Resume button if the pause menu is up
  const clicked = await (async () => {
    const btns = [...document.querySelectorAll('#ui-root button')].filter((b) => b.offsetParent !== null);
    const resume = btns.find((b) => /resume/i.test(b.textContent));
    if (resume) { resume.click(); return true; }
    return false;
  })();
  await sleep(500);
  snap('after-resume-click');

  // quit to menu from pause, then verify the menu comes back
  press('Escape'); await sleep(400);
  const quit = await (async () => {
    const btns = [...document.querySelectorAll('#ui-root button')].filter((b) => b.offsetParent !== null);
    const q = btns.find((b) => /quit/i.test(b.textContent));
    if (q) { q.click(); return true; }
    return false;
  })();
  await sleep(900);
  snap('after-quit');
  return { steps, resumeButtonFound: clicked, quitButtonFound: quit, raceDisposed: !g.race };
})()
