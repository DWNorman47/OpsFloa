/* Excavation Bid Calculator — contour takeoff & cut/fill estimator */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'pdf.worker.min.js';

/* ============================== State ============================== */

const state = {
  pdf: null,               // pdfjs document
  pdfName: null,
  sheet: 'existing',       // active sheet: 'existing' | 'proposed'
  sheets: {
    existing: { pageNum: 1, image: null },  // image: offscreen canvas of rendered page
    proposed: { pageNum: 2, image: null },
  },
  renderScale: null,       // pdf units -> image px, shared by both sheets
  caps: null,              // per-active-page capabilities, e.g. { hatch, reason, stats }

  tool: 'pan',
  smooth: false,           // curve mode: draw smooth curves through the clicked points
  view: { zoom: 1, panX: 0, panY: 0 },   // screen = world*zoom + pan

  projectId: null,         // current project record id (IndexedDB 'projects' store)
  projectName: null,
  pdfKey: null,            // content-hash key of the PDF in the 'files' store

  calibration: null,       // { ax, ay, bx, by, feet, ftPerPx }
  // similarity transform proposed-image -> world: world = [[a,-b],[b,a]]·q + [e,f]
  align: { a: 1, b: 0, e: 0, f: 0 },
  boundary: [],            // closed polygon, world px [{x,y}]
  contours: { existing: [], proposed: [] }, // [{ pts:[{x,y}], elev, spot }]
  walls: [],               // retaining-wall digs: [{ id, pts:[{x,y}], cfg, result }]
  takeoffs: [],            // quantity takeoffs: [{ id, kind:'area', pts, cfg, result }]
  bid: null,               // bid report meta: { project, preparedBy, markup, prices:{key->$} }
  production: null,        // job production log: { tickets:[…], days:[…] }

  draft: [],               // in-progress clicks for trace/boundary
  calibPts: [],            // in-progress calibration clicks
  alignPts: [],            // align landmarks clicked on the EXISTING sheet (world)
  alignQs: [],             // matching landmarks on the PROPOSED sheet (raw image coords)
  realignPts: [],          // revision re-align: flat [from,to,from,to,…] world points
  measurePts: [],          // quick measure tool: up to 2 world points
  selected: null,          // { sheet, index }
  lastElev: { existing: null, proposed: null },
  prevElev: { existing: null, proposed: null },

  result: null,            // { grid, cutCY, fillCY, ... }
  showHeatmap: true,
  ghost: false,
  layers: { scale: true, boundary: true, contours: true }, // per-section "Show on drawing" toggles

  // transient pointer stuff
  mouse: { x: 0, y: 0, down: false, panning: false, sx: 0, sy: 0, moved: false },
  spaceHeld: false,
  dragCal: null,           // 'a' | 'b' while dragging a calibration endpoint
  dragBnd: null,           // boundary vertex index while dragging (-1 = click consumed)
  dragPad: null,           // { ci, vi } pad vertex while dragging (-1 = click consumed)
  dragSel: null,           // selected-contour vertex index while dragging (-1 = click consumed)
  dragDraft: null,         // draft vertex index while tracing before commit
  wandPts: null,           // highlighted auto-traced polyline awaiting an elevation
  boxA: null, boxB: null,  // erase-box drag corners (world px)
  selTake: null,           // selected takeoff index (state.takeoffs) for reshape/edit
  dragTake: null,          // selected-takeoff vertex index while dragging (-1 = click consumed)
  dragMove: null,          // whole-shape move: { what:'takeoff'|'contour', last:{x,y} }
  clipboard: null,         // copied shape: { type:'takeoff'|'contour', data }
};

/* ============================== DOM ============================== */

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const $ = id => document.getElementById(id);

const els = {
  filePdf: $('filePdf'), dropHint: $('dropHint'), hud: $('hud'), navPads: $('navPads'),
  pageExisting: $('pageExisting'), pageProposed: $('pageProposed'),
  scaleStatus: $('scaleStatus'), boundaryStatus: $('boundaryStatus'),
  contourTitle: $('contourTitle'), contourCount: $('contourCount'),
  contourList: $('contourList'),
  inpGrid: $('inpGrid'), inpInterval: $('inpInterval'), inpZoomSpeed: $('inpZoomSpeed'),
  inpShrink: $('inpShrink'), inpSwell: $('inpSwell'), inpTruck: $('inpTruck'),
  resultsSection: $('resultsSection'), results: $('results'),
  chkHeatmap: $('chkHeatmap'), chkGhost: $('chkGhost'),
  btnAlign: $('btnAlign'), btnAlignReset: $('btnAlignReset'), alignStatus: $('alignStatus'),
  btnEditDist: $('btnEditDist'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
  btnProjects: $('btnProjects'), projName: $('projName'),
  projects: $('projects'), projList: $('projList'),
  projNewBtn: $('projNewBtn'), projClose: $('projClose'),
  sbTool: $('sbTool'), sbMsg: $('sbMsg'), sbCoords: $('sbCoords'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'),
  modalOk: $('modalOk'), modalCancel: $('modalCancel'),
  help: $('help'),
};

/* ============================== Utilities ============================== */

function screenToWorld(sx, sy) {
  return { x: (sx - state.view.panX) / state.view.zoom,
           y: (sy - state.view.panY) / state.view.zoom };
}

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

const alignIdentity = () => ({ a: 1, b: 0, e: 0, f: 0 });
const alignIsIdentity = M => M.a === 1 && M.b === 0 && M.e === 0 && M.f === 0;
// raw proposed-image point -> world point
function alignApply(M, q) {
  return { x: M.a * q.x - M.b * q.y + M.e, y: M.b * q.x + M.a * q.y + M.f };
}
// world point -> raw proposed-image point (inverse of the align transform)
function alignInvert(M, w) {
  const s2 = M.a * M.a + M.b * M.b;
  const x = w.x - M.e, y = w.y - M.f;
  return { x: (M.a * x + M.b * y) / s2, y: (-M.b * x + M.a * y) / s2 };
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

function distToPolyline(px, py, pts) {
  if (pts.length === 1) return dist(px, py, pts[0].x, pts[0].y);
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const dd = pointSegDist(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (dd < d) d = dd;
  }
  return d;
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonAreaFt2(poly, ftPerPx) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2) * ftPerPx * ftPerPx;
}

// Closed-polygon perimeter in feet (sums every edge, including last→first).
function polygonPerimeterFt(poly, ftPerPx) {
  let p = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    p += dist(poly[j].x, poly[j].y, poly[i].x, poly[i].y);
  return p * ftPerPx;
}

// Catmull-Rom spline: a smooth curve that passes THROUGH every input point.
// Returns a densified polyline. `closed` wraps the ends into a loop (areas);
// open curves clamp the ends (contours, lines). <3 points can't curve.
function catmullRomSpline(pts, closed, segs = 14) {
  const n = pts.length;
  if (n < 3) return pts.map(p => ({ x: p.x, y: p.y }));
  const get = i => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const out = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < segs; s++) {
      const t = s / segs, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  if (!closed) out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
  return out;
}

function elevColor(elev, sheet) {
  // stable hue per elevation so equal elevations match visually
  const h = ((elev * 47) % 360 + 360) % 360;
  return sheet === 'existing'
    ? `hsl(${h}, 70%, 62%)`
    : `hsl(${h}, 85%, 55%)`;
}

function fmt(n, d = 0) {
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function money(n) {
  return '$' + (Math.round((n || 0) * 100) / 100)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function defaultBid() { return { project: '', preparedBy: '', markup: '', prices: {} }; }

function defaultProduction() { return { tickets: [], days: [] }; }
function normalizeProduction(d) {
  const p = defaultProduction();
  if (d && typeof d === 'object') {
    if (Array.isArray(d.tickets)) p.tickets = d.tickets;
    if (Array.isArray(d.days)) p.days = d.days;
  }
  return p;
}

function normalizeBid(d) {
  const b = defaultBid();
  if (d && typeof d === 'object') {
    b.project = d.project || '';
    b.preparedBy = d.preparedBy || '';
    b.markup = d.markup != null ? d.markup : '';
    b.prices = (d.prices && typeof d.prices === 'object') ? { ...d.prices } : {};
  }
  return b;
}

function setMsg(t) { els.sbMsg.textContent = t || ''; }

/* ============================== Modal ============================== */

let modalResolve = null;

function askModal({ title, body, focusSel }) {
  return new Promise(resolve => {
    modalResolve = resolve;
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = body;
    els.modal.classList.remove('hidden');
    const f = focusSel && els.modalBody.querySelector(focusSel);
    if (f) { f.focus(); f.select && f.select(); }
  });
}

function closeModal(val) {
  els.modal.classList.add('hidden');
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(val); }
}

els.modalOk.addEventListener('click', () => closeModal(readModalValue()));
els.modalCancel.addEventListener('click', () => closeModal(null));
els.modal.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); closeModal(readModalValue()); }
  if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
  e.stopPropagation();
});

function readModalValue() {
  const inp = els.modalBody.querySelector('input');
  return inp ? inp.value : true;
}

async function askNumber(title, hint, prefill, step) {
  const val = await askModal({
    title,
    body: `
      <input type="number" id="modalNum" step="any" value="${prefill ?? ''}">
      ${step ? `<div class="stepper">
        <button class="btn" data-step="${-step}">− ${step}</button>
        <button class="btn" data-step="${step}">+ ${step}</button>
      </div>` : ''}
      ${hint ? `<div class="hint">${hint}</div>` : ''}`,
    focusSel: '#modalNum',
  });
  if (val === null || val === '' || isNaN(parseFloat(val))) return null;
  return parseFloat(val);
}

async function askText(title, hint, prefill) {
  const esc = String(prefill ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const val = await askModal({
    title,
    body: `
      <input type="text" id="modalTxt" maxlength="80" value="${esc}">
      ${hint ? `<div class="hint">${hint}</div>` : ''}`,
    focusSel: '#modalTxt',
  });
  if (val === null) return null;
  const s = String(val).trim();
  return s || null;
}

els.modalBody.addEventListener('click', e => {
  const b = e.target.closest('[data-step]');
  if (!b) return;
  const inp = els.modalBody.querySelector('input');
  inp.value = (parseFloat(inp.value || 0) + parseFloat(b.dataset.step)).toString();
  inp.focus(); inp.select();
});

$('btnHelp').addEventListener('click', () => els.help.classList.remove('hidden'));
$('helpClose').addEventListener('click', () => els.help.classList.add('hidden'));

/* ============================== PDF loading ============================== */

// IndexedDB: 'files' holds PDF bytes keyed by content hash (shared between
// projects); 'projects' holds one record per takeoff.
function idb(store, mode, op) {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('ebc', 2);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
    };
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(store, mode);
      const res = op(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); resolve(res && res.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const idbFilesGet = key => idb('files', 'readonly', s => s.get(key));
const idbFilesPut = (key, val) => idb('files', 'readwrite', s => s.put(val, key));
const idbFilesDelete = key => idb('files', 'readwrite', s => s.delete(key));
const idbProjGet = id => idb('projects', 'readonly', s => s.get(id));
const idbProjPut = rec => idb('projects', 'readwrite', s => s.put(rec, rec.id));
const idbProjDelete = id => idb('projects', 'readwrite', s => s.delete(id));
const idbProjAll = () => idb('projects', 'readonly', s => s.getAll());

const randId = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

async function hashBytes(buf) {
  try {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].slice(0, 16)
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return 'f' + buf.byteLength + '-' + Date.now().toString(36); // no dedup, still works
  }
}

$('btnOpenPdf').addEventListener('click', () => els.filePdf.click());
els.filePdf.addEventListener('change', e => {
  if (e.target.files[0]) loadPdfFile(e.target.files[0]);
});

document.getElementById('canvasWrap').addEventListener('dragover', e => e.preventDefault());
document.getElementById('canvasWrap').addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type === 'application/pdf') loadPdfFile(f);
});

async function loadPdfFile(file) {
  setMsg(`Loading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    // store a copy BEFORE getDocument — pdf.js transfers (detaches) the buffer
    const copy = buf.slice(0);
    try {
      const key = await hashBytes(copy);
      await idbFilesPut(key, { name: file.name, bytes: copy });
      state.pdfKey = key;
    } catch (_) { /* private mode / quota — session still works */ }
    await openPdfBytes(buf, file.name);
  } catch (err) {
    console.error(err);
    setMsg('Could not open that PDF: ' + err.message);
  }
  draw();
}

async function openPdfBytes(buf, name) {
  state.pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  state.pdfName = name;
  Object.keys(pathCache).forEach(k => delete pathCache[k]);
  Object.keys(hatchCapCache).forEach(k => delete hatchCapCache[k]);
  els.dropHint.classList.add('hidden');

  const n = state.pdf.numPages;
  for (const sel of [els.pageExisting, els.pageProposed]) {
    sel.innerHTML = '';
    for (let i = 1; i <= n; i++) {
      const o = document.createElement('option');
      o.value = i; o.textContent = `Page ${i}`;
      sel.appendChild(o);
    }
    sel.disabled = false;
  }
  state.sheets.existing.pageNum = Math.min(state.sheets.existing.pageNum, n);
  state.sheets.proposed.pageNum = Math.min(n >= 2 ? state.sheets.proposed.pageNum : 1, n);
  els.pageExisting.value = state.sheets.existing.pageNum;
  els.pageProposed.value = state.sheets.proposed.pageNum;

  await renderSheet('existing');
  await renderSheet('proposed');
  await updateHatchCap();
  fitView();
  setMsg(`Loaded ${name} (${n} page${n > 1 ? 's' : ''}).` +
    (state.calibration ? '' : ' Now calibrate the scale (📏).'));
  saveLocal();
}

async function renderSheet(sheet) {
  if (!state.pdf) return;
  const s = state.sheets[sheet];
  const page = await state.pdf.getPage(s.pageNum);
  const base = page.getViewport({ scale: 1 });
  if (!state.renderScale) state.renderScale = Math.min(3, 2800 / base.width);
  const vp = page.getViewport({ scale: state.renderScale });
  const off = document.createElement('canvas');
  off.width = Math.ceil(vp.width);
  off.height = Math.ceil(vp.height);
  await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
  s.image = off;
}

els.pageExisting.addEventListener('change', async e => {
  state.sheets.existing.pageNum = parseInt(e.target.value);
  await renderSheet('existing'); saveLocal(); draw(); updateHatchCap();
});
els.pageProposed.addEventListener('change', async e => {
  state.sheets.proposed.pageNum = parseInt(e.target.value);
  await renderSheet('proposed'); saveLocal(); draw(); updateHatchCap();
});

/* ============================== View / canvas ============================== */

function resizeCanvas() {
  const r = cv.parentElement.getBoundingClientRect();
  const w = Math.round(r.width * devicePixelRatio);
  const h = Math.round(r.height * devicePixelRatio);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  draw();
}
window.addEventListener('resize', resizeCanvas);
// the canvas area also changes size without a window resize (e.g. layout shifts) —
// a stale buffer gets stretched to fit, drawing everything slightly off the cursor
new ResizeObserver(resizeCanvas).observe(cv.parentElement);

function fitView() {
  const img = state.sheets[state.sheet].image;
  if (!img) return;
  const r = cv.parentElement.getBoundingClientRect();
  const z = Math.min(r.width / img.width, r.height / img.height) * 0.97;
  state.view.zoom = z;
  state.view.panX = (r.width - img.width * z) / 2;
  state.view.panY = (r.height - img.height * z) / 2;
}

// Edge/corner jump pads — pan a third of a screen without dragging. dx=+1 is
// right, dy=+1 is down; decreasing pan reveals content in that direction.
const PAN_STEP = 0.12; // arrow-key pan step, as a fraction of the viewport
// pan by a fraction of the viewport (dx/dy in screen fractions; + = reveal that side)
function panBy(dxFrac, dyFrac) {
  const r = cv.parentElement.getBoundingClientRect();
  state.view.panX -= dxFrac * r.width;
  state.view.panY -= dyFrac * r.height;
  draw();
}

document.querySelectorAll('.nav-pad').forEach(b => b.addEventListener('click', () => {
  panBy(parseInt(b.dataset.dx, 10) / 3, parseInt(b.dataset.dy, 10) / 3);
}));

// Show the pads only when zoomed in past ~70% (less than 70% of the plan is on
// screen), where dragging to navigate gets tedious. Called every paint.
function updateNavPads() {
  const img = state.sheets[state.sheet].image;
  let show = false;
  if (img) {
    const r = cv.parentElement.getBoundingClientRect();
    const fitZoom = Math.min(r.width / img.width, r.height / img.height);
    show = fitZoom > 0 && state.view.zoom > fitZoom / 0.7;
  }
  els.navPads.classList.toggle('hidden', !show);
  cv.parentElement.classList.toggle('nav-active', show);
}

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; paint(); });
}

function paint() {
  const w = cv.width / devicePixelRatio, h = cv.height / devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(state.view.panX, state.view.panY);
  ctx.scale(state.view.zoom, state.view.zoom);

  // the proposed image is drawn through the align transform so it lands in world coords
  const drawSheetImage = (image, sheet) => {
    if (sheet === 'proposed' && !alignIsIdentity(state.align)) {
      const M = state.align;
      ctx.save();
      ctx.transform(M.a, M.b, -M.b, M.a, M.e, M.f);
      ctx.drawImage(image, 0, 0);
      ctx.restore();
    } else ctx.drawImage(image, 0, 0);
  };

  // nothing to anchor overlays to until a sheet is rendered
  const img = state.sheets[state.sheet].image;
  if (!img) { ctx.restore(); updateHud(); return; }

  ctx.imageSmoothingEnabled = state.view.zoom < 1;
  drawSheetImage(img, state.sheet);

  const other = state.sheet === 'existing' ? 'proposed' : 'existing';

  // ghost of the other sheet's drawing (also a visual alignment check)
  if (state.ghost) {
    const oimg = state.sheets[other].image;
    if (oimg && oimg !== img) {
      ctx.globalAlpha = 0.35;
      drawSheetImage(oimg, other);
      ctx.globalAlpha = 1;
    }
  }

  // heatmap under the linework
  if (state.result && state.showHeatmap) drawHeatmap();

  // contour linework — hidden by the Contours section's "Show on drawing" toggle
  if (state.layers.contours) {
    // ghost of the other surface's traces
    if (state.ghost) {
      ctx.globalAlpha = 0.3;
      for (const c of state.contours[other]) drawContour(c, other, false);
      ctx.globalAlpha = 1;
    }

    // this sheet's traces
    state.contours[state.sheet].forEach((c, i) => {
      const sel = state.selected && state.selected.sheet === state.sheet && state.selected.index === i;
      drawContour(c, state.sheet, sel);
    });
  }

  if (state.layers.boundary) drawBoundary();
  drawWall();
  drawTakeoffs();
  if (state.layers.scale) drawCalibration();
  drawDraft();
  drawRealign();
  drawMeasure();

  // auto-traced line awaiting its elevation
  if (state.wandPts && state.wandPts.length) {
    ctx.strokeStyle = '#ff9f43';
    ctx.lineWidth = lw(5);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    state.wandPts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // erase-box marquee
  if (state.boxA && state.boxB) {
    const a = state.boxA, b = state.boxB;
    ctx.fillStyle = 'rgba(224,85,85,.12)';
    ctx.strokeStyle = '#e05555';
    ctx.lineWidth = lw(1.5);
    ctx.setLineDash([lw(6), lw(4)]);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }

  // crosshair at the pending align landmark so the same spot is easy to re-find
  if (state.alignPts.length > state.alignQs.length) {
    const p = state.alignPts[state.alignPts.length - 1], r = lw(14);
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = lw(2);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x + r, p.y);
    ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, p.y + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
  updateHud();
}

function lw(px) { return px / state.view.zoom; } // constant screen-width lines

function drawContour(c, sheet, selected) {
  const col = elevColor(c.elev, sheet);
  ctx.strokeStyle = ctx.fillStyle = col;
  ctx.lineWidth = lw(selected ? 4 : 2.2);

  if (c.pad) {
    ctx.setLineDash([]);
    ctx.beginPath();
    c.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    const ga = ctx.globalAlpha;
    ctx.globalAlpha = ga * 0.18;
    ctx.fill();
    ctx.globalAlpha = ga;
    ctx.stroke();
    const cx2 = c.pts.reduce((s, p) => s + p.x, 0) / c.pts.length;
    const cy2 = c.pts.reduce((s, p) => s + p.y, 0) / c.pts.length;
    labelAt(cx2, cy2, `PAD ${c.elev}`, col);
    // editable vertex handles while the Pad tool is active, or when selected
    if ((state.tool === 'pad' || (selected && state.tool === 'select')) && !state.draft.length && sheet === state.sheet) {
      for (const p of c.pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, lw(8), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    return;
  }

  ctx.setLineDash(sheet === 'existing' ? [lw(9), lw(6)] : []);

  if (c.spot || c.pts.length === 1) {
    const p = c.pts[0];
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw(selected ? 7 : 5), 0, Math.PI * 2);
    ctx.stroke();
    labelAt(p.x + lw(9), p.y - lw(9), String(c.elev), col);
    return;
  }

  ctx.beginPath();
  c.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.stroke();
  ctx.setLineDash([]);

  // draggable vertex handles when this contour is selected (Select tool)
  if (selected && state.tool === 'select' && sheet === state.sheet) {
    for (const p of c.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, lw(7), 0, Math.PI * 2); ctx.stroke(); }
  }

  const mid = c.pts[Math.floor(c.pts.length / 2)];
  labelAt(mid.x, mid.y - lw(8), String(c.elev), col);
}

function labelAt(x, y, text, col) {
  const size = lw(14);
  ctx.font = `bold ${size}px Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = lw(4);
  ctx.strokeStyle = 'rgba(20,23,27,.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = col;
  ctx.fillText(text, x, y);
}

function drawBoundary() {
  if (state.boundary.length < 2) return;
  ctx.strokeStyle = '#ffd24d';
  ctx.lineWidth = lw(2.5);
  ctx.setLineDash([lw(14), lw(7)]);
  ctx.beginPath();
  state.boundary.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  // editable vertex handles while the Boundary tool is active
  if (state.tool === 'boundary' && !state.draft.length) {
    for (const p of state.boundary) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, lw(8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawCalibration() {
  const pts = state.calibPts.length ? state.calibPts
    : state.calibration ? [{ x: state.calibration.ax, y: state.calibration.ay },
                           { x: state.calibration.bx, y: state.calibration.by }]
    : null;
  if (!pts) return;
  ctx.strokeStyle = ctx.fillStyle = '#3fbf6f';
  ctx.lineWidth = lw(2);
  const grabbable = state.tool === 'calibrate' && state.calibration && !state.calibPts.length;
  for (const p of pts) {
    ctx.beginPath();
    ctx.moveTo(p.x - lw(8), p.y); ctx.lineTo(p.x + lw(8), p.y);
    ctx.moveTo(p.x, p.y - lw(8)); ctx.lineTo(p.x, p.y + lw(8));
    ctx.stroke();
    if (grabbable) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, lw(10), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
    if (state.calibration && !state.calibPts.length) {
      labelAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2 - lw(8),
              `${state.calibration.feet} ft`, '#3fbf6f');
    }
  }
}

function drawDraft() {
  if (!state.draft.length) return;
  // count drops are discrete markers, not a polyline — no connecting/rubber-band line
  if (state.tool === 'count') {
    state.draft.forEach((p, i) => drawCountMarker(p, i + 1));
    return;
  }
  ctx.strokeStyle = ctx.fillStyle =
    state.tool === 'boundary' ? '#ffd24d' : state.tool === 'pad' ? '#c07ef7' : '#4da3ff';
  ctx.lineWidth = lw(2);
  ctx.setLineDash([lw(5), lw(5)]);
  ctx.beginPath();
  const m = screenToWorld(state.mouse.x, state.mouse.y);
  if (state.smooth && SMOOTHABLE_TOOLS.includes(state.tool) && state.draft.length >= 2) {
    // preview the smooth curve through the placed points + the rubber-band point
    const curve = catmullRomSpline(state.draft.concat([m]), false);
    curve.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  } else {
    state.draft.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.lineTo(m.x, m.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  const editableDraft = ['trace', 'boundary', 'pad', 'wall', 'area', 'line'].includes(state.tool);
  for (const p of state.draft) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw(editableDraft ? 5 : 3), 0, Math.PI * 2);
    ctx.fill();
    if (editableDraft) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, lw(8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawHeatmap() {
  const g = state.result.grid;
  ctx.globalAlpha = 0.45;
  for (let r = 0; r < g.rows; r++) {
    for (let cI = 0; cI < g.cols; cI++) {
      const dz = g.dz[r * g.cols + cI];
      if (dz === null || Math.abs(dz) < 0.02) continue;
      const t = Math.min(1, Math.abs(dz) / g.maxAbs);
      ctx.fillStyle = dz < 0
        ? `rgba(224,85,85,${0.25 + 0.75 * t})`     // cut
        : `rgba(77,163,255,${0.25 + 0.75 * t})`;   // fill
      ctx.fillRect(g.x0 + cI * g.cellPx, g.y0 + r * g.cellPx, g.cellPx + 0.5, g.cellPx + 0.5);
    }
  }
  ctx.globalAlpha = 1;
}

function updateHud() {
  updateNavPads();
  const msgs = {
    pan: 'Drag to pan · wheel to zoom',
    calibrate: state.calibPts.length === 1 ? 'Click the SECOND point'
      : state.calibration
        ? 'Drag an endpoint (○) to adjust it, or click two new points to re-measure'
        : 'Click the FIRST point of a known distance',
    boundary: state.draft.length
      ? `Boundary: ${state.draft.length} pts — Enter/double-click to close, Backspace undoes`
      : state.boundary.length >= 3
        ? 'Edit the boundary: drag a point (○) · double-click an edge to add a point · Alt+click removes · click elsewhere to redraw'
        : 'Click around the limits of disturbance',
    trace: state.draft.length
      ? `Tracing: ${state.draft.length} pts — Enter/double-click to finish, Backspace undoes, Esc cancels`
      : `Click along an elevation-labeled ${state.sheet === 'existing' ? 'EXISTING' : 'PROPOSED'} contour line`,
    wand: 'Click ON a contour — the whole line is lifted from the PDF vector data, then you confirm its elevation',
    spot: 'Click a spot grade (FG spot, high/low point)',
    pad: state.draft.length
      ? `Pad: ${state.draft.length} pts — Enter/double-click to close, Backspace undoes`
      : state.contours[state.sheet].some(c => c.pad)
        ? 'Click around a new pad — or edit one: drag a point (○) · double-click an edge to add a point · Alt+click removes'
        : 'Click around the building pad footprint — everything inside is held flat at one elevation',
    select: state.selected
      ? 'Drag the body to move · drag a point (○) to reshape · double-click an edge to add · Alt+click removes · Ctrl+C/V copies · Delete removes · E edits elevation'
      : state.selTake != null
        ? 'Drag the body to move · drag a point (○) to reshape · double-click an edge to add · Alt+click removes · Ctrl+C/V copies · Delete removes · E re-picks type'
        : 'Click a line, area, or line takeoff to select it — then move/reshape/copy it · Delete removes · E edits',
    erase: state.selected && state.selected.sheet === state.sheet
      ? 'Drag a box — erases only from the SELECTED line · Esc deselects to erase from all lines'
      : 'Drag a box — traced line portions inside it are erased (lines crossing it are split)',
    align: state.alignPts.length > state.alignQs.length
      ? 'Align: click that SAME landmark on the PROPOSED drawing (green cross = where Existing has it)'
      : state.alignQs.length === 1
        ? 'Align: click a SECOND landmark on the EXISTING sheet (far from the first) to fix rotation — or press Enter to keep shift only'
        : 'Align: click a sharp landmark on the EXISTING sheet (property corner, title block corner…)',
  };
  els.hud.textContent = state.pdf ? (msgs[state.tool] || '') : '';
}

/* ============================== Tools & input ============================== */

const TOOL_LABEL = {
  pan: 'Pan', calibrate: 'Scale', boundary: 'Boundary',
  trace: 'Trace contour', wand: 'Auto trace', spot: 'Spot elevation', pad: 'Flat pad',
  wall: 'Wall dig', area: 'Area takeoff', line: 'Linear takeoff', count: 'Count takeoff', select: 'Select', erase: 'Erase box', align: 'Align sheets',
  realign: 'Re-align traces', measure: 'Measure',
};

function setTool(t) {
  finishDraftIfAny(false);
  state.tool = t;
  state.calibPts = [];
  state.alignPts = [];
  state.alignQs = [];
  state.realignPts = [];
  state.measurePts = [];
  state.wandPts = null;
  state.boxA = state.boxB = null;
  state.dragDraft = null;
  state.dragSel = null;
  state.dragTake = null;
  state.dragMove = null;
  document.querySelectorAll('.tool').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
  cv.classList.toggle('crosshair', t !== 'pan');
  els.sbTool.textContent = TOOL_LABEL[t];
  draw();
}

document.querySelectorAll('.tool').forEach(b =>
  b.addEventListener('click', () => {
    if (b.dataset.tool === 'autoarea') { autoAreaClick(); return; } // placeholder (Phase 1)
    setTool(b.dataset.tool);
  }));

function switchSheet(s) {
  finishDraftIfAny(false);
  state.sheet = s;
  state.selected = null;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.sheet === s));
  refreshContourList();
  draw();
  updateHatchCap();
}

document.querySelectorAll('.tab').forEach(b =>
  b.addEventListener('click', () => switchSheet(b.dataset.sheet)));

function renderSmoothUI() {
  const b = $('btnSmooth');
  if (b) b.classList.toggle('on', state.smooth);
}
function setSmooth(on) {
  state.smooth = on;
  renderSmoothUI();
  setMsg(on
    ? 'Curve mode ON — points you place are joined by a smooth curve through them. Press C to turn off.'
    : 'Curve mode off — points join with straight segments.');
  draw();
}
$('btnSmooth').addEventListener('click', () => setSmooth(!state.smooth));

cv.addEventListener('contextmenu', e => e.preventDefault());

cv.addEventListener('wheel', e => {
  e.preventDefault();
  // scale by the actual wheel delta (smooth on touchpads), adjustable via Zoom speed %
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
  const speed = Math.max(10, Math.min(300, parseFloat(els.inpZoomSpeed.value) || 100)) / 100;
  const f = Math.exp(-Math.max(-300, Math.min(300, px)) * 0.0014 * speed);
  const nz = Math.max(0.02, Math.min(30, state.view.zoom * f));
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  state.view.panX = mx - (mx - state.view.panX) * (nz / state.view.zoom);
  state.view.panY = my - (my - state.view.panY) * (nz / state.view.zoom);
  state.view.zoom = nz;
  draw();
}, { passive: false });

cv.addEventListener('mousedown', e => {
  if (e.button === 1) e.preventDefault();
  const r = cv.getBoundingClientRect();
  state.mouse.sx = e.clientX - r.left;
  state.mouse.sy = e.clientY - r.top;
  state.mouse.down = true;
  state.mouse.moved = false;
  state.mouse.panning = (e.button === 1 || e.button === 2 ||
                         state.spaceHeld || state.tool === 'pan');
  if (state.mouse.panning) cv.classList.add('grabbing');

  if (!state.mouse.panning && e.button === 0 && state.tool === 'erase')
    state.boxA = screenToWorld(state.mouse.sx, state.mouse.sy);

  // While tracing a draft, let earlier vertices be adjusted before committing it.
  if (!state.mouse.panning && e.button === 0 && state.draft.length &&
      ['trace', 'boundary', 'pad', 'wall', 'area', 'line'].includes(state.tool)) {
    const w = screenToWorld(state.mouse.sx, state.mouse.sy);
    const thresh = 12 / state.view.zoom;
    let hit = -1, hd = thresh;
    state.draft.forEach((p, i) => {
      const d = dist(w.x, w.y, p.x, p.y);
      if (d < hd) { hd = d; hit = i; }
    });
    if (hit >= 0) state.dragDraft = hit;
  }

  // with the Boundary tool, grabbing a vertex of the closed polygon edits it
  if (!state.mouse.panning && e.button === 0 && state.tool === 'boundary' &&
      state.boundary.length >= 3 && !state.draft.length) {
    const w = screenToWorld(state.mouse.sx, state.mouse.sy);
    const thresh = 12 / state.view.zoom;
    let hit = -1, hd = thresh;
    state.boundary.forEach((p, i) => {
      const d = dist(w.x, w.y, p.x, p.y);
      if (d < hd) { hd = d; hit = i; }
    });
    if (hit >= 0) {
      if (e.altKey) {
        // Alt+click removes the vertex (a polygon needs at least 3)
        if (state.boundary.length > 3) {
          snapshot();
          state.boundary.splice(hit, 1);
          boundaryEdited('Boundary point removed.');
        } else setMsg('A boundary needs at least 3 points — draw a new one instead.');
        state.dragBnd = -1; // consume the coming click
      } else { state.dragBnd = hit; pendingSnap = takeSnap(); }
    }
  }

  // with the Pad tool, grabbing a vertex of an existing pad edits it
  if (!state.mouse.panning && e.button === 0 && state.tool === 'pad' && !state.draft.length) {
    const w = screenToWorld(state.mouse.sx, state.mouse.sy);
    const thresh = 12 / state.view.zoom;
    let hit = null, hd = thresh;
    state.contours[state.sheet].forEach((c, ci) => {
      if (!c.pad) return;
      c.pts.forEach((p, vi) => {
        const d = dist(w.x, w.y, p.x, p.y);
        if (d < hd) { hd = d; hit = { ci, vi }; }
      });
    });
    if (hit) {
      const c = state.contours[state.sheet][hit.ci];
      if (e.altKey) {
        if (c.pts.length > 3) {
          snapshot();
          c.pts.splice(hit.vi, 1);
          padEdited('Pad point removed.');
        } else setMsg('A pad needs at least 3 points — delete the whole pad instead (➤ Select, Delete).');
        state.dragPad = -1; // consume the coming click
      } else { state.dragPad = hit; pendingSnap = takeSnap(); }
    }
  }

  // with the Select tool, grabbing a vertex of the selected contour reshapes it
  if (!state.mouse.panning && e.button === 0 && state.tool === 'select' &&
      state.selected && state.selected.sheet === state.sheet && !state.draft.length) {
    const c = state.contours[state.sheet][state.selected.index];
    if (c) {
      const w = screenToWorld(state.mouse.sx, state.mouse.sy);
      const thresh = 12 / state.view.zoom;
      let hit = -1, hd = thresh;
      c.pts.forEach((p, i) => { const d = dist(w.x, w.y, p.x, p.y); if (d < hd) { hd = d; hit = i; } });
      if (hit >= 0) {
        const isSpot = c.spot || c.pts.length === 1;
        const min = c.pad ? 3 : 2;
        if (e.altKey && !isSpot) {
          if (c.pts.length > min) {
            snapshot();
            c.pts.splice(hit, 1);
            padEdited('Contour point removed.');
          } else setMsg(`This shape needs at least ${min} points — use Delete to remove the whole contour.`);
          state.dragSel = -1; // consume the coming click
        } else { state.dragSel = hit; pendingSnap = takeSnap(); }
      }
    }
  }

  // with the Select tool, grabbing a vertex of the selected takeoff reshapes it
  if (!state.mouse.panning && e.button === 0 && state.tool === 'select' &&
      state.selTake != null && !state.draft.length) {
    const t = state.takeoffs[state.selTake];
    if (t && t.pts) {
      const w = screenToWorld(state.mouse.sx, state.mouse.sy);
      const thresh = 12 / state.view.zoom;
      let hit = -1, hd = thresh;
      t.pts.forEach((p, i) => { const d = dist(w.x, w.y, p.x, p.y); if (d < hd) { hd = d; hit = i; } });
      if (hit >= 0) {
        const min = t.kind === 'area' ? 3 : 2;
        if (e.altKey) {
          if (t.pts.length > min) {
            snapshot();
            t.pts.splice(hit, 1);
            recomputeTakeoff(t);
            renderTakeoffs(); saveLocal();
            setMsg('Point removed.');
          } else setMsg(`This ${t.kind} needs at least ${min} points — use Delete to remove it.`);
          state.dragTake = -1; // consume the coming click
        } else { state.dragTake = hit; pendingSnap = takeSnap(); }
      }
    }
  }

  // with the Select tool, pressing the BODY of the selected shape (not a vertex)
  // moves the whole shape
  if (!state.mouse.panning && e.button === 0 && state.tool === 'select' && !state.draft.length &&
      state.dragTake === null && state.dragSel === null && !e.altKey) {
    const w = screenToWorld(state.mouse.sx, state.mouse.sy);
    if (state.selTake != null && hitTakeoff(w) === state.selTake) {
      state.dragMove = { what: 'takeoff', last: { x: w.x, y: w.y } }; pendingSnap = takeSnap();
    } else if (state.selected && state.selected.sheet === state.sheet) {
      const h = hitTest(w);
      if (h && h.sheet === state.selected.sheet && h.index === state.selected.index) {
        state.dragMove = { what: 'contour', last: { x: w.x, y: w.y } }; pendingSnap = takeSnap();
      }
    }
  }

  // with the Scale tool, grabbing an existing endpoint drags it instead of re-clicking
  if (!state.mouse.panning && e.button === 0 && state.tool === 'calibrate' &&
      state.calibration && !state.calibPts.length) {
    const w = screenToWorld(state.mouse.sx, state.mouse.sy);
    const c = state.calibration, thresh = 12 / state.view.zoom;
    if (dist(w.x, w.y, c.ax, c.ay) < thresh) state.dragCal = 'a';
    else if (dist(w.x, w.y, c.bx, c.by) < thresh) state.dragCal = 'b';
    if (state.dragCal) pendingSnap = takeSnap();
  }
});

cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (state.mouse.down) {
    if (Math.abs(x - state.mouse.sx) + Math.abs(y - state.mouse.sy) > 3)
      state.mouse.moved = true;
    if (state.mouse.panning && state.mouse.moved) {
      state.view.panX += x - state.mouse.x;
      state.view.panY += y - state.mouse.y;
    }
    if (state.boxA && state.tool === 'erase' && state.mouse.moved)
      state.boxB = screenToWorld(x, y);
    if (state.dragDraft !== null) {
      const w = screenToWorld(x, y);
      state.draft[state.dragDraft] = { x: w.x, y: w.y };
    }
    if (state.dragBnd !== null && state.dragBnd >= 0) {
      const w = screenToWorld(x, y);
      state.boundary[state.dragBnd] = { x: w.x, y: w.y };
    }
    if (state.dragPad !== null && typeof state.dragPad === 'object') {
      const w = screenToWorld(x, y);
      state.contours[state.sheet][state.dragPad.ci].pts[state.dragPad.vi] = { x: w.x, y: w.y };
    }
    if (state.dragSel !== null && state.dragSel >= 0 && state.selected) {
      const w = screenToWorld(x, y);
      const c = state.contours[state.selected.sheet][state.selected.index];
      if (c) c.pts[state.dragSel] = { x: w.x, y: w.y };
    }
    if (state.dragTake !== null && state.dragTake >= 0 && state.selTake != null) {
      const w = screenToWorld(x, y);
      const t = state.takeoffs[state.selTake];
      if (t) t.pts[state.dragTake] = { x: w.x, y: w.y };
    }
    if (state.dragMove) {
      const w = screenToWorld(x, y);
      const dx = w.x - state.dragMove.last.x, dy = w.y - state.dragMove.last.y;
      const pts = state.dragMove.what === 'takeoff'
        ? (state.takeoffs[state.selTake] || {}).pts
        : (state.contours[state.selected.sheet][state.selected.index] || {}).pts;
      if (pts) { for (const p of pts) { p.x += dx; p.y += dy; } }
      state.dragMove.last = { x: w.x, y: w.y };
    }
    if (state.dragCal) {
      const w = screenToWorld(x, y);
      const c = state.calibration;
      if (state.dragCal === 'a') { c.ax = w.x; c.ay = w.y; }
      else { c.bx = w.x; c.by = w.y; }
      const px = dist(c.ax, c.ay, c.bx, c.by);
      if (px > 2) c.ftPerPx = c.feet / px;
      refreshStatuses();
    }
  }
  state.mouse.x = x; state.mouse.y = y;

  const w = screenToWorld(x, y);
  let coords = `${Math.round(w.x)}, ${Math.round(w.y)} px`;
  if (state.calibration) {
    coords = `${(w.x * state.calibration.ftPerPx).toFixed(1)}, ${(w.y * state.calibration.ftPerPx).toFixed(1)} ft`;
  }
  els.sbCoords.textContent = coords;

  if (state.draft.length || state.mouse.down) draw();
});

cv.addEventListener('mouseup', e => {
  const wasPanning = state.mouse.panning, moved = state.mouse.moved;
  state.mouse.down = false;
  state.mouse.panning = false;
  cv.classList.remove('grabbing');
  if (state.dragDraft !== null) {
    const didMove = moved;
    state.dragDraft = null;
    if (didMove) setMsg('Draft point moved.');
    draw();
    return;
  }
  if (state.dragPad !== null) {
    const didMove = typeof state.dragPad === 'object' && moved;
    state.dragPad = null;
    if (didMove) {
      if (pendingSnap) pushSnap(pendingSnap);
      padEdited('Pad point moved.');
    }
    pendingSnap = null;
    draw();
    return;
  }
  if (state.dragBnd !== null) {
    const moved2 = state.dragBnd >= 0 && moved;
    state.dragBnd = null;
    if (moved2) {
      if (pendingSnap) pushSnap(pendingSnap);
      boundaryEdited('Boundary point moved.');
    }
    pendingSnap = null;
    draw();
    return;
  }
  if (state.dragSel !== null) {
    const didMove = state.dragSel >= 0 && moved;
    state.dragSel = null;
    if (didMove) {
      if (pendingSnap) pushSnap(pendingSnap);
      padEdited('Contour point moved.');
    }
    pendingSnap = null;
    draw();
    return;
  }
  if (state.dragTake !== null) {
    const didMove = state.dragTake >= 0 && moved;
    state.dragTake = null;
    if (didMove) {
      if (pendingSnap) pushSnap(pendingSnap);
      const t = state.takeoffs[state.selTake];
      if (t) recomputeTakeoff(t);
      renderTakeoffs(); saveLocal();
      setMsg('Takeoff point moved.');
    }
    pendingSnap = null;
    draw();
    return;
  }
  if (state.dragMove) {
    const what = state.dragMove.what;
    state.dragMove = null;
    if (moved) {
      if (pendingSnap) pushSnap(pendingSnap);
      if (what === 'takeoff') { renderTakeoffs(); saveLocal(); setMsg('Shape moved.'); } // area/length unchanged by a translate
      else padEdited('Contour moved.'); // invalidates the stale cut/fill result + saves
    }
    pendingSnap = null;
    draw();
    return;
  }
  if (state.dragCal) {
    state.dragCal = null;
    if (moved && pendingSnap) pushSnap(pendingSnap);
    pendingSnap = null;
    state.result = null;
    els.resultsSection.classList.add('hidden');
    refreshStatuses();
    updateAlignStatus();
    saveLocal();
    setMsg(`Scale updated: ${state.calibration.feet} ft reference re-measured.`);
    draw();
    return;
  }
  if (state.tool === 'erase' && state.boxA) {
    const a = state.boxA, b = state.boxB;
    state.boxA = state.boxB = null;
    if (b && moved && e.button === 0)
      eraseInBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    draw();
    return;
  }
  if (wasPanning || moved || e.button !== 0) return;
  handleClick(screenToWorld(state.mouse.x, state.mouse.y));
});

cv.addEventListener('dblclick', e => {
  e.preventDefault();
  // double-click on a pad's edge inserts a new vertex there
  if (state.tool === 'pad' && !state.draft.length) {
    const r = cv.getBoundingClientRect();
    const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const hit = nearestPadEdge(w, 10 / state.view.zoom);
    if (hit) {
      snapshot();
      state.contours[state.sheet][hit.ci].pts.splice(hit.i + 1, 0, hit.p);
      padEdited('Pad point added — drag it into place.');
      draw();
    }
    return;
  }
  // double-click on a closed boundary's edge inserts a new vertex there
  if (state.tool === 'boundary' && !state.draft.length && state.boundary.length >= 3) {
    const r = cv.getBoundingClientRect();
    const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const hit = nearestBoundaryEdge(w, 10 / state.view.zoom);
    if (hit) {
      snapshot();
      state.boundary.splice(hit.i + 1, 0, hit.p);
      boundaryEdited('Boundary point added — drag it into place.');
      draw();
    }
    return;
  }
  // double-click an edge of the selected contour inserts a vertex there
  if (state.tool === 'select' && state.selected && state.selected.sheet === state.sheet) {
    const c = state.contours[state.sheet][state.selected.index];
    if (c && !c.spot && c.pts.length >= 2) {
      const r = cv.getBoundingClientRect();
      const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const hit = nearestContourEdge(c, w, 10 / state.view.zoom);
      if (hit) {
        snapshot();
        c.pts.splice(hit.i + 1, 0, hit.p);
        padEdited('Contour point added — drag it into place.');
        draw();
      }
    }
    return;
  }
  // double-click an edge of the selected takeoff (area/line) inserts a vertex
  if (state.tool === 'select' && state.selTake != null) {
    const t = state.takeoffs[state.selTake];
    if (t && (t.kind === 'area' || t.kind === 'line') && t.pts.length >= 2) {
      const r = cv.getBoundingClientRect();
      const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const hit = nearestTakeoffEdge(t.pts, w, 10 / state.view.zoom, t.kind === 'area');
      if (hit) {
        snapshot();
        t.pts.splice(hit.i + 1, 0, hit.p);
        recomputeTakeoff(t);
        renderTakeoffs(); saveLocal();
        setMsg('Point added — drag it into place.');
        draw();
      }
    }
    return;
  }
  // dblclick fires after two click-adds; drop the duplicate vertex
  if ((state.tool === 'trace' || state.tool === 'boundary' || state.tool === 'pad' || state.tool === 'count') &&
      state.draft.length > 1)
    state.draft.pop();
  finishDraftIfAny(true);
});

async function handleClick(w) {
  if (!state.pdf && state.tool !== 'pan') { setMsg('Open a PDF first.'); return; }

  switch (state.tool) {
    case 'calibrate': {
      state.calibPts.push(w);
      if (state.calibPts.length === 2) {
        const [a, b] = state.calibPts;
        const px = dist(a.x, a.y, b.x, b.y);
        if (px < 2) { state.calibPts = []; break; }
        const feet = await askNumber('Real-world distance',
          'Enter the actual distance between the two points, in feet.', '', null);
        if (feet && feet > 0) {
          snapshot();
          state.calibration = { ax: a.x, ay: a.y, bx: b.x, by: b.y, feet, ftPerPx: feet / px };
          state.result = null;
          els.resultsSection.classList.add('hidden');
          refreshStatuses();
          updateAlignStatus();
          setMsg(`Scale set: 1 px = ${state.calibration.ftPerPx.toFixed(4)} ft. Now draw the ▱ Boundary.`);
          saveLocal();
          setTool('boundary');
        }
        state.calibPts = [];
      }
      break;
    }
    case 'trace':
      addDraftPoint(w);
      break;
    case 'wall':
      addDraftPoint(w);
      break;
    case 'area':
      addDraftPoint(w);
      break;
    case 'line':
      addDraftPoint(w);
      break;
    case 'count':
      addDraftPoint(w);
      setMsg(`${state.draft.length} dropped — keep clicking items, Enter/double-click to finish.`);
      break;
    case 'measure': {
      if (!state.calibration) { setMsg('Calibrate the scale (📏) first.'); break; }
      if (state.measurePts.length >= 2) state.measurePts = []; // start a fresh measurement
      state.measurePts.push(w);
      if (state.measurePts.length === 2) {
        const [a, b] = state.measurePts;
        const ft = dist(a.x, a.y, b.x, b.y) * state.calibration.ftPerPx;
        $('measureOut').textContent = `${fmt(ft, 1)} ft`;
        setMsg(`Distance: ${fmt(ft, 1)} ft. Click two new points to measure again.`);
      } else setMsg('Click the second point.');
      break;
    }
    case 'realign': {
      state.realignPts.push(w);
      const pairs = Math.floor(state.realignPts.length / 2);
      setMsg(state.realignPts.length % 2
        ? 'Now click that SAME spot on the updated drawing.'
        : `${pairs} landmark pair${pairs > 1 ? 's' : ''} set. Press Enter to apply` +
          `${pairs === 1 ? ' (shift)' : ' (shift + rotation/scale)'}, or add another pair.`);
      break;
    }
    case 'pad':
      // clicks on an existing pad edit it rather than starting a new one
      if (!state.draft.length && nearestPadEdge(w, 10 / state.view.zoom)) {
        setMsg('Double-click the pad edge to add a point · drag a point (○) to move it · Alt+click removes it. Click away from pads to draw a new one.');
        break;
      }
      addDraftPoint(w);
      break;
    case 'boundary':
      // clicks on the existing polygon edit it rather than starting a redraw
      if (!state.draft.length && state.boundary.length >= 3 &&
          nearestBoundaryEdge(w, 10 / state.view.zoom)) {
        setMsg('Double-click the edge to add a point · drag a point (○) to move it · Alt+click a point removes it. Click away from the boundary to redraw it.');
        break;
      }
      addDraftPoint(w);
      break;
    case 'wand':
      await wandPick(w);
      break;
    case 'spot': {
      const elev = await promptElevation();
      if (elev !== null) {
        snapshot();
        state.contours[state.sheet].push({ pts: [w], elev, spot: true });
        afterContourAdded(elev);
      }
      break;
    }
    case 'select': {
      const hit = hitTest(w);
      if (hit) { state.selected = hit; state.selTake = null; }
      else { state.selTake = hitTakeoff(w); state.selected = null; }
      refreshContourList();
      renderTakeoffs();
      break;
    }
    case 'align': {
      if (state.alignPts.length === state.alignQs.length) {
        // a landmark on the existing sheet
        if (state.sheet !== 'existing') break;
        state.alignPts.push(w);
        switchSheet('proposed');
        setMsg('Now click that SAME landmark on the Proposed sheet (green cross marks the spot).');
      } else {
        // its match on the proposed sheet — store as raw image coords
        if (state.sheet !== 'proposed') break;
        state.alignQs.push(alignInvert(state.align, w));
        if (state.alignQs.length === 1) {
          // pair 1: shift only (resets any previous rotation)
          const p = state.alignPts[0], q = state.alignQs[0];
          snapshot();
          state.align = { a: 1, b: 0, e: p.x - q.x, f: p.y - q.y };
          updateAlignStatus();
          saveLocal();
          switchSheet('existing');
          setMsg('Shift applied. Press Enter to finish, or click a SECOND landmark (far from the first) to also fix rotation.');
        } else {
          // pair 2: solve shift + rotation + scale from the two pairs
          const [p1, p2] = state.alignPts, [q1, q2] = state.alignQs;
          const dqx = q2.x - q1.x, dqy = q2.y - q1.y;
          const dpx = p2.x - p1.x, dpy = p2.y - p1.y;
          const len2 = dqx * dqx + dqy * dqy;
          if (Math.sqrt(len2) < 20) {
            state.alignPts.pop(); state.alignQs.pop();
            switchSheet('existing');
            setMsg('Those landmarks are too close together — click a second landmark farther from the first.');
            break;
          }
          const a = (dqx * dpx + dqy * dpy) / len2;
          const b = (dqx * dpy - dqy * dpx) / len2;
          snapshot();
          state.align = {
            a, b,
            e: p1.x - (a * q1.x - b * q1.y),
            f: p1.y - (b * q1.x + a * q1.y),
          };
          state.alignPts = []; state.alignQs = [];
          updateAlignStatus();
          saveLocal();
          setMsg('Sheets aligned (shift + rotation). Turn on Ghost to double-check the fit.');
          setTool('pan');
        }
      }
      break;
    }
  }
  draw();
}

function hitTest(w) {
  const thresh = 8 / state.view.zoom;
  let best = null, bestD = thresh;
  state.contours[state.sheet].forEach((c, i) => {
    let d = distToPolyline(w.x, w.y, c.pad ? c.pts.concat([c.pts[0]]) : c.pts);
    if (c.pad && pointInPolygon(w.x, w.y, c.pts)) d = Math.min(d, thresh * 0.6);
    if (d < bestD) { bestD = d; best = { sheet: state.sheet, index: i }; }
  });
  return best;
}

// ── Editing completed takeoffs (areas / lines) ────────────────────────────────
// Recompute an area's SF/volume or a line's length after its points move.
function recomputeTakeoff(t) {
  if (!state.calibration) return;
  if (t.kind === 'area') {
    const areaSf = polygonAreaFt2(t.pts, state.calibration.ftPerPx);
    const perimFt = polygonPerimeterFt(t.pts, state.calibration.ftPerPx);
    t.result = computeAreaResult(areaSf, t.cfg, perimFt);
  } else if (t.kind === 'line') {
    t.result = computeLineResult(polyLengthFt(t.pts), t.cfg);
  }
}

// Which takeoff is under the cursor? Topmost area fill wins; else nearest edge /
// line / count point within a small threshold. Returns an index or null.
function hitTakeoff(w) {
  for (let i = state.takeoffs.length - 1; i >= 0; i--) {
    const t = state.takeoffs[i];
    if (t.kind === 'area' && t.pts.length >= 3 && pointInPolygon(w.x, w.y, t.pts)) return i;
  }
  const thresh = 8 / state.view.zoom;
  let best = null, bestD = thresh;
  for (let i = state.takeoffs.length - 1; i >= 0; i--) {
    const t = state.takeoffs[i];
    if (!t.pts || !t.pts.length) continue;
    let d = Infinity;
    if (t.kind === 'area') d = distToPolyline(w.x, w.y, t.pts.concat([t.pts[0]]));
    else if (t.kind === 'line') d = distToPolyline(w.x, w.y, t.pts);
    else if (t.kind === 'count') for (const p of t.pts) d = Math.min(d, dist(w.x, w.y, p.x, p.y));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Nearest point on a takeoff's edges (for double-click insert). closed = area.
function nearestTakeoffEdge(pts, w, thresh, closed) {
  const n = closed ? pts.length : pts.length - 1;
  let best = null, bd = thresh;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    let tt = len2 ? ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2 : 0;
    tt = Math.max(0, Math.min(1, tt));
    const px = a.x + tt * dx, py = a.y + tt * dy, d = dist(w.x, w.y, px, py);
    if (d < bd) { bd = d; best = { i, p: { x: px, y: py } }; }
  }
  return best;
}

// ── Copy / paste a selected shape ─────────────────────────────────────────────
const cloneDeep = o => JSON.parse(JSON.stringify(o));

function copySelection() {
  if (state.selTake != null && state.takeoffs[state.selTake]) {
    state.clipboard = { type: 'takeoff', data: cloneDeep(state.takeoffs[state.selTake]) };
    setMsg('Copied. Ctrl+V pastes a copy next to it.');
  } else if (state.selected) {
    const c = state.contours[state.selected.sheet][state.selected.index];
    if (c) { state.clipboard = { type: 'contour', data: cloneDeep(c) }; setMsg('Copied. Ctrl+V pastes a copy next to it.'); }
  } else setMsg('Select a shape first (➤ Select), then Ctrl+C to copy.');
}

function pasteClipboard() {
  if (!state.clipboard) { setMsg('Nothing copied yet — select a shape and press Ctrl+C.'); return; }
  snapshot();
  const off = 24 / state.view.zoom; // offset so the pasted copy is visibly separate
  const clone = cloneDeep(state.clipboard.data);
  clone.pts.forEach(p => { p.x += off; p.y += off; });
  if (state.tool !== 'select') setTool('select');
  if (state.clipboard.type === 'takeoff') {
    clone.id = randId();
    state.takeoffs.push(clone);
    state.selTake = state.takeoffs.length - 1;
    state.selected = null;
    renderTakeoffs();
  } else {
    state.contours[state.sheet].push(clone); // paste onto the active sheet
    state.selected = { sheet: state.sheet, index: state.contours[state.sheet].length - 1 };
    state.selTake = null;
    state.result = null; // new contour geometry invalidates the last cut/fill
    els.resultsSection.classList.add('hidden');
    refreshContourList();
  }
  saveLocal();
  draw();
  setMsg('Pasted a copy — drag its body to reposition, or its points to reshape.');
}

// Re-open the material / line config for the selected takeoff (E key).
async function editSelectedTakeoff() {
  const t = state.takeoffs[state.selTake];
  if (!t || !state.calibration) return;
  if (t.kind === 'area') {
    const areaSf = polygonAreaFt2(t.pts, state.calibration.ftPerPx);
    const perimFt = polygonPerimeterFt(t.pts, state.calibration.ftPerPx);
    const cfg = await askAreaConfig(areaSf, perimFt, t.cfg);
    if (cfg) { snapshot(); t.cfg = cfg; t.result = computeAreaResult(areaSf, cfg, perimFt); renderTakeoffs(); saveLocal(); draw(); }
  } else if (t.kind === 'line') {
    const lengthFt = polyLengthFt(t.pts);
    const cfg = await askLineConfig(lengthFt, t.cfg);
    if (cfg) { snapshot(); t.cfg = cfg; t.result = computeLineResult(lengthFt, cfg); renderTakeoffs(); saveLocal(); draw(); }
  }
}

async function promptElevation(prefillOverride) {
  const s = state.sheet;
  const last = state.lastElev[s], prev = state.prevElev[s];
  const interval = parseFloat(els.inpInterval.value) || 1;
  let prefill = '', hint = 'Contour elevation in feet. Pre-filled with the next value in the run — just hit Enter if it\'s right.';
  if (last !== null) {
    const step = (prev !== null && Math.abs(last - prev) <= interval * 4 && last !== prev)
      ? Math.sign(last - prev) * interval : interval;
    prefill = +(last + step).toFixed(2);
  }
  if (prefillOverride != null) {
    prefill = prefillOverride;
    hint = 'Pre-filled from the printed label nearest your click — double-check it against the drawing.';
  }
  return askNumber(
    `${s === 'existing' ? 'Existing' : 'Proposed'} elevation`,
    hint, prefill, interval);
}

function afterContourAdded(elev) {
  const s = state.sheet;
  state.prevElev[s] = state.lastElev[s];
  state.lastElev[s] = elev;
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshContourList();
  saveLocal();
}

function boundaryEdited(msg) {
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshStatuses();
  saveLocal();
  setMsg(msg);
}

function padEdited(msg) {
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshContourList();
  saveLocal();
  setMsg(msg);
}

// closest point on any pad's edge (current sheet) within thresh, or null
function nearestPadEdge(w, thresh) {
  let best = null, bd = thresh;
  state.contours[state.sheet].forEach((c, ci) => {
    if (!c.pad) return;
    const P = c.pts;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      const d = dist(w.x, w.y, px, py);
      if (d < bd) { bd = d; best = { ci, i, p: { x: px, y: py } }; }
    }
  });
  return best;
}

// closest point on a contour's edges within thresh, or null (open trace vs closed pad)
function nearestContourEdge(c, w, thresh) {
  const P = c.pts, n = c.pad ? P.length : P.length - 1;
  let best = null, bd = thresh;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d = dist(w.x, w.y, px, py);
    if (d < bd) { bd = d; best = { i, p: { x: px, y: py } }; }
  }
  return best;
}

// closest point on the closed boundary within thresh, or null
function nearestBoundaryEdge(w, thresh) {
  const B = state.boundary;
  let best = null, bd = thresh;
  for (let i = 0; i < B.length; i++) {
    const a = B[i], b = B[(i + 1) % B.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d = dist(w.x, w.y, px, py);
    if (d < bd) { bd = d; best = { i, p: { x: px, y: py } }; }
  }
  return best;
}

const SMOOTHABLE_TOOLS = ['trace', 'area', 'line', 'boundary', 'pad'];
const CLOSED_TOOLS = ['area', 'boundary', 'pad'];

async function finishDraftIfAny(commit) {
  draftRedo.length = 0;  // finishing or abandoning a shape ends its draft-redo chain
  if (!state.draft.length) { return; }
  let pts = state.draft;
  state.draft = [];
  updateUndoButtons(); // draft consumed; commit branches push the single shape snapshot

  if (!commit) { draw(); return; }

  // Curve mode: replace the clicked knots with a smooth spline through them.
  if (state.smooth && SMOOTHABLE_TOOLS.includes(state.tool) && pts.length >= 3)
    pts = catmullRomSpline(pts, CLOSED_TOOLS.includes(state.tool));

  if (state.tool === 'boundary') {
    if (pts.length >= 3) {
      snapshot();
      state.boundary = pts;
      refreshStatuses();
      setMsg('Boundary set. Now trace the Existing contours (〰).');
      saveLocal();
    } else setMsg('A boundary needs at least 3 points.');
  } else if (state.tool === 'trace') {
    if (pts.length >= 2) {
      const elev = await promptElevation();
      if (elev !== null) {
        snapshot();
        state.contours[state.sheet].push({ pts, elev, spot: false });
        afterContourAdded(elev);
        setMsg(`Contour ${elev} recorded (${pts.length} pts). Keep going — click the next line.`);
      }
    } else setMsg('A contour needs at least 2 points.');
  } else if (state.tool === 'pad') {
    if (pts.length >= 3) {
      const elev = await askNumber('Pad elevation',
        'The flat elevation held across the whole pad, in feet. Tip: earthwork is usually ' +
        'graded to the pad/subgrade elevation — often FF minus slab and base thickness — ' +
        'not the finished floor itself.', '', parseFloat(els.inpInterval.value) || 1);
      if (elev !== null) {
        snapshot();
        state.contours[state.sheet].push({ pts, elev, spot: false, pad: true });
        afterContourAdded(elev);
        setMsg(`Flat pad at ${elev} recorded.`);
      }
    } else setMsg('A pad needs at least 3 points.');
  } else if (state.tool === 'wall') {
    if (pts.length >= 2) {
      if (!state.calibration) { setMsg('Calibrate the scale (📏) before measuring a wall dig.'); draw(); return; }
      const cfg = await askWallSection(polyLengthFt(pts), {
        canSubgrade: state.contours.existing.length > 0,
        canProposed: state.contours.existing.length > 0 && state.contours.proposed.length > 0,
      });
      if (cfg) {
        const result = computeWallSweep(pts, cfg);
        if (result) {
          snapshot();
          state.walls.push({ id: randId(), pts, cfg, result });
          renderWalls();
          saveLocal();
          let m = `Wall dig: ${fmt(result.netCY)} CY export (${fmt(result.truckCY)} CY loose).`;
          if (result.noGradeFrac > 0.05) m += ' Some stations had no Existing contour nearby — depth taken as 0 there.';
          setMsg(m);
        }
      }
    } else setMsg('A wall dig needs at least 2 points along its line.');
  } else if (state.tool === 'area') {
    if (pts.length >= 3) {
      if (!state.calibration) { setMsg('Calibrate the scale (📏) before an area takeoff.'); draw(); return; }
      const areaSf = polygonAreaFt2(pts, state.calibration.ftPerPx);
      const perimFt = polygonPerimeterFt(pts, state.calibration.ftPerPx);
      const cfg = await askAreaConfig(areaSf, perimFt);
      if (cfg) {
        snapshot();
        const result = computeAreaResult(areaSf, cfg, perimFt);
        state.takeoffs.push({ id: randId(), kind: 'area', pts, cfg, result });
        renderTakeoffs();
        saveLocal();
        setMsg(`Area takeoff: ${fmt(result.quantity, result.unit === 'tons' ? 1 : 0)} ${result.unit} — ${cfg.label}.`);
      }
    } else setMsg('An area needs at least 3 points.');
  } else if (state.tool === 'line') {
    if (pts.length >= 2) {
      if (!state.calibration) { setMsg('Calibrate the scale (📏) before a linear takeoff.'); draw(); return; }
      const lengthFt = polyLengthFt(pts);
      const cfg = await askLineConfig(lengthFt);
      if (cfg) {
        snapshot();
        const result = computeLineResult(lengthFt, cfg);
        state.takeoffs.push({ id: randId(), kind: 'line', pts, cfg, result });
        renderTakeoffs();
        saveLocal();
        const q = result.trench ? `${fmt(result.trenchCY, 1)} CY trench` : `${fmt(result.lengthFt)} ft`;
        setMsg(`Linear takeoff: ${q} — ${cfg.label}.`);
      }
    } else setMsg('A line needs at least 2 points.');
  } else if (state.tool === 'count') {
    // no calibration needed — counting is scale-independent
    if (pts.length >= 1) {
      const cfg = await askCountConfig(pts.length);
      if (cfg) {
        snapshot();
        const result = { count: pts.length, label: cfg.label, unit: cfg.unit };
        state.takeoffs.push({ id: randId(), kind: 'count', pts, cfg, result });
        renderTakeoffs();
        saveLocal();
        setMsg(`Count takeoff: ${result.count} ${result.unit} — ${cfg.label}.`);
      }
    } else setMsg('A count needs at least one point.');
  }
  draw();
}

/* ============================== Undo ============================== */

const undoStack = [];
const redoStack = [];
const draftRedo = [];   // points undone mid-draw, so redo can re-add them within the same shape
let pendingSnap = null; // pre-drag state, pushed only if the drag actually moved

function takeSnap() {
  return JSON.stringify({
    calibration: state.calibration,
    align: state.align,
    boundary: state.boundary,
    contours: state.contours,
    walls: state.walls,
    takeoffs: state.takeoffs,
    lastElev: state.lastElev,
    prevElev: state.prevElev,
  });
}

function updateUndoButtons() {
  els.btnUndo.disabled = !(state.draft.length || undoStack.length);
  els.btnRedo.disabled = !(draftRedo.length || (redoStack.length && !state.draft.length));
}

// a point placed while drawing is undoable (Ctrl+Z / Undo / Backspace) but never
// enters the geometry undo stack — so finishing the shape leaves exactly one undo
function addDraftPoint(w) {
  draftRedo.length = 0;   // a fresh point invalidates the draft-redo chain
  state.draft.push(w);
  updateUndoButtons();
}

function pushSnap(s) {
  undoStack.push(s);
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function snapshot() { pushSnap(takeSnap()); }

function restoreSnap(s) {
  s = JSON.parse(s);
  state.calibration = s.calibration;
  state.align = s.align || alignIdentity();
  state.boundary = s.boundary || [];
  state.contours = s.contours || { existing: [], proposed: [] };
  state.walls = s.walls || [];
  state.takeoffs = s.takeoffs || [];
  state.lastElev = s.lastElev || { existing: null, proposed: null };
  state.prevElev = s.prevElev || { existing: null, proposed: null };
  state.selected = null;
  state.draft = []; state.calibPts = [];
  state.alignPts = []; state.alignQs = [];
  state.wandPts = null;
  state.dragDraft = null;
  state.dragSel = null;
  state.realignPts = [];
  state.boxA = state.boxB = null;
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshStatuses();
  refreshContourList();
  renderWalls();
  renderTakeoffs();
  updateAlignStatus();
  saveLocal();
  draw();
}

function undo() {
  if (state.draft.length) {                 // undo point-by-point while still drawing
    draftRedo.push(state.draft.pop());
    updateUndoButtons();
    setMsg(state.draft.length ? `Point removed — ${state.draft.length} placed.` : 'Points cleared.');
    draw();
    return;
  }
  draftRedo.length = 0;                      // undoing committed history ends the draft-redo chain
  if (!undoStack.length) return;
  redoStack.push(takeSnap());
  if (redoStack.length > 50) redoStack.shift();
  restoreSnap(undoStack.pop());
  updateUndoButtons();
  setMsg(`Undone.${undoStack.length ? ` ${undoStack.length} more step${undoStack.length === 1 ? '' : 's'} available.` : ''}`);
}

function redo() {
  if (draftRedo.length) {                    // re-add a point undone while drawing
    state.draft.push(draftRedo.pop());
    updateUndoButtons();
    setMsg(`Point restored — ${state.draft.length} placed.`);
    draw();
    return;
  }
  if (state.draft.length) return;           // drafting but nothing to redo → don't clobber the draft
  if (!redoStack.length) return;
  undoStack.push(takeSnap());
  if (undoStack.length > 50) undoStack.shift();
  restoreSnap(redoStack.pop());
  updateUndoButtons();
  setMsg(`Redone.${redoStack.length ? ` ${redoStack.length} more step${redoStack.length === 1 ? '' : 's'} available.` : ''}`);
}

els.btnUndo.addEventListener('click', undo);
els.btnRedo.addEventListener('click', redo);

/* ============================== Vector wand (auto trace) ============================== */

const pathCache = {}; // pageNum -> { polys, labels } in image/world px
const hatchCapCache = {}; // pageNum -> { hatch, reason, stats } from detectHatchCap

function matMul(A, B) { // compose: apply B, then A
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
const matApply = (M, x, y) => ({ x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] });

function flattenCubic(p0, c1, c2, p3, out) {
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
    });
  }
}

// Extract every stroked vector path on a page, in rendered-image pixels.
async function buildPathIndex(pageNum) {
  if (pathCache[pageNum]) return pathCache[pageNum];
  const page = await state.pdf.getPage(pageNum);
  const vp = page.getViewport({ scale: state.renderScale });
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const F = opList.fnArray, A = opList.argsArray;

  const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke,
    OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const polys = [];
  let M = vp.transform.slice();
  const stack = [];

  const finishPoly = (pts) => {
    if (pts.length < 2) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    polys.push({ pts, x0, y0, x1, y1 });
  };

  for (let i = 0; i < F.length; i++) {
    const fn = F[i];
    if (fn === OPS.save) stack.push(M.slice());
    else if (fn === OPS.restore) { if (stack.length) M = stack.pop(); }
    else if (fn === OPS.transform) M = matMul(M, A[i]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(M.slice());
      if (A[i] && A[i][0]) M = matMul(M, A[i][0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      if (stack.length) M = stack.pop();
    } else if (fn === OPS.constructPath) {
      if (!STROKES.has(F[i + 1])) continue; // fills (hatches, blobs) aren't contours
      const [subOps, co] = A[i];
      let k = 0, cur = [], start = null;
      const raw = (x, y) => matApply(M, x, y);
      for (const op of subOps) {
        if (op === OPS.moveTo) {
          finishPoly(cur);
          start = raw(co[k], co[k + 1]); k += 2;
          cur = [start];
        } else if (op === OPS.lineTo) {
          cur.push(raw(co[k], co[k + 1])); k += 2;
        } else if (op === OPS.curveTo) {
          const c1 = raw(co[k], co[k + 1]), c2 = raw(co[k + 2], co[k + 3]), p3 = raw(co[k + 4], co[k + 5]);
          k += 6;
          if (cur.length) flattenCubic(cur[cur.length - 1], c1, c2, p3, cur);
        } else if (op === OPS.curveTo2) {
          const c2 = raw(co[k], co[k + 1]), p3 = raw(co[k + 2], co[k + 3]);
          k += 4;
          if (cur.length) flattenCubic(cur[cur.length - 1], cur[cur.length - 1], c2, p3, cur);
        } else if (op === OPS.curveTo3) {
          const c1 = raw(co[k], co[k + 1]), p3 = raw(co[k + 2], co[k + 3]);
          k += 4;
          if (cur.length) flattenCubic(cur[cur.length - 1], c1, p3, p3, cur);
        } else if (op === OPS.closePath) {
          if (start && cur.length) cur.push({ x: start.x, y: start.y });
        } else if (op === OPS.rectangle) {
          finishPoly(cur); cur = [];
          const [x, y, w2, h2] = [co[k], co[k + 1], co[k + 2], co[k + 3]]; k += 4;
          finishPoly([raw(x, y), raw(x + w2, y), raw(x + w2, y + h2), raw(x, y + h2), raw(x, y)]);
        }
      }
      finishPoly(cur);
    }
  }

  // numeric text labels (for elevation prefill)
  const labels = [];
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = it.str.trim();
      if (/^\d{2,4}(?:\.\d{1,2})?$/.test(s)) {
        const T = matMul(vp.transform, it.transform);
        labels.push({ x: T[4], y: T[5], val: parseFloat(s) });
      }
    }
  } catch (_) { /* labels are a nicety only */ }

  const res = { polys, labels };
  pathCache[pageNum] = res;
  return res;
}

// ── Vector-hatch capability probe ──────────────────────────────────────────────
// Phase 1 of the "auto-select an area by its hatch" idea: a cheap detector that
// classifies the active page so the UI only offers auto-select when it can work.
// Reads the same operator list Auto Trace uses. A hatched fill (asphalt //,
// gravel xx…) shows up as MANY short line segments clustered at one or two
// angles; a scan shows up as a big image with almost no vector paths. Thresholds
// are heuristic — the numbers are surfaced in the button tooltip so they can be
// tuned against real plans.
async function detectHatchCap(pageNum) {
  if (hatchCapCache[pageNum]) return hatchCapCache[pageNum];
  const OPS = pdfjsLib.OPS;
  let result;
  try {
    const page = await state.pdf.getPage(pageNum);
    const vp = page.getViewport({ scale: state.renderScale });
    const opList = await page.getOperatorList();
    const F = opList.fnArray, A = opList.argsArray;
    const pageArea = vp.width * vp.height || 1;
    const shortMax = Math.hypot(vp.width, vp.height) * 0.02; // "hatch-line short" ≈ 2% of diagonal

    const IMG = new Set([OPS.paintImageXObject, OPS.paintJpegXObject,
      OPS.paintImageMaskXObject, OPS.paintInlineImageXObject].filter(v => v != null));
    const BINS = 36; // 5° bins over 0..180
    const hist = new Float64Array(BINS);
    let shortSegs = 0, imageArea = 0, pathOps = 0;

    let M = vp.transform.slice();
    const stack = [];
    for (let i = 0; i < F.length; i++) {
      const fn = F[i];
      if (fn === OPS.save) stack.push(M.slice());
      else if (fn === OPS.restore) { if (stack.length) M = stack.pop(); }
      else if (fn === OPS.transform) M = matMul(M, A[i]);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(M.slice()); if (A[i] && A[i][0]) M = matMul(M, A[i][0]); }
      else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) M = stack.pop(); }
      else if (IMG.has(fn)) {
        const o = matApply(M, 0, 0), ux = matApply(M, 1, 0), uy = matApply(M, 0, 1);
        imageArea += Math.hypot(ux.x - o.x, ux.y - o.y) * Math.hypot(uy.x - o.x, uy.y - o.y);
      } else if (fn === OPS.constructPath) {
        pathOps++;
        const [subOps, co] = A[i];
        let k = 0, cur = null;
        for (const op of subOps) {
          if (op === OPS.moveTo) { cur = matApply(M, co[k], co[k + 1]); k += 2; }
          else if (op === OPS.lineTo) {
            const p = matApply(M, co[k], co[k + 1]); k += 2;
            if (cur) {
              const dx = p.x - cur.x, dy = p.y - cur.y, len = Math.hypot(dx, dy);
              if (len > 0.5 && len <= shortMax) {
                shortSegs++;
                let ang = Math.atan2(dy, dx) * 180 / Math.PI;
                ang = ((ang % 180) + 180) % 180; // undirected: 0..180
                hist[Math.min(BINS - 1, (ang / (180 / BINS)) | 0)]++;
              }
              cur = p;
            }
          } else if (op === OPS.curveTo) { cur = matApply(M, co[k + 4], co[k + 5]); k += 6; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = matApply(M, co[k + 2], co[k + 3]); k += 4; }
          else if (op === OPS.rectangle) { k += 4; cur = null; }
        }
      }
    }

    // Concentration = share of short segments in the two busiest angle bins.
    let top1 = 0, top1i = -1, top2 = 0;
    for (let b = 0; b < BINS; b++) if (hist[b] > top1) { top1 = hist[b]; top1i = b; }
    for (let b = 0; b < BINS; b++) if (b !== top1i && hist[b] > top2) top2 = hist[b];
    const concentration = shortSegs ? (top1 + top2) / shortSegs : 0;
    const dominantDeg = top1i >= 0 ? Math.round((top1i + 0.5) * (180 / BINS)) : null;
    const imageCover = imageArea / pageArea;

    const isRaster = imageCover > 0.5 && pathOps < 60;
    const isHatch = !isRaster && shortSegs >= 150 && concentration >= 0.45;
    result = {
      hatch: isHatch,
      reason: isRaster ? 'raster' : (isHatch ? 'hatch' : 'no-hatch'),
      stats: { shortSegs, concentration: +concentration.toFixed(2), dominantDeg,
        imageCover: +imageCover.toFixed(2), pathOps },
    };
  } catch (e) {
    result = { hatch: false, reason: 'error', stats: {} };
  }
  hatchCapCache[pageNum] = result;
  return result;
}

function reasonHint(reason) {
  if (reason === 'raster') return 'This sheet looks like a scan / raster image — no vector hatches to auto-select. Trace areas with ▦ Area.';
  if (reason === 'no-hatch') return 'No vector hatch pattern detected on this sheet. Trace areas with ▦ Area.';
  if (reason === 'error') return 'Could not read this sheet’s vectors. Trace areas with ▦ Area.';
  return 'Open a PDF to check for vector hatching.';
}

function renderHatchCapUI() {
  const cap = state.caps || { hatch: false, reason: 'no-pdf', stats: {} };
  const s = cap.stats || {};
  const okTitle = `Vector hatching detected${s.dominantDeg != null ? ` (~${s.dominantDeg}°, ${fmt(s.shortSegs)} pattern segments)` : ''}. ` +
    'One-click area select by ground type is coming soon (beta).';
  const btn = $('btnAutoArea');
  if (btn) { btn.disabled = !cap.hatch; btn.title = cap.hatch ? okTitle : reasonHint(cap.reason); }
  const pill = $('hatchCap');
  if (pill) {
    pill.classList.toggle('hidden', !cap.hatch);
    if (cap.hatch) { pill.textContent = 'hatch ✓'; pill.title = okTitle; }
  }
}

async function updateHatchCap() {
  if (!state.pdf) { state.caps = { hatch: false, reason: 'no-pdf', stats: {} }; renderHatchCapUI(); return; }
  const cap = await detectHatchCap(state.sheets[state.sheet].pageNum);
  state.caps = cap;
  renderHatchCapUI();
}

function autoAreaClick() {
  const cap = state.caps || { hatch: false };
  if (!cap.hatch) return; // the button is disabled in this state, but guard anyway
  const s = cap.stats || {};
  setMsg(`Auto Area (beta): vector hatching detected${s.dominantDeg != null ? ` at ~${s.dominantDeg}°` : ''} — ` +
    `${fmt(s.shortSegs)} pattern segments. One-click select by ground type is coming soon; for now trace it with ▦ Area.`);
}

// Grow a chain from the picked fragment: exact-touch joins freely; larger gaps
// (dashes, label breaks) only if the direction carries through.
function stitchChain(seed, polys) {
  const TOUCH = 3, BRIDGE = 18, ANG = Math.cos(35 * Math.PI / 180);
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
  const dot = (u, v) => u.x * v.x + u.y * v.y;
  const used = new Set([seed]);
  let chain = seed.pts.slice();

  const grow = (atEnd) => {
    for (;;) {
      if (chain.length > 20000) break;
      const tip = atEnd ? chain[chain.length - 1] : chain[0];
      const nb = atEnd ? chain[chain.length - 2] : chain[1];
      let pick = null, pickRev = false, pickD = BRIDGE;
      for (const poly of polys) {
        if (used.has(poly)) continue;
        if (tip.x < poly.x0 - BRIDGE || tip.x > poly.x1 + BRIDGE ||
            tip.y < poly.y0 - BRIDGE || tip.y > poly.y1 + BRIDGE) continue;
        const a = poly.pts[0], b = poly.pts[poly.pts.length - 1];
        const da = dist(tip.x, tip.y, a.x, a.y), db = dist(tip.x, tip.y, b.x, b.y);
        const rev = db < da, d = rev ? db : da;
        if (d >= pickD) continue;
        if (d > TOUCH) {
          const first = rev ? b : a;
          const second = (rev ? poly.pts[poly.pts.length - 2] : poly.pts[1]) || first;
          const dirTip = unit(tip.x - nb.x, tip.y - nb.y);
          const dirGap = unit(first.x - tip.x, first.y - tip.y);
          const dirNew = unit(second.x - first.x, second.y - first.y);
          if (dot(dirTip, dirGap) < ANG || dot(dirGap, dirNew) < ANG) continue;
        }
        pick = poly; pickRev = rev; pickD = d;
      }
      if (!pick) break;
      used.add(pick);
      const pts = pickRev ? pick.pts.slice().reverse() : pick.pts.slice();
      if (atEnd) chain = chain.concat(pts);
      else chain = pts.reverse().concat(chain);
    }
  };
  grow(true);
  grow(false);
  return chain;
}

// Douglas–Peucker
function simplifyPts(pts, eps) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = 0, mi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointSegDist(pts[i].x, pts[i].y, pts[i0].x, pts[i0].y, pts[i1].x, pts[i1].y);
      if (d > maxD) { maxD = d; mi = i; }
    }
    if (maxD > eps) { keep[mi] = 1; stack.push([i0, mi], [mi, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Trim a wand-traced line to the boundary plus a margin (contours just outside
// still support the surface near the edge). Keeps the piece nearest the click.
function clipToBoundary(pts, clickW) {
  if (state.boundary.length < 3 || pts.length < 2) return pts;
  const closed = state.boundary.concat([state.boundary[0]]);
  const margin = state.calibration
    ? Math.max(60, 20 / state.calibration.ftPerPx)   // ~20 ft outside the line
    : 100;
  const keep = p => pointInPolygon(p.x, p.y, state.boundary) ||
                    distToPolyline(p.x, p.y, closed) < margin;

  // subdivide long segments so in/out crossings aren't missed
  const dense = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.min(200, Math.max(1, Math.ceil(dist(a.x, a.y, b.x, b.y) / 25)));
    for (let k = 1; k <= n; k++)
      dense.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }

  // contiguous kept runs; the line may cross the boundary more than once
  const runs = [];
  let run = null;
  for (const p of dense) {
    if (keep(p)) { if (!run) { run = []; runs.push(run); } run.push(p); }
    else run = null;
  }
  let best = null, bestD = Infinity;
  for (const r of runs) {
    if (r.length < 2) continue;
    const d = distToPolyline(clickW.x, clickW.y, r);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best || pts; // line entirely outside: leave it to the user
}

// Remove the portions of this sheet's traced lines inside the box; the parts
// outside survive (a line crossing the box is split into separate pieces).
function eraseInBox(x0, y0, x1, y1) {
  const inside = p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  // with a selection, the box only trims that one line
  const selIdx = state.selected && state.selected.sheet === state.sheet
    ? state.selected.index : null;
  const out = [];
  let touched = 0, removedWhole = 0, i = -1;

  for (const c of state.contours[state.sheet]) {
    i++;
    if (selIdx !== null && i !== selIdx) { out.push(c); continue; }
    if (c.pad) {
      // pads aren't split — removed only when the whole footprint is boxed
      if (c.pts.every(inside)) { touched++; removedWhole++; }
      else out.push(c);
      continue;
    }
    if (c.spot || c.pts.length === 1) {
      if (inside(c.pts[0])) { touched++; removedWhole++; }
      else out.push(c);
      continue;
    }
    // subdivide long segments so the cut lands at the box edge, not a far vertex
    const dense = [c.pts[0]];
    for (let i = 1; i < c.pts.length; i++) {
      const a = c.pts[i - 1], b = c.pts[i];
      const n = Math.min(200, Math.max(1, Math.ceil(dist(a.x, a.y, b.x, b.y) / 12)));
      for (let k = 1; k <= n; k++)
        dense.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
    }
    const runs = [];
    let run = null, hit = false;
    for (const p of dense) {
      if (inside(p)) { run = null; hit = true; }
      else { if (!run) { run = []; runs.push(run); } run.push(p); }
    }
    if (!hit) { out.push(c); continue; }
    touched++;
    let kept = 0;
    for (const r of runs) {
      if (r.length < 2) continue;
      out.push({ pts: simplifyPts(r, 1.5), elev: c.elev, spot: false });
      kept++;
    }
    if (!kept) removedWhole++;
  }

  if (!touched) {
    setMsg(selIdx !== null
      ? 'The selected line has nothing inside the box. (Deselect to erase from all lines.)'
      : 'Nothing inside the box to erase.');
    return;
  }
  snapshot();
  state.contours[state.sheet] = out;
  state.selected = null;
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshContourList();
  saveLocal();
  setMsg(`Erased inside the box${selIdx !== null ? ' (selected line only)' : ''}: ` +
    `${touched} line${touched > 1 ? 's' : ''} trimmed` +
    (removedWhole ? ` (${removedWhole} removed entirely)` : '') + '.');
}

async function wandPick(w) {
  const sheet = state.sheet;
  setMsg('Reading the page’s vector line work…');
  let idx;
  try {
    idx = await buildPathIndex(state.sheets[sheet].pageNum);
  } catch (err) {
    setMsg('Could not read vector paths from this page (scanned PDF?) — use 〰 Trace instead.');
    return;
  }
  if (!idx.polys.length) {
    setMsg('No vector line work on this page (scanned PDF?) — use 〰 Trace instead.');
    return;
  }

  // hit test in raw image coords (the proposed sheet may be align-transformed)
  const q = sheet === 'proposed' ? alignInvert(state.align, w) : w;
  const thresh = Math.max(3, 8 / state.view.zoom);
  let best = null, bestD = thresh;
  for (const poly of idx.polys) {
    if (q.x < poly.x0 - thresh || q.x > poly.x1 + thresh ||
        q.y < poly.y0 - thresh || q.y > poly.y1 + thresh) continue;
    const d = distToPolyline(q.x, q.y, poly.pts);
    if (d < bestD) { bestD = d; best = poly; }
  }
  if (!best) {
    setMsg('No line under the click — zoom in and click right on the contour.');
    return;
  }

  let pts = stitchChain(best, idx.polys);
  if (sheet === 'proposed') pts = pts.map(p => alignApply(state.align, p));
  pts = simplifyPts(clipToBoundary(pts, w), 2.5);
  if (pts.length < 2) { setMsg('That line is a single point — use ◎ Spot Elev for spot grades.'); return; }

  state.wandPts = pts;
  draw();

  // prefill from the nearest printed elevation label, else the usual increment
  let labelVal = null, labelD = 90;
  for (const L of idx.labels) {
    const d = dist(q.x, q.y, L.x, L.y);
    if (d < labelD) { labelD = d; labelVal = L.val; }
  }
  const elev = await promptElevation(labelVal);
  state.wandPts = null;
  if (elev !== null) {
    snapshot();
    state.contours[sheet].push({ pts, elev, spot: false });
    afterContourAdded(elev);
    setMsg(`Contour ${elev} picked up (${pts.length} pts). Click the next line.`);
  }
  draw();
}

window.addEventListener('keydown', e => {
  if (!els.projects.classList.contains('hidden')) {
    if (e.key === 'Escape') els.projects.classList.add('hidden');
    return;
  }
  if (!$('bidReport').classList.contains('hidden')) {
    if (e.key === 'Escape') closeBidReport();
    return; // bid report open: don't fire tool shortcuts underneath
  }
  if (!$('prodLog').classList.contains('hidden')) {
    if (e.key === 'Escape') closeProdLog();
    return; // production log open: don't fire tool shortcuts underneath
  }
  if (!els.modal.classList.contains('hidden') || !els.help.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  if (e.code === 'Space') { state.spaceHeld = true; e.preventDefault(); return; }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
    e.preventDefault();
    redo();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }

  switch (e.key) {
    case 'Enter':
      if (state.tool === 'realign') applyRealign();
      else if (state.tool === 'align' && state.alignQs.length === 1) {
        state.alignPts = []; state.alignQs = [];
        setTool('pan');
        setMsg('Alignment saved (shift only).');
      } else finishDraftIfAny(true);
      break;
    case 'Escape':
      state.draft = []; draftRedo.length = 0; state.calibPts = [];
      state.measurePts = [];
      state.boxA = state.boxB = null;
      if (state.selected) { state.selected = null; refreshContourList(); }
      if (state.selTake != null) { state.selTake = null; renderTakeoffs(); }
      state.dragTake = null;
      state.dragMove = null;
      if (state.tool === 'align' || state.tool === 'realign' || state.tool === 'measure') setTool('pan');
      else { state.alignPts = []; state.alignQs = []; }
      updateUndoButtons(); // draft may have been cleared
      draw(); break;
    case 'Backspace':
      if (state.draft.length) { undo(); e.preventDefault(); } // same as Ctrl+Z: drop the last point
      break;
    case 'Delete':
      deleteSelected(); break;
    case 'e': case 'E':
      if (state.selTake != null) editSelectedTakeoff(); else editSelectedElevation(); break;
    case 't': case 'T': setTool('trace'); break;
    case 'a': case 'A': setTool('wand'); break;
    case 'w': case 'W': setTool('wall'); break;
    case 'p': case 'P': setTool('pad'); break;
    case 'v': case 'V': setTool('select'); break;
    case 'b': case 'B': setTool('boundary'); break;
    case 'c': case 'C': if (!e.ctrlKey && !e.metaKey) setSmooth(!state.smooth); break;
    case 'ArrowUp':    panBy(0, -PAN_STEP); e.preventDefault(); break;
    case 'ArrowDown':  panBy(0,  PAN_STEP); e.preventDefault(); break;
    case 'ArrowLeft':  panBy(-PAN_STEP, 0); e.preventDefault(); break;
    case 'ArrowRight': panBy( PAN_STEP, 0); e.preventDefault(); break;
    case ' ': break;
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') state.spaceHeld = false;
});

function deleteSelected() {
  if (state.selTake != null) {
    snapshot();
    state.takeoffs.splice(state.selTake, 1);
    state.selTake = null;
    renderTakeoffs();
    saveLocal();
    draw();
    return;
  }
  if (!state.selected) return;
  snapshot();
  state.contours[state.selected.sheet].splice(state.selected.index, 1);
  state.selected = null;
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshContourList();
  saveLocal();
  draw();
}

async function editContourElevation(sheet, index) {
  const c = state.contours[sheet] && state.contours[sheet][index];
  if (!c) return;
  const elev = await askNumber('Edit elevation', '', c.elev,
    parseFloat(els.inpInterval.value) || 1);
  if (elev !== null && elev !== c.elev) {
    snapshot();
    c.elev = elev;
    state.result = null;
    els.resultsSection.classList.add('hidden'); // a changed elevation invalidates the last calc
    refreshContourList();
    saveLocal();
    draw();
  }
}

// The 'E' shortcut edits the currently-selected contour.
function editSelectedElevation() {
  if (!state.selected) return;
  editContourElevation(state.selected.sheet, state.selected.index);
}

/* ============================== Sidebar ============================== */

function refreshStatuses() {
  if (state.calibration) {
    els.scaleStatus.textContent =
      `1 px = ${state.calibration.ftPerPx.toFixed(4)} ft (${state.calibration.feet} ft reference)`;
    els.scaleStatus.className = 'status good';
  } else {
    els.scaleStatus.textContent = 'Not calibrated';
    els.scaleStatus.className = 'status bad';
  }
  if (state.boundary.length >= 3) {
    let txt = `${state.boundary.length}-point polygon`;
    if (state.calibration) {
      const ftPerPx = state.calibration.ftPerPx;
      const ac = polygonAreaFt2(state.boundary, ftPerPx) / 43560;
      const perim = polygonPerimeterFt(state.boundary, ftPerPx);
      txt += ` · ${ac.toFixed(2)} acres · ${fmt(perim)} ft perimeter`;
    }
    els.boundaryStatus.textContent = txt;
    els.boundaryStatus.className = 'status good';
  } else {
    els.boundaryStatus.textContent = 'Not drawn';
    els.boundaryStatus.className = 'status bad';
  }
}

function refreshContourList() {
  const s = state.sheet;
  els.contourTitle.textContent = s === 'existing' ? 'Existing' : 'Proposed';
  const list = state.contours[s];
  els.contourCount.textContent = list.length;
  els.contourList.innerHTML = '';

  const order = list.map((c, i) => ({ c, i })).sort((a, b) => b.c.elev - a.c.elev);
  for (const { c, i } of order) {
    const div = document.createElement('div');
    div.className = 'list-item' +
      (state.selected && state.selected.sheet === s && state.selected.index === i ? ' selected' : '');
    div.innerHTML = `
      <span class="swatch" style="background:${elevColor(c.elev, s)}"></span>
      <span class="lbl">${c.elev} ft ${c.spot ? '· spot' : c.pad ? '· flat pad' : `· ${c.pts.length} pts`}</span>
      <button class="edit" title="Edit elevation">✎</button>
      <button class="del" title="Delete">✕</button>`;
    div.addEventListener('click', e => {
      if (e.target.classList.contains('edit')) { editContourElevation(s, i); return; }
      if (e.target.classList.contains('del')) {
        snapshot();
        state.contours[s].splice(i, 1);
        state.selected = null;
        state.result = null;
        els.resultsSection.classList.add('hidden');
        refreshContourList(); saveLocal(); draw();
        return;
      }
      state.selected = { sheet: s, index: i };
      refreshContourList(); draw();
    });
    els.contourList.appendChild(div);
  }
}

$('btnClearSheet').addEventListener('click', async () => {
  const ok = await askModal({
    title: `Clear all ${state.sheet} traces?`,
    body: `<div class="hint">This deletes all ${state.contours[state.sheet].length} traced lines on the ${state.sheet} sheet. It cannot be undone.</div>`,
  });
  if (ok) {
    snapshot();
    state.contours[state.sheet] = [];
    state.selected = null;
    state.result = null;
    els.resultsSection.classList.add('hidden');
    refreshContourList(); saveLocal(); draw();
  }
});

els.chkGhost.addEventListener('change', e => { state.ghost = e.target.checked; draw(); });

// per-section "Show on drawing" toggles for the scale line, boundary, and contours
[['showScale', 'scale'], ['showBoundary', 'boundary'], ['showContours', 'contours']].forEach(([id, key]) => {
  $(id).addEventListener('change', e => { state.layers[key] = e.target.checked; draw(); });
});

els.btnEditDist.addEventListener('click', async () => {
  const c = state.calibration;
  if (!c) { setMsg('No scale yet — use the 📏 Scale tool first.'); return; }
  const feet = await askNumber('Real-world distance',
    'Distance between the two calibration points, in feet.', c.feet, null);
  if (feet && feet > 0) {
    snapshot();
    c.feet = feet;
    c.ftPerPx = feet / dist(c.ax, c.ay, c.bx, c.by);
    state.result = null;
    els.resultsSection.classList.add('hidden');
    refreshStatuses();
    updateAlignStatus();
    saveLocal();
    draw();
  }
});

els.btnAlign.addEventListener('click', () => {
  if (!state.pdf) { setMsg('Open a PDF first.'); return; }
  switchSheet('existing');
  setTool('align');
  setMsg('Click a sharp landmark on the Existing sheet — a property corner or title block corner works well.');
});

els.btnAlignReset.addEventListener('click', () => {
  if (!alignIsIdentity(state.align)) snapshot();
  state.align = alignIdentity();
  state.alignPts = [];
  state.alignQs = [];
  updateAlignStatus();
  saveLocal();
  draw();
});

function updateAlignStatus() {
  const M = state.align;
  if (alignIsIdentity(M)) {
    els.alignStatus.textContent = 'No offset applied (sheets assumed to overlay as-is).';
    return;
  }
  const px = Math.hypot(M.e, M.f);
  const ft = state.calibration ? ` (${(px * state.calibration.ftPerPx).toFixed(1)} ft)` : '';
  const rotDeg = Math.atan2(M.b, M.a) * 180 / Math.PI;
  const scale = Math.hypot(M.a, M.b);
  const parts = [`shifted ${px.toFixed(1)} px${ft}`];
  if (Math.abs(rotDeg) > 0.005) parts.push(`rotated ${rotDeg.toFixed(2)}°`);
  if (Math.abs(scale - 1) > 0.0005) parts.push(`scaled ×${scale.toFixed(4)}`);
  els.alignStatus.textContent = `Proposed sheet ${parts.join(', ')} to match Existing.`;
}
els.chkHeatmap.addEventListener('change', e => { state.showHeatmap = e.target.checked; draw(); });

/* ============================== Surface interpolation ============================== */
/* Classic linear-between-contours: elevation at a point = distance-weighted blend
   of the nearest contour and the nearest contour at a DIFFERENT elevation. */

function makeInterpolator(contours) {
  const n = contours.length;
  const dists = new Float64Array(n);
  const pads = contours.filter(c => c.pad);
  // a pad's outline behaves as a closed contour ring for the ground around it
  const rings = contours.map(c => c.pad ? c.pts.concat([c.pts[0]]) : c.pts);
  return function (px, py) {
    for (const p of pads)
      if (pointInPolygon(px, py, p.pts)) return p.elev; // flat inside the pad
    let d1 = Infinity, z1 = null;
    for (let i = 0; i < n; i++) {
      const d = distToPolyline(px, py, rings[i]);
      dists[i] = d;
      if (d < d1) { d1 = d; z1 = contours[i].elev; }
    }
    if (z1 === null) return null;
    let d2 = Infinity, z2 = null;
    for (let i = 0; i < n; i++) {
      if (contours[i].elev !== z1 && dists[i] < d2) { d2 = dists[i]; z2 = contours[i].elev; }
    }
    if (z2 === null || d1 === 0) return z1;
    return (z1 * d2 + z2 * d1) / (d1 + d2);
  };
}

/* ============================== Cut / fill ============================== */

$('btnCalc').addEventListener('click', calculate);

async function calculate() {
  const problems = [];
  if (!state.pdf) problems.push('open a PDF');
  if (!state.calibration) problems.push('calibrate the scale (📏)');
  if (state.boundary.length < 3) problems.push('draw the boundary (▱)');
  if (!state.contours.existing.length) problems.push('trace at least one Existing contour');
  if (!state.contours.proposed.length) problems.push('trace at least one Proposed contour');
  if (problems.length) {
    setMsg('Before calculating: ' + problems.join(', ') + '.');
    return;
  }

  const distinct = list => new Set(list.map(c => c.elev)).size;
  if (distinct(state.contours.existing) < 2)
    setMsg('Heads up: only one distinct Existing elevation — that surface will be flat.');
  if (distinct(state.contours.proposed) < 2 &&
      !state.contours.proposed.some(c => c.spot))
    setMsg('Heads up: only one distinct Proposed elevation — that surface will be flat.');

  const btn = $('btnCalc');
  btn.disabled = true;
  btn.textContent = 'Calculating…';

  try {
    const ftPerPx = state.calibration.ftPerPx;
    let gridFt = Math.max(0.5, parseFloat(els.inpGrid.value) || 5);
    let cellPx = gridFt / ftPerPx;

    const xs = state.boundary.map(p => p.x), ys = state.boundary.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);

    // cap grid size so the browser stays responsive
    const MAXCELLS = 60000;
    let cols = Math.ceil((x1 - x0) / cellPx), rows = Math.ceil((y1 - y0) / cellPx);
    if (cols * rows > MAXCELLS) {
      const f = Math.sqrt((cols * rows) / MAXCELLS);
      cellPx *= f; gridFt *= f;
      cols = Math.ceil((x1 - x0) / cellPx); rows = Math.ceil((y1 - y0) / cellPx);
      setMsg(`Large site — grid coarsened to ${gridFt.toFixed(1)} ft cells to stay fast.`);
    }

    const interpE = makeInterpolator(state.contours.existing);
    const interpP = makeInterpolator(state.contours.proposed);

    const dz = new Array(cols * rows).fill(null);
    const cellAreaFt2 = (cellPx * ftPerPx) ** 2;
    let cutFt3 = 0, fillFt3 = 0, cellsInside = 0, maxAbs = 0.01;

    // chunk by rows to keep the UI alive on big grids
    for (let r = 0; r < rows; r++) {
      const cy = y0 + (r + 0.5) * cellPx;
      for (let cI = 0; cI < cols; cI++) {
        const cx = x0 + (cI + 0.5) * cellPx;
        if (!pointInPolygon(cx, cy, state.boundary)) continue;
        const ze = interpE(cx, cy);
        const zp = interpP(cx, cy);
        if (ze === null || zp === null) continue;
        const d = zp - ze;           // + fill, − cut
        dz[r * cols + cI] = d;
        cellsInside++;
        if (d > 0) fillFt3 += d * cellAreaFt2;
        else cutFt3 += -d * cellAreaFt2;
        if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
      }
      if (r % 24 === 23) {
        setMsg(`Calculating… ${Math.round((r / rows) * 100)}%`);
        await new Promise(res => setTimeout(res, 0));
      }
    }

    const cutCY = cutFt3 / 27, fillCY = fillFt3 / 27;
    state.result = {
      cutCY, fillCY,
      areaFt2: cellsInside * cellAreaFt2,
      gridFt,
      grid: { x0, y0, cellPx, cols, rows, dz, maxAbs },
    };
    renderResults();
    collapseForResults(); // tuck away the inputs so the fresh numbers are front-and-center
    setMsg('Done. Adjust shrink/swell in Settings to refine the export number.');
  } finally {
    btn.disabled = false;
    btn.textContent = '∑ Calculate Cut/Fill';
  }
  draw();
}

// after a cut/fill calc, collapse the input sections so the Results panel (and the
// quantity panels below it) are what you see. Not persisted — a fresh session still
// opens with the inputs expanded for tracing.
function collapseForResults() {
  ['secSheet', 'secScale', 'secBoundary', 'secRealign', 'secContours', 'secSettings']
    .forEach(id => { const s = $(id); if (s) s.classList.add('collapsed'); });
  els.resultsSection.classList.remove('collapsed');
}

function renderResults() {
  const res = state.result;
  if (!res) return;
  const shrink = (parseFloat(els.inpShrink.value) || 0) / 100;
  const swell = (parseFloat(els.inpSwell.value) || 0) / 100;

  const fillBankCY = res.fillCY / Math.max(0.01, 1 - shrink); // bank dirt needed to build the fill
  const netBankCY = res.cutCY - fillBankCY;                    // + means surplus dirt on site
  const isExport = netBankCY >= 0;
  const haulCY = Math.abs(netBankCY) * (isExport ? 1 + swell : 1); // export hauls loose
  const cap = parseFloat(els.inpTruck.value) || 0;
  const loads = cap > 0 ? Math.ceil(haulCY / cap) : 0;

  els.results.innerHTML = `
    <div class="res-row"><span>Disturbed area</span><b>${fmt(res.areaFt2 / 43560, 2)} ac (${fmt(res.areaFt2)} sf)</b></div>
    <div class="res-row"><span>Grid cell used</span><b>${fmt(res.gridFt, 1)} ft</b></div>
    <div class="res-row cutc"><span>Cut (bank)</span><b>${fmt(res.cutCY)} CY</b></div>
    <div class="res-row fillc"><span>Fill (compacted)</span><b>${fmt(res.fillCY)} CY</b></div>
    <div class="res-row fillc"><span>Fill in bank CY (÷ ${(1 - shrink).toFixed(2)})</span><b>${fmt(fillBankCY)} CY</b></div>
    <div class="res-row total exportc">
      <span>${isExport ? 'EXPORT off site' : 'IMPORT to site'}</span>
      <b>${fmt(Math.abs(netBankCY))} CY bank</b>
    </div>
    ${isExport ? `<div class="res-row exportc"><span>≈ truck volume (loose, × ${(1 + swell).toFixed(2)})</span><b>${fmt(haulCY)} CY</b></div>` : ''}
    ${isExport && loads > 0 ? `<div class="res-row exportc"><span>≈ haul loads @ ${fmt(cap)} CY</span><b>${fmt(loads)} loads</b></div>` : ''}
    <div class="hint">Balanced site = 0. Positive cut means dirt leaves; shrink/swell/truck size come from the Settings panel. This is an estimating number — verify scale and traces before you bid.</div>`;
  els.resultsSection.classList.remove('hidden');
  els.resultsSection.classList.remove('collapsed'); // fresh numbers should be visible
}

['inpShrink', 'inpSwell'].forEach(id =>
  $(id).addEventListener('input', () => state.result && renderResults()));
els.inpTruck.addEventListener('input', () => {
  if (state.result) renderResults();
  if (!$('bidReport').classList.contains('hidden')) { $('bidTruck').value = els.inpTruck.value; renderHaulSummary(); }
  saveLocal();
});
els.inpZoomSpeed.addEventListener('change', () => saveLocal());

/* ============================== Retaining-wall dig ============================== */
// A wall trench cross-section is a trapezoid: a flat bottom (footing + working
// room) plus two backslopes rising to grade. Area = width·depth + slope·depth²
// (each side is a right triangle of base slope·depth and height depth). Volume
// is that area swept along the wall's length. Export = the excavated native that
// leaves the site (gross minus any reused as backfill); truck volume swells it.

function wallSectionAreaSf(bottomWidth, depth, slope) {
  if (!(depth > 0) || !(bottomWidth >= 0)) return 0;
  return bottomWidth * depth + slope * depth * depth;
}

function wallComputeCore({ grossFt3, concreteCY, aggregateCY, reusePct, swellPct }) {
  const grossCY = grossFt3 / 27;
  const conc = Math.max(0, concreteCY || 0);   // footing + stem concrete (import)
  const agg = Math.max(0, aggregateCY || 0);   // drainage aggregate zone (import)
  // After the wall + aggregate occupy the hole, the rest is backfill. Native can
  // be reused for that void; whatever's left is imported structural fill.
  const voidCY = Math.max(0, grossCY - conc - agg);
  const reuse = Math.min(1, Math.max(0, (reusePct || 0) / 100));
  const reusedCY = voidCY * reuse;             // native put back (not hauled)
  const netCY = grossCY - reusedCY;            // native exported off site
  const importBackfillCY = voidCY - reusedCY;  // structural fill to bring in
  const swell = Math.max(0, (swellPct || 0) / 100);
  return { grossCY, concreteCY: conc, aggregateCY: agg, voidCY, reusedCY,
    netCY, importBackfillCY, truckCY: netCY * (1 + swell), swell };
}

function polyLengthFt(pts) {
  const ftPerPx = (state.calibration && state.calibration.ftPerPx) || 0;
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += dist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
  return d * ftPerPx;
}

// --- Quick calculator (no plans needed) ---
function wallCalcCompute() {
  const len = parseFloat($('wcLen').value) || 0;
  const depth = parseFloat($('wcDepth').value) || 0;
  const width = parseFloat($('wcWidth').value) || 0;
  const slope = parseFloat($('wcSlope').value) || 0;
  const areaSf = wallSectionAreaSf(width, depth, slope);
  const core = wallComputeCore({
    grossFt3: areaSf * len,
    concreteCY: parseFloat($('wcConcrete').value),
    aggregateCY: parseFloat($('wcAgg').value),
    reusePct: parseFloat($('wcReuse').value),
    swellPct: parseFloat($('wcSwell').value),
  });
  $('wcResult').innerHTML = wallResultRows(core, areaSf);
}
$('btnWallCalc').addEventListener('click', () => {
  $('wcSwell').value = els.inpSwell.value || 25;
  wallCalcCompute();
  $('wallCalc').classList.remove('hidden');
});
$('wcClose').addEventListener('click', () => $('wallCalc').classList.add('hidden'));
['wcLen', 'wcDepth', 'wcWidth', 'wcSlope', 'wcReuse', 'wcSwell', 'wcConcrete', 'wcAgg']
  .forEach(id => $(id).addEventListener('input', wallCalcCompute));

// Shared results block for the quick calc and the section-mode recap.
function wallResultRows(core, areaSf) {
  const row = (label, val, cls) => `<div class="res-row ${cls || ''}"><span>${label}</span><b>${val}</b></div>`;
  return [
    areaSf != null ? row('Cross-section area', `${fmt(areaSf, 1)} sf`) : '',
    row('Excavation (bank)', `${fmt(core.grossCY)} CY`),
    core.concreteCY > 0.5 ? row('Concrete — footing + stem (import)', `${fmt(core.concreteCY)} CY`) : '',
    core.aggregateCY > 0.5 ? row('Drainage aggregate (import)', `${fmt(core.aggregateCY)} CY`) : '',
    core.reusedCY > 0.5 ? row('Reused as backfill', `− ${fmt(core.reusedCY)} CY`) : '',
    row('EXPORT off site (bank)', `${fmt(core.netCY)} CY`, 'total'),
    row(`≈ truck volume (loose, × ${(1 + core.swell).toFixed(2)})`, `${fmt(core.truckCY)} CY`),
    core.importBackfillCY > 0.5 ? row('Import structural backfill', `${fmt(core.importBackfillCY)} CY`) : '',
    `<div class="wall-note">Bank = in-ground volume; truck = swelled loose. Concrete &amp; aggregate are imported materials that take up the hole, so reused native backfill is figured against what's left. Cross-section = bottom width × depth + slope × depth². An estimating number — verify against the plans.</div>`,
  ].join('');
}

// --- Section mode (traced alignment off the plan) ---
function syncWsMode() {
  const mode = document.querySelector('input[name=wsMode]:checked').value;
  $('wsDepth').disabled = mode !== 'constant';
  $('wsSub').disabled = mode !== 'subgrade';
  $('wsEmbed').disabled = mode !== 'proposed';
}
document.querySelectorAll('input[name=wsMode]').forEach(r => r.addEventListener('change', syncWsMode));

// Changing Swell % (Settings) refigures each wall's loose/truck volume live,
// off the stored net bank CY — no re-sweep needed.
els.inpSwell.addEventListener('input', () => {
  if (!state.walls.length) return;
  const swell = Math.max(0, (parseFloat(els.inpSwell.value) || 0) / 100);
  for (const w of state.walls) { w.result.swell = swell; w.result.truckCY = w.result.netCY * (1 + swell); }
  renderWalls();
});

function askWallSection(lengthFt, caps) {
  const canSubgrade = !!caps.canSubgrade, canProposed = !!caps.canProposed;
  return new Promise(resolve => {
    $('wsLen').textContent = fmt(lengthFt) + ' ft along the line';
    const subRadio = document.querySelector('input[name=wsMode][value=subgrade]');
    const propRadio = document.querySelector('input[name=wsMode][value=proposed]');
    subRadio.disabled = !canSubgrade;
    propRadio.disabled = !canProposed;
    // If the checked mode is no longer available, fall back to constant depth.
    const checked = document.querySelector('input[name=wsMode]:checked');
    if ((checked.value === 'subgrade' && !canSubgrade) || (checked.value === 'proposed' && !canProposed))
      document.querySelector('input[name=wsMode][value=constant]').checked = true;
    $('wsSubHint').textContent =
      'Subgrade: digs to a fixed footing elevation off your Existing contours. ' +
      'Proposed grade: bottom follows the Proposed (finished) surface at the embedment below it — for a benched footing that steps down a slope. ' +
      (canSubgrade ? '' : 'Trace Existing contours to enable subgrade. ') +
      (canProposed ? '' : 'Trace Existing + Proposed contours to enable proposed-grade.');
    syncWsMode();
    $('wallSection').classList.remove('hidden');
    const cleanup = () => { $('wsOk').onclick = null; $('wsCancel').onclick = null; $('wallSection').classList.add('hidden'); };
    $('wsCancel').onclick = () => { cleanup(); resolve(null); };
    $('wsOk').onclick = () => {
      const mode = document.querySelector('input[name=wsMode]:checked').value;
      cleanup();
      resolve({
        bottomWidth: parseFloat($('wsWidth').value) || 0,
        slope: parseFloat($('wsSlope').value) || 0,
        reusePct: parseFloat($('wsReuse').value) || 0,
        concreteCY: parseFloat($('wsConcrete').value) || 0,
        aggregateCY: parseFloat($('wsAgg').value) || 0,
        depthMode: mode,
        depth: parseFloat($('wsDepth').value) || 0,
        subgrade: parseFloat($('wsSub').value) || 0,
        embedment: parseFloat($('wsEmbed').value) || 0,
      });
    };
  });
}

function computeWallSweep(pts, cfg) {
  const ftPerPx = state.calibration && state.calibration.ftPerPx;
  if (!ftPerPx) return null;
  const needExist = cfg.depthMode === 'subgrade' || cfg.depthMode === 'proposed';
  const existInterp = (needExist && state.contours.existing.length) ? makeInterpolator(state.contours.existing) : null;
  const propInterp = (cfg.depthMode === 'proposed' && state.contours.proposed.length) ? makeInterpolator(state.contours.proposed) : null;
  let lengthFt = 0, volFt3 = 0, dSum = 0, dN = 0, dMin = Infinity, dMax = -Infinity, noGrade = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segFt = dist(a.x, a.y, b.x, b.y) * ftPerPx;
    if (segFt <= 0) continue;
    const n = Math.max(1, Math.round(segFt)); // ~1-ft stations
    const dsFt = segFt / n;
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      let depth;
      if (cfg.depthMode === 'proposed') {
        // Dig from Existing ground down to the Proposed surface less the footing
        // embedment: depth = existing − (proposed − embedment).
        const ge = existInterp ? existInterp(x, y) : null;
        const gp = propInterp ? propInterp(x, y) : null;
        if (ge === null || gp === null) { depth = 0; noGrade++; }
        else depth = Math.max(0, ge - (gp - cfg.embedment));
      } else if (cfg.depthMode === 'subgrade') {
        const g = existInterp ? existInterp(x, y) : null;
        if (g === null) { depth = 0; noGrade++; } else depth = Math.max(0, g - cfg.subgrade);
      } else depth = Math.max(0, cfg.depth);
      volFt3 += wallSectionAreaSf(cfg.bottomWidth, depth, cfg.slope) * dsFt;
      lengthFt += dsFt; dSum += depth; dN++;
      if (depth < dMin) dMin = depth;
      if (depth > dMax) dMax = depth;
    }
  }
  const core = wallComputeCore({ grossFt3: volFt3, concreteCY: cfg.concreteCY, aggregateCY: cfg.aggregateCY, reusePct: cfg.reusePct, swellPct: parseFloat(els.inpSwell.value) });
  return { ...core, lengthFt, avgDepth: dN ? dSum / dN : 0,
    minDepth: isFinite(dMin) ? dMin : 0, maxDepth: isFinite(dMax) ? dMax : 0,
    noGradeFrac: dN ? noGrade / dN : 0 };
}

function drawWall() {
  if (!state.walls || !state.walls.length) return;
  for (const w of state.walls) {
    if (!w.pts || w.pts.length < 2) continue;
    ctx.strokeStyle = '#e0a03f';
    ctx.lineWidth = lw(3);
    ctx.beginPath();
    w.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
    ctx.fillStyle = '#e0a03f';
    for (const p of w.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, lw(3), 0, Math.PI * 2); ctx.fill(); }
    const mid = w.pts[Math.floor(w.pts.length / 2)];
    if (w.result) labelAt(mid.x, mid.y, `${fmt(w.result.netCY)} CY`, '#e0a03f');
  }
}

function renderWalls() {
  const sec = $('secWalls'), list = $('wallList');
  if (!sec || !list) return;
  if (!state.walls.length) { sec.classList.add('hidden'); draw(); return; }
  sec.classList.remove('hidden');
  const cnt = $('wallCount'); if (cnt) cnt.textContent = state.walls.length;
  const depthTxt = r => r.minDepth === r.maxDepth
    ? `${fmt(r.avgDepth, 1)} ft deep`
    : `${fmt(r.minDepth, 1)}–${fmt(r.maxDepth, 1)} ft deep`;
  list.innerHTML = state.walls.map((w, i) => `
    <div class="wall-row">
      <div class="wall-row-main">
        <b>${fmt(w.result.netCY)} CY export</b>
        <span>${fmt(w.result.lengthFt)} ft · ${fmt(w.result.truckCY)} CY loose · ${depthTxt(w.result)}</span>
      </div>
      <button class="wall-del" data-i="${i}" title="Delete this wall dig">✕</button>
    </div>`).join('');
  list.querySelectorAll('.wall-del').forEach(b => b.addEventListener('click', () => {
    snapshot();
    state.walls.splice(parseInt(b.dataset.i, 10), 1);
    renderWalls();
    saveLocal();
  }));
  draw();
}

/* ============================== Area takeoffs ============================== */
// Turn a traced area into a sitework quantity: area (SF/SY), volume (CY from a
// thickness), or weight (tons from thickness × compacted density).

const AREA_PRESETS = {
  asphalt:  { label: 'Asphalt paving', mode: 'paving', thickness: 3, density: 145, tack: 0.10 },
  base:     { label: 'Aggregate base', mode: 'tons', thickness: 6, density: 135 },
  concrete: { label: 'Concrete flatwork', mode: 'concrete', thickness: 4, rebar: '#4@18', form: true },
  gravel:   { label: 'Gravel / fill', mode: 'cy', thickness: 6 },
  topsoil:  { label: 'Topsoil strip', mode: 'strip', thickness: 6, swell: 25, respread: 0 },
  areaonly: { label: 'Area', mode: 'area' },
};

// Each surface type draws in its own color so concrete, paving, base, etc. read
// apart on the plan. Known materials get a real-world color by mode; generic
// "Area" takeoffs get a stable color hashed from their (custom) label, so two
// differently-named Area-only takeoffs come out different colors.
const AREA_MODE_COLORS = {
  concrete: '#9aa7b8', // concrete — gray
  paving:   '#5b6472', // asphalt — charcoal
  tons:     '#c7a55f', // aggregate base — tan
  cy:       '#b07d43', // gravel / fill — brown
  strip:    '#6fae4d', // topsoil — green
};
const AREA_PALETTE = ['#38d39f', '#4da3ff', '#c07ef7', '#e0912b', '#e05555', '#2bb3c0', '#d24d8c', '#8bbf3f'];
function areaColorHex(t) {
  const m = AREA_MODE_COLORS[t.cfg.mode];
  if (m) return m;
  const s = String(t.cfg.label || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AREA_PALETTE[h % AREA_PALETTE.length];
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// bar unit weights (lb/ft); grid spacing in feet
const REBAR = {
  '#4@18': { bar: '#4', spacing: '18', sp: 1.5, lb: 0.668 },
  '#4@12': { bar: '#4', spacing: '12', sp: 1.0, lb: 0.668 },
  '#5@12': { bar: '#5', spacing: '12', sp: 1.0, lb: 1.043 },
};
function rebarQuantity(areaSf, key) {
  if (key === 'mesh') return { type: 'mesh', meshSf: areaSf * 1.05 }; // 5% overlap
  const r = REBAR[key];
  if (!r) return null;
  const lf = 2 * areaSf / r.sp * 1.10; // both directions + 10% laps/waste
  return { type: r.bar, spacing: r.spacing, lf, weightLb: lf * r.lb };
}

function areaQuantity(areaSf, cfg) {
  const thickFt = (parseFloat(cfg.thickness) || 0) / 12;
  if (cfg.mode === 'tons') {
    const d = parseFloat(cfg.density) || 145;
    return { quantity: areaSf * thickFt * d / 2000, unit: 'tons' };
  }
  if (cfg.mode === 'paving') {
    const d = parseFloat(cfg.density) || 145;
    return { quantity: areaSf * thickFt * d / 2000, unit: 'tons' };
  }
  if (cfg.mode === 'cy' || cfg.mode === 'concrete') return { quantity: areaSf * thickFt / 27, unit: 'CY' };
  if (cfg.mode === 'strip') {
    const stripCY = areaSf * thickFt / 27;                       // bank volume stripped
    const swell = 1 + (parseFloat(cfg.swell) || 0) / 100;        // loose bulking for hauling
    const respreadCY = areaSf * ((parseFloat(cfg.respread) || 0) / 12) / 27; // placed back (bank)
    const netExportCY = Math.max(0, stripCY - respreadCY);       // leaves the site (bank)
    return {
      quantity: stripCY, unit: 'CY',
      stripCY, looseCY: stripCY * swell,
      respreadCY, netExportCY, netExportLooseCY: netExportCY * swell,
    };
  }
  return { quantity: areaSf, unit: 'SF' };
}

function computeAreaResult(areaSf, cfg, perimFt) {
  const q = areaQuantity(areaSf, cfg);
  const r = { areaSf, sy: areaSf / 9, acres: areaSf / 43560, label: cfg.label, perimFt: perimFt || 0, ...q };
  if (cfg.mode === 'concrete') {
    if (cfg.form !== false && perimFt > 0) r.formworkLF = perimFt; // edge forms run the perimeter
    const reb = rebarQuantity(areaSf, cfg.rebar);
    if (reb) r.rebar = reb;
  } else if (cfg.mode === 'paving') {
    const rate = parseFloat(cfg.tack);
    const tackRate = isFinite(rate) ? rate : 0.10;
    if (tackRate > 0) r.tackGal = (areaSf / 9) * tackRate; // gal = SY × rate
  }
  return r;
}

function areaResultRows(areaSf, cfg, perimFt) {
  const r = computeAreaResult(areaSf, cfg, perimFt);
  const rows = [['Area', `${fmt(areaSf)} sf · ${fmt(r.sy)} sy · ${fmt(r.acres, 2)} ac`]];
  if (cfg.mode === 'strip') {
    rows.push(['Strip volume', `${fmt(r.stripCY, 1)} CY bank`, 'total']);
    rows.push(['Loose (haul)', `${fmt(r.looseCY, 1)} CY`]);
    if (r.respreadCY > 0) {
      rows.push(['Respread', `${fmt(r.respreadCY, 1)} CY bank`]);
      rows.push(['Net export', `${fmt(r.netExportCY, 1)} CY bank · ${fmt(r.netExportLooseCY, 1)} loose`, 'total']);
    }
  } else if (cfg.mode === 'concrete') {
    rows.push(['Concrete volume', `${fmt(r.quantity, 1)} CY`, 'total']);
    if (r.formworkLF) rows.push(['Edge forms', `${fmt(r.formworkLF)} LF`]);
    if (r.rebar) rows.push(r.rebar.type === 'mesh'
      ? ['Wire mesh', `${fmt(r.rebar.meshSf)} SF`]
      : [`Rebar ${r.rebar.type} @ ${r.rebar.spacing}"`, `${fmt(r.rebar.lf)} LF · ${fmt(r.rebar.weightLb)} lb`]);
  } else if (cfg.mode === 'paving') {
    rows.push(['Asphalt weight', `${fmt(r.quantity, 1)} tons`, 'total']);
    if (r.tackGal) rows.push(['Tack coat', `${fmt(r.tackGal)} gal`]);
  } else if (cfg.mode !== 'area') {
    rows.push([cfg.mode === 'tons' ? 'Weight' : 'Volume', `${fmt(r.quantity, 1)} ${r.unit}`, 'total']);
  }
  return rows.map(([k, v, cls]) => `<div class="res-row ${cls === 'total' ? 'total' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}

function readAreaCfg() {
  return {
    label: $('atLabel').value.trim() || 'Area',
    mode: $('atMode').value,
    thickness: $('atThick').value,
    density: $('atDensity').value,
    rebar: $('atRebar').value,
    form: $('atForm').checked,
    tack: $('atTack').value,
    swell: $('atSwell').value,
    respread: $('atRespread').value,
    deduct: $('atDeduct').checked,
  };
}

function syncAreaMode() {
  const mode = $('atMode').value;
  $('atThickWrap').style.display = mode === 'area' ? 'none' : '';
  $('atDensityWrap').style.display = (mode === 'tons' || mode === 'paving') ? '' : 'none';
  $('atRebarWrap').style.display = mode === 'concrete' ? '' : 'none';
  $('atFormWrap').style.display = mode === 'concrete' ? '' : 'none';
  $('atTackWrap').style.display = mode === 'paving' ? '' : 'none';
  $('atSwellWrap').style.display = mode === 'strip' ? '' : 'none';
  $('atRespreadWrap').style.display = mode === 'strip' ? '' : 'none';
  $('atThickLbl').textContent = mode === 'strip' ? 'Strip depth (in)' : 'Thickness (in)';
}

function askAreaConfig(areaSf, perimFt, prefill) {
  return new Promise(resolve => {
    const preview = () => { $('atResult').innerHTML = areaResultRows(areaSf, readAreaCfg(), perimFt); };
    $('atArea').textContent = `${fmt(areaSf)} sf`;
    $('atDeduct').checked = !!(prefill && prefill.deduct); // default off for a new area
    if (prefill) {
      $('atLabel').value = prefill.label ?? '';
      $('atMode').value = prefill.mode ?? 'area';
      if (prefill.thickness != null) $('atThick').value = prefill.thickness;
      if (prefill.density != null) $('atDensity').value = prefill.density;
      if (prefill.rebar != null) $('atRebar').value = prefill.rebar;
      if (prefill.form != null) $('atForm').checked = !!prefill.form;
      if (prefill.tack != null) $('atTack').value = prefill.tack;
      if (prefill.swell != null) $('atSwell').value = prefill.swell;
      if (prefill.respread != null) $('atRespread').value = prefill.respread;
    }
    syncAreaMode();
    preview();
    $('areaTakeoff').classList.remove('hidden');

    const onInput = () => { syncAreaMode(); preview(); };
    const inputs = ['atLabel', 'atMode', 'atThick', 'atDensity', 'atRebar', 'atForm', 'atTack', 'atSwell', 'atRespread'];
    inputs.forEach(id => { $(id).addEventListener('input', onInput); $(id).addEventListener('change', onInput); });
    const presetBtns = [...document.querySelectorAll('#atPresets [data-preset]')];
    const onPreset = e => {
      const p = AREA_PRESETS[e.target.dataset.preset];
      if (!p) return;
      $('atLabel').value = p.label;
      $('atMode').value = p.mode;
      if (p.thickness != null) $('atThick').value = p.thickness;
      if (p.density != null) $('atDensity').value = p.density;
      if (p.rebar != null) $('atRebar').value = p.rebar;
      if (p.form != null) $('atForm').checked = p.form;
      if (p.tack != null) $('atTack').value = p.tack;
      if (p.swell != null) $('atSwell').value = p.swell;
      if (p.respread != null) $('atRespread').value = p.respread;
      onInput();
    };
    presetBtns.forEach(b => b.addEventListener('click', onPreset));

    const cleanup = () => {
      inputs.forEach(id => { $(id).removeEventListener('input', onInput); $(id).removeEventListener('change', onInput); });
      presetBtns.forEach(b => b.removeEventListener('click', onPreset));
      $('atOk').onclick = null; $('atCancel').onclick = null;
      $('areaTakeoff').classList.add('hidden');
    };
    $('atCancel').onclick = () => { cleanup(); resolve(null); };
    $('atOk').onclick = () => { const cfg = readAreaCfg(); cleanup(); resolve(cfg); };
  });
}

// ── Linear / trench takeoffs ──────────────────────────────────────────────────
// Length in feet, plus an optional trench cross-section (reusing the wall
// section math) for pipe/utility runs → excavation spoil + aggregate bedding.

const LINE_PRESETS = {
  curb:     { label: 'Curb & gutter', trench: false },
  pipe:     { label: 'Pipe / utility trench', trench: true, width: 3, depth: 5, slope: 0, bedding: 6 },
  // Pipe-size presets seed a typical trench bottom width (pipe OD + working room);
  // depth/slope are starting points — set each segment's actual average depth.
  pipe12:   { label: '12" pipe trench', trench: true, width: 3,   depth: 5, slope: 0, bedding: 6 },
  pipe18:   { label: '18" pipe trench', trench: true, width: 3.5, depth: 5, slope: 0, bedding: 6 },
  pipe24:   { label: '24" pipe trench', trench: true, width: 4,   depth: 6, slope: 0, bedding: 6 },
  pipe36:   { label: '36" pipe trench', trench: true, width: 5,   depth: 6, slope: 0, bedding: 6 },
  silt:     { label: 'Silt fence', trench: false },
  sawcut:   { label: 'Sawcut', trench: false },
  fence:    { label: 'Fence / guardrail', trench: false },
  lineonly: { label: 'Line', trench: false },
};

function computeLineResult(lengthFt, cfg) {
  const r = { lengthFt, label: cfg.label, trench: !!cfg.trench, trenchCY: 0, beddingCY: 0 };
  if (cfg.trench) {
    const w = parseFloat(cfg.width) || 0, d = parseFloat(cfg.depth) || 0, s = parseFloat(cfg.slope) || 0;
    r.trenchCY = wallSectionAreaSf(w, d, s) * lengthFt / 27; // trapezoid × length
    const bedIn = parseFloat(cfg.bedding) || 0;
    r.beddingCY = bedIn > 0 ? (w * (bedIn / 12) * lengthFt) / 27 : 0;
  }
  return r;
}

function lineResultRows(lengthFt, cfg) {
  const r = computeLineResult(lengthFt, cfg);
  const rows = [['Length', `${fmt(lengthFt)} ft`, r.trench ? '' : 'total']];
  if (r.trench) {
    rows.push(['Trench excavation', `${fmt(r.trenchCY, 1)} CY`, 'total']);
    if (r.beddingCY > 0) rows.push(['Bedding (import)', `${fmt(r.beddingCY, 1)} CY`]);
  }
  return rows.map(([k, v, cls]) => `<div class="res-row ${cls === 'total' ? 'total' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}

function readLineCfg() {
  return {
    label: $('ltLabel').value.trim() || 'Line',
    trench: $('ltTrench').checked,
    width: $('ltWidth').value, depth: $('ltDepth').value,
    slope: $('ltSlope').value, bedding: $('ltBedding').value,
  };
}

function syncLineTrench() {
  $('ltTrenchFields').style.display = $('ltTrench').checked ? '' : 'none';
}

function askLineConfig(lengthFt, prefill) {
  return new Promise(resolve => {
    const preview = () => { $('ltResult').innerHTML = lineResultRows(lengthFt, readLineCfg()); };
    $('ltLen').textContent = `${fmt(lengthFt)} ft`;
    if (prefill) {
      $('ltLabel').value = prefill.label ?? '';
      $('ltTrench').checked = !!prefill.trench;
      if (prefill.width != null) $('ltWidth').value = prefill.width;
      if (prefill.depth != null) $('ltDepth').value = prefill.depth;
      if (prefill.slope != null) $('ltSlope').value = prefill.slope;
      if (prefill.bedding != null) $('ltBedding').value = prefill.bedding;
    }
    syncLineTrench();
    preview();
    $('lineTakeoff').classList.remove('hidden');
    const onInput = () => { syncLineTrench(); preview(); };
    const inputs = ['ltLabel', 'ltTrench', 'ltWidth', 'ltDepth', 'ltSlope', 'ltBedding'];
    inputs.forEach(id => { $(id).addEventListener('input', onInput); $(id).addEventListener('change', onInput); });
    const presetBtns = [...document.querySelectorAll('#ltPresets [data-preset]')];
    const onPreset = e => {
      const p = LINE_PRESETS[e.target.dataset.preset];
      if (!p) return;
      $('ltLabel').value = p.label;
      $('ltTrench').checked = !!p.trench;
      if (p.width != null) $('ltWidth').value = p.width;
      if (p.depth != null) $('ltDepth').value = p.depth;
      if (p.slope != null) $('ltSlope').value = p.slope;
      if (p.bedding != null) $('ltBedding').value = p.bedding;
      onInput();
    };
    presetBtns.forEach(b => b.addEventListener('click', onPreset));
    const cleanup = () => {
      inputs.forEach(id => { $(id).removeEventListener('input', onInput); $(id).removeEventListener('change', onInput); });
      presetBtns.forEach(b => b.removeEventListener('click', onPreset));
      $('ltOk').onclick = null; $('ltCancel').onclick = null;
      $('lineTakeoff').classList.add('hidden');
    };
    $('ltCancel').onclick = () => { cleanup(); resolve(null); };
    $('ltOk').onclick = () => { const cfg = readLineCfg(); cleanup(); resolve(cfg); };
  });
}

// ── Count takeoffs ────────────────────────────────────────────────────────────
// Scale-independent tally: each dropped point is one item. Presets just seed the
// label + unit; the count is however many points you dropped.

const COUNT_PRESETS = {
  catchbasin: { label: 'Catch basin', unit: 'EA' },
  manhole:    { label: 'Manhole', unit: 'EA' },
  inlet:      { label: 'Inlet', unit: 'EA' },
  jbox:       { label: 'Junction box', unit: 'EA' },
  cleanout:   { label: 'Cleanout', unit: 'EA' },
  fes:        { label: 'Flared end section', unit: 'EA' },
  areadrain:  { label: 'Area drain', unit: 'EA' },
  tree:       { label: 'Tree', unit: 'EA' },
  sign:       { label: 'Sign', unit: 'EA' },
  light:      { label: 'Light pole', unit: 'EA' },
  bollard:    { label: 'Bollard', unit: 'EA' },
  itemonly:   { label: 'Item', unit: 'EA' },
};

function readCountCfg() {
  return {
    label: $('ctLabel').value.trim() || 'Item',
    unit: $('ctUnit').value.trim() || 'EA',
  };
}

function countResultRows(n, cfg) {
  return `<div class="res-row total"><span>${cfg.label}</span><b>${n} ${cfg.unit}</b></div>`;
}

function askCountConfig(n) {
  return new Promise(resolve => {
    const preview = () => { $('ctResult').innerHTML = countResultRows(n, readCountCfg()); };
    $('ctN').textContent = `${n} point${n === 1 ? '' : 's'}`;
    preview();
    $('countTakeoff').classList.remove('hidden');
    const onInput = () => preview();
    const inputs = ['ctLabel', 'ctUnit'];
    inputs.forEach(id => $(id).addEventListener('input', onInput));
    const presetBtns = [...document.querySelectorAll('#ctPresets [data-preset]')];
    const onPreset = e => {
      const p = COUNT_PRESETS[e.target.dataset.preset];
      if (!p) return;
      $('ctLabel').value = p.label;
      $('ctUnit').value = p.unit;
      onInput();
    };
    presetBtns.forEach(b => b.addEventListener('click', onPreset));
    const cleanup = () => {
      inputs.forEach(id => $(id).removeEventListener('input', onInput));
      presetBtns.forEach(b => b.removeEventListener('click', onPreset));
      $('ctOk').onclick = null; $('ctCancel').onclick = null;
      $('countTakeoff').classList.add('hidden');
    };
    $('ctCancel').onclick = () => { cleanup(); resolve(null); };
    $('ctOk').onclick = () => { const cfg = readCountCfg(); cleanup(); resolve(cfg); };
  });
}

function polyCentroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

// a numbered pin used for both count-draft and stored count markers
function drawCountMarker(p, num) {
  const r = lw(7);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#38d39f';
  ctx.fill();
  ctx.lineWidth = lw(1.5);
  ctx.strokeStyle = '#0f9d68';
  ctx.stroke();
  ctx.fillStyle = '#06371f';
  ctx.font = `${lw(9)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), p.x, p.y + lw(0.5));
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function drawTakeoffHandles(pts) {
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = lw(2);
  for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, lw(6), 0, Math.PI * 2); ctx.stroke(); }
}

function drawTakeoffs() {
  if (!state.takeoffs || !state.takeoffs.length) return;
  for (const t of state.takeoffs) {
    if (!t.pts || !t.pts.length) continue;
    const selT = state.tool === 'select' && state.takeoffs[state.selTake] === t;
    if (t.kind === 'count') {
      t.pts.forEach((p, i) => drawCountMarker(p, i + 1));
      const c = t.pts[0];
      labelAt(c.x + lw(10), c.y - lw(10), `${t.cfg.label}: ${t.result.count} ${t.result.unit}`, '#0f9d68');
      if (selT) drawTakeoffHandles(t.pts);
      continue;
    }
    if (t.pts.length < 2) continue;
    if (t.kind === 'area') {
      if (t.pts.length < 3) continue;
      const deduct = !!t.cfg.deduct;
      const areaCol = areaColorHex(t);
      ctx.beginPath();
      t.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = hexToRgba(areaCol, deduct ? 0.08 : 0.18);
      ctx.fill();
      ctx.strokeStyle = areaCol;
      ctx.lineWidth = lw(2);
      if (deduct) ctx.setLineDash([lw(7), lw(5)]); // dashed = subtracted (hole / cutout)
      ctx.stroke();
      ctx.setLineDash([]);
      if (t.result) {
        const c = polyCentroid(t.pts);
        const q = `${fmt(t.result.quantity, t.result.unit === 'SF' ? 0 : 1)} ${t.result.unit}`;
        labelAt(c.x, c.y, `${deduct ? '− ' : ''}${t.cfg.label}: ${q}`, deduct ? '#e0912b' : '#0f9d68');
      }
      if (selT) drawTakeoffHandles(t.pts);
    } else if (t.kind === 'line') {
      ctx.beginPath();
      t.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.strokeStyle = '#38d39f';
      ctx.lineWidth = lw(3);
      ctx.stroke();
      ctx.fillStyle = '#38d39f';
      for (const p of t.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, lw(2.5), 0, Math.PI * 2); ctx.fill(); }
      if (t.result) {
        const mid = t.pts[Math.floor(t.pts.length / 2)];
        const q = t.result.trench ? `${fmt(t.result.trenchCY, 0)} CY` : `${fmt(t.result.lengthFt)} ft`;
        labelAt(mid.x, mid.y, `${t.cfg.label}: ${q}`, '#0f9d68');
      }
      if (selT) drawTakeoffHandles(t.pts);
    }
  }
}

function takeoffRowText(t) {
  if (t.kind === 'count') {
    return { headline: `${t.result.count} ${t.result.unit}`, sub: t.cfg.label };
  }
  if (t.kind === 'area') {
    const strip = t.cfg.mode === 'strip';
    let extra = '';
    if (strip && t.result.netExportCY > 0) extra = ` · ${fmt(t.result.netExportCY, 0)} CY export`;
    else if (t.cfg.mode === 'concrete' && t.result.rebar)
      extra = ` · ${t.result.rebar.type === 'mesh' ? 'mesh' : t.result.rebar.type}${t.result.formworkLF ? ' + forms' : ''}`;
    else if (t.cfg.mode === 'paving' && t.result.tackGal) extra = ` · ${fmt(t.result.tackGal)} gal tack`;
    const sign = t.cfg.deduct ? '− ' : '';
    return {
      headline: `${sign}${fmt(t.result.quantity, t.result.unit === 'SF' ? 0 : 1)} ${t.result.unit}${strip ? ' strip' : ''}`,
      sub: `${t.cfg.deduct ? 'DEDUCT · ' : ''}${t.cfg.label} · ${fmt(t.result.areaSf)} sf${t.cfg.mode !== 'area' ? ` · ${t.cfg.thickness}"` : ''}${extra}`,
    };
  }
  return {
    headline: t.result.trench ? `${fmt(t.result.trenchCY, 1)} CY` : `${fmt(t.result.lengthFt)} ft`,
    sub: `${t.cfg.label} · ${fmt(t.result.lengthFt)} ft${t.result.trench ? ' trench' : ''}` +
      `${t.result.beddingCY ? ` · ${fmt(t.result.beddingCY, 1)} CY bed` : ''}`,
  };
}

function renderTakeoffs() {
  const sec = $('secTakeoffs'), list = $('takeoffList');
  if (!sec || !list) return;
  const items = state.takeoffs || [];
  if (!items.length) { sec.classList.add('hidden'); draw(); return; }
  sec.classList.remove('hidden');
  const cnt = $('takeoffCount'); if (cnt) cnt.textContent = items.length;

  // Keep each takeoff's real index (for delete) while we regroup for display.
  const indexed = items.map((t, i) => ({ t, i }));
  const rowHtml = ({ t, i }) => {
    const { headline, sub } = takeoffRowText(t);
    const dot = t.kind === 'area'
      ? `<span class="swatch" style="background:${areaColorHex(t)}"></span>` : '';
    const sel = i === state.selTake ? ' selected' : '';
    return `<div class="wall-row${sel}" data-take="${i}" title="Click to select on the plan (reshape with ➤ Select)">` +
      `<div class="wall-row-main"><b>${dot}${headline}</b><span>${sub}</span></div>` +
      `<button class="wall-del" data-i="${i}" title="Delete this takeoff">✕</button></div>`;
  };

  // Areas group by type: a color-matched subheader carrying the COMBINED SF (+ SY)
  // for that surface, then that type's individual takeoff rows beneath it.
  let html = '';
  const areaItems = indexed.filter(x => x.t.kind === 'area' && x.t.result);
  if (areaItems.length) {
    const groups = new Map(); // label -> { color, sf, rows }
    for (const x of areaItems) {
      const key = x.t.cfg.label || 'Area';
      const g = groups.get(key) || { color: areaColorHex(x.t), sf: 0, rows: [] };
      g.sf += (x.t.cfg.deduct ? -1 : 1) * (x.t.result.areaSf || 0); // holes/cutouts subtract
      g.rows.push(x);
      groups.set(key, g);
    }
    for (const [label, g] of groups) {
      html += `<div class="to-group"><span class="swatch" style="background:${g.color}"></span>` +
        `<span class="to-group-label">${esc(label)}</span>` +
        `<b>${fmt(g.sf)} sf</b><span class="to-group-sub">${fmt(g.sf / 9)} sy</span></div>` +
        g.rows.map(rowHtml).join('');
    }
  }

  // Lines & counts list below (unchanged), under a plain subheader when areas are shown.
  const others = indexed.filter(x => x.t.kind !== 'area');
  if (others.length) {
    if (areaItems.length) html += `<div class="to-group to-group-plain"><span class="to-group-label">Lines &amp; counts</span></div>`;
    html += others.map(rowHtml).join('');
  }
  list.innerHTML = html;
  list.querySelectorAll('.wall-del').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    snapshot();
    state.takeoffs.splice(parseInt(b.dataset.i, 10), 1);
    state.selTake = null;
    renderTakeoffs();
    saveLocal();
  }));
  // Click a row to select that takeoff on the plan (then reshape with ➤ Select).
  list.querySelectorAll('.wall-row[data-take]').forEach(row => row.addEventListener('click', () => {
    state.selTake = parseInt(row.dataset.take, 10);
    state.selected = null;
    if (state.tool !== 'select') setTool('select');
    renderTakeoffs();
    draw();
  }));
  draw();
}

/* ============================== Revision re-align ============================== */
// When a revised PDF shifts (or rotates/scales) the drawing, move ALL carried
// geometry onto it in one step. Every trace lives in the shared world frame, so
// this bakes a single similarity transform into calibration, boundary, both
// sheets' contours, and wall lines — then re-derives ft/px from the moved scale
// points (real feet unchanged). state.align (the proposed-image display offset)
// is a separate concern and is left alone.

function transformAllGeometry(M) {
  const T = p => alignApply(M, p);
  if (state.calibration) {
    const c = state.calibration;
    const A = T({ x: c.ax, y: c.ay }), B = T({ x: c.bx, y: c.by });
    c.ax = A.x; c.ay = A.y; c.bx = B.x; c.by = B.y;
    const px = dist(c.ax, c.ay, c.bx, c.by);
    if (px > 0) c.ftPerPx = c.feet / px; // same real distance, new pixel span
  }
  state.boundary = state.boundary.map(T);
  for (const sheet of ['existing', 'proposed'])
    state.contours[sheet].forEach(c => { c.pts = c.pts.map(T); });
  state.walls.forEach(w => { w.pts = w.pts.map(T); });
}

function applyRealign() {
  const pts = state.realignPts || [];
  const nPairs = Math.floor(pts.length / 2);
  if (nPairs < 1) { setMsg('Set at least one landmark pair: a spot on a carried trace, then the same spot on the updated drawing.'); return; }

  let M;
  if (nPairs === 1) {
    const from = pts[0], to = pts[1];
    M = { a: 1, b: 0, e: to.x - from.x, f: to.y - from.y }; // shift only
  } else {
    // Similarity (shift + rotation + uniform scale) from the first two pairs.
    const f1 = pts[0], t1 = pts[1], f2 = pts[2], t2 = pts[3];
    const dfx = f2.x - f1.x, dfy = f2.y - f1.y;
    const dtx = t2.x - t1.x, dty = t2.y - t1.y;
    const len2 = dfx * dfx + dfy * dfy;
    if (len2 < 4) { setMsg('Those two landmarks are too close together — pick a second one farther away.'); return; }
    const a = (dfx * dtx + dfy * dty) / len2;
    const b = (dfx * dty - dfy * dtx) / len2;
    M = { a, b, e: t1.x - (a * f1.x - b * f1.y), f: t1.y - (b * f1.x + a * f1.y) };
  }

  snapshot();
  transformAllGeometry(M);
  state.realignPts = [];
  state.result = null; // the cut/fill grid is positional — recompute after moving
  els.resultsSection.classList.add('hidden');
  refreshStatuses();
  refreshContourList();
  renderWalls();
  saveLocal();
  setTool('pan');
  draw();
  const scale = Math.hypot(M.a, M.b);
  setMsg(`Traces re-aligned to this PDF${nPairs >= 2 ? ` (shift + rotation, ×${scale.toFixed(3)})` : ' (shift)'}. ` +
    'Check the fit; re-verify the scale (📏) if the sheet prints at a different size. Ctrl+Z undoes it.');
}

function drawRealign() {
  const pts = state.realignPts;
  if (!pts || !pts.length) return;
  ctx.fillStyle = ctx.strokeStyle = '#38d39f';
  for (let i = 0; i < pts.length; i += 2) {
    const from = pts[i], to = pts[i + 1];
    ctx.beginPath(); ctx.arc(from.x, from.y, lw(4), 0, Math.PI * 2); ctx.fill();
    if (to) {
      ctx.lineWidth = lw(2);
      ctx.setLineDash([lw(5), lw(4)]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(to.x, to.y, lw(4), 0, Math.PI * 2); ctx.stroke();
    }
  }
}

/* ============================== Measure distance ============================== */
// Quick side tool: click two points, read the distance in feet. Doesn't change
// the scale or save anything — purely a readout.
function drawMeasure() {
  const pts = state.measurePts;
  if (!pts || !pts.length) return;
  ctx.fillStyle = ctx.strokeStyle = '#ffd24d';
  ctx.lineWidth = lw(2);
  if (pts.length >= 2) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    if (state.calibration) {
      const ft = dist(pts[0].x, pts[0].y, pts[1].x, pts[1].y) * state.calibration.ftPerPx;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      labelAt(mid.x, mid.y, `${fmt(ft, 1)} ft`, '#ffd24d');
    }
  }
  for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, lw(4), 0, Math.PI * 2); ctx.fill(); }
}

$('btnMeasure').addEventListener('click', () => {
  if (!state.calibration) { setMsg('Calibrate the scale (📏) first, then measure.'); return; }
  setTool('measure');
  $('measureOut').textContent = '';
  setMsg('Measure: click two points to read the distance in feet.');
});

/* ============================== Save / load ============================== */

$('btnNew').addEventListener('click', async () => {
  const hasWork = state.calibration || state.boundary.length ||
    state.contours.existing.length || state.contours.proposed.length;
  if (hasWork) {
    const ok = await askModal({
      title: 'Start a new takeoff?',
      body: '<div class="hint">This clears the scale, boundary, sheet alignment, and every traced contour — including the autosave. The PDF stays open. Use Save first if you want to keep this takeoff.</div>',
    });
    if (ok === null) return;
    snapshot(); // Undo can restore the whole takeoff after New
  }
  resetTakeoffState();
  try { localStorage.removeItem('ebc-project'); } catch (_) { /* private mode */ }
  scheduleProjectSync();
  setTool(state.pdf ? 'calibrate' : 'pan');
  setMsg(state.pdf ? 'Fresh takeoff — start by calibrating the scale (📏).' : 'Fresh takeoff.');
  draw();
});

function projectData() {
  return {
    app: 'excavation-bid-calculator', version: 1,
    pdfName: state.pdfName,
    pages: { existing: state.sheets.existing.pageNum, proposed: state.sheets.proposed.pageNum },
    calibration: state.calibration,
    align: state.align,
    boundary: state.boundary,
    contours: state.contours,
    walls: state.walls,
    takeoffs: state.takeoffs,
    bid: state.bid || defaultBid(),
    production: state.production || defaultProduction(),
    settings: {
      gridFt: els.inpGrid.value, interval: els.inpInterval.value,
      shrink: els.inpShrink.value, swell: els.inpSwell.value,
      truckCap: els.inpTruck.value,
      zoomSpeed: els.inpZoomSpeed.value,
    },
  };
}

function applyProjectData(d) {
  if (!d || d.app !== 'excavation-bid-calculator') return false;
  state.calibration = d.calibration || null;
  const al = d.align;
  state.align = al && 'a' in al ? al
    : al && (al.dx || al.dy) ? { a: 1, b: 0, e: -al.dx, f: -al.dy } // pre-rotation saves
    : alignIdentity();
  state.boundary = d.boundary || [];
  state.contours = d.contours || { existing: [], proposed: [] };
  state.walls = d.walls || [];
  state.takeoffs = d.takeoffs || [];
  state.bid = normalizeBid(d.bid);
  state.production = normalizeProduction(d.production);
  if (d.pages) {
    state.sheets.existing.pageNum = d.pages.existing || 1;
    state.sheets.proposed.pageNum = d.pages.proposed || 2;
  }
  if (d.settings) {
    els.inpGrid.value = d.settings.gridFt ?? 5;
    els.inpInterval.value = d.settings.interval ?? 1;
    els.inpShrink.value = d.settings.shrink ?? 15;
    els.inpSwell.value = d.settings.swell ?? 25;
    els.inpTruck.value = d.settings.truckCap ?? 12;
    els.inpZoomSpeed.value = d.settings.zoomSpeed ?? 100;
  }
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshStatuses();
  refreshContourList();
  renderWalls();
  renderTakeoffs();
  updateAlignStatus();
  return true;
}

function saveLocal() {
  try { localStorage.setItem('ebc-project', JSON.stringify(projectData())); }
  catch (_) { /* storage full or blocked — Save/Load file export still works */ }
  scheduleProjectSync();
}

/* ============================== Projects ============================== */

let projSyncTimer = null;
function scheduleProjectSync() {
  clearTimeout(projSyncTimer);
  projSyncTimer = setTimeout(syncProjectNow, 600);
}

async function syncProjectNow() {
  clearTimeout(projSyncTimer);
  projSyncTimer = null;
  if (!state.projectId) return;
  try {
    await idbProjPut({
      id: state.projectId,
      name: state.projectName || 'Takeoff',
      modified: Date.now(),
      pdfKey: state.pdfKey || null,
      pdfName: state.pdfName || null,
      data: projectData(),
    });
  } catch (_) { /* IndexedDB unavailable */ }
}

function updateProjectBtn() {
  els.projName.textContent = state.projectName || 'Project';
}

// clear the working takeoff (used by New, project switching)
function resetTakeoffState() {
  state.calibration = null;
  state.align = alignIdentity();
  state.boundary = [];
  state.contours = { existing: [], proposed: [] };
  state.walls = [];
  state.takeoffs = [];
  state.bid = defaultBid();
  state.production = defaultProduction();
  state.draft = []; state.calibPts = []; state.alignPts = []; state.alignQs = [];
  state.wandPts = null;
  state.boxA = state.boxB = null;
  state.selected = null;
  state.lastElev = { existing: null, proposed: null };
  state.prevElev = { existing: null, proposed: null };
  state.result = null;
  els.resultsSection.classList.add('hidden');
  refreshStatuses();
  refreshContourList();
  renderWalls();
  renderTakeoffs();
  updateAlignStatus();
}

async function openProject(id, opts = {}) {
  if (id === state.projectId) { els.projects.classList.add('hidden'); return; }
  if (!opts.noSync) await syncProjectNow(); // flush the outgoing project first
  const rec = await idbProjGet(id);
  if (!rec) { setMsg('That project no longer exists.'); return; }

  state.projectId = rec.id;
  state.projectName = rec.name;
  state.pdfKey = rec.pdfKey || null;
  state.pdfName = rec.pdfName || null;
  try { localStorage.setItem('ebc-current', rec.id); } catch (_) {}

  // drop everything belonging to the old project
  undoStack.length = 0;
  redoStack.length = 0;
  els.btnUndo.disabled = true;
  els.btnRedo.disabled = true;
  state.pdf = null;
  state.sheets.existing = { pageNum: 1, image: null };
  state.sheets.proposed = { pageNum: 2, image: null };
  state.renderScale = null;
  Object.keys(pathCache).forEach(k => delete pathCache[k]);
  Object.keys(hatchCapCache).forEach(k => delete hatchCapCache[k]);
  updateHatchCap();
  for (const sel of [els.pageExisting, els.pageProposed]) { sel.innerHTML = ''; sel.disabled = true; }
  els.dropHint.classList.remove('hidden');

  if (rec.data && rec.data.app === 'excavation-bid-calculator') applyProjectData(rec.data);
  else resetTakeoffState();
  updateProjectBtn();
  setTool('pan');
  saveLocal();
  draw();
  els.projects.classList.add('hidden');

  if (rec.pdfKey) {
    try {
      const f = await idbFilesGet(rec.pdfKey);
      if (f && f.bytes) {
        setMsg(`Opening ${state.projectName}: ${f.name}…`);
        await openPdfBytes(f.bytes, f.name);
      } else setMsg(`"${state.projectName}" opened — its PDF (${rec.pdfName || '?'}) isn't stored; use Open PDF….`);
    } catch (_) {
      setMsg(`"${state.projectName}" opened — could not reopen its PDF; use Open PDF….`);
    }
    draw();
  } else {
    setMsg(`"${state.projectName}" opened. Open a PDF to start the takeoff.`);
  }
}

async function projectList() {
  try { return (await idbProjAll()).sort((a, b) => (b.modified || 0) - (a.modified || 0)); }
  catch (_) { return []; }
}

async function showProjects() {
  await syncProjectNow();
  const recs = await projectList();
  els.projList.innerHTML = '';
  for (const r of recs) {
    const traces = r.data && r.data.contours
      ? r.data.contours.existing.length + r.data.contours.proposed.length : 0;
    const when = r.modified ? new Date(r.modified).toLocaleDateString() : '';
    const row = document.createElement('div');
    row.className = 'proj-row' + (r.id === state.projectId ? ' current' : '');
    row.innerHTML = `
      <div class="grow">
        <div class="name"></div>
        <div class="meta">${r.pdfName ? r.pdfName + ' · ' : ''}${traces} traces · ${when}</div>
      </div>
      ${r.id === state.projectId
        ? '<span class="pill">current</span>'
        : '<button class="btn tiny" data-act="open">Open</button>'}
      <button class="btn tiny" data-act="dup" title="Copy this takeoff as a new version — same PDF, independent traces">Duplicate</button>
      <button class="btn tiny" data-act="revise" title="Start a new revision from this takeoff — carries the scale, boundary, and traces; you then open the updated plans and edit only what changed">Revise…</button>
      <button class="btn tiny" data-act="ren" title="Rename">Rename</button>
      <button class="btn tiny danger" data-act="del" title="Delete this project">✕</button>`;
    row.querySelector('.name').textContent = r.name;
    row.querySelector('.grow').addEventListener('click', () => openProject(r.id));
    row.querySelectorAll('[data-act]').forEach(b =>
      b.addEventListener('click', () => projectAction(b.dataset.act, r.id)));
    els.projList.appendChild(row);
  }
  els.projects.classList.remove('hidden');
}

// Suggest the next revision name: "Site Grading Rev 2" → "Site Grading Rev 3",
// otherwise append " Rev 2".
function nextRevName(name) {
  const m = String(name || '').match(/^(.*?)[\s_-]*rev\.?\s*(\d+)\s*$/i);
  return m ? `${m[1].trim()} Rev ${parseInt(m[2], 10) + 1}` : `${name || 'Takeoff'} Rev 2`;
}

async function projectAction(act, id) {
  els.projects.classList.add('hidden'); // our modals don't stack
  if (act === 'open') { await openProject(id); return; }

  if (act === 'dup') {
    await syncProjectNow();
    const rec = await idbProjGet(id);
    if (!rec) return;
    const name = await askText('Duplicate takeoff',
      'Name for the copy. It shares the same PDF; the traces are an independent second version.',
      rec.name + ' v2');
    if (name) {
      const copy = JSON.parse(JSON.stringify(rec));
      copy.id = randId(); copy.name = name; copy.modified = Date.now();
      await idbProjPut(copy);
      await openProject(copy.id);
      return;
    }
  } else if (act === 'revise') {
    await syncProjectNow();
    const rec = await idbProjGet(id);
    if (!rec) return;
    const name = await askText('New revision',
      "Name for the revision. It carries this takeoff's scale, boundary, and traces. " +
      'After it opens, use Open PDF… to load the updated plans and edit only what changed.',
      nextRevName(rec.name));
    if (name) {
      // Fork into a new project (the original revision is left untouched). Keep
      // the old PDF so the revision opens with the traces over the previous
      // plans; opening the updated PDF swaps only the drawing.
      const copy = JSON.parse(JSON.stringify(rec));
      copy.id = randId(); copy.name = name; copy.modified = Date.now();
      await idbProjPut(copy);
      await openProject(copy.id);
      setMsg(`Revision "${name}" created — scale, boundary, and traces carried over. ` +
        'Click Open PDF… to load the updated plans (your traces stay put, so you edit only what changed). ' +
        'Re-check the scale (📏) if the revised sheet prints at a different size.');
      return;
    }
  } else if (act === 'ren') {
    const rec = await idbProjGet(id);
    if (!rec) return;
    const name = await askText('Rename project', '', rec.name);
    if (name) {
      rec.name = name;
      await idbProjPut(rec);
      if (id === state.projectId) { state.projectName = name; updateProjectBtn(); }
    }
  } else if (act === 'del') {
    const recs = await projectList();
    const rec = recs.find(r => r.id === id);
    if (!rec) return;
    const ok = await askModal({
      title: `Delete "${rec.name}"?`,
      body: '<div class="hint">Removes this takeoff permanently (no undo). Its PDF is removed too if no other project uses it.</div>',
    });
    if (ok !== null) {
      await idbProjDelete(id);
      if (rec.pdfKey && !recs.some(r => r.id !== id && r.pdfKey === rec.pdfKey))
        await idbFilesDelete(rec.pdfKey).catch(() => {});
      if (id === state.projectId) {
        const rest = recs.filter(r => r.id !== id);
        if (rest.length) { await openProject(rest[0].id, { noSync: true }); return; }
        const nid = randId();
        await idbProjPut({ id: nid, name: 'New project', modified: Date.now(), pdfKey: null, pdfName: null, data: null });
        try { localStorage.removeItem('ebc-project'); } catch (_) {}
        await openProject(nid, { noSync: true });
        return;
      }
    }
  }
  showProjects(); // back to the (refreshed) list
}

$('btnRealign').addEventListener('click', () => {
  if (!state.pdf) { setMsg('Open the updated PDF first, then re-align your carried traces to it.'); return; }
  if (!state.calibration && !state.boundary.length &&
      !state.contours.existing.length && !state.contours.proposed.length && !state.walls.length) {
    setMsg('Nothing to re-align yet — this moves already-placed traces onto a shifted drawing.'); return;
  }
  setTool('realign');
  setMsg('Re-align: click a landmark on a carried trace, then the same spot on the updated drawing. Enter to apply, Esc to cancel.');
});

els.btnProjects.addEventListener('click', showProjects);
els.projClose.addEventListener('click', () => els.projects.classList.add('hidden'));
els.projNewBtn.addEventListener('click', async () => {
  els.projects.classList.add('hidden');
  const name = await askText('New project',
    'Name for the new takeoff (e.g. the job or bid name). You pick its PDF after it opens.',
    'New project');
  if (!name) { showProjects(); return; }
  await syncProjectNow();
  const id = randId();
  await idbProjPut({ id, name, modified: Date.now(), pdfKey: null, pdfName: null, data: null });
  await openProject(id);
});

async function initProjects(liveRestored) {
  try {
    let cur = null;
    try { cur = localStorage.getItem('ebc-current'); } catch (_) {}
    let rec = cur ? await idbProjGet(cur) : null;

    if (!rec) {
      // first run with projects (or wiped store): adopt whatever is live now
      cur = randId();
      let pdfKey = null, pdfName = null;
      const legacy = await idbFilesGet('pdf').catch(() => null);
      if (legacy && legacy.bytes) { // migrate the pre-projects single PDF slot
        pdfKey = await hashBytes(legacy.bytes);
        await idbFilesPut(pdfKey, legacy);
        await idbFilesDelete('pdf').catch(() => {});
        pdfName = legacy.name;
      }
      rec = {
        id: cur,
        name: pdfName ? pdfName.replace(/\.pdf$/i, '') : 'Project 1',
        modified: Date.now(),
        pdfKey, pdfName,
        data: liveRestored ? projectData() : null,
      };
      await idbProjPut(rec);
      try { localStorage.setItem('ebc-current', cur); } catch (_) {}
    }

    state.projectId = rec.id;
    state.projectName = rec.name;
    state.pdfKey = rec.pdfKey || null;
    updateProjectBtn();
    if (!liveRestored && rec.data && rec.data.app === 'excavation-bid-calculator')
      applyProjectData(rec.data);

    if (rec.pdfKey && !state.pdf) {
      const f = await idbFilesGet(rec.pdfKey);
      if (f && f.bytes) {
        setMsg(`Reopening ${f.name}…`);
        try { await openPdfBytes(f.bytes, f.name); }
        catch (_) { setMsg(`Could not reopen ${f.name} — use Open PDF….`); }
        draw();
      }
    }
  } catch (_) { /* IndexedDB unavailable: single-takeoff mode still works */ }
}

$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.pdfName ? state.pdfName.replace(/\.pdf$/i, '') : 'takeoff') + '.takeoff.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('Takeoff saved. The PDF itself is not embedded — keep it next to the .json.');
});

$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const preLoad = takeSnap();
    if (applyProjectData(d)) {
      pushSnap(preLoad);
      if (state.pdf) {
        els.pageExisting.value = state.sheets.existing.pageNum;
        els.pageProposed.value = state.sheets.proposed.pageNum;
        await renderSheet('existing');
        await renderSheet('proposed');
      }
      saveLocal();
      setMsg(`Takeoff loaded${d.pdfName ? ` (made from ${d.pdfName})` : ''}.` +
             (state.pdf ? '' : ' Now open the matching PDF.'));
      draw();
    } else setMsg('That file is not a takeoff export.');
  } catch (err) { setMsg('Could not read that file: ' + err.message); }
  e.target.value = '';
});

/* ============================== Bid report ============================== */
// Rolls every measured quantity — cut/fill, wall digs, and area/line/count
// takeoffs — into one priced table. Unit prices are keyed by a stable id so
// they survive recompute and reload; overhead & profit is applied to the
// subtotal. Export to CSV, or Print (the browser's dialog offers Save as PDF;
// the @media print rules isolate just the report).

function bidState() { if (!state.bid) state.bid = defaultBid(); return state.bid; }

function buildBidItems() {
  const items = [];
  // key   = per-instance id (holds this project's price)
  // typeKey = type-level id (holds the remembered price shared across projects)
  // haul  = loose CY leaving the site, summed into the truck-load count
  const push = (key, typeKey, group, desc, qty, unit, haul) => {
    if (Math.abs(qty) > 0.05) items.push({ key, typeKey, group, desc, qty, unit, haul: !!haul });
  };
  const tk = s => String(s).toLowerCase().trim();

  // Earthwork — from the cut/fill result, using the current shrink/swell.
  const res = state.result;
  if (res) {
    const shrink = (parseFloat(els.inpShrink.value) || 0) / 100;
    const swell = (parseFloat(els.inpSwell.value) || 0) / 100;
    const fillBankCY = res.fillCY / Math.max(0.01, 1 - shrink);
    const netBankCY = res.cutCY - fillBankCY;
    const isExport = netBankCY >= 0;
    push('ew-cut', 'ew-cut', 'Earthwork', 'Mass excavation — cut (bank)', res.cutCY, 'CY');
    push('ew-fill', 'ew-fill', 'Earthwork', 'Embankment / fill (compacted)', res.fillCY, 'CY');
    const haul = Math.abs(netBankCY) * (isExport ? 1 + swell : 1);
    push('ew-haul', 'ew-haul', 'Earthwork',
      isExport ? 'Export & haul off site (loose)' : 'Import fill to site (bank)', haul, 'CY', isExport);
  }

  // Retaining-wall digs (type keys drop the per-wall id so pricing is shared).
  state.walls.forEach((w, i) => {
    const r = w.result, n = i + 1;
    push(`wall-${w.id}-exc`, 'wall-exc', 'Retaining walls', `Wall ${n} — excavation (bank)`, r.grossCY, 'CY');
    push(`wall-${w.id}-exp`, 'wall-exp', 'Retaining walls', `Wall ${n} — export off site (loose)`, r.truckCY, 'CY', true);
    push(`wall-${w.id}-bf`, 'wall-bf', 'Retaining walls', `Wall ${n} — import backfill`, r.importBackfillCY, 'CY');
    push(`wall-${w.id}-conc`, 'wall-conc', 'Retaining walls', `Wall ${n} — concrete`, r.concreteCY, 'CY');
    push(`wall-${w.id}-agg`, 'wall-agg', 'Retaining walls', `Wall ${n} — drainage aggregate`, r.aggregateCY, 'CY');
  });

  // Sitework quantity takeoffs (type keys use the label so like-named items share a price).
  const g = 'Sitework quantities';
  state.takeoffs.forEach(t => {
    const lbl = tk(t.cfg.label);
    if (t.kind === 'count') {
      push(`to-${t.id}`, `count:${lbl}:${tk(t.result.unit)}`, g, t.cfg.label, t.result.count, t.result.unit);
    } else if (t.kind === 'line') {
      if (t.result.trench) {
        push(`to-${t.id}-len`, `line:${lbl}`, g, `${t.cfg.label} (run)`, t.result.lengthFt, 'LF');
        push(`to-${t.id}-tr`, `line-trench:${lbl}`, g, `${t.cfg.label} — trench excavation`, t.result.trenchCY, 'CY');
        push(`to-${t.id}-bed`, `line-bed:${lbl}`, g, `${t.cfg.label} — bedding`, t.result.beddingCY, 'CY');
      } else {
        push(`to-${t.id}`, `line:${lbl}`, g, t.cfg.label, t.result.lengthFt, 'LF');
      }
    } else if (t.kind === 'area') {
      // A deduct (hole / cutout) subtracts only its PRIMARY quantity from the same
      // type key; secondary add-ons (rebar/forms/tack/respread) are skipped since a
      // cutout's effect on those is ambiguous.
      const sgn = t.cfg.deduct ? -1 : 1, dPfx = t.cfg.deduct ? 'Deduct — ' : '';
      if (t.cfg.mode === 'strip') {
        push(`to-${t.id}-strip`, `strip:${lbl}`, g, `${dPfx}${t.cfg.label} (strip, bank)`, sgn * t.result.stripCY, 'CY');
        if (!t.cfg.deduct) {
          push(`to-${t.id}-resp`, `strip-resp:${lbl}`, g, `${t.cfg.label} — respread`, t.result.respreadCY, 'CY');
          push(`to-${t.id}-exp`, `strip-exp:${lbl}`, g, `${t.cfg.label} — net export (loose)`, t.result.netExportLooseCY, 'CY', true);
        }
      } else if (t.cfg.mode === 'concrete') {
        push(`to-${t.id}`, `concrete:${lbl}`, g, `${dPfx}${t.cfg.label}`, sgn * t.result.quantity, 'CY');
        if (!t.cfg.deduct) {
          if (t.result.formworkLF) push(`to-${t.id}-form`, `concrete-form:${lbl}`, g, `${t.cfg.label} — edge forms`, t.result.formworkLF, 'LF');
          if (t.result.rebar) {
            if (t.result.rebar.type === 'mesh')
              push(`to-${t.id}-mesh`, `concrete-mesh:${lbl}`, g, `${t.cfg.label} — wire mesh`, t.result.rebar.meshSf, 'SF');
            else
              push(`to-${t.id}-rebar`, `concrete-rebar:${lbl}:${t.result.rebar.type}`, g, `${t.cfg.label} — rebar ${t.result.rebar.type}`, t.result.rebar.weightLb, 'lb');
          }
        }
      } else if (t.cfg.mode === 'paving') {
        push(`to-${t.id}`, `paving:${lbl}`, g, `${dPfx}${t.cfg.label}`, sgn * t.result.quantity, 'tons');
        if (!t.cfg.deduct && t.result.tackGal) push(`to-${t.id}-tack`, `tack:${lbl}`, g, `${t.cfg.label} — tack coat`, t.result.tackGal, 'gal');
      } else {
        push(`to-${t.id}`, `area:${lbl}:${tk(t.result.unit)}`, g, `${dPfx}${t.cfg.label}`, sgn * t.result.quantity, t.result.unit);
      }
    }
  });

  return items;
}

// Cross-project remembered unit prices, keyed by item type (not instance).
let priceBookCache = null;
function loadPriceBook() {
  if (!priceBookCache) {
    try { priceBookCache = JSON.parse(localStorage.getItem('ebc-pricebook')); } catch (_) { priceBookCache = null; }
    if (!priceBookCache || typeof priceBookCache !== 'object') priceBookCache = {};
  }
  return priceBookCache;
}
function savePriceBook(book) {
  priceBookCache = book || {};
  try { localStorage.setItem('ebc-pricebook', JSON.stringify(priceBookCache)); } catch (_) { /* private mode */ }
}

// Pre-fill any un-priced line from the remembered library (writes into the project).
function seedPricesFromBook() {
  const book = loadPriceBook();
  const prices = bidState().prices;
  let changed = false;
  for (const it of buildBidItems()) {
    const cur = prices[it.key];
    const remembered = book[it.typeKey];
    if ((cur == null || cur === '') && remembered != null && remembered !== '') {
      prices[it.key] = remembered;
      changed = true;
    }
  }
  if (changed) saveLocal();
}

// Single source of truth for the priced numbers, shared by render/CSV/print.
function bidComputed() {
  const items = buildBidItems();
  const prices = bidState().prices;
  let subtotal = 0, haulCY = 0;
  const groupSubs = {};
  const rows = items.map(it => {
    const parsed = parseFloat(prices[it.key]);
    const price = isFinite(parsed) ? parsed : 0;
    const ext = it.qty * price;
    subtotal += ext;
    if (it.haul) haulCY += it.qty;
    groupSubs[it.group] = (groupSubs[it.group] || 0) + ext;
    return { ...it, price, ext };
  });
  const markupPct = parseFloat(bidState().markup) || 0;
  const markupAmt = subtotal * markupPct / 100;
  return { rows, subtotal, groupSubs, markupPct, markupAmt, total: subtotal + markupAmt, haulCY };
}

function bidSubrow(group, val) {
  return `<tr class="bid-subrow" data-group="${esc(group)}">` +
    `<td colspan="4">${esc(group)} subtotal</td>` +
    `<td class="bid-num bid-subval">${money(val)}</td></tr>`;
}

function renderBidReport() {
  const c = bidComputed();
  const body = $('bidTableBody');
  if (!c.rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="bid-empty">Nothing to price yet — run ∑ Calculate ' +
      'Cut/Fill, add a wall dig, or take off areas / lines / counts.</td></tr>';
    applyBidTotals(c);
    return;
  }
  const prices = bidState().prices;
  let html = '', curGroup = null;
  for (const r of c.rows) {
    if (r.group !== curGroup) {
      if (curGroup !== null) html += bidSubrow(curGroup, c.groupSubs[curGroup]);
      curGroup = r.group;
      html += `<tr class="bid-group"><td colspan="5">${esc(curGroup)}</td></tr>`;
    }
    const pv = prices[r.key];
    html += '<tr>' +
      `<td class="bid-desc">${esc(r.desc)}</td>` +
      `<td class="bid-num">${fmt(r.qty, r.unit === 'EA' ? 0 : 1)}</td>` +
      `<td class="bid-unit">${esc(r.unit)}</td>` +
      `<td class="bid-price-cell">$<input type="number" class="bid-price" data-key="${esc(r.key)}" ` +
        `data-type="${esc(r.typeKey)}" min="0" step="0.01" value="${pv != null ? esc(pv) : ''}" placeholder="0.00"></td>` +
      `<td class="bid-num bid-ext" data-key="${esc(r.key)}">${money(r.ext)}</td>` +
    '</tr>';
  }
  html += bidSubrow(curGroup, c.groupSubs[curGroup]);
  body.innerHTML = html;
  body.querySelectorAll('.bid-price').forEach(inp => inp.addEventListener('input', onBidPriceInput));
  applyBidTotals(c);
}

function applyBidTotals(c) {
  $('bidSubtotal').textContent = money(c.subtotal);
  $('bidMarkupAmt').textContent = money(c.markupAmt);
  $('bidTotal').textContent = money(c.total);
}

// Total loose export CY → truck loads at the configured capacity.
function renderHaulSummary() {
  const haulCY = bidComputed().haulCY;
  const el = $('bidHaul');
  if (!(haulCY > 0.05)) { el.hidden = true; return; }
  el.hidden = false;
  const cap = parseFloat($('bidTruck').value) || 0;
  const loads = cap > 0 ? Math.ceil(haulCY / cap) : 0;
  $('bidHaulCy').textContent = `${fmt(haulCY)} CY`;
  $('bidHaulLoads').textContent = `${fmt(loads)} load${loads === 1 ? '' : 's'}`;
}

// Update the money cells in place (keeps input focus/caret) without re-rendering.
function recomputeBidTotals() {
  const c = bidComputed();
  const body = $('bidTableBody');
  for (const r of c.rows) {
    const cell = body.querySelector(`.bid-ext[data-key="${r.key}"]`);
    if (cell) cell.textContent = money(r.ext);
  }
  body.querySelectorAll('.bid-subrow').forEach(tr => {
    const cell = tr.querySelector('.bid-subval');
    if (cell) cell.textContent = money(c.groupSubs[tr.dataset.group] || 0);
  });
  applyBidTotals(c);
}

function onBidPriceInput(e) {
  const key = e.target.dataset.key;
  const typeKey = e.target.dataset.type;
  const v = e.target.value;
  const prices = bidState().prices;
  if (v === '') delete prices[key]; else prices[key] = v;
  // remember a typed price at the type level for future projects (never wipe on clear)
  if (typeKey && v !== '') {
    const book = loadPriceBook();
    book[typeKey] = v;
    savePriceBook(book);
  }
  recomputeBidTotals();
  saveLocal();
}

function openBidReport() {
  const b = bidState();
  $('bidProject').value = b.project || (state.pdfName ? state.pdfName.replace(/\.pdf$/i, '') : '');
  $('bidPrep').value = b.preparedBy || '';
  $('bidMarkup').value = b.markup != null ? b.markup : '';
  if (!$('bidDate').value) $('bidDate').value = new Date().toLocaleDateString();
  $('bidTruck').value = els.inpTruck.value;
  fillLetterheadEditor();
  renderLetterhead();
  seedPricesFromBook();   // pre-fill matching lines from the remembered library
  renderBidReport();
  renderHaulSummary();
  $('bidReport').classList.remove('hidden');
}

function closeBidReport() { $('bidReport').classList.add('hidden'); }

function bidCSVDownload() {
  const c = bidComputed();
  if (!c.rows.length) { setMsg('Nothing to export yet — measure some quantities first.'); return; }
  const cell = s => {
    const t = String(s == null ? '' : s);
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const row = arr => arr.map(cell).join(',');
  const num = n => (Math.round((n || 0) * 100) / 100).toFixed(2);
  const lines = [
    row(['Bid summary']),
    row(['Project', $('bidProject').value]),
    row(['Prepared by', $('bidPrep').value]),
    row(['Date', $('bidDate').value]),
    '',
    row(['Group', 'Description', 'Quantity', 'Unit', 'Unit price', 'Extended']),
  ];
  for (const r of c.rows)
    lines.push(row([r.group, r.desc, Math.round(r.qty * 100) / 100, r.unit, num(r.price), num(r.ext)]));
  lines.push('');
  lines.push(row(['', '', '', '', 'Subtotal', num(c.subtotal)]));
  lines.push(row(['', '', '', '', `Overhead & profit (${c.markupPct}%)`, num(c.markupAmt)]));
  lines.push(row(['', '', '', '', 'Total bid', num(c.total)]));

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const base = ($('bidProject').value || (state.pdfName ? state.pdfName.replace(/\.pdf$/i, '') : 'bid')).trim() || 'bid';
  a.download = base.replace(/[^\w.-]+/g, '_') + '.bid.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('Bid exported as CSV.');
}

function printBid() {
  renderBidReport();   // make sure the printed numbers are current
  // isolate just the report for the print/PDF layout, then restore the app
  document.body.classList.add('printing-bid');
  const cleanup = () => {
    document.body.classList.remove('printing-bid');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();      // the browser's print dialog offers "Save as PDF"
  setTimeout(cleanup, 1500); // fallback if afterprint never fires
}

// ── Letterhead (device-local company profile, shared across projects) ──────────
let companyCache = null;
function loadCompany() {
  if (!companyCache) {
    try { companyCache = JSON.parse(localStorage.getItem('ebc-company')); } catch (_) { companyCache = null; }
    if (!companyCache || typeof companyCache !== 'object') companyCache = { name: '', details: '', logo: '' };
  }
  return companyCache;
}
function saveCompany(c) {
  companyCache = c;
  try { localStorage.setItem('ebc-company', JSON.stringify(c)); }
  catch (_) { setMsg('Could not save the letterhead — storage is full. Try a smaller logo.'); }
}

function fillLetterheadEditor() {
  const co = loadCompany();
  $('bidCompanyName').value = co.name || '';
  $('bidCompanyDetails').value = co.details || '';
}

function renderLetterhead() {
  const co = loadCompany();
  const img = $('bidLogoImg');
  if (co.logo) { img.src = co.logo; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  $('bidLogoRemove').hidden = !co.logo;
  const name = co.name ? `<div class="bid-co-name">${esc(co.name)}</div>` : '';
  const details = co.details ? `<div class="bid-co-details">${esc(co.details).replace(/\n/g, '<br>')}</div>` : '';
  $('bidCompanyRender').innerHTML = name + details;
  $('bidLetterhead').hidden = !(co.logo || co.name || co.details);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Cap the logo so it prints crisp and doesn't blow the localStorage quota.
function downscaleImage(dataUrl, maxW, maxH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(dataUrl); }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

$('bidCompanyName').addEventListener('input', e => {
  const co = loadCompany(); co.name = e.target.value; saveCompany(co); renderLetterhead();
});
$('bidCompanyDetails').addEventListener('input', e => {
  const co = loadCompany(); co.details = e.target.value; saveCompany(co); renderLetterhead();
});
$('bidLogoFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const scaled = await downscaleImage(await fileToDataURL(f), 400, 200);
    const co = loadCompany(); co.logo = scaled; saveCompany(co); renderLetterhead();
    setMsg('Logo added to the bid letterhead.');
  } catch (_) { setMsg('Could not load that image.'); }
  e.target.value = '';
});
$('bidLogoRemove').addEventListener('click', () => {
  const co = loadCompany(); co.logo = ''; saveCompany(co); renderLetterhead();
});
$('bidTruck').addEventListener('input', () => {
  els.inpTruck.value = $('bidTruck').value; // one capacity, shown in two places
  if (state.result) renderResults();
  renderHaulSummary();
  saveLocal();
});

$('btnBid').addEventListener('click', openBidReport);
$('bidClose').addEventListener('click', closeBidReport);
$('bidCsv').addEventListener('click', bidCSVDownload);
$('bidPrint').addEventListener('click', printBid);
$('bidForget').addEventListener('click', () => {
  savePriceBook({}); // clears the remembered library; this project's typed prices stay
  setMsg('Saved price library cleared. This project keeps the prices you already typed.');
});
$('bidProject').addEventListener('input', e => { bidState().project = e.target.value; saveLocal(); });
$('bidPrep').addEventListener('input', e => { bidState().preparedBy = e.target.value; saveLocal(); });
$('bidMarkup').addEventListener('input', e => { bidState().markup = e.target.value; recomputeBidTotals(); saveLocal(); });

/* ============================== Production log ============================== */
// Haul tickets + daily field reports kept against THIS job, so hauled CY can be
// tracked against the estimated export and the whole log exported/printed.

function prodState() { if (!state.production) state.production = defaultProduction(); return state.production; }
function todayISO() { return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD in local time

function openProdLog() {
  const name = bidState().project || (state.pdfName ? state.pdfName.replace(/\.pdf$/i, '') : 'Untitled project');
  $('prodProjectLine').textContent = `${name} · ${todayISO()}`;
  if (!$('htDate').value) $('htDate').value = todayISO();
  if (!$('drDate').value) $('drDate').value = todayISO();
  renderHaulTickets();
  renderDailyReports();
  $('prodLog').classList.remove('hidden');
}
function closeProdLog() { $('prodLog').classList.add('hidden'); }

function setProdTab(tab) {
  document.querySelectorAll('.prod-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('prodHaulPane').classList.toggle('hidden', tab !== 'haul');
  $('prodDailyPane').classList.toggle('hidden', tab !== 'daily');
}

function addHaulTicket() {
  const t = {
    id: randId(),
    date: $('htDate').value,
    ticket: $('htTicket').value.trim(),
    hauler: $('htHauler').value.trim(),
    material: $('htMaterial').value.trim(),
    qty: $('htQty').value,
    unit: $('htUnit').value,
    notes: $('htNotes').value.trim(),
  };
  const qty = parseFloat(t.qty) || 0;
  if (!(qty > 0) && !t.ticket && !t.material) { setMsg('Enter at least a quantity, ticket #, or material.'); return; }
  prodState().tickets.push(t);
  saveLocal();
  ['htTicket', 'htQty', 'htNotes'].forEach(id => { $(id).value = ''; }); // keep date/hauler/material/unit for fast entry
  renderHaulTickets();
  $('htTicket').focus();
}

function renderHaulTickets() {
  const list = prodState().tickets;
  const body = $('htBody');
  body.innerHTML = list.length
    ? list.map((t, i) => '<tr>' +
        `<td>${esc(t.date)}</td><td>${esc(t.ticket)}</td><td>${esc(t.hauler)}</td><td>${esc(t.material)}</td>` +
        `<td class="bid-num">${fmt(parseFloat(t.qty) || 0, 1)}</td><td>${esc(t.unit)}</td><td>${esc(t.notes)}</td>` +
        `<td><button class="wall-del" data-i="${i}" title="Delete this ticket">✕</button></td></tr>`).join('')
    : '<tr><td colspan="8" class="bid-empty">No haul tickets yet — add one above as loads leave the site.</td></tr>';
  body.querySelectorAll('.wall-del').forEach(b => b.addEventListener('click', () => {
    prodState().tickets.splice(parseInt(b.dataset.i, 10), 1);
    saveLocal();
    renderHaulTickets();
  }));

  let cy = 0, tons = 0, loads = 0;
  for (const t of list) {
    const q = parseFloat(t.qty) || 0;
    if (t.unit === 'tons') tons += q; else if (t.unit === 'loads') loads += q; else cy += q;
  }
  const est = bidComputed().haulCY;
  const parts = [`${list.length} ticket${list.length === 1 ? '' : 's'}`, `${fmt(cy)} CY`];
  if (tons) parts.push(`${fmt(tons)} tons`);
  if (loads) parts.push(`${fmt(loads)} loads`);
  let s = parts.join(' · ');
  if (est > 0.5) s += ` · vs est. export ${fmt(est)} CY (${Math.round(cy / est * 100)}%)`;
  $('htSummary').textContent = s;
}

function addDailyReport() {
  const d = {
    id: randId(),
    date: $('drDate').value,
    weather: $('drWeather').value.trim(),
    crew: $('drCrew').value,
    hours: $('drHours').value,
    notes: $('drNotes').value.trim(),
  };
  if (!d.notes && !d.weather && !(parseFloat(d.crew) > 0)) { setMsg('Enter crew, weather, or a work note for the day.'); return; }
  prodState().days.push(d);
  saveLocal();
  ['drWeather', 'drNotes'].forEach(id => { $(id).value = ''; });
  renderDailyReports();
  $('drNotes').focus();
}

function renderDailyReports() {
  const list = prodState().days;
  const body = $('drBody');
  body.innerHTML = list.length
    ? list.map((d, i) => '<tr>' +
        `<td>${esc(d.date)}</td><td>${esc(d.weather)}</td>` +
        `<td class="bid-num">${esc(d.crew)}</td><td class="bid-num">${esc(d.hours)}</td><td>${esc(d.notes)}</td>` +
        `<td><button class="wall-del" data-i="${i}" title="Delete this day">✕</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="bid-empty">No daily reports yet — log the crew, weather, and work each day.</td></tr>';
  body.querySelectorAll('.wall-del').forEach(b => b.addEventListener('click', () => {
    prodState().days.splice(parseInt(b.dataset.i, 10), 1);
    saveLocal();
    renderDailyReports();
  }));
  const manHours = list.reduce((s, d) => s + (parseFloat(d.crew) || 0) * (parseFloat(d.hours) || 0), 0);
  $('drSummary').textContent = `${list.length} day${list.length === 1 ? '' : 's'} · ${fmt(manHours, 1)} man-hours`;
}

function prodCSVDownload() {
  const p = prodState();
  if (!p.tickets.length && !p.days.length) { setMsg('Nothing to export yet — log a ticket or a day first.'); return; }
  const cell = s => {
    const t = String(s == null ? '' : s);
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const row = arr => arr.map(cell).join(',');
  const name = bidState().project || (state.pdfName ? state.pdfName.replace(/\.pdf$/i, '') : 'log');
  const lines = [row(['Production log']), row(['Project', name]), row(['Date', todayISO()]), ''];

  lines.push(row(['Haul tickets']));
  lines.push(row(['Date', 'Ticket', 'Hauler', 'Material', 'Qty', 'Unit', 'Notes']));
  let cy = 0;
  for (const t of p.tickets) {
    if (t.unit === 'CY') cy += parseFloat(t.qty) || 0;
    lines.push(row([t.date, t.ticket, t.hauler, t.material, parseFloat(t.qty) || 0, t.unit, t.notes]));
  }
  lines.push(row(['', '', '', '', cy, 'CY total', `${p.tickets.length} tickets`]));
  lines.push('');

  lines.push(row(['Daily reports']));
  lines.push(row(['Date', 'Weather', 'Crew', 'Hours', 'Man-hours', 'Work performed']));
  let mh = 0;
  for (const d of p.days) {
    const dmh = (parseFloat(d.crew) || 0) * (parseFloat(d.hours) || 0);
    mh += dmh;
    lines.push(row([d.date, d.weather, d.crew, d.hours, dmh, d.notes]));
  }
  lines.push(row(['', '', '', '', mh, 'man-hours total']));

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[^\w.-]+/g, '_') + '.production.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('Production log exported as CSV.');
}

function printProd() {
  renderHaulTickets();
  renderDailyReports();
  document.body.classList.add('printing-log');
  const cleanup = () => {
    document.body.classList.remove('printing-log');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 1500);
}

$('btnProd').addEventListener('click', openProdLog);
$('prodClose').addEventListener('click', closeProdLog);
$('prodCsv').addEventListener('click', prodCSVDownload);
$('prodPrint').addEventListener('click', printProd);
$('htAdd').addEventListener('click', addHaulTicket);
$('drAdd').addEventListener('click', addDailyReport);
document.querySelectorAll('.prod-tab').forEach(b => b.addEventListener('click', () => setProdTab(b.dataset.tab)));
$('prodHaulPane').querySelector('.prod-add').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addHaulTicket(); } });
$('prodDailyPane').querySelector('.prod-add').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDailyReport(); } });

/* ============================== Init ============================== */

// sidebar show/hide toggle (☰); persists across sessions
$('btnSidebar').addEventListener('click', () => {
  const hidden = document.body.classList.toggle('nosidebar');
  try { localStorage.setItem('ebc-sidebar', hidden ? 'hidden' : 'shown'); } catch (_) {}
});
try {
  if (localStorage.getItem('ebc-sidebar') === 'hidden')
    document.body.classList.add('nosidebar');
} catch (_) { /* default: shown */ }

// collapsible sidebar sections; collapsed set persists across sessions
(function initCollapsibles() {
  const KEY = 'ebc-collapsed';
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(KEY)) || []; } catch (_) { /* fresh */ }
  document.querySelectorAll('#sidebar section').forEach(sec => {
    const h = sec.querySelector('h3');
    if (!h) return;
    if (saved.includes(sec.id)) sec.classList.add('collapsed');
    h.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      const now = [...document.querySelectorAll('#sidebar section.collapsed')]
        .map(s => s.id).filter(Boolean);
      try { localStorage.setItem(KEY, JSON.stringify(now)); } catch (_) { /* private mode */ }
    });
  });
})();

(function init() {
  resizeCanvas();
  setTool('pan');
  refreshStatuses();
  refreshContourList();
  updateAlignStatus();
  let liveRestored = false;
  try {
    const saved = localStorage.getItem('ebc-project');
    if (saved && applyProjectData(JSON.parse(saved))) {
      liveRestored = true;
      const total = state.contours.existing.length + state.contours.proposed.length;
      if (total || state.calibration)
        setMsg(`Restored your last takeoff (${total} traced lines).`);
    }
  } catch (_) { /* ignore corrupt autosave */ }

  initProjects(liveRestored); // adopts/loads the current project + reopens its PDF
})();
