import { Game } from './game/game';
import { micSupported, warmUpMic } from './ui/mic';

declare global {
  interface Window {
    __skimReport: (event: string, detail?: string) => void;
    __skimBootError: (msg: string) => void;
  }
}
/** No console on the Quest: report to the server log (index.html defines it before any module). */
const report = (event: string, detail = '') => window.__skimReport?.(event, detail);

let built: Game;
try {
  built = new Game(document.getElementById('app')!);
} catch (e) {
  window.__skimBootError?.(e instanceof Error ? `${e.name}: ${e.message} ${e.stack?.split('\n')[1]?.trim() ?? ''}` : String(e));
  throw e;
}
const game = built;
const splash = document.getElementById('splash')!;
const play = document.getElementById('play') as HTMLButtonElement;
const flat = document.getElementById('flat') as HTMLButtonElement;
const vrerr = document.getElementById('vrerr')!;

function go() {
  splash.classList.add('gone');
  game.start();
}

// On a headset browser (Quest), the button must enter VR: flat mode needs a keyboard.
let vrReady = false;
const VR_LABEL = 'Enter VR and ride';
navigator.xr
  ?.isSessionSupported('immersive-vr')
  .then((ok) => {
    report('ready', `immersive-vr=${ok}`);
    if (!ok) return;
    vrReady = true;
    play.textContent = VR_LABEL;
  })
  .catch(() => undefined);

play.addEventListener('click', () => {
  if (!vrReady) return go();
  // Keep the splash up until VR really starts, so a failure is visible instead of "nothing".
  play.disabled = true;
  play.textContent = 'Entering VR…';
  vrerr.hidden = true;
  report('vr-click', navigator.userAgent);
  game
    .enterVR()
    .then(() => report('vr-ok'))
    .catch((e: unknown) => {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      report('vr-fail', msg);
      play.disabled = false;
      play.textContent = VR_LABEL;
      vrerr.textContent = `Couldn't enter VR (${msg}). Try again, or ride on the screen.`;
      vrerr.hidden = false;
      flat.hidden = false;
    });
});
flat.addEventListener('click', go);

// Freeform talk needs the mic. Ask here, on the flat page, so the permission prompt
// doesn't have to appear inside VR. Hidden once granted (or where there is no mic API).
const micBtn = document.getElementById('mic') as HTMLButtonElement | null;
if (micBtn && micSupported()) {
  const show = (state: string) => (micBtn.hidden = state === 'granted');
  navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .then((st) => {
      show(st.state);
      st.onchange = () => show(st.state);
    })
    .catch(() => show('prompt'));
  micBtn.addEventListener('click', async () => {
    const ok = await warmUpMic();
    report('mic-warmup', String(ok));
    micBtn.textContent = ok ? '🎤 Mic ready' : '🎤 Mic blocked: allow it in browser settings';
    if (ok) setTimeout(() => (micBtn.hidden = true), 1200);
  });
}

// Entering VR starts the world; leaving VR brings the splash back so you can re-enter.
game.renderer.xr.addEventListener('sessionstart', go);
game.renderer.xr.addEventListener('sessionend', () => {
  play.disabled = false;
  play.textContent = VR_LABEL;
  splash.classList.remove('gone');
});
// Automation / screenshots: ?autostart
if (new URLSearchParams(location.search).has('autostart')) go();
