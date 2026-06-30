import { userHasAnyPerm } from './hooks/usePerm';

export const GUIDE_TASKS = [
  {
    id: 'create-subcontractor-po',
    title: 'Create a subcontractor PO',
    category: 'Projects',
    app: 'projects',
    summary: 'Set up a purchase order for a subcontractor and tie it to the project it belongs to.',
    route: '/projects#pos',
    routeLabel: 'Open subcontractor POs',
    requiredModules: ['projects'],
    requiredAnyPerms: ['manage_projects', 'manage_settings'],
    permissionLabel: 'manage project work',
    keywords: [
      'po', 'purchase order', 'sub', 'subcontractor', 'vendor', 'scope', 'retainage',
      'pay a sub', 'sub po', 'contractor',
    ],
    before: [
      'The project should already exist.',
      'The subcontractor should already be in Directory > Subcontractors.',
    ],
    steps: [
      'Open Projects.',
      'Go to the Purchase Orders tab.',
      'Choose New PO.',
      'Pick the project and subcontractor.',
      'Enter the scope, amount, retainage if needed, and any notes.',
      'Save it as a draft. Issue it only when the details are ready.',
    ],
    related: ['add-subcontractor', 'create-project', 'record-subcontractor-payment'],
  },
  {
    id: 'add-subcontractor',
    title: 'Add a subcontractor',
    category: 'Directory',
    app: 'team',
    summary: 'Create the subcontractor record that can be used in subcontractor POs and project paperwork.',
    route: '/team#subs',
    routeLabel: 'Open subcontractors',
    requiredModules: ['team'],
    requiredAdmin: true,
    permissionLabel: 'admin access to Directory',
    keywords: ['subcontractor', 'sub', 'vendor', 'directory', 'contractor', 'company'],
    steps: [
      'Open Directory.',
      'Go to the Subcontractors tab.',
      'Choose Add subcontractor.',
      'Enter the company name first. Add contact, trade, insurance, and notes when you have them.',
      'Save the subcontractor. You can come back later to attach documents.',
    ],
    related: ['create-subcontractor-po', 'add-team-member'],
  },
  {
    id: 'record-subcontractor-payment',
    title: 'Record a subcontractor PO payment',
    category: 'Projects',
    app: 'projects',
    summary: 'Track partial or final payments against a subcontractor PO.',
    route: '/projects#pos',
    routeLabel: 'Open subcontractor POs',
    requiredModules: ['projects'],
    requiredAnyPerms: ['manage_projects', 'manage_settings'],
    permissionLabel: 'manage project work',
    keywords: ['pay sub', 'payment', 'subcontractor payment', 'partial payment', 'invoice', 'po payment'],
    before: [
      'The subcontractor PO must be issued before payments can be recorded.',
    ],
    steps: [
      'Open Projects > Purchase Orders.',
      'Open the subcontractor PO.',
      'Find the Payments area.',
      'Enter the payment amount, paid date, invoice reference, and notes.',
      'Save the payment. OpsFloa will mark the PO partial or complete based on totals.',
    ],
    related: ['create-subcontractor-po'],
  },
  {
    id: 'create-project',
    title: 'Create a project',
    category: 'Projects',
    app: 'projects',
    summary: 'Add a project, job, route, or customer work bucket people can clock into and report against.',
    route: '/projects',
    routeLabel: 'Open Projects',
    requiredModules: ['projects'],
    requiredAnyPerms: ['manage_projects'],
    permissionLabel: 'manage projects',
    keywords: ['project', 'job', 'work', 'route', 'customer', 'client', 'add job'],
    steps: [
      'Open Projects.',
      'Choose New project.',
      'Enter the name. Add the customer, job number, budget, and location if you have them.',
      'Save the project.',
      'If people clock into projects, make sure it is active.',
    ],
    related: ['create-subcontractor-po', 'clock-in-to-project'],
  },
  {
    id: 'clock-in-to-project',
    title: 'Clock in to a project',
    category: 'Time Clock',
    app: 'timeclock',
    summary: 'Start the day against the right project so time lands where it belongs.',
    route: '/timeclock#clock',
    routeLabel: 'Open Time Clock',
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['clock_self', 'submit_time_entry_self'],
    permissionLabel: 'clock yourself in',
    keywords: ['clock in', 'project', 'start day', 'time', 'punch in', 'job'],
    before: [
      'If the company uses projects, at least one active project must exist.',
    ],
    steps: [
      'Open Time Clock.',
      'Choose Clock.',
      'Select the project or work item.',
      'Add notes if they help explain the day.',
      'Tap Clock In.',
    ],
    related: ['create-project', 'fix-missed-clock-out'],
  },
  {
    id: 'approve-time',
    title: 'Approve time entries',
    category: 'Time Clock',
    app: 'timeclock',
    summary: 'Review pending time before payroll and approve only entries that are complete.',
    route: '/timeclock#wf-approvals',
    routeLabel: 'Open Approvals',
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['approve_entries'],
    permissionLabel: 'approve time entries',
    keywords: ['approve', 'approval', 'payroll', 'timesheet', 'pending time', 'review time'],
    steps: [
      'Open Time Clock.',
      'Switch to Workforce.',
      'Open Approvals.',
      'Review the person, project, start time, end time, and notes.',
      'Edit or reject anything wrong.',
      'Approve entries only after they have ended.',
    ],
    related: ['fix-missed-clock-out', 'run-payroll-export'],
  },
  {
    id: 'fix-missed-clock-out',
    title: 'Fix a missed clock-out',
    category: 'Time Clock',
    app: 'timeclock',
    summary: 'Correct an open or incorrect time entry before it reaches payroll.',
    route: '/timeclock#wf-approvals',
    routeLabel: 'Open Approvals',
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['edit_any_entry', 'approve_entries'],
    permissionLabel: 'edit or approve time',
    keywords: ['missed clock out', 'forgot clock out', 'fix time', 'edit time', 'open shift', 'stale clock'],
    steps: [
      'Open Time Clock.',
      'Switch to Workforce.',
      'Open Approvals.',
      'Find the entry and choose Edit.',
      'Set the correct end time and confirm the project or notes.',
      'Save, then approve only if the entry is ready for payroll.',
    ],
    related: ['approve-time'],
  },
  {
    id: 'run-payroll-export',
    title: 'Run a payroll export',
    category: 'Reports',
    app: 'timeclock',
    summary: 'Download approved time for payroll or review a date range before closing it.',
    route: '/timeclock#wf-reports',
    routeLabel: 'Open Reports',
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['view_reports', 'export_data'],
    permissionLabel: 'view reports or export data',
    keywords: ['payroll', 'export', 'csv', 'hours', 'pay period', 'reports'],
    before: [
      'Approve and correct time entries first.',
    ],
    steps: [
      'Open Time Clock.',
      'Switch to Workforce.',
      'Open Reports.',
      'Choose the payroll or time export.',
      'Pick the date range.',
      'Download the file and review totals before importing into payroll.',
    ],
    related: ['approve-time', 'lock-pay-period'],
  },
  {
    id: 'lock-pay-period',
    title: 'Lock a pay period',
    category: 'Time Clock',
    app: 'timeclock',
    summary: 'Freeze a completed date range after payroll has been reviewed or exported.',
    route: '/timeclock#wf-approvals',
    routeLabel: 'Open Pay Periods',
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['manage_pay_periods'],
    permissionLabel: 'manage pay periods',
    keywords: ['lock', 'pay period', 'close payroll', 'freeze time', 'payroll'],
    before: [
      'Make sure entries in the date range are approved and exported.',
    ],
    steps: [
      'Open Time Clock > Workforce > Approvals.',
      'Open Pay Periods.',
      'Choose the start and end dates.',
      'Lock the period.',
      'If a correction is needed later, unlock intentionally, fix the entry, then lock it again.',
    ],
    related: ['run-payroll-export', 'approve-time'],
  },
  {
    id: 'request-time-off',
    title: 'Request time off',
    category: 'Time Clock',
    app: 'timeclock',
    summary: 'Submit vacation, sick time, PTO, or leave so an admin can review it.',
    route: '/timeclock#timeoff',
    routeLabel: 'Open Time Off',
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['clock_self', 'submit_time_entry_self', 'view_own_entries'],
    permissionLabel: 'use personal time tools',
    keywords: ['time off', 'pto', 'vacation', 'leave', 'sick day', 'request leave', 'day off', 'absence'],
    steps: [
      'Open Time Clock.',
      'Choose Time Off.',
      'Pick the start date, end date, and request type.',
      'Add a note if your manager needs context.',
      'Submit the request.',
      'Watch the same tab for approval or denial.',
    ],
    related: ['approve-time', 'lock-pay-period'],
  },
  {
    id: 'create-inventory-po',
    title: 'Create an inventory purchase order',
    category: 'Inventory',
    app: 'inventory',
    summary: 'Order items from a supplier and receive them into stock when they arrive.',
    route: '/inventory#orders',
    routeLabel: 'Open inventory orders',
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: ['inventory po', 'purchase order', 'supplier', 'order stock', 'reorder', 'materials'],
    before: [
      'Items and suppliers should already exist, though you can add missing setup data first.',
    ],
    steps: [
      'Open Inventory.',
      'Go to Operations > Orders.',
      'Choose New PO.',
      'Pick the supplier and default receiving location.',
      'Add items, quantities, and unit costs.',
      'Create the draft, then submit it when ready.',
    ],
    related: ['receive-inventory-po', 'add-inventory-item'],
  },
  {
    id: 'receive-inventory-po',
    title: 'Receive items from a PO',
    category: 'Inventory',
    app: 'inventory',
    summary: 'Move delivered items from a purchase order into the selected stock location.',
    route: '/inventory#orders',
    routeLabel: 'Open inventory orders',
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: ['receive inventory', 'receive po', 'delivery', 'stock', 'supplier', 'items arrived'],
    steps: [
      'Open Inventory > Orders.',
      'Open the submitted or partially received PO.',
      'Choose Receive Items.',
      'Pick the receiving location.',
      'Enter only the quantities that arrived now.',
      'Confirm receipt. Stock updates immediately.',
    ],
    related: ['create-inventory-po'],
  },
  {
    id: 'add-inventory-item',
    title: 'Add an inventory item',
    category: 'Inventory',
    app: 'inventory',
    summary: 'Create the item record that stock, transactions, counts, and purchase orders use.',
    route: '/inventory#items',
    routeLabel: 'Open inventory items',
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: ['item', 'sku', 'part', 'inventory item', 'add item', 'materials'],
    steps: [
      'Open Inventory.',
      'Switch to Setup.',
      'Open Items.',
      'Choose Add Item.',
      'Enter the name, SKU, category, unit, cost, and reorder settings you know.',
      'Save the item. You can add stock later through transactions or receiving.',
    ],
    related: ['create-inventory-po', 'receive-inventory-po'],
  },
  {
    id: 'run-inventory-count',
    title: 'Run an inventory count',
    category: 'Inventory',
    app: 'inventory',
    summary: 'Create a full or cycle count to verify stock and reconcile what is physically on hand.',
    route: '/inventory#counts',
    routeLabel: 'Open inventory counts',
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: ['inventory count', 'cycle count', 'stock count', 'physical count', 'reconcile stock', 'audit inventory', 'counts'],
    before: [
      'Items and stock locations should already exist.',
    ],
    steps: [
      'Open Inventory.',
      'Go to Counts.',
      'Choose New Count.',
      'Pick full count or cycle count and choose the scope.',
      'Assign counters if more than one person is helping.',
      'Enter counted quantities, review variances, and reconcile when ready.',
    ],
    related: ['add-inventory-item', 'receive-inventory-po'],
  },
  {
    id: 'add-team-member',
    title: 'Invite or add a team member',
    category: 'Directory',
    app: 'team',
    summary: 'Give a person access and set the basics needed for time, reports, and payroll.',
    route: '/team#team',
    routeLabel: 'Open team members',
    requiredModules: ['team'],
    requiredAnyPerms: ['manage_workers'],
    permissionLabel: 'manage team members',
    keywords: ['invite', 'add user', 'add worker', 'team member', 'employee', 'email invite'],
    steps: [
      'Open Directory.',
      'Go to the Team Members tab.',
      'Choose Add Manually or Invite by Email.',
      'Fill in required fields and choose the role.',
      'Add worker type, classification, rate type, and overtime rule when needed.',
      'Save or send the invite.',
    ],
    related: ['guided-company-setup'],
  },
  {
    id: 'guided-company-setup',
    title: 'Run company setup',
    category: 'Administration',
    app: 'administration',
    summary: 'Choose which modules and daily tools this company should actually see.',
    route: '/administration?setup=1',
    routeLabel: 'Open guided setup',
    requiredModules: ['administration'],
    requiredAnyPerms: ['manage_settings'],
    permissionLabel: 'manage company settings',
    keywords: ['setup', 'wizard', 'turn on modules', 'company settings', 'configure', 'start'],
    steps: [
      'Open Administration.',
      'Start guided setup.',
      'Choose the work the company tracks.',
      'Choose the daily tools people need.',
      'Choose manager visibility and labels.',
      'Review the summary and apply the setup.',
    ],
    related: ['configure-modules', 'add-team-member'],
  },
  {
    id: 'configure-modules',
    title: 'Turn modules on or off',
    category: 'Administration',
    app: 'administration',
    summary: 'Keep the app simple by showing only the parts this company uses.',
    route: '/administration#workspace',
    routeLabel: 'Open Company Settings',
    requiredModules: ['administration'],
    requiredAnyPerms: ['manage_settings'],
    permissionLabel: 'manage company settings',
    keywords: ['modules', 'settings', 'hide', 'show', 'turn on', 'turn off', 'customize'],
    steps: [
      'Open Administration.',
      'Go to Workspace.',
      'Open Company Settings.',
      'Turn modules and feature controls on or off.',
      'Save changes.',
      'Ask users to refresh if their navigation does not update immediately.',
    ],
    related: ['guided-company-setup'],
  },
];

export const MODULE_LABELS = {
  timeclock: 'Time Clock',
  workforce: 'Workforce',
  field: 'Field Work',
  inventory: 'Inventory',
  team: 'Directory',
  projects: 'Projects',
  administration: 'Administration',
  financial_reports: 'Reports',
};

export function isGuideModuleEnabled(features = {}, moduleId) {
  features = features || {};
  if (!moduleId) return true;
  if (moduleId === 'financial_reports') {
    return !(features.module_financial_reports === false && features.module_analytics === false);
  }
  return features[`module_${moduleId}`] !== false;
}

export function getGuideTaskAvailability(task, user, features = {}) {
  features = features || {};
  const missingModules = (task.requiredModules || [])
    .filter(moduleId => !isGuideModuleEnabled(features, moduleId))
    .map(moduleId => MODULE_LABELS[moduleId] || moduleId);

  const adminOk = !task.requiredAdmin || user?.role === 'admin' || user?.role === 'super_admin';
  const permsOk = !task.requiredAnyPerms?.length || userHasAnyPerm(user, task.requiredAnyPerms);
  const missingRole = adminOk ? '' : 'admin access';
  const missingPermission = permsOk ? '' : task.permissionLabel || 'additional permission';

  return {
    ready: missingModules.length === 0 && adminOk && permsOk,
    missingModules,
    missingRole,
    missingPermission,
  };
}

export function sortGuideTasks(tasks, currentApp) {
  return [...tasks].sort((a, b) => {
    const aCurrent = a.app === currentApp ? 0 : 1;
    const bCurrent = b.app === currentApp ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    return a.title.localeCompare(b.title);
  });
}

const GUIDE_STOP_WORDS = new Set(['a', 'an', 'and', 'can', 'do', 'for', 'how', 'i', 'make', 'the', 'to']);

function normalizeGuideTokens(value) {
  const tokens = String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.flatMap(token => {
    if (token.length > 2 && token.endsWith('s')) {
      return [token, token.slice(0, -1)];
    }
    return [token];
  });
}

function guideFieldText(task, field) {
  if (Array.isArray(task[field])) return task[field].join(' ');
  return task[field] || '';
}

function guideTokenSet(task, fields) {
  return new Set(fields.flatMap(field => normalizeGuideTokens(guideFieldText(task, field))));
}

function guideTaskScore(task, terms, phrase, currentApp) {
  const titleTokens = guideTokenSet(task, ['title']);
  const routeTokens = guideTokenSet(task, ['routeLabel']);
  const keywordTokens = guideTokenSet(task, ['keywords']);
  const categoryTokens = guideTokenSet(task, ['category']);
  const bodyTokens = guideTokenSet(task, ['summary', 'before', 'steps']);
  const haystack = [
    task.title,
    task.category,
    task.summary,
    task.routeLabel,
    ...(task.keywords || []),
    ...(task.before || []),
    ...(task.steps || []),
  ].join(' ').toLowerCase();

  let score = task.app === currentApp ? 4 : 0;
  const phraseIsUseful = phrase.length > 2 || phrase.includes(' ');
  if (phraseIsUseful) {
    if (String(task.title || '').toLowerCase().includes(phrase)) score += 85;
    if (String(task.routeLabel || '').toLowerCase().includes(phrase)) score += 65;
    if ((task.keywords || []).join(' ').toLowerCase().includes(phrase)) score += 70;
    if (haystack.includes(phrase)) score += 15;
  }

  for (const term of terms) {
    let termScore = 0;
    if (titleTokens.has(term)) termScore += 70;
    if (keywordTokens.has(term)) termScore += 65;
    if (routeTokens.has(term)) termScore += 55;
    if (categoryTokens.has(term)) termScore += 20;
    if (bodyTokens.has(term)) termScore += 12;
    if (term.length >= 3 && haystack.includes(term)) termScore += 6;
    if (termScore === 0) return 0;
    score += termScore;
  }

  return score;
}

export function filterGuideTasks(query, currentApp, tasks = GUIDE_TASKS) {
  const q = String(query || '').trim().toLowerCase();
  const sorted = sortGuideTasks(tasks, currentApp);
  if (!q) return sorted;
  const terms = normalizeGuideTokens(q).filter(term => term && !GUIDE_STOP_WORDS.has(term));
  if (terms.length === 0) return sorted;

  return tasks
    .map(task => ({ task, score: guideTaskScore(task, terms, q, currentApp) }))
    .filter(result => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aCurrent = a.task.app === currentApp ? 0 : 1;
      const bCurrent = b.task.app === currentApp ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      return a.task.title.localeCompare(b.task.title);
    })
    .map(result => result.task);
}

export function findGuideTask(id) {
  return GUIDE_TASKS.find(task => task.id === id) || null;
}
