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

⚠️ **Needs David:** hard-refresh — cache-bust **v35**.

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
