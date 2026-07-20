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

## 2026-07-16 — Email bounce suppression: reconnected, and made reversible

**Fixed.** `458d920`. Resend bounce webhook + two ways to undo a suppression + a
banner so it's visible at all.

**Correction to how I reported this to you:** I called it a fresh find. Half of
it wasn't. My own note from **2026-07-02** — the day of the Resend migration —
read *"Follow-up not yet done: sendgridEvents.js is now inert; wire Resend
webhooks to restore bounce tracking."* **It sat for 14 days** while the app kept
mailing dead addresses. Nothing resurfaced it, because a follow-up recorded only
in a private note has no owner and no date — it isn't tracked, it's just
remembered. That's what `docs/BACKLOG.md` is for, and it should have gone there
on 2026-07-02. It has now.

The note also only caught half. It knew the webhook was inert. It did **not**
know that nothing ever cleared the flag — the half that strands real people.

**The bug was two bugs pointing opposite ways.** `email.js` skips any recipient
whose `users.email_bounced_at` is set — sensible, that's how you avoid burning
sender reputation on dead addresses.

1. **The column's only writer was a SendGrid webhook, and email moved to
   Resend.** So it took no new data. Every bounce since the migration went
   unrecorded and the app kept mailing addresses it had already been told were
   dead. The route didn't break — it just never heard from anyone again, and
   nothing was watching for silence.
2. **Nothing anywhere cleared the column.** Three references existed repo-wide:
   the read, the write, the migration. **So anyone flagged during the SendGrid
   era was suppressed forever** — no invite, no password reset, no notification,
   no symptom an admin could see. Their mail simply stopped. A worker whose
   mailbox was full for one afternoon in the SendGrid era is, today, still
   unreachable and there was no way to fix it short of editing the database.

The second is the one that actually hurts people, and it's the one that reads as
a smaller bug.

**Found — the migration promised the visibility and it was never built.**
`0075_email_bounce_tracking.sql` says its *"primary use is visibility: admins can
see which worker emails are broken."* The columns were never returned by any
endpoint or rendered by any component. That's why this was invisible for months:
the feature that would have surfaced it was the half nobody finished.

**Calls made:**
- **Only a `Permanent` bounce suppresses.** Resend also reports `Transient` (full
  mailbox, greylisting) and `Undetermined`. Treating those as fatal would silence
  a real person because their mail server had a bad afternoon — and, before the
  clear paths, would have done it permanently. Asserted in the tests.
- **`services/emailSuppression.js` now owns every read and write of the column.**
  The read and the write living in separate files that knew nothing about each
  other is precisely how the matching rule drifted out of sync for months. One
  owner, one rule: by address, case-insensitive (`users.email` is UNIQUE, so an
  address is exactly one row).
- **Changing the address clears the flag; an unrelated edit doesn't.** The
  obvious fix for a bounce is to correct the typo, and that silently didn't work
  — the flag rode along and the new address was skipped too. But the worker PATCH
  carries the whole form, so clearing whenever `email !== undefined` would lift
  every suppression the moment someone edited a pay rate. It clears only on an
  actual change, via a `CASE ... IS DISTINCT FROM` against the pre-update row.
- **Kept `/api/sendgrid-events`, marked deprecated.** It can't be proven dead
  from the repo, and it isn't mine to delete on a guess. It now shares the same
  marking helper. Delete once Render confirms nothing posts to it.
- **Verified the signature check against the real SDK rather than stubbing it.**
  Worth it: `resend.webhooks.verify()` takes its own `{id, timestamp, signature}`
  object, **not** the `Headers` global its type name implies. Getting that wrong
  fails closed — every bounce silently rejected, which is the exact bug being
  fixed here, wearing a different hat. The tests sign real payloads and cover
  tampering and replay.

⚠️ **Not done until you set `RESEND_WEBHOOK_SECRET`.** Create the webhook in
Resend → Webhooks → `https://<server>/api/resend-events`, events `email.bounced`
+ `email.complained`, then paste the signing secret into Render. Until then the
route 503s: the code is live but deaf.

⚠️ **Worth checking:** whether any prod rows have `email_bounced_at` set. Anyone
who does has been unreachable this entire time, and the Retry button now frees
them.

---

## 2026-07-16 — GC: COI / document expiry tracker

**Shipped.** `9ee0a2f`. Sub documents now alert before they lapse (30 days) and
again, louder, once they have. Daily job + a banner on the Subs page.

**Found — the data was already there and doing nothing.**
`subcontractor_documents.expires_on` has existed since migration `0107`. It
appeared in exactly four places: the migration, the destructure, the INSERT, and
one label on the sub's own page. **No index, no query, no cron.** Every
customer's COI expiry dates have been collected and never read — a sub's
insurance lapsed silently and you found out when something went wrong. The
tracker isn't new capability so much as making collected data do its job.

**Found — I shipped a route-shadowing bug and caught it.** `/subcontractors/
compliance` was declared *after* `/subcontractors/:id`. Express matches in
declaration order, so `:id` swallowed it and tried to load a subcontractor whose
id was the string `'compliance'` — a Postgres error on an INTEGER column, a
**500 not a 404**, and invisible until someone opened the page. Moved above
`:id`, commented so it can't drift back, and pinned with a test asserting `:id`
never sees it.

**Found — `db-enums.md`'s inbox-type list had drifted.** It was missing
`equipment_rental_due` and `bid_due`, both already in use. Verified by grepping
every `createInboxItem` call site. Exactly the drift that doc predicts for an
unconstrained column.

**Call made — it warns, it doesn't block.** An expired COI does **not** stop a PO
being issued to that sub. Blocking is arguably the real value ("he can't be on
site") but it's a hard gate on a flow that already works. ⚠️ Your call.

---

## 2026-07-16 — Meeting minutes from a recording

**Shipped.** `d8b8553`. A "Turn into minutes" button on a finished transcript →
Summary / Decisions / Action items with owners / Open questions, saved on the
recording. Migration `0140`.

**The point: it connects two things that already existed but had never been
introduced.** Transcription (diarized, with editable speaker names) and the
Claude backend. You could already do this by hand — copy the transcript, paste
into the Summarizer. **And that paste is exactly what breaks it.** The transcript
*knows* Mike said it; flattening to text throws that away and the model guesses.
Building the prompt server-side from the utterances + speaker names is the whole
edge: "**Mike:** order rebar — by Monday" instead of a vague bullet.

**Calls made:**
- **Un-named speakers fall back to "Speaker A"** (David's suggestion — it was
  already the behaviour, but his question surfaced that blank-but-present names
  weren't handled, and made me tell the prompt to *keep* those labels rather than
  invent a name. A wrong name on an action item is worse than no name.)
- **Extracted the AI meter to `services/aiGate.js`.** It was private to
  officeTools, but the monthly quota is per *company* across every AI feature —
  a second copy would mean two counters disagreeing about one limit.
- **This is the first AI output OpsFloa persists.** The office tools are
  deliberately paste-in-read-out. Minutes are different in kind: a recap you
  can't find next week isn't minutes. The recording already stores its transcript
  anyway.
- **No usage badge on the Transcription tool** — transcription runs on
  AssemblyAI, not the AI budget, so a badge there would imply transcribing burns
  AI calls. The minutes panel states the cost at the point of decision instead.

⚠️ **Untested against a real meeting.** The prompt's quality is unknown until one
runs through it. Needs `ANTHROPIC_API_KEY`.

---

## 2026-07-16 — GC tools: planned, not built

**Why nothing shipped.** "GC tools" is a heading in the roadmap brainstorm, not a
feature — **~30 ideas across 7 categories**. So: surveyed the codebase, wrote
`docs/plans/gc-tools.md`. `c2e6a42`

**Found — three of the six "standouts" are already substantially built.** Lien
waivers (~90%: both directions, public sign flow, PDF), the closeout checklist
(fully built; the *assembler* isn't), and budget-vs-actual. The roadmap still
lists them as to-build — nobody updated it after building them. **Planning without
surveying would have wasted real work.**

**Found — closeout is broken for non-QBO companies, in both directions.**
`project_invoices` is a QuickBooks *mirror*: only `routes/qbo.js` writes it, so a
company without QBO has zero rows. Two checklist items read it —
`final_invoice` counts *paid* invoices → 0 → stuck at `in_progress` forever, so
**those projects can never be closed out**; `retainage_release` sums `balance` →
`SUM` over zero rows is **0** → `0 === 0` → reports **done**, certifying retainage
released on a project with no invoices. **A false negative that blocks and a false
positive that lies.** Filed — it needs the invoice decision first.

**Found — the closeout assembler has nothing to assemble.**
`project_closeout_items` has no document columns at all, despite `0111`'s header
claiming items are "checked off with notes + attached doc". So "as-builts
delivered" is a checkbox with no as-built behind it. Item-level document storage
is prerequisite work, not part of the assembler.

**Fixed in passing:** deleting a recording whose media was already swept threw a
`ReferenceError` **after** the row was deleted — a 500 and no audit row. Two lines.

**Recommendation in the plan — GC is probably not a module.** `module_sales` and
`module_subs` were backfilled by `0118`, never wired, and `db-enums` records them
as orphaned. **The codebase already ran this experiment**: both became tabs. If
GC is monetized it's `addon_gc`, not `module_gc`.

---

## 2026-07-16 — Calculators hub

**Shipped.** `72b4e74`. 12 field calculators, one tab — concrete (slab/footing/
column/wall), rebar grid, asphalt, base, slope, rafter, stairs with IRC checks,
board feet, paint, tile+thinset+grout, ft-in ↔ decimal, area/volume. Pure
client-side: no network, no AI, nothing to meter or gate. Works offline. This was
the roadmap's own idea ("a shared Calculators hub instead of a tab per calc").

**Found — a real float bug, caught by the tests.** `Math.ceil` over a float
product rounds up on **drift**, not quantity: `200 SF × 1.1 waste` is
`220.00000000000003`, so it ordered **221 tiles for an exact 220-tile job** — on
the most ordinary input the tool has. Every bag / tile / pail / riser count was a
`ceil` of a float, so all of them were exposed. Fixed via `ceilQty()`, locked by a
regression test.

**Call made — the math is data, not components.** `calculators.js` is a plain
`.js` file with no React import, so it's testable without rendering; the UI just
renders whatever it's given. Adding a calculator is one array entry. That
separation is the only reason the 40-test suite exists — including totality checks
that **no** calculator returns NaN/Infinity for empty, garbage, zero or negative
input. A field tool that prints "NaN CY" is worse than no tool.

---

## 2026-07-16 — Marketing doc rewrite + Contract Red-Flag Scanner

**Found — the marketing doc understated the product by 8 of its 11 trades.**
`OpsFloa_Features.txt` still described Takeoff as Earthwork + Roofing + Drywall;
it was written the day before Framing, Flooring, ESC, Striping, Siding, Demo,
Fence and Landscape all landed. Rewrote it around the real pitch — a GC takes off
the whole building, a site contractor takes off the whole site, nobody buys a
second seat — split THE SITE / THE BUILDING so a reader finds their trade fast,
and put the $60 add-on next to the $1,500–4,000/seat/yr the incumbents charge for
usually one trade. Also documents Storm/Utility, which the doc had never
mentioned. `e629cc0`

⚠️ **Pricing is now a live question.** $60/mo was set when Takeoff was 3 trades.
It's 11. Left as-is (land-grab pricing is defensible and raising later beats
lowering), but it should be a decision rather than an oversight.

**Shipped — Contract Red-Flag Scanner** (`8ed2520`), one of the two ad standouts
in the roadmap. Upload a subcontract → the terms that carry real money, worst
first, each with the clause quoted and the edit to negotiate.

**The prompt is the product.** It *names* the clauses that cost subs money —
pay-if-paid, notice windows, no-damage-for-delay, LDs, broad-form indemnity,
retainage release, termination for convenience, open-ended scope, written-CO
requirements, backcharges, one-way consequential waivers, venue/fee-shifting —
rather than asking for "anything concerning" and hoping. Grounding mirrors the
Doc Q&A prompt: quote the document, never invent. **A hallucinated clause is
worse than a miss** — someone would go negotiate over language that isn't in
their contract.

**Built on the existing engine, not beside it.** `/office/extract` is reused
unchanged (unmetered, no API key needed), and the new route goes through the same
`runAi()` wrapper as `/ask` — so auth, the business-plan gate, the monthly meter,
refund-on-failure and the 503/429/502 contract all came free. No migration, no
env var, no client gating. It draws on the same 300/month per-company AI budget.

**Calls made:**
- **Scanning is a separate click from upload.** The ad line is "upload it and
  we read it", but scanning spends a metered call — the doc bar lets you confirm
  you grabbed the right file first. One extra click beats burning quota on a
  misclick.
- **A truncated read says so loudly.** The server clips at 120k chars; a scanner
  that quietly reviewed half a contract and reported it clean would be worse than
  no scanner, so the clipped case gets a warning banner, not a footnote.

**Found — two things fixed in passing.** DocQA and Summarizer had *byte-identical*
markdown renderers; the scanner would have made three, so it's extracted to
`aiMarkdown.jsx` (Summarizer's heading margin normalises 14px → 12px). And
DocQA's drop zone claimed **"the file stays in your browser"** — it doesn't, the
bytes are POSTed to `/office/extract`. What's true is that nothing is *stored*,
so it says that now. That's a privacy claim, so it shouldn't have been loose.

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

## 2026-07-17 — Plan Room: elegant dirt markups, no mid-edit "?", movable draft points, draft undo/redo

**Shipped** (`app.js`/`index.html`, cache-bust → **v44**). Four asks off a
screenshot where the boundary (`ebound`) looked crisp but the other earthwork
markups looked heavy.

- **Root of "why isn't it elegant like the boundary":** `ebound` drew with a
  **screen-constant** thin dashed stroke (`lineWidth = 2/zoom`, dash `[12/z,7/z]`),
  so it stays 2px on screen at any zoom. The rest used pen-width (`m.width`, world
  px) that balloons as you zoom in. Pulled the boundary recipe into one helper,
  `dirtOutline(ctx, m, col, {closed, dash, fillAlpha})`, and routed **contour,
  espot, epad, qarea, qline** (and `ebound` itself) through it. Spot elevation is
  now a screen-constant bullseye; contour keeps its existing=dashed / proposed=solid
  semantic, just thin. Fills dialed back to subtle (`0.10–0.18`). **Left qcount
  alone** — it shares one `drawMarkup` case with 11 other point kinds across
  every trade, so making it elegant means splitting that case; deferred as its
  own small task rather than touching a dozen unrelated markers.
- **The "?" clutter:** it's the elevation placeholder from `elevLabel` — a
  contour/pad/spot shows `?` until you type the elevation. Now suppressed while
  **placing** (draft preview, via a `previewing` flag) or **editing** (the markup
  is selected). It returns on a settled, *unselected* markup as a "still needs
  elevation" flag — which is the one time it's actually useful.
- **Movable points while placing a line:** during a click-built draft you can now
  grab any already-placed vertex and drag it (forgiving zoom-aware grab radius);
  vertices render as ring handles so they read as grabbable. Point-count kinds
  (mcount/qcount/…) opt out — each click there is its own marker.
- **Draft point ops in undo/redo:** while a draft is open, Ctrl+Z / Ctrl+Y (and
  the toolbar buttons) step through the draft's **own** point history — add, move,
  Backspace-remove — instead of the committed-markup stack, so you can't
  accidentally unwind a finished markup mid-draw. On commit it collapses to the
  usual single main-stack undo entry.

**Judgment calls:** scoped the elegance pass to the dirt/earthwork + quantity
family (the tool the screenshot was taken in) rather than sweeping all ~45 markup
kinds — annotation tools (arrow/rect/cloud) are *meant* to be bold pen strokes the
user sizes. Canvas render + pointer code has no test harness here, so verified by
reading + `node --check`; the two app.js-lifting jest suites still pass. Worth a
real click-through on stage: grab-a-vertex-mid-draw and Ctrl+Z during a polygon.

---

## 2026-07-17 — Plan Room: hide AI Jump Start, show Company on first open

**Shipped** (`index.html`, cache-bust → **v45**).

- **AI Jump Start button hidden for now** — added `hidden` to `#btnJumpStart`
  rather than deleting it, so its click wiring (`app.js:4177`) still binds and
  it's a one-attribute re-enable when we want it back. All the server/vision
  plumbing stays in place, just no entry point.
- **Company (☁) button now shows before a project is open.** It carried
  `needs-doc`, so first-run showed only 📁 Projects — a brand-new user couldn't
  reach the company library to **copy a set a teammate shared**. Dropped
  `needs-doc`; the library list and copy flow don't need an open doc, and
  "Share current project" already guards the empty case ("Nothing to share yet —
  open a plan set first"). Live Co-Edit keeps `needs-doc` (it does need a doc).

---

## 2026-07-17 — Plan Room: contour elevations keep their precision

**Shipped** (`app.js`, cache-bust → **v46**). Same class of bug as the earlier
scale fix (207.9 → 208): a contour/pad/spot elevation of **197.85 displayed as
197.9** because every elevation label forced a single decimal
(`fmt(m.elev, …? 0 : 1)`).

- The **input** was never the problem — `askNumber` is `step="any"` + `parseFloat`,
  so 197.85 was stored intact; the loss was purely on display.
- Added `elevStr(v)` (mirrors `scaleFeetStr`): shows the value as entered, 3 dp of
  headroom, trailing zeros trimmed, float noise rounded off. Routed all three
  elevation renders through it — the canvas label (`elevLabel`), the markup-list /
  measure text (`measureValue`), and the earthwork panel's contour list.
- Lift-test `server/tests/planroomElevFormat.test.js` guards it (197.85, 812,
  812.5, 812.125, below-datum, float noise).

---

## 2026-07-17 — Live Co-Edit: start-without-R2-CORS fallback (investigation paused)

**Shipped one resilience fix; investigation paused mid-stream at David's request.**

- **Going live no longer hard-depends on R2 bucket CORS.** `uploadDocToR2` does a
  direct browser→R2 presigned PUT, which throws if the bucket has no CORS for a
  browser PUT — and unlike shared takeoffs, the live-session create had **no
  base64 fallback**, so a CORS gap meant no session could start at all. Now
  `goLive` tries the presigned PUT and, on failure, hands the PDF up as base64;
  the server (`liveSessions` POST, new `pdfBase64` branch → `uploadBase64`) stores
  it. Added a `/api/live` 64 MB body cap (matches `/api/takeoffs`) so the base64
  body isn't rejected by the 20 MB global. Joiners already read the PDF via base64,
  so live now works with or without R2 CORS. Safe either way — the fallback only
  fires when the fast path fails. Cache-bust → **v47**.

**Investigation state (for when we resume).** David's clarified symptom: a host
starts a session, teammates **see** it in ☁ Company, but clicking to join
"starts a session for them — doesn't look like the same session." Ruled out:
response compression (none), CORS origin allow-list (frontend origins are
listed), multi-instance room-sharing (no scaling config → single Render
instance, so the in-memory `rooms` map should be shared). Leading hypotheses,
untested: **(a)** teammates click the ✨ Live Co-Edit toolbar button (which always
*starts* a new session) instead of ☁ Company → "Join live", spawning a parallel
room — the button has no join affordance; **(b)** the join connects but the
live-bar roster/state gives no visible proof, so a working session *looks*
separate; **(c)** a silent SSE failure on the cross-origin EventSource leaves the
joiner with only a static local copy. Next step when resumed: make the connection
state visible + offer "join the running session" when one exists before starting a
new one. Also noted but not applied: the shared `doc` includes `page`, so any
participant's page-flip yanks everyone (bidirectional) — a separate bug.

---

## 2026-07-17 — Plan Room: side-menu section for area/line/count takeoffs

**Shipped** (`app.js`, cache-bust → **v48**). Root of David's "proposed areas
don't show anywhere / should they not be contours?": he was doing a **surfacing
takeoff** (paving areas by type) with the **▨ Area takeoff** tool. Those areas
*do* render on the sheet, but the Earthwork panel only had a **Contours** section
(the cut/fill grade surface) — there was **no list for the takeoff quantities**,
so they looked missing. Area/line/count takeoffs (`qarea`/`qline`/`qcount`) carry
no existing/proposed surface by design; they're bid quantities, not grade.

- New collapsible **Takeoffs (N)** section in the earthwork panel, between
  Contours and Earthwork. Groups items by type (**Areas / Lines / Counts**), each
  row = color swatch + the item's measured value (e.g. "▨ Concrete · 1,704 SF") +
  ✎ reconfigure + ✕ delete; click a row to select & jump to it. Empty-state hint
  explains these price into the **$ Bid** and are separate from the cut/fill
  contours.
- `reconfigureTakeoff(m)` re-opens the same area/line/count config form used when
  drawing (and when double-clicking on the canvas); applied as one undo step.
  Reuses the generic `selectContourById`/`deleteContourById`.

Did **not** add per-material SF subtotals yet (mixing area modes/units + deducts
makes a single total misleading) — offered as a follow-up. Also reverted an
earlier exploratory change (dual existing+proposed surface sections) at David's
request: the page/side-menu still follow the surface toggle.

---

## 2026-07-17 — Plan Room: hollow deduct areas + per-material takeoff subtotals

**Shipped** (`app.js`, cache-bust → **v49**).

- **Deduct areas draw hollow** — a `qarea` with `cfg.deduct` now renders outline-only
  (fillAlpha 0) instead of a heavier fill, so it reads as a hole cut out of the
  filled additive areas around it. Additive areas keep their subtle 0.12 fill.
- **Per-material subtotals in the Takeoffs section** — `takeoffSubtotals(kind, items)`
  rolls each group up by material/type: **Areas** net out deducts within the same
  material+unit (uses `computeAreaResult().quantity/unit`, matching the per-item
  labels), **Lines** sum length (+trench CY) per pipe/line type, **Counts** sum
  items per type. Rendered as `Σ <material> · <total>` rows under each group. So a
  surfacing job now shows total SF per pavement type once materials are assigned
  (all-default areas roll into one "Σ Area" line).

The broader "global toggle to turn off all colored fills (Layers)" David floated
earlier is still open — not built; the deduct-hollow change covered the immediate
need.

---

## 2026-07-17 — Plan Room: Layers → "Shape fills" toggle (outline-only mode)

**Shipped** (`app.js` + `index.html`, cache-bust → **v50**). New **Shape fills**
checkbox in the ◫ Layers menu (default on) — uncheck it and every filled area
shape draws outline-only, no colored inside. Follows the same pattern as the
existing "Value labels" toggle: a `layers.fills` flag checked at draw time.

Gated fill sites: `dirtOutline` (qarea / pad / boundary), the shared area case
(measure area + froom/fsheath/escarea/swall/sinsul/dmarea/lsarea), roof `plane`,
and `dceiling`. Strokes/labels always stay — only the translucent interior is
dropped. Left **un**gated on purpose: the highlighter (an annotation with no
outline — hide it via the Annotations layer) and the ghost-sheet overlay.

---

## 2026-07-17 — Live Co-Edit: join-aware button, backup poll, visible status, page fix

**Shipped** (`app.js`, cache-bust → **v51**) — the resume of the "join lands in a
separate session" investigation. Four changes, targeting all three standing
hypotheses at once so the next test is conclusive:

1. **✨ button is join-aware.** Clicking Live Co-Edit with no active session now
   first checks for a session already running for the company and offers **Join it
   / Start a separate one** (via `askChoice`). The old button *always* started a
   new room, so a teammate who clicked it spun up a parallel session — the most
   likely "we're not in the same session." Joining otherwise lived buried in
   ☁ Company.
2. **REST backup poll.** The SSE stream is a cross-origin `EventSource` (Vercel →
   Render); if a proxy buffers/blocks it the joiner silently gets no pushes. New
   `livePollTick`/`livePollPull` pull `GET /live/:id` every 4 s **only while the
   stream isn't delivering** (`!session.connected`), flushing local edits first,
   so co-edit stays in sync even with a dead stream. ~free when SSE is healthy.
3. **Visible connection status.** Live bar now shows 🟢 Live / 🟡 Live · backup
   sync / 🔴 Reconnecting… (`refreshLiveStatus`, driven by `session.connected` +
   `syncedAt`). Turns a silent failure into a visible one — and tells us on the
   next test whether SSE is actually the culprit.
4. **Push retry + page fix.** `sessionPush` now commits its `lastSync`/`docHash`
   baseline **only on a confirmed push**, so an edit made during a blip re-pushes
   instead of being lost (and then clobbered by the poll). And `applySessionDoc`
   no longer applies `d.page` — participants scroll independently; the join still
   lands you on the host's page once. (Bidirectional page-yank was a real bug and
   would have been amplified by the poll.)

Base64 start fallback from the earlier session is already in (v47). Still not
built: cursor/presence beyond the name roster.

---

## 2026-07-17 — Live Co-Edit: "End for all" actually closes it now

**Shipped** (`liveSessions.js` server + `app.js` client, cache-bust → **v52**).

- **Root cause of "End for all doesn't close it":** the end handler's host check
  was `room.meta.hostUserId !== req.user.id` with **no `String()` cast** (the
  company check right above it *does* cast). For a room rehydrated from the DB
  after any Render restart/deploy, `hostUserId` is the DB type and `req.user.id`
  is the JWT type — bare `!==` 403s the **real host**, and the client swallowed
  the failure, so the session stayed `active` and joinable. Fixed to
  `String(...) !== String(...)`.
- **Client no longer swallows the failure:** `endOrLeave` checks `res.ok`; if the
  close didn't confirm, it says so ("may still be open — reopen ☁ Company and hit
  End"). Refreshes the company list after ending.
- **End from the list:** `GET /live` now returns `can_end` (host or admin), and
  live rows in ☁ Company show an **End** button — so a lingering/abandoned session
  (host closed their tab; the sweep only reaps after 2 h idle) can be closed
  straight from the list. `endSessionFromList` tears down the local session too if
  you're in it.
- **Joining an ended session** (`404`) now says "That session has already ended"
  and refreshes the list instead of a raw HTTP error.

Note: abandoned-session sweep is still 2 h (`liveSessionSweep`, `*/15`); the End
button is the manual remedy rather than making the sweep more aggressive.

---

## 2026-07-19 — Reports: per-day Overtime column, admin-toggleable (default on)

**Shipped** (server + client). New company setting **`report_daily_ot_column`**
(default ON) controls whether the daily line items on reports carry an Overtime
column. Toggle lives in **Administration Workspace → Company Settings → Overtime**
(only shown when overtime is enabled — the column is meaningless otherwise).

- **Setting:** added to `FEATURE_KEYS` + `SETTINGS_DEFAULTS` (`true`). A brand-new
  key with no stored rows, so it defaults ON for every company with **no backfill
  migration**, and the existing `/admin/settings` PATCH allowlist picks it up via
  `FEATURE_KEYS` automatically.
- **Per-entry OT:** the reports listed *total* hours per line but split reg/OT
  only in the summary. New `annotateEntryOvertime()` in `payCalculations.js`
  mirrors `computeOT`'s day/week bucketing and fills regular chronologically, so
  **the line-item OT column always sums to the summary OT** (override / rest-day /
  7th-day / min-daily / prevailing all handled). Lift-tested against `computeOT`
  across daily/weekly/override/prevailing — 18 assertions. The two data endpoints
  (`GET /admin/workers/:id/entries`, project bill) annotate their entries.
- **Reports wired:** `BillPDF` (Employee Time Invoice) + `ProjectBillPDF` (Project
  Bill) render the OT column gated on the setting × overtime-enabled; the
  WorkerMetrics **CSV export** got the column too, for consistency. i18n:
  `ratesOTColumn`/`Desc` + `pdfOvertimeCol` (EN/ES, parity test green).

**Judgment calls:** scoped "reports" to the two bill/invoice PDFs with daily line
items (+ the CSV) — deliberately did **not** touch `CertifiedPayrollPDF` (a
regulated WH-347 layout). Setting is a `settings` key/value row, not a fixed-value
DB column, so `docs/db-enums.md` doesn't apply. Verified: client build, 161 server
tests (admin+pay+settings), i18n parity.

---

## 2026-07-19 — Hours & Rules: edit an existing rule (was add/delete only)

**Shipped** (client). The rule list in `HoursRuleBuilder` only had a delete (×)
per row — to change a rule you had to delete and rebuild it. Added an **Edit**
button per row that loads the rule back into the draft editor; the save button
then reads **Save changes** and commits in place (replace-by-id) instead of
appending a copy.

- A stored rule only carries the fields its type uses, so `edit()` merges it onto
  a `blankRule()` (filling the rest, keeping its id + `when`/`trigger`). `commit()`
  now replaces when the id exists, appends otherwise — one path for both flows.
- Row Edit/Delete buttons hide while a draft is open (no editing/deleting
  mid-draft). No engine change — `coerceDraft` is reused verbatim, so the
  builder↔engine contract test still passes (124 hours-rules tests green).
- i18n `hrEdit` / `hrSaveRule` (EN/ES, parity green). Also: report OT column now
  uses normal text color, not red (per feedback).

---

## 2026-07-19 — Hours & Rules: clearer Add-Time labels + schedule fallback

**Shipped** (server + client). David couldn't read the Add-Time controls, and the
rule was blocked without a Start/End Time rule. Fixed both.

- **Labels** (i18n EN/ES): "How often" → **"Add it once, or repeatedly?"** (options
  *Once, at a set time* / *Repeatedly (a ladder)*); "Measured from" first option
  "The start/end time rule" → **"Their pay schedule"**; hint reworded.
- **Schedule fallback (behavior).** Add/Remove Time with base=schedule no longer
  *requires* a Start/End Time rule. The engine already fell back to the worker's
  scheduled hours (`resolveExpected`: shift → worker → company standard hours) —
  the block was purely `validatePolicy`, which is now a no-op. So a bare
  "add 30 min past 5:25" measures from the **scheduled end**. **Safety:** with no
  Start/End rule AND no schedule for the day, the rule is now a **no-op** (was a
  flat add onto the raw punch — the 5:51→6:51 nonsense David flagged). Below-rung
  late punches clip to the scheduled end, same as an End-Time-rule baseline.
- **UI de-blocked:** the red "needs a baseline" error → a soft FYI hint, Save no
  longer disabled, Add/Remove Time type options no longer disabled, top banner
  reworded to informational.
- Tests: updated `hoursRulesList` (no-op, not punch-add) + the builder contract
  (allowed + measures-from-schedule + no-op); 141 hours/pay tests green, 274
  admin+hours+pay green, i18n parity green.

**Note for David:** for a scheduleless day the rule intentionally does nothing —
workers need scheduled hours (company/worker standard hours or a shift), or a
Start/End Time rule, for "add time" to actually apply.

---

## 2026-07-19 — Hours & Rules: migrate fixed slots into custom rules — Phase 1 (Punch Rounding)

**In progress** (David chose the full phased migration of the baked-in sections —
rounding, tiered OT, premiums — into the custom-rule builder). Phase 1 shipped:
**Punch Rounding is now a when-scoped custom rule.**

- **Engine** (`hoursRules.js`): new `round` rule type `{edge:in|out|both,
  reference, direction, intervalMin, graceMin}` + `when`. In `roundEntriesForPay`
  the per-edge rounding config is resolved from matching `round` rules (later wins)
  and falls back to the global `policy.rounding` — so existing policies are
  byte-identical, and a `round` rule can target one edge / certain days, incl.
  `direction:'off'` to *turn rounding off* on some days. The rounding math
  (`roundEdge`) is untouched.
- **Builder**: `round` type with edge / how-to-round (nearest, worker-favor,
  company-favor, off) / interval / grace / measure-against (Schedule Time vs wall
  clock); plain-English summary; coerce. i18n EN/ES (~26 keys).
- **Tests**: `hoursRulesRound.test.js` (both edges, edge-scoped, off-override,
  backward-compat, parse/defaults) + contract type-parity updated. 133
  hours-rules tests green, client build + i18n parity green.

**Phase 2 shipped — tiered Overtime as when-scoped rules** (the deep one, in the
`computeOT` cost engine). New `ot_tier` rule `{basis:day|week, afterHours, mult}` +
`when`. `computeOT` reformulated: bands resolved **per bucket** (a date-scoped
ot_tier rule sets that day's tiers; else the fixed-slot config) and OT accumulated
by multiplier instead of a fixed band array. **Behavior-preserving** — all 95
payCalculations tests pass unchanged; the reformulation only diverges when an
ot_tier rule exists. `annotateEntryOvertime` resolves its boundary per bucket too,
so the report OT column still reconciles. `otConfigFromSettings` carries the
tierRules; `payCalculations` imports `ruleMatchesDate` (one-way, no cycle).
Builder: `ot_tier` type (basis / after-hours / multiplier) + summary + coerce;
i18n EN/ES. `hoursRulesOtTier.test.js` (single/tiered/CA-style, Saturday-scoped,
parse, report reconciliation, backward-compat). 234 pay/hours + 38 admin tests
green; client build + i18n parity green.

**Phase 3 shipped — premiums as custom rules.** Four new rule types:
`rest_day {mult}` (whole day OT on the days `when` selects), `min_daily {hours}`
(reporting-time floor), `seventh_day {firstHours, firstMult, afterMult}`, and
`night_diff {fromHour, toHour, pct}`. Design kept the OT accumulator untouched
for safety: rest_day / seventh_day / night_diff **feed the existing otConfig**
(`otConfigFromSettings` overrides the fixed slots when a rule is present, incl.
`daysFromWhen` to turn a rest_day's weekday `when` into rest days), so
`computeOT` + `nightPremiumCost` are unchanged; only **min_daily** got a small
per-bucket resolve (`minDailyForBucket`, autoReg-only, no OT-band restructuring)
so its `when` scopes per day. Builder reuses the fixed-slot field labels; new
type/summary/hint keys EN/ES. `hoursRulesPremiumRules.test.js` (rest-day Sat @2×,
scoped min-daily floor, 7-day OT, night-diff pricing, parse, no-op). 240 pay/hours
+ 38 admin tests green; client build + i18n parity green.

**Phase 4 shipped — fixed slots retired; rules are the single source of truth.**
- `migrateFixedSlots(raw)` + `hasFixedSlots()` convert a legacy policy's fixed-slot
  config (rounding / OT bands + 7th-day / premiums) into the equivalent rules and
  clear the slots. **Proven** by `hoursRulesMigrate.test.js`: same entries →
  identical rounding, regular/OT hours, and OT cost.
- **Wiring:** `GET /admin/settings` migrates `hours_rules` in the response
  (display-only) so the builder shows rules; the stored value the pay engine reads
  is untouched until the admin re-saves, and the equivalents are identical either
  way — so no big-bang data migration, no un-migrated policy breaks.
- **UI:** removed the Rounding / Overtime-tiers / Premiums fixed-slot sections
  (and the now-dead `EdgeEditor` + band helpers). Kept Standard Hours,
  Transparency, presets, and the rule builder.
- **Presets** (Honduras / US quarter / California) now emit the matching custom
  rules instead of filling slots (`hoursRulesPresets.test.js` proves California ≡
  old fixed-slot California + every preset rule parses). Round-rule summary now
  shows grace + reference (schedule vs clock).

**Done.** The whole Hours & Rules policy — rounding, overtime, premiums — is now
one `when`-scoped rule list, backward-compatible (no rules → normal pay + OT;
legacy configs migrate on load, identical pay). 286 admin/hours/pay tests + i18n
parity + client build green across the four phases.

---

## 2026-07-19 — Hours & Rules: schedule-relative trigger for Add/Remove Time

David asked, in the Add-Time builder: add a step asking whether the trigger is a
*set time* or the *end of schedule* — so "+30 at :25 past quitting time" fires no
matter what hour a worker actually finishes (variable shifts, not just a fixed
5:25).

**The gap it closes.** The trigger (`at`/`from`) was a fixed wall-clock time; it
only makes sense when everyone quits at the same hour. `base` ("Added to") already
adapts where the credit *lands*, but nothing adapted where the trigger *fires*.

- **New rule field `anchor`** on add_time/remove_time (`RULE_ANCHORS =
  ['clock','schedule']`, default `clock`). `schedule` measures the trigger as an
  **offset** (`offsetMin`) off the scheduled edge instead of a clock time. It is
  independent of `base` — trigger anchor vs. credit landing are orthogonal.
- **Engine:** `ruleCredit(rule, punchMin, anchorBase)` gained a 3rd arg — the
  resolved baseline (`baseEnd` for 'after', `baseStart` for 'before'), which is the
  End Time rule if one is set, else the worker's own scheduled end. So the anchor is
  the *same* baseline the credit already lands on. No schedule to resolve → the rule
  no-ops (0), exactly like a schedule-*based* credit with no baseline. Clock anchor
  is byte-for-byte unchanged.
- **Builder:** a "Set time, or relative to their shift?" select between Mode and the
  threshold; when *schedule*, the time picker swaps for a "Minutes past scheduled
  end" number + a hint. Summaries read "…once 25 min past their scheduled end".
- **Judgment call:** the anchor follows the resolved baseline (End Time rule ⇒
  scheduled end), not raw `expected` — so a company End Time rule and a per-worker
  schedule both behave the way the admin already expects for the credit side.

New `hoursRulesAnchor.test.js` proves it adapts (17:00 shift fires 17:25, a 14:00
shift fires 14:25 from the *same* rule), the ladder mode, offset 0, no-schedule
no-op, End-Time-rule override, and clock-anchor regression. **276 server
hours/pay tests + i18n parity + client build green.** No DB column (lives in the
`hours_rules` JSON), so no `db-enums.md` change.

---

## 2026-07-19 — Hours & Rules: additive stacking for set-time rules

David: "if I set 5:25 → +30 and 5:50 → +60, does it end in an hour or 90 minutes?"
Today it's an hour — `edgeCredit` (was `bestCredit`) takes the largest rung that
fired, never the sum. He wanted the *option* to stack.

- **New per-rule flag `stack`** on add_time/remove_time (default absent = false).
  `false` = **replacing**: largest fired rule wins (unchanged, so 60). `true` =
  **additive**: that rule's minutes pile on top. Formula:
  `max(replacing rules) + sum(additive rules)` — mark both and the pair pays 90.
- **Only 'at' rules** get the toggle (an 'every' ladder is already cumulative on
  its own). Shown as an "If two set-time rules both apply" select right under
  "Added to"; `coerceDraft` only writes `stack:true` for 'at' rules, and only
  when true, so nothing else changes shape.
- **Backward compatible by construction:** default preserves the max-wins math —
  every existing policy and all 282 tests unchanged. The flag round-trips only
  when true (absent stays absent, verified).

New `hoursRulesStack.test.js` covers both-additive (90), mixed (90), replacing
(60), the single-rule case (agree), and round-trip. **282 server hours/pay tests
+ i18n parity + client build green.** No DB column (hours_rules JSON), no
db-enums change.

---

## 2026-07-20 — Hours & Rules: weekday selector starts on Monday

David asked to move Sunday to the end of the "Select days" buttons. Reordering
`WEEKDAY_KEYS` would have been a trap — its **index is the stored day value**
(Sunday=0, the engine's numbering), so shuffling it silently remaps every saved
rule. Instead added a display-only `WEEKDAY_DISPLAY_ORDER = [1,2,3,4,5,6,0]` that
the day buttons, the nth-weekday dropdown, and the summary iterate; the values
they carry are unchanged. The summary now sorts/contracts by display rank too, so
Sat+Sun reads "Sat, Sun" and Fri–Sun contracts to a clean "Fri–Sun". Client build
green; no server/i18n change (labels already existed).

Also: David reported the stage migration failure self-resolved — it was the
nightly job briefly holding things up, not the `users`-PK issue I'd diagnosed (see
prior entry; that diagnosis stands if it recurs).

---

## 2026-07-20 — Hours & Rules: "Schedule Time" → "Schedule/Pay Time"

David wanted the "Added to" pay-basis option to carry a "pay" framing. Flagged
that plain **"Pay Time"** is the worse of his two ideas — "Punch Time" also drives
pay, so "Pay Time vs Punch Time" blurs the only real distinction (scheduled end vs
actual punch) — and went with his fallback **"Schedule/Pay Time"**, which keeps the
accurate meaning. Renamed the term in all four user-facing spots: the dropdown
option (`hrBaseSchedule`), the rule summary token (`hrSumOnBaseline`), the hint
(`hrBaseScheduleHint`), and the glossary (`hrGlossary`), EN + ES. Left the round
rule's own "Scheduled time" vocabulary alone, and lowercased `hrRoundHint`'s stray
"Schedule Time" → "their scheduled time" so it no longer reads as the same term.
i18n-only; parity + build green. Trivial to swap to plain "Pay Time" if he changes
his mind.

---

## Standing items waiting on David

*Everything here is blocked on a decision or an action of yours, not on more code.*

### The big one

⚠️ **133 commits sit on `dev` and have never gone to production.** That's
six trade packs, the storm module, the currency sweep, four new tools and the AI
gate. **None of it has been through stage**, and the trade packs were verified by
unit-testing the *math*, not by driving the UI with a real plan set. It is a very
large release. Everything below matters less than getting this out.
(The bill-PDF currency hotfix is the one exception — merged to `main` 2026-07-16.)

### Decisions only you can make

**These live in `docs/BACKLOG.md` → "Open questions / decisions for you", with the
full context. That doc is the one to actually work from — this is just the
headline.** (Keeping two full copies is how the roadmap went stale in the first
place, so there's one copy and a pointer.)

1. ⚠️ **Native invoices, or QuickBooks forever?** — the biggest call on the board.
   Blocks sub pay-apps, and is already breaking closeout today.
2. ⚠️ **Do you want GC customers at all?** — deepening the 11-trade contractor
   product instead is a legitimate, cheaper answer.
3. ⚠️ **Is $60/mo still right for Takeoff?** — priced at 3 trades; it does 11.
4. ⚠️ **Should an expired COI block, or just warn?** — it warns today.
5. ⚠️ **Closeout deliverable: PDF or ZIP?** — moot until closeout items can hold
   documents at all.

### Verification you owe

⚠️ **Storm/Utility is built but unsellable.** `STORM_SELLABLE=false` in
`BillingPanel.jsx` hides every buy path until the utility math is hand-verified.
To sell: verify → flip to `true` → set `STRIPE_PRICE_STORM` to **$20** in Stripe.
(The approach used from the ESC pack onward — lifting the real functions out of
app.js and running them against stubbed state — would work here.) See
`docs/plans/storm-utility-pack.md`.

⚠️ **Roofing math** still wants a hand-verification pass.

⚠️ **Sitework ↔ Plan Room parity test** still outstanding.

⚠️ **The Red-Flag Scanner and Meeting Minutes prompts have never seen real
input.** Both are wired and verified structurally; their *output quality* is
unknown until you run a real subcontract and a real meeting through them. Both
need `ANTHROPIC_API_KEY`.

### Filed, not forgotten

⚠️ **Five open items in `docs/BACKLOG.md`** — the two closeout/QBO bugs above,
tool-apps still hardcoding `'$'`, flooring/framing missing from `NEEDS_SCALE`,
and `fopening` missing from `POINT_KINDS`.
