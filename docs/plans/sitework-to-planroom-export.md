# OpsFloa — Sitework → Plan Room export: plan

Status: **building** (2026-07-17). Scope + delivery confirmed with David: carry
the **drawings + scale** over and re-price in Plan Room; **push** it (creates a
new Plan Room project that appears in his Plan Room list). Adding an export
button inside sitework is **explicitly authorized** (overrides the standing
"don't touch sitework" rule for this one addition — see [[feedback_never_break_sitework]]).

## Why the button lives in sitework, not as a Plan Room importer

Both tools take off on a PDF, but in **different pixel spaces**:

- **Plan Room** stores points in PDF **base px** (viewport at scale 1).
- **Sitework** stores points in **rendered-image px** at `state.renderScale`
  (`min(3, 2800 / pageWidth)`), and **renderScale is not saved** in the project.

So `base = image / renderScale`, and the bridging factor only exists **while the
sitework tool is open**. A Plan Room–side importer would have to re-open the PDF
and re-derive it per page. An export button converts while `renderScale` is live
— which is why the button belongs in sitework. (Good instinct on David's part.)

## What converts (and what doesn't)

**Clean — carried over:** every traced shape and the scale.

| Sitework | Plan Room `kind` |
|---|---|
| boundary (1 polygon) | `ebound` |
| contours (normal / spot / pad) | `contour` / `espot` / `epad` (+ `surface`, `elev`) |
| takeoff `area` | `qarea` |
| takeoff `line` | `qline` |
| takeoff `count` | `qcount` |
| retaining `walls` | `qline` (line only) |
| project calibration | per-page `scaleBars` + `scales` |
| grid/shrink/swell/truck settings + `align` | `earthwork` |

**Dropped (no Plan Room equivalent, re-price there):**
- The priced **bid** (sitework price book ≠ Plan Room per-trade config).
- Retaining-**wall dig volumes** (Plan Room has no cross-section model — the line
  survives, the computed CY does not).
- The **production / haul-ticket log**.

Measurement **labels** are carried into each markup's `cfg.label` so a shape is
still identifiable; only the pricing is lost.

## The coordinate math (the correctness crux)

For every point and calibration endpoint: `base = image / renderScale`.

- One `renderScale` is used for all of sitework's geometry, so dividing every
  point by it maps each page's geometry into that page's base px correctly
  (base px = nativeWidth; image px = nativeWidth × renderScale ⇒ image/rs = base,
  per page, regardless of page width).
- **Scale:** sitework's `calibration.ftPerPx` is feet/imagePx; Plan Room's is
  feet/basePx = `ftPerPx_sw × renderScale`. Rather than compute it, emit a
  `scaleBar { a, b, feet }` with endpoints ÷ renderScale and let Plan Room
  recompute — one bar per page (calibration is project-wide in sitework).
- **align** (proposed→existing transform): rotation/scale `a,b` are scale-free;
  the translation `e,f` is in px, so it divides by renderScale like any point.

## Delivery

Reuses sitework's own share path (`shareToCompany`): read the PDF bytes from
IndexedDB (`state.pdfKey` → `idbFilesGet` → base64), `POST /api/takeoffs` a **new**
row with `data.app='plan-room'`, the converted `data`, and a **fresh** PDF copy.

⚠️ A fresh PDF copy, **not** a shared `pdf_url` — `DELETE /api/takeoffs/:id`
removes the R2 object (`takeoffs.js:188`), so sharing one PDF across two rows
would let deleting the sitework project break the Plan Room copy.

Same ~48–64 MB base64 ceiling as sitework's existing share (413 → friendly
message). Presigned direct upload for huge plan sets is a later improvement.

## Implementation

- **`convertToPlanRoom(state, settings)`** — pure function, returns the Plan Room
  `data` blob. Testable by lifting it out of `app.js` and running against a stub
  state (the project's established verification pattern).
- **`sendToPlanRoom()`** — wraps it: guards (PDF open, something drawn), grabs the
  PDF bytes, POSTs the new row, reports where to find it.
- **Button** `➡ Send to Plan Room` in the Company modal, next to Share.
- **Test** `server/tests/siteworkToPlanRoom.test.js` — lifts `convertToPlanRoom`,
  pins the coordinate division, the type map, `surface`, the scale-bar math, the
  align e/f ÷ rs, and that bid/production/pricing are absent.

## Known limitations (documented, not bugs)

- Re-price in Plan Room (pricing never maps).
- Wall dig volumes and production log are lost.
- Existing/proposed must be single sheets (sitework's model); multi-sheet plan
  sets beyond the two surfaces aren't in sitework's data to begin with.
- Big-PDF base64 ceiling inherited from the existing share path.
