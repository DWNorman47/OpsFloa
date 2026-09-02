'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../shared/pdf.worker.min.js';
const { PDFDocument, degrees } = PDFLib;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  sources: [],   // { name, bytes:Uint8Array (pristine, for pdf-lib), doc:pdfjs document }
  pages: [],     // { id, src, page (0-based), rot (0/90/180/270), sel }
};
const thumbs = {}; // "src:page" -> dataURL
let uid = 0;
let dragId = null;

/* ---------- ui helpers ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function busy(on, msg) {
  if (msg) $('busyMsg').textContent = msg;
  $('busy').classList.toggle('hidden', !on);
}
function showEmpty() {
  $('grid').classList.add('hidden');
  $('dropZone').classList.remove('hidden');
  updateToolbar();
}

/* ---------- loading ---------- */
const isPdfFile = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImageFile = f => /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);

async function openFiles(fileList) {
  const files = [...fileList].filter(f => isPdfFile(f) || isImageFile(f));
  if (!files.length) { toast('Drop PDF or image files (JPG, PNG).'); return; }
  busy(true, 'Loading…');
  try {
    for (const f of files) {
      if (isImageFile(f)) { await addImageSource(f); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      // pdf.js detaches the buffer it's given, so hand it a copy and keep `bytes` for pdf-lib
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const src = state.sources.length;
      state.sources.push({ kind: 'pdf', name: f.name, bytes, doc });
      for (let p = 0; p < doc.numPages; p++)
        state.pages.push({ id: ++uid, src, page: p, rot: 0, sel: false });
    }
    renderGrid();
    await ensureThumbs();
  } catch (e) {
    toast('Could not read a file: ' + (e && e.message ? e.message : e));
  }
  busy(false);
}

// A JPG/PNG becomes a one-page source: bytes for the pdf-lib embed, a dataURL for the
// thumbnail + viewer, and the natural size for laying out the page.
async function addImageSource(f) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const mime = (/png$/i.test(f.type) || /\.png$/i.test(f.name)) ? 'image/png' : 'image/jpeg';
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes], { type: mime }));
  });
  const dim = await new Promise(resolve => {
    const im = new Image();
    im.onload = () => resolve({ width: im.naturalWidth, height: im.naturalHeight });
    im.onerror = () => resolve({ width: 0, height: 0 });
    im.src = dataUrl;
  });
  if (!dim.width || !dim.height) { toast('Could not read image: ' + f.name); return; }
  const src = state.sources.length;
  state.sources.push({ kind: 'image', name: f.name, bytes, mime, dataUrl, width: dim.width, height: dim.height });
  state.pages.push({ id: ++uid, src, page: 0, rot: 0, sel: false });
}

function imageThumb(src) {
  return new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      const scale = Math.min(1, 220 / im.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * scale));
      c.height = Math.max(1, Math.round(im.naturalHeight * scale));
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    im.onerror = () => resolve(src.dataUrl);
    im.src = src.dataUrl;
  });
}

async function renderThumb(srcIdx, pageIdx) {
  const source = state.sources[srcIdx];
  if (source.kind === 'image') return imageThumb(source);
  const page = await source.doc.getPage(pageIdx + 1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.max(0.2, 220 / base.width) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c.toDataURL('image/jpeg', 0.7);
}

// render any thumbnails not yet cached, filling cards in as they finish
async function ensureThumbs() {
  for (const pg of state.pages) {
    const key = pg.src + ':' + pg.page;
    if (thumbs[key] != null) continue;
    try { thumbs[key] = await renderThumb(pg.src, pg.page); }
    catch (_) { thumbs[key] = ''; }
    document.querySelectorAll('.card').forEach(card => {
      const p = state.pages.find(x => x.id === +card.dataset.id);
      if (p && p.src === pg.src && p.page === pg.page && thumbs[key]) {
        const img = card.querySelector('img'), ph = card.querySelector('.ph');
        img.src = thumbs[key]; img.style.display = ''; if (ph) ph.remove();
      }
    });
  }
}

/* ---------- grid ---------- */
function renderGrid() {
  const grid = $('grid');
  if (!state.pages.length) { showEmpty(); return; }
  $('dropZone').classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = state.pages.map((pg, i) => {
    const s = state.sources[pg.src];
    const short = s.name.length > 20 ? s.name.slice(0, 18) + '…' : s.name;
    return `<div class="card${pg.sel ? ' selected' : ''}" data-id="${pg.id}" draggable="true">
      <div class="thumb"><img alt="page ${i + 1}" style="transform:rotate(${pg.rot}deg)"><span class="ph">…</span></div>
      <div class="card-bar">
        <label><input type="checkbox" class="sel"${pg.sel ? ' checked' : ''}>${i + 1}</label>
        <span class="src" title="${esc(s.name)} · page ${pg.page + 1}">${esc(short)} · p${pg.page + 1}</span>
        <button class="mini rot" title="Rotate 90°">⟳</button>
        <button class="mini del" title="Delete this page">✕</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.card').forEach(card => {
    const id = +card.dataset.id;
    const pg = state.pages.find(p => p.id === id);
    const img = card.querySelector('img'), ph = card.querySelector('.ph');
    const key = pg.src + ':' + pg.page;
    if (thumbs[key]) { img.src = thumbs[key]; if (ph) ph.remove(); } else { img.style.display = 'none'; }
    const thumbBox = card.querySelector('.thumb');
    if (thumbBox) {
      thumbBox.style.cursor = 'zoom-in';
      thumbBox.title = 'Click to view full size';
      thumbBox.addEventListener('click', () => openViewer(pg));
    }
    card.querySelector('.sel').addEventListener('change', e => {
      pg.sel = e.target.checked; card.classList.toggle('selected', pg.sel); updateToolbar();
    });
    card.querySelector('.rot').addEventListener('click', () => {
      pg.rot = (pg.rot + 90) % 360; img.style.transform = `rotate(${pg.rot}deg)`;
    });
    card.querySelector('.del').addEventListener('click', () => {
      state.pages = state.pages.filter(p => p.id !== id);
      renderGrid();
    });
    wireDnd(card, id);
  });
  updateToolbar();
}

// Default download name: a single source keeps its name; multiple → "combined".
function defaultBaseName() {
  if (state.sources.length === 1) return state.sources[0].name.replace(/\.(pdf|jpe?g|png)$/i, '');
  return 'combined';
}
// The filename box value → a safe "<name>.pdf".
function outName() {
  let base = ($('fileName').value || '').trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
  return (base || 'document') + '.pdf';
}

function updateToolbar() {
  const n = state.pages.length, selN = state.pages.filter(p => p.sel).length;
  $('pageInfo').textContent = n ? `${n} page${n === 1 ? '' : 's'}${selN ? ` · ${selN} selected` : ''}` : '';
  $('btnDownload').disabled = !n;
  $('btnExtract').disabled = !selN;
  $('btnSelectAll').disabled = !n;
  $('btnClear').disabled = !n;
  const fn = $('fileName');
  fn.disabled = !n;
  if (n && !fn.value.trim()) fn.value = defaultBaseName(); // seed a sensible default, never clobber a typed name
  $('btnSelectAll').textContent = (n && selN === n) ? 'Select none' : 'Select all';
}

/* ---------- drag reorder ---------- */
function clearDnDMarks() {
  document.querySelectorAll('.card.drop-before, .card.drop-after')
    .forEach(c => c.classList.remove('drop-before', 'drop-after'));
}
function wireDnd(card, id) {
  card.addEventListener('dragstart', e => {
    dragId = id; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(id)); } catch (_) { /* some browsers */ }
  });
  card.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); clearDnDMarks(); });
  card.addEventListener('dragover', e => {
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    clearDnDMarks();
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });
  card.addEventListener('drop', e => {
    if (dragId == null) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    const fromId = dragId;
    dragId = null; // the dragged card is replaced by renderGrid, so its dragend won't fire
    reorder(fromId, id, after);
  });
}
function reorder(fromId, toId, after) {
  if (fromId === toId) { clearDnDMarks(); return; }
  const from = state.pages.findIndex(p => p.id === fromId);
  const item = state.pages.splice(from, 1)[0];
  let to = state.pages.findIndex(p => p.id === toId);
  if (after) to += 1;
  state.pages.splice(to, 0, item);
  renderGrid();
}

/* ---------- build & download (pdf-lib, with a pdf.js raster fallback) ---------- */
// pdf-lib copies each page losslessly. Some PDFs render fine in pdf.js but can't be
// copied by pdf-lib (a dangling object ref, odd encryption) — that used to crash the
// whole export with a cryptic "Expected instance of …, but got undefined". Now a page
// that can't be copied falls back to a rasterized image (via pdf.js, which already
// rendered it), so the download still succeeds.
async function rasterizeInto(out, pg) {
  const page = await state.sources[pg.src].doc.getPage(pg.page + 1);
  const rotation = ((((page.rotate || 0) + pg.rot) % 360) + 360) % 360;
  const vp = page.getViewport({ scale: 2, rotation });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const jpg = await out.embedJpg(arr);
  const p = out.addPage([vp.width, vp.height]);
  p.drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
}

// Re-encode any browser-decodable image to JPEG bytes — rescues a mislabeled
// extension or an unusual format (CMYK, etc.) that embedJpg/embedPng rejects.
async function imageToJpegBytes(dataUrl) {
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  c.getContext('2d').drawImage(im, 0, 0);
  const b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// An image source → a page sized to the image, with the picture drawn to fill it.
async function imagePageInto(out, meta, rot) {
  let img;
  try {
    img = meta.mime === 'image/png'
      ? await out.embedPng(meta.bytes.slice())
      : await out.embedJpg(meta.bytes.slice());
  } catch (_) {
    img = await out.embedJpg(await imageToJpegBytes(meta.dataUrl));
  }
  const p = out.addPage([meta.width, meta.height]);
  p.drawImage(img, { x: 0, y: 0, width: meta.width, height: meta.height });
  if (rot) p.setRotation(degrees(rot % 360));
}

async function buildPdf(pageList) {
  const out = await PDFDocument.create();
  const libDocs = {}; // src -> PDFDocument | null (null = couldn't load that file)
  let rasterized = 0, failed = 0;
  for (const pg of pageList) {
    const meta = state.sources[pg.src];
    if (!meta) { failed++; continue; }
    if (meta.kind === 'image') {
      try { await imagePageInto(out, meta, pg.rot); }
      catch (_) { failed++; }
      continue;
    }
    if (libDocs[pg.src] === undefined) {
      try { libDocs[pg.src] = await PDFDocument.load(meta.bytes.slice(), { ignoreEncryption: true, throwOnInvalidObject: false }); }
      catch (_) { libDocs[pg.src] = null; }
    }
    let ok = false;
    const srcDoc = libDocs[pg.src];
    if (srcDoc) {
      try {
        const [copied] = await out.copyPages(srcDoc, [pg.page]);
        if (copied) {
          if (pg.rot) copied.setRotation(degrees((copied.getRotation().angle + pg.rot) % 360));
          out.addPage(copied);
          ok = true;
        }
      } catch (_) { /* fall through to raster */ }
    }
    if (!ok) {
      try { await rasterizeInto(out, pg); rasterized++; }
      catch (_) { failed++; }
    }
  }
  const bytes = out.getPageCount() > 0 ? await out.save() : null;
  return { bytes, rasterized, failed, total: pageList.length };
}

async function downloadPages(pageList, filename) {
  if (!pageList.length) { toast('No pages to save.'); return; }
  busy(true, 'Building PDF…');
  try {
    const { bytes, rasterized, failed, total } = await buildPdf(pageList);
    if (!bytes) { toast('None of the pages could be exported — the PDF may be damaged or protected.'); busy(false); return; }
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    const saved = total - failed;
    let msg = `Saved ${filename} (${saved} page${saved === 1 ? '' : 's'}).`;
    if (rasterized) msg += ` ${rasterized} couldn't be copied and were saved as images.`;
    if (failed) msg += ` ${failed} could not be included.`;
    toast(msg);
  } catch (e) {
    toast('Could not build the PDF: ' + (e && e.message ? e.message : e));
  }
  busy(false);
}

/* ---------- full-size page viewer ---------- */
let viewerEl = null;
function ensureViewer() {
  if (viewerEl) return viewerEl;
  viewerEl = document.createElement('div');
  viewerEl.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(17,24,39,0.85);padding:24px';
  viewerEl.innerHTML = '<button type="button" aria-label="Close" style="position:absolute;top:14px;right:18px;background:rgba(255,255,255,0.15);color:#fff;border:none;border-radius:8px;width:38px;height:38px;font-size:22px;cursor:pointer;line-height:1">✕</button><div class="pv-body" style="max-width:100%;max-height:100%;overflow:auto"></div>';
  viewerEl.querySelector('button').addEventListener('click', closeViewer);
  viewerEl.addEventListener('click', e => { if (e.target === viewerEl) closeViewer(); });
  document.body.appendChild(viewerEl);
  return viewerEl;
}
function closeViewer() { if (viewerEl) viewerEl.style.display = 'none'; }
async function openViewer(pg) {
  const ov = ensureViewer();
  const body = ov.querySelector('.pv-body');
  body.innerHTML = '<div style="color:#fff;padding:40px;font:14px system-ui,sans-serif">Rendering…</div>';
  ov.style.display = 'flex';
  const source = state.sources[pg.src];
  if (source.kind === 'image') {
    const el = new Image();
    el.src = source.dataUrl;
    el.style.cssText = `display:block;max-width:100%;max-height:calc(100vh - 60px);height:auto;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,0.5);transform:rotate(${pg.rot}deg)`;
    body.innerHTML = ''; body.appendChild(el);
    return;
  }
  try {
    const page = await source.doc.getPage(pg.page + 1);
    const rotation = ((((page.rotate || 0) + pg.rot) % 360) + 360) % 360;
    const one = page.getViewport({ scale: 1, rotation });
    const scale = Math.max(0.2, Math.min((window.innerWidth - 60) / one.width, (window.innerHeight - 60) / one.height, 4));
    const vp = page.getViewport({ scale, rotation });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    c.style.cssText = 'display:block;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,0.5);max-width:100%;height:auto';
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    body.innerHTML = ''; body.appendChild(c);
  } catch (_) {
    body.innerHTML = '<div style="color:#fff;padding:40px;font:14px system-ui,sans-serif">Could not render this page.</div>';
  }
}
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeViewer(); });

/* ---------- wiring ---------- */
$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => { openFiles(e.target.files); e.target.value = ''; });
$('btnDownload').addEventListener('click', () => downloadPages(state.pages, outName()));
$('btnExtract').addEventListener('click', () => downloadPages(state.pages.filter(p => p.sel), outName()));
$('btnSelectAll').addEventListener('click', () => {
  const all = state.pages.length && state.pages.every(p => p.sel);
  state.pages.forEach(p => (p.sel = !all));
  renderGrid();
});
$('btnClear').addEventListener('click', () => {
  state.sources = []; state.pages = [];
  for (const k of Object.keys(thumbs)) delete thumbs[k]; // src indices restart, so drop stale thumbs
  $('fileName').value = ''; // next load reseeds the default name
  showEmpty();
});
$('btnHelp').addEventListener('click', () => $('help').classList.remove('hidden'));
$('helpClose').addEventListener('click', () => $('help').classList.add('hidden'));

// drag-and-drop files onto the window
const dz = $('dropZone');
['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dz.classList.add('dragover'); }
}));
['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => {
  if (ev === 'dragleave' && e.relatedTarget) return;
  dz.classList.remove('dragover');
}));
window.addEventListener('drop', e => {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && dragId == null) {
    e.preventDefault();
    openFiles(e.dataTransfer.files);
  }
});

updateToolbar();
