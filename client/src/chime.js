/**
 * playMessageChime — a short, pleasant two-note tone played when a new chat
 * message arrives while the app is open. Generated with the Web Audio API so
 * there is no binary asset to ship.
 *
 * The AudioContext is created lazily and resumed on use. Browsers block audio
 * until the user has interacted with the page; by the time a message arrives
 * the user has almost always interacted, so the chime is allowed. If it's still
 * blocked (or Web Audio is unavailable), we fail silently — a missed chime is
 * never worth an error.
 */

let ctx = null;

function getCtx() {
  if (ctx) return ctx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  ctx = new AudioCtx();
  return ctx;
}

// Play a single note: a sine tone with a quick attack and a smooth decay so it
// sounds like a soft "ding" rather than a click.
function note(ac, freq, startAt, duration) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.18, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

export function playMessageChime() {
  try {
    const ac = getCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const now = ac.currentTime;
    // Two ascending notes (E6 → A6) — a gentle "message received" motif.
    note(ac, 1318.5, now, 0.18);
    note(ac, 1760.0, now + 0.13, 0.22);
  } catch {
    // Autoplay blocked or Web Audio unavailable — ignore.
  }
}
