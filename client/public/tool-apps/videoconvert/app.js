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
    hint_remux: 'Tip: "MP4 (recommended)" is instant when your video is already H.264 (most iPhone / QuickTime videos) — it just rewraps the container. It only re-encodes when it has to (e.g. HEVC), which is much slower.',
    hint_slow: '⚠ Heads-up: re-encoding re-compresses every frame in your browser and can take a long time on a big video — that’s normal, it is NOT frozen. Use it only when the recommended option produces a file that won’t play.',
    slow_running: 'Working — not stuck. Re-encoding a large video can take a while. You don’t need to watch it: leave this tab open (you can switch tabs) and come back — or hit Cancel.',
    probing: 'Checking the video…',
    remuxing: 'Already H.264 — rewrapping to MP4 (fast)…',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    canceled: 'Canceled.',
    converting_t: (s) => `Working… (${fmtElapsed(s)} elapsed)`,
    fmt_mp4auto: 'MP4 (recommended — instant if already H.264)',
    fmt_mp4enc: 'MP4 · force re-encode to H.264',
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
    hint_remux: 'Consejo: "MP4 (recomendado)" es instantáneo cuando el video ya es H.264 (la mayoría de videos de iPhone / QuickTime) — solo recambia el contenedor. Solo recodifica cuando es necesario (p. ej. HEVC), lo cual es mucho más lento.',
    hint_slow: '⚠ Aviso: recodificar recomprime cada fotograma en tu navegador y puede tardar bastante en un video grande — es normal, NO está congelado. Úsalo solo cuando la opción recomendada genere un archivo que no se reproduce.',
    slow_running: 'Trabajando — no está atascado. Recodificar un video grande puede tardar. No necesitas mirarlo: deja esta pestaña abierta (puedes cambiar de pestaña) y vuelve — o pulsa Cancelar.',
    probing: 'Revisando el video…',
    remuxing: 'Ya es H.264 — recambiando a MP4 (rápido)…',
    cancel: 'Cancelar',
    cancelling: 'Cancelando…',
    canceled: 'Cancelado.',
    converting_t: (s) => `Trabajando… (${fmtElapsed(s)} transcurrido)`,
    fmt_mp4auto: 'MP4 (recomendado — instantáneo si ya es H.264)',
    fmt_mp4enc: 'MP4 · forzar recodificación a H.264',
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
// These choices always re-encode; "mp4auto" only re-encodes non-H.264, so it gets the
// reassuring recommended tip rather than the slow warning until we know the codec.
const ALWAYS_REENCODE = new Set(['mp4enc', 'webm', 'mp3']);
function updateHint() {
  const big = currentFile && currentFile.size > 25 * 1024 * 1024;
  els.fmtHint.textContent = (ALWAYS_REENCODE.has(els.format.value) && big) ? T.hint_slow : T.hint_remux;
}
els.fmtHint.textContent = T.hint_remux;
els.format.addEventListener('change', updateHint);

// Only take the first video + first audio track and drop everything else (iPhone .mov
// carries timed-metadata "mebx" data streams that just add failure surface). `?` makes
// audio optional so a video-only clip still works.
const MAP = ['-map', '0:v:0', '-map', '0:a:0?'];
// Copy the audio when it's already AAC (no needless re-encode); otherwise make it AAC.
const audioArgs = c => (c.audio === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']);
// H.264 re-encode: ultrafast keeps the browser encode as short as possible.
const h264Args = (i, o, c) => ['-i', i, ...MAP, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', ...audioArgs(c), '-movflags', '+faststart', o];
const remuxArgs = (i, o) => ['-i', i, ...MAP, '-c', 'copy', '-movflags', '+faststart', o];

// format menu. `build(in, out, codecs)` returns the ffmpeg args. `reencodes(codecs)`
// says whether this choice will actually re-encode (drives the "this can be slow" note).
const FORMATS = [
  // Re-encode only when we KNOW the source isn't H.264. Unknown (probe failed) → rewrap:
  // it's instant and non-destructive, and if the result won't play the user can force a
  // re-encode — far better than silently dropping into a slow encode by mistake.
  { v: 'mp4auto', label: T.fmt_mp4auto, ext: 'mp4', mime: 'video/mp4',
    reencodes: c => !!c.video && c.video !== 'h264',
    build: (i, o, c) => (c.video && c.video !== 'h264' ? h264Args(i, o, c) : remuxArgs(i, o)) },
  { v: 'mp4enc', label: T.fmt_mp4enc, ext: 'mp4', mime: 'video/mp4',
    reencodes: () => true, build: (i, o, c) => h264Args(i, o, c) },
  { v: 'webm', label: T.fmt_webm, ext: 'webm', mime: 'video/webm',
    reencodes: () => true,
    build: (i, o) => ['-i', i, ...MAP, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', o] },
  { v: 'mp3', label: T.fmt_mp3, ext: 'mp3', mime: 'audio/mpeg',
    reencodes: () => true, build: (i, o) => ['-i', i, '-map', '0:a:0?', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', o] },
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

// Detect the input's video/audio codecs with ffprobe (reads headers only — fast, no
// encode, no threads) so we can rewrap instead of re-encode whenever possible.
async function probeCodecs(name) {
  const one = async (sel, out) => {
    try {
      await ffmpeg.ffprobe(['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', name, '-o', out]);
      const txt = await ffmpeg.readFile(out, 'utf8');
      try { await ffmpeg.deleteFile(out); } catch { /* best effort */ }
      return String(txt).trim().split(/\s+/)[0].toLowerCase();
    } catch { return ''; }
  };
  return { video: await one('v:0', 'v.txt'), audio: await one('a:0', 'a.txt') };
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

  cancelled = false;
  totalDurationSec = 0;
  els.convert.disabled = true;
  els.change.disabled = true;
  els.progwrap.classList.remove('hidden');
  els.bar.style.width = '0';
  els.logbox.textContent = '';
  els.convNote.classList.add('hidden');
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

    // Detect codecs, then pick the lightest command: rewrap (instant) when we can,
    // re-encode only when we must.
    setStatus(T.probing);
    const codecs = await probeCodecs(inName);
    if (cancelled) { setStatus(T.canceled); return; }
    const willReencode = fmt.reencodes(codecs);
    const args = fmt.build(inName, outName, codecs);

    if (willReencode) {
      // Re-encoding can run a long time — say so plainly so no one thinks it froze.
      els.convNote.textContent = T.slow_running;
      els.convNote.classList.remove('hidden');
      setStatus(T.converting);
    } else {
      setStatus(T.remuxing);
    }
    els.logbox.textContent = '';
    startElapsed();
    const code = await ffmpeg.exec(args);
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
