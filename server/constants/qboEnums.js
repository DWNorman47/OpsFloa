/**
 * Fixed-value columns for the QuickBooks integration. See docs/db-enums.md.
 *
 * qbo_bill_range_pay.kind (0211, 'worked' added in 0214; CHECK-enforced): what a
 * contractor bill carries, ledgered per worker + kind + date (the week's start
 * date for the weekly guarantee) so a later bill for an overlapping range posts
 * only the difference. 'worked' = the day's worked pay (straight + OT + prevailing
 * + night), so a backdated raise trues up already-billed days on the next bill.
 *
 * qbo_bill_range_pay.status (0214): 'billed' = on a QuickBooks bill; 'baseline' =
 * lazily seeded for pay billed before the ledger existed (counts as billed).
 *
 * qbo_bill_pushes.status (0214): the bill outbox — 'pending' until the bill's
 * entry stamps + ledger rows commit, then 'posted'.
 */
const QBO_BILL_RANGE_PAY_KINDS = ['worked', 'daily_floor', 'weekly_guarantee', 'sick', 'vacation'];
const QBO_BILL_LEDGER_STATUSES = ['billed', 'baseline'];
const QBO_BILL_PUSH_STATUSES = ['pending', 'posted'];

module.exports = { QBO_BILL_RANGE_PAY_KINDS, QBO_BILL_LEDGER_STATUSES, QBO_BILL_PUSH_STATUSES };
