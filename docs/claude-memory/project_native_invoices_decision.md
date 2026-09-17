---
name: project_native_invoices_decision
description: "Native invoices/AR fully SHIPPED (Phases 1-5, 2026-07-25); QuickBooks optional. Open: prod smoke-test + drop dormant project_invoices; deferred email link + online pay"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-25T22:32:55.227Z
---

**Decision (David, 2026-07-25):** OpsFloa must **not rely on QuickBooks**. QBO is
an *optional extra*, never required. So OpsFloa gets its **own native invoice /
accounts-receivable concept** — a company that never connects QuickBooks can still
invoice, record payment, and close out a project.

**SHIPPED 2026-07-25 — all 5 phases on `dev`, CI green each.** Create → send → pay
→ close out works without QB, and QBO is now a sync layer on the ONE native invoice
table. Truth: migration `0149_invoices.sql` (`invoices`/`invoice_lines`/
`invoice_payments`/`invoice_audit`) + `0150_unify_invoices.sql` (folded the QBO
mirror in), `server/constants/projectMoneyEnums.js` (`INVOICE_*` +
`computeInvoiceTotals`), `server/routes/invoices.js` (CRUD/send/payments/void/
public token; 3 create sources scratch/from-estimate/from-project), client
`pages/InvoicesPage.jsx` (`InvoicesPanel` = an **Invoices tab** in the Projects
module), `components/InvoicePDF.jsx`, `pages/PublicInvoicePage.jsx` (`/i/:token`,
view-only), `inv*` keys in `i18nModules.js`. Phase 3 fixed 3 real closeout bugs;
Phase 5 rewired `qbo.js` + `projectReports` AR + `lienWaivers` + `closeout` onto
native. Plan: `.claude/plans/mossy-launching-mist.md`. Per-phase detail in
`docs/WORKLOG.md`.

**OPEN THREADS (work on these later — filed in `docs/BACKLOG.md`):**
1. **Prod smoke-test after `main` merge** — on a QuickBooks-connected company:
   push an invoice, run check-payment, confirm the project AR rollup + closeout
   `final_invoice` read correctly (the `0150` data-copy only exercises on real
   QBO-mirror rows; dev has none, so it's schema-only there — untested on live data).
2. **Drop the dormant `project_invoices` table** — `0150` kept it as a rollback
   backup (nothing reads/writes it but the superadmin wipe). After #1: one-line
   migration `DROP TABLE project_invoices` + remove the dormant delete in
   `superadmin.js` and its `expectedTables` entry in the test.
3. **Invoice send email** — **DONE 2026-07-25**: `POST /invoices/:id/send` emails
   the client the `/i/:token` link via `sendEmail` (Resend), best-effort; From
   shows the company name, Reply-To the sending admin; the raw share token is now
   stored (migration `0151`) so "Copy link" matches the emailed link instead of
   rotating.
4. **Online payment on the public page — IN PROGRESS (paused 2026-07-25, resume
   later).** Full plan: `docs/plans/invoice-online-pay.md`. Decisions (David):
   **Stripe Connect, Standard accounts** (company connects their OWN Stripe; money
   lands in their balance), **no platform fee**, **hosted Stripe Checkout**.
   - **Phase 1 DONE & pushed:** migration `0152` (`companies.stripe_connect_account_id`
     + `stripe_connect_charges_enabled`); `POST /stripe/connect/onboard` +
     `GET /stripe/connect/status` in `routes/stripe.js` (reuse `getStripe()`).
   - **PENDING:** Phase 2 (public `POST /public/invoices/:token/checkout` → Checkout
     Session on the connected account + "Pay now" on `/i/:token`), Phase 3 (webhook
     `checkout.session.completed` → `invoice_payment` + status, idempotent), Phase 4
     (settings "Connect Stripe" button + status, public pay gating, i18n).
   - **BLOCKED on David's Stripe dashboard** before Phase 2–3 can be E2E-tested:
     enable **Connect**, and add a **Connect webhook** endpoint (events on connected
     accounts) + its signing secret as an env var.

**Why it matters:** today `project_invoices` is a **QBO mirror** — only
`server/routes/qbo.js` writes it, so a non-QBO company has **zero invoice rows**,
which already breaks closeout (final-invoice check blocks forever; retainage-release
check falsely reports "done" over zero rows). QBO stays a **sync layer on top** of
the native invoices — the mirror is fine, it just can't be the source of truth.

**This unblocks:** the two closeout bugs (see `docs/BACKLOG.md`), sub
pay-applications, and invoicing straight off a service work order (see
[[project_service_call_gaps]] — the work-order flow ends in "generate invoice").

**Going forward:** build money-category features (sub pay-apps, invoicing off a
service work order — see [[project_service_call_gaps]]) on the native `invoices`
model, never the retired `project_invoices` mirror. Original plan basis:
`docs/plans/gc-tools.md` (Decision 2).
