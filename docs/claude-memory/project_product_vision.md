---
name: project_product_vision
description: "OpsFloa's origin story and core product strategy — an operations platform (base) + specialized profit tools (add-ons)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---

**Origin & vision (owner stated it directly — remember this):** OpsFloa began as just a **time clock + invoicing** app to make the owner's wife's workflow easier. He realized it was wide-ranging and useful across many job types, so he decided to sell it. It is an **operations** platform — *not* just project management.

**The core strategy — two layers:**
- **Base app = broad operations** everyone gets with the subscription. Breadth is the value. **Service calls belong here**, built into operations as a first-class part of the base — the owner explicitly does NOT want to monetize service-call features as separate add-ons; he'd rather build them into the base ops.
- **Add-on profit tools = specialized operations** sold at extra cost. The **sitework takeoff calculator is the model**: a specialized, high-value operation that justifies premium pricing (see [[project_tool_roadmap]]). Extra profit comes from these specialized tools, not from core workflow.

**The test for base vs. add-on:** base = horizontal, nearly every customer uses it, table-stakes to run a business. Add-on = specialized depth only a subset needs but who get outsized value (often replacing expensive point software). Do NOT build add-ons out of generic service-call/dispatch workflow — that's base.

**Positioning:** "the operations + AI toolbox for contractors/service businesses," not a home-services dispatch FSM. OpsFloa differentiates on the *tools* (takeoff, AI office pack, plan tools), not on out-dispatching ServiceTitan/Jobber. Widening toward FSM (recurring service/dispatch) enters their crowded turf — do it as part of *base operations*, not as a monetized tool.

**Plan-tools tiering (decided 2026-07-11):** the plan tools are structured as **Plan Room base add-on (~$40/mo, `addon_planroom` — viewer/markup/measure/library/live sessions) + Takeoff layer (~$60/mo, reuses `addon_takeoff`, requires the base, stacked billing) that includes ALL trade packs** (sitework, roofing, future drywall…) — not one SKU per trade. The shipped standalone sitework tool keeps working until the user personally confirms the integrated sitework pack works, then it redirects; grandfathering terms decided at cutover. Master plan: `docs/plans/plan-viewer-markup.md`.
