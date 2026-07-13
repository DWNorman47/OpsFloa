/**
 * engine-ui.js — modal ask-helpers + text formatting for the plan tools.
 *
 * Part of the shared plan-tools engine (see docs/plans/plan-viewer-markup.md).
 * COPY-derived from sitework/app.js (Modal + Utilities sections) — the
 * sitework tool still runs its own monolith and is NOT wired to this module;
 * see shared/PARITY.md. Reworked into a factory: the original wires
 * sitework's els.* globals at load.
 */

/* ---------------- pure formatting ---------------- */

export function fmt(n, d = 0) {
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function money(n) {
  return '$' + (Math.round((n || 0) * 100) / 100)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- modal ask-helpers ----------------
 * Expects the sitework modal DOM shape:
 *   overlay (.modal) > box > title (h3), body, actions with OK + Cancel.
 * askModal resolves with the first input's value (or true if no input) on OK,
 * and null on Cancel/Escape. Enter = OK. [data-step] buttons inside the body
 * nudge the first number input (the stepper pattern).
 */
export function createModals({ overlay, title, body, ok, cancel }) {
  let resolveFn = null;

  function readValue() {
    const inp = body.querySelector('input');
    return inp ? inp.value : true;
  }

  function closeModal(val) {
    overlay.classList.add('hidden');
    if (resolveFn) { const r = resolveFn; resolveFn = null; r(val); }
  }

  ok.addEventListener('click', () => closeModal(readValue()));
  cancel.addEventListener('click', () => closeModal(null));
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); closeModal(readValue()); }
    if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
    e.stopPropagation(); // modal keys must not fire tool shortcuts underneath
  });
  body.addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    const inp = body.querySelector('input');
    inp.value = (parseFloat(inp.value || 0) + parseFloat(b.dataset.step)).toString();
    inp.focus(); inp.select();
  });

  function askModal({ title: t, body: html, focusSel }) {
    return new Promise(resolve => {
      resolveFn = resolve;
      title.textContent = t;
      body.innerHTML = html;
      overlay.classList.remove('hidden');
      const f = focusSel && body.querySelector(focusSel);
      if (f) { f.focus(); f.select && f.select(); }
    });
  }

  async function askNumber(t, hint, prefill, step) {
    const val = await askModal({
      title: t,
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

  async function askText(t, hint, prefill) {
    const escd = String(prefill ?? '')
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const val = await askModal({
      title: t,
      body: `
        <input type="text" id="modalTxt" maxlength="80" value="${escd}">
        ${hint ? `<div class="hint">${hint}</div>` : ''}`,
      focusSel: '#modalTxt',
    });
    if (val === null) return null;
    const s = String(val).trim();
    return s || null;
  }

  const isOpen = () => !overlay.classList.contains('hidden');

  return { askModal, askNumber, askText, closeModal, isOpen };
}
