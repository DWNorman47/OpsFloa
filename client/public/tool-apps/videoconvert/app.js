// OpsFloa offline video converter — runs ffmpeg.wasm (multithreaded) entirely in the
// browser on this cross-origin-isolated page. No upload, no server, no external app.
// Self-contained static tool-app; not part of the React bundle (so it isn't linted/bundled).
import { FFmpeg } from './ffmpeg/index.js';

// ── tiny i18n (launcher passes ?lang=English|Spanish) ───────────────────────────
const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'Spanish' ? 'es' : 'en';
const STR = {
  en: {
    title: 'Video Converter',
    sub: 'Convert a video (including iPhone / QuickTime .mov) to MP4 and more — entirely on this device.',
    dropBig: 'Choose a video or drop it here',
    dropSmall: 'Nothing is uploaded — it stays on your computer.',
    format: 'Convert to',
    log: 'Details',
    convert: 'Convert',
    converting: 'Converting…',
    change: 'Change',
    foot: 'Runs on your device with ffmpeg (WebAssembly). The first run downloads the ~32 MB engine once, then works offline.',
    loadingEngine: 'Loading converter engine (first time downloads ~32 MB)…',
    engineReady: 'Engine ready.',
    reading: 'Reading file…',
    done: 'Done — your download should start automatically.',
    downloadAgain: 'Download again',
    failed: 'Conversion failed. See Details below.',
    engineFailed: 'Could not start the converter engine. See Details below.',
    noIsolation: 'Multithreading needs the deployed, cross-origin-isolated page. Open this from the Convert button in OpsFloa (not a local file). It may still run single-threaded, or fail — check Details.',
    handoffGone: "Couldn't load the passed-in video (it may have expired). Pick a file below.",
    fmt_mp4: 'MP4 · H.264 (most compatible)',
    fmt_remux: 'MP4 · fast (no re-encode, only if already H.264)',
    fmt_webm: 'WebM · VP9',
    fmt_mp3: 'Audio only · MP3',
    hint_remux: 'Tip: iPhone / QuickTime videos are usually already H.264 — try "MP4 · fast (no re-encode)" first. It finishes in seconds. Only use a re-encode option if that file won’t play (HEVC) or you need it smaller.',
    hint_slow: '⚠ Heads-up: re-encoding re-compresses every frame in your browser. For a large, long, or 4K video this can take well over an hour — that’s normal, it is NOT frozen. "MP4 · fast" is instant if the video is already H.264, so try that first.',
    slow_running: 'Working — not stuck. A large video can take well over an hour to re-encode. You don’t need to watch it: leave this tab open (you can switch to other tabs) and come back. Or hit Cancel and use "MP4 · fast".',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    canceled: 'Canceled.',
    converting_t: (s) => `Converting… (${fmtElapsed(s)} elapsed)`,
  },
  es: {
    title: 'Convertidor de video',
    sub: 'Convierte un video (incluido iPhone / QuickTime .mov) a MP4 y más — todo en este dispositivo.',
    dropBig: 'Elige un video o suéltalo aquí',
    dropSmall: 'No se sube nada — se queda en tu computadora.',
    format: 'Convertir a',
    log: 'Detalles',
    convert: 'Convertir',
    converting: 'Convirtiendo…',
    change: 'Cambiar',
    foot: 'Funciona en tu dispositivo con ffmpeg (WebAssembly). La primera vez descarga el motor de ~32 MB una sola vez; luego funciona sin conexión.',
    loadingEngine: 'Cargando el motor de conversión (la primera vez descarga ~32 MB)…',
    engineReady: 'Motor listo.',
    reading: 'Leyendo archivo…',
    done: 'Listo — la descarga debería iniciar automáticamente.',
    downloadAgain: 'Descargar de nuevo',
    failed: 'La conversión falló. Consulta Detalles abajo.',
    engineFailed: 'No se pudo iniciar el motor de conversión. Consulta Detalles abajo.',
    noIsolation: 'El multihilo requiere la página desplegada y aislada (cross-origin). Ábrela desde el botón Convertir en OpsFloa. Puede funcionar en un solo hilo o fallar — revisa Detalles.',
    handoffGone: 'No se pudo cargar el video recibido (pudo expirar). Elige un archivo abajo.',
    fmt_mp4: 'MP4 · H.264 (más compatible)',
    fmt_remux: 'MP4 · rápido (sin recodificar, solo si ya es H.264)',
    fmt_webm: 'WebM · VP9',
    fmt_mp3: 'Solo audio · MP3',
    hint_remux: 'Consejo: los videos de iPhone / QuickTime normalmente ya son H.264 — prueba primero "MP4 · rápido (sin recodificar)". Termina en segundos. Usa una opción de recodificación solo si ese archivo no se reproduce (HEVC) o lo necesitas más pequeño.',
    hint_slow: '⚠ Aviso: recodificar recomprime cada fotograma en tu navegador. Para un video grande, largo o 4K esto puede tardar más de una hora — es normal, NO está congelado. "MP4 · rápido" es instantáneo si el video ya es H.264, así que pruébalo primero.',
    slow_running: 'Trabajando — no está atascado. Un video grande puede tardar más de una hora en recodificarse. No necesitas mirarlo: deja esta pestaña abierta (puedes cambiar de pestaña) y vuelve. O pulsa Cancelar y usa "MP4 · rápido".',
    cancel: 'Cancelar',
    cancelling: 'Cancelando…',
    canceled: 'Cancelado.',
    converting_t: (s) => `Convirtiendo… (${fmtElapsed(s)} transcurrido)`,
  },
};
const T = STR[lang];

// ── elements ────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), picker: $('picker'), chosen: $('chosen'),
  fname: $('fname'), fmeta: $('fmeta'), change: $('change'), format: $('format'),
  convert: $('convert'), cancel: $('cancel'), progwrap: $('progwrap'), bar: $('bar'), status: $('status'),
  logbox: $('logbox'), warn: $('isolation-warn'), fmtHint: $('fmt-hint'), convNote: $('conv-note'),
};
// static text
$('t-title').textContent = T.title;
document.title = `${T.title} · OpsFloa`;
$('t-sub').textContent = T.sub;
$('t-drop-big').textContent = T.dropBig;
$('t-drop-small').textContent = T.dropSmall;
$('t-format').textContent = T.format;
$('t-log').textContent = T.log;
$('t-foot').textContent = T.foot;
els.convert.textContent = T.convert;
els.change.textContent = T.change;
els.cancel.textContent = T.cancel;

// Steer users to the instant path. Re-encoding is CPU-heavy in the browser; a plain
// remux is seconds. Show the general tip, and a stronger warning when a re-encode
// format is chosen for a large file.
const REENCODE = new Set(['mp4', 'webm', 'mp3']);
function updateHint() {
  const big = currentFile && currentFile.size > 25 * 1024 * 1024;
  els.fmtHint.textContent = (REENCODE.has(els.format.value) && big) ? T.hint_slow : T.hint_remux;
}
els.fmtHint.textContent = T.hint_remux;
els.format.addEventListener('change', updateHint);

// format menu
const FORMATS = [
  { v: 'mp4', label: T.fmt_mp4, ext: 'mp4', mime: 'video/mp4',
    args: (i, o) => ['-i', i, '-threads', '0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', o] },
  { v: 'remux', label: T.fmt_remux, ext: 'mp4', mime: 'video/mp4',
    args: (i, o) => ['-i', i, '-c', 'copy', '-movflags', '+faststart', o] },
  { v: 'webm', label: T.fmt_webm, ext: 'webm', mime: 'video/webm',
    args: (i, o) => ['-i', i, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', o] },
  { v: 'mp3', label: T.fmt_mp3, ext: 'mp3', mime: 'audio/mpeg',
    args: (i, o) => ['-i', i, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', o] },
];
for (const f of FORMATS) {
  const opt = document.createElement('option');
  opt.value = f.v; opt.textContent = f.label;
  els.format.appendChild(opt);
}

// ── helpers ──────────────────────────────────────────────────────────────────────
function humanSize(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtElapsed(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function log(line) {
  els.logbox.textContent += (els.logbox.textContent ? '\n' : '') + line;
  els.logbox.scrollTop = els.logbox.scrollHeight;
}
function setStatus(msg) { els.status.textContent = msg || ''; }
function baseName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return url;
}

// ── cross-origin isolation check ─────────────────────────────────────────────────
if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
  els.warn.textContent = T.noIsolation;
  els.warn.classList.remove('hidden');
}

// ── current file ─────────────────────────────────────────────────────────────────
let currentFile = null; // { data: Uint8Array, name: string, size: number }

function showChosen(name, size) {
  els.fname.textContent = name;
  els.fmeta.textContent = size ? `· ${humanSize(size)}` : '';
  els.picker.classList.add('hidden');
  els.chosen.classList.remove('hidden');
  setStatus('');
  els.progwrap.classList.add('hidden');
  els.bar.style.width = '0';
  updateHint();
}
async function setFileFromBlob(blob, name) {
  const data = new Uint8Array(await blob.arrayBuffer());
  currentFile = { data, name: name || 'video', size: blob.size };
  showChosen(currentFile.name, currentFile.size);
}

// ── file picking ─────────────────────────────────────────────────────────────────
els.drop.addEventListener('click', () => els.file.click());
els.drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
els.change.addEventListener('click', () => { els.chosen.classList.add('hidden'); els.picker.classList.remove('hidden'); });
els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) setFileFromBlob(f, f.name); });
['dragenter', 'dragover'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.remove('over'); }));
els.drop.addEventListener('drop', e => { const f = e.dataTransfer?.files?.[0]; if (f) setFileFromBlob(f, f.name); });

// ── IndexedDB handoff (video passed from the OpsFloa app) ────────────────────────
function openHandoffDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('opsfloa-convert', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handoff')) db.createObjectStore('handoff');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function takeHandoff(key) {
  const db = await openHandoffDB();
  // The app opens this tab first (to keep the click gesture) and writes the blob
  // right after, so poll briefly rather than reading once and missing the race.
  for (let attempt = 0; attempt < 20; attempt++) {
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction('handoff', 'readonly');
      const g = tx.objectStore('handoff').get(key);
      g.onsuccess = () => resolve(g.result);
      g.onerror = () => reject(g.error);
    });
    if (rec) {
      await new Promise(res => {
        const tx = db.transaction('handoff', 'readwrite');
        tx.objectStore('handoff').delete(key);
        tx.oncomplete = res; tx.onerror = res;
      });
      return rec; // { blob, filename }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return undefined;
}
(async function initHandoff() {
  const key = params.get('k');
  if (!key) return;
  try {
    const rec = await takeHandoff(key);
    if (rec?.blob) await setFileFromBlob(rec.blob, rec.filename);
    else setStatus(T.handoffGone);
  } catch { setStatus(T.handoffGone); }
  // Drop the key from the URL so a refresh doesn't try to re-read a consumed handoff.
  history.replaceState(null, '', location.pathname + (lang !== 'en' ? `?lang=${params.get('lang')}` : ''));
})();

// ── ffmpeg engine (lazy) ─────────────────────────────────────────────────────────
let ffmpeg = null;
let loadingPromise = null;
let totalDurationSec = 0;
let cancelled = false;
let elapsedTimer = null;
function loadEngine() {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => {
      log(message);
      // The progress event doesn't fire for every input, so also derive % from ffmpeg's
      // own log lines: total "Duration:" and per-frame "time=". Keeps the bar alive.
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (d) totalDurationSec = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
      const tm = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (tm && totalDurationSec > 0) {
        const cur = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
        const pct = Math.max(0, Math.min(99, Math.round((cur / totalDurationSec) * 100)));
        els.bar.style.width = pct + '%';
      }
    });
    inst.on('progress', ({ progress }) => {
      if (!(progress > 0)) return;
      const pct = Math.max(0, Math.min(99, Math.round(progress * 100)));
      els.bar.style.width = pct + '%';
    });
    setStatus(T.loadingEngine);
    await inst.load({
      coreURL: new URL('core/ffmpeg-core.js', location.href).href,
      wasmURL: new URL('core/ffmpeg-core.wasm', location.href).href,
      workerURL: new URL('core/ffmpeg-core.worker.js', location.href).href,
    });
    ffmpeg = inst;
    return inst;
  })();
  return loadingPromise;
}

// ── convert ──────────────────────────────────────────────────────────────────────
let lastOutput = null; // { blob, filename }

function startElapsed() {
  const t0 = Date.now();
  els.convert.textContent = T.converting_t(0);
  elapsedTimer = setInterval(() => {
    els.convert.textContent = T.converting_t((Date.now() - t0) / 1000);
  }, 1000);
}
function stopElapsed() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  els.convert.textContent = T.convert;
}

// Cancel: terminate the worker (frees it mid-encode) and reset so the next run
// reloads a fresh engine. The pending exec() rejects → the handler's catch runs.
els.cancel.addEventListener('click', () => {
  if (!ffmpeg) return;
  cancelled = true;
  els.cancel.disabled = true;
  els.cancel.textContent = T.cancelling;
  try { ffmpeg.terminate(); } catch { /* already gone */ }
  ffmpeg = null;
  loadingPromise = null;
});

els.convert.addEventListener('click', async () => {
  if (!currentFile) return;
  const fmt = FORMATS.find(f => f.v === els.format.value) || FORMATS[0];
  const inName = 'input' + (currentFile.name.includes('.') ? currentFile.name.slice(currentFile.name.lastIndexOf('.')) : '');
  const outName = 'output.' + fmt.ext;
  const reencode = REENCODE.has(fmt.v);

  cancelled = false;
  totalDurationSec = 0;
  els.convert.disabled = true;
  els.change.disabled = true;
  els.progwrap.classList.remove('hidden');
  els.bar.style.width = '0';
  els.logbox.textContent = '';
  // Re-encoding can run a very long time — say so plainly so no one thinks it froze.
  if (reencode) { els.convNote.textContent = T.slow_running; els.convNote.classList.remove('hidden'); }
  els.cancel.disabled = false;
  els.cancel.textContent = T.cancel;
  els.cancel.classList.remove('hidden');

  try {
    if (!ffmpeg) {
      try { await loadEngine(); }
      catch (e) { log(String(e)); setStatus(T.engineFailed); return; }
    }
    if (cancelled) { setStatus(T.canceled); return; }
    setStatus(T.reading);
    await ffmpeg.writeFile(inName, currentFile.data);

    setStatus(T.converting);
    startElapsed();
    const code = await ffmpeg.exec(fmt.args(inName, outName));
    stopElapsed();
    if (code !== 0) { setStatus(T.failed); return; }

    const out = await ffmpeg.readFile(outName);
    const blob = new Blob([out.buffer], { type: fmt.mime });
    const filename = `${baseName(currentFile.name)}.${fmt.ext}`;
    lastOutput = { blob, filename };
    saveBlob(blob, filename);

    els.bar.style.width = '100%';
    setStatus(`${T.done} (${humanSize(blob.size)})`);
    // offer a re-download link (some browsers only fire the first click)
    if (!$('again')) {
      const a = document.createElement('button');
      a.id = 'again'; a.type = 'button'; a.className = 'ghost';
      a.style.marginTop = '12px';
      a.textContent = T.downloadAgain;
      a.addEventListener('click', () => { if (lastOutput) saveBlob(lastOutput.blob, lastOutput.filename); });
      els.status.after(a);
    }
    $('again').classList.remove('hidden');

    // clean up FS to free memory for the next conversion
    try { await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile(outName); } catch { /* best effort */ }
  } catch (e) {
    log(String(e && e.message ? e.message : e));
    setStatus(cancelled ? T.canceled : T.failed);
  } finally {
    stopElapsed();
    els.convert.disabled = false;
    els.change.disabled = false;
    els.cancel.classList.add('hidden');
    els.convNote.classList.add('hidden');
    els.progwrap.classList.add('hidden');
  }
});
