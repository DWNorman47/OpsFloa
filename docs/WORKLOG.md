# OpsFloa — Work Log

What Claude reported back to David after each task, kept so it survives the chat
scrolling away. **Newest first.**

**What belongs here:** what shipped (with commit refs), the *non-obvious things
found along the way*, judgment calls made on David's behalf that he may want to
overrule, and anything waiting on him.

**What does NOT belong here** (so this stays scannable rather than becoming a
second copy of everything):
- Code-level rationale → the commit message.
- Parked bugs / ideas / todos → `docs/BACKLOG.md`.
- Per-feature design + milestones → `docs/plans/*.md`.
- Fixed-value column rules → `docs/db-enums.md`.

Cross-reference those rather than restating them. The unique value here is the
**findings** and the **calls** — the things that otherwise only ever existed in
a chat window.

Conventions: `YYYY-MM-DD`, newest first. ⚠️ marks something David should decide
or act on. Commit hashes are on `dev` unless noted.

---

## 2026-07-16 — Landscape & Irrigation trade pack (L1–L3, complete)

**Shipped.** The **11th** trade — `landscape` (🌳) — and the **last of the
takeoff-siblings list** in `project_tool_roadmap`. Four tools: ▢ areas → SF by
type → CY / SY / tons / lbs · ❋ plants → EA by type · ≀ irrigation runs → LF ·
⊛ heads, valves, controller, backflow → EA.
`cbd3f57` · plan: `docs/plans/landscape-irrigation-pack.md`

**Call made — this pack bids in the material's own unit, unlike the last four.**
Striping, demo and fencing all bid an installed $/unit with materials as a
panel-only cost basis, because those trades quote that way and billing the
material again would double-charge. **Landscape doesn't work like that**: mulch is
bought and sold by the **CY**, rock by the **ton**, sod by the **SY** — quoting
mulch per SF would be the unnatural choice. So here the materials math *is* the
bid, and there's no double-count exposure because each area type yields exactly
one line in exactly one unit (asserted). Seed is the exception — seeding is quoted
per SF, so it bids by SF with the lbs shown as the buying number.

**Call made — depths are per type.** A 3″ mulch bed and a 6″ soil-prep bed on the
same plan are normal, so one shared depth would be wrong on any real job. The test
asserts the bed lands at exactly 2× the mulch CY.

**Verified** against the real functions lifted out of app.js: 1,000 SF mulch @ 3″
= 9.26 CY · 1,000 SF rock @ 3″/100 lb/ft³ = 12.5 tons · 900 SF sod @ 5% waste =
105 SY · 5,000 SF seed @ 5 lb/1000 SF = 25 lb with the bid qty staying 5,000 SF ·
each type one line in its own unit · rolled-up SF flows into the CY · plants and
heads roll up at their own rates · no phantom lines · empty `state.landscape`
still computes. 51/51 kinds registered in `hitMarkup`, `MK_LABEL`, `MK_ICON`.

**Correction — I'd been miscounting the trades.** I called this the 12th; it's the
**11th**. Roofing(1) Earthwork(2) Drywall(3) Flooring(4) Framing(5) ESC(6)
Striping(7) Siding(8) Demo(9) Fence(10) Landscape(11) — verified against
`TRADE_TOOLS` and the `#tradeSel` dropdown, both of which say 11. The off-by-one
started at siding and rode along through demo, fence and landscape. The plan docs
and this log are corrected; **the commit messages for siding / demo / fence /
landscape still say 9th / 10th / 11th / 12th** and can't be rewritten now that
they're pushed — the docs are the source of truth on the count.

⚠️ **Needs David:** hard-refresh — cache-bust **v41**.

---

## 2026-07-16 — Fencing & Guardrail trade pack (F1–F3, complete)

**Shipped.** The **10th** trade — `fence` (🚧), in the $60 Takeoff add-on, no own
SKU. Another trade riding the same site plan that already gets an Earthwork / ESC
/ Demo takeoff. Tools: ⌗ runs → LF + posts by type (8 types) · ⊓ gates &
guardrail end treatments → EA, plus a post-concrete cost basis.
`e815bc9` · plan: `docs/plans/fencing-guardrail-pack.md`

**Call made — posts count per run, and this is the entire pack.** Every run needs
a post at **both** ends, so it's ⌈LF ÷ spacing⌉ + 1 evaluated **per run**.
Summing the LF first and computing once is the obvious shortcut and it's wrong:
two 50-ft runs at 10 ft are 6 + 6 = **12** posts, not ⌈100/10⌉+1 = **11**. The
error compounds — a 20-run job comes out **19 posts short**, plus their concrete,
and nothing about the number would look wrong. The test asserts 12 and explicitly
fails on 11.

**Call made — spacing belongs to the fence type, not the project.** Chain link
runs at 10 ft, vinyl privacy at 6, W-beam guardrail at 6.25 (the standard). A
single project-wide spacing setting would be wrong on every mixed job.

**Pattern worth naming — the installed-price trap, now the third time.** `$/LF`
for fence already includes posts, rails, fabric and concrete, so the post count
and its concrete are a **panel cost basis and never bid lines**. Same call as the
striping pack's paint gallons and demo's haul-inside-the-unit-price. All three
are now *asserted* in tests rather than just commented, so a later change can't
quietly re-introduce a double-charge. Gates genuinely are quoted on top of the
LF, so those do bid.

**Verified** against the real functions lifted out of app.js: 12 posts not 11 ·
20 × 50 ft = 120 posts · vinyl at 6 ft = 18 posts and $42/LF not chain link's $18
· guardrail at 6.25 ft = 17 posts · 12 holes at 10″ × 30″ = 1.36 CF each → 0.61
CY → 37 bags · empty `state.fence` defaults hold · a zero-length run yields no
posts. 47/47 kinds registered in `hitMarkup`, `MK_LABEL`, `MK_ICON`.

⚠️ **Needs David:** hard-refresh — superseded by **v41** (landscape pack).

---

## 2026-07-16 — Demolition trade pack (D1–D3, complete)

**Shipped.** The **9th** trade — `demo` (💥), in the $60 Takeoff add-on, no own
SKU. Finishes the sitework suite: a site contractor now takes off demo, cut/fill
and the ESC plan for one job in one tool, same buyer and same plan set. Three
tools: ▣ areas → SF by type → debris CY, tons, truck loads · ⌁ linear removals →
LF by type · ⊠ items & structures → EA by type.
`1731a20` (D1) · `a0f2aa2` (D2–D3) · plan: `docs/plans/demolition-pack.md`

**Call made — buildings and pavement convert completely differently, and this is
the whole pack.** A **building is mostly air**: footprint × height is nonsense —
a 1,000 SF house is not 444 CY of debris, it's the walls, roof and floor. So
buildings use an empirical **CY per SF of footprint** (wood ≈ .25, masonry ≈ .45,
steel ≈ .20 — steel lowest because the frame goes to scrap, not the pile), with
bulking already in the factor. **Pavement is solid**: thickness → in-place CY →
*then* swelled, because broken concrete and asphalt bulk ~40–60% once ripped.
Three consequences worth knowing:
- Hauling the **un-swelled** volume under-books trucks — 92.6 vs 138.9 CY on the
  test job, four fewer loads.
- Swell must **not** touch buildings, or the bulking double-counts. The test
  asserts building CY is identical at 0% and 100% swell.
- **Tons come off the in-place volume, not the swelled one** — swell moves air,
  not weight.

**Call made — removals and items don't feed the CY pile.** Linear removals and
item removals are quoted with haul *inside* the unit price, so they're excluded
from the debris CY and the load count; counting them would bill the same hauling
twice. The test asserts CY and loads are unchanged by adding 500 LF of curb and
10 trees, so a later change can't quietly reintroduce it.

**Call made — `truckCap` is demo's own setting**, not `state.earthwork.truckCap`.
Same trucks in real life, but coupling them would mean editing the earthwork
setting silently re-prices the demo bid. ⚠️ Overrule this if you'd rather have
one number for the job.

**Verified** against the real functions lifted out of app.js, including the edges
that ship silently wrong: `truckCap: 0` yields finite loads, not `Infinity`;
empty `state.demo` falls back to the documented defaults; concrete uses its own
6" not asphalt's 3"; same-type areas roll up. 45/45 kinds registered in
`hitMarkup`, `MK_LABEL`, `MK_ICON`.

⚠️ **Needs David:** hard-refresh — superseded by **v40** (fencing pack).

---

## 2026-07-16 — Siding, Gutters & Insulation trade pack (Si1–Si3, complete)

**Shipped.** The **8th** trade — `siding` (▥), in the $60 Takeoff add-on, no own
SKU. Completes the residential shell: with Framing → **Siding** → Roofing →
Drywall → Flooring, a builder takes off the whole house in one tool. Also reaches
the roofing buyer, since roofers sell gutters. Four tools: ▥ elevations → gross
SF by material (7 materials), ⊡ openings → deduct SF + trim EA, ⌐ gutters →
LF by type, ▩ insulation → SF by R-value → bags.
`0a86f9f` (Si1) · `53f23ff` (Si2–Si3) · plan: `docs/plans/siding-gutters-insulation-pack.md`

**Call made — the net-area trap.** Gross elevation area over-bids every house; on
some elevations the wall is mostly glass. So `swall` traces gross and `sopening`
deducts, and the bid uses **net**. The panel shows **gross / deduct / net side by
side** rather than silently folding the deduction in — the deduct is the number
most likely to be wrong, so it should be inspectable. Openings still bill a trim
& wrap EA on top: an opening removes SF but *costs* money, because cutting siding
around one is more work per foot than the field.

**Call made — how the deduct splits across materials.** Openings aren't attached
to a wall, so the deduction is apportioned by each material's share of gross.
That's **exact** on a single-material job (the common case) and an honest
approximation on a mixed one. Flagging it because it's a real modelling choice,
not a fact: the alternative is making the user assign each opening to a wall,
which is more clicking for a rounding difference. Asserted that the per-material
nets sum back to the total.

**Call made — only batts convert to bags.** Blown and spray foam are bid straight
by SF, so a bag count there would be a meaningless number that looks
authoritative. Batts get bags at the coverage setting; the others don't.

**Verified** against the real functions lifted out of app.js (same method as ESC
and Striping). The worked example: 1,200 SF − 4 windows − 1 door = **1,119 net**
→ 1,230.9 SF at 10% waste → 11.19 squares. Plus the edges that would ship
silently wrong: over-deduction **floors net at 0** with no negative bid
quantities; openings traced before any wall don't divide by zero; mixed materials
split 50/50 and sum back; 1,760 SF R-13 @ 5% = 1,848 SF = **21 bags**; and the
one that matters most with three kinds sharing a totals loop — **gutters and
insulation never leak into the wall area** (gross stays 1,200 with 880 SF of
insulation traced).

**Structural.** 42/42 kinds registered in `hitMarkup`, `MK_LABEL`, `MK_ICON`;
`swall`/`sinsul` in `NEEDS_SCALE` + `CLOSED_KINDS`, `sopening` in `POINT_KINDS`.

⚠️ **Needs David:** hard-refresh — superseded by **v39** (demolition pack).

---

## 2026-07-16 — Parking-lot Striping & Signage trade pack (S1–S3, complete)

**Shipped.** New `striping` trade (🅿) in Plan Room, in the $60 Takeoff add-on,
no own SKU. Pairs with the asphalt paving area takeoff already in Earthwork — the
same site plan that gets a paving takeoff gets a striping plan. Three tools:
⊞ stalls → EA by type with a **separate ADA tally**, ≡ painted runs → LF by type
(4"/6"/8" line, 12" crosswalk, 24" stop bar, hatching), ◆ markings & signs → EA
by type (arrow, ONLY legend, ADA symbol, sign, wheel stop, bollard). Plus a
paint/bead cost basis in the panel.
`47ddf6a` (S1) · `4a70108` (S2–S3) · plan: `docs/plans/striping-signage-pack.md`

**Call made — the double-count trap, designed around rather than papered over.**
Striping is bid **per stall** (the stall price includes painting its own lines)
**or** per LF, not both — so counting a stall *and* tracing its lines charges the
paint twice. So `sstall` counts stalls priced per stall, and `sstripe` is only for
the runs that **aren't** stall lines (stop bars, crosswalks, lane lines,
hatching). The panel says this in bold, because it's the one thing a new user
would get wrong. Same reasoning kept the S3 paint gallons **out of the bid** —
the $/LF and $/EA are installed prices that already include paint. The test now
*asserts* paint never reaches the bid, so a later change can't quietly
reintroduce the double-charge.

**Call made — paint is width-weighted, not raw LF.** A 24" stop bar eats **6×**
the paint of a 4" line per foot, so `stripingPaint()` converts everything to
"4-inch-equivalent LF" before dividing by coverage. Summing raw LF would have
under-counted paint badly on any lot with stop bars or crosswalks — and it would
have looked perfectly reasonable in the panel.

**Verified** the same way as ESC — `stripingTotals`/`stripingPaint`/
`stripingBidLines` lifted **verbatim out of app.js** and run against stubbed
state, not re-implemented in the test. 320 LF of 4" = exactly 1.0 gal · 320 LF of
24" = 6.0 gal · 12" crosswalk = 3× · mixed widths sum to 380 4"-equivalent LF ·
2 coats doubles · 40 standard + 2 ADA + 1 van = 43 stalls / ADA tally 3 · stop bar
prices at its own $2.25 not the 4" rate · ADA stall at $45 not $5 · untraced types
emit no phantom $0 lines · empty `state.striping` still computes.

**Structural.** Registered without repeating the older packs' bugs: `sstripe` in
`NEEDS_SCALE`, `sstall`/`smark` in `POINT_KINDS`, and all three in `hitMarkup`.
Re-audited after: **38/38** kinds present in `hitMarkup`, `MK_LABEL` and
`MK_ICON`.

⚠️ **Needs David:** hard-refresh — superseded by **v37** (siding pack).

---

## 2026-07-16 — Erosion & Sediment Control trade pack (E1–E3, complete)

**Shipped.** New `esc` trade (🌱) in Plan Room, in the $60 Takeoff add-on, no own
SKU. Same buyer and same plan set as the Earthwork flagship — every grading
permit carries an ESC/SWPPP sheet. Three tools: 〰 control runs → LF by type
(7 BMP types), ⊘ point BMPs → EA by type (5 types), ▧ stabilized areas → SF →
stone tons / SY / seed lb + mulch tons. Everything prices into `$ Bid`;
double-click any markup to change its type.
`c1bf94e` (E1) · `022c040` (E2) · `d3234a8` (E3) · plan: `docs/plans/erosion-sediment-control-pack.md`

**Found — flooring & framing markups were completely unselectable.** `e786e0e`.
`hitMarkup()` resolves *both* the select tool and the double-click handler, and
its switch has **no `default:`** — an unlisted kind silently can't be clicked at
all. Seven kinds were never registered: `froom`, `ftrans`, `fwall`, `fopening`,
`fsheath` (the **entire flooring and framing packs**), `dheight`, and `escline`.
So every *"double-click a room to change its material"* / *"double-click a wall
to change its size"* — documented as shipped in the plan docs and promised in the
tooltips — **did nothing**, and those markups couldn't be selected, moved, or
deleted either; only undo removed them. Fixed all seven by geometry; audited
`MK_KINDS` against the switch afterwards → 33/33 hit-testable. Only surfaced
because ESC would have shipped with the same dead double-click.

**Found — the panel close-lists had drifted.** Each of the seven panel toggles
hard-coded its own list of "the others to close", and they'd fallen out of sync
as packs were added: `btnRoof` predates flooring/framing, so **opening Roof left
Framing open**. Replaced all seven with `closeOtherPanels(keepId)` over one
`PANEL_IDS` list. Also fixed CSS the flooring/framing packs missed —
`#floorPanel`/`#framPanel` were never in the panel width rules, so they sized to
content instead of the shared 268px.

**How the math was verified** (David asked for this on Storm, so it was done
properly here): `escTotals`/`escMaterials`/`escBidLines` were lifted **verbatim
out of app.js** and run against stubbed state — *not* re-implemented in the test,
which would only re-derive the same mistakes. 5,000 SF entrance @ 6"/105 lb/ft³ →
131.25 tons / $4,593.75 · 10,000 SF blanket @ 10% → 1,222.2 SY · 43,560 SF →
exactly 1.00 acre → 200 lb seed + 2 ton mulch · 500 SF riprap @ 12" → 26.25 tons ·
rollups hold · empty `state.esc` still lands on 131.25 tons (defaults are real).
`escMaterials()` is shared by the bid and the panel so the two can't drift.

**Calls made.** Three deliberate deviations so ESC didn't inherit the older packs'
bugs: `escline`/`escarea` **are** in `NEEDS_SCALE` (an uncalibrated sheet refuses
the tool instead of silently measuring 0); `escitem` **is** in `POINT_KINDS` (one
click per BMP, not two); rate inputs render only for the area types actually
traced, so an empty panel isn't six numeric fields of noise. The older packs'
equivalents are filed in `BACKLOG.md` rather than fixed in-place.

⚠️ **Needs David:** hard-refresh — superseded by **v35** (striping pack).

---

## 2026-07-16 — Currency: full sweep (a customer's Lempiras showed as dollars)

**The report:** a customer set their profile to Honduran Lempira and amounts came
up as dollars.

**Root cause — not what it looked like.** The currency was always saved
correctly, HNL was always supported, and `settings.currency === 'HNL'` always
reached the browser. The bug was that **only ~10 of ~25 money-render sites ever
read it**. Three separate failure modes: hand-rolled `Intl` pinned to
`currency:'USD'`; literal `` `$${v}` `` concatenation; and a shared
`formatMoney()` whose `currency` option defaulted to USD and which **not one of
its five callers ever passed**. Its own header said it existed so "every page
renders the same way" — the consolidation happened, currency was never wired
through.

**Shipped** (6 commits, `136cbf9` → `7c6d788`): a `useCurrency()` /
`useCents()` / `useMoney()` hook trio off the existing `SettingsContext`, then
every site — the 5 `formatMoney` pages, all 5 PDFs, Inventory, Catalog, Financial
Reports, Dashboard, PayStub, Reimbursements, the 3 public client-facing pages
(currency added to the server payload — they're unauthenticated and can't read
`/api/settings`), and the 2 server-rendered emails (`server/currency.js` is new;
the server had no money formatter at all). Verified at each step: client lint,
212 client tests, 695 server tests, build.

**Found — a near-miss that would have shipped looking fixed but reading wrong.**
Intl takes the currency symbol from the **locale**, not the currency code:
`en-US` + `HNL` → **"HNL 1,234.50"**, `es-HN` + `HNL` → **"L 1,234.50"**.
`formatMoney` pinned `locale:'en-US'`, so binding its currency *alone* would have
produced "HNL 1,234.50" everywhere while the already-correct pages showed
"L 1,234.50". Caught by actually running Intl both ways; fixed at the root with
`localeForCurrency()` so both formatters agree.

**Found — the real scope was ~22 sites, not the ~15 the audit reported.**
Re-grepping after each batch kept surfacing misses: Reimbursements ×2,
PayStubView, InventoryItems/Stock/PurchaseOrders, ManageProjects — plus hardcoded
`$` on **mileage rates**, which keep 4dp and so use `currencySymbol()`
(`formatCurrency` would round $0.6700/mi → $0.67/mi).

**Calls made** — overrule any of these if wrong:
- **`BillingPanel`'s `$20/mo` left hardcoded** — OpsFloa's own subscription bills
  in USD regardless of the customer's currency.
- **`server/currency.js` duplicates the client's locale map** — the two bundles
  can't share a module; commented as a deliberate mirror on both sides.
- **A module-level "active currency" global was rejected** even though it'd be a
  far smaller diff: settings load async, and mutating a module variable doesn't
  re-render a page that already painted, so early renders would keep their dollar
  signs.
- **`docs/db-enums.md`**: added the missing `currency` row and documented the
  sharp edge — the PATCH check is only `/^[A-Z]{3}$/`, so it validates **shape,
  not membership**; `XYZ` saves fine and renders as a bare code. Adding a currency
  means touching **three** places (dropdown + both locale maps). Also dropped the
  stale `label_work` entry.

**Not touched:** the Plan Room / sitework tool-apps still hardcode `'$'` —
sandboxed static HTML with no `SettingsContext` access. Filed in `BACKLOG.md`
with the likely fix (the `tc_addons` localStorage bridge).

---

## 2026-07-16 — Currency: production hotfix (bill PDF)

**Shipped to production** via `hotfix/billpdf-currency` → PR #214 (`66c47aa`).
David asked to ship just this one fix ahead of the sweep.

**The bug:** two mistakes compounding in `BillPDF.jsx`. `fmtMoney` hardcoded
`` `$${v.toFixed(2)}` ``, **and** the component never destructured the `currency`
prop that `WorkerMetrics` had always passed it — so the value was silently
discarded. Net effect: the **screen showed `L 1,234.50` and the PDF printed from
that same screen showed `$1234.50`**. Its sibling `ProjectBillPDF` had it right;
the two had diverged.

**Call made — cut from `main`, not `dev`.** `dev` was **100 commits ahead**, so
merging it would have shipped the entire Plan Room / storm / trade-pack backlog
alongside a one-line fix. The hotfix branch changed exactly one file.
Verified before shipping: eslint, 212 tests, build, and confirmed `BillPDF` is
the file's only component so removing the module-level `fmtMoney` was safe.

**Note:** `gh` CLI isn't installed on this machine, so PRs have to be opened by
hand from the URL git prints on push.

---

## 2026-07-16 — `main` ↔ `dev` had diverged both ways

**Found while preparing the currency sweep.** `dev` was 100 commits ahead of
`main`, but `main` also had ~632 lines `dev` had never received (via `stage`
merges). Back-merged `main` → `dev` (`00898ac`); they're now in sync
(`main not in dev: 0`).

**The conflict resolution was the opposite of the obvious one.** One conflict —
`BillPDF.jsx`. The assumption was that `main` had a `settings`/`workLabel`
feature `dev` was missing. **Wrong:** the merge base already had it, and **`dev`
deliberately removed it** (`e16d6cf`, *"Remove the dynamic work/project label —
hardcode 'Project' everywhere"*), repo-wide. Taking main's side — the reflexive
move — would have silently resurrected `label_work` in the bill PDF after David
had retired it. Kept main's currency fix **and** dev's removal.

⚠️ **Worth knowing:** `dev` still carries 100+ commits unmerged to `main`
(Plan Room, storm, all the trade packs). That's a large release when it goes.

---

## 2026-07-16 — Plan Room toolbar + earthwork panel

**Shipped.** Sheet strip got a "Sheets" header + ✕ close, with a floating ❐ to
reopen (`8ec5f32`). Page-nav + Fit kept as one unit that wraps only when it must
(`7747353`). Toolbar broken into flowing units — undo/redo, the Contour+Area
dropdowns, List/Layers, and the trade/Bid/Export actions each stay together but
wrap independently (`b414bee`). Earthwork panel got its own ✕ + a floating ⛰
reopen button in the canvas's top-right, and the toolbar **Dirt button was
removed** as redundant — the panel already auto-opens on entering the trade
(`8e7b41e`).

**Found — "it didn't seem to take" was a stale cached stylesheet.** The toolbar
is CSS-driven and `styles.css` is cache-busted by `?v=N`; the browser was holding
the old file, so a structural fix looked like a no-op. Worth remembering: **any
Plan Room CSS/JS change needs a version bump *and* a hard refresh**, or it will
look like the change didn't work.

**Call reversed by David:** group-separation spacing was added so the toolbar
units read as distinct groups, then removed at his request — uniform gaps, groups
only separate when the row wraps (`05fe3f1` → `73e78ee`).

---

## Standing items waiting on David

⚠️ **Storm/Utility is built but unsellable.** `STORM_SELLABLE=false` in
`BillingPanel.jsx` hides every buy path until the utility math is hand-verified.
To sell: verify the math → flip to `true` → set `STRIPE_PRICE_STORM` to **$20**
in the Stripe dashboard. (The ESC pack's verification approach — lifting the real
functions out of app.js and running them against stubbed state — would work here
too.) See `docs/plans/storm-utility-pack.md`.

⚠️ **Roofing math** still wants a hand-verification pass.

⚠️ **Sitework ↔ Plan Room parity test** still outstanding.

⚠️ **Three open backlog items** from the currency sweep — tool-apps `'$'`,
flooring/framing missing from `NEEDS_SCALE`, `fopening` missing from
`POINT_KINDS`. See `docs/BACKLOG.md`.
