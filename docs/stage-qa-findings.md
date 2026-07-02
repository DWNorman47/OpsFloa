# Stage QA Findings

Generated: 2026-06-29

Scope:
- Site tested: `https://stage.opsfloa.com`
- Company tested: `Demo Operations`
- Super admin and company creation flows are intentionally out of scope.
- Items already fixed on `dev` but not yet promoted to stage are tracked separately and should not be double-counted here.

## Latest Stage Pass - 2026-06-30

### Retest After Dev Promotion

Verified:
- Stage public/admin presence now uses `Administration > Public` and the `#public` hash cleanly.
- Guide search for `PO` now returns relevant purchase-order guides first, including subcontractor PO, PO payment, receive-from-PO, and inventory purchase order guidance.
- Booking hash aliases now route correctly for `#appointments`, `#appointment-types`, `#shift-types`, and `#bookable-users`.
- Time Clock > Time Off request form shows proper labels/required fields.
- Team > Add User has normalized Add Manually and Invite by Email fields; Invite by Email includes required stars for first name, last name, and email.
- Inventory Stock, Items, Transactions, Counts, Conversions, and Valuation loaded without browser console errors.
- Inventory Items mobile/table mode still keeps horizontal scrolling inside the table wrapper, and sticky first-column cells have solid backgrounds.
- Broad authenticated route sweep found no browser console errors across Time Clock, Projects, Field Work, Team, Inventory, Booking, and Administration routes tested.
- Current release-readiness pass intentionally excludes Booking; Booking is hidden locally from the app switcher while remaining routable by URL.
- Field Work creation panels checked cleanly for Work Notes, Daily Reports, Punchlist, Incidents, RFIs, Safety Talks, Safety Checklists, Inspections, Equipment, and Sub Reports.
- Inventory tabs checked cleanly for Stock, Transactions, Orders, Counts, Valuation, Items, Locations, Suppliers, and Conversions.

Current issues still observed after promotion:
- Demo Operations booking setup is still empty: no public appointment types, shift types, appointments, or bookable users, so public booking cannot demonstrate a real scheduling flow.
- Field Work > Media still shows `0 items`.
- Demo Operations data is still stale in several areas: Field Daily/Checklists/Inspections around June 20, safety/incidents around April/May, inventory transactions around May, and notifications with old stale-clock alerts.
- Several authenticated pages can still look stuck during the first few seconds. Time Clock, Projects, Team, and Inventory Stock all resolved after a longer wait, but the quick sweep still caught `Loading...` states.
- Administration > Public still contains old wording pointing users to `Workspace > Advanced Controls > Service Request Categories`; this should match the current `Company Settings` wording if that is now the source of truth.

Verified:
- Stage frontend is serving build `1.0.0+96680ed`.
- Stage API origin is `https://opsfloa-stage.onrender.com/api`.
- Demo Operations login works with `Admin` / `Admin123`.
- Public profile `/companies/demo-operations` renders with photos, services, FAQ-style content, and `Last updated 6/30/2026`.
- Public request form `/r/demo-operations` renders and links back to the company profile.
- Public booking `/book/demo-operations` renders a clean empty state instead of an auth or server error.
- Invalid public change-order and lien-waiver token endpoints return `404`, not `401`.
- Main authenticated pages loaded without browser console errors during this pass: Time Clock, Projects, Project Purchase Orders, Field Daily, Field Safety, Inventory Stock, Inventory Orders, Inventory Counts, Booking, Team, Administration Public, and Administration Workspace.

Current issues still observed:
- Demo Operations on Stage has no public booking types, shift types, appointments, or bookable users, so Booking cannot demonstrate the public scheduling flow yet.
- Field Work > Media is empty on Stage even though the public profile shows demo photos.
- Demo Operations operational data on Stage is still centered around roughly June 20-21, 2026 instead of the current date, June 30, 2026. Examples include current-day Work Notes showing empty, notifications dated June 21, and a zero-minute timesheet entry from June 15.
- Some pages take several seconds to resolve their initial loading state, especially Time Clock, Projects, Inventory Items, and Team.

Local follow-up:
- Updated `.github/workflows/refresh-demo-operations.yml` so the demo refresh can seed the staging database when the workflow runs from `stage` or `main`.
- Hid Booking from the app switcher while leaving `/booking` routable.
- Fixed Inventory low-stock reorder PO prefill so line items use the `item_id` returned by `/inventory/stock/low`.
- Guarded Inventory Setup list loads against stale responses and non-array response shapes so setup lists do not show false empty states.
- Fixed Booking hash aliases locally so `/booking#shift-types`, `/booking#appointment-types`, and `/booking#bookable-users` resolve to the intended tabs; invalid Booking hashes now reset to Appointments instead of leaving a stale previous tab visible.
- Fixed the Performance weekly-hours chart locally so partial weeks inside the selected date range are included instead of falsely showing no weekly entries.

## Fixed Locally This Pass

- Help/guide search now covers `time off`, `PTO`, vacation/leave wording, and inventory/cycle-count wording.
- Booking now has its own app header identity and app-switcher entry.
- Booking subtabs now deep-link and update the URL hash.
- Booking > Bookable Users now shows an empty state when no active users are available.
- Public booking pages now distinguish loading, unavailable pages, and invalid appointment types.
- Public estimate/change-order/lien-waiver/booking links now use generic invalid/expired wording instead of raw API token errors.
- Administration Public now uses the canonical `#public` hash while keeping old `#requests` links working.
- Financial Reports now responds to hash changes for direct tab links.
- Time Clock accepts `#requests`, `#pto`, and `#time_off` as aliases for Time Off.
- The standalone Account password row no longer shows the stray `New Password` label.
- The guide close button now exposes a cleaner visible `X`.
- Team member pay/overtime text now has a separator so values do not run together.

## Open Findings

### Demo Operations data is stale or bloated

Severity: P2

Observed:
- Projects shows about `3050 total hours`.
- Workforce reports show `105 pending approvals`.
- Notifications are filled with repeated old `Worker still clocked in` alerts.
- Field Work has old incidents and RFIs from April/May.
- Equipment shows `11880 total hours logged` and every seeded item overdue.
- Inventory purchase orders are dated in May, and count sessions are dated in mid-June.
- Field checklists, inspections, subcontractor reports, incidents, and RFIs are present, but much of the demo activity is still old instead of centered around the current demo day.

Why it matters:
- Demo Operations no longer feels like a fresh, believable demo company.
- The extra records may contribute to slower page loads and noisy screens.

Likely direction:
- Make the demo refresh prune or update old seeded operational records, not only insert missing records.
- Normalize time entries, active clocks, notifications, RFIs, incidents, equipment hours, approvals, and field records around the current demo window.

### Help and guide search misses common phrasing

Severity: P2

Observed:
- Searching `time off` in the guide drawer returns no guide.
- Searching `time off` on `/help` returns no matches.
- Searching `PTO` in the guide drawer returns no guide.
- Searching `inventory count` in the guide drawer only surfaces `Add an inventory item`, not a count/cycle-count guide.

Why it matters:
- A normal user asking for time off guidance will think help content does not exist.

Likely direction:
- Add synonyms/keywords to guide and help search content, especially for `time off`, `PTO`, `vacation`, `request leave`, `sick day`, and similar phrases.
- Add inventory count/cycle count guide keywords such as `inventory count`, `cycle count`, `stock count`, `physical count`, and `reconcile stock`.

### Booking header shows the wrong current app

Severity: P3

Observed:
- `/booking` displays `Time Clock` in the app header instead of `Booking`.

Why it matters:
- It makes the user feel like they landed in the wrong place.

Likely direction:
- Ensure `BookingPage` passes the correct current app/module id to the shared page shell/header.

### Booking > Bookable Users has no rows or empty state

Severity: P2

Observed:
- `Booking > Bookable Users` shows table headers only: `NAME`, `ROLE LABEL`, `TIMEZONE`, `BOOKABLE`.
- No users appear after waiting, and there is no empty-state explanation.

Why it matters:
- Admins cannot tell whether there are no eligible users, loading failed, or the feature is misconfigured.

Likely direction:
- Show bookable user rows when available.
- If none are returned, show a clear empty state explaining what to configure.

### Booking subtabs are not deep-linkable

Severity: P3

Observed:
- Direct loads of `/booking#types`, `/booking#users`, and `/booking#settings` all render the default `Appointments` view.
- Clicking `Appointment Types`, `Shift Types`, or `Bookable Users` changes the visible content, but the URL stays at `/booking`.

Why it matters:
- Admins cannot bookmark or share a specific Booking setup section.
- QA and help links cannot target the exact Booking tab a user needs.

Likely direction:
- Map Booking subtabs to stable hashes and read the active tab from the URL.
- Update the URL when a Booking subtab is clicked.

### Invalid public booking type stays on Loading

Severity: P2

Observed:
- `/book/demo-operations/no-such-type` stays on `Loading...` for at least 20 seconds.

Why it matters:
- Bad or stale public booking links look broken instead of giving a clean not-found message.

Likely direction:
- Return and render a clear `booking type not found` state.

### Invalid public document links mix Not Found and Unauthorized wording

Severity: P3

Observed:
- `/e/not-real-token-stage-qa` renders `Not found`.
- `/co/not-real-token-stage-qa`, `/lien-waiver-sign/not-real-token-stage-qa`, and `/book/manage/not-real-token-stage-qa` render a mixed message like `Not found Unauthorized`.

Why it matters:
- The bad-token state is safe, but the mixed wording feels broken and may confuse external users.

Likely direction:
- Use one clean public-facing state for invalid or expired public tokens, such as `This link is invalid or expired`.
- Avoid exposing internal authorization wording on public pages.

### Help page header shows Account

Severity: P3

Observed:
- `/help` loads correctly, but the app header shows `Account`.

Why it matters:
- Small navigation polish issue; the page feels mislabeled.

Likely direction:
- Pass `help` or equivalent current app metadata to the shared header.

### Team member pay line lacks readable separation

Severity: P3

Observed:
- In a team member detail card, the pay line extracts as `$34.00 / hrDaily overtime`.

Why it matters:
- Visual/accessibility text needs a separator between pay rate and overtime rule.

Likely direction:
- Add visible spacing or a separator between the rate and overtime summary.

### Administration Public tab still uses the old Requests hash

Severity: P2

Observed:
- Clicking `Administration > Public` changes the URL to `/administration#requests`.
- Visiting `/administration#public` directly shows the Workspace setup screen, not the Public/Presence area.

Why it matters:
- The visible tab was renamed to Public, so copied links, bookmarks, and QA routes using the expected `#public` hash land in the wrong place.

Likely direction:
- Make `#public` the canonical hash for the Public tab.
- Keep `#requests` as a backward-compatible alias if existing links rely on it.

### Time Clock hash changes can show the wrong subtab until reload

Severity: P3

Observed:
- From inside Time Clock, changing the URL from `#messages` to `#timeoff` or `#reimbursements` did not update the visible subtab.
- A full reload on `/timeclock#timeoff` did show the correct Time Off tab.
- Old hashes such as `/timeclock#requests` and `/timeclock#expenses` land on the Clock view instead of a request/expense view.

Why it matters:
- Deep links and browser history can leave users looking at a different Time Clock section than the URL suggests.

Likely direction:
- Listen for hash changes or derive the active subtab directly from `location.hash`.
- Add aliases from old hashes to current hashes, especially `#requests -> #timeoff` and `#expenses -> #reimbursements`.

### Reports hash changes can show the wrong report until reload

Severity: P3

Observed:
- Navigating from `/financial-reports#performance` to `/financial-reports#pnl` or `/financial-reports#wip` by hash-only URL change kept the visible content on Performance.
- Clicking the visible `P&L by project` and `WIP report` tabs works.
- A full reload on `/financial-reports#pnl` shows the correct P&L report.

Why it matters:
- Bookmarked or inbox-linked report hashes can show stale content if the user is already on the Reports page.

Likely direction:
- Add a `hashchange` listener in `FinancialReportsPage`, matching the pattern used by other tabbed pages.

### Some stage pages load slowly enough to look stuck

Severity: P2

Observed:
- `/timeclock` stayed on `Loading...` or `Loading clock status...` for roughly 10 seconds before becoming usable in one pass.
- `/inventory#items` and `/inventory#stock` stayed on `Loading...` during a quick check and only showed content after a longer wait.
- `/team#team` still showed `Loading...` after a quick check and only showed team rows after a longer wait.

Why it matters:
- This lines up with user reports that the app can feel slow, especially in the PWA.
- The demo company data bloat may be contributing, but the UI also gives little reassurance while waiting.

Likely direction:
- Check API timings for Time Clock status, time entries, inventory stock, and item list endpoints on stage.
- Add clearer loading states or progressive rendering where a slow endpoint is not critical.
- Continue pruning/normalizing Demo Operations data so stage is not carrying unrealistic old records.

### Field Work Media Gallery is empty in the demo company

Severity: P3

Observed:
- `Field Work > Daily` has seeded daily reports and work-note-style content.
- `Field Work > Media` shows `0 items` and the empty state: `No media yet`.

Why it matters:
- Field photos/media are one of the more visual ways to understand the product.
- A demo company that has field records but no gallery media feels unfinished.

Likely direction:
- Ensure the demo seed either keeps a small current set of photos/media attached to work notes or intentionally hides the Media tab when there is no media.

### Demo booking setup is empty

Severity: P3

Observed:
- `/booking` has no appointments.
- `Appointment Types` shows `0`.
- `Shift Types` shows `0`.
- `Bookable Users` shows only table headers and no rows.
- Public booking at `/book/demo-operations` shows `No public appointment types are configured for this company.`

Why it matters:
- The Booking feature is visible, but Demo Operations cannot demonstrate what public booking is supposed to look like.

Likely direction:
- Either seed a small booking setup for Demo Operations or hide Booking in the demo until it is configured.

### Account password area has a stray collapsed label

Severity: P3

Observed:
- On `/account`, before opening the password editor, a visible row reads like `Change Password` / `New Password` / `Change Password`.
- Clicking `Change Password` opens the full form correctly.

Why it matters:
- The collapsed state looks like an incomplete form or duplicate control.

Likely direction:
- Replace the collapsed row with a single clear `Change Password` button, and show fields only after expansion.

### Time Clock subtab controls are weakly exposed to assistive tooling

Severity: P3

Observed:
- The visible Time Clock subtabs (`Timesheet`, `Time Off`, `Schedule`, `Expenses`, `Messages`) were clickable by visible element text, but did not resolve as named ARIA buttons in browser automation.

Why it matters:
- This may affect keyboard/screen-reader usability and makes reliable automated UI testing harder.

Likely direction:
- Ensure tab controls use real `button` elements or proper `role="tab"` / `aria-selected` semantics with accessible names.

### App shell controls are weakly exposed to assistive tooling

Severity: P3

Observed:
- `Guide` is visible and clickable, but did not resolve as a named ARIA button in browser automation.
- The guide close control is exposed as lowercase `x`.

Why it matters:
- This may affect keyboard/screen-reader usability and makes reliable UI automation harder.

Likely direction:
- Give shell controls stable accessible names, for example `Open guide` and `Close guide`.

## Working Areas Verified In Last Pass

- Public company profile loads with specific title, meta description, and JSON-LD.
- Public request form submits successfully.
- Submitted public request appears in `Administration > Public`.
- Guided setup opens, starts, and closes.
- Time Clock tab clicks work through normal UI navigation.
- Financial report tabs load.
- Reports P&L and WIP tabs switch correctly when clicked.
- Projects `+ New Project` form opens and cancels.
- Project detail drawer opens, closes, and its inner tabs are clickable.
- Estimate and Change Order editors open from their toolbar buttons.
- Time Off and Reimbursement request forms open and cancel without submitting.
- Inventory item add/import/filter controls open.
- Inventory movement, location, supplier, and unit conversion forms open and cancel.
- Public request not-found slug renders a clear message.
- Public booking start page renders a clean empty state when no public appointment types are configured.
- Directory customers/subcontractors/team lists load after waiting, with seeded demo records present.
- Directory `+ Add User` opens; both `Add manually` and `Invite by email` forms include the expected required fields and worker/pay fields.
- Booking appointment type and shift type forms open without submitting.
- My Booking Settings can add an unsaved weekly window row.
- Field Work new forms open and cancel without console errors.
- Mobile header, notification drawer, Inventory list/table, public profile, and public request page do not show page-level horizontal overflow.
- Field Work Add Equipment, New RFI, Fill Out Checklist, New Inspection, and New Punchlist Item forms open and cancel cleanly.
- Inventory Purchase Order creation opens and cancels cleanly.
- Inventory count detail opens and shows count lines/team controls.
- Guide search for `PO` now surfaces relevant subcontractor PO, PO payment, receive-from-PO, and inventory purchase order guides.
- Administration Public/Presence shows the demo profile data, FAQ entries, public photos, request settings, preview/save controls, and public/request links without console errors.
