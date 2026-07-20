# OpsFloa — Parking-lot Striping & Signage takeoff pack (inside the Plan Room Takeoff layer)

Status: **S1–S3 all shipped — pack complete** (2026-07-16). A new takeoff **trade** in Plan Room
(alongside Roofing, Earthwork, Drywall & Paint, Flooring & Tile, Framing &
Lumber, Erosion & Sediment Control), included in the **$60 Takeoff** add-on —
no own SKU.

## The buyer
Striping subs and the paving contractors who sub them. Pairs directly with the
**asphalt paving area takeoff already in the Earthwork trade** — the same site
plan that gets a paving takeoff gets a striping plan, so it's the same sheet the
buyer already has open. Everyday, high-repetition work with a small enough scope
that a focused browser tool beats a $1,500/yr seat.

## The domain motion
A striping plan is stalls, painted lines, and point items — Count + Line only, no
new geometry. The value is the type taxonomy, the ADA tally (which is what gets a
lot rejected), and the paint/bead math.

## Trade shape (mirrors ESC / Framing)
- New trade `striping` (🅿), trade-dropdown option, body class `trade-striping`,
  toolbar sub-row (`tr-strp`), side panel (`strpPanel`), bid section.
- `state.striping` project settings (shape fixed in S1 so persistence is wired
  once; the paint fields go live in S3): 4" paint coverage (LF/gal), glass-bead
  rate (lb/gal), coats.

## The double-count trap (why the tools are split this way)
Striping is really bid **per stall** (the stall price includes painting its own
lines) or **per LF**, not both — so counting a stall *and* tracing its lines
double-charges the paint. The split here matches how it's actually bid:

- **`sstall`** counts stalls, priced **per stall, striping included**.
- **`sstripe`** traces only the lines that are **not** stall lines — stop bars,
  crosswalks, lane lines, hatching, curb lines.

The panel says this out loud, because it's the one thing a new user would get
wrong.

## Takeoff motions
- **Stalls (Count → `sstall`, S1):** click each stall → EA by **type**
  (standard, compact, ADA accessible, ADA van-accessible).
- **Stripe runs (Line → `sstripe`, S1):** trace a run → LF by **type**, each
  carrying its paint width: 4" / 6" / 8" line, 12" crosswalk, 24" stop bar,
  hatching.
- **Markings & signs (Count → `smark`, S2):** arrows, ONLY/legends, ADA symbol,
  signs, wheel stops, bollards → EA by type.

## Materials math (rates editable, into the shared bid)
- **Stalls / markings / signs:** installed $/EA — labor and paint baked in, the
  way they're quoted.
- **Stripe runs:** installed $/LF per type.
- **Paint + beads (S3, panel-only cost basis — like framing's board-feet):**
  gallons = Σ(LF × width÷4) ÷ coverage4in × coats; beads = gallons × bead rate.
  Deliberately **not** bid lines: the $/LF and $/EA above are installed prices
  that already include paint, so adding gallons to the bid would double-charge.

## Milestones (each committable to `dev`, push after each)
- **S1 — trade + stalls + stripe runs** ✅ *shipped*: `striping` trade (🅿) + `sstall` count
  kind (4 stall types, double-click to change) + `sstripe` line kind (6 line
  types, double-click to change); bid = stalls EA + stripe LF by type at seeded
  installed prices; panel shows stalls-by-type with an **ADA tally** and
  LF-by-type. Persists in projectData + all 5 load paths.
- **S2 — markings & signs** ✅ *shipped*: `smark` count kind (arrow, ONLY legend,
  ADA symbol, sign, wheel stop, bollard) → EA by type, double-click to change;
  bid EA lines at seeded installed $/EA; panel "Markings & signs" section.
- **S3 — paint & bead cost basis** ✅ *shipped*: `stripingPaint()` converts every
  run to **4"-equivalent LF** (a 24" bar is 6× the paint of a 4" line per foot)
  → gallons ÷ coverage × coats → bead lbs. Coverage / coats / bead-rate inputs
  render only when there are runs. Panel-only, never a bid line.

## Verification
`stripingTotals`/`stripingPaint`/`stripingBidLines` are lifted **verbatim out of
app.js** and run against stubbed state, rather than re-implementing the formulas
in the test. All pass:
- 40 standard + 2 ADA + 1 van → **43 stalls, ADA tally 3**
- 120+80 LF of 4" rolls up to **200 LF → $70** @ $0.35
- a 24" stop bar prices at its **own $2.25**, not the 4" rate; an ADA stall at
  **$45**, not the standard $5
- arrows roll up (6+2 = 8 → $280); a sign prices at its own $165
- **320 LF of 4" = exactly 1.0 gal** @ 320 LF/gal → 6 lb beads
- **320 LF of 24" stop bar = 6.0 gal** (6× the 4" line — width weighting works)
- 100 LF of 12" crosswalk → 300 4"-equivalent LF (3×)
- mixed 160 LF 4" + 80 LF 8" + 10 LF 24" → **380 4"-equivalent LF**
- 2 coats doubles the gallons
- **paint never reaches the bid** (asserted) — the installed rates include it
- untraced types emit no phantom $0 lines; an empty `state.striping` still
  computes (defaults hold, beads finite)

Structural: `sstripe` in `NEEDS_SCALE` (measures LF); `sstall`/`smark` in
`POINT_KINDS` (one click, no rubber band); all **38** kinds present in
`hitMarkup`, `MK_LABEL` and `MK_ICON` — an unlisted kind is silently unclickable,
which is what ate the whole flooring/framing double-click (see
`docs/WORKLOG.md` 2026-07-16). `app.js` parses;
`git status --porcelain client/public/tool-apps/sitework/` clean.
