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
- **Q4 Wall dig — DEFERRED (user, 2026-07-12).** Most niche of the four; the
  *dig* overlaps Q2's trench cross-section, and its unique concrete/rebar/agg
  are usually the concrete sub's scope, not the excavator's. Full self-contained
  spec below so it's rebuildable even if the standalone tool is deleted first.
- **W1 Auto-trace (vector wand)** — extract vector paths from the PDF page
  (pdf.js operator list) → click-to-trace a contour/area; + smooth. `simplifyPts`
  already in engine-measure.
Deferred (not in this round): revision re-align; production/haul log; bid
branding (letterhead/logo/markup/prepared-by); layer toggles + legend +
per-contour list + contour interval; eraser/clear-sheet/nav-pads.
All quantity takeoffs live under the ⛰ trade, feed the Takeoff bid, copy from
sitework/app.js (record in PARITY.md), sitework untouched.

## Q4 Wall dig — full spec (deferred; rebuildable without the standalone tool)
Excavation for a retaining wall / footing: a trench swept along a traced line,
netting export vs. reused backfill after concrete + aggregate occupy the hole.
Two entry points in the standalone tool:
- **▚ Wall tool (plan-accurate):** trace the wall line; depth comes from one of
  three modes (below) read off the contours; sweep the cross-section along it.
- **Quick calculator (no plans):** type length + avg depth + cross-section.

**Cross-section** (already ported as `wallSectionAreaSf`): trapezoid area (SF)
`= bottomWidth·depth + slope·depth²`, where bottomWidth = footing width + working
room, slope = side backcut H:V (0 vertical/shored, 0.75 Type A, 1 Type B, 1.5
Type C). Gross ft³ = cross-section × length.

**Core volumes** (`wallComputeCore`, verbatim math to port):
```
grossCY   = grossFt3 / 27
void      = max(0, grossCY − concreteCY − aggregateCY)   // hole left after wall+agg
reused    = void × clamp(reusePct/100, 0..1)             // native put back
netExport = grossCY − reused                              // bank dirt hauled off
importBackfill = void − reused                            // structural fill to bring in
truckCY   = netExport × (1 + swellPct/100)                // loose/haul volume
```
Concrete (footing+stem CY) and drainage aggregate (CY) are optional imports that
take up the hole, so reused native is figured against what's left.

**Depth modes for the ▚ Wall tool** (needs contours; integrates depth per station
along the swept line): (1) **constant** depth below grade; (2) **down to subgrade
elevation** — reads Existing ground elev at each station, digs to a fixed footing
subgrade elev; (3) **proposed grade − embedment** — bottom follows the Proposed
surface at a set embedment (reads both Existing + Proposed contours; for a
benched/stepped footing down a slope). Source refs (if the tool still exists):
`recomputeWall`, `computeWallSweep`, `askWallSection`, `wallResultRows`,
`wallCalcCompute` in sitework/app.js.

**Form fields:** length (calc only), avg/constant depth, trench bottom width,
side slope select, swell %, reused-as-backfill %, concrete CY (opt), drainage
aggregate CY (opt). **Bid lines:** wall excavation (net export bank CY), import
structural backfill CY, concrete CY, aggregate CY — each at editable $/unit.
Model as a `qwall` markup (polyline + cfg) parallel to qline, reusing
`wallSectionAreaSf` + `wallComputeCore`.

## Verification
Trace a known simple case (a flat pad cut into a uniform slope) and match cut/fill
against a hand calc; a real project's totals should match the standalone tool
before any cutover. Existing/proposed page designation + align persist and
survive reload/share.
