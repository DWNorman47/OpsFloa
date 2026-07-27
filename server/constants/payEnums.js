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

module.exports = { OVERTIME_RATE_METHODS, DEFAULT_OVERTIME_RATE_METHOD };
