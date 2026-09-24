/**
 * Fixed-value columns for the QuickBooks integration. See docs/db-enums.md.
 *
 * qbo_bill_range_pay.kind (migration 0211, CHECK-enforced): the range-level pay
 * items a contractor bill carries that aren't tied to one time entry. Each is
 * ledgered per worker + kind + date (the week's start date for the weekly
 * guarantee) so a later bill for an overlapping range posts only the difference.
 */
const QBO_BILL_RANGE_PAY_KINDS = ['daily_floor', 'weekly_guarantee', 'sick', 'vacation'];

module.exports = { QBO_BILL_RANGE_PAY_KINDS };
