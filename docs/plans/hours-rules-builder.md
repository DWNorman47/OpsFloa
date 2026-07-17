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

**Rules compose. A ladder is not a feature.**

The 5:25 ladder looked like it needed a new rule type — a threshold table, or a
repeating "every N minutes" form. It needs neither. It's four ordinary rules
that all fire at once:

| clock out | rules matching | credit |
|---|---|---|
| 5:24 | — | 0 |
| 5:35 | 5:25 | +0.5 |
| 5:50 | 5:25, 5:50 | +1.0 |
| 6:25 | 5:25, 5:50, 6:25 | +1.5 |

The step function *emerges from summing*. That's why there is **no repeating
form**: it looks more powerful and is strictly less, because real negotiated
ladders aren't evenly spaced (this one alternates 25- and 35-minute gaps, so
"every N minutes" cannot express it).

The same trick does breaks: **one `auto_break` rule per expected break**, and
"three expected, two taken → one auto break" falls out of comparing totals
without counting anything.

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
counts toward the overtime threshold. A 9.5h day + 0.5h credit = 10h → under an
8h threshold that's **2h of OT**, not 1.5h OT + 0.5h regular.

Letting an admin drag rules into an order is a trap — there's no feedback when
they get it wrong, only a wrong invoice.

## The trap that nearly ate the ladder

Every `add_time`/`remove_time` rule is evaluated against **the same snapshot**,
and the deltas are summed and applied once. Applying rungs one at a time would
let the first credit push the clock-out past the next rung's threshold: 5:30
+30 → 6:00, which satisfies "after 5:50" → +30 → 6:30, which satisfies "after
6:25"… one late punch runs away to the end of the day. Pinned by a test.

## What shipped (M4a) — `server/utils/hoursRules.js`

`policy.rules[]`, parsed by `parseRules`, applied by `applyRules` inside the
existing `roundEntriesForPay` insertion point — so the four call sites that
already use the engine got rules for free.

| Type | Params | Does |
|---|---|---|
| `clip_start` | `at` | paid start = `max(start, at)` — ignore the early clock-in |
| `clip_end` | `at` | paid end = `min(end, at)` |
| `add_time` | `edge`, `at`, `minutes` | credit when the punch passes a threshold |
| `remove_time` | `edge`, `at`, `minutes` | the inverse |
| `auto_break` | `minutes`, `trigger` | break = `max(total expected, total logged)` |

Selectors (`when.kind`): `every_day`, `weekdays`, `month_days`,
`month_weekdays` (incl. `week: -1` = **last** — "last Friday" isn't a fixed nth,
a month has four or five).

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
{ "enabled": true, "rules": [
  { "id":"lunch", "type":"auto_break", "when":{"kind":"every_day"}, "minutes":60, "trigger":{"kind":"always"} },
  { "id":"in7",   "type":"clip_start", "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "at":"07:00" },
  { "id":"l1",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"17:25", "minutes":30 },
  { "id":"l2",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"17:50", "minutes":30 },
  { "id":"l3",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"18:25", "minutes":30 },
  { "id":"l4",    "type":"add_time",   "when":{"kind":"weekdays","days":[1,2,3,4,5]}, "edge":"after", "at":"18:50", "minutes":30 }
]}
```

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

## Parked — bring back if it comes up

- **Nth Days / Nth Months** (cut on David's call, noted here on his call).
  "Every 3rd day starting from date X" / "every 2nd month". Genuinely more work
  than the rest of the selectors combined — an anchored recurrence needs a start
  date, a period, and a rule for what happens across month/year boundaries and
  DST. No construction rule has asked for it yet. `month_weekdays` with
  `week: -1` covers the "last Friday" case that usually motivates it.
- **The Monthly scope.** David's sketch lists monthly *selectors* but no monthly
  *rule types*, so a monthly rule can't currently do anything. Left out until
  there's a rule to put in it.
- **A repeating add_time** (`every N minutes from T`). Cut — see above. Would be
  cheap to add later as an optional field on `add_time` if a company ever has an
  evenly-spaced ladder.

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
