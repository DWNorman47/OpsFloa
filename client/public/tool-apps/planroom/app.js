/* Plan Room — viewer + markup + measure (M1 viewer core + M2 markups).
 * Built on the shared plan-tools engine (../shared/engine-*.js). Local-first:
 * projects live in this browser (IndexedDB 'planroom'), documents dedup by
 * content hash, markups live inside the project data (no server tables).
 * See docs/plans/plan-viewer-markup.md.
 */

import { createViewport } from '../shared/engine-view.js?v=1';
import { createStore, randId, hashBytes } from '../shared/engine-store.js?v=1';
import { openDoc, bytesToBase64, base64ToBytes, defaultRenderScale } from '../shared/engine-doc.js?v=1';
import { createModals, esc, fmt, money } from '../shared/engine-ui.js?v=1';
import { distToPolyline, pointSegDist, simplifyPts, polyLengthFt, polygonAreaFt2, pointInPolygon, dist, alignApply } from '../shared/engine-measure.js?v=1';

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
  scales: {},       // pageNum -> ftPerPx (per-sheet calibration; measures recompute live)
  serverId: null,     // takeoff_projects id when linked to a company-shared copy
  serverVersion: null, // its optimistic-concurrency version at open/last save
  roofPitch: 6,     // takeoff layer: main roof pitch (rise/12) for edge factors
  roofWaste: 12,    // takeoff layer: waste % applied to squares
  roofPrices: {},   // takeoff layer: unit-price overrides by bid-line key
  roofOP: 15,       // takeoff layer: overhead & profit %
  // takeoff layer: earthwork/cut-fill (sitework pack). existing & proposed are
  // page numbers; align maps proposed-page px -> existing-page px at compute.
  earthwork: { existingPage: null, proposedPage: null, align: { a: 1, b: 0, e: 0, f: 0 },
    gridFt: 5, shrink: 15, swell: 25, truckCap: 12, result: null },
};
let curSurface = 'existing';                 // which surface new contours/spots/pads belong to
const lastElev = { existing: null, proposed: null };

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

const MK_KINDS = ['cloud', 'rect', 'ellipse', 'arrow', 'line', 'freehand', 'highlight', 'text', 'callout', 'mlength', 'marea', 'mcount', 'plane', 'redge', 'ritem', 'contour', 'espot', 'epad', 'ebound'];
const MK_LABEL = {
  cloud: 'Cloud', rect: 'Rectangle', ellipse: 'Ellipse', arrow: 'Arrow', line: 'Line',
  freehand: 'Pen', highlight: 'Highlight', text: 'Text', callout: 'Callout',
  mlength: 'Length', marea: 'Area', mcount: 'Count',
  plane: 'Roof plane', redge: 'Roof edge', ritem: 'Roof item',
  contour: 'Contour', espot: 'Spot elev', epad: 'Pad', ebound: 'Earthwork boundary',
};
const MK_ICON = {
  cloud: '☁', rect: '▭', ellipse: '⬭', arrow: '↗', line: '╲',
  freehand: '✏', highlight: '🖍', text: 'T', callout: '🏷',
  mlength: '↔', marea: '⬠', mcount: '🔢',
  plane: '▰', redge: '╱', ritem: '⊕',
  contour: '⛰', espot: '◎', epad: '◫', ebound: '⬚',
};
const MEASURE_TOOLS = ['calibrate', 'mlength', 'marea', 'mcount'];
const CLICK_TOOLS = ['mlength', 'marea', 'mcount', 'plane', 'redge', 'ritem', 'contour', 'epad', 'ebound']; // click-built (vs drag; espot/align are special-cased)
const NEEDS_SCALE = ['mlength', 'marea', 'plane', 'redge']; // produce ft / SF / squares

/* ---- earthwork (sitework pack) helpers ---- */
// stable hue per elevation so equal elevations match visually; existing lighter
function elevColor(elev, surface) {
  const h = ((elev * 47) % 360 + 360) % 360;
  return surface === 'existing' ? `hsl(${h}, 70%, 62%)` : `hsl(${h}, 85%, 52%)`;
}
const surfaceContours = surface => state.markups.filter(m => m.kind === 'contour' && m.surface === surface);

// inverse of the align transform (proposed→existing) as another {a,b,e,f}
function alignInverse(M) {
  const s2 = M.a * M.a + M.b * M.b || 1;
  return {
    a: M.a / s2, b: -M.b / s2,
    e: -(M.a * M.e + M.b * M.f) / s2,
    f: (M.b * M.e - M.a * M.f) / s2,
  };
}

/* two-sheet alignment state: click a landmark on the existing sheet, then its
   match on the proposed sheet. 1 pair = shift; 2 pairs = shift+rotation+scale. */
let alignDraft = null;   // { pts:[existing-page pts], qs:[proposed-page pts], prevAlign }
let ghostOn = false;     // overlay the other sheet through the align transform

function earthworkCounts() {
  return {
    existing: state.markups.filter(m => (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') && m.surface === 'existing').length,
    proposed: state.markups.filter(m => (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') && m.surface === 'proposed').length,
    boundary: state.markups.some(m => m.kind === 'ebound'),
  };
}

/* ---- roofing takeoff (the $60 takeoff layer) ---- */
const EDGE_TYPES = ['eave', 'rake', 'ridge', 'hip', 'valley', 'flashing'];
const EDGE_LABEL = { eave: 'Eave', rake: 'Rake', ridge: 'Ridge', hip: 'Hip', valley: 'Valley', flashing: 'Flashing' };
const ITEM_TYPES = ['boot', 'vent', 'skylight', 'chimney'];
const ITEM_LABEL = { boot: 'Pipe boot', vent: 'Vent', skylight: 'Skylight', chimney: 'Chimney' };

// entitlement gate — the main app exposes tc_addons; the takeoff layer needs it
function hasTakeoffLayer() {
  try {
    const a = JSON.parse(localStorage.getItem('tc_addons') || '{}');
    return !!(a.takeoff || a.status === 'exempt' || a.status === 'trial');
  } catch (_) { return false; }
}

// pitch-correction: sloped length / area factor for a given rise-per-12
function slopeFactor(pitch) { const p = (pitch || 0) / 12; return Math.sqrt(1 + p * p); }
function hipValleyFactor(pitch) { const p = (pitch || 0) / 12; return Math.sqrt(1 + p * p / 2); }
function edgeFactor(etype, pitch) {
  if (etype === 'rake') return slopeFactor(pitch);
  if (etype === 'hip' || etype === 'valley') return hipValleyFactor(pitch);
  return 1; // eave, ridge, flashing measured directly on the plan
}
const planeSquares = (m, ftPerPx) => polygonAreaFt2(m.pts, ftPerPx) * slopeFactor(m.pitch) / 100;
const edgeFt = (m, ftPerPx) => polyLengthFt(m.pts, ftPerPx) * edgeFactor(m.etype, state.roofPitch);

// Roofing bid lines: materials/labor derived from the live takeoff, with
// editable unit prices. Sensible defaults; every quantity traces to the roof.
const DEFAULT_ROOF_PRICES = {
  tearoff: 50, install: 125, shingles: 38, ridgecap: 4.5, underlayment: 45,
  icewater: 1.75, dripedge: 1.25, starter: 1.1,
  item_boot: 30, item_vent: 35, item_skylight: 350, item_chimney: 450,
  ew_cut: 4.5, ew_fill: 6, ew_haul: 12, // earthwork $/CY (editable like the rest)
};
const priceFor = key => (state.roofPrices[key] != null ? state.roofPrices[key] : (DEFAULT_ROOF_PRICES[key] || 0));

function roofBidLines() {
  // A trade's FULL line list shows whenever that trade is in play at all —
  // the zero rows are the menu of what the bid can price (and where unit
  // prices get reviewed). A trade with no markups contributes nothing, so a
  // dirt-only bid has no roofing rows and vice versa.
  const lines = [];
  const roofingActive = state.markups.some(m => ['plane', 'redge', 'ritem'].includes(m.kind));
  if (roofingActive) {
    const T = roofingTotals();
    const sq = T.squaresWaste;
    const ridgeHip = (T.edges.ridge || 0) + (T.edges.hip || 0);
    const eaveRake = (T.edges.eave || 0) + (T.edges.rake || 0);
    const iceWater = (T.edges.eave || 0) + (T.edges.valley || 0);
    lines.push(
      { key: 'tearoff', label: 'Tear-off & disposal', qty: sq, unit: 'sq', q: 1 },
      { key: 'install', label: 'Shingle install (labor)', qty: sq, unit: 'sq', q: 1 },
      { key: 'shingles', label: 'Shingles (3 bundles/sq)', qty: Math.ceil(sq * 3), unit: 'bdl', q: 0 },
      { key: 'ridgecap', label: 'Ridge / hip cap', qty: ridgeHip, unit: 'LF', q: 0 },
      { key: 'underlayment', label: 'Underlayment (4 sq/roll)', qty: Math.ceil(sq / 4), unit: 'roll', q: 0 },
      { key: 'icewater', label: 'Ice & water (eave + valley)', qty: iceWater, unit: 'LF', q: 0 },
      { key: 'dripedge', label: 'Drip edge (eave + rake)', qty: eaveRake, unit: 'LF', q: 0 },
      { key: 'starter', label: 'Starter strip (eave + rake)', qty: eaveRake, unit: 'LF', q: 0 },
      ...ITEM_TYPES.filter(k => T.items[k]).map(k => ({
        key: 'item_' + k, label: ITEM_LABEL[k] + ' flashing', qty: T.items[k], unit: 'EA', q: 0,
      })),
    );
  }
  // earthwork lines from the cut/fill result (same math as the dirt panel)
  const R = state.earthwork.result;
  if (R) {
    const shrink = (Number(state.earthwork.shrink) || 0) / 100;
    const swell = (Number(state.earthwork.swell) || 0) / 100;
    const fillBank = R.fillCY / Math.max(0.01, 1 - shrink);
    const net = R.cutCY - fillBank;
    lines.push({ key: 'ew_cut', label: 'Earthwork — excavation (cut, bank)', qty: R.cutCY, unit: 'CY', q: 0 });
    lines.push({ key: 'ew_fill', label: 'Earthwork — fill placed (compacted)', qty: R.fillCY, unit: 'CY', q: 0 });
    if (net > 0) lines.push({ key: 'ew_haul', label: 'Earthwork — export haul-off (loose)', qty: net * (1 + swell), unit: 'CY', q: 0 });
  }
  for (const l of lines) { l.price = priceFor(l.key); l.ext = l.qty * l.price; }
  const subtotal = lines.reduce((a, l) => a + l.ext, 0);
  const op = subtotal * (Number(state.roofOP) || 0) / 100;
  return { lines, subtotal, op, total: subtotal + op };
}

// aggregate roofing quantities across the whole set (live)
function roofingTotals() {
  const wasteMul = 1 + (Number(state.roofWaste) || 0) / 100;
  let squares = 0, planes = 0, scaleMissing = false;
  const edges = {}, items = {};
  for (const m of state.markups) {
    const s = state.scales[m.page] || 0;
    if (m.kind === 'plane') { planes++; if (s) squares += planeSquares(m, s); else scaleMissing = true; }
    else if (m.kind === 'redge') { if (s) edges[m.etype] = (edges[m.etype] || 0) + edgeFt(m, s); else scaleMissing = true; }
    else if (m.kind === 'ritem') items[m.itype] = (items[m.itype] || 0) + m.pts.length;
  }
  return { squares, squaresWaste: squares * wasteMul, planes, edges, items, scaleMissing };
}

/* ---- per-sheet scale + measured values (recomputed live, never stored) ---- */

const pageFtPerPx = (p = state.page) => state.scales[p] || 0;

function measureValue(m) {
  const s = state.scales[m.page] || 0;
  if (m.kind === 'mcount') return `${m.pts.length} × ${m.text || 'items'}`;
  if (m.kind === 'ritem') return `${m.pts.length} × ${ITEM_LABEL[m.itype] || 'item'}`;
  if (!s) return 'no scale — 📏 this sheet';
  if (m.kind === 'mlength') {
    const ft = polyLengthFt(m.pts, s);
    return fmt(ft, ft < 100 ? 1 : 0) + ' ft';
  }
  if (m.kind === 'marea') {
    const sf = polygonAreaFt2(m.pts, s);
    return fmt(sf, 0) + ' SF' + (sf > 21780 ? ` (${fmt(sf / 43560, 2)} ac)` : '');
  }
  if (m.kind === 'plane') return `${fmt(m.pitch || 0)}/12 · ${fmt(planeSquares(m, s), 1)} sq`;
  if (m.kind === 'redge') {
    const ft = edgeFt(m, s);
    return `${EDGE_LABEL[m.etype] || 'Edge'} · ${fmt(ft, ft < 100 ? 1 : 0)} ft`;
  }
  if (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') {
    return `${m.surface === 'existing' ? 'EG' : 'FG'} ${m.elev != null ? fmt(m.elev, Number.isInteger(m.elev) ? 0 : 1) : '?'}`;
  }
  if (m.kind === 'ebound') return 'Limits of disturbance';
  return '';
}
const LINE_W = { S: 2, M: 4, L: 8 };
const FONT_S = { S: 12, M: 18, L: 28 };

// last-used color per tool (highlighter yellow; roofing kinds distinct)
const toolColors = { highlight: '#ffe066', plane: '#3fbf6f', redge: '#4da3ff', ritem: '#e0a03f' };
const DEFAULT_COLOR = '#e05555';

let tool = 'pan';
let selectedId = null;
let drag = null;      // {mode:'pan'|'draw'|'move'|'handle', ...}
let undoCapture = null;
let draft = null;     // click-built measure in progress {kind, pts, prev}
let calibPts = null;  // [firstPoint] while calibrating
let hoverW = null;    // cursor world pos while drafting (rubber band)

const centroid = pts => ({
  x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
  y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
});

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

// every mutation funnels through here: redraw, refresh lists, autosave
function markupsChanged() {
  renderMarkupList();
  if (typeof renderRoofPanel === 'function') renderRoofPanel();
  if (typeof renderDirtPanel === 'function') renderDirtPanel();
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
    case 'mlength': {
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      labelAt(ctx, m, mid.x, mid.y - (m.width || 4) * 2.5);
      break;
    }
    case 'marea': {
      if (m.pts.length >= 2) {
        ctx.beginPath();
        m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        ctx.globalAlpha = 0.12; ctx.fill();
        ctx.globalAlpha = 1; ctx.stroke();
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); labelAt(ctx, m, c.x, c.y); }
      break;
    }
    case 'mcount': case 'ritem': {
      const r = (m.width || 4) * 1.5 + 3;
      for (const p of m.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
      const c = centroid(m.pts);
      if (m.pts.length) labelAt(ctx, m, c.x, c.y - r * 2.4);
      break;
    }
    case 'plane': {
      if (m.pts.length >= 2) {
        ctx.beginPath();
        m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        ctx.globalAlpha = 0.14; ctx.fill();
        ctx.globalAlpha = 1; ctx.stroke();
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); labelAt(ctx, m, c.x, c.y); }
      break;
    }
    case 'redge': {
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      labelAt(ctx, m, mid.x, mid.y - (m.width || 4) * 2.5);
      break;
    }
    case 'contour': {
      const col = elevColor(m.elev || 0, m.surface);
      ctx.strokeStyle = col;
      if (m.surface === 'existing') ctx.setLineDash([11, 6]); // existing dashed, proposed solid
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      ctx.setLineDash([]);
      const e = m.pts[m.pts.length - 1];
      elevLabel(ctx, m, e.x, e.y, col);
      break;
    }
    case 'espot': {
      const col = elevColor(m.elev || 0, m.surface);
      const p = m.pts[0]; const r = (m.width || 4) * 1.4 + 2;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, r / 4), 0, Math.PI * 2); ctx.fill();
      elevLabel(ctx, m, p.x + r * 1.8, p.y, col);
      break;
    }
    case 'epad': {
      const col = elevColor(m.elev || 0, m.surface);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      if (m.pts.length >= 2) {
        ctx.beginPath(); m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
        ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); elevLabel(ctx, m, c.x, c.y, col); }
      break;
    }
    case 'ebound': {
      ctx.strokeStyle = '#e0a03f'; ctx.fillStyle = '#e0a03f';
      ctx.setLineDash([14, 8]);
      if (m.pts.length >= 2) {
        ctx.beginPath(); m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
        ctx.globalAlpha = 0.06; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
      }
      ctx.setLineDash([]);
      break;
    }
  }
  ctx.restore();
}

// elevation label (white-haloed, colored by elevation) for earthwork markups
function elevLabel(ctx, m, x, y, col) {
  const base = pageBase.get(m.page);
  const fs = Math.max(11, Math.min(28, (base ? base.width : 2800) / 120));
  ctx.save();
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const txt = m.elev != null ? fmt(m.elev, Number.isInteger(m.elev) ? 0 : 1) : '?';
  ctx.lineWidth = fs / 4.5; ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
  ctx.restore();
}

// Measured-value label: white-haloed bold text, sized to the sheet.
function labelAt(ctx, m, x, y) {
  const base = pageBase.get(m.page);
  const fs = Math.max(11, Math.min(30, (base ? base.width : 2800) / 110));
  ctx.save();
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineWidth = fs / 4.5;
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.strokeText(measureValue(m), x, y);
  ctx.fillStyle = m.color;
  ctx.fillText(measureValue(m), x, y);
  ctx.restore();
}

function drawCross(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / vp.view.zoom;
  ctx.beginPath();
  ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// alignment landmarks (and the predicted-spot hint on the proposed sheet)
function drawAlignDraft(ctx) {
  if (!alignDraft) return;
  const E = state.earthwork;
  const r = 12 / vp.view.zoom;
  if (state.page === E.existingPage) {
    for (const p of alignDraft.pts) drawCross(ctx, p.x, p.y, r, '#e0a03f');
  } else if (state.page === E.proposedPage) {
    for (const q of alignDraft.qs) drawCross(ctx, q.x, q.y, r, '#e0a03f');
    // where the current alignment predicts the pending landmark lands
    if (alignDraft.pts.length > alignDraft.qs.length && alignIsSet()) {
      const p = alignDraft.pts[alignDraft.pts.length - 1];
      const inv = alignInverse(E.align);
      const g = { x: inv.a * p.x - inv.b * p.y + inv.e, y: inv.b * p.x + inv.a * p.y + inv.f };
      drawCross(ctx, g.x, g.y, r * 1.3, '#3fbf6f');
    }
  }
}

// In-progress measure/calibration overlay (rubber-banded to the cursor).
function drawDraft(ctx) {
  if (calibPts && calibPts.length) {
    const a = calibPts[0], b = hoverW || a;
    ctx.save();
    ctx.strokeStyle = '#e0a03f';
    ctx.fillStyle = '#e0a03f';
    ctx.lineWidth = 2 / vp.view.zoom;
    ctx.setLineDash([8 / vp.view.zoom, 5 / vp.view.zoom]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 5 / vp.view.zoom, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (draft && draft.pts.length) {
    const pts = (hoverW && !POINT_KINDS.includes(draft.kind)) ? [...draft.pts, hoverW] : draft.pts;
    const previewExtra =
      draft.kind === 'plane' ? { pitch: state.roofPitch } :
      draft.kind === 'redge' ? { etype: ($('edgeType') || {}).value || 'eave' } :
      draft.kind === 'ritem' ? { itype: ($('itemType') || {}).value || 'boot' } : {};
    drawMarkup(ctx, {
      kind: draft.kind, pts, page: state.page,
      color: curColor(), width: curWidth(),
      text: POINT_KINDS.includes(draft.kind) ? '…' : undefined,
      ...previewExtra,
    });
  }
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
      case 'freehand': case 'mlength': case 'redge': case 'contour':
        if (distToPolyline(w.x, w.y, m.pts) < t) return m;
        break;
      case 'marea': case 'plane': case 'epad':
        if (pointInPolygon(w.x, w.y, m.pts) ||
            distToPolyline(w.x, w.y, [...m.pts, m.pts[0]]) < t) return m;
        break;
      case 'ebound':
        if (distToPolyline(w.x, w.y, [...m.pts, m.pts[0]]) < t) return m; // edge only (fill is faint)
        break;
      case 'mcount': case 'ritem':
        if (m.pts.some(p => dist(w.x, w.y, p.x, p.y) < (m.width || 4) * 1.5 + 3 + t)) return m;
        break;
      case 'espot':
        if (dist(w.x, w.y, m.pts[0].x, m.pts[0].y) < (m.width || 4) * 1.4 + 4 + t) return m;
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

// Rendered page canvases (with the scale they were rendered at), kept under a
// pixel budget; base sizes are tiny and kept for all pages.
const pageCanvas = new Map();  // pageNum -> { canvas, scale }
const pageBase = new Map();    // pageNum -> { width, height } at scale 1
const inflight = new Map();    // pageNum -> Promise
const PAGE_PIXEL_BUDGET = 60e6;   // ~240 MB of RGBA across cached pages
const PAGE_MAX_PIXELS = 22e6;     // per-page cap when sharpening zoomed views

async function baseSize(p) {
  if (!pageBase.has(p)) pageBase.set(p, await state.doc.baseSize(p));
  return pageBase.get(p);
}

// Density-aware base target: enough pixels for THIS screen at fit, not a
// fixed width — a blurry viewer is a broken viewer.
function dprTargetWidth() {
  const r = els.cv.parentElement.getBoundingClientRect();
  return Math.min(4200, Math.max(2600, r.width * devicePixelRatio * 1.25));
}
const scaleCapFor = base => Math.max(1, Math.min(4, Math.sqrt(PAGE_MAX_PIXELS / (base.width * base.height))));
const defaultScaleFor = base =>
  Math.min(defaultRenderScale(base.width, { targetWidth: dprTargetWidth(), maxScale: 3 }), scaleCapFor(base));

function ensurePage(p, wantScale) {
  if (!state.doc) return Promise.resolve();
  const cur = pageCanvas.get(p);
  if (cur && (!wantScale || cur.scale >= wantScale * 0.99)) return Promise.resolve();
  if (inflight.has(p)) return inflight.get(p);
  const job = (async () => {
    const base = await baseSize(p);
    const scale = wantScale ? Math.min(wantScale, scaleCapFor(base)) : defaultScaleFor(base);
    const have = pageCanvas.get(p);
    if (have && have.scale >= scale * 0.99) return;
    const canvas = await state.doc.renderPage(p, scale);
    pageCanvas.delete(p);                    // re-insert = most recently used
    pageCanvas.set(p, { canvas, scale });
    evictPages();
    vp.requestDraw();
  })().finally(() => inflight.delete(p));
  inflight.set(p, job);
  return job;
}

function evictPages() {
  let total = 0;
  for (const { canvas } of pageCanvas.values()) total += canvas.width * canvas.height;
  for (const k of [...pageCanvas.keys()]) {
    if (total <= PAGE_PIXEL_BUDGET || pageCanvas.size <= 1) break;
    if (k === state.page) continue;
    const e = pageCanvas.get(k);
    total -= e.canvas.width * e.canvas.height;
    pageCanvas.delete(k);
  }
}

// Progressive sharpening: once zooming settles, re-render the current page at
// the resolution the view actually needs (bounded by the per-page pixel cap).
let sharpenTimer = null;
function maybeSharpen(entry, base) {
  const needed = Math.min(vp.view.zoom * devicePixelRatio, scaleCapFor(base));
  if (needed > entry.scale * 1.25) {
    clearTimeout(sharpenTimer);
    const p = state.page;
    sharpenTimer = setTimeout(() => { if (state.page === p) ensurePage(p, needed); }, 200);
  }
}

function paint(ctx) {
  vp.beginPaint(ctx);
  const entry = pageCanvas.get(state.page);
  const base = pageBase.get(state.page);
  // world units = base-scale px, so markups are resolution-independent
  if (entry && base) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(entry.canvas, 0, 0, base.width, base.height);
    maybeSharpen(entry, base);
  } else if (state.doc) ensurePage(state.page);
  // ghost: the OTHER earthwork sheet (image + its contours) through the align
  // transform, so the fit can be eyeballed
  const EW = state.earthwork;
  if (ghostOn && state.doc && EW.existingPage && EW.proposedPage && EW.existingPage !== EW.proposedPage &&
      (state.page === EW.existingPage || state.page === EW.proposedPage)) {
    const onExisting = state.page === EW.existingPage;
    const other = onExisting ? EW.proposedPage : EW.existingPage;
    const M = onExisting ? EW.align : alignInverse(EW.align);
    const oEntry = pageCanvas.get(other), oBase = pageBase.get(other);
    if (oEntry && oBase) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.transform(M.a, M.b, -M.b, M.a, M.e, M.f);
      ctx.drawImage(oEntry.canvas, 0, 0, oBase.width, oBase.height);
      for (const m of state.markups)
        if (m.page === other && ['contour', 'espot', 'epad'].includes(m.kind)) drawMarkup(ctx, m);
      ctx.restore();
    } else if (state.doc) ensurePage(other);
  }
  if (heatGrid && state.page === heatGrid.page) drawHeat(ctx);
  for (const m of state.markups) if (m.page === state.page) drawMarkup(ctx, m);
  if (drag && drag.mode === 'draw' && drag.markup) drawMarkup(ctx, drag.markup);
  drawDraft(ctx);
  drawAlignDraft(ctx);
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
  // render at display density ×1.5 supersample — CSS scales it down sharp
  // (at 1:1 CSS px, dense notes sheets collapse into black smears)
  const canvas = await state.doc.renderPage(p, (THUMB_W * devicePixelRatio * 1.5) / base.width);
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
  cancelDraft();
  if (alignDraft && t !== 'align') alignDraft = null; // keep any applied shift; drop the in-progress pair
  drag = null;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  els.cv.classList.toggle('crosshair', t !== 'pan' && t !== 'select');
  // per-tool color memory (highlighter yellow, ink red, user overrides stick)
  if (t !== 'pan' && t !== 'select') els.mkColor.value = toolColors[t] || DEFAULT_COLOR;
  if (t === 'calibrate') {
    setMsg(pageFtPerPx()
      ? `Sheet ${state.page} already has a scale — recalibrating replaces it. Click the first point.`
      : 'Click two points a known distance apart (a dimension line, a scale bar).');
  } else if (NEEDS_SCALE.includes(t) && !pageFtPerPx()) {
    setMsg('This sheet has no scale yet — calibrate first (📏).');
  } else if (t === 'plane') {
    setMsg(`Trace a roof face; finish with Enter/double-click, then set its pitch. Main pitch ${state.roofPitch}/12.`);
  } else if (t === 'redge') {
    setMsg(`Trace a ${EDGE_LABEL[($('edgeType') || {}).value] || 'roof'} edge; hip/valley/rake are pitch-corrected off the ${state.roofPitch}/12 main pitch.`);
  } else if (t === 'contour') {
    setMsg(`Trace a ${curSurface} contour; finish with Enter/double-click, then type its elevation.`);
  } else if (t === 'espot') {
    setMsg(`Click a ${curSurface} spot grade — you'll type its elevation.`);
  } else if (t === 'epad') {
    setMsg(`Trace a ${curSurface} building pad (flat at one elevation); Enter/double-click to close.`);
  } else if (t === 'ebound') {
    setMsg('Trace the limits of disturbance — the area gridded for cut/fill. Enter/double-click to close.');
  } else if (t === 'align') {
    const E = state.earthwork;
    setMsg((!E.existingPage || !E.proposedPage)
      ? 'Designate the Existing and Proposed sheets in the ⛰ Dirt panel first.'
      : `Click a sharp landmark on the Existing sheet (page ${E.existingPage}) — a property corner works well.`);
  }
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

  // scale calibration: two clicks, then the real-world distance
  if (tool === 'calibrate') {
    const p = { x: w.x, y: w.y };
    if (!calibPts || !calibPts.length) {
      calibPts = [p];
      setMsg('Now click the second point of the known distance.');
    } else {
      const a = calibPts[0];
      calibPts = null;
      const px = dist(a.x, a.y, p.x, p.y);
      if (px < 4) { setMsg('Those points are on top of each other — click two points a known distance apart.'); vp.requestDraw(); return; }
      modals.askNumber('Real-world distance between the two points',
        "Feet (e.g. 50). Sets this sheet's scale — every measurement on it updates live.", '', null)
        .then(ftv => {
          if (ftv && ftv > 0) {
            state.scales[state.page] = ftv / px;
            scheduleSave(); renderMarkupList();
            setMsg(`Scale set for sheet ${state.page}. Measurements on this sheet are live.`);
          } else setMsg('Calibration cancelled.');
          vp.requestDraw();
        });
    }
    vp.requestDraw();
    return;
  }

  // spot elevation: one click = one markup + elevation prompt
  if (tool === 'espot') {
    const prev = snapshot();
    const surf = curSurface;
    const m = { id: randId(), page: state.page, kind: 'espot', surface: surf, color: curColor(), width: curWidth(), pts: [{ x: w.x, y: w.y }], elev: null, created: Date.now() };
    state.markups.push(m);
    pushUndo(prev);
    markupsChanged();
    modals.askNumber(`Spot elevation (ft) — ${surf}`, 'e.g. 812.5', lastElev[surf] != null ? lastElev[surf] : '', 1)
      .then(v => { if (v != null) { m.elev = v; lastElev[surf] = v; markupsChanged(); } });
    return;
  }

  // two-sheet alignment: landmark on existing, its match on proposed
  if (tool === 'align') {
    const E = state.earthwork;
    if (!E.existingPage || !E.proposedPage) { setMsg('Designate the Existing and Proposed sheets first (⛰ Dirt panel).'); return; }
    if (E.existingPage === E.proposedPage) { setMsg('Both surfaces are on the same sheet — no alignment needed.'); return; }
    if (!alignDraft) alignDraft = { pts: [], qs: [], prevAlign: { ...E.align } };
    if (alignDraft.pts.length === alignDraft.qs.length) {
      // expecting a landmark on the EXISTING sheet
      if (state.page !== E.existingPage) { setPage(E.existingPage); setMsg(`Jumped to the Existing sheet (page ${E.existingPage}) — click a sharp landmark (a property corner).`); return; }
      alignDraft.pts.push({ x: w.x, y: w.y });
      setPage(E.proposedPage);
      setMsg('Now click that SAME landmark on the Proposed sheet' + (alignIsSet() ? ' (the ⌖ cross marks where the current alignment predicts it).' : '.'));
    } else {
      // its match on the PROPOSED sheet
      if (state.page !== E.proposedPage) { setPage(E.proposedPage); setMsg(`Jumped to the Proposed sheet (page ${E.proposedPage}) — click the matching landmark.`); return; }
      alignDraft.qs.push({ x: w.x, y: w.y });
      if (alignDraft.qs.length === 1) {
        const p = alignDraft.pts[0], q = alignDraft.qs[0];
        E.align = { a: 1, b: 0, e: p.x - q.x, f: p.y - q.y }; // pair 1: shift only
        scheduleSave(); renderDirtPanel();
        setPage(E.existingPage);
        setMsg('Shift applied. Press Enter to finish, or click a SECOND landmark (far from the first) to also fix rotation & scale.');
      } else {
        const [p1, p2] = alignDraft.pts, [q1, q2] = alignDraft.qs;
        const dqx = q2.x - q1.x, dqy = q2.y - q1.y;
        const dpx = p2.x - p1.x, dpy = p2.y - p1.y;
        const len2 = dqx * dqx + dqy * dqy;
        if (Math.sqrt(len2) < 20) {
          alignDraft.pts.pop(); alignDraft.qs.pop();
          setPage(E.existingPage);
          setMsg('Those landmarks are too close together — click a second landmark farther from the first.');
          vp.requestDraw();
          return;
        }
        const a = (dqx * dpx + dqy * dpy) / len2;
        const b = (dqx * dpy - dqy * dpx) / len2;
        E.align = { a, b, e: p1.x - (a * q1.x - b * q1.y), f: p1.y - (b * q1.x + a * q1.y) };
        alignDraft = null;
        scheduleSave(); renderDirtPanel();
        setMsg('Sheets aligned (shift + rotation + scale). Turn on Ghost in the ⛰ Dirt panel to double-check the fit.');
        setTool('pan');
      }
    }
    vp.requestDraw();
    return;
  }

  // click-built tools: measures (length/area/count) + roofing (plane/edge/item)
  if (CLICK_TOOLS.includes(tool)) {
    if (NEEDS_SCALE.includes(tool) && !pageFtPerPx()) {
      setMsg('This sheet has no scale yet — calibrate it first (📏): click two points a known distance apart.');
      setTool('calibrate');
      return;
    }
    if (!draft) draft = { kind: tool, pts: [], prev: snapshot() };
    draft.pts.push({ x: w.x, y: w.y });
    if (draft.kind === 'mcount' || draft.kind === 'ritem') setMsg(`${draft.pts.length} clicked — Enter or double-click to finish.`);
    vp.requestDraw();
    return;
  }

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
  if (draft || calibPts) { // rubber-band the in-progress measure/calibration
    const sp = screenPt(e);
    hoverW = vp.screenToWorld(sp.x, sp.y);
    vp.requestDraw();
  }
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

/* ---- click-built measure drafts: commit / cancel ---- */

const CLOSED_KINDS = ['marea', 'plane', 'epad', 'ebound']; // 3+ pts, closed polygon
const POINT_KINDS = ['mcount', 'ritem'];      // 1+ pts, no rubber band

function commitDraft() {
  if (!draft) return;
  const d = draft;
  draft = null; hoverW = null;
  const pts = d.pts;
  // double-click leaves two points on top of each other — drop the duplicate
  if (pts.length >= 2 &&
      dist(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[pts.length - 2].x, pts[pts.length - 2].y) < 3 / vp.view.zoom) pts.pop();
  const min = CLOSED_KINDS.includes(d.kind) ? 3 : POINT_KINDS.includes(d.kind) ? 1 : 2;
  if (pts.length < min) { vp.requestDraw(); return; }
  const extra = {};
  if (d.kind === 'plane') extra.pitch = state.roofPitch;
  else if (d.kind === 'redge') extra.etype = $('edgeType') ? $('edgeType').value : 'eave';
  else if (d.kind === 'ritem') extra.itype = $('itemType') ? $('itemType').value : 'boot';
  else if (d.kind === 'contour' || d.kind === 'epad') extra.surface = curSurface;
  if (d.kind === 'ebound') state.markups = state.markups.filter(m => m.kind !== 'ebound'); // one boundary
  const finish = text => {
    state.markups.push({
      id: randId(), page: state.page, kind: d.kind, color: curColor(),
      width: curWidth(), pts, text, created: Date.now(), ...extra,
    });
    pushUndo(d.prev);
    markupsChanged();
    // the measurement is the ad: nudge base-tier users toward the takeoff layer
    if ((d.kind === 'marea' || d.kind === 'mlength') && !hasTakeoffLayer()) {
      const m = state.markups[state.markups.length - 1];
      setMsg(`${measureValue(m)} — turn measurements into a priced takeoff & bid: 🔒 Takeoff layer.`);
    }
    if (d.kind === 'plane') {
      modals.askNumber(`Roof plane pitch (rise per 12)`, 'e.g. 6 for 6/12. Sloped area & squares update live.', state.roofPitch, 1)
        .then(v => { if (v != null && v >= 0) { const m = state.markups[state.markups.length - 1]; if (m && m.kind === 'plane') { m.pitch = v; markupsChanged(); } } });
    } else if (d.kind === 'contour' || d.kind === 'epad') {
      const surf = extra.surface;
      modals.askNumber(`${d.kind === 'contour' ? 'Contour' : 'Pad'} elevation (ft) — ${surf === 'existing' ? 'existing' : 'proposed'}`,
        'e.g. 812.5', lastElev[surf] != null ? lastElev[surf] : '', 1)
        .then(v => { if (v != null) { const m = state.markups[state.markups.length - 1]; if (m && (m.kind === 'contour' || m.kind === 'epad')) { m.elev = v; lastElev[surf] = v; markupsChanged(); } } });
    }
  };
  if (d.kind === 'mcount') modals.askText('What are you counting?', `${pts.length} clicked`, '').then(t => finish(t || 'items'));
  else finish(undefined);
}

function cancelDraft() {
  draft = null; calibPts = null; hoverW = null;
  vp.requestDraw();
}

// double-click: finish a measure draft, or edit a note's text
els.cv.addEventListener('dblclick', e => {
  if (!state.doc) return;
  if (draft) { commitDraft(); return; }
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  const hit = hitMarkup(vp.ctx, w);
  if (hit && (hit.kind === 'text' || hit.kind === 'callout')) {
    selectedId = hit.id;
    openOverlay({ mode: 'edit', markup: hit });
    return;
  }
  // double-click an earthwork markup to fix its elevation
  if (hit && (hit.kind === 'contour' || hit.kind === 'espot' || hit.kind === 'epad')) {
    selectedId = hit.id;
    vp.requestDraw();
    modals.askNumber(`${MK_LABEL[hit.kind]} elevation (ft) — ${hit.surface}`, 'e.g. 812.5', hit.elev != null ? hit.elev : '', 1)
      .then(v => {
        if (v == null) return;
        const prev = snapshot();
        hit.elev = v;
        lastElev[hit.surface] = v;
        pushUndo(prev);
        markupsChanged();
      });
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

$('btnList').addEventListener('click', () => {
  els.markupPanel.classList.toggle('hidden');
  if (!els.markupPanel.classList.contains('hidden')) { $('roofPanel').classList.add('hidden'); $('dirtPanel').classList.add('hidden'); renderMarkupList(); }
});
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
    row.querySelector('.grow').textContent =
      (m.kind === 'mcount' || m.kind === 'ritem') ? measureValue(m)
      : (m.kind === 'mlength' || m.kind === 'marea' || m.kind === 'plane' || m.kind === 'redge') ? `${MK_LABEL[m.kind]} — ${measureValue(m)}`
      : m.text ? m.text.split('\n')[0] : MK_LABEL[m.kind];
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

/* ============================== Roofing takeoff panel (takeoff layer) ============================== */

function renderRoofPanel() {
  const panel = $('roofPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const T = roofingTotals();
  const rows = [];
  rows.push(`<div class="roof-tot big"><span>Squares (with waste)</span><span class="v">${fmt(T.squaresWaste, 1)} sq</span></div>`);
  rows.push(`<div class="roof-tot"><span>Base squares</span><span class="v">${fmt(T.squares, 1)} sq</span></div>`);
  rows.push(`<div class="roof-tot"><span>Roof planes</span><span class="v">${T.planes}</span></div>`);
  if (T.scaleMissing) rows.push(`<div class="hint" style="margin:6px 0">Some sheets aren't calibrated (📏) — those planes/edges are excluded.</div>`);

  const edgeKeys = EDGE_TYPES.filter(k => T.edges[k]);
  if (edgeKeys.length) {
    rows.push('<div class="roof-sub">Edges (LF)</div>');
    for (const k of edgeKeys) rows.push(`<div class="roof-tot"><span>${EDGE_LABEL[k]}</span><span class="v">${fmt(T.edges[k], 0)} ft</span></div>`);
  }
  const itemKeys = ITEM_TYPES.filter(k => T.items[k]);
  if (itemKeys.length) {
    rows.push('<div class="roof-sub">Items (EA)</div>');
    for (const k of itemKeys) rows.push(`<div class="roof-tot"><span>${ITEM_LABEL[k]}</span><span class="v">${T.items[k]}</span></div>`);
  }
  if (!T.planes && !edgeKeys.length && !itemKeys.length) {
    rows.push('<div class="mk-empty">No roof takeoff yet — trace a plane (▰) and set its pitch, then add edges (╱) and items (⊕).</div>');
  }
  $('roofBody').innerHTML = rows.join('');
}

function applyTakeoffGate() {
  document.body.classList.toggle('has-takeoff', hasTakeoffLayer());
}

// push loaded roof settings into the inputs + refresh the panel
function syncRoofInputs() {
  if ($('roofPitch')) { $('roofPitch').value = state.roofPitch; $('roofWaste').value = state.roofWaste; }
  renderRoofPanel();
}

if ($('roofPitch')) {
  $('roofPitch').value = state.roofPitch;
  $('roofWaste').value = state.roofWaste;
  $('roofPitch').addEventListener('change', e => {
    state.roofPitch = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
    e.target.value = state.roofPitch;
    scheduleSave(); renderRoofPanel(); renderMarkupList(); vp.requestDraw();
  });
  $('roofWaste').addEventListener('change', e => {
    state.roofWaste = Math.max(0, Math.min(40, parseFloat(e.target.value) || 0));
    e.target.value = state.roofWaste;
    scheduleSave(); renderRoofPanel();
  });
}
$('btnRoof').addEventListener('click', () => {
  $('roofPanel').classList.toggle('hidden');
  if (!$('roofPanel').classList.contains('hidden')) { els.markupPanel.classList.add('hidden'); $('dirtPanel').classList.add('hidden'); renderRoofPanel(); }
});
$('btnUpsell').addEventListener('click', () => {
  setMsg('Takeoff layer ($60/mo add-on): turn your measurements into roofing squares, pitch-corrected edges, materials, and a priced, branded bid. Add it from Billing.');
});

/* ---- roofing bid ---- */
function renderRoofBid() {
  const { lines, subtotal, op, total } = roofBidLines();
  const head = '<thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit price</th><th class="num">Extended</th></tr></thead>';
  const body = lines.map(l =>
    `<tr>
      <td>${esc(l.label)}</td>
      <td class="num">${fmt(l.qty, l.q || 0)}</td>
      <td>${l.unit}</td>
      <td class="num"><input class="price" type="number" min="0" step="0.01" data-key="${l.key}" value="${l.price}"></td>
      <td class="num">${money(l.ext)}</td>
    </tr>`).join('');
  $('bidTable').innerHTML = head + '<tbody>' + (lines.length ? body : '<tr><td colspan="5" class="mk-empty">No takeoff yet — trace roof planes/edges/items, or run the earthwork cut/fill.</td></tr>') + '</tbody>';
  $('bidTotals').innerHTML =
    `Subtotal: <b>${money(subtotal)}</b><br>` +
    `Overhead &amp; profit (${fmt(state.roofOP)}%): <b>${money(op)}</b><br>` +
    `<span class="grand">Total: ${money(total)}</span>`;
  $('bidTable').querySelectorAll('input.price').forEach(inp => {
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      state.roofPrices[inp.dataset.key] = isNaN(v) ? 0 : v;
      scheduleSave();
      renderRoofBid();
    });
  });
}

function openRoofBid() {
  $('bidOP').value = state.roofOP;
  renderRoofBid();
  $('roofBid').classList.remove('hidden');
}

function printRoofBid() {
  document.body.classList.add('printing-bid');
  const done = () => { document.body.classList.remove('printing-bid'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000); // Safari sometimes skips afterprint
}

function bidCsv() {
  const { lines, subtotal, op, total } = roofBidLines();
  const qc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['Item', 'Qty', 'Unit', 'Unit price', 'Extended'].map(qc).join(',')];
  for (const l of lines) rows.push([l.label, fmt(l.qty, l.q || 0), l.unit, l.price, l.ext.toFixed(2)].map(qc).join(','));
  rows.push('');
  rows.push([qc('Subtotal'), '', '', '', qc(subtotal.toFixed(2))].join(','));
  rows.push([qc(`Overhead & profit ${fmt(state.roofOP)}%`), '', '', '', qc(op.toFixed(2))].join(','));
  rows.push([qc('Total'), '', '', '', qc(total.toFixed(2))].join(','));
  download(new Blob([rows.join('\r\n')], { type: 'text/csv' }), safeName() + '-takeoff-bid.csv');
}

$('btnBid').addEventListener('click', openRoofBid);
$('bidClose').addEventListener('click', () => $('roofBid').classList.add('hidden'));
$('roofBid').addEventListener('click', e => { if (e.target === $('roofBid')) $('roofBid').classList.add('hidden'); });
$('bidOP').addEventListener('input', e => {
  state.roofOP = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
  scheduleSave();
  renderRoofBid();
});
$('bidPrint').addEventListener('click', printRoofBid);
$('bidCsv').addEventListener('click', bidCsv);

/* ---- earthwork (sitework pack, S1: trace + designate; compute = next slice) ---- */
const alignIsSet = () => { const a = state.earthwork.align; return !(a.a === 1 && a.b === 0 && a.e === 0 && a.f === 0); };

function renderDirtPanel() {
  const panel = $('dirtPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const E = state.earthwork;
  const c = earthworkCounts();
  const rows = [];
  rows.push('<div class="roof-sub">Sheets</div>');
  rows.push(`<div class="dirt-row"><span>Existing sheet</span><span class="v">${E.existingPage ? 'page ' + E.existingPage : '—'}</span></div>`);
  rows.push(`<button class="btn tiny dirt-btn" data-act="set-existing">Set current page (${state.page}) as Existing</button>`);
  rows.push(`<div class="dirt-row"><span>Proposed sheet</span><span class="v">${E.proposedPage ? 'page ' + E.proposedPage : '—'}</span></div>`);
  rows.push(`<button class="btn tiny dirt-btn" data-act="set-proposed">Set current page (${state.page}) as Proposed</button>`);
  rows.push(`<div class="dirt-row"><span>Alignment</span><span class="v">${alignIsSet() ? 'set' : 'not set'} · use ⌖</span></div>`);
  rows.push(`<label class="dirt-row" style="cursor:pointer"><span>Ghost the other sheet</span><input type="checkbox" id="ghostChk" ${ghostOn ? 'checked' : ''}></label>`);

  rows.push('<div class="roof-sub">Traced</div>');
  rows.push(`<div class="dirt-row"><span>Existing contours / pads</span><span class="v">${c.existing}</span></div>`);
  rows.push(`<div class="dirt-row"><span>Proposed contours / pads</span><span class="v">${c.proposed}</span></div>`);
  rows.push(`<div class="dirt-row"><span>Boundary</span><span class="v">${c.boundary ? 'set' : '—'}</span></div>`);
  rows.push(`<div class="hint" style="margin:6px 0">New contours are <b>${curSurface}</b> (toolbar toggle). Existing draws dashed, proposed solid; type each elevation.</div>`);

  rows.push('<div class="roof-sub">Earthwork</div>');
  rows.push('<div class="dirt-set">Grid <input type="number" id="ewGrid" min="0.5" step="0.5"> ft · Shrink <input type="number" id="ewShrink" min="0"> % · Swell <input type="number" id="ewSwell" min="0"> % · Truck <input type="number" id="ewTruck" min="1"> CY</div>');
  rows.push('<button class="btn go dirt-btn" data-act="calc">∑ Calculate Cut / Fill</button>');
  if (E.result) {
    // same math as the standalone tool: fill needs bank dirt ÷(1−shrink);
    // net = cut − fillBank (+ = surplus leaves site); export hauls loose ×(1+swell)
    const R = E.result;
    const shrink = (Number(E.shrink) || 0) / 100;
    const swell = (Number(E.swell) || 0) / 100;
    const fillBank = R.fillCY / Math.max(0.01, 1 - shrink);
    const net = R.cutCY - fillBank;
    const isExport = net >= 0;
    const haul = Math.abs(net) * (isExport ? 1 + swell : 1);
    const loads = E.truckCap > 0 ? Math.ceil(haul / E.truckCap) : 0;
    rows.push('<div class="roof-sub">Results</div>');
    rows.push(`<div class="dirt-row"><span>Disturbed area</span><span class="v">${fmt(R.areaFt2 / 43560, 2)} ac</span></div>`);
    rows.push(`<div class="dirt-row"><span>Grid cell used</span><span class="v">${fmt(R.gridFt, 1)} ft</span></div>`);
    rows.push(`<div class="dirt-row"><span>Cut (bank)</span><span class="v">${fmt(R.cutCY, 0)} CY</span></div>`);
    rows.push(`<div class="dirt-row"><span>Fill (compacted)</span><span class="v">${fmt(R.fillCY, 0)} CY</span></div>`);
    rows.push(`<div class="dirt-row"><span>Fill in bank CY</span><span class="v">${fmt(fillBank, 0)} CY</span></div>`);
    rows.push(`<div class="dirt-row"><b>${isExport ? 'EXPORT off site' : 'IMPORT to site'}</b><span class="v"><b>${fmt(Math.abs(net), 0)} CY</b></span></div>`);
    if (isExport) rows.push(`<div class="dirt-row"><span>≈ truck volume (loose)</span><span class="v">${fmt(haul, 0)} CY</span></div>`);
    if (isExport && loads > 0) rows.push(`<div class="dirt-row"><span>≈ haul loads @ ${fmt(E.truckCap)} CY</span><span class="v">${fmt(loads, 0)}</span></div>`);
    rows.push('<div class="hint" style="margin:4px 0">Estimating numbers — verify scale, alignment, and traces before you bid.</div>');
  }
  const body = $('dirtBody');
  body.innerHTML = rows.join('');
  $('ewGrid').value = E.gridFt; $('ewShrink').value = E.shrink; $('ewSwell').value = E.swell; $('ewTruck').value = E.truckCap;
  const numHandler = (el, key, min, def) => el.addEventListener('change', e => { E[key] = Math.max(min, parseFloat(e.target.value) || def); e.target.value = E[key]; scheduleSave(); });
  numHandler($('ewGrid'), 'gridFt', 0.5, 5);
  numHandler($('ewShrink'), 'shrink', 0, 15);
  numHandler($('ewSwell'), 'swell', 0, 25);
  numHandler($('ewTruck'), 'truckCap', 1, 12);
  body.querySelector('[data-act="set-existing"]').addEventListener('click', () => { E.existingPage = state.page; scheduleSave(); renderDirtPanel(); });
  body.querySelector('[data-act="set-proposed"]').addEventListener('click', () => { E.proposedPage = state.page; scheduleSave(); renderDirtPanel(); });
  body.querySelector('[data-act="calc"]').addEventListener('click', calculateCutFill);
  const gk = body.querySelector('#ghostChk');
  if (gk) gk.addEventListener('change', e => { ghostOn = e.target.checked; vp.requestDraw(); });
}

function syncDirtInputs() { renderDirtPanel(); }

/* Cut/fill compute — ported from the standalone sitework tool (see
   shared/PARITY.md). One adaptation: sitework stores both surfaces in one
   world space; Plan Room keeps geometry in native page coords and maps the
   PROPOSED surface into existing space through the align transform here. */

let heatGrid = null; // session-only heat overlay {page,x0,y0,cellPx,cols,rows,dz,maxAbs}

// Classic linear-between-contours: elevation at a point = distance-weighted
// blend of the nearest contour and the nearest contour at a DIFFERENT
// elevation; flat inside pads. (Copied verbatim from sitework.)
function makeInterpolator(contours) {
  const n = contours.length;
  const dists = new Float64Array(n);
  const pads = contours.filter(c => c.pad);
  const rings = contours.map(c => c.pad ? c.pts.concat([c.pts[0]]) : c.pts);
  return function (px, py) {
    for (const p of pads)
      if (pointInPolygon(px, py, p.pts)) return p.elev;
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

// A surface's contours/spots/pads, mapped into EXISTING-sheet space.
function surfaceInputs(surface) {
  const E = state.earthwork;
  const wantPage = surface === 'existing' ? E.existingPage : E.proposedPage;
  const mapPt = (surface === 'proposed' && E.existingPage !== E.proposedPage)
    ? p => alignApply(E.align, p)
    : p => ({ x: p.x, y: p.y });
  return state.markups
    .filter(m => ['contour', 'espot', 'epad'].includes(m.kind) && m.surface === surface && m.elev != null && m.page === wantPage)
    .map(m => ({ pts: m.pts.map(mapPt), elev: m.elev, pad: m.kind === 'epad' }));
}

async function calculateCutFill() {
  const E = state.earthwork;
  const problems = [];
  if (!state.doc) problems.push('open the plan set');
  if (!E.existingPage) problems.push('designate the Existing sheet');
  if (!E.proposedPage) problems.push('designate the Proposed sheet');
  const ftPerPx = E.existingPage ? (state.scales[E.existingPage] || 0) : 0;
  if (E.existingPage && !ftPerPx) problems.push(`calibrate the Existing sheet (📏 on page ${E.existingPage})`);
  if (E.existingPage && E.proposedPage && E.existingPage !== E.proposedPage && !alignIsSet()) problems.push('align the sheets (⌖)');
  const bound = state.markups.find(m => m.kind === 'ebound');
  if (!bound) problems.push('trace the earthwork boundary (⬚)');
  const exist = E.existingPage ? surfaceInputs('existing') : [];
  const prop = E.proposedPage ? surfaceInputs('proposed') : [];
  if (E.existingPage && !exist.length) problems.push(`trace at least one Existing contour/spot/pad (with elevation) on page ${E.existingPage}`);
  if (E.proposedPage && !prop.length) problems.push(`trace at least one Proposed contour/spot/pad (with elevation) on page ${E.proposedPage}`);
  if (problems.length) { setMsg('Before calculating: ' + problems.join(', ') + '.'); return; }

  // boundary into existing space
  let bpts;
  if (bound.page === E.existingPage) bpts = bound.pts;
  else if (bound.page === E.proposedPage) bpts = bound.pts.map(p => alignApply(E.align, p));
  else { setMsg(`The boundary is on page ${bound.page} — trace it on the Existing or Proposed sheet.`); return; }

  const distinct = list => new Set(list.map(c => c.elev)).size;
  if (distinct(exist) < 2) setMsg('Heads up: only one distinct Existing elevation — that surface will be flat.');
  if (distinct(prop) < 2) setMsg('Heads up: only one distinct Proposed elevation — that surface will be flat.');

  let gridFt = Math.max(0.5, E.gridFt || 5);
  let cellPx = gridFt / ftPerPx;
  const xs = bpts.map(p => p.x), ys = bpts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);

  // cap grid size so the browser stays responsive (coarsen for huge sites)
  const MAXCELLS = 60000;
  let cols = Math.ceil((x1 - x0) / cellPx), rows = Math.ceil((y1 - y0) / cellPx);
  if (cols * rows > MAXCELLS) {
    const f = Math.sqrt((cols * rows) / MAXCELLS);
    cellPx *= f; gridFt *= f;
    cols = Math.ceil((x1 - x0) / cellPx); rows = Math.ceil((y1 - y0) / cellPx);
    setMsg(`Large site — grid coarsened to ${gridFt.toFixed(1)} ft cells to stay fast.`);
  }

  const interpE = makeInterpolator(exist);
  const interpP = makeInterpolator(prop);
  const dz = new Array(cols * rows).fill(null);
  const cellAreaFt2 = (cellPx * ftPerPx) ** 2;
  let cutFt3 = 0, fillFt3 = 0, cellsInside = 0, maxAbs = 0.01;

  for (let r = 0; r < rows; r++) {
    const cy = y0 + (r + 0.5) * cellPx;
    for (let cI = 0; cI < cols; cI++) {
      const cx = x0 + (cI + 0.5) * cellPx;
      if (!pointInPolygon(cx, cy, bpts)) continue;
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
    if (r % 24 === 23) { // chunk by rows to keep the UI alive on big grids
      setMsg(`Calculating… ${Math.round((r / rows) * 100)}%`);
      await new Promise(res => setTimeout(res, 0));
    }
  }

  // summary persists with the project; the heavy grid stays session-only
  E.result = { cutCY: cutFt3 / 27, fillCY: fillFt3 / 27, areaFt2: cellsInside * cellAreaFt2, gridFt };
  heatGrid = { page: E.existingPage, x0, y0, cellPx, cols, rows, dz, maxAbs };
  scheduleSave();
  renderDirtPanel();
  if (state.page !== E.existingPage) await setPage(E.existingPage);
  vp.requestDraw();
  setMsg('Done — volumes in the ⛰ Dirt panel; the overlay shows cut (red) and fill (blue). Verify scale and traces before you bid.');
}

// cut/fill heat overlay on the existing sheet (copied from sitework)
function drawHeat(ctx) {
  const g = heatGrid;
  ctx.save();
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
  ctx.restore();
}

$('btnDirt').addEventListener('click', () => {
  const p = $('dirtPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { els.markupPanel.classList.add('hidden'); $('roofPanel').classList.add('hidden'); renderDirtPanel(); }
});
if ($('surfaceSel')) $('surfaceSel').addEventListener('change', e => {
  curSurface = e.target.value;
  renderDirtPanel();
  if (tool === 'contour') setMsg(`Tracing ${curSurface} contours.`);
});

/* ============================== Topbar & keyboard ============================== */

els.btnPrev.addEventListener('click', () => setPage(state.page - 1));
els.btnNext.addEventListener('click', () => setPage(state.page + 1));
els.btnFit.addEventListener('click', async () => {
  const b = await baseSize(state.page);
  vp.fitTo(b.width, b.height);
});
$('btnThumbs').addEventListener('click', () => document.body.classList.toggle('nothumbs'));

document.addEventListener('keydown', e => {
  const companyOpen = !$('company').classList.contains('hidden');
  const bidOpen = !$('roofBid').classList.contains('hidden');
  if (modals.isOpen() || companyOpen || bidOpen || !els.projects.classList.contains('hidden')) {
    if (e.key === 'Escape' && !modals.isOpen()) {
      if (companyOpen) $('company').classList.add('hidden');
      if (bidOpen) $('roofBid').classList.add('hidden');
      els.projects.classList.add('hidden');
    }
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (e.key === 'Enter' && alignDraft) { // accept the shift-only alignment
    e.preventDefault();
    alignDraft = null;
    setTool('pan');
    setMsg('Alignment saved (shift only). Turn on Ghost in the ⛰ Dirt panel to double-check the fit.');
    return;
  }
  if (e.key === 'Escape' && alignDraft) {
    e.preventDefault();
    if (!alignDraft.qs.length) state.earthwork.align = alignDraft.prevAlign; // nothing applied yet — restore
    alignDraft = null;
    vp.requestDraw();
    setMsg('Alignment cancelled.');
    return;
  }
  if (e.key === 'Enter' && draft) { e.preventDefault(); commitDraft(); return; }
  if (e.key === 'Backspace' && draft) {
    e.preventDefault();
    draft.pts.pop();
    if (!draft.pts.length) cancelDraft(); else vp.requestDraw();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') {
    if (draft || calibPts) { cancelDraft(); }
    else if (drag) { drag = null; vp.requestDraw(); }
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
  return {
    app: 'plan-room', version: 1, page: state.page,
    markups: state.markups, scales: state.scales,
    roofPitch: state.roofPitch, roofWaste: state.roofWaste,
    roofPrices: state.roofPrices, roofOP: state.roofOP,
    earthwork: state.earthwork,
  };
}
const defaultEarthwork = () => ({ existingPage: null, proposedPage: null, align: { a: 1, b: 0, e: 0, f: 0 }, gridFt: 5, shrink: 15, swell: 25, truckCap: 12, result: null });

let saveTimer = null;
function scheduleSave(now = false) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProjectNow, now ? 0 : 600);
  if (typeof sessionSyncSoon === 'function') sessionSyncSoon(); // push live edits (no-op if not in a session / applying incoming)
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
  state.serverId = null; state.serverVersion = null;
  heatGrid = null;
  alignDraft = null;
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
  state.scales = (rec.data && rec.data.scales) || {};
  state.roofPitch = (rec.data && rec.data.roofPitch != null) ? rec.data.roofPitch : 6;
  state.roofWaste = (rec.data && rec.data.roofWaste != null) ? rec.data.roofWaste : 12;
  state.roofPrices = (rec.data && rec.data.roofPrices) || {};
  state.roofOP = (rec.data && rec.data.roofOP != null) ? rec.data.roofOP : 15;
  state.earthwork = (rec.data && rec.data.earthwork) || defaultEarthwork();
  renderMarkupList(); syncRoofInputs(); syncDirtInputs();
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
  state.scales = {};
  state.roofPitch = 6; state.roofWaste = 12; state.roofPrices = {}; state.roofOP = 15;
  state.earthwork = defaultEarthwork();
  renderMarkupList(); syncRoofInputs(); syncDirtInputs();
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
  state.scales = d.scales || {};
  if (d.roofPitch != null) state.roofPitch = d.roofPitch;
  if (d.roofWaste != null) state.roofWaste = d.roofWaste;
  state.roofPrices = d.roofPrices || {};
  if (d.roofOP != null) state.roofOP = d.roofOP;
  state.earthwork = d.earthwork || defaultEarthwork();
  renderMarkupList(); syncRoofInputs(); syncDirtInputs();
  if (d.docB64) {
    const bytes = base64ToBytes(d.docB64);
    await openFromBytes(bytes.buffer, d.docName || 'plans.pdf', d.docType);
    if (d.page) await setPage(d.page);
  }
  scheduleSave(true);
});

/* ============================== Export (flatten + CSV) ============================== */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function safeName() {
  return (state.projectName || 'plan-room').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'plan-room';
}

// Render one page's markups onto a transparent canvas (world coords), for
// embedding over the PDF page. Raster overlay: reliable for every markup
// kind, and the original page's vector content stays untouched underneath.
async function markupOverlayPng(p) {
  const base = await baseSize(p);
  const S = Math.min(3, Math.max(1.5, 3000 / base.width));
  const c = document.createElement('canvas');
  c.width = Math.ceil(base.width * S);
  c.height = Math.ceil(base.height * S);
  const ctx = c.getContext('2d');
  ctx.scale(S, S);
  for (const m of state.markups) if (m.page === p) drawMarkup(ctx, m);
  return c.toDataURL('image/png');
}

async function exportFlatPdf() {
  if (!state.doc) { setMsg('Open a plan set first.'); return; }
  setMsg('Building the marked-up PDF…');
  try {
    const { PDFDocument, degrees } = PDFLib;
    const pagesWith = new Set(state.markups.map(m => m.page));
    let out;
    if (state.doc.kind === 'pdf') {
      const f = state.docKey ? await store.filesGet(state.docKey) : null;
      if (!f || !f.bytes) throw new Error('the original PDF is not stored on this device');
      out = await PDFDocument.load(f.bytes.slice(0), { ignoreEncryption: true });
      const pages = out.getPages();
      for (const p of pagesWith) {
        const page = pages[p - 1];
        if (!page) continue;
        setMsg(`Flattening sheet ${p}…`);
        const png = await out.embedPng(await markupOverlayPng(p));
        const rot = ((page.getRotation().angle % 360) + 360) % 360;
        const W = page.getWidth(), H = page.getHeight();
        // the overlay is in VIEWER orientation; rotated pages swap dims and
        // need the image rotated back into raw page space
        const vw = (rot === 90 || rot === 270) ? H : W;
        const vh = (rot === 90 || rot === 270) ? W : H;
        const place =
          rot === 90 ? { x: W, y: 0, rotate: degrees(90) } :
          rot === 180 ? { x: W, y: H, rotate: degrees(180) } :
          rot === 270 ? { x: 0, y: H, rotate: degrees(270) } :
          { x: 0, y: 0 };
        page.drawImage(png, { ...place, width: vw, height: vh });
      }
    } else {
      // image doc → single-page PDF: re-encode via canvas (handles jpg/png/webp
      // uniformly), then composite the overlay
      const base = await baseSize(1);
      out = await PDFDocument.create();
      const page = out.addPage([base.width, base.height]);
      const full = await state.doc.renderPage(1, 1);
      const img = await out.embedPng(full.toDataURL('image/png'));
      page.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      if (pagesWith.has(1)) {
        const png = await out.embedPng(await markupOverlayPng(1));
        page.drawImage(png, { x: 0, y: 0, width: base.width, height: base.height });
      }
    }
    const bytes = await out.save();
    download(new Blob([bytes], { type: 'application/pdf' }), safeName() + '-marked.pdf');
    setMsg('Marked-up PDF downloaded — markups are burned in; print it from any PDF viewer.');
  } catch (e) {
    console.error(e);
    setMsg('Could not build the PDF: ' + e.message);
  }
}

function exportCsv() {
  if (!state.markups.length) { setMsg('No markups yet — nothing to summarize.'); return; }
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['Sheet', 'Type', 'Text / label', 'Value', 'Color', 'Created'].map(q).join(',')];
  const sorted = [...state.markups].sort((a, b) => a.page - b.page || (a.created || 0) - (b.created || 0));
  for (const m of sorted) {
    const isMeasure = m.kind === 'mlength' || m.kind === 'marea' || m.kind === 'mcount';
    rows.push([
      m.page,
      MK_LABEL[m.kind] || m.kind,
      m.text || '',
      isMeasure ? measureValue(m) : '',
      m.color || '',
      m.created ? new Date(m.created).toLocaleString() : '',
    ].map(q).join(','));
  }
  download(new Blob([rows.join('\r\n')], { type: 'text/csv' }), safeName() + '-markups.csv');
  setMsg('Markup summary CSV downloaded.');
}

$('btnFlat').addEventListener('click', exportFlatPdf);
$('btnCsv').addEventListener('click', exportCsv);

/* ===================== Company library (server-backed) =====================
 * Shares this project — plans, markups, measurements — to the company library
 * (the shared /api/takeoffs route, rows marked data.app='plan-room'). Big plan
 * sets upload straight to R2 via a presigned PUT (needs bucket CORS), then
 * only the small JSON goes through the API. `version` gives optimistic-
 * concurrency: a stale save 409s so it can't silently overwrite a teammate.
 */

function toolApiBase() { return (localStorage.getItem('tc_api_base') || '') + '/api'; }
function toolToken() { return localStorage.getItem('tc_token') || sessionStorage.getItem('tc_token') || ''; }
async function apiFetch(path, opts = {}) {
  return fetch(toolApiBase() + '/takeoffs' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + toolToken(), ...(opts.headers || {}) },
  });
}

// Show status inside the Company modal (visible over the dialog) and the HUD.
function companyMsg(t, isError) {
  const el = $('companyMsg');
  if (el) { el.textContent = t || ''; el.style.color = isError ? '#f87171' : ''; }
  setMsg(t);
}

const UPLOAD_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function docExt() {
  const m = /\.(pdf|png|jpe?g|webp)$/i.exec(state.docName || '');
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  const t = state.docType || '';
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  return 'pdf';
}

// Presigned three-step: URL from the API → browser PUTs bytes straight to R2
// → the create call carries only the resulting publicUrl.
async function uploadDocToR2() {
  if (!state.docKey) return null;
  const f = await store.filesGet(state.docKey);
  if (!f || !f.bytes) return null;
  const ext = docExt();
  const ur = await apiFetch('/upload-url', { method: 'POST', body: JSON.stringify({ ext }) });
  if (!ur.ok) throw new Error('HTTP ' + ur.status + ' (upload-url)');
  const { uploadUrl, publicUrl } = await ur.json();
  companyMsg('Uploading the plans…');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: f.bytes,
    headers: { 'Content-Type': UPLOAD_MIME[ext] }, // must match the presigned signature
  });
  if (!put.ok) throw new Error('HTTP ' + put.status + ' (R2 upload — is bucket CORS configured?)');
  return publicUrl;
}

async function shareToCompany() {
  if (!state.doc && !state.markups.length) {
    companyMsg('Nothing to share yet — open a plan set first.', true);
    return;
  }
  const name = state.projectName || 'Plan set';
  companyMsg('Sharing…');
  try {
    if (state.serverId) {
      const res = await apiFetch('/' + state.serverId, {
        method: 'PUT', body: JSON.stringify({ name, data: projectData(), version: state.serverVersion }),
      });
      if (res.status === 409) { return shareConflict(await res.json()); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.serverVersion = (await res.json()).version;
      companyMsg('Saved to the company copy — teammates will see your changes.');
    } else {
      const pdfUrl = await uploadDocToR2();
      const res = await apiFetch('', {
        method: 'POST',
        body: JSON.stringify({ name, data: projectData(), pdfUrl, pdfName: state.docName }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = await res.json();
      state.serverId = out.id; state.serverVersion = out.version;
      companyMsg('Shared to the company. Teammates can copy it from ☁ Company.');
    }
    if (!$('company').classList.contains('hidden')) refreshCompanyList();
  } catch (e) {
    companyMsg('Could not share (are you signed in to OpsFloa?): ' + e.message, true);
  }
}

function shareConflict(c) {
  const who = c.updatedByName || 'A teammate';
  const ok = confirm(`${who} changed this shared project since you opened it.\n\nOK = save YOURS as a new, separate company copy.\nCancel = leave the shared copy as theirs (keep editing locally).`);
  if (ok) { state.serverId = null; state.serverVersion = null; return shareToCompany(); }
  companyMsg('Left the shared copy as theirs — your work is still saved locally.');
}

async function refreshCompanyList() {
  const list = $('companyList');
  list.innerHTML = '<div class="hint">Loading…</div>';
  let live = [];
  try { const sr = await apiLive('?tool=planroom'); if (sr.ok) live = await sr.json(); } catch (_) {}
  try {
    const res = await apiFetch('?app=plan-room');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    list.innerHTML = '';
    // live sessions first — join to co-edit in real time
    for (const s of live) {
      const mine = session && String(session.id) === String(s.id);
      const row = document.createElement('div');
      row.className = 'proj-row';
      row.innerHTML =
        `<div class="grow"><div class="name"></div>` +
        `<div class="meta"><span class="pill" style="background:var(--good);color:#062915">LIVE</span> ${s.host_name ? 'by ' + esc(s.host_name) + ' · ' : ''}${s.participants || 0} here</div></div>` +
        (mine ? '<span class="pill">in this</span>' : '<button class="btn tiny primary" data-act="join">Join live</button>');
      row.querySelector('.name').textContent = s.name || 'Live session';
      const jb = row.querySelector('[data-act="join"]');
      if (jb) jb.addEventListener('click', () => joinSession(s.id));
      list.appendChild(row);
    }
    if (!rows.length && !live.length) {
      list.innerHTML = '<div class="hint">No shared plan sets or live co-edit sessions yet. Open a set and hit “Share current project”, or 🟢 Live Co-Edit.</div>';
      return;
    }
    for (const r of rows) {
      const when = r.updated_at ? new Date(r.updated_at).toLocaleString() : '';
      const row = document.createElement('div');
      row.className = 'proj-row' + (String(r.id) === String(state.serverId) ? ' current' : '');
      row.innerHTML =
        `<div class="grow"><div class="name"></div>` +
        `<div class="meta">${r.pdf_name ? esc(r.pdf_name) + ' · ' : ''}v${r.version}${r.updated_by_name ? ' · by ' + esc(r.updated_by_name) : ''} · ${when}</div></div>` +
        (String(r.id) === String(state.serverId)
          ? '<span class="pill">current</span>'
          : '<button class="btn tiny" data-act="copy">Copy to my projects</button>') +
        '<button class="btn tiny danger" data-act="del" title="Delete this shared project">✕</button>';
      row.querySelector('.name').textContent = r.name;
      const copyBtn = row.querySelector('[data-act="copy"]');
      if (copyBtn) copyBtn.addEventListener('click', () => copyCompanyProject(r.id));
      row.querySelector('[data-act="del"]').addEventListener('click', () => deleteCompanyShared(r.id, r.name));
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<div class="hint">Could not load the company library: ${esc(e.message)}. Make sure you're signed in to OpsFloa.</div>`;
  }
}

async function copyCompanyProject(id) {
  let t;
  try {
    const res = await apiFetch('/' + id);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    t = await res.json();
  } catch (e) { companyMsg('Could not reach that shared project: ' + e.message, true); return; }
  if (!t.data || t.data.app !== 'plan-room') { companyMsg('That shared project could not be read.', true); return; }

  // How should it land locally? (name field first — askModal returns it; the
  // radio choice is read from the modal body afterward, which persists.)
  const nameAttr = String(t.name || 'Plan set').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const name = await modals.askModal({
    title: 'Copy to my projects',
    body: `
      <input type="text" id="modalTxt" maxlength="80" value="${nameAttr}">
      <label style="display:block;margin:8px 0 0"><input type="radio" name="cpmode" value="new" checked> Save as a new project</label>
      <label style="display:block;margin:4px 0 0"><input type="radio" name="cpmode" value="over"> Overwrite the project I have open now</label>
      <div class="hint">Pulls the shared set — plans, markups, and measurements — into your projects on this device.</div>`,
    focusSel: '#modalTxt',
  });
  if (name === null) { companyMsg(''); return; }
  const overwrite = !!$('modalBody').querySelector('input[name="cpmode"][value="over"]:checked');
  const finalName = String(name).trim() || t.name || 'Plan set';

  companyMsg('Copying from the company library…');
  try {
    await saveProjectNow(); // flush the outgoing project first
    if (!overwrite) state.projectId = randId();
    state.projectName = finalName;
    const keepId = state.projectId;
    resetDocState();
    state.projectId = keepId;
    state.markups = Array.isArray(t.data.markups) ? t.data.markups : [];
    state.scales = t.data.scales || {};
    if (t.data.roofPitch != null) state.roofPitch = t.data.roofPitch;
    if (t.data.roofWaste != null) state.roofWaste = t.data.roofWaste;
    state.roofPrices = t.data.roofPrices || {};
    if (t.data.roofOP != null) state.roofOP = t.data.roofOP;
    state.earthwork = t.data.earthwork || defaultEarthwork();
    renderMarkupList(); syncRoofInputs(); syncDirtInputs();
    try { localStorage.setItem('planroom-current', state.projectId); } catch (_) {}
    updateProjectBtn();
    if (t.pdf_url) {
      const pres = await apiFetch('/' + id + '/pdf'); // doc proxied through the API (no R2 CORS needed to read)
      if (!pres.ok) throw new Error('HTTP ' + pres.status + ' (plans download)');
      const pj = await pres.json();
      await openFromBytes(base64ToBytes(pj.b64).buffer, pj.name || t.pdf_name || 'plans.pdf', t.data.docType);
      if (t.data.page) await setPage(t.data.page);
    }
    state.serverId = t.id; state.serverVersion = t.version;
    scheduleSave(true);
    $('company').classList.add('hidden');
    companyMsg(overwrite ? `Overwrote your open project with “${finalName}”.` : `Copied “${finalName}” into your projects.`);
  } catch (e) { companyMsg('Could not copy that shared project: ' + e.message, true); }
}

async function deleteCompanyShared(id, name) {
  const ok = await modals.askModal({
    title: `Delete the shared “${name}”?`,
    body: '<div class="hint">Removes it from the company library for everyone. Local copies people already made are not affected. This cannot be undone.</div>',
  });
  if (ok === null) return;
  try {
    const res = await apiFetch('/' + id, { method: 'DELETE' });
    if (res.status === 403) { companyMsg('Only the person who shared it (or an admin) can delete it.', true); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (String(id) === String(state.serverId)) { state.serverId = null; state.serverVersion = null; }
    refreshCompanyList();
    companyMsg('Shared project deleted.');
  } catch (e) { companyMsg('Could not delete: ' + e.message, true); }
}

$('btnCompany').addEventListener('click', () => {
  $('company').classList.remove('hidden');
  companyMsg('');
  refreshCompanyList();
});
$('companyShareBtn').addEventListener('click', shareToCompany);
$('companyClose').addEventListener('click', () => $('company').classList.add('hidden'));
$('company').addEventListener('click', e => { if (e.target === $('company')) $('company').classList.add('hidden'); });

/* ===================== Live sessions (SSE + REST ops) =====================
 * Host "goes live" on the current project; teammates join and co-edit in real
 * time. Server→client push via EventSource; client→server via REST ops. Every
 * persistent change (markups + scale/roof settings) is diffed against the last
 * synced state and pushed as ops; incoming ops apply without re-emitting.
 * Base-tier feature — not gated on the takeoff layer.
 */

let session = null; // { id, clientId, es, applying, isHost, lastSync, docHash, timer }

async function apiLive(path, opts = {}) {
  return fetch(toolApiBase() + '/live' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + toolToken(), ...(opts.headers || {}) },
  });
}

function sessionDoc() {
  return { scales: state.scales, page: state.page, roofPitch: state.roofPitch, roofWaste: state.roofWaste, roofPrices: state.roofPrices, roofOP: state.roofOP, earthwork: state.earthwork };
}
function applySessionDoc(d) {
  if (!d) return;
  if (d.scales) state.scales = d.scales;
  if (d.roofPitch != null) state.roofPitch = d.roofPitch;
  if (d.roofWaste != null) state.roofWaste = d.roofWaste;
  if (d.roofPrices) state.roofPrices = d.roofPrices;
  if (d.roofOP != null) state.roofOP = d.roofOP;
  if (d.earthwork) state.earthwork = d.earthwork;
  if (d.page && d.page !== state.page && state.doc) setPage(d.page);
}

function setLiveState(t) { $('liveState').textContent = t || ''; }
function updateLiveBar(roster) {
  const label = $('btnLive').querySelector('.btn-label');
  if (!session) {
    $('liveBar').classList.add('hidden');
    $('btnLive').classList.remove('live-on');
    if (label) label.textContent = ' Live Co-Edit';
    return;
  }
  $('liveBar').classList.remove('hidden');
  $('liveName').textContent = state.projectName || 'Live session';
  $('btnLive').classList.add('live-on');
  if (label) label.textContent = ' Co-Editing';
  $('liveEnd').classList.toggle('hidden', !session.isHost);
  if (roster) $('liveRoster').textContent = roster.length ? `${roster.length} here: ${roster.map(r => r.name).join(', ')}` : '';
}

// diff current state vs last-synced and push ops (debounced; hooked into scheduleSave)
function sessionSyncSoon() {
  if (!session || session.applying) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(sessionPush, 250);
}
async function sessionPush() {
  if (!session) return;
  const ops = [];
  const cur = new Map();
  for (const m of state.markups) {
    const j = JSON.stringify(m);
    cur.set(m.id, j);
    if (session.lastSync.get(m.id) !== j) ops.push({ t: 'up', id: m.id, o: m, ts: Date.now() });
  }
  for (const id of session.lastSync.keys()) if (!cur.has(id)) ops.push({ t: 'del', id, ts: Date.now() });
  session.lastSync = cur;
  const docNow = sessionDoc();
  const docHash = JSON.stringify(docNow);
  const doc = docHash !== session.docHash ? docNow : null;
  session.docHash = docHash;
  if (!ops.length && !doc) return;
  try { await apiLive('/' + session.id + '/op', { method: 'POST', body: JSON.stringify({ clientId: session.clientId, ops, doc, docTs: Date.now() }) }); } catch (_) {}
}

function applyStream(msg) {
  if (!session) return;
  if (msg.type === 'presence') { updateLiveBar(msg.roster); return; }
  if (msg.type === 'ended') { endSessionLocal(true); return; }
  session.applying = true;
  if (msg.type === 'init') {
    if (Array.isArray(msg.objects)) state.markups = msg.objects;
    applySessionDoc(msg.doc);
    updateLiveBar(msg.roster);
  } else if (msg.type === 'ops') {
    for (const op of msg.ops || []) {
      if (op.t === 'del') state.markups = state.markups.filter(m => m.id !== op.id);
      else if (op.t === 'up' && op.o) {
        const i = state.markups.findIndex(m => m.id === op.o.id);
        if (i >= 0) state.markups[i] = op.o; else state.markups.push(op.o);
      }
    }
    applySessionDoc(msg.doc);
  }
  session.lastSync = new Map(state.markups.map(m => [m.id, JSON.stringify(m)]));
  session.docHash = JSON.stringify(sessionDoc());
  if (selectedId && !selMarkup()) selectedId = null;
  renderMarkupList(); renderRoofPanel(); syncRoofInputs(); syncDirtInputs();
  scheduleSave(); vp.requestDraw();
  session.applying = false;
}

function openStream() {
  const url = toolApiBase() + '/live/' + session.id + '/stream?token=' + encodeURIComponent(toolToken()) + '&client=' + encodeURIComponent(session.clientId);
  const es = new EventSource(url);
  session.es = es;
  es.onopen = () => setLiveState('');
  es.onmessage = e => { try { applyStream(JSON.parse(e.data)); } catch (_) {} };
  es.onerror = () => setLiveState('reconnecting…'); // EventSource auto-reconnects; the server resends init
}

async function goLive() {
  if (session) return;
  if (!state.doc) { setMsg('Open a plan set before going live.'); return; }
  setMsg('Starting the live session…');
  try {
    const pdfUrl = await uploadDocToR2(); // presigned upload — needs R2 CORS
    const res = await apiLive('/', { method: 'POST', body: JSON.stringify({
      tool: 'planroom', name: state.projectName || 'Live session', pdfUrl, pdfName: state.docName,
      objects: state.markups, doc: sessionDoc(),
    }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { id } = await res.json();
    session = {
      id: String(id), clientId: randId(), applying: false, isHost: true, timer: null,
      lastSync: new Map(state.markups.map(m => [m.id, JSON.stringify(m)])), docHash: JSON.stringify(sessionDoc()),
    };
    openStream();
    updateLiveBar();
    setMsg('Live co-edit started. Teammates can join from ☁ Company (it shows a LIVE badge).');
  } catch (e) { setMsg('Could not start the session (signed in? is R2 CORS configured?): ' + e.message); }
}

async function joinSession(id) {
  if (session) endSessionLocal(false);
  setMsg('Joining the live session…');
  let t;
  try { const res = await apiLive('/' + id); if (!res.ok) throw new Error('HTTP ' + res.status); t = await res.json(); }
  catch (e) { setMsg('Could not join: ' + e.message); return; }
  // land the shared doc in a FRESH local project — never overwrite the open one
  await saveProjectNow();
  state.projectId = randId();
  state.projectName = t.name || 'Live session';
  resetDocState();
  state.markups = Array.isArray(t.objects) ? t.objects : [];
  applySessionDoc(t.doc);
  updateProjectBtn(); renderMarkupList(); syncRoofInputs();
  try { localStorage.setItem('planroom-current', state.projectId); } catch (_) {}
  if (t.pdfUrl) {
    try {
      const pr = await apiLive('/' + id + '/pdf');
      if (pr.ok) { const pj = await pr.json(); await openFromBytes(base64ToBytes(pj.b64).buffer, pj.name || t.pdfName || 'plans.pdf', null); if (t.doc && t.doc.page) await setPage(t.doc.page); }
    } catch (_) { setMsg('Joined, but could not load the plans.'); }
  }
  session = {
    id: String(id), clientId: randId(), applying: false, isHost: false, timer: null,
    lastSync: new Map(state.markups.map(m => [m.id, JSON.stringify(m)])), docHash: JSON.stringify(sessionDoc()),
  };
  $('company').classList.add('hidden');
  openStream();
  updateLiveBar();
  scheduleSave(true);
  setMsg(`Joined “${t.name}”. Your markups appear for everyone live.`);
}

function endSessionLocal(remote) {
  if (!session) return;
  const wasHost = session.isHost;
  if (session.es) { try { session.es.close(); } catch (_) {} }
  clearTimeout(session.timer);
  session = null;
  updateLiveBar();
  setMsg(remote ? 'The live session ended — your copy is saved in your projects.'
    : wasHost ? 'Live session ended.' : 'You left the session — your copy is saved in your projects.');
}

async function endOrLeave(endForAll) {
  if (!session) return;
  const id = session.id;
  if (endForAll && session.isHost) { try { await apiLive('/' + id + '/end', { method: 'POST' }); } catch (_) {} }
  endSessionLocal(false);
}

$('btnLive').addEventListener('click', () => {
  if (!session) return goLive();
  if (session.isHost) { if (confirm('End the session for everyone? Each person keeps their own copy.')) endOrLeave(true); }
  else endOrLeave(false);
});
$('liveLeave').addEventListener('click', () => endOrLeave(false));
$('liveEnd').addEventListener('click', () => { if (confirm('End the session for everyone? Each person keeps their own copy.')) endOrLeave(true); });

/* ============================== Boot ============================== */

async function boot() {
  vp.attach(paint);
  applyTakeoffGate();
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
