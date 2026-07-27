# Invoice online payment — Stripe Connect

## Context
Native invoices ship, send, and get emailed a public `/i/:token` view page. The
next step: let the **client pay online** from that page. Money must land in the
**company's own** Stripe account, not OpsFloa's (OpsFloa's existing Stripe is only
its own subscription billing). So this is a net-new **Stripe Connect** layer.

## Decisions (David, 2026-07-25)
- **Stripe Connect (Standard accounts)** — each company connects their own Stripe
  via hosted onboarding; OpsFloa stores only the connected-account id
  (`acct_…`), never their keys.
- **No platform fee to start** — 100% passes through (the company still pays
  Stripe's own processing fee). Built so a fee can be added later.
- **Stripe Checkout (hosted)** for the pay UI — no card fields on our page, minimal
  PCI scope. Direct charge on the connected account (company = merchant of record).

## Phases (each committable + verified)

**Phase 1 — Connect onboarding (foundation).** Migration adds
`companies.stripe_connect_account_id` + `stripe_connect_charges_enabled`.
`POST /stripe/connect/onboard` creates (or reuses) the company's Standard account
and returns a hosted onboarding link; `GET /stripe/connect/status` retrieves the
account and reports `charges_enabled` (cached on the row so the pay path can gate
without a Stripe round-trip). Reuses `getStripe()` + `manage_billing` perm.

**Phase 2 — Pay from the public page.** Public
`POST /public/invoices/:token/checkout` — resolve the invoice by token hash; if the
company's account is connected + `charges_enabled` and the balance > 0, create a
Stripe **Checkout Session on the connected account** (`{ stripeAccount }`, direct
charge, line item = the outstanding balance, `metadata` = invoice id + a nonce);
return `session.url`. The `/i/:token` page gets a **Pay now** button → redirect.

**Phase 3 — Webhook records the payment.** Handle `checkout.session.completed`
for connected accounts → find the invoice by session metadata → INSERT an
`invoice_payment` + recompute status (partial/paid), **idempotent** on the session
id (a `stripe_checkout_session_id` guard so a re-delivered event can't double-pay).
Reuses the existing signature-verified webhook infra.

**Phase 4 — Settings UI + gating + i18n.** A "Connect Stripe to accept online
payments" button + status in settings (calls onboard/status, handles the
`?stripe_connect=return` landing). Public page shows **Pay now** only when the
company is connected + balance > 0. EN/ES keys.

## Prereqs (David — Stripe dashboard, when we reach Phase 2–3)
- Enable **Connect** on the OpsFloa platform Stripe account.
- Add a **Connect webhook endpoint** (events on connected accounts:
  `checkout.session.completed`) + its signing secret as an env var.

## Notes / risks
- Money-critical + external: real E2E needs Connect enabled + a company that has
  onboarded + live webhooks — like the QBO path, the code is unit-tested where it
  can be (webhook → payment recording) and smoke-tested on a real account after.
- Refunds / disputes are out of scope for the first cut (handled in the company's
  Stripe dashboard; a future phase can sync them back).
