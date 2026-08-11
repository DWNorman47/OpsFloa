/**
 * Fixed-value pay-engine settings. See `docs/db-enums.md`.
 *
 * How overtime is *priced* when a worker earns more than one base rate in a
 * period (prevailing on one job, civilian on the next, per-project rates):
 *
 *   - 'rate_when_worked' (default): each overtime hour is paid at the rate that
 *     hour earned — the hours that cross the threshold get the premium at THEIR
 *     rate. Order-dependent within a period, generalizes to any jurisdiction.
 *   - 'weighted_average': the US-FLSA blended "regular rate" — total straight-time
 *     pay ÷ total hours, OT premium applied to that blend. Order-independent.
 *     Opt-in, for companies whose rules require it.
 */

const OVERTIME_RATE_METHODS = Object.freeze(['rate_when_worked', 'weighted_average']);

const DEFAULT_OVERTIME_RATE_METHOD = 'rate_when_worked';

/**
 * Which wage type ABSORBS overtime when a day/week mixes regular and prevailing
 * hours over the threshold (only meaningful on the simple/rate-aware OT path):
 *
 *   - 'chronological' (default): the hours that cross the threshold are OT, in
 *     the order worked — the later hours become OT regardless of wage type
 *     (today's behavior; an artifact of entry order).
 *   - 'regular_first': prevailing-wage hours fill straight-time first, so the
 *     overtime is drawn from REGULAR hours first (prevailing hours stay whole).
 *     Opt-in — jurisdiction-sensitive.
 */
const OVERTIME_WAGE_PRIORITIES = Object.freeze(['chronological', 'regular_first']);

const DEFAULT_OVERTIME_WAGE_PRIORITY = 'chronological';

module.exports = {
  OVERTIME_RATE_METHODS,
  DEFAULT_OVERTIME_RATE_METHOD,
  OVERTIME_WAGE_PRIORITIES,
  DEFAULT_OVERTIME_WAGE_PRIORITY,
};
