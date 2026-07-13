/**
 * engine-view.js — canvas viewport (pan / zoom / fit / DPR) for the plan tools.
 *
 * Part of the shared plan-tools engine (see docs/plans/plan-viewer-markup.md).
 * COPY-derived from sitework/app.js (resizeCanvas / fitView / panBy / wheel
 * zoom-at-cursor / rAF-coalesced draw) — the sitework tool still runs its own
 * monolith and is NOT wired to this module; see shared/PARITY.md. Reworked
 * into a factory: the original reads sitework globals (state.view, cv, els).
 *
 * Usage:
 *   const vp = createViewport({ canvas, getZoomSpeed: () => 100 });
 *   const detach = vp.attach(paint);   // wires resize + ResizeObserver + wheel
 *   vp.requestDraw();                  // rAF-coalesced; calls paint()
 *   function paint(ctx, w, h) {        // w/h in CSS px
 *     vp.beginPaint(ctx);              // DPR transform + clear + pan/zoom
 *     ...draw world-space content...
 *     ctx.restore();
 *   }
 * Pointer-drag panning stays with the tool's own handlers (pan vs draw is a
 * tool decision) — use vp.panPx(dx, dy) from them.
 */

export function createViewport({ canvas, getZoomSpeed } = {}) {
  const ctx = canvas.getContext('2d');
  const view = { zoom: 1, panX: 0, panY: 0 };
  let onDraw = null;
  let drawQueued = false;

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      if (onDraw) onDraw(ctx, canvas.width / devicePixelRatio, canvas.height / devicePixelRatio);
    });
  }

  // Match the canvas buffer to its parent box at device resolution; a stale
  // buffer gets stretched to fit, drawing everything slightly off the cursor.
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const w = Math.round(r.width * devicePixelRatio);
    const h = Math.round(r.height * devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    requestDraw();
  }

  // DPR transform + clear + world pan/zoom. Caller draws, then ctx.restore().
  function beginPaint(c = ctx) {
    const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
    c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    c.clearRect(0, 0, w, h);
    c.save();
    c.translate(view.panX, view.panY);
    c.scale(view.zoom, view.zoom);
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
  }
  function worldToScreen(wx, wy) {
    return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY };
  }

  // Zoom that would fit a w×h (world px) document in the parent box.
  function fitZoomFor(w, h) {
    const r = canvas.parentElement.getBoundingClientRect();
    return Math.min(r.width / w, r.height / h);
  }

  // Center a w×h (world px) document with a small margin.
  function fitTo(w, h, margin = 0.97) {
    const r = canvas.parentElement.getBoundingClientRect();
    const z = fitZoomFor(w, h) * margin;
    view.zoom = z;
    view.panX = (r.width - w * z) / 2;
    view.panY = (r.height - h * z) / 2;
    requestDraw();
  }

  // Pan by a fraction of the viewport (+dx reveals content to the right).
  function panByFraction(dxFrac, dyFrac) {
    const r = canvas.parentElement.getBoundingClientRect();
    view.panX -= dxFrac * r.width;
    view.panY -= dyFrac * r.height;
    requestDraw();
  }

  // Pan by screen pixels (for pointer-drag handlers).
  function panPx(dx, dy) {
    view.panX += dx;
    view.panY += dy;
    requestDraw();
  }

  // Zoom by `factor` keeping the screen point (sx, sy) fixed.
  function zoomAt(sx, sy, factor, { min = 0.02, max = 30 } = {}) {
    const nz = Math.max(min, Math.min(max, view.zoom * factor));
    view.panX = sx - (sx - view.panX) * (nz / view.zoom);
    view.panY = sy - (sy - view.panY) * (nz / view.zoom);
    view.zoom = nz;
    requestDraw();
  }

  // Wheel zoom at the cursor — scales by the actual wheel delta (smooth on
  // touchpads); speed is a percentage (10–300, default 100).
  function wheelZoom(e) {
    e.preventDefault();
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    const speed = Math.max(10, Math.min(300, (getZoomSpeed && parseFloat(getZoomSpeed())) || 100)) / 100;
    const f = Math.exp(-Math.max(-300, Math.min(300, px)) * 0.0014 * speed);
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, f);
  }

  // True when zoomed in past ~70% of fit — where drag-navigation gets tedious
  // (the sitework nav-pads heuristic; the app decides what to show).
  function zoomedPastFit(w, h, frac = 0.7) {
    const fz = fitZoomFor(w, h);
    return fz > 0 && view.zoom > fz / frac;
  }

  // Wire resize + wheel; returns a detach function.
  function attach(drawFn) {
    onDraw = drawFn;
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    window.addEventListener('resize', resize);
    canvas.addEventListener('wheel', wheelZoom, { passive: false });
    resize();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('wheel', wheelZoom);
      onDraw = null;
    };
  }

  return {
    view, ctx, attach, resize, requestDraw, beginPaint,
    screenToWorld, worldToScreen,
    fitTo, fitZoomFor, zoomedPastFit,
    panByFraction, panPx, zoomAt, wheelZoom,
  };
}
