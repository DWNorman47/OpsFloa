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
 * qbo_bill_pushes.status (0214, widened in 0218): the bill outbox — 'pending'
 * until the bill's entry stamps + ledger rows commit, then 'posted'. 'mismatch' =
 * QuickBooks returned a bill whose total differs (the bill exists; kept with its
 * id, worker blocked until an admin resolves it). 'discarded' = an admin
 * confirmed no bill exists in QuickBooks. A pending row is never deleted on a
 * failed replay — only an admin resolve (POST /api/qbo/bill-outbox/:id/resolve)
 * or a successful replay closes it.
 */
const QBO_BILL_RANGE_PAY_KINDS = ['worked', 'daily_floor', 'weekly_guarantee', 'sick', 'vacation'];
const QBO_BILL_LEDGER_STATUSES = ['billed', 'baseline'];
const QBO_BILL_PUSH_STATUSES = ['pending', 'posted', 'mismatch', 'discarded'];
// Outbox rows that block their worker until resolved.
const QBO_BILL_PUSH_OPEN_STATUSES = ['pending', 'mismatch'];

module.exports = { QBO_BILL_RANGE_PAY_KINDS, QBO_BILL_LEDGER_STATUSES, QBO_BILL_PUSH_STATUSES, QBO_BILL_PUSH_OPEN_STATUSES };
