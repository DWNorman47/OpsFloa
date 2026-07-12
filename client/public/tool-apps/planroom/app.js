/* Plan Room — viewer + markup + measure (M1 viewer core + M2 markups).
 * Built on the shared plan-tools engine (../shared/engine-*.js). Local-first:
 * projects live in this browser (IndexedDB 'planroom'), documents dedup by
 * content hash, markups live inside the project data (no server tables).
 * See docs/plans/plan-viewer-markup.md.
 */

import { createViewport } from '../shared/engine-view.js?v=1';
import { createStore, randId, hashBytes } from '../shared/engine-store.js?v=1';
import { openDoc, bytesToBase64, base64ToBytes, defaultRenderScale } from '../shared/engine-doc.js?v=1';
import { createModals, esc } from '../shared/engine-ui.js?v=1';
import { distToPolyline, pointSegDist, simplifyPts } from '../shared/engine-measure.js?v=1';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../shared/pdf.worker.min.js';

const $ = id => document.getElementById(id);

/* ============================== State ============================== */

const state = {
  projectId: null,
  projectName: 'Project 1',
  doc: null,        // engine-doc handle (pdf or image)
  docKey: null,     // content hash → IndexedDB 'files'
  docName: null,
  docType: null,
  page: 1,
  markups: [],      // markup objects; geometry in world/base px (see MK kinds)
};

const store = createStore('planroom');

const els = {
  cv: $('cv'), hud: $('hud'), dropHint: $('dropHint'), thumbRail: $('thumbRail'),
  pageInfo: $('pageInfo'), btnPrev: $('btnPrevPage'), btnNext: $('btnNextPage'),
  btnFit: $('btnFit'), projName: $('projName'), projects: $('projects'), projList: $('projList'),
  mkColor: $('mkColor'), mkWidth: $('mkWidth'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
  markupPanel: $('markupPanel'), mkList: $('mkList'), mkKindFilter: $('mkKindFilter'),
  mkThisSheet: $('mkThisSheet'), textOverlay: $('textOverlay'),
};

const modals = createModals({
  overlay: $('modal'), title: $('modalTitle'), body: $('modalBody'),
  ok: $('modalOk'), cancel: $('modalCancel'),
});

const vp = createViewport({ canvas: els.cv });

function setMsg(t) { els.hud.textContent = t || ''; }

/* ============================== Markup model ==============================
 * kind        pts                                other
 * cloud       [corner, corner]                   —
 * rect        [corner, corner]                   —
 * ellipse     [corner, corner]                   —
 * highlight   [corner, corner]                   — (translucent fill)
 * line/arrow  [a, b]                             — (arrow head at b)
 * freehand    polyline                           —
 * text        [anchor (top-left)]                text, fontSize
 * callout     [anchor (text top-left), target]   text, fontSize (leader → target)
 * Widths/sizes are document-space (base px) so markups print/zoom like ink.
 */

const MK_KINDS = ['cloud', 'rect', 'ellipse', 'arrow', 'line', 'freehand', 'highlight', 'text', 'callout'];
const MK_LABEL = {
  cloud: 'Cloud', rect: 'Rectangle', ellipse: 'Ellipse', arrow: 'Arrow', line: 'Line',
  freehand: 'Pen', highlight: 'Highlight', text: 'Text', callout: 'Callout',
};
const MK_ICON = {
  cloud: '☁', rect: '▭', ellipse: '⬭', arrow: '↗', line: '╲',
  freehand: '✏', highlight: '🖍', text: 'T', callout: '🏷',
};
const LINE_W = { S: 2, M: 4, L: 8 };
const FONT_S = { S: 12, M: 18, L: 28 };

// last-used color per tool (highlighter starts yellow, ink starts red)
const toolColors = { highlight: '#ffe066' };
const DEFAULT_COLOR = '#e05555';

let tool = 'pan';
let selectedId = null;
let drag = null;      // {mode:'pan'|'draw'|'move'|'handle', ...}
let undoCapture = null;

const curColor = () => els.mkColor.value;
const curWidth = () => LINE_W[els.mkWidth.value] || LINE_W.M;
const curFont = () => FONT_S[els.mkWidth.value] || FONT_S.M;
const selMarkup = () => state.markups.find(m => m.id === selectedId) || null;

/* ============================== Undo / redo ============================== */

const undoStack = [], redoStack = [];
const snapshot = () => JSON.stringify(state.markups);

function updateUndoButtons() {
  els.btnUndo.disabled = !undoStack.length;
  els.btnRedo.disabled = !redoStack.length;
}
function pushUndo(prevJson) {
  undoStack.push(prevJson);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function restoreMarkups(json) {
  state.markups = JSON.parse(json);
  if (selectedId && !selMarkup()) selectedId = null;
  markupsChanged();
}
function undo() { if (undoStack.length) { redoStack.push(snapshot()); restoreMarkups(undoStack.pop()); updateUndoButtons(); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); restoreMarkups(redoStack.pop()); updateUndoButtons(); } }
els.btnUndo.addEventListener('click', undo);
els.btnRedo.addEventListener('click', redo);

// every mutation funnels through here: redraw, refresh list, autosave
function markupsChanged() {
  renderMarkupList();
  scheduleSave();
  vp.requestDraw();
}

/* ============================== Markup rendering ============================== */

const normRect = (a, b) => ({
  x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
  x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
});

// Revision cloud: semicircle scallops bulging outward along the rect edges.
function cloudPath(ctx, r) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const rad = Math.max(5, Math.min(22, Math.min(w, h) / 6 || 8));
  const edge = (ax, ay, bx, by, bulge) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / (rad * 2)));
    const ux = (bx - ax) / n, uy = (by - ay) / n;
    for (let i = 0; i < n; i++) {
      const cx = ax + ux * (i + 0.5), cy = ay + uy * (i + 0.5);
      const a0 = Math.atan2(ay + uy * i - cy, ax + ux * i - cx);
      ctx.arc(cx, cy, Math.hypot(ux, uy) / 2, a0, a0 + Math.PI * bulge, bulge < 0);
    }
  };
  ctx.beginPath();
  ctx.moveTo(r.x0, r.y0);
  edge(r.x0, r.y0, r.x1, r.y0, 1);
  edge(r.x1, r.y0, r.x1, r.y1, 1);
  edge(r.x1, r.y1, r.x0, r.y1, 1);
  edge(r.x0, r.y1, r.x0, r.y0, 1);
  ctx.closePath();
}

function arrowHead(ctx, from, to, size) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(a - 0.45), to.y - size * Math.sin(a - 0.45));
  ctx.lineTo(to.x - size * Math.cos(a + 0.45), to.y - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

function textLines(m) { return String(m.text || '').split('\n'); }

// Measured text-box geometry {x0,y0,x1,y1,pad,lineH} for text/callout kinds.
function textBox(ctx, m) {
  const fs = m.fontSize || 18;
  ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
  const lines = textLines(m);
  const wMax = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
  const pad = fs * 0.4, lineH = fs * 1.25;
  const a = m.pts[0];
  return { x0: a.x - pad, y0: a.y - pad, x1: a.x + wMax + pad, y1: a.y + lines.length * lineH + pad, pad, lineH, fs };
}

function drawTextBlock(ctx, m, withBox) {
  const tb = textBox(ctx, m);
  if (withBox) {
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.strokeStyle = m.color;
    ctx.lineWidth = Math.max(1, (m.width || 4) / 2);
    ctx.beginPath();
    ctx.roundRect(tb.x0, tb.y0, tb.x1 - tb.x0, tb.y1 - tb.y0, tb.pad);
    ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = withBox ? '#1c2126' : m.color;
  ctx.font = `${tb.fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  textLines(m).forEach((l, i) => ctx.fillText(l, m.pts[0].x, m.pts[0].y + i * tb.lineH));
  return tb;
}

function drawMarkup(ctx, m) {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.width || 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const [p0, p1] = m.pts;
  switch (m.kind) {
    case 'rect': {
      const r = normRect(p0, p1);
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      break;
    }
    case 'ellipse': {
      const r = normRect(p0, p1);
      ctx.beginPath();
      ctx.ellipse((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'cloud':
      cloudPath(ctx, normRect(p0, p1));
      ctx.stroke();
      break;
    case 'highlight': {
      const r = normRect(p0, p1);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      break;
    }
    case 'line':
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      break;
    case 'arrow':
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      arrowHead(ctx, p0, p1, (m.width || 4) * 3.5);
      break;
    case 'freehand':
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      break;
    case 'text':
      drawTextBlock(ctx, m, false);
      break;
    case 'callout': {
      const tb = drawTextBlock(ctx, m, true);
      // leader from the box edge nearest the target
      const cx = Math.max(tb.x0, Math.min(tb.x1, p1.x));
      const cy = Math.max(tb.y0, Math.min(tb.y1, p1.y));
      ctx.strokeStyle = m.color; ctx.fillStyle = m.color;
      ctx.lineWidth = Math.max(1.5, (m.width || 4) / 2);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      arrowHead(ctx, { x: cx, y: cy }, p1, (m.width || 4) * 2.5 + 4);
      break;
    }
  }
  ctx.restore();
}

// Bounding box in world px (for selection, centering, hit slop).
function markupBBox(ctx, m) {
  if (m.kind === 'text' || m.kind === 'callout') {
    const tb = textBox(ctx, m);
    let { x0, y0, x1, y1 } = tb;
    if (m.kind === 'callout') {
      x0 = Math.min(x0, m.pts[1].x); y0 = Math.min(y0, m.pts[1].y);
      x1 = Math.max(x1, m.pts[1].x); y1 = Math.max(y1, m.pts[1].y);
    }
    return { x0, y0, x1, y1 };
  }
  const xs = m.pts.map(p => p.x), ys = m.pts.map(p => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* ---- selection handles ---- */

function handlePoints(ctx, m) {
  if (['rect', 'ellipse', 'cloud', 'highlight'].includes(m.kind)) {
    const r = normRect(m.pts[0], m.pts[1]);
    return [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  }
  if (m.kind === 'line' || m.kind === 'arrow') return [m.pts[0], m.pts[1]];
  if (m.kind === 'callout') return [m.pts[1]]; // move the leader target
  return [];
}

function drawSelection(ctx, m) {
  const bb = markupBBox(ctx, m);
  const s = 4 / vp.view.zoom;
  ctx.save();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1.5 / vp.view.zoom;
  ctx.setLineDash([6 / vp.view.zoom, 4 / vp.view.zoom]);
  ctx.strokeRect(bb.x0 - s, bb.y0 - s, (bb.x1 - bb.x0) + s * 2, (bb.y1 - bb.y0) + s * 2);
  ctx.setLineDash([]);
  const h = 5 / vp.view.zoom;
  ctx.fillStyle = '#fff';
  for (const p of handlePoints(ctx, m)) {
    ctx.fillRect(p.x - h, p.y - h, h * 2, h * 2);
    ctx.strokeRect(p.x - h, p.y - h, h * 2, h * 2);
  }
  ctx.restore();
}

/* ---- hit testing (world coords; tolerances shrink with zoom) ---- */

function hitHandle(ctx, m, w) {
  const h = 7 / vp.view.zoom;
  const hps = handlePoints(ctx, m);
  for (let i = 0; i < hps.length; i++) {
    if (Math.abs(w.x - hps[i].x) <= h && Math.abs(w.y - hps[i].y) <= h) return i;
  }
  return -1;
}

function hitMarkup(ctx, w) {
  const tol = Math.max(6 / vp.view.zoom, 3);
  for (let i = state.markups.length - 1; i >= 0; i--) {
    const m = state.markups[i];
    if (m.page !== state.page) continue;
    const t = tol + (m.width || 4) / 2;
    const [p0, p1] = m.pts;
    switch (m.kind) {
      case 'rect': case 'cloud': {
        const r = normRect(p0, p1);
        const nearX = w.x > r.x0 - t && w.x < r.x1 + t, nearY = w.y > r.y0 - t && w.y < r.y1 + t;
        const onEdge = nearX && nearY &&
          (Math.abs(w.x - r.x0) < t || Math.abs(w.x - r.x1) < t ||
           Math.abs(w.y - r.y0) < t || Math.abs(w.y - r.y1) < t);
        if (onEdge) return m;
        break;
      }
      case 'ellipse': {
        const r = normRect(p0, p1);
        const rx = (r.x1 - r.x0) / 2 || 1, ry = (r.y1 - r.y0) / 2 || 1;
        const dx = (w.x - (r.x0 + rx)) / rx, dy = (w.y - (r.y0 + ry)) / ry;
        const d = Math.abs(Math.hypot(dx, dy) - 1);
        if (d * Math.min(rx, ry) < t) return m;
        break;
      }
      case 'highlight': {
        const r = normRect(p0, p1);
        if (w.x > r.x0 && w.x < r.x1 && w.y > r.y0 && w.y < r.y1) return m;
        break;
      }
      case 'line': case 'arrow':
        if (pointSegDist(w.x, w.y, p0.x, p0.y, p1.x, p1.y) < t) return m;
        break;
      case 'freehand':
        if (distToPolyline(w.x, w.y, m.pts) < t) return m;
        break;
      case 'text': case 'callout': {
        const tb = textBox(ctx, m);
        if (w.x > tb.x0 - t && w.x < tb.x1 + t && w.y > tb.y0 - t && w.y < tb.y1 + t) return m;
        if (m.kind === 'callout' &&
            pointSegDist(w.x, w.y, (tb.x0 + tb.x1) / 2, (tb.y0 + tb.y1) / 2, p1.x, p1.y) < t) return m;
        break;
      }
    }
  }
  return null;
}

/* ============================== Page rendering ============================== */

// Rendered page canvases, capped; base sizes are tiny and kept for all pages.
const pageCanvas = new Map();  // pageNum -> canvas (at render scale)
const pageBase = new Map();    // pageNum -> { width, height } at scale 1
const inflight = new Map();    // pageNum -> Promise
const PAGE_CACHE_MAX = 6;

async function baseSize(p) {
  if (!pageBase.has(p)) pageBase.set(p, await state.doc.baseSize(p));
  return pageBase.get(p);
}

function ensurePage(p) {
  if (!state.doc || pageCanvas.has(p)) return Promise.resolve();
  if (inflight.has(p)) return inflight.get(p);
  const job = (async () => {
    const base = await baseSize(p);
    const canvas = await state.doc.renderPage(p, defaultRenderScale(base.width));
    pageCanvas.set(p, canvas);
    // evict oldest rendered page beyond the cap (never the current one)
    while (pageCanvas.size > PAGE_CACHE_MAX) {
      const first = [...pageCanvas.keys()].find(k => k !== state.page);
      if (first == null) break;
      pageCanvas.delete(first);
    }
    vp.requestDraw();
  })().finally(() => inflight.delete(p));
  inflight.set(p, job);
  return job;
}

function paint(ctx) {
  vp.beginPaint(ctx);
  const img = pageCanvas.get(state.page);
  const base = pageBase.get(state.page);
  // world units = base-scale px, so markups are resolution-independent
  if (img && base) ctx.drawImage(img, 0, 0, base.width, base.height);
  else if (state.doc) ensurePage(state.page);
  for (const m of state.markups) if (m.page === state.page) drawMarkup(ctx, m);
  if (drag && drag.mode === 'draw' && drag.markup) drawMarkup(ctx, drag.markup);
  const sel = selMarkup();
  if (sel && sel.page === state.page) drawSelection(ctx, sel);
  ctx.restore();
}

/* ============================== Pages & thumbnails ============================== */

function updatePageUI() {
  const n = state.doc ? state.doc.numPages : 0;
  els.pageInfo.textContent = n ? `${state.page} / ${n}` : '– / –';
  els.btnPrev.disabled = !n || state.page <= 1;
  els.btnNext.disabled = !n || state.page >= n;
  els.btnFit.disabled = !n;
  els.thumbRail.querySelectorAll('.thumb').forEach(t =>
    t.classList.toggle('current', parseInt(t.dataset.page, 10) === state.page));
}

async function setPage(p, { fit = false } = {}) {
  if (!state.doc) return;
  state.page = Math.max(1, Math.min(state.doc.numPages, p));
  updatePageUI();
  await ensurePage(state.page);
  if (fit) { const b = await baseSize(state.page); vp.fitTo(b.width, b.height); }
  vp.requestDraw();
  scheduleSave();
}

// Lazy thumbnail strip: placeholders now, rendered when scrolled into view.
const THUMB_W = 128;
let thumbObserver = null;

function buildThumbs() {
  els.thumbRail.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();
  if (!state.doc) return;
  thumbObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      thumbObserver.unobserve(en.target);
      renderThumb(en.target).catch(() => {});
    }
  }, { root: els.thumbRail, rootMargin: '200px' });
  for (let p = 1; p <= state.doc.numPages; p++) {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.dataset.page = p;
    b.title = `Sheet ${p}`;
    b.innerHTML = `<div class="thumb-ph"></div><span class="thumb-num">${p}</span>`;
    b.addEventListener('click', () => setPage(p));
    els.thumbRail.appendChild(b);
    thumbObserver.observe(b);
  }
  updatePageUI();
}

async function renderThumb(btn) {
  const p = parseInt(btn.dataset.page, 10);
  const base = await baseSize(p);
  const canvas = await state.doc.renderPage(p, THUMB_W / base.width);
  btn.querySelector('.thumb-ph').replaceWith(canvas);
}

/* ============================== Document opening ============================== */

async function openFromBytes(buf, name, type, { persist = true } = {}) {
  setMsg(`Loading ${name}…`);
  const keep = buf.slice(0); // pdf.js detaches the buffer it opens
  try {
    state.doc = await openDoc(new Uint8Array(buf), { type });
  } catch (err) {
    console.error(err);
    setMsg(`Could not open ${name}: ${err.message}`);
    return false;
  }
  if (persist) {
    try {
      const key = await hashBytes(keep);
      await store.filesPut(key, { name, type: type || null, bytes: keep });
      state.docKey = key;
    } catch (_) { /* private mode / quota — session still works */ }
  }
  state.docName = name;
  state.docType = type || null;
  pageCanvas.clear(); pageBase.clear(); inflight.clear();
  els.dropHint.classList.add('hidden');
  buildThumbs();
  await setPage(1, { fit: true });
  const n = state.doc.numPages;
  setMsg(`Loaded ${name}${n > 1 ? ` (${n} sheets)` : ''}. Drag to pan · wheel to zoom.`);
  return true;
}

async function openFile(file) {
  const buf = await file.arrayBuffer();
  const ok = await openFromBytes(buf, file.name, file.type);
  if (ok) scheduleSave(true);
}

$('btnOpenDoc').addEventListener('click', () => $('fileDoc').click());
$('fileDoc').addEventListener('change', e => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('canvasWrap').addEventListener('dragover', e => e.preventDefault());
$('canvasWrap').addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

/* ============================== Tools & pointer input ============================== */

function setTool(t) {
  tool = t;
  cancelOverlay();
  drag = null;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  els.cv.classList.toggle('crosshair', t !== 'pan' && t !== 'select');
  // per-tool color memory (highlighter yellow, ink red, user overrides stick)
  if (t !== 'pan' && t !== 'select') els.mkColor.value = toolColors[t] || DEFAULT_COLOR;
}
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

const screenPt = e => {
  const r = els.cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

els.cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  commitOverlay(); // clicking the canvas places any pending note first
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  els.cv.setPointerCapture(e.pointerId);

  // middle button always pans; pan tool pans
  if (e.button === 1 || tool === 'pan') {
    drag = { mode: 'pan', ptr: e.pointerId, last: { x: e.clientX, y: e.clientY } };
    els.cv.classList.add('grabbing');
    return;
  }
  if (!state.doc) return;

  if (tool === 'select') {
    const ctx = vp.ctx;
    const sel = selMarkup();
    if (sel && sel.page === state.page) {
      const hi = hitHandle(ctx, sel, w);
      if (hi >= 0) {
        undoCapture = snapshot();
        drag = { mode: 'handle', ptr: e.pointerId, id: sel.id, hi, moved: false };
        return;
      }
    }
    const hit = hitMarkup(ctx, w);
    if (hit) {
      selectedId = hit.id;
      undoCapture = snapshot();
      drag = { mode: 'move', ptr: e.pointerId, id: hit.id, from: w, orig: JSON.parse(JSON.stringify(hit.pts)), moved: false };
      renderMarkupList();
      vp.requestDraw();
    } else {
      if (selectedId) { selectedId = null; renderMarkupList(); vp.requestDraw(); }
      drag = { mode: 'pan', ptr: e.pointerId, last: { x: e.clientX, y: e.clientY } };
      els.cv.classList.add('grabbing');
    }
    return;
  }

  if (tool === 'text') {
    openOverlay({ mode: 'new-text', anchor: w });
    return;
  }

  // drawing tools (incl. callout: drag from target to note position)
  undoCapture = snapshot();
  const base = { id: randId(), page: state.page, kind: tool, color: curColor(), width: curWidth(), created: Date.now() };
  const markup = tool === 'freehand'
    ? { ...base, pts: [w] }
    : { ...base, pts: [w, { x: w.x, y: w.y }] };
  drag = { mode: 'draw', ptr: e.pointerId, markup, from: s, moved: false };
});

els.cv.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.ptr) return;
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  if (drag.mode === 'pan') {
    vp.panPx(e.clientX - drag.last.x, e.clientY - drag.last.y);
    drag.last = { x: e.clientX, y: e.clientY };
    return;
  }
  if (drag.mode === 'draw') {
    const m = drag.markup;
    if (m.kind === 'freehand') m.pts.push(w);
    else m.pts[1] = w;
    if (Math.hypot(s.x - drag.from.x, s.y - drag.from.y) > 4) drag.moved = true;
    vp.requestDraw();
    return;
  }
  const m = selMarkup();
  if (!m) return;
  if (drag.mode === 'move') {
    const dx = w.x - drag.from.x, dy = w.y - drag.from.y;
    m.pts = drag.orig.map(p => ({ x: p.x + dx, y: p.y + dy }));
    drag.moved = true;
    vp.requestDraw();
    return;
  }
  if (drag.mode === 'handle') {
    drag.moved = true;
    if (['rect', 'ellipse', 'cloud', 'highlight'].includes(m.kind)) {
      const r = normRect(m.pts[0], m.pts[1]);
      const corners = [
        { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
      const opposite = corners[(drag.hi + 2) % 4];
      m.pts = [opposite, { x: w.x, y: w.y }];
    } else if (m.kind === 'line' || m.kind === 'arrow') {
      m.pts[drag.hi] = { x: w.x, y: w.y };
    } else if (m.kind === 'callout') {
      m.pts[1] = { x: w.x, y: w.y };
    }
    vp.requestDraw();
  }
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.ptr) return;
  const d = drag;
  drag = null;
  els.cv.classList.remove('grabbing');

  if (d.mode === 'pan') return;

  if (d.mode === 'draw') {
    const m = d.markup;
    if (m.kind === 'callout') {
      // drag went target→note position: pts = [note anchor, target]
      const target = m.pts[0];
      const anchor = d.moved ? m.pts[1] : { x: target.x + 90 / vp.view.zoom, y: target.y - 70 / vp.view.zoom };
      m.pts = [anchor, target];
      openOverlay({ mode: 'new-callout', markup: m });
      vp.requestDraw();
      return;
    }
    if (!d.moved) { vp.requestDraw(); return; } // a click, not a shape
    if (m.kind === 'freehand') m.pts = simplifyPts(m.pts, 1.2 / vp.view.zoom);
    state.markups.push(m);
    selectedId = null;
    pushUndo(undoCapture); undoCapture = null;
    markupsChanged();
    return;
  }

  if ((d.mode === 'move' || d.mode === 'handle') && d.moved) {
    const m = selMarkup();
    if (m) m.modified = Date.now();
    pushUndo(undoCapture); undoCapture = null;
    markupsChanged();
  } else {
    undoCapture = null;
  }
}
els.cv.addEventListener('pointerup', endDrag);
els.cv.addEventListener('pointercancel', endDrag);

// double-click a note to edit its text
els.cv.addEventListener('dblclick', e => {
  if (!state.doc) return;
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  const hit = hitMarkup(vp.ctx, w);
  if (hit && (hit.kind === 'text' || hit.kind === 'callout')) {
    selectedId = hit.id;
    openOverlay({ mode: 'edit', markup: hit });
  }
});

/* ============================== Text overlay ============================== */

let overlay = null; // {mode:'new-text'|'new-callout'|'edit', anchor?, markup?}
let overlayBusy = false;

function openOverlay(o) {
  cancelOverlay();
  overlay = o;
  const anchor = o.mode === 'new-text' ? o.anchor : o.markup.pts[0];
  const s = vp.worldToScreen(anchor.x, anchor.y);
  els.textOverlay.style.left = Math.max(4, s.x - 4) + 'px';
  els.textOverlay.style.top = Math.max(4, s.y - 4) + 'px';
  els.textOverlay.value = o.mode === 'edit' ? (o.markup.text || '') : '';
  els.textOverlay.classList.remove('hidden');
  els.textOverlay.focus();
}

function commitOverlay() {
  if (!overlay || overlayBusy) return;
  overlayBusy = true;
  const o = overlay;
  overlay = null;
  els.textOverlay.classList.add('hidden');
  const text = els.textOverlay.value.replace(/\s+$/, '');
  if (text.trim()) {
    const prev = snapshot();
    if (o.mode === 'new-text') {
      state.markups.push({
        id: randId(), page: state.page, kind: 'text', color: curColor(),
        width: curWidth(), fontSize: curFont(), pts: [o.anchor], text, created: Date.now(),
      });
    } else if (o.mode === 'new-callout') {
      o.markup.text = text;
      o.markup.fontSize = curFont();
      state.markups.push(o.markup);
    } else {
      o.markup.text = text;
      o.markup.modified = Date.now();
    }
    pushUndo(prev);
    markupsChanged();
  } else if (o.mode === 'edit') {
    vp.requestDraw(); // empty edit = leave unchanged
  }
  overlayBusy = false;
}

function cancelOverlay() {
  if (!overlay) return;
  overlay = null;
  els.textOverlay.classList.add('hidden');
  vp.requestDraw();
}

els.textOverlay.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitOverlay(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelOverlay(); }
});
els.textOverlay.addEventListener('blur', () => commitOverlay());

/* ============================== Selected-markup restyling ============================== */

els.mkColor.addEventListener('input', () => {
  if (tool !== 'pan' && tool !== 'select') toolColors[tool] = els.mkColor.value;
  const m = selMarkup();
  if (m) {
    const prev = snapshot();
    m.color = els.mkColor.value;
    m.modified = Date.now();
    pushUndo(prev);
    markupsChanged();
  }
});
els.mkWidth.addEventListener('change', () => {
  const m = selMarkup();
  if (m) {
    const prev = snapshot();
    m.width = curWidth();
    if (m.fontSize) m.fontSize = curFont();
    m.modified = Date.now();
    pushUndo(prev);
    markupsChanged();
  }
});

function deleteSelected() {
  const m = selMarkup();
  if (!m) return;
  const prev = snapshot();
  state.markups = state.markups.filter(x => x.id !== m.id);
  selectedId = null;
  pushUndo(prev);
  markupsChanged();
}

/* ============================== Markup list panel ============================== */

$('btnList').addEventListener('click', () => els.markupPanel.classList.toggle('hidden'));
els.mkKindFilter.addEventListener('change', renderMarkupList);
els.mkThisSheet.addEventListener('change', renderMarkupList);

function renderMarkupList() {
  if (els.markupPanel.classList.contains('hidden')) return;
  const kind = els.mkKindFilter.value;
  const thisSheet = els.mkThisSheet.checked;
  const rows = state.markups
    .filter(m => (!kind || m.kind === kind) && (!thisSheet || m.page === state.page))
    .sort((a, b) => a.page - b.page || (a.created || 0) - (b.created || 0));
  els.mkList.innerHTML = '';
  if (!rows.length) {
    els.mkList.innerHTML = '<div class="mk-empty">No markups yet — pick a tool and drag on the sheet.</div>';
    return;
  }
  for (const m of rows) {
    const row = document.createElement('div');
    row.className = 'mk-row' + (m.id === selectedId ? ' selected' : '');
    row.innerHTML =
      `<span class="swatch" style="background:${esc(m.color)}"></span>` +
      `<span>${MK_ICON[m.kind] || '?'}</span>` +
      `<span class="grow"></span>` +
      `<span class="pg">p${m.page}</span>` +
      `<button class="btn tiny danger" title="Delete">✕</button>`;
    row.querySelector('.grow').textContent = m.text ? m.text.split('\n')[0] : MK_LABEL[m.kind];
    row.addEventListener('click', async e => {
      if (e.target.closest('button')) return;
      selectedId = m.id;
      await setPage(m.page);
      const ctx = vp.ctx;
      const bb = markupBBox(ctx, m);
      const r = els.cv.parentElement.getBoundingClientRect();
      vp.view.panX = r.width / 2 - ((bb.x0 + bb.x1) / 2) * vp.view.zoom;
      vp.view.panY = r.height / 2 - ((bb.y0 + bb.y1) / 2) * vp.view.zoom;
      renderMarkupList();
      vp.requestDraw();
    });
    row.querySelector('button').addEventListener('click', () => {
      const prev = snapshot();
      state.markups = state.markups.filter(x => x.id !== m.id);
      if (selectedId === m.id) selectedId = null;
      pushUndo(prev);
      markupsChanged();
    });
    els.mkList.appendChild(row);
  }
}

/* ============================== Topbar & keyboard ============================== */

els.btnPrev.addEventListener('click', () => setPage(state.page - 1));
els.btnNext.addEventListener('click', () => setPage(state.page + 1));
els.btnFit.addEventListener('click', async () => {
  const b = await baseSize(state.page);
  vp.fitTo(b.width, b.height);
});
$('btnThumbs').addEventListener('click', () => document.body.classList.toggle('nothumbs'));

document.addEventListener('keydown', e => {
  if (modals.isOpen() || !els.projects.classList.contains('hidden')) {
    if (e.key === 'Escape' && !els.projects.classList.contains('hidden')) els.projects.classList.add('hidden');
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') {
    if (drag) { drag = null; vp.requestDraw(); }
    else if (selectedId) { selectedId = null; renderMarkupList(); vp.requestDraw(); }
    return;
  }
  if (e.key === 'PageDown') { e.preventDefault(); setPage(state.page + 1); }
  if (e.key === 'PageUp') { e.preventDefault(); setPage(state.page - 1); }
  const PAN = 0.12;
  if (e.key === 'ArrowLeft') vp.panByFraction(-PAN, 0);
  if (e.key === 'ArrowRight') vp.panByFraction(PAN, 0);
  if (e.key === 'ArrowUp') vp.panByFraction(0, -PAN);
  if (e.key === 'ArrowDown') vp.panByFraction(0, PAN);
});

/* ============================== Projects (local-first) ============================== */

function projectData() {
  return { app: 'plan-room', version: 1, page: state.page, markups: state.markups };
}

let saveTimer = null;
function scheduleSave(now = false) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProjectNow, now ? 0 : 600);
}
async function saveProjectNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!state.projectId) return;
  try {
    await store.projPut({
      id: state.projectId,
      name: state.projectName || 'Project',
      modified: Date.now(),
      docKey: state.docKey || null,
      docName: state.docName || null,
      docType: state.docType || null,
      data: projectData(),
    });
  } catch (_) { /* IndexedDB unavailable */ }
}

function updateProjectBtn() { els.projName.textContent = state.projectName || 'Project'; }

function resetDocState() {
  state.doc = null; state.docKey = null; state.docName = null; state.docType = null; state.page = 1;
  selectedId = null;
  cancelOverlay();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  pageCanvas.clear(); pageBase.clear(); inflight.clear();
  els.thumbRail.innerHTML = '';
  els.dropHint.classList.remove('hidden');
  updatePageUI();
  vp.requestDraw();
}

async function openProject(rec) {
  await saveProjectNow(); // flush the outgoing project first
  state.projectId = rec.id;
  state.projectName = rec.name;
  resetDocState();
  state.markups = (rec.data && Array.isArray(rec.data.markups)) ? rec.data.markups : [];
  renderMarkupList();
  try { localStorage.setItem('planroom-current', rec.id); } catch (_) {}
  updateProjectBtn();
  if (rec.docKey) {
    try {
      const f = await store.filesGet(rec.docKey);
      if (f && f.bytes) {
        state.docKey = rec.docKey;
        await openFromBytes(f.bytes, f.name || rec.docName || 'plans', f.type || rec.docType, { persist: false });
        if (rec.data && rec.data.page) await setPage(rec.data.page);
      } else {
        setMsg(`"${rec.name}" opened — its plans (${rec.docName || '?'}) aren't stored here; use Open Plans….`);
      }
    } catch (_) {
      setMsg(`"${rec.name}" opened — could not reopen its plans; use Open Plans….`);
    }
  } else {
    setMsg(`"${rec.name}" opened. Open a plan set to get started.`);
  }
  els.projects.classList.add('hidden');
}

async function newProject(name) {
  await saveProjectNow();
  state.projectId = randId();
  state.projectName = name || 'Project ' + new Date().toLocaleDateString();
  resetDocState();
  state.markups = [];
  renderMarkupList();
  try { localStorage.setItem('planroom-current', state.projectId); } catch (_) {}
  updateProjectBtn();
  await saveProjectNow();
  setMsg(`"${state.projectName}" created. Open a plan set to get started.`);
}

async function showProjects() {
  await saveProjectNow();
  let recs = [];
  try { recs = (await store.projAll()).sort((a, b) => (b.modified || 0) - (a.modified || 0)); } catch (_) {}
  els.projList.innerHTML = '';
  for (const r of recs) {
    const row = document.createElement('div');
    row.className = 'proj-row' + (r.id === state.projectId ? ' current' : '');
    const when = r.modified ? new Date(r.modified).toLocaleDateString() : '';
    const nMk = (r.data && r.data.markups && r.data.markups.length) || 0;
    row.innerHTML = `
      <div class="grow">
        <div class="name"></div>
        <div class="meta">${r.docName ? esc(r.docName) + ' · ' : ''}${nMk} markup${nMk === 1 ? '' : 's'} · ${when}</div>
      </div>
      ${r.id === state.projectId ? '<span class="pill">current</span>' : '<button class="btn tiny" data-act="open">Open</button>'}
      <button class="btn tiny" data-act="ren" title="Rename">Rename</button>
      <button class="btn tiny danger" data-act="del" title="Delete this project">✕</button>`;
    row.querySelector('.name').textContent = r.name;
    row.querySelector('.grow').addEventListener('click', () => openProject(r));
    const openBtn = row.querySelector('[data-act="open"]');
    if (openBtn) openBtn.addEventListener('click', () => openProject(r));
    row.querySelector('[data-act="ren"]').addEventListener('click', async () => {
      const name = await modals.askText('Rename project', '', r.name);
      if (!name) return;
      r.name = name;
      await store.projPut(r);
      if (r.id === state.projectId) { state.projectName = name; updateProjectBtn(); }
      showProjects();
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      const ok = await modals.askModal({
        title: `Delete "${r.name}"?`,
        body: '<div class="hint">Removes this project and its markups permanently (no undo). Its plan file is removed too if no other project uses it.</div>',
      });
      if (ok === null) return;
      await store.projDelete(r.id);
      const rest = (await store.projAll()).filter(x => x.id !== r.id);
      if (r.docKey && !rest.some(x => x.docKey === r.docKey)) await store.filesDelete(r.docKey).catch(() => {});
      if (r.id === state.projectId) {
        if (rest.length) await openProject(rest.sort((a, b) => (b.modified || 0) - (a.modified || 0))[0]);
        else await newProject('Project 1');
      }
      showProjects();
    });
    els.projList.appendChild(row);
  }
  els.projects.classList.remove('hidden');
}

$('btnProjects').addEventListener('click', showProjects);
$('projClose').addEventListener('click', () => els.projects.classList.add('hidden'));
els.projects.addEventListener('click', e => { if (e.target === els.projects) els.projects.classList.add('hidden'); });
$('btnProjNew').addEventListener('click', async () => {
  const name = await modals.askText('New project', 'Name the project', '');
  if (name === null) return;
  els.projects.classList.add('hidden');
  await newProject(name);
});
$('btnNew').addEventListener('click', async () => {
  const name = await modals.askText('New project', 'Name the project', '');
  if (name === null) return;
  await newProject(name);
});

/* ============================== Save / load file ============================== */

$('btnExport').addEventListener('click', async () => {
  if (!state.doc && !state.markups.length) { setMsg('Nothing to save yet — open a plan set first.'); return; }
  setMsg('Building the file…');
  let docB64 = null;
  try {
    const f = state.docKey ? await store.filesGet(state.docKey) : null;
    if (f && f.bytes) docB64 = bytesToBase64(f.bytes);
  } catch (_) {}
  const out = {
    ...projectData(),
    name: state.projectName,
    docName: state.docName, docType: state.docType, docB64,
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.projectName || 'plan-room').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.planroom.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('Saved. The file has the plans and markups embedded — hand it to anyone.');
});

$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); } catch (_) { setMsg('That is not a Plan Room file.'); return; }
  if (!d || d.app !== 'plan-room') { setMsg('That is not a Plan Room file.'); return; }
  // Always land in a NEW project — never overwrite the one that's open.
  await newProject(d.name || file.name.replace(/\.planroom\.json$|\.json$/i, ''));
  state.markups = Array.isArray(d.markups) ? d.markups : [];
  renderMarkupList();
  if (d.docB64) {
    const bytes = base64ToBytes(d.docB64);
    await openFromBytes(bytes.buffer, d.docName || 'plans.pdf', d.docType);
    if (d.page) await setPage(d.page);
  }
  scheduleSave(true);
});

/* ============================== Boot ============================== */

async function boot() {
  vp.attach(paint);
  updatePageUI();
  let rec = null;
  try {
    const cur = localStorage.getItem('planroom-current');
    if (cur) rec = await store.projGet(cur);
    if (!rec) {
      const all = (await store.projAll()).sort((a, b) => (b.modified || 0) - (a.modified || 0));
      rec = all[0] || null;
    }
  } catch (_) {}
  if (rec) await openProject(rec);
  else await newProject('Project 1');
}

boot();
