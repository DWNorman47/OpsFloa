/**
 * Fixed-value enums for the Daily Checklist tables. See `docs/db-enums.md` for the
 * registry and `docs/plans/daily-checklist.md` for the model.
 *
 * A "day" (daily_checklists) moves through a lifecycle; its items carry where they came
 * from. Both columns are CHECK-enforced at the DB level (migration 0163).
 */

// daily_checklists.status — the day lifecycle.
//   pending   — prepared ahead, waiting in the reorderable queue (no ordinal spent yet)
//   paused    — a calendar-pinned day whose date lapsed unworked; content preserved
//   active    — the live day (has a day_number + work_date); one per project at a time
//   completed — closed by the manager (may still have unchecked items)
//   canceled  — dropped
const DAILY_CHECKLIST_STATUSES = Object.freeze(['pending', 'paused', 'active', 'completed', 'canceled']);
const DAILY_CHECKLIST_STATUS_DEFAULT = 'pending';

// daily_checklists.schedule_type — how the day was scheduled.
//   calendar — pinned to a specific date
//   ordinal  — pinned to the Nth worked day
//   adhoc    — started on demand with no prior plan
const DAILY_CHECKLIST_SCHEDULE_TYPES = Object.freeze(['calendar', 'ordinal', 'adhoc']);
const DAILY_CHECKLIST_SCHEDULE_TYPE_DEFAULT = 'adhoc';

// daily_checklist_items.source — where an item on a day came from.
//   recurring — copied from the project's standing daily template
//   scheduled — from a prepared day-plan (calendar or ordinal)
//   manual    — added by hand during the day
//   rollover  — an unchecked item carried forward from the previous worked day
const DAILY_CHECKLIST_ITEM_SOURCES = Object.freeze(['recurring', 'scheduled', 'manual', 'rollover']);
const DAILY_CHECKLIST_ITEM_SOURCE_DEFAULT = 'manual';

// daily_checklist_recurring_items.kind + daily_checklist_items.kind — how an item behaves.
//   check — a checkbox (uses `checked`)
//   text  — a free-text field the worker fills in (uses `value`)
const DAILY_CHECKLIST_ITEM_KINDS = Object.freeze(['check', 'text']);
const DAILY_CHECKLIST_ITEM_KIND_DEFAULT = 'check';

// daily_checklist_recurring_items.mode + daily_checklist_items.mode — who owns the check.
//   shared     — one row; everyone with the matching team-member-type sees + checks the
//                same state (a change by one is seen by all)
//   individual — each matching person gets their own private check state (per-user)
const DAILY_CHECKLIST_ITEM_MODES = Object.freeze(['shared', 'individual']);
const DAILY_CHECKLIST_ITEM_MODE_DEFAULT = 'shared';

module.exports = {
  DAILY_CHECKLIST_STATUSES,
  DAILY_CHECKLIST_STATUS_DEFAULT,
  DAILY_CHECKLIST_SCHEDULE_TYPES,
  DAILY_CHECKLIST_SCHEDULE_TYPE_DEFAULT,
  DAILY_CHECKLIST_ITEM_SOURCES,
  DAILY_CHECKLIST_ITEM_SOURCE_DEFAULT,
  DAILY_CHECKLIST_ITEM_KINDS,
  DAILY_CHECKLIST_ITEM_KIND_DEFAULT,
  DAILY_CHECKLIST_ITEM_MODES,
  DAILY_CHECKLIST_ITEM_MODE_DEFAULT,
};
