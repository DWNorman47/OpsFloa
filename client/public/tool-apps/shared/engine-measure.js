/**
 * engine-measure.js — pure geometry & measurement math for the plan tools.
 *
 * Part of the shared plan-tools engine (see docs/plans/plan-viewer-markup.md).
 * COPY-derived from sitework/app.js — the sitework tool still runs its own
 * monolith and is NOT wired to this module; see shared/PARITY.md before
 * changing anything here. Everything in this file is pure: no DOM, no state,
 * no globals. Points are {x, y} in world/image pixels; `ftPerPx` comes from
 * the caller's scale calibration.
 */

// Distance between two points.
export function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

// Distance from point P to segment AB.
export function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

// Distance from point P to an open polyline.
export function distToPolyline(px, py, pts) {
  if (pts.length === 1) return dist(px, py, pts[0].x, pts[0].y);
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const dd = pointSegDist(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (dd < d) d = dd;
  }
  return d;
}

// Ray-cast point-in-polygon.
export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Shoelace area of a closed polygon, in square feet.
export function polygonAreaFt2(poly, ftPerPx) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2) * ftPerPx * ftPerPx;
}

// Closed-polygon perimeter in feet (sums every edge, including last→first).
export function polygonPerimeterFt(poly, ftPerPx) {
  let p = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    p += dist(poly[j].x, poly[j].y, poly[i].x, poly[i].y);
  return p * ftPerPx;
}

// Open-polyline length in feet. (Sitework's version reads its own state for
// ftPerPx; the shared version takes it as a parameter.)
export function polyLengthFt(pts, ftPerPx) {
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += dist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
  return d * ftPerPx;
}

// Catmull-Rom spline: a smooth curve that passes THROUGH every input point.
// Returns a densified polyline. `closed` wraps the ends into a loop (areas);
// open curves clamp the ends (contours, lines). <3 points can't curve.
export function catmullRomSpline(pts, closed, segs = 14) {
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

// Douglas-Peucker polyline simplification (eps in the same px units as pts).
// Useful for freehand input smoothing before storing.
export function simplifyPts(pts, eps) {
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

/* ---- rigid alignment transforms (rotate+translate, uniform scale) ----
   M = { a, b, e, f } applies as x' = a·x − b·y + e, y' = b·x + a·y + f.
   Used by sitework's two-sheet align; generic enough for any overlay/compare. */

export const alignIdentity = () => ({ a: 1, b: 0, e: 0, f: 0 });
export const alignIsIdentity = M => M.a === 1 && M.b === 0 && M.e === 0 && M.f === 0;

// raw image point -> world point
export function alignApply(M, q) {
  return { x: M.a * q.x - M.b * q.y + M.e, y: M.b * q.x + M.a * q.y + M.f };
}

// world point -> raw image point (inverse of the align transform)
export function alignInvert(M, w) {
  const s2 = M.a * M.a + M.b * M.b;
  const x = w.x - M.e, y = w.y - M.f;
  return { x: (M.a * x + M.b * y) / s2, y: (-M.b * x + M.a * y) / s2 };
}
