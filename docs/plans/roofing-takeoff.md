# OpsFloa — Roofing trade pack (inside the Plan Room takeoff layer)

Status: **scoped, not started** (2026-07-11; restructured same day — originally
its own tool-app + `addon_roofing` SKU, now a **trade pack inside the Plan Room
takeoff layer**; see the master plan `docs/plans/plan-viewer-markup.md`).
No own SKU, no own tool-app: the $60 takeoff layer includes all trades.
This doc owns the roofing **domain spec**; it ships as Plan Room **M8**.

## Why roofing is the first new trade
Roofers already pay per measurement (EagleView / Hover, $20–100 *per report*) —
the strongest proven willingness to pay on the roadmap — and roof takeoff is
exactly the engine's motion: polygon area + linear feet + counts, plus pitch
math. Big, fragmented market new to OpsFloa.

## M0 note (shared-engine extraction)
The original plan here carried M0 — splitting the ~5,000-line sitework monolith
into shared ES modules (`client/public/tool-apps/shared/`: engine-view/doc/
measure/store/ui/bid/share), one module per commit, sitework green throughout,
`?v=` import versioning for Vercel caching. **M0 now belongs to whichever plan
builds first** (in the current sequence, Plan Room M0). Rules unchanged:
- engine-doc gains **raster image input** (PNG/JPG as a 1-page doc) — needed by
  the base viewer generally and roofing especially (see below).
- Done = sitework's `app.js` is only domain glue (grading/contours/cut-fill,
  walls, hatch detection, its presets) — which then becomes the **sitework
  trade pack** in Plan Room M8.

## Roofing domain spec (the pack itself)
- **Input reality:** new-construction bids come from PDF plan sets; residential
  re-roofs (the biggest segment) have **no plans** — an aerial image
  (Google-Maps screenshot, drone photo) calibrated on a known dimension is the
  document. Both are engine-doc features; the pack just assumes them.
- **Planes:** trace each roof plane (plan view), assign pitch (x/12 presets
  3/12–12/12 or custom). Sloped area = plan SF × `sqrt(1+(x/12)²)`; report
  per-plane and total **squares** (100 SF) + waste % (guidance ~10% gable,
  ~15% hip/cut-up; editable).
- **Lines:** eave, rake, ridge, hip, valley, step/wall flashing → LF. Hip and
  valley get their own pitch-corrected length factor (configurable multiplier
  per line type with sensible defaults; document the math inline).
- **Counts:** pipe boots, box/ridge vents, skylights, chimneys.
- **Materials math:** bundles (default 3/square), ridge-cap bundles from
  ridge+hip LF, underlayment rolls (default 4 sq/roll synthetic), ice & water
  from eave+valley LF × width, drip edge 10' sticks from eave+rake, starter
  strip LF, fasteners. All rates editable; quantities flow into the shared
  bid/price engine with a roofing default price library (per-square
  tear-off/install, per-LF flashing/edge, per-EA penetrations).
- **Aerial caveat UX:** an aerial measures *plan* area (the pitch factor
  handles slope — correct by design), but oblique photos distort; hint
  top-down capture + calibrate on a known straight dimension; estimator-grade
  accuracy disclaimer (we are not claiming EagleView precision).

## Delivery (as part of Plan Room M8)
- Pack = presets + configs + compute glue on the shared engine inside the
  planroom app: plane tool (area object + pitch attribute), roofing line/count
  preset sets, materials calculators, bid defaults.
- Verification: pitch-factor table sanity (4/12→1.054, 6/12→1.118,
  8/12→1.202, 12/12→1.414); a hand-calced gable roof matches to the SF; an
  aerial-calibrated re-roof produces a sane priced bid end to end.
- Gating: base + takeoff flags (stacked billing) — no roofing-specific flag.

## Later (kept from the original plan)
- **Auto-measure from an address/aerial** (the true EagleView swing —
  vision-hard) and a photo pitch estimator. Explicitly out of MVP; a separate
  decision when the manual pack is earning.
