# OpsFloa — Bid workflow: Estimate ⇄ Plan Room

Status: **ALL FOUR MILESTONES SHIPPED** to `dev` (2026-07-13; M1 f49f373/524ac95,
M2 019e849, M3 c13d7db, M4 4040252). **User to-do before it works end-to-end:
run migrations 0135 + 0136 on the DB.** Makes the **Estimate the hub of a bid**: it carries the deadline and the plans, launches the takeoff in one click,
and pulls the takeoff's pricing back into its line items. Designed around the
real workflow (a contractor is handed a PDF and a due date, takes off the
quantities, and sends a priced bid before the clock runs out).

## The loop this creates
> **Estimate** (customer/GC, **bid due date**, **attached plan PDF**) → click
> **Take off in Plan Room** → auto-opens a **linked Plan Room project** on that
> PDF → do the takeoff → **$ Bid** pricing → **push back** → the estimate's
> **line items** → review → **send** before the due date.

One record per bid; plans + deadline attached; takeoff one click away; numbers
flow back so nothing is re-keyed.

## Pieces (each usable on its own; build in this order)

### 1. Bid due date + reminder  (base — sales module)
- **`estimates.bid_due_at TIMESTAMPTZ`** (distinct from `valid_until`, which is
  how long *our* quote stays good). Nullable.
- **Form**: a date+time field in the estimate editor (`EstimatesPage.jsx`),
  editable on a draft — she creates the estimate the moment she hears about the
  bid and enters the due date first.
- **Surface it**: the Estimates list shows a "due in 2 days" / "overdue" badge
  and can sort by `bid_due_at`; a "Bidding" filter = drafts with a future due
  date. (No overdue badge once `status` is past `sent`.)
- **Reminder**: a cron (clone `server/jobs/equipmentMaintenance.js` /
  `rentalReturnReminders.js` pattern) that, for estimates still in `draft`/`sent`
  with `bid_due_at` within N hours and a `bid_reminder_sent_at IS NULL`,
  claim-then-send (per-row `UPDATE … SET bid_reminder_sent_at=NOW() WHERE … IS
  NULL RETURNING id`) → `sendPushToUser` the owner + `sendPushToCompanyAdmins` +
  `createInboxItem` (url `/work#estimates`), reset the stamp when `bid_due_at`
  changes. Add a `bid_reminder_sent_at TIMESTAMPTZ` column for dedup.

### 2. Attach a plan PDF to the estimate  (base — sales module)
- **`estimates.plan_pdf_url TEXT`** + `plan_pdf_name TEXT` (R2 public URL, same
  bucket/prefix pattern the takeoffs use — `server/r2.js`
  `getPresignedUploadUrl`/`keyFromPublicUrl`/`getBytesByUrl` are all present).
- **Upload**: presigned PUT from the estimate form (reuse
  `server/routes/takeoffs.js` `POST /upload-url` logic, or a sibling
  `POST /api/estimates/:id/plan-upload-url`); store the returned key/URL on the
  row. Validate content-type pdf/image.
- This is the prerequisite for #3 — the PDF must live server-side so Plan Room
  can fetch it. When present, the "Take off in Plan Room" button lights up.

### 3. "Take off in Plan Room" — launch + linked project  (takeoff add-on)
- **Button** on the estimate (shown only when `plan_pdf_url` set AND the company
  has the takeoff add-on — `usePlan().hasTakeoff`/`hasPlanroom`): opens
  `…/tool-apps/planroom/?estimate=<id>`.
- **Proxy endpoint** `GET /api/estimates/:id/plan-pdf` (`requireAuth`, company
  scoped) → `{ name, b64 }` from R2 via `getBytesByUrl` (avoids R2-CORS on read,
  exactly like `GET /api/live/:id/pdf`).
- **Plan Room boot** (`planroom/app.js`): read `?estimate=<id>`. Find-or-create —
  scan local projects (`store.projAll()`) for one whose `data.estimateId === id`;
  if found, open it; else create a new project, `apiFetch` the plan PDF from the
  proxy, `openFromBytes`, and store `state.estimateId = id` (persist in
  `projectData()` + all load paths, like `trade`/`bidMeta`). Idempotent: clicking
  again reopens the same takeoff.
- Reuses what Plan Room already does — reads `tc_token`/`tc_api_base`/`tc_addons`
  from localStorage; fetches PDFs through the API for the company library + live
  sessions.

### 4. Pull the takeoff's pricing into the estimate  (takeoff add-on)
- **Push from Plan Room** (more reliable than pull, since Plan Room projects are
  local): when the open project has an `estimateId`, the bid modal shows
  **"Send pricing to estimate #<id>"** → POST the `roofBidLines()` result to
  `PUT /api/estimates/:id/lines` (endpoint exists; replaces the line set).
- **Line mapping** takeoff → `estimate_lines`: `description = label`,
  `qty`, `unit`, `unit_cost_cents = round(price*100)`, `total_cents`. Category by
  a light heuristic on the line key → one of
  `labor/materials/equipment/subs/overhead/contingency/other` (e.g. hang/install/
  finish/tear-off → `labor`; board/shingles/concrete/mud/paint → `materials`;
  haul/excavation → `equipment`; else `other`). She can recategorize in the
  estimate. **Decision needed:** replace vs. append the estimate's existing lines
  (recommend **replace with a confirm** if lines already exist).
- The estimate recomputes its subtotal/total from the pushed lines
  (`recomputeAndStoreTotals` already runs on `PUT /lines`).

## Data model — migration `server/migrations/0135_bid_workflow.sql`
Next free number is 0135 (highest `0134_live_sessions.sql`). **Note:** the
production-log plan also targets 0135 — whichever ships first takes it; renumber
the other. Idempotent, `ADD COLUMN IF NOT EXISTS`:
`estimates.bid_due_at TIMESTAMPTZ`, `bid_reminder_sent_at TIMESTAMPTZ`,
`plan_pdf_url TEXT`, `plan_pdf_name TEXT`. No new fixed-value columns → no
db-enums.md change. (No CHECK constraints needed.)

## Gating
- **Base (sales module):** bid due date + reminder + PDF attachment — these are
  estimating/CRM, available to anyone who has Estimates.
- **Takeoff add-on** (`requireTakeoffAddon` server, `usePlan().hasTakeoff`
  client): the "Take off in Plan Room" button, the `/plan-pdf` proxy, and the
  "Send pricing to estimate" action — they only make sense with Plan Room.

## Milestones (each to `dev`, push after each)
- **M1 — deadline: DONE (f49f373 + 524ac95).** Migration 0135 (`bid_due_at` +
  `bid_reminder_sent_at`); estimate form field + list "due soon/overdue" chip;
  hourly reminder cron (push + inbox), claim-then-send, re-armed on due-date
  change. (Sort/"Bidding" filter not yet — list badge covers the visibility for
  now.) **Needs migration 0135 run on the DB.**
- **M2 — attach plans: DONE (019e849).** Migration 0136
  (`plan_pdf_url`/`_name`); POST/DELETE `/estimates/:id/plan-pdf` (base64
  through the server → R2, **no R2-CORS needed**); a Plans card on the estimate
  detail (attach/replace/remove/view). **Needs migration 0136 run.**
- **M3 — launch takeoff: DONE (c13d7db).** GET `/estimates/:id/plan-pdf` base64
  proxy (no R2-CORS on reads); "📐 Take off in Plan Room" button on the Plans
  card (gated: plan attached AND `addon_planroom`/trial/exempt); Plan Room
  `?estimate=` find-or-create → `bootEstimate()` reopens or creates the linked
  project + pulls the plan via `apiEstimate()`; `estimateId` round-trips through
  `projectData()` + all load paths. Idempotent.
- **M4 — pricing back: DONE (4040252).** "➤ Send pricing to estimate #<id>" in
  the $ Bid modal (shown when the project is estimate-linked) → `PUT
  /estimates/:id/lines` via `apiEstimate()`. Line mapping + keyword category
  heuristic (`estimateCategoryFor`); O&P rides along as one `overhead` line so
  the estimate total matches the bid. Replace-with-confirm; inline
  locked/404/403/offline handling. No server change (endpoint already existed).

## Verification
- Migration idempotent (re-run clean); a starter/no-sales company can't see any
  of it; the takeoff button hides without the add-on.
- Reminder: seed an estimate due in N hours → exactly one push+inbox; second run
  silent (claim stamp); editing `bid_due_at` re-arms it.
- Round trip: estimate → button → new linked Plan Room project on the right PDF →
  takeoff → send pricing → estimate lines + totals match the bid; click the
  button again → same project reopens (idempotent).

## Caveat & open decisions
- **Plan Room projects are per-browser (local IndexedDB).** Find-or-create links
  within the same browser; on a different device the button starts a fresh
  takeoff (unless the takeoff was shared to the company library). Fine for a
  single work machine; note for multi-device. A future server-side link
  (estimate ↔ shared takeoff id) would make it cross-device.
- **Pull direction** — push-from-Plan-Room (chosen) vs. pull-from-estimate (would
  require the takeoff to be shared server-side first).
- **Replace vs append** estimate lines on push (recommend replace-with-confirm).
- **Which PDF** if the estimate has multiple attachments later (MVP: one plan
  PDF).
- **O&P double-count (M4 shipped behavior):** the push adds the Plan Room O&P %
  as one `overhead` line so the estimate total matches the bid. If the estimate
  *also* carries a non-zero `margin_pct`/`overhead_pct`, markup stacks — the line
  is visible and deletable, and the push always replaces-with-confirm, so she
  reconciles on review. A future refinement could set the estimate's `margin_pct`
  from `roofOP` instead of adding a line.
