---
name: project_service_call_gaps
description: Gap analysis + build backlog for making OpsFloa serve a field-service / service-call business model (HVAC/plumbing/electrical/appliance)
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---

Backlog captured 2026-07-09 from a grounded code inventory (Explore agent, current code). Goal: make OpsFloa serve a **service-call business model** (ServiceTitan/Jobber/Housecall space). Per [[project_product_vision]] these are **base-app** gaps (service calls live in the base), NOT paid add-ons.

**Already have (foundation):** service-request intake + public booking (solid); work orders (dispatch atom: status/priority/assignee/scheduled_at, tech self-updates status+notes); customers; time tracking; QBO invoice push; push+email notifications (booking only).

**Missing — ranked by how much the model needs it:**
1. **Work-order completion flow** — WO is too thin (one `amount`; no line items, photos, signature, parts/labor). Tech can't run the call in-app. Everything hangs off this. `SignatureModal.jsx` + `PhotoCapture.jsx` already exist (wired to timesheets/estimates) → reuse.
2. **In-app customer payments** — customer literally can't pay (Stripe = SaaS billing only; QBO collects in QuickBooks). Card/deposit/pay-link = table stakes + processing-margin revenue.
3. **Flat-rate price book** — service techs price by task from a book (good/better/best), not typed estimates. Have material catalog→estimate lines, NOT a service price book. This is what separates FSM from construction estimating.
4. **Customer-site asset registry + service history** — "AC unit at 123 Main, serial X, installed 2019, serviced 3×, warranty 2026." Retention/upsell engine. Missing (`equipment_items` = contractor's own gear, not customer assets).
5. **Recurring agreements / memberships / PM plans** — annual tune-ups, maintenance memberships = recurring revenue, #1 home-services profit lever. Absent.
6. **Dispatch board for work orders** — current drag board schedules shifts→projects, not techs→customer jobs w/ arrival windows. WOs are a flat list.
7. **Customer SMS + "on my way"** — no SMS anywhere (email+push only); WOs emit zero customer notifications.
8. **Invoice from a work order** — invoicing is QBO from a project; no WO→invoice path.

**Critical path (build first — the money loop):** #1 → #3 → #8 → #2 = "dispatch WO → tech adds priced line items + photos + signature → invoice from WO → take payment." Until this exists a service business can't run one call end-to-end in-app. Phase two = retention/scale layer (#4 assets/history, #5 memberships, #6 dispatch board, #7 SMS). **Recommended start: #1 work-order completion flow with line items** (payments/invoice/price-book all attach to it).
