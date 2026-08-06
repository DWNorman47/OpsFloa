# Daily Checklist — design

## What this is
A per-project **daily checklist**: a checklist a manager sets up to happen each working
day on a project. Each day's list is assembled from a project's standing "every day"
items plus anything scheduled for that particular day, and the crew checks it off. A
**day manager** lets a manager prepare days ahead of time and schedule items either on a
**calendar date** or by **ordinal day** ("1st day, 2nd day, …").

This is a NEW concept, distinct from the existing `punchlist_items` table (a persistent
project *issue/punch* tracker: open → in_progress → resolved → verified). The name is
**Daily Checklist** and its tables are prefixed `daily_checklist_*`, deliberately kept
apart from the punchlist tracker.

## Scope
**In (the two strongest features — building now):**
1. **Recurring daily checklist** — the standing "every day" items a manager defines once
   per project, copied into each day.
2. **Day manager** — prepare days ahead and schedule items/day-plans on a **calendar
   date** or by **ordinal day**, with a reorderable queue of pending days.

**Deferred (agreed to set aside):**
- **Reference-pulled safety checklists** — safety lists attached to *things* (e.g. a
  machine) that auto-append when that thing is referenced in the day. Needs an
  asset/equipment registry first.
- **Portioning the project's general punchlist per day** — likely better modeled later
  as a soft day-*tag* on general items than a hard partition.

## The ordinal-day model (the heart of it)
- **Day 1 = the first day the project is actually worked onsite** (the first day a
  checklist is started). **Day 2 = the next worked day.** Calendar **gaps are allowed** —
  ordinal counts *worked* days, not calendar days.
- **Ordinal numbers are spent only by days that are actually worked.** A day prepared for
  a date that nobody works never becomes "Day 3"; it waits, and whatever day the crew
  next works is Day 3. Weather delays / no-shows / gaps just work.

## Lifecycle of a day
A day moves through these states:

- **pending** — prepared ahead (calendar- or ordinal-scheduled), sitting in the
  reorderable queue, not yet worked. Consumes no ordinal number.
- **paused** — a *calendar*-pinned pending day whose date arrived with **no start and no
  clock-in**. Its content is preserved; it stays in the queue until **rescheduled** (new
  date) or **started on another day**. (Ordinal-scheduled days can't lapse — they're
  relative, so they never pause.)
- **active** — the live day. Assigned its **day_number** = (count of prior worked days
  for the project) + 1, dated with the actual **work_date**. One active day per project
  at a time.
- **completed** — closed by the manager (can close with items still unchecked).
- **canceled** — dropped.

### Triggers — what "starts" a day
A day becomes **active** when either:
- **the manager starts it** ("Start today's checklist"), or
- **someone clocks in** on the project that day — **but only if the clock-in trigger is
  enabled** (it's **optional**; see Settings). With it off, days are manager-started only.

### Starting resumes the pending queue
- On start, if a **pending plan exists**, **resume the top of the queue** — that same
  prepared plan slides onto today's date, keeps its prepared items, and is stamped with
  the next ordinal number. (Confirmed: starting on another day = the paused plan moves to
  that day.)
- The queue defaults to scheduled order but **whoever sets up the days can reorder it**,
  so "top of queue" is planner-controlled.
- If there is **no** pending plan, starting creates a **fresh (adhoc) day** from the
  recurring template + any ordinal/calendar items that map to it.

### Day assembly (what's on a started day)
Items materialize on start, from:
1. the project's **recurring daily items**,
2. the **prepared plan's items** (if resuming a pending plan),
3. items scheduled by **ordinal** whose target == this day's `day_number`,
4. items scheduled by **calendar** pinned to this `work_date`,
5. **rolled-over** unchecked items from the previous worked day (see Rollover),
6. **manual adds** during the day.

### Rollover (decided)
When a day completes with **unchecked** items, those items **carry into the next worked
day** — but only the ones that **don't already show up** in that day's assembled list
(from recurring / scheduled / etc.). Dedup is by normalized item text, so a standing
recurring item isn't duplicated; a genuinely one-off unchecked item follows the crew
until it's done. Rolled-over items carry `source = 'rollover'`.

### Ordinal-vs-calendar conflict (decided)
If a started day matches **both** an ordinal-scheduled plan **and** a calendar-scheduled
plan and their contents **differ**, don't auto-pick — **prompt the manager** with three
choices: **use the ordinal one**, **use the calendar one**, or **merge** (union of both).
If the two are identical, just use them silently.

### Generation = lazy, not pre-generated
Nothing is materialized for a calendar day until the day is actually started. Prepared
days are explicit `pending` rows a manager created — the system never auto-creates empty
lists for days nobody works (which is why an overnight "generate for everyone" job is the
wrong model here).

## Data model (proposed, mirrors house conventions)
Money-free; follow the repo's enum discipline — a frozen `*Enums.js` constant + CHECK
constraint + `docs/db-enums.md` row for every status/type column below. Next free
migration number is `0163` (verify at build time).

- **`daily_checklist_recurring_items`** — the "every day" template, per project.
  `id, company_id, project_id (FK projects), text, order_index, active bool,
  created_by, created_at, updated_at`.

- **`daily_checklists`** — one row per prepared-or-worked day.
  `id, company_id, project_id (FK projects),
   status` (CHECK: pending|paused|active|completed|canceled),
  `schedule_type` (CHECK: calendar|ordinal|adhoc),
  `scheduled_date DATE` (calendar target, null otherwise),
  `ordinal_target INT` (ordinal target, null otherwise),
  `queue_order INT` (reorderable position while pending; null once active/done),
  `work_date DATE` (actual worked date — set on start),
  `day_number INT` (ordinal assigned on start — the "spent only when worked" number),
  `name, notes, started_by, started_at, completed_at, created_by, created_at, updated_at`.

- **`daily_checklist_items`** — items on a day (prepared or materialized).
  `id, daily_checklist_id (FK CASCADE), text, checked bool, order_index,
   source` (CHECK: recurring|scheduled|manual|rollover),
  `checked_by, checked_at, created_at`.

Enums to add to `server/constants/` + `docs/db-enums.md`:
`DAILY_CHECKLIST_STATUSES`, `DAILY_CHECKLIST_SCHEDULE_TYPES`, `DAILY_CHECKLIST_ITEM_SOURCES`.

## Permissions (decided)
Granular per-action permissions, slotting into the existing permission framework, all
individually changeable per user/role:

| Permission | What it gates | Admin default | Worker default |
|---|---|---|---|
| `daily_checklist_manage_recurring` | edit the recurring template | ✅ true | ⬜ false |
| `daily_checklist_schedule_days` | prepare / schedule / reorder / reschedule / pause / cancel days | ✅ true | ⬜ false |
| `daily_checklist_start_day` | start a day | ✅ true | ✅ true |
| `daily_checklist_check_items` | check/uncheck + add manual items | ✅ true | ✅ true |
| `daily_checklist_complete_day` | complete a day | ✅ true | ⬜ false |

Everything is **true by default on an admin account**; workers default to **start-day**
and **check-items** only. All are editable in the permission UI.

## Settings
- **`daily_checklist_clockin_autostart`** (bool, **default off**) — the optional clock-in
  trigger. Off = manager-start only; on = first clock-in on the project auto-starts the
  next pending/adhoc day. (Company-level to start; per-project override is a later option.)

## Server (routes/dailyChecklist.js)
- Recurring template: `GET/PUT /projects/:id/daily-checklist/recurring`.
- Day manager: `GET /projects/:id/daily-checklist/days` (queue + history),
  `POST` (prepare a day), `PATCH /:dayId` (edit/reschedule/reorder/pause/cancel),
  `POST /days/reorder` (queue order).
- Run the day: `POST /projects/:id/daily-checklist/start` (resume top-of-queue or adhoc;
  returns the ordinal/calendar conflict choice when one exists),
  `PATCH /days/:dayId/items/:itemId` (check/uncheck, add manual), `POST /days/:dayId/complete`
  (runs rollover into the next day's carry-forward set).
- Clock-in auto-start: when `daily_checklist_clockin_autostart` is on, hook the project
  clock-in path (`server/routes/clock.js`) to activate the next pending/adhoc day if none
  is active for the project today.

## Client (Day Manager + daily view)
- **Day Manager** (per project): edit recurring items; prepare specific days (calendar or
  ordinal) with their own items; see + drag-reorder the pending queue; reschedule / pause
  / cancel.
- **Daily view**: the active day's checklist to work; a "Start today's checklist" control
  when none is active (gated by `start_day`); add manual items; complete the day. The
  ordinal-vs-calendar conflict prompt appears here on start.
- Bilingual strings (EN + ES, `i18n.test.js` parity). Lives under the **Field** module
  (`module_field`).

## Phasing (within the in-scope work)
- **Phase 1 — the daily loop.** Recurring template + Start-a-day (adhoc) + daily view +
  check-off + complete + rollover + the two default permissions. Delivers a working
  per-project daily checklist with no advance scheduling.
- **Phase 2 — the day manager.** Prepare-ahead day plans (calendar + ordinal), the
  reorderable pending queue, pause/reschedule, the ordinal/calendar conflict prompt, the
  remaining permissions, and the optional clock-in auto-start setting.

## Open decisions
All decided. The feature lives under the **Field** module (`module_field`).
