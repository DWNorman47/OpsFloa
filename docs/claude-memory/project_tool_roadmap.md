---
name: project_tool_roadmap
description: "Full backlog of Tools-module ideas (built + roadmap), categorized with reuse/leverage tags — brainstormed for OpsFloa"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-24T05:22:44.520Z
---

Master list of every tool idea suggested for the OpsFloa **Tools module**, so none get lost. Related: [[project_feature_completion]], [[project_storm_utility_module]].

⚠️ **This list goes stale and that has already cost real time.** Planning GC tools (2026-07-16) turned up **three of its own six "standouts" already substantially built** — nobody updated this after building them. **When a tool ships, move it to "Already built" in the same change.** Last reconciled against the code: **2026-07-16**.

**Reuse/leverage tags:** 🧮 pure client-side calc ($0/use) · 📐 reuses the plan-measure engine (pdf.js scale + polygon/line/count) · 📄 reuses pdf-lib/pdf-parse · 🤖 reuses the metered Claude backend (`services/aiGate.js`) · 🎙 reuses transcription (AssemblyAI).

## 2026-07-23 — "handy for trades" shortlist (David asked; all already listed below, surfaced together)
The un-built, trade-facing tools worth doing next, in day-to-day-use order:
1. **Voice memo → daily log** 🎙🤖 (a.k.a. Talk-to-Bid) — ✅ **BUILT 2026-07-23**. Second "turn this recording into…" action beside Minutes, jobsite-oriented prompt. See "Already built".
2. **Bilingual EN→ES crew task cards** 🤖 — ✅ **BUILT 2026-07-23**. New Crew Cards tab. See "Already built".
3. **Snap-a-receipt job costing** (OCR → expense line on the job). ← now the top un-built trade tool.
4. **Photo → punch list / daily field report** (vision).
5. **Scope-of-work generator** 🤖 (bullets → clean SOW).
6. **Portable cost book** (promote the takeoff price library to a reusable unit-cost DB).
7. **Trade-engineering calcs** 🧮 (electrical/plumbing/HVAC/spans) — only if the MEP trades are wanted; current hub is site/finish-heavy.
Honest caveat surfaced to David: a "branded proposal generator" is a smaller gap than the roadmap implies — branded estimates with e-sign links already exist; it'd be polish, not a new engine.

## Already built (do not rebuild)
- **Plan Room** 📐📄 — the plan viewer + markup + measure tool, with **11 trade packs**: roofing · dirt/earthwork · drywall&paint · flooring · framing · ESC · striping · siding (incl. gutters + insulation) · demolition · fencing · landscape. Verified list at `TRADE_TOOLS` in `client/public/tool-apps/planroom/app.js`. **This is the Bluebeam/PlanSwift replacement below — it got built.**
- **Storm/Utility takeoff** 📐 — separate `addon_storm` upsell on top of Takeoff. Built but **not sellable yet** (`STORM_SELLABLE=false` until the math is hand-verified) — see [[project_storm_utility_module]].
- **Sitework Takeoff Estimator** 📐 — the original standalone tool: PDF takeoff → priced/branded bid; area (paving/base/concrete w/ rebar+forms/asphalt+tack/topsoil strip), linear/trench, count, wall dig, cut/fill, **price library**, **haul truck-count**, **branded letterhead**, **production log**. ⚠️ Stays untouched — see [[feedback_never_break_sitework]].
- **Calculators hub** 🧮 — 12 field calculators in one tab (the "hub instead of a tab per calc" idea): concrete (slab/footing/column/wall), rebar grid, asphalt, base, slope, rafter, stairs w/ IRC checks, board-feet, paint, tile+thinset+grout, ft-in↔decimal, area/volume. `client/src/components/calculators.js` — math is data, not components, so it's unit-tested.
- **Contract Red-Flag Scanner** 🤖📄 — subcontract → penalties/retainage/deadlines/odd clauses. One of the two recommended ad campaign picks. ⚠️ Prompt never tested on a real contract.
- **Meeting minutes** 🎙🤖 — recording → Summary/Decisions/Action items w/ owners/Open questions, built server-side from diarized utterances + speaker names (the paste-into-Summarizer path threw the speakers away). ⚠️ Prompt never tested on a real meeting.
- **Voice memo → daily log** 🎙🤖 (built 2026-07-23) — sibling to Minutes on a recording: `POST /recordings/:id/daily-log` + `daily_log_md`/`daily_log_at` (migration 0146), jobsite prompt (Work completed / Crew / Materials / Delays-blockers / Weather / Safety / Action items). Button beside "Turn into minutes" in `TranscriptionTool.jsx`; Transcription tab copy updated to surface it. ⚠️ Prompt never tested on a real jobsite memo.
- **Bilingual EN→ES crew task cards** 🤖 (built 2026-07-23) — new **Crew Cards** tab. English task notes → clean Spanish (or bilingual) task card. `POST /office/crew-card` (`CREW_CARD_SYSTEM`) + `CrewCardTool.jsx`. Bilingual default so the foreman can verify the translation. ⚠️ Spanish quality never checked by a native speaker.
- **COI / document expiry tracker** — daily job + compliance banner; warns, does **not** block a PO to an uninsured sub (open decision).
- **Transcription** 🎙 — audio → diarized transcript.
- **Summarizer** 🤖 — transcript/notes → summary + action items.
- **Document Q&A** 🤖📄 — PDF → ask questions (grounded in the doc).
- **Email/Message Drafter** 🤖 — notes + tone → ready-to-send message.
- **PDF Toolkit** 📄 — merge/reorder/rotate/delete/extract pages (client-side, $0).

## Takeoff siblings (📐) — ✅ **ALL BUILT**, all 10 are Plan Room trade packs
Roofing · drywall & paint · flooring/tile · framing/lumber · siding+gutters+insulation · ESC · demolition · fencing · striping+signage · landscape/irrigation. **Nothing left on this list.** Remaining work is *verification*, not building — the packs were verified by unit-testing the math (lifting the real functions out of `app.js`), not by driving the UI with a real plan set. Roofing math + sitework↔Plan Room parity still owed.

**The trap this list hides, hit 3× (striping paint, demo haul, fence posts):** an installed $/unit already includes materials, so a derived quantity is a *panel cost basis*, never a bid line — double-counting it inflates the bid. Now asserted in each pack's tests. Any 12th pack must assert it too.

## Quick field calculators (🧮) — ✅ **hub built**; these are the remaining un-built ones
- **Mortar/concrete mix ratios**, **construction unit converter** (CY↔tons, SF↔SY — the ft-in↔decimal half shipped).
- *(Everything else in this category shipped in the hub above.)*

## Trade-engineering calcs (🧮 — sticky, trade-specific) — not built
- **Electrical** — wire ampacity, conduit fill, voltage drop.
- **Plumbing** — pipe sizing, fixture-unit / DFU.
- **HVAC** — quick load / duct sizing.
- **Structural** — joist/beam span lookups, wind/snow load by location.

## Money & bidding (📄 + the bid engine) — not built
- **Proposal / quote generator** — branded PDF from line items + e-sign. *(Public token e-sign is already proven 3× — estimates, COs, waivers.)*
- **Change-order builder** — ⚠️ **owner COs are already built** (`0109`, `routes/changeOrders.js`); this entry is only about a *tool-module* wrapper.
- **Portable cost book** — editable labor/material/equipment unit-cost DB (promote the price library).
- **Markup / margin / overhead** calculator.
- **AIA-style pay app (G702/G703)** — ⛔ blocked on the native-invoice decision (see below).
- **Certified payroll / prevailing wage** helper — ⚠️ `CertifiedPayrollPDF` already reproduces WH-347.
- **Lien-deadline calculator** by state. *(Lien **waivers** are ~90% built — different thing.)*
- **Own-vs-rent equipment** calculator.

## AI document & writing (🤖)
- ✅ **Plan/spec "red-flag" scanner** — BUILT (above).
- **Scope-of-work generator** — bullets → clean SOW.
- **RFI drafter · submittal log/drafter**.
- **Estimate sanity-checker** — AI reviews a bid for missing scope.
- **Bilingual EN↔ES translator** — crew task-cards in Spanish (ES i18n already shipped).
- **Review-response drafter · job-ad generator · warranty/closeout letters**.
- **"Ask the code"** — AI Q&A over a building code / spec book.

## AI from media (🎙 / vision / OCR) — not built
- **Voice memo → tasks** — talk on the drive home → structured action items. *(Closest to done: minutes proved the utterances→prompt path.)*
- **Photo → rough measurement / estimate**.
- **Receipt / business-card scanner** → expense line or contact (OCR).
- **Video walkthrough → punch list** (AI vision).
- **Before/after photo pairs** for proposals & marketing.

## Field & jobsite ops
- **Daily field report** (general-purpose), **punch list with photos** *(a punchlist exists — closeout reads it)*.
- **Jobsite sign-in / visitor log**, **weather-aware delay log** (good for claims; previously shelved).
- **Pre-use equipment inspection checklist** *(equipment tracking + maintenance logs are built)*, **3-week lookahead schedule**.

## Utility & reference
- **Material weight/density · fastener torque** reference.
- **QR label / asset-tag maker** 📄 *(the QR pattern exists in `ItemLabelModal.jsx`)*, **simple Gantt / phase planner**.

## Called-out standouts (leverage × demand)
~~Roofing takeoff~~ ✅ · ~~the 🧮 calculators hub~~ ✅ · ~~spec Red-flag scanner~~ ✅ · **branded Proposal generator** (still the biggest un-built one) · **Voice-memo→daily-log**.

## Advertising standouts (demo-able "magic" — for hero ads/marketing)
Bar = demo-able wow + relatable pain + tagline writes itself. User liked these.
- ✅ **Talk-to-Bid / Voice-memo→daily-log** 🎙🤖 — "Walk the job talking, drive home to a finished log." **The daily-log half is BUILT (2026-07-23).** The finished-*bid* half (voice → priced estimate) is still the gap.
- ✅ **Contract Red-Flag Scanner** 🤖📄 — "Upload it. We read the fine print you don't have time to." **BUILT.** *Half the recommended ad pair is now shippable.*
- **Instant Branded Proposal** 📄 — "From the driveway to a signed proposal before you leave." Full-loop money shot; the takeoff half is now 11 trades deep.
- ✅ **Bilingual Crew Cards** 🤖 — "Speak English. Your crew reads Spanish." **BUILT 2026-07-23** (Crew Cards tab).
- **Snap-a-Receipt Job Costing** — "Snap it at the pump. It's on the job."
- Moonshots (best ads, genuinely harder — vision-heavy): **Photo Takeoff**, **Video Walkthrough → Punch List**, **"Chat With Your Blueprint"**.
- **Recommended ad campaign pair:** Talk-to-Bid + Red-Flag Scanner. **The scanner half exists now; Talk-to-Bid is the gap.**

## Widening directions (broaden reach vs. deepen the contractor niche)
Everything else deepens contractor estimating; these widen along a different axis.
- **A. Own more of the same contractor's day (share of wallet):** simple CRM/lead pipeline, online booking / "request an estimate" widget *(booking is built)*, review & reputation manager 🤖, SMS/email marketing + reminders, customer portal, payments & financing presenter.
- **B. Adjacent service businesses (HVAC/plumbing/cleaning/landscaping/pest/auto — new customers):** work order/service ticket, recurring-service & maintenance-contract scheduler, service history per address/asset, dispatch/day board, flat-rate service price book. *(Service calls belong in the base product — see [[project_product_vision]].)*
- **C. Horizontal AI/office for any business (widest — the AI pack already is this):** website chatbot/FAQ 🤖, AI receptionist / missed-call→text-back+summary 🎙🤖, social & marketing content generator 🤖, SOP/checklist/handbook generator 🤖, meeting-notes→tasks/CRM 🎙🤖 *(minutes shipped — this is now partly real)*, translation 🤖.
- **D. Revenue/growth:** instant online quote form, automated follow-up for un-won quotes, referral program, digital business card / lead capture, invoice-pay/deposit links.
- **E. Back-office any small biz needs:** expense/receipt/mileage tracker (OCR), cash-flow forecaster, simple invoicing + payment links, subscription/recurring billing, tax-prep organizer, payroll helper.
- **F. Become the hub (integrations):** calendar sync, SMS (Twilio), Stripe *(built)*, QuickBooks/Xero *(QBO built)*, Zapier, import/export, public API.
- **Strategic read:** A+C is lowest-risk widening. B = biggest TAM but competes with ServiceTitan/Jobber/Housecall.

## General-contractor tools (GC = coordinator, not self-performer)
📄 **Full survey + plan: `docs/plans/gc-tools.md`.** Read it before touching this section — it records what's already built, and that GC is probably **tabs on Projects + Tools entries, not a module** (`module_sales`/`module_subs` were backfilled, never wired, and sit orphaned — the codebase already ran this experiment). If monetized: `addon_gc`.
- **Precon/bidding:** bid leveling / sub-bid comparison 🤖 (**the GC-defining one; next up if GC is wanted**), invitation-to-bid sender + tracker, trade scope sheets, GC budget rollup, qualifications & exclusions builder, sub prequalification.
- **Buyout/setup:** buyout log, subcontract generator 🤖📄, Schedule of Values builder, ✅ **COI/insurance tracker + expiry alerts — BUILT**, permit tracker, project directory.
- **During construction:** ✅ **OAC/coordination meeting minutes 🎙🤖 — BUILT**, RFI log/drafter 🤖, submittal register 🤖, 3-week lookahead, procurement/long-lead tracker, progress photos by location, T&M ticket log, transmittal generator.
- **Money/owner billing:** **sub pay-app intake** ⛔ (the *lien-waiver half is ~90% built*; and the pay-app is arguably just a public intake in front of the existing `subcontract_po_payments`) · **budget vs actual ✅ already built** — only **cost-to-complete** is missing, and it's ~one subtraction from what `projectSpend.js` already computes (**cheapest thing left**) · owner COs ✅ built · draw schedule.
- **Residential/owner:** **selection & allowance tracker** (standout — #1 custom-builder pain; genuinely missing), weekly owner update generator 🤖, bank draw request.
- **Closeout:** **closeout package assembler** 📄 — ⛔ **nothing to assemble**: `project_closeout_items` has no document columns, so item-level doc storage is prerequisite. Also no server-side PDF generation exists (`archiver` is already a dep → a ZIP may be the honest answer). The **checklist itself is ✅ fully built**.
- **Compliance:** sub compliance dashboard (COI ✅ done; +safety+waivers), certified payroll ✅ built, site safety inspection/JHA.
- **GC standouts scorecard:** ~~COI tracker~~ ✅ · ~~OAC minutes~~ ✅ · ~~budget vs actual~~ ✅ (minus cost-to-complete) · **bid leveling** ← next · **selection/allowance tracker** · **sub pay-app** ⛔ · **closeout assembler** ⛔.
- ⚠️ **Two blockers own most of the remaining GC value:** (1) **native invoices vs QBO-forever** — `project_invoices` is a QBO *mirror*, so non-QBO companies have zero rows; this blocks pay apps **and already breaks closeout today**. (2) **is the GC buyer wanted at all** — deepening the 11-trade contractor product is a legitimate, cheaper answer.

## Expensive-software replacements (the takeoff-tool pattern → profit)
Pattern that made the sitework takeoff win: a specific, expensive, bloated incumbent → a focused browser tool that nails the core 20% at a fraction of the price.
- **Tier 1:**
  - ✅ **Plan viewer + markup + measure** → Bluebeam Revu / PlanGrid / Fieldwire (~$260–600/user/yr). **BUILT — this is Plan Room.** It was the top pick and it happened.
  - ✅ **Multi-trade takeoff + estimating** → PlanSwift / STACK / On-Screen Takeoff (~$1,500–4,000/yr, usually **one trade**). **BUILT — 11 trades.** ⚠️ This is why "$60/mo for Takeoff" is now a real question: it was priced when Takeoff did 3 trades.
  - **Proposal / CPQ + e-sign** → PandaDoc / DocuSign / Qwilr. **Now the last un-built Tier 1** — and the one that closes takeoff→bid→signed.
- **Tier 2:** Photo documentation → CompanyCam ($19–30/user/mo; have R2). · Residential GC PM → Buildertrend/CoConstruct ($399–999/mo). · Bid leveling → BuildingConnected/SmartBid 🤖 *(see GC section — same feature)*.
- **Tier 3 (highest value/unit, hardest):** Roof measurement reports → EagleView/Hover (**$20–100 PER report**; start with trace-on-aerial-image). **🚧 MVP PROTOTYPE BUILT 2026-07-23** — a `roofmeas` mode inside Plan Room gated by a new `roof` add-on, reusing the roofing geometry (pitch/squares/edges already shipped), deliverable = a printable **measurement report**. Plan: `docs/plans/roof-measurement.md`. Per-edge pitch accuracy ✅ fixed. **Billing + two-door standalone sale BUILT 2026-07-23** (migration 0147 `addon_roof`, full Stripe clone of storm, `requirePlanToolsAddon` passes on roof, BillingPanel + SuperAdmin, two-door: `roofwork` gate + `.roof-door` button + `?roofsolo` preview). **$40/mo**, env `STRIPE_PRICE_ROOF`. **ON SALE (2026-07-23): `ROOF_SELLABLE=true`** (and `STORM_SELLABLE=true` — both opened together). Roof wired into the standalone buy-alone flow; Storm→Takeoff dependency enforced. ⚠️ Live-gates: set `STRIPE_PRICE_ROOF`(+`_ANNUAL`, $40) + `STRIPE_PRICE_STORM`, run 0147 on stage/prod, and **the math on neither is verified** — flipped on anyway (David's call). Set the SELLABLE flag back to false to pull either. · FSM lite → ServiceTitan/Jobber (crowded, big build).
- **Recommendation, updated:** the two Tier-1 engine plays are done. **The remaining Tier-1 profit is the Proposal generator** — it needs no new engine and completes the loop the other two opened. **Roof measurement (EagleView) — the Tier-3 swing — now has an MVP prototype** (2026-07-23, see above); the go/no-go is proving scale-from-aerial accuracy + the report on a real roof, then productizing (sell it, decouple from takeoff).
