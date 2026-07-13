# Plan Room — Sitework (earthwork) trade pack

Status: **S1–S3 built** (2026-07-11) — tracing, alignment+ghost, and cut/fill
compute all shipped; S4 (cutover) awaits the user's parity confirmation. The takeoff layer's second trade pack:
dirt/cut-fill takeoff inside Plan Room, at full parity with the standalone
Sitework Takeoff tool. This IS the "sitework consolidation" — but built as a
copy, so the standalone tool keeps running untouched until the user confirms
Plan Room does the job (then it redirects; grandfathering decided at cutover).

## Decision (locked with user, 2026-07-11)
**Separate sheets + alignment** — full parity from the start. Existing-conditions
and grading are different pages; the user designates each, traces contours on
each, and aligns them with landmarks. (Not the simpler combined-sheet model.)

## Model (fits Plan Room's page-based viewer)
Project gains an `earthwork` blob: `{ existingPage, proposedPage, align{a,b,e,f},
gridFt, shrink, swell, truckCap, result }`. New markup kinds, each tagged
`surface: 'existing'|'proposed'` and carrying `elev`:
- `contour` — polyline + elevation (colored by elevation).
- `espot` — a single spot grade (point + elevation).
- `epad` — building pad polygon (flat at one elevation).
- `ebound` — the limits-of-disturbance polygon (one, in existing space).
Contours/spots/pads are stored in their own page's base-px. Proposed geometry
is mapped into existing space via `align` **at compute time** (not at trace
time) — storage/rendering stay in native page coords.

## Copied algorithms (from sitework/app.js — record in shared/PARITY.md if shared)
- **Interpolator** `makeInterpolator(contours)` (sitework §Surface interpolation):
  pads flat inside; else distance-weighted blend of nearest contour + nearest at
  a different elevation. Uses `pointInPolygon`/`distToPolyline` (already in
  engine-measure).
- **Cut/fill grid** (sitework `calculate()`): grid the boundary bbox at
  `gridFt/ftPerPx`, cap ~60k cells, per cell inside boundary sample existing &
  proposed, `d = zProp − zExist` (+fill/−cut), sum × cell area, ÷27 → CY; net
  export applies shrink (cut) / swell (fill).
- **Align solve** (sitework, 2 landmark pairs → similarity): with
  q=proposed-page pt, p=existing pt: `a=(dq·dp)/|dq|²`, `b=(dq×dp)/|dq|²`,
  `e=p1.x−(a·q1.x−b·q1.y)`, `f=p1.y−(b·q1.x+a·q1.y)`; 1 pair = shift only.
  `alignApply(M,q)` (engine-measure) maps proposed→existing.

## Slices (each a commit; sitework tool untouched throughout; gated on the takeoff layer)
- **S1 — model + tracing:** `earthwork` state + persistence; contour + ebound
  tools with a surface toggle (Existing/Proposed) + elevation entry;
  elevation-colored rendering; earthwork panel (designate existing/proposed
  pages, surface toggle, grid/shrink/swell/truck inputs, contour counts). No
  volumes yet. *(this turn)*
- **S2 — spot/pad + alignment:** espot + epad tools; align mode (click a
  landmark on the existing page, its match on the proposed page → solve
  transform) + a ghost overlay of the other sheet to verify the fit.
- **S3 — cut/fill compute:** port the interpolator + grid; Calculate →
  cut/fill/net CY + truck counts in the panel + a cut/fill heat overlay; feed
  earthwork lines into the roofing-style bid engine (make the bid tool
  trade-agnostic).
- **S4 (unscheduled, user-gated) — consolidation:** once the user confirms Plan
  Room's earthwork matches the standalone tool on a real job, redirect the
  standalone tool.

## Parity gap — what the standalone tool has that Plan Room does NOT (2026-07-12)
Plan Room earthwork = **cut/fill core only** today. To reach parity (and retire
the standalone tool) these must come over. User approved porting the quantity
takeoffs + auto-trace first (2026-07-12):
- **Q1 Area takeoff** — polygon → SF; form: thickness, material, density, rebar,
  respread, swell, deductions → SF/tons/CY + bid line. *(building)*
- **Q2 Line takeoff** — polyline → LF; trench width/depth, bedding, slope →
  LF + excavation CY + bedding.
- **Q3 Count takeoff** — points → count; unit type + price.
- **Q4 Wall dig** — line → wall/footing excavation; depth/width/slope, concrete,
  aggregate, reuse.
- **W1 Auto-trace (vector wand)** — extract vector paths from the PDF page
  (pdf.js operator list) → click-to-trace a contour/area; + smooth. `simplifyPts`
  already in engine-measure.
Deferred (not in this round): revision re-align; production/haul log; bid
branding (letterhead/logo/markup/prepared-by); layer toggles + legend +
per-contour list + contour interval; eraser/clear-sheet/nav-pads.
All quantity takeoffs live under the ⛰ trade, feed the Takeoff bid, copy from
sitework/app.js (record in PARITY.md), sitework untouched.

## Verification
Trace a known simple case (a flat pad cut into a uniform slope) and match cut/fill
against a hand calc; a real project's totals should match the standalone tool
before any cutover. Existing/proposed page designation + align persist and
survive reload/share.
