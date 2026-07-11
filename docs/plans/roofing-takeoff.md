# OpsFloa — Roofing Takeoff (paid add-on, shared measure engine)

Status: **scoped, not started** (2026-07-11). File references name mechanisms, not
line numbers — verify against current code at build time.

## Context
Repeat the sitework-takeoff pattern: a specific trade with an expensive incumbent
→ a focused browser tool that nails the core 20% on the engine we already have.
Roofers are the strongest candidate because they **already pay per measurement**
(EagleView / Hover, $20–100 *per report*) — proven willingness to pay, big
fragmented market, and roof takeoff is exactly the engine's motion: polygon area
+ linear feet + counts, plus pitch math.

## Decisions (locked with user, 2026-07-11)
1. **Own add-on SKU** — `addon_roofing`, `STRIPE_PRICE_ROOFING(_ANNUAL)`,
   mirroring the takeoff add-on end to end (migration, webhook, one-click
   add/remove, superadmin override, hidden ToolsPage tab without it).
2. **Extract a shared engine first** (not a fork). Drywall/paint takeoff and a
   Bluebeam-style plan viewer are queued next — the extraction is paid for three
   times. The sitework tool must stay shipped and green throughout.
3. **MVP input = PDF plan sets AND aerial/raster images.** Residential re-roofs
   (the biggest segment) have no plans — accept a dropped-in image (Google-Maps
   screenshot, drone photo) calibrated on a known dimension.

## Phase 0 — shared engine extraction (`client/public/tool-apps/shared/`)
Today `sitework/app.js` is a ~5,000-line single file. Split the generic engine
into browser ES modules (`<script type="module">` — these are static no-build
apps) that both tools import:
- `engine-view.js` — canvas, pan/zoom, HUD, nav pads
- `engine-doc.js` — pdf.js loading + **new: raster image loading** (PNG/JPG as a
  1-page doc), base64 embed/extract for self-contained save files
- `engine-measure.js` — scale calibration (`ftPerPx`), polygon area / path
  length / point math, snapping, curve mode (Catmull-Rom)
- `engine-store.js` — IndexedDB projects/files, save/load file, undo/redo stacks
- `engine-ui.js` — modal/ask helpers, toolbars/flyouts, collapsible group lists
- `engine-bid.js` — priced bid report + branded print/CSV
- `engine-share.js` — company cloud (`apiFetch`, share/copy/conflict flow)

Rules: **one module per commit**, sitework switched to the module in the same
commit, smoke-tested after each (`node --check` + open the tool: trace, area,
bid, save/load, share). Version the imports (`?v=N` query param) so Vercel's
static caching can't serve mixed old/new modules. Done = sitework's `app.js` is
only sitework-specific glue (grading/contours/cut-fill, walls, hatch detection,
its area/line/count types).

## Roofing tool (`client/public/tool-apps/roofing/`) — net-new domain logic
- **Planes:** trace each roof plane (plan view), assign a pitch (x/12 presets
  3/12–12/12 or custom). Sloped area = plan SF × `sqrt(1+(x/12)²)`; report
  per-plane and total **squares** (100 SF) + waste % (guidance: ~10% gable,
  ~15% hip/cut-up; user-editable).
- **Lines:** eave, rake, ridge, hip, valley, step/wall flashing → LF each. Hip
  and valley get their own pitch-corrected length factor (configurable
  multiplier per line type with sensible defaults; document the math inline).
- **Counts:** pipe boots, box/ridge vents, skylights, chimneys.
- **Materials math:** bundles (default 3/square), ridge-cap bundles from
  ridge+hip LF, underlayment rolls (default 4 sq/roll synthetic), ice & water
  from eave+valley LF × width, drip edge 10' sticks from eave+rake, starter
  strip LF, fasteners. All rates editable; flows into the bid as quantities.
- **Bid:** reuse `engine-bid.js` with a roofing default price library
  (per-square tear-off/install, per-LF flashing/edge, per-EA penetrations),
  overhead & profit, branded print — same output motion as sitework.
- **Aerial-image caveat UX:** measuring an aerial gives *plan* area (pitch factor
  handles slope — that's correct), but oblique photos distort; hint the user to
  use top-down capture and calibrate on a known straight dimension. Show an
  estimator-grade accuracy disclaimer (we are not claiming EagleView precision).

## Platform wiring (mirror the takeoff add-on exactly)
- Migration **`0133_addon_roofing.sql`** (verify next free number at build time):
  `companies.addon_roofing BOOLEAN NOT NULL DEFAULT false` + db-enums.md note if
  any fixed-value column is added (none expected).
- `server/routes/stripe.js`: plans/status/checkout include roofing; webhook maps
  `STRIPE_PRICE_ROOFING(_ANNUAL)` → `addon_roofing`; `ADDON_PRICES` entry;
  one-click `POST /addon` + `/addon/remove` already generic — add the SKU.
- `server/routes/auth.js` session + `AuthContext` include `addon_roofing`;
  superadmin PATCH/list/toggle like `addon_takeoff`; BillingPanel card
  ("+ Roofing Takeoff add-on", plus-prefix consistency).
- ToolsPage: `Roofing Takeoff` tab, hidden without add-on/trial/exempt (same
  `hasTakeoff` pattern).
- **Company sharing:** reuse `takeoff_projects` + `server/routes/takeoffs.js`
  with a `data.app` marker (`'roofing-takeoff'`); client list filters by marker
  so the two tools' libraries don't mix. Generalize the mount gate from
  `requireTakeoffAddon` to "has takeoff OR roofing add-on" (middleware takes a
  list), since the route now serves both tools.
- **User action required:** create the Stripe product/prices and set
  `STRIPE_PRICE_ROOFING` + `STRIPE_PRICE_ROOFING_ANNUAL` in Render env.

## Milestones (committable slices, all to `dev`, push after each)
- **M0 — engine extraction:** the Phase 0 module series; sitework behaviorally
  unchanged at every commit.
- **M1 — roofing skeleton:** new tool-app on the shared engine — open PDF/image,
  calibrate, pan/zoom, projects, save/load; plane takeoff with pitch → squares.
- **M2 — full takeoff:** roof line types + counts + materials math + waste;
  quantities panel with per-plane breakdown.
- **M3 — bid:** roofing price library defaults + branded bid report.
- **M4 — platform:** add-on migration/Stripe/superadmin/BillingPanel/ToolsPage +
  shared-library reuse. Tool goes live gated.
- **M5 (later, separate decision):** auto-measure from address/aerial imagery
  (the true EagleView swing — vision-hard) and a photo pitch estimator.

## Verification
- **M0:** after each module commit, sitework smoke: open PDF, scale, trace, area
  w/ color, line, count, undo/redo, save/load file, company share/copy, bid.
- **Math:** pitch-factor table sanity (4/12→1.054, 6/12→1.118, 8/12→1.202,
  12/12→1.414); a hand-calced gable roof matches tool output to the SF.
- **Billing:** Stripe test mode — checkout, webhook flag flip, one-click
  add/remove, superadmin override; no add-on → tab hidden, API routes 403.
- **Sharing:** roofing and sitework libraries stay separated by marker; 409
  conflict flow still works from the roofing tool.

## Risks
- **Extraction destabilizes sitework** (the shipped, paid tool): mitigated by
  one-module-per-commit + smoke each; any breakage is a one-commit revert.
- **Static-asset caching:** shared modules served from `client/public` — bump the
  `?v=` import param in every commit that changes a shared module.
- **Accuracy expectations:** roofers compare against EagleView reports; position
  as estimator-grade manual takeoff (the price difference is the point),
  disclaim aerial distortion.
- **Scope creep toward auto-measure:** M5 is explicitly out of MVP; don't let
  "snap a photo, get a roof" leak into M1–M4.
