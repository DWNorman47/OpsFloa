# OpsFloa — Hours rules builder: plan

Status: **M4a shipped (the engine); the builder UI and the consistency fix are
the work that remains** (2026-07-16).

## Where this came from

David described a real customer's invoicing rules:

> Every day deducts a lunch hour automatically. Ignore clocking in before 7am
> (they can, but it won't be paid, unless overridden). If clocked in to or past
> 5:25pm, add a half hour to the day's hours worked; if to or past 5:50pm, add an
> hour; then past 6:25, add another half hour, and so on. All time on Saturday is
> overtime.

…and asked for "a way to add lots of possible variations on rules", sketching a
rule-builder UI. **The engine already existed** (`hours_rules`, shipped in three
milestones) — he'd forgotten, which is itself the point: things get built here
and fall out of memory. What was missing is that its vocabulary is *closed*.

## The one idea the design rests on

**Added time is PAID time, not clock time.**

David's table, which is the spec:

| still clocked in at | pays to |
|---|---|
| 5:24 | 5:00 |
| 5:25 | 5:30 |
| 5:50 | 5:30 |
| 5:51 | 6:00 |

The credit lands on the **scheduled end** (5:00). The punch only decides *which
rung* was reached — it is not the thing added to. 5:00+0, 5:00+30, 5:00+60.

The first cut of this got it backwards and added the credit to the punch, making
5:51 pay to 6:51. David: *"that's nonsense"* — and he's right, because it pays a
worker **more for clocking out later inside the same rung**, which is the one
thing a rung exists to prevent.

**Rungs do not accumulate.** Each names the TOTAL credit at that point, so the
largest rung reached wins. Read David's original words that way and they line up
exactly: *"past 5:25 add a half hour; past 5:50 add an hour"* — an hour, not
another half hour. He was giving totals all along.

Two corollaries fall out for free:
- **No runaway.** A rung is a destination, so no rung can push a punch into the
  next one.
- **Leaving early is not a ladder case.** The schedule base engages only when the
  punch is *past* the scheduled end — otherwise going home at 3pm would pay to
  5:00.

Breaks work on the same principle: **one `auto_break` rule per expected break**,
and "three expected, two taken → one auto break" falls out of comparing totals
without counting anything.

**The numbers belong to the company.** 5:25, 5:51, 30, 60 are that customer's to
choose; the engine's job is that any numbers run. That is the whole reason this
is a rule list and not four hardcoded rules.

## Stage order is fixed, not authorable

Rules are a *set*; the pipeline is a *sequence*. Two rules in a different order
produce a different invoice, so the order belongs to the engine:

```
raw punch
  ↓ 1. clip      clip_start / clip_end bound the paid punch
  ↓ 2. adjust    add_time / remove_time shift the paid end
  ↓ 3. break     auto_break sets the deducted break
  ↓ 4. classify  overtime, downstream in computeOT
```

**Adjust before classify is David's decision, and it moves money**: added time
counts toward the overtime threshold. A 5:51 punch on a 7:00–5:00 schedule pays
to 6:00 = 11h − 1h lunch = 10h → under an 8h threshold that's **2h of OT**. With
the credit applied after classification it would be 1.85h OT plus a bolted-on
0.15h, and a different invoice.

Letting an admin drag rules into an order is a trap — there's no feedback when
they get it wrong, only a wrong invoice.

## Why there is no runaway to guard against

An earlier cut had a real hazard — rungs adding to the punch could push it into
the next rung and cascade to the end of the day off one late punch — and an
elaborate snapshot mechanism to prevent it. Paid-time semantics deleted the
hazard rather than defending against it: a rung is a **destination**, so there is
nothing to cascade. Worth remembering as the shape of the mistake — the clever
guard was evidence the model was wrong, not that the guard was good.

## What shipped (M4a) — `server/utils/hoursRules.js`

`policy.rules[]`, parsed by `parseRules`, applied by `applyRules` inside the
existing `roundEntriesForPay` insertion point — so the four call sites that
already use the engine got rules for free.

| Type | Params | Does |
|---|---|---|
| `clip_start` | `at` | paid start = `max(start, at)` — ignore the early clock-in |
| `clip_end` | `at` | paid end = `min(end, at)` |
| `add_time` | `edge`, `base`, `mode`, `at`/`from`+`everyMin`, `minutes` | paid end = **scheduled** end + the largest rung reached |
| `remove_time` | same | the inverse |
| `auto_break` | `minutes`, `trigger` | break = `max(total expected, total logged)` |

`base`: `schedule` (default) or `punch` (a flat bonus on the actual punch —
available for whoever wants it, not the default, because it's the 6:51 above).
With no schedule for that day a schedule-based rule falls back to the punch
rather than silently paying nothing.

`mode`: `at` (one threshold, one credit) or `every` (`from` + `everyMin` — a
repeating ladder, each step another `minutes`). Uneven ladders still want one
`at` rule per rung; `every` is there because evenly-spaced ones are common and
nobody should type ten rules for them.

Selectors (`when.kind`): `every_day`, `weekdays`, `month_days`,
`month_weekdays` (incl. `week: -1` = **last**, for **any** weekday — not a fixed
nth, since a month has four or five), `months`, `nth_days`, `nth_months`.
An nth pattern without an anchor date is dropped — "every 3rd day" isn't a rule
until you say which day was the first — and never fires before its anchor.

**`clip_start` is a clamp, not a rounding.** It ignores an early clock-in but
does not dock a late arrival — 07:20 still pays from 07:20. That distinguishes
it from the rounding engine's `against_worker`, which would round 07:20 up to
07:30. Both exist; they're different rules.

**A malformed rule is DROPPED, not repaired** — the opposite of `parsePolicy`'s
posture everywhere else, deliberately. A wrong default rounds a punch slightly
wrong; a half-understood rule that still fires bills a wrong number invisibly.

**The no-op guarantee holds**: no rules + rounding off → the same array
reference, byte-identical behaviour. Every existing company is untouched.

### The customer's four rules, as data

```json
{ "enabled": true,
  "standardHours": { "1": {"start":"07:00","end":"17:00"}, "...": "…Mon–Fri" },
  "rules": [
    { "id":"lunch", "type":"auto_break", "when":{"kind":"every_day"}, "minutes":60, "trigger":{"kind":"always"} },
    { "id":"in7",   "type":"clip_start", "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "at":"07:00" },
    { "id":"l1",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"17:25", "minutes":30 },
    { "id":"l2",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"17:51", "minutes":60 },
    { "id":"l3",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"18:25", "minutes":90 }
  ]}
```

**`standardHours` is load-bearing here, not decoration** — it is the 17:00 the
ladder measures from. `minutes` are cumulative totals (30, 60, 90), not
increments, because the largest rung wins.

Saturday-all-overtime is **not** in this list — it already works via the
existing rest-day premium (`premiums.restDayMult`, with no `standardHours` on
Saturday). See M4c: that path only fires under the `daily` overtime rule.

## ⛔ The blocker — fix this before anyone turns a policy on

**The engine reaches 4 of the 10 places that turn hours into money.** Verified:

| Path | Rounding | otConfig | |
|---|---|---|---|
| `admin.js:1004` worker detail | ✅ | ✅ | |
| `admin.js:1635` bills/invoices | ✅ | ✅ | |
| `admin.js:3108/3192` payroll export | ✅ | ✅ | |
| `admin.js:1709` WorkerMetrics | ✅ | ❌ | **hardcodes `'daily'`**, ignores the worker's rule |
| `admin.js:3271` hours CSV | ✅ | ❌ | |
| `timeEntries.js:356` worker view | ✅ | ❌ | |
| `qbo.js:727` **QuickBooks** | ❌ | ❌ | doesn't import hoursRules at all |
| `jobs/scheduledReports.js:125` | ❌ | ❌ | doesn't import hoursRules at all |
| `projectSpend.js` / `projectReports.js` | ❌ | ❌ | raw SQL, bypasses the engine entirely |
| `WorkerSummary.jsx`, `Tests.jsx` | ❌ | ❌ | hand-copied client mirrors |

**Turn a policy on today and the invoice, the worker's screen, and what lands in
QuickBooks disagree.** For a rules engine that is worse than having none — it
converts one wrong number into an argument with a customer about which screen is
right. This outranks every feature below.

## Milestones

- **M4a — the rule engine** ✅ shipped. Types, selectors, pipeline, 49 tests.
- **M4b — consistency (the blocker above).** One helper every money path calls;
  delete the client mirrors or generate them; fix the two SQL paths. Do this
  before the UI, or the UI ships a footgun.
- **M4c — Saturday either way.** `restDay` only fires under `rule === 'daily'`
  (`payCalculations.js:141`). David wants Saturday-OT to work with a weekly rule
  too. Probably a per-day OT threshold rule type (`Total hours before overtime`
  = 0 on Saturday), which needs `computeOT` to take per-day bands.
- **M4d — the builder UI.** Extend `HoursRulesSettings.jsx`: scope → selector →
  type → params, matching David's sketch. Needs a **preview** ("a 7:00–5:30
  Monday pays 10h: 8 regular + 2 OT") — rules that compose are rules you cannot
  read off the list, and the preview is how an admin checks their work.
  EN/ES keys required (the i18n parity test fails the build).
- **M4e — enforcement rules.** `prevent` pre-clock-in, `auto_clockin`,
  `auto_clockout`, weekly `Total hours allowed → auto-clockout`. **Separate
  milestone on purpose**: these are not pay math. They write data — auto-clockin
  invents a time entry for someone who never clocked in. Different subsystem,
  different risk, own decision.
- **M4f — per-role scoping.** David: "later we can add something to roles for
  controlling which rules are applied per role." The shape is a `roles: []` on a
  rule; absent = all. Carried in the schema now so enabling it needs no
  migration (the same trick `premiums: {}` used).

## Decisions taken

1. **Extend, don't replace** (David: "Extend for now, but I may change my mind
   later"). The rule list lives beside `rounding`/`overtime`/`premiums`, which
   express things the rule list can't: tiered OT, night differential,
   7th-consecutive-day, minimum daily hours, clock rounding. A replacement
   regresses all of them.
2. **Added time counts toward overtime** (David).
3. **Break = max(expected, logged), never the sum** (David: "Larger wins…
   combine all break times when comparing"). `break_minutes` is already deducted
   everywhere, so summing would take the lunch twice.
4. **Stage order fixed in the engine**, not authorable.
5. **No repeating/every-N form** — can't express the customer's own ladder.

## Parked

- **The Monthly scope's rule types.** The sketch lists monthly *selectors* (now
  built, as `months` / `nth_months`) but no monthly *rule types*, so there is
  nothing yet a monthly-scoped rule would do. The selectors work on any rule; the
  scope waits for a rule worth putting in it.
- **Weekly scope**: `Total hours allowed` and `Total hours before overtime`, per
  the sketch. Needs `computeOT` to accept per-bucket bands — the same
  prerequisite as M4c.

### What got cut, and un-cut

I cut nth-days, nth-months and the repeating `every` form after deciding the
first customer's ladder didn't need them. David put them back:

> "the whole point of doing things this way and not just hardcoding some rules
> is that anyone can use whatever rules they like"

He's right, and the reasoning is worth keeping: **this feature exists precisely
because the rules nobody has imagined yet are the ones that matter.** Cutting an
option because the first customer doesn't need it is the same instinct as
hardcoding their rules, one step removed. Availability is the product.

## Open questions

1. **What does "unless overridden" mean for the 7am rule?** There's a per-entry
   `overtime_hours_override` but nothing overrides a clip. Per-entry flag, or an
   admin editing the punch?
2. **Does a rule's `at` respect the entry's timezone?** `time_entries.timezone`
   exists and the engine compares bare wall-clock minutes. Fine for one-region
   companies; wrong for a company spanning zones.
3. **The 8 KB cap on `hours_rules`** (`admin.js:211-217`). Six rules is ~700
   bytes, so there's room — but a company with per-month rules across many
   selectors could approach it. Worth a count limit with a clear error rather
   than a silent truncation at the size check.
