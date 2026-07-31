# Roof Measurement — EagleView/Hover-style report, as a Plan Room mode

## What & why
A focused **roof measurement report** tool: trace a roof on an aerial/satellite
image, get a branded report — facet areas, pitches, squares, and the linear
quantities roofers bid on (eave / rake / ridge / hip / valley) with a waste
factor. The incumbents (EagleView, Hover) charge **$20–100 _per report_**; the
pitch that wins is a flat add-on with unlimited reports, same move that won
Plan Room vs. Bluebeam.

## Key architectural finding (why this is small, not a new engine)
Plan Room's **roofing trade pack already contains the entire roof engine** —
`slopeFactor` / `hipValleyFactor` / `edgeFactor` / `planeSquares` / `edgeFt`
([app.js:505-513](../../client/public/tool-apps/planroom/app.js#L505)),
`roofingTotals()` ([app.js:585](../../client/public/tool-apps/planroom/app.js#L585)),
per-facet pitch (`m.pitch`), the `plane`/`redge`/`ritem` draw tools, edge types
(eave/rake/ridge/hip/valley/flashing) and penetrations (boot/vent/skylight/
chimney). Scale-from-image already works (calibrate tool → `state.scales[page]`),
and image files are ingested as PDF pages
([app.js:1814](../../client/public/tool-apps/planroom/app.js#L1814)). So the roof
tool is **not a new engine** — it's a new *deliverable* (the report) + new
*commercial packaging* (its own add-on) on top of geometry that already ships.

## Structure: a mode inside Plan Room, gated by an add-on (the Storm precedent)
Storm/Utility is already exactly this: a paid add-on that's a *mode* inside Plan
Room, gated by reading `localStorage.tc_addons`
([app.js:497](../../client/public/tool-apps/planroom/app.js#L497),
`hasStormAddon`), toggling a body class
([app.js:3740](../../client/public/tool-apps/planroom/app.js#L3740)). Roof follows
the same shape.

### The `roof` add-on gate (4 touch points)
1. `client/src/contexts/AuthContext.jsx` (~L81) — add `roof: !!user.addon_roof`
   to the `tc_addons` blob. (Needs a backend `addon_roof` on the user + a Stripe
   price to actually *sell* — deferred, see below. Until then `hasRoofAddon()` is
   true only for `exempt`/`trial`, so it's build-hidden like `STORM_SELLABLE`.)
2. `app.js` — `hasRoofAddon()` mirroring `hasStormAddon` (~L497); cached `ROOF_ON`.
3. `applyTakeoffGate()` ([app.js:3738](../../client/public/tool-apps/planroom/app.js#L3738))
   — `document.body.classList.toggle('has-roof', ROOF_ON)`.
4. `styles.css` — `body:not(.has-roof) .roof-only { display:none !important }`.

### The `roofmeas` mode (additive registration — never edit an existing trade case)
The per-trade logic is hard-coded in ~10 spots that have "drifted" before, so
every edit here is a **new line beside** the existing ones, never a change to
one:
- `TRADE_TOOLS` ([app.js:3746](../../client/public/tool-apps/planroom/app.js#L3746))
  — `roofmeas: ['plane','redge','ritem']` (reuse the roofing draw tools verbatim).
- `PANEL_IDS` (L3765) — add `roofMeasPanel`.
- `setTrade` body-class toggles (L3786) + hint (L3819) — add the `roofmeas` line.
- `TRADE_PANEL` (L3804) — `roofmeas: 'roofMeasPanel'`.
- `syncPanelButtons` (L3774) — `mark('btnRoofMeas','roofMeasPanel')`.
- `index.html` — a `roofmeas` entry point (a `roof-only` side button, not a
  `<select>` option — option hiding is unreliable), the report panel `<aside
  id="roofMeasPanel" class="roof-only">`, and `tr-roofmeas` added to the shared
  roof draw controls (edge/item selects, pitch/waste inputs, plane/redge/ritem
  buttons) so tracing shows in the mode.
- `styles.css` — `body:not(.trade-roofmeas) .tr-roofmeas { display:none }`.
- Bump `?v=70 → 71` on BOTH the `styles.css` and `app.js` tags in `index.html`.

### The new deliverable: the measurement report
`renderRoofReport()` + a printable modal (mirrors the `#roofBid` modal +
`printing-bid` letterhead/branding machinery,
[app.js:3879-4038](../../client/public/tool-apps/planroom/app.js#L3879)). Built
from `roofingTotals()` + a per-facet walk of `state.markups`:
- Header: squares (with waste), base squares, total plan area (SF), facet count,
  predominant pitch, waste %.
- Per-facet table: facet # · plan SF · pitch · sloped SF · squares.
- Edges by type (LF): eave / rake / ridge / hip / valley.
- Penetrations by type (EA).
- Scale note + an "uncalibrated sheet" warning (reuses `T.scaleMissing`).
- **Print** → branded one-pager via `loadBranding()`/letterhead + a
  `printing-report` body class.

## Two things to prototype first (the go/no-go)
1. **Scale from a user-supplied aerial.** Largely solved — the calibrate tool
   sets `state.scales[page]` off any two points at a known distance, and the
   report reads it. The prototype proves the *accuracy/workflow* (pick a known
   ridge or the map's scale bar).
2. **The report output.** The genuinely new artifact and the thing customers pay
   EagleView for. Built this pass.

## Decisions locked (2026-07-23)
- **Price: $40/mo** (`addon_roof`). Standalone door = Plan Room $40 + Roof $40 =
  **$80/mo**; full suite = Plan Room $40 + Takeoff $60 + Roof $40 = **$140/mo**.
  One entitlement, one price (not price-discriminated by door). Deliberately at
  the low/wedge end — easy to raise a new product later; hard to walk a high one
  back. Actual price lives in Stripe.
- **Sold standalone via a two-door design** (agreed): buyable *without* Takeoff.
  - **Door A — alternate roof button**, shown only when `has-roof && !has-takeoff`.
    Enters a clean roof-only experience; the takeoff chrome (trade dropdown, other
    trades, `$ Bid`) is already auto-hidden because it's `tb-takeoff` and they don't
    own takeoff. Requires re-gating the roof draw tools from takeoff-only to
    **takeoff-OR-roof** (a "can-do-roof" gate) so a roof-only owner can trace.
  - **Door B — the trade dropdown** (`roofmeas` mode), for takeoff owners; the
    alternate button hides when takeoff is owned. Buy/cancel transitions flip which
    door shows; saved roof projects load either way.
  - Testing wrinkle: exempt/trial reads both flags true, so Door A won't show for
    an exempt account — add a dev override to preview the roof-only door.

## Built 2026-07-23 — billing plumbing + two-door UX (behind the not-sellable gate)
The full `addon_roof` lifecycle now mirrors `addon_storm`, staged off:
- **DB:** migration `0147_addon_roof.sql` (boolean on `companies`). ⚠️ must run on
  stage/prod.
- **Session:** `buildSessionUser` selects + returns `addon_roof` → `tc_addons`.
- **Stripe:** `ADDON_PRICES.roof`, `/plans`+`/status` include roof, `/checkout` and
  `/checkout-addon` accept it, `roof` added to `STANDALONE_ADDONS`, and all three
  webhook handlers map `STRIPE_PRICE_ROOF[_ANNUAL]` → `addon_roof`. Roof **requires
  Plan Room** (enforced in all three checkout paths, like Takeoff).
- **Gate:** `requirePlanToolsAddon` now also passes on `addon_roof`, so a roof owner
  can save via `/api/takeoffs`.
- **Billing UI:** `BillingPanel` roof card + owned card + manage row, gated by
  **`ROOF_SELLABLE = false`** (mirrors `STORM_SELLABLE`). SuperAdmin has a roof toggle.
- **Two-door tool-app:** roof draw tools re-gated `tb-takeoff` → `roofwork`
  (`has-roofwork` = takeoff OR roof); alternate **Door A** button (`btnRoofDoor`,
  `.roof-door`, shown when `has-roof && !has-takeoff`); `?roofsolo=1` dev override
  (a `roof-solo` body class that hides takeoff chrome so an exempt account can
  preview the roof-only door). Plan Room `?v 72 → 73`.

## On sale (2026-07-23)
`ROOF_SELLABLE = true` — the roof card is in billing (one-click add + the
standalone buy-alone "Plan Room + Roof" flow). Remaining to actually transact:
- Create the **$40 Stripe price** (+ annual) and set `STRIPE_PRICE_ROOF` /
  `STRIPE_PRICE_ROOF_ANNUAL` in the deployed env (or the buy card stays hidden).
- Run **migration 0147** on stage/prod.
- ⚠️ **The scale-from-aerial + report math is NOT verified on a real roof** — it
  was opened for sale anyway. Verify before leaning on the output.
- ~~**Per-edge pitch accuracy:**~~ ✅ **DONE.** Each `redge` now carries its own
  `pitch` (captured at draw time; rake/hip/valley prompt for it, defaulting to the
  main pitch). `edgeFt` uses `m.pitch`, falling back to the global for edges saved
  before the change — so multi-pitch roofs are correct and old projects unchanged.
- **Discriminator on facets:** `roofingTotals()` scans *all* `plane`/`redge`
  markups regardless of mode, so a "measurement" roof and a "bid" roof on the
  same sheet share facets. Add an `m.purpose` discriminator only if that turns
  out to matter.
- Report polish: a labeled facet diagram (number the facets on the sheet), PDF
  export via the existing `exportFlatPdf`, waste presets by roof type.

## Verification
- `node --check app.js`; Plan Room still boots and every existing trade still
  switches (additive-only edits; verify no existing trade case was altered).
- `git status --porcelain client/public/tool-apps/sitework/` clean.
- Client build green (AuthContext change).
- Manual: exempt user → Roof Measure mode appears → trace facets on an image,
  set pitch, add edges → report shows correct squares/LF → print is branded.
