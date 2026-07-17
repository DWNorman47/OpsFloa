# OpsFloa — AI Jump Start (Plan Room): plan

Status: **building the engine** (2026-07-17). A vision-model layer in Plan Room
that reads the current page and lays down a reviewable *first draft* of markups.
Named to set the expectation honestly: a **jump start you finish**, never an
authoritative takeoff.

## Design decisions (settled with David)

- **Best vision model**, not the Haiku the office text tools use. Own model knob.
- **Per page.** Bounded cost, bounded scope, matches "do the current page."
- **Pay per use** — a token/credit bucket, priced on the hour of estimator time
  saved (raw API cost is pennies–~$0.50/page; the value is 20–60 min).
- **Plan for scans, be pleasantly surprised by vector.** David expects scans, so
  the beachhead is designed for raster; the vector fast-path is upside.
- **Everything lands as a distinct, reviewable "Jump Start" layer** with
  provenance ("read from the sheet" vs "estimated") — never merged silently. For
  a takeoff tool, confident-but-wrong is worse than nothing.

## The reliability reality (why the beachhead is what it is)

On a **scan**, no geometry is extractable — every shape comes from the model
reading pixels, which is where vision models are least precise. So:

- **Reliable (v1 beachhead):**
  - **Counts** — the sweet spot. Discrete symbols (inlets, stalls, trees,
    fixtures) → point markers. Vision counts reasonably; points need no precise
    polygon and are scale-independent; trivial to review.
  - **Reading the sheet** — scale notation, legend, elevation labels, sheet
    number/title. Good at text even on scans; kills data-entry time.
- **Assistive (v1, low confidence):** rough **regions** (parking/pad/pond) as
  candidate polygons the user reshapes. Right neighborhood, wrong vertices.
- **Not v1 — roadmapped:** precise **contours** (see below). Least reliable
  thing to ask of a scan.

## Scale — the one subtlety worth stating

Plan Room's base px = PDF points (viewport scale 1), and 1 inch = 72 pt. So on a
**true-scale/vector** PDF, the scale *notation alone* gives the calibration:
`ftPerPx = feetPerInch / 72` — no pixel measurement. On a **scan** the page size
is the scan's, not the sheet's, so that shortcut is invalid; the notation gives
the ratio but a pixel reference is still needed. v1 therefore: read the scale
text, pre-fill the feet value, and ask the user to draw one reference line (or
confirm a scale bar the model located). Auto-apply `/72` only once we detect a
vector sheet.

## Architecture

```
Plan Room (client)                    Server                         Claude
──────────────────                    ──────                         ──────
render current page → PNG    ──POST──► /api/jumpstart/page  ──image──► vision model
(pdf.js canvas → dataURL)             runAi meter + prompt            (best model)
                                      parseJumpstart(text)  ◄──JSON───┘
place as reviewable AI layer ◄──JSON── {counts,regions,scale,labels}
(qcount / rough qarea, ai:true)
```

- Coordinates from the model are **normalized [0,1]** of the image, so the client
  maps them to its own base-px page dims — stable across render scales.
- **`parseJumpstart(text)`** is pure and defensive: strips markdown fences,
  extracts the JSON object, drops malformed entries, never throws (the model
  will sometimes wrap JSON in prose). Unit-tested.
- **`jumpstartToMarkups(result, page, dims)`** (client, pure, lift-tested like the
  sitework converter): normalized pts × dims → base-px markups; counts → `qcount`,
  regions → `qarea`, each `ai: true` + a confidence, so the review layer can style
  and filter them.

## Metering / pricing

- **v1:** gate behind the existing `runAi` (config check, refund-on-failure,
  per-company cap) so the prototype can't be abused — but Jump Start is far more
  expensive than a summary, so counting it as "1 office call" is a stopgap, not
  the model.
- **The real model (own milestone):** a **credit/token wallet** — buy packs, one
  Jump Start debits one credit (flat, predictable — users hate opaque token
  bills), sized so margin holds on a dense page. New billing dimension beside the
  add-ons; ties into the Stripe work already in flight.

## Accuracy levers (later, and they cost more — which the bucket funds)

- **Tiling:** split the page into overlapping crops, run per tile, stitch. The
  model sees detail and coordinates land in a smaller frame → tighter. More calls
  = more tokens.
- **Preprocess:** deskew / denoise / upscale before the model looks.

## Milestones

- **M1 — engine** (this change): `anthropic.generateVision`, `POST
  /api/jumpstart/page` metered via `runAi`, the Jump Start prompt (counts +
  scale/legend/labels + rough regions, conservative, strict-JSON), robust
  `parseJumpstart`, tests. Server-only; no UI yet.
- **M2 — Plan Room trigger:** an "AI Jump Start" button that renders the page,
  POSTs it, and drops the result as a reviewable AI layer (accept/edit/reject),
  surfacing the read scale/labels. The slice that lets David test vision quality
  on a real sheet — the critical unknown.
- **M3 — credit/token wallet** (real pricing).
- **M4 — accuracy:** tiling + preprocessing.
- **M5 — vector fast-path:** detect vector sheets, extract real paths, auto-apply
  `/72` scale — the "pleasantly surprised" upgrade.
- **M6 — AUTO CONTOURS (David wants this).** The hard one, deferred on purpose
  until the beachhead proves out and we know vector-vs-scan reality. Path:
  vector sheets first (extract contour polylines, LLM labels existing/proposed +
  reads elevations) → then scanned contours via CV line-following + LLM labeling,
  which is genuinely hard and stays "rough draft, you verify."

## Honest limitations

Scan geometry is approximate; contours are not v1; scale on a scan needs a human
reference line; vision quality is unknown until real sheets are run — M2 exists
precisely to measure it before widening scope or price.
