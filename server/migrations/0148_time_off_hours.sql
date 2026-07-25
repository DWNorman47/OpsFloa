-- Partial time off: an optional hours value on a sick/vacation request.
--
-- NULL (the default, and every existing row) = a FULL day — paid the worker's
-- scheduled hours that day (their shift), falling back to the weekday leave-value
-- rule, then the company Regular Shift default. A number = a PARTIAL day: pay
-- exactly that many hours (the worker clocks in for the rest). Single-day partials
-- are the intended use; the pay engine values it as `hours` regardless.
--
-- See docs/plans/hours-rules-builder.md — sick/vacation are paid as their own
-- lines, valued schedule-first (server/utils/payCalculations.computeLeaveHours).

ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS hours NUMERIC;
