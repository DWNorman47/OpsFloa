/* Plan Room — viewer + markup + measure (M1: viewer core).
 * Built on the shared plan-tools engine (../shared/engine-*.js). Local-first:
 * projects live in this browser (IndexedDB 'planroom'), documents dedup by
 * content hash. See docs/plans/plan-viewer-markup.md.
 */

import { createViewport } from '../shared/engine-view.js?v=1';
import { createStore, randId, hashBytes } from '../shared/engine-store.js?v=1';
import { openDoc, bytesToBase64, base64ToBytes, defaultRenderScale } from '../shared/engine-doc.js?v=1';
import { createModals, esc } from '../shared/engine-ui.js?v=1';

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
};

const store = createStore('planroom');

const els = {
  cv: $('cv'), hud: $('hud'), dropHint: $('dropHint'), thumbRail: $('thumbRail'),
  pageInfo: $('pageInfo'), btnPrev: $('btnPrevPage'), btnNext: $('btnNextPage'),
  btnFit: $('btnFit'), projName: $('projName'), projects: $('projects'), projList: $('projList'),
};

const modals = createModals({
  overlay: $('modal'), title: $('modalTitle'), body: $('modalBody'),
  ok: $('modalOk'), cancel: $('modalCancel'),
});

const vp = createViewport({ canvas: els.cv });

function setMsg(t) { els.hud.textContent = t || ''; }

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
  // world units = base-scale px, so future markups are resolution-independent
  if (img && base) ctx.drawImage(img, 0, 0, base.width, base.height);
  else if (state.doc) ensurePage(state.page);
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

/* ============================== Pan (pointer) ============================== */

let panPtr = null, panLast = null;
els.cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  els.cv.setPointerCapture(e.pointerId);
  panPtr = e.pointerId;
  panLast = { x: e.clientX, y: e.clientY };
  els.cv.classList.add('grabbing');
});
els.cv.addEventListener('pointermove', e => {
  if (e.pointerId !== panPtr || !panLast) return;
  vp.panPx(e.clientX - panLast.x, e.clientY - panLast.y);
  panLast = { x: e.clientX, y: e.clientY };
});
function endPan(e) {
  if (e.pointerId !== panPtr) return;
  panPtr = null; panLast = null;
  els.cv.classList.remove('grabbing');
}
els.cv.addEventListener('pointerup', endPan);
els.cv.addEventListener('pointercancel', endPan);

/* ============================== Topbar ============================== */

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
  return { app: 'plan-room', version: 1, page: state.page };
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
    row.innerHTML = `
      <div class="grow">
        <div class="name"></div>
        <div class="meta">${r.docName ? esc(r.docName) + ' · ' : ''}${when}</div>
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
        body: '<div class="hint">Removes this project permanently (no undo). Its plan file is removed too if no other project uses it.</div>',
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
  if (!state.doc) { setMsg('Nothing to save yet — open a plan set first.'); return; }
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
  setMsg('Saved. The file has the plans embedded — hand it to anyone.');
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
