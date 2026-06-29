/**
 * Help-page content. Edit this file to add or revise FAQ entries.
 *
 * Shape:
 *   { id, title, intro?, items: [{ q, a }] }
 *
 * - `id` becomes the URL hash for deep links (`/help#approvals`).
 * - `intro` is an optional paragraph rendered above the Q&A list.
 * - Each `a` can be a string or an array of strings.
 */

export const HELP_SECTIONS = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    intro: "If you're brand-new to OpsFloa, work through these in order. Most take about a minute each.",
    items: [
      {
        q: 'How do I add my first team member?',
        a: 'Open Team in the AppSwitcher. Click "Add team member" and enter their name and email. They will get an invite link to set their own password. You can also create them with a temporary password if email is not reliable in their environment.',
      },
      {
        q: 'How do I create projects people can clock in to?',
        a: [
          'Open Projects in the AppSwitcher and click "New project". It only needs a name; everything else is optional.',
          'If your business does not track projects by job, route, case, or customer, create a single "General" project and use it for everything. People need one project available before they can clock in.',
        ],
      },
      {
        q: "Why don't I see Field, Inventory, or some other module?",
        a: 'Modules can be turned off per company under Administration > Workspace > Modules. New companies default to a minimal set and you turn on other tools as you need them.',
      },
      {
        q: 'How do I switch between admin tools and clocking myself in?',
        a: 'Click the AppSwitcher in the top-left. "Workforce" is the admin oversight view. "Time Clock" is the participating view, where you clock yourself in like the rest of the team.',
      },
    ],
  },
  {
    id: 'time-tracking',
    title: 'Time Tracking',
    items: [
      {
        q: "What's the difference between hourly and daily team members?",
        a: [
          'Hourly people clock in, clock out, and get paid for elapsed time.',
          'Daily-rate people get paid a flat rate per day worked. You can have them clock in/out as usual or enable "Mark Day mode" on their profile so they tap one button to record presence.',
        ],
      },
      {
        q: 'How does overtime work?',
        a: 'Set the rule under Administration > Workspace > Overtime. "Daily" pays OT after a per-day threshold. "Weekly" pays OT after a per-week total. You can override OT on a per-entry basis from the Approvals tab when a specific entry needs different treatment.',
      },
      {
        q: 'Someone clocked in but is not showing on Live',
        a: 'Live polls every minute, so wait a moment or hit Refresh. If they still do not appear, check that they selected a project on clock-in. If their browser blocked location access, the clock-in still goes through but you will get a "Location denied" alert in the bell.',
      },
      {
        q: 'Can people edit their own time after submitting?',
        a: 'Yes, within 7 days and as long as the entry is not in a locked pay period. They cannot edit entries you have already approved. If you want to disable self-editing entirely, use the company setting under Administration > Workspace.',
      },
      {
        q: 'What does "Mark Day" do for daily-rate people?',
        a: 'For daily-rate team members with Mark Day mode enabled, clock-in and clock-out collapse into one button. Useful for piece-rate, per-diem, or presence-based work where exact hours do not affect pay.',
      },
      {
        q: 'How does someone request time off or PTO?',
        keywords: ['time off', 'PTO', 'vacation', 'leave', 'sick day', 'request leave', 'absence'],
        a: 'Open Time Clock > Time Off. Pick the dates, choose the request type, add a note if needed, and submit. Admins review requests from the workforce time-off tools.',
      },
    ],
  },
  {
    id: 'approvals',
    title: 'Approvals & Edits',
    items: [
      {
        q: 'How do I approve time entries?',
        a: 'Workforce > Approvals. Each entry has Approve and Reject buttons. You can also edit times before approving, or split an entry across multiple projects if someone worked on more than one job, route, case, or customer in a single shift.',
      },
      {
        q: 'Someone clocked the wrong day. How do I fix it?',
        a: 'Workforce > Approvals > click Edit on the entry. Change the Date input to the correct day and Save. The change is recorded in the audit log.',
      },
      {
        q: 'What does "lock a pay period" mean?',
        a: 'Locking freezes every entry in a date range so it cannot be edited once you have closed the books on it. Use it after you have exported or paid out a period. Workforce > Approvals > Pay Periods.',
      },
      {
        q: 'I rejected an entry by mistake. Can I undo it?',
        a: 'A rejected entry stays in the system as "rejected"; it is not deleted. The person can resubmit, and you can also unreject from the entry detail view.',
      },
    ],
  },
  {
    id: 'roles-permissions',
    title: 'Roles & Permissions',
    items: [
      {
        q: "What's the difference between Team Member, Admin, and Owner?",
        a: [
          'Team Member is the default participating role. They clock themselves in, see their own entries, and may submit reports or checklists depending on what is enabled.',
          'Admin includes oversight: approve entries, manage people and projects, view reports, and run exports.',
          'Owner includes billing, role management, and company-level control. Each company gets one Owner by default: the person who registered.',
        ],
      },
      {
        q: 'Can I create a custom role?',
        a: 'Yes. Team > Manage Roles lets you pick which Team Member or Admin permissions a custom role gets. Useful for a lead who approves entries but should not manage billing, or office staff who need reports without every admin control.',
      },
      {
        q: 'I removed a permission from someone but they still see the tab',
        a: 'They need to refresh or log out and back in. Permissions are computed on login and cached in the session. The next auth refresh also picks up the change automatically.',
      },
    ],
  },
  {
    id: 'reports-exports',
    title: 'Reports & Exports',
    items: [
      {
        q: 'How do I export hours for payroll?',
        a: 'Workforce > Reports > Export. Pick a date range and download as CSV. The Payroll Export tile formats columns the way most payroll providers expect.',
      },
      {
        q: 'What is Certified Payroll?',
        a: 'Certified Payroll, including federal form WH-347, is required for some prevailing-wage public work. Enable it under Administration > Workspace > Modules to get classification fields, fringe benefit tracking, signed weekly reports, and the WH-347 PDF generator.',
      },
      {
        q: 'Can I see labor cost by project?',
        a: 'Workforce > Reports > Project Reports. Filter by date range and project to see total hours and pay, if Show Wages is enabled.',
      },
    ],
  },
  {
    id: 'inventory',
    title: 'Inventory',
    items: [
      {
        q: 'How do I run an inventory count or cycle count?',
        keywords: ['inventory count', 'cycle count', 'stock count', 'physical count', 'reconcile stock', 'audit inventory'],
        a: 'Open Inventory > Counts. Create a full count or cycle count, choose what should be counted, enter the counted quantities, review variances, and reconcile only when the numbers are ready.',
      },
      {
        q: 'How do I receive items from a purchase order?',
        keywords: ['receive inventory', 'receive PO', 'supplier order', 'stock delivery'],
        a: 'Open Inventory > Orders, open the submitted PO, choose Receive Items, pick the receiving location, and enter only the quantities that arrived.',
      },
    ],
  },
  {
    id: 'billing',
    title: 'Billing & Subscription',
    items: [
      {
        q: 'How do I update my payment method?',
        a: 'Administration > Billing > Manage Subscription opens the Stripe customer portal where you can change card, view invoices, and cancel.',
      },
      {
        q: 'My trial is about to expire. What happens?',
        a: 'You will see a banner starting 7 days before. If the trial ends and you have not subscribed, the app keeps your data but blocks team member login until you pick a plan. Admins can still log in to update billing.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    items: [
      {
        q: "I'm not getting notification bell or push alerts",
        a: 'Open Account > Notifications. Team members and admins each need to grant browser notification permission once. On iOS, push notifications only work if OpsFloa is installed as a home-screen app.',
      },
      {
        q: 'People say the app feels slow with bad signal',
        a: 'OpsFloa is a PWA: clock-in and clock-out work offline. Punches are queued locally and replayed when the device gets a signal. If someone consistently reports slowness, it is usually network latency.',
      },
      {
        q: 'A setting I changed did not seem to apply',
        a: 'Most settings take effect immediately, but some cached state, like a permission list, only refreshes when the browser revalidates auth. A page refresh or quick logout/login picks up the change.',
      },
      {
        q: 'I need help that is not answered here',
        a: 'Open Administration > Account > Send a support message. Include screenshots or steps if the issue is hard to describe.',
      },
    ],
  },
];
