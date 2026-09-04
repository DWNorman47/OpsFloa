# OpsFloa — Actions & How-To Guide

A reference of every major action in OpsFloa: **what** it is, **why** you'd use it, and **how** to do it. Companion to `OpsFloa_Features.txt` (which describes capabilities; this describes actions).

**How navigation works.** The one main menu is the **app switcher** — the avatar/pill dropdown in the **top-left of the header**. It lists the modules you have access to. Within a module, related screens are grouped into **tabs** (and sometimes a group row above the tabs). The header (top-right) also has: a **Messages** bell, a **Notifications** bell, and an **Account menu** (avatar) with Refresh, Language, Guide, and Log out.

**A few things that change what you see:**
- **Role** — Worker, Admin, or Super Admin. Admin-only areas (Work, Reports, Administration, Booking) don't appear for workers.
- **Plan & add-ons** — some features require the Business plan or an add-on (Plan Room, Takeoff, QuickBooks, Advanced Payroll, Certified Payroll).
- **Module & feature toggles** — an admin can turn whole modules and individual features on/off (Administration → Workspace → Company Settings).
- **Custom labels** — a company can rename "Field", "Worker", and "Client", so those words may differ in your workspace.

---

## Table of contents
1. [Getting started & your account](#1-getting-started--your-account)
2. [Time tracking (worker)](#2-time-tracking-worker)
3. [Workforce (admin oversight, payroll, scheduling)](#3-workforce-admin)
4. [Field](#4-field)
5. [Work — projects, estimating & billing](#5-work--projects-estimating--billing)
6. [Directory — workers, clients, subcontractors, roles](#6-directory)
7. [Inventory & equipment](#7-inventory--equipment)
8. [Tools](#8-tools)
9. [Reports & analytics](#9-reports--analytics)
10. [Booking & service requests](#10-booking--service-requests)
11. [Communication](#11-communication)
12. [Administration & company settings](#12-administration--company-settings)
13. [Subscription & billing](#13-subscription--billing)
14. [Super Admin (platform operator)](#14-super-admin)

---

## 1. Getting started & your account

### Create a company account (self-service registration)
- **What:** Sign up a brand-new company and create the first admin account.
- **Why:** Start using OpsFloa with no sales call — you get a free trial with full access.
- **How:** On the login page, click **Create account** (→ `/register`), enter company name + your admin details, and confirm your email via the link that's sent before first login.

### Log in
- **What:** Sign in with your username/email and password.
- **Why:** Access your workspace.
- **How:** Go to the login page, enter credentials, submit. If MFA is enabled on your account, enter the 6-digit code from your authenticator app.

### Reset a forgotten password
- **What:** Get a reset link by email.
- **Why:** Regain access without an admin.
- **How:** Login page → **Forgot password** → enter your email → open the emailed link → set a new password.

### Change your password
- **What:** Update your password while logged in.
- **How:** **Account** module → **Change password** (workers), or **Administration → Account → Change password** (admins).

### Turn on multi-factor authentication (MFA / TOTP)
- **What:** Require a one-time code from an authenticator app at login.
- **Why:** Stronger account security.
- **How:** **Account** (worker) or **Administration → Account** (admin) → **Enable** under MFA → scan the QR code (or type the manual key) into Google Authenticator/Authy → **Confirm & enable**. Disabling requires your password.

### Switch language (English / Español)
- **What:** Change the app's language.
- **How:** Header **Account menu** (avatar, top-right) → choose **English** or **Español**.

### Install the app to your phone/desktop (PWA)
- **What:** Add OpsFloa to your home screen so it launches like a native app.
- **Why:** Faster access and full-screen use; works offline for clock-ins.
- **How:** Follow the in-app install prompt when it appears, or use your browser's "Add to Home Screen" / "Install app".

### Turn on push notifications
- **What:** Opt in to browser/phone push alerts (approvals, comments, announcements, etc.).
- **How:** **Account** module → **Notification setup** → enable and allow notifications when prompted.

---

## 2. Time tracking (worker)

*Path: app switcher → **Time Clock**. Admins who also manage the team see a **Personal / Workforce** switcher; the actions below are under **Personal**.*

### Clock in / out
- **What:** Start and end a shift with one tap; records exact time, project, and (optionally) GPS.
- **Why:** Replaces paper timesheets and phone-in check-ins.
- **How:** **Time Clock → Clock** tab → pick the project → **Clock In**. To end, **Clock Out**. (If a project has geofencing, you must be within its radius; if a required safety checklist is set, complete it first.)

### Add a break / mileage before clocking out
- **What:** Log break minutes and job mileage on the current shift.
- **How:** On the **Clock** tab while clocked in → **Add break** (enter minutes) and/or **Add mileage** → then **Clock Out**.

### Switch projects
- **What:** Move from one project to another without a manual clock-out/in.
- **How:** **Clock** tab → **Switch project** → choose the new project → **Confirm switch**.

### Cancel a wrong clock-in
- **What:** Undo a clock-in made on the wrong project with no time entry created.
- **How:** Immediately after clocking in, use **Cancel** on the Clock tab, then clock in correctly.

### Enter time manually
- **What:** Log a shift after the fact (project, date, start/end, break, mileage, notes).
- **Why:** Fix a missed clock-in or record past work.
- **How:** **Clock** tab → open the **manual entry** form → fill fields → save.

### View your timesheet / edit or delete entries
- **What:** A calendar/list of your entries by week.
- **How:** **Time Clock → Timesheet** tab. Toggle **Timesheet view / List view**. Edit or delete your own entries within 7 days of the work date (locked once approved).

### Copy last week
- **What:** Duplicate the previous week's entries into this week.
- **Why:** Fast entry for repeating schedules.
- **How:** **Timesheet** tab → **Copy last week**.

### Sign off your timesheet
- **What:** Digitally attest your hours for a date range.
- **Why:** Tells admins the hours are accurate before approval.
- **How:** **Timesheet** tab → **Timesheet sign-off** → select the range → sign.

### Export your timesheet as PDF
- **What:** A print-ready PDF of your entries for any range.
- **How:** **Timesheet** tab → **Export PDF** (sign in the signature modal if required).

### See your upcoming shifts / auto-fill from a shift
- **What:** Your scheduled shifts; tap one to pre-fill a time entry.
- **How:** **Timesheet** tab (Upcoming Shifts) → tap a shift to pre-fill project/date/hours.

### Request time off
- **What:** Submit a PTO request for a date range with a note.
- **How:** **Time Clock → Time Off** tab → new request → pick dates → submit. (Requires the PTO feature.)

### Set your availability / view your schedule
- **How:** **Time Clock → Schedule** tab → **Schedule** (your shifts) or **Availability** (mark when you can work).

### Submit an expense / reimbursement
- **What:** Out-of-pocket expense with amount, category, and receipt photo.
- **How:** **Time Clock → Expenses** tab → new expense → fill in + attach receipt → submit. (Requires the Reimbursements feature.)

### View your pay stubs
- **What:** Read-only pay stub per pay period (hours, OT, prevailing, mileage, estimated gross).
- **How:** **Account** module → pay stubs (visible when wage display is enabled for workers).

---

## 3. Workforce (admin)

*Path: app switcher → **Time Clock** → **Workforce** group. Legacy `/workforce` and `/admin` links redirect here.*

### Approve or reject time entries
- **What:** Review submitted entries; approve/reject one at a time or all at once.
- **Why:** Gatekeep hours before payroll; rejections include a reason the worker sees.
- **How:** **Workforce → Approvals** → review the queue → **Approve** / **Reject** (add a note), or **Approve all**. Use the worker filter to focus on one person.

### Comment on a time entry
- **What:** Threaded notes between admin and worker on an entry.
- **How:** **Approvals** → open an entry → add a comment (both sides get push notifications).

### Manage pay periods
- **What:** Create/lock pay periods (e.g., bi-weekly, semi-monthly).
- **Why:** Once locked, workers can't edit entries inside the period.
- **How:** **Workforce → Approvals** → **Pay Periods** section → create or lock a period.

### See who's working right now (live)
- **What:** Real-time KPIs + a map/list of who's clocked in and on what.
- **How:** **Workforce → Live**.

### Open Team Member Reports
- **What:** Per-worker breakdown of hours/OT/prevailing/mileage with every amount traceable to a row and the rule behind it.
- **Why:** Performance review and labor-cost analysis.
- **How:** **Workforce → Reports** → find the worker's report row (search/pin available) → open it to expand the full **Team Member Reports** detail. Every rule shown links to its setting.

### Project reports
- **How:** **Workforce → Reports → Projects reports** — hours by worker and date range per project.

### Overtime report
- **How:** **Workforce → Reports → Overtime Report** — regular/OT/prevailing/total hours + estimated labor cost per worker for a range.

### Export a payroll CSV or time-entry CSV
- **What:** CSV for payroll software (regular/OT/prevailing/cost/mileage) or a detailed per-entry export.
- **How:** **Workforce → Reports → Export** — choose the export and range.

### Run payroll / view payroll history
- **What:** Compute a payroll run and keep a history.
- **How:** **Workforce → Payroll** → **Payroll Run** / **Payroll History**. (Requires the Advanced Payroll add-on and wage-view permission.)

### Generate a Certified Payroll (WH-347) report
- **What:** Weekly WH-347 report for Davis-Bacon / prevailing-wage jobs.
- **How:** **Workforce → Payroll → Certified Payroll** → **⬇ WH-347 PDF**. (Business plan; certified-payroll permission.)

### Approve/deny time off (admin)
- **How:** **Workforce → Time Off** → approve or deny requests (workers are notified).

### Review expenses (admin)
- **How:** **Workforce → Expenses** → approve/reject submitted reimbursements.

### Schedule shifts (dispatch)
- **What:** Create shifts and assign them to workers/projects with dates and times.
- **How:** **Workforce → Scheduling** → drag-and-drop calendar → create/assign shifts.

### Broadcast an announcement
- **What:** Push a message to every active worker at once.
- **How:** **Workforce → Live → Announcements** → compose → send. (Business plan; broadcast feature/permission.)

---

## 4. Field

*Path: app switcher → **Field** (may be renamed). Grouped into **Log**, **Issues**, and **Manage** (admin).*

### Complete a daily checklist
- **What:** A recurring per-project checklist for the day; a fresh copy each day, kept as history.
- **How:** **Field → Log → Daily Checklist** → answer/check items. Clocking into (or switching to) a project also surfaces its checklist for the day. Items can be shared (crew fills one) or individual (each person their own).

### File a work note / field report (with photos or video)
- **What:** A dated, GPS-tagged note or observation, optionally with media.
- **How:** **Field → Log → Work Notes** → new note → add text and attach photos/videos → submit. Admins can mark reports reviewed.

### Create a structured daily report (admin)
- **What:** A formal daily job-site report (title, date, description, photos) exportable as PDF.
- **How:** **Field → Log → Daily Reports** → new → fill in → save; download as PDF from the report.

### Log a haul / production ticket
- **What:** Record loads/material/quantities with running totals (and bid-vs-actual on jobs from a bid).
- **How:** **Field → Log → Haul log** → add tickets.

### Track punch list items
- **What:** Open issues/deficiencies, with sub-task checklists, assignment, and completion.
- **How:** **Field → Issues → Punch** → add items; break into sub-tasks; assign; mark complete.

### File an incident report
- **How:** **Field → Issues → Incidents** → new → describe injury/near-miss/damage with date and details.

### Record a toolbox / safety talk
- **What:** A digital record of a safety meeting (title, content, who gave it, date, project) with sign-offs.
- **How:** **Field → Issues → Talks** → new talk → fill in → record worker sign-offs.

### Run an inspection checklist (admin)
- **How:** **Field → Issues → Inspect** → pick a template → complete the pass/fail responses.

### Submit / track an RFI
- **What:** A Request for Information with status and response.
- **How:** **Work → Documents → RFIs** (primary), or from a project's detail panel.

### Set up which checklists seed each project's day (admin)
- **How:** **Field → Manage → Project Daily** → pick a project scope → add checklist templates, order them, and set each to **Shared** or **Individual** with a role scope.

### Build reusable checklist templates (admin)
- **How:** **Field → Manage → Checklist Builder** → create/edit templates (safety, pre-task, etc.).

### Review submitted checklists (Checklist Reports) + export PDF (admin)
- **What:** History of completed safety/required checklist submissions.
- **How:** **Field → Manage → Checklist Reports** → expand a submission to see answers → **Export PDF** for a record.

### Review a project's daily-checklist history + export/delete a day (admin)
- **How:** **Field → Manage → Project Daily** → select a project → **History** view → expand a day. Each day has a **PDF** button (export) and, with permission, a delete (🗑) for a day logged by mistake.

### Browse the media gallery; download or convert media (admin)
- **What:** All field photos/videos in one place.
- **How:** **Field → Manage → Media** → click any item to view. In the viewer: **Download** (single), and for videos **Convert** (opens the on-device video converter). Filter by project, then **Download all (ZIP)**. (Requires the media-gallery feature.)

---

## 5. Work — projects, estimating & billing

*Path: app switcher → **Work** (admin only). Groups: **Projects**, **Documents**, **Financials**.*

### Create and manage a project
- **What:** A project with client, job number, address, dates, status, wage type, budget, progress.
- **How:** **Work → Projects → + New Project** → fill in → save. Toggle grid/list; show archived. Open a project for its detail panel.

### Use the project detail panel
- **What:** Everything about one project: health, budget bars, punchlist, documents, photos, RFIs, roster, activity.
- **How:** Open a project → sub-tabs **Overview**, **Financials**, **Closeout**, **Billing**, **Entries**, **Edit**.

### Set a budget & budget alerts
- **How:** Project → **Edit** (or Overview) → set dollar budget and an alert threshold; the Overview shows a live hours-vs-budget bar.

### Bill a project / export billing / generate a PDF invoice
- **What:** Hours and labor cost for a range, by worker and wage type; export CSV or a formatted PDF invoice.
- **How:** Project → **Billing** tab → pick a range → export CSV or generate the PDF invoice.

### Store project documents
- **How:** Project → Overview (documents) → upload/download/delete plans, permits, contracts.

### Close out a project
- **What:** Assemble and track handover documentation; move through statuses.
- **How:** Project → **Closeout** tab (or the **Closeout** page) → work the checklist → transition substantially-complete → final → closed.

### Build an estimate / bid
- **What:** Line-item estimate with branding and an optional bid-due date + reminders.
- **How:** **Work → Financials → Estimates → New** → add line items (from the price catalog if you like) → optionally attach the plan set and set a due date.

### Send an estimate for online acceptance
- **How:** Open an estimate → **Send to client** → the client reviews/accepts via a public link (no account needed).

### Convert a winning bid to a project
- **How:** Open the accepted estimate → **Convert to project** — details carry across so field/time/billing connect back.

### Manage the price catalog
- **What:** A reusable book of priced items/services.
- **How:** **Tools/Catalog** (Estimates use it), or **Inventory → Setup → Catalog**.

### Create an invoice / record a payment
- **What:** OpsFloa's own invoices (blank, from an estimate, or from a project) with AR tracking.
- **How:** **Work → Financials → Invoices → New** → choose **Blank / From estimate / From project** → build it → **Send to client** (public pay/view link) → **Record payment** as payments come in.

### Create a change order
- **How:** **Work → Financials → Change Orders → + Change Order** → add line items → **Send to client** for online review/signature.

### Issue a subcontractor purchase order
- **How:** **Work → Financials → Purchase Orders** → new PO → add line items → assign to a subcontractor.

### Track submittals
- **How:** **Work → Documents → Submittals → + New Submittal** → move it through its review cycle.

### Generate & send a lien waiver
- **How:** **Lien Waivers** page → **New Waiver** → fill in → send for online signature (public sign link).

---

## 6. Directory

*Path: app switcher → **Directory** (may be shown as your custom label). Tabs: Directory, Workers, Subcontractors, Clients, Roles.*

### Invite or add a worker
- **What:** Bring a team member onboard by email invite (they set their own password) or add manually.
- **How:** **Directory → {Workers}** → choose **Invite by email** (enter name/email → **Send invite**) or **Add manually**. The worker accepts via the emailed link.

### Set a worker's rate, permissions, and access
- **What:** Per-worker pay rate, admin permissions, data access, and messaging.
- **How:** **Directory → {Workers}** → open a worker → the **Info / Rate / Permissions / Worker Access / Messaging** sections → **Edit** each. Permissions can be **Full access** or specific toggles.

### Manage clients
- **What:** Client directory with contacts and compliance docs (COI, W-9, contract, license) with expiry flags.
- **How:** **Directory → {Clients}** → add/edit clients; upload documents with optional expiry (the app flags expiring/expired).

### Manage subcontractors
- **How:** **Directory → Subcontractors** → **New** sub → open a sub for detail/edit. (Sub POs are in Work → Financials → Purchase Orders; sub on-site reports are in Field → Log → Subs.)

### Create custom roles
- **How:** **Directory → Roles** → define custom team roles.

---

## 7. Inventory & equipment

*Path: app switcher → **Inventory**. Groups: **Stock**, **Equipment**, **Setup**.*

### Track stock on hand & movements
- **How:** **Inventory → Stock → On hand** (levels), **Transactions** (receive/issue/transfer/adjust ledger), **Valuation** (value).

### Do a cycle count
- **How:** **Inventory → Stock → Counts** (managers) or **My Count** (view-only counters) → record counts.

### Purchase orders (inventory)
- **How:** **Inventory → Stock → Orders** → create/receive POs.

### Set up items, locations, suppliers, units, catalog
- **How:** **Inventory → Setup** → **Items / Locations / Suppliers / Conversions / Catalog**. Item labels/QR codes support quick lookup on site.

### Equipment registry & maintenance (Business plan)
- **How:** **Inventory → Equipment → Assets** (registry + usage hours + maintenance alerts), **Checked out** (who has what, on which job), **Rentals** (return-due reminders), **Maintenance** (service log).

### Check equipment out / in
- **How:** **Inventory → Equipment → Assets** → check an asset out to a worker + project; check it back in from **Checked out**.

---

## 8. Tools

*Path: app switcher → **Tools**. (Some tools are paid add-ons and are gated.)*

### Plan Room (add-on)
- **What:** Browser plan viewer, markup, and measure-to-scale with a company plan library and live co-editing.
- **How:** **Tools → Plan Room** → open a plan set → mark up / calibrate scale / measure / export a flattened PDF. Live share sessions let teammates co-edit.

### Takeoff (add-on, on top of Plan Room)
- **What:** Turn measurements into priced, branded bid lines across many trades.
- **How:** In Plan Room, pick a trade → measure → priced takeoff lines flow into a bid and back onto an estimate.

### Office tools
- **How:** **Tools →** choose one:
  - **Transcription** — upload a recording → speaker-separated transcript.
  - **Summarizer** — turn a transcript/notes into a summary with action items.
  - **Doc Q&A** — open a contract/spec/cert and ask questions answered from the document.
  - **Red-Flag Scanner** — upload a subcontract → the risky money terms ranked worst-first (a reading aid, not legal advice).
  - **Email Drafter** — turn notes into a polished email/text.
  - **Calculators / Crew Cards** — quick field utilities.
  - **PDF Toolkit** — merge/reorder/rotate/delete/extract PDF pages, entirely on your device.

### Convert a video (on-device)
- **What:** Convert a field video (e.g., iPhone/QuickTime `.mov`) to MP4, entirely in your browser.
- **How:** **Field → Manage → Media** → open a video → **Convert** (opens the converter in its own tab). Pick **MP4 (recommended)** — it rewraps instantly when the video is already H.264, and only re-encodes when needed.

---

## 9. Reports & analytics

*Path: app switcher → **Reports** (admin only). Tabs: Performance, P&L by project, WIP report.*

### Analytics dashboard
- **How:** **Reports → Performance** — hours/active-worker trends, top projects/workers, daily and weekly charts. (Business plan.)

### Profit & Loss by project
- **How:** **Reports → P&L by project** — portfolio P&L table.

### Work-in-Progress (WIP) report
- **How:** **Reports → WIP report** → view the table → **Download CSV**.

---

## 10. Booking & service requests

### Online booking
- **What:** Let customers book appointments/shifts online; bookings flow into the schedule.
- **How:** **Booking** module → **Appointment Types** / **Shift Types** (define what's bookable) → **Bookable Users** (who can be booked) → **Appointments** (see/manage). Customers book at your public page (`/book/your-company`).

### Public service-request intake
- **What:** A public form so incoming work lands in the system instead of a voicemail.
- **How:** **Administration → Public** → configure Service Requests + your public profile. Requests arrive under **Administration → Public → Service Requests**; the public form is at `/r/your-company`.

---

## 11. Communication

### Company chat
- **How:** Workers: **Time Clock → Messages**. Admins: **Workforce → Live** (chat panel). Real-time; retained for a configurable number of days.

### Broadcast announcements
- **How:** **Workforce → Live → Announcements** → send to all active workers. (See §3.)

### Notifications
- **How:** Opt in on the **Account** page; alerts appear in the header **Notifications** bell and as push (approvals, comments, decisions, budget/inactivity/overtime alerts, etc.).

---

## 12. Administration & company settings

*Path: app switcher → **Administration** (admin only). Tabs: Company, Workspace, Public, Integrations, Billing, Log, Account.*

### Edit company info / logo
- **How:** **Administration → Company** — name, address, logo, subscription summary.

### Run guided setup
- **What:** A questionnaire that turns modules/features on or off to match how you work.
- **How:** **Administration → Workspace → Run guided setup**.

### Turn modules and features on/off
- **What:** Enable/disable whole modules (Time Clock, Work, Field, Inventory, Tools, Directory, Reports) and individual features (scheduling, PTO, reimbursements, chat, broadcast, analytics, geolocation, media gallery, etc.).
- **How:** **Administration → Workspace → Company Settings** → **Modules** and **Features** sections. *(Note: module/feature toggles are here, not under "Advanced Controls.")*

### Set rates, overtime, currency, timezone, units
- **How:** **Administration → Workspace → Company Settings** → **Wages** (default rates), **Overtime** (rule/threshold/multiplier), **Company Standards** (timezone, currency, week start, units), plus **Paid Time Off**, **Reimbursements** (mileage rate), **Notifications**, **Storage**, etc.

### Configure Hours & Pay Rules (role + individual overrides)
- **What:** Pay/OT rules company-wide, per role, and per individual employee.
- **How:** **Administration → Workspace → Payroll Settings → Hours & Pay Rules** → add role rules; under **Individual Overrides**, pick an employee and change/remove an inherited rule or add one just for them. (Individual > role > company default.)

### Configure deductions & paycheck rules
- **How:** **Administration → Workspace → Payroll Settings → Payroll Deductions** and **Paycheck Rules** (Advanced Payroll).

### Rename labels (Field/Worker/Client)
- **How:** **Administration → Workspace → (Workspace Labels)**.

### Edit category lists (advanced controls)
- **What:** Reimbursement categories, item units, job classifications, service-request categories.
- **How:** **Administration → Workspace → Advanced Controls**.

### Connect QuickBooks Online (add-on)
- **How:** **Administration → Integrations → QuickBooks Online** → connect via OAuth → map employees/projects → push time/payroll.

### View the audit log
- **How:** **Administration → Log** — every significant admin action with actor + timestamp; filter by action group and date.

---

## 13. Subscription & billing

### Manage your plan and add-ons
- **What:** Base plan (Free/Starter/Business) plus add-ons (QuickBooks, Plan Room, Takeoff, Advanced Payroll, Certified Payroll); annual billing available.
- **How:** **Administration → Billing** → change plan, add/remove add-ons, open the Stripe customer portal to update payment methods, download invoices, or cancel. Add-on availability/prices are managed in Stripe.

### Free trial
- **What:** New companies get a full-access trial (default 14 days).
- **How:** Automatic on signup; you'll be prompted to subscribe before it ends (remaining days carry over if you subscribe early).

---

## 14. Super Admin

*Platform-operator only (the company that runs OpsFloa), at `/superadmin`.*

- **What:** Cross-tenant console to see/manage companies and **Login as** (impersonate) a company for support.
- **How:** Sign in as super admin → you land on the Super Admin console → use its tools and the "Login as" action.

---

*Labels and availability depend on your role, plan, and your admin's module/feature settings, so some items here may not appear in every workspace. When a screen offers an action this guide doesn't name, the pattern is consistent: pick the module in the app switcher, choose the tab, then use the primary button (usually top-right or labeled "New/Add/+").*
