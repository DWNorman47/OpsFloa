'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
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
async function openFiles(fileList) {
  const files = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) { toast('Drop PDF files.'); return; }
  busy(true, 'Loading…');
  try {
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      // pdf.js detaches the buffer it's given, so hand it a copy and keep `bytes` for pdf-lib
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const src = state.sources.length;
      state.sources.push({ name: f.name, bytes, doc });
      for (let p = 0; p < doc.numPages; p++)
        state.pages.push({ id: ++uid, src, page: p, rot: 0, sel: false });
    }
    renderGrid();
    await ensureThumbs();
  } catch (e) {
    toast('Could not read a PDF: ' + (e && e.message ? e.message : e));
  }
  busy(false);
}

async function renderThumb(srcIdx, pageIdx) {
  const page = await state.sources[srcIdx].doc.getPage(pageIdx + 1);
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

function updateToolbar() {
  const n = state.pages.length, selN = state.pages.filter(p => p.sel).length;
  $('pageInfo').textContent = n ? `${n} page${n === 1 ? '' : 's'}${selN ? ` · ${selN} selected` : ''}` : '';
  $('btnDownload').disabled = !n;
  $('btnExtract').disabled = !selN;
  $('btnSelectAll').disabled = !n;
  $('btnClear').disabled = !n;
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

async function buildPdf(pageList) {
  const out = await PDFDocument.create();
  const libDocs = {}; // src -> PDFDocument | null (null = couldn't load that file)
  let rasterized = 0, failed = 0;
  for (const pg of pageList) {
    const meta = state.sources[pg.src];
    if (!meta) { failed++; continue; }
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
  try {
    const page = await state.sources[pg.src].doc.getPage(pg.page + 1);
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
$('btnDownload').addEventListener('click', () => {
  const base = state.sources.length === 1 ? state.sources[0].name.replace(/\.pdf$/i, '') : 'combined';
  downloadPages(state.pages, base + '.pdf');
});
$('btnExtract').addEventListener('click', () => downloadPages(state.pages.filter(p => p.sel), 'extracted.pdf'));
$('btnSelectAll').addEventListener('click', () => {
  const all = state.pages.length && state.pages.every(p => p.sel);
  state.pages.forEach(p => (p.sel = !all));
  renderGrid();
});
$('btnClear').addEventListener('click', () => {
  state.sources = []; state.pages = [];
  for (const k of Object.keys(thumbs)) delete thumbs[k]; // src indices restart, so drop stale thumbs
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
