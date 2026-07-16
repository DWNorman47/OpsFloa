# OpsFloa — GC tools: plan

Status: **plan only — nothing built** (2026-07-16). Written after a full survey of
what already exists, because the roadmap entry (`docs/BACKLOG.md:131-133`) names
six "standouts" and **three of them are already substantially built**.

## The buyer, and why this is a real fork

Everything OpsFloa does today assumes a contractor who **self-performs**: workers
clock in, you take off your own quantities, you bid your own trade. A GC
**coordinates other people** — the value isn't in doing work, it's in not getting
burned by the twenty subs who are.

That's a different buyer with a different anxiety. It's also the buyer who pays
for Procore ($10k+/yr) and Buildertrend ($399–999/mo). Worth entering — but worth
entering *deliberately*, because a half-built GC story is worse than none: a GC
who tries it, finds it can't do pay apps, and leaves doesn't come back.

## Decision 1 — this is almost certainly NOT a new module ⚠️

**The codebase has already run this experiment and lost.** `module_sales` and
`module_subs` were backfilled by migration `0118`, never added to `FEATURE_KEYS`,
and are read by nothing — `docs/db-enums.md:222-225` records them as *"orphaned
and unread (kept only as historical data)"*. Sales and Subs ended up as **tabs of
existing modules**, not modules.

The six GC features are almost all **per-project**, and Projects already has a
tab strip with Financials and Closeout on it. A `module_gc` flag costs four
coordinated edits (`FEATURE_KEYS`, `SETTINGS_DEFAULTS`, `AppSwitcher`,
`modulePermissions`) plus a backfill migration plus a `db-enums` row — and would
likely end up orphaned the same way.

**Recommendation:** ship GC features as **tabs on Projects** + **entries in
Tools**, exactly as Sales/Subs settled. Revisit a module only if the surface
genuinely outgrows that.

**If GC is to be monetized separately, the pattern is `addon_gc`, not
`module_gc`** — a boolean column on `companies` flipped by the Stripe webhook,
like `addon_takeoff` / `addon_planroom` / `addon_storm`. That's a pricing
decision for David, not an engineering one. Note the packaging tension: a GC
add-on and the $60 Takeoff add-on target *different people*, so they don't
naturally bundle.

## Decision 2 — the invoice problem is the real blocker ⚠️

`project_invoices` (`0070_qbo_invoices_and_vendor_prompt.sql`) is a **QuickBooks
mirror, not a native invoice**. Its rows are only ever written by
`server/routes/qbo.js`. **A company without QBO connected has zero rows in it.**

Two things follow, and the second is a live bug:

1. **A pay-app module cannot be built on `project_invoices`** without either
   inventing a native invoice/AR concept or making QBO a hard dependency of GC
   billing. This is the single largest architectural decision in the whole GC
   arc, and it should be made *before* anything in the money category is built.
2. **Closeout is already quietly broken for non-QBO companies.** Its
   `final_invoice` and `retainage_release` auto-status items read
   `project_invoices` (`closeout.js:181-201`), so for a company without QBO they
   are **permanently stuck at `in_progress`** — which means `final_complete` can
   never be reached, because the transition gate requires all required items done
   (`closeout.js:370-383`). That's not a GC-tools problem; it's a shipped bug.
   Filed in `BACKLOG.md`.

## What already exists — do NOT rebuild

| Thing | State | Where |
|---|---|---|
| **Lien waivers** | **~90% done.** Both directions (`from_sub`/`from_us`), all 4 types, full status machine, public token sign flow with `FOR UPDATE` + IP + signature method, `convert-unconditional`, PDF. | `0112`, `routes/lienWaivers.js`, `LienWaiversPage.jsx`, `LienWaiverPDF.jsx` |
| **Closeout checklist** | **Fully built** — 10 seeded items, 4 computed live from punchlist/waivers/invoices, gated transitions, standalone page + project tab, warranty-expiry tile. | `0111`, `routes/closeout.js`, `CloseoutPage.jsx`, `ProjectCloseoutTab.jsx` |
| **Budget vs actual** | **Built.** Per-category budget, spent, committed, pct_used; WIP report with cost-to-cost % complete and over/under billed. | `0105`, `0106`, `routes/projectSpend.js`, `routes/projectReports.js` |
| **Sub POs + payments** | **Built.** Auto-numbered `SP-YYYY-NNNN`, retainage %, draws, auto status, `waiver_required`/`waiver_received`. | `0107`, `routes/subcontractors.js` |
| **Owner change orders** | **Built** — lines, markup, public accept/decline, e-sign, idempotent budget bump. | `0109`, `routes/changeOrders.js` |
| **COI storage** | Table + upload + expiry date exist. | `0107:28-40`, `routes/subcontractors.js:181-248` |
| **Transcription** | Full pipeline: presigned R2 → AssemblyAI **with diarization** → utterances, project-scopable. | `services/assemblyai.js`, `routes/recordings.js`, `jobs/transcriptionPoller.js` |
| **Summarizer** | Emits `## Summary` / `## Key points` / `## Action items`; framed for meetings. | `officeTools.js:109-131` |

The corollary: **the "sub pay-app + lien-waiver collection" standout is mostly a
pay-app problem.** The waiver half is done. And **"budget vs actual" is done** —
only *cost-to-complete* is missing, and that's one subtraction from data already
computed.

## The six standouts, re-scoped against reality

### 1. COI tracker + expiry alerts — **cheapest real win** 🟢
**State:** storage exists; **`expires_on` is a write-only field.** It appears in
exactly 5 places repo-wide — the migration, the INSERT, the destructure, one
display label, and the enum doc. **Nothing queries it. No cron. No index.** So
the data has been collected and never used.

**Build:** an expiring/expired query + index, `ADD COLUMN coi_reminder_sent_at`
for dedup, a daily cron cloned from `jobs/rentalReturnReminders.js` (the
claim-then-send pattern), push + inbox alerts, and a compliance view on the sub.

**Decide:** does an expired COI *block* issuing a PO, or just warn? Blocking is
the actual value ("we can't let him on site") but it's a hard gate on an existing
flow.

**Effort:** small. One migration, one job, one query, one badge.

### 2. OAC meeting minutes — **best leverage per line** 🟢
**State:** ~80% of the infrastructure is shipped, and the two halves are **not
connected**: `TranscriptionTool` only offers copy/download, and the user pastes
into `SummarizerTool` by hand. No `recording_id → summarize` path exists, and no
AI output is persisted anywhere (`officeTools.js:4-5`).

**Build:** a third system prompt beside `SUMMARIZE_SYSTEM`/`ASK_SYSTEM`/
`RED_FLAG_SYSTEM` that emits decisions / action items with owners / open
questions; a route that feeds **diarized utterances with speaker names applied**
rather than pasted text (that's the whole edge — "Mike owes the RFI answer by
Friday" needs to know who Mike is); and a table to persist minutes.
`recordings.project_id` already exists, so minutes are project-scopable for free.
Metering/gating comes free via `runAi()`.

**Effort:** small-to-medium. Mostly a prompt and a join.

### 3. Bid leveling — **the GC-defining one** 🟡
**State:** genuinely missing. "Bid" in this codebase means *our outbound bid*;
there's no inbound-sub-bid concept at all.

**Build:** an inbound bid per trade per project (vendor, amount, inclusions,
exclusions, and the PDF), then AI-assisted normalization to a common scope so
"who's actually low" survives contact with mismatched inclusions. Reuses the
`estimates`/`estimate_lines` header+lines shape and the metered Claude backend.

**Why it matters:** it's the thing GCs do that trades don't — the sharpest
"this is for you" signal in the whole list.

**Effort:** medium. New tables + UI + prompt, but no dependency on the invoice
question.

### 4. Selection & allowance tracker 🟡
**State:** missing entirely — zero functional hits repo-wide.

**Build:** allowances per project (flooring, fixtures, appliances), the client's
actual selection, and over/under vs the allowance — the number custom builders
bleed on and argue about. Should tie into change orders (an over-allowance
selection *is* a CO) and the `contingency` budget category.

**Effort:** medium. Table + UI + the CO link.

### 5. Sub pay-app intake ⛔ **blocked on Decision 2**
**State:** 0%. No SOV, no G702, no G703.

**Note the shape:** `subcontract_pos` + `subcontract_po_payments` already carries
retainage %, draws, auto-status and the waiver flags — so a sub pay app is
arguably a **structured public intake in front of `POST /subcontract-pos/:id/payments`**,
not a new money system. That reframing makes it much cheaper. The public
token-page pattern is established 3× (estimates, COs, waivers) and
`CertifiedPayrollPDF` already reproduces the official WH-347 form layout, which
is the best precedent in the codebase for a G702/G703.

**Blocked by:** whether owner-side billing gets a native invoice or stays QBO-only.

### 6. Closeout package assembler ⛔ **blocked on prerequisite work**
**State:** the checklist is fully built and good. The **assembler does not exist**
— and here's the catch: **`project_closeout_items` has no document columns at
all** (only `notes TEXT`), despite the migration header at `0111:3-4` claiming
items are *"manual (admin checks them off with notes + attached doc)"*. The
attached-doc half was never built.

**So "as-builts delivered" is a checkbox with no as-built behind it — an
assembler has nothing to assemble.** Item-level document storage is prerequisite
work, not part of the assembler.

Also: **there is no server-side PDF generation anywhere** (client-side
`@react-pdf` only; the server has `pdf-parse` for *reading*). A server-built
package is a new capability. `archiver` **is** already a server dep, used once in
`admin.js:2326` for the company export zip — that's the reuse target, and a ZIP
may be the honest answer over an indexed PDF.

**Effort:** large, and larger than it looks.

## Recommended sequence

1. **COI tracker** — smallest, uses data already being collected, and the
   compliance win is legible in one sentence.
2. **OAC minutes** — connects two shipped tools that don't talk to each other;
   mostly a prompt.
3. **Bid leveling** — the GC-defining feature; no dependency on the invoice
   question.
4. **Selections/allowances** — self-contained.
5. *(Decide the invoice question)* → **sub pay-app intake**.
6. *(Add item-level docs first)* → **closeout assembler**.

1–3 are each roughly a day and together make a credible "this is for GCs" story.
5–6 are where the real weight is and both are gated on decisions above.

## Open decisions for David
1. **Module, tabs, or add-on?** Recommendation: tabs + Tools entries (the
   `module_sales`/`module_subs` precedent). Separate `addon_gc` only if it's to be
   sold separately — and note it doesn't naturally bundle with Takeoff, which
   targets a different buyer.
2. **Native invoices, or QBO forever?** Blocks pay apps, and is already breaking
   closeout for non-QBO companies today.
3. **Does an expired COI block, or just warn?**
4. **Is the closeout deliverable a PDF or a ZIP?** ZIP is cheaper and arguably
   more useful (as-builts are big CAD files).
5. **Is the GC buyer actually wanted?** Everything above assumes yes. The
   alternative — deepen the trade-contractor product that now has 11 takeoff
   trades — is a legitimate answer, and cheaper.
