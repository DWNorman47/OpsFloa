import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'public', 'captures', 'field-payroll');
const baseUrl = process.env.OPSFLOA_CAPTURE_URL || 'https://stage.opsfloa.com';
const companyName = 'Demo Operations';
const adminUsername = process.env.OPSFLOA_CAPTURE_USERNAME || 'Admin';
const adminPassword = process.env.OPSFLOA_CAPTURE_PASSWORD || 'Admin123';
const workerUsername = 'ad.walkthrough';
const workerPassword = 'DemoWalkthrough123!';
const workerName = 'Jordan Lee';
const payrollRulesetName = 'Weekly Field Payroll';
const reportEntryNote = 'Marketing report walkthrough overtime';
const phoenix = { latitude: 33.4484, longitude: -112.0740 };
const browserCandidates = [
  process.env.REMOTION_BROWSER_EXECUTABLE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const browserExecutable = browserCandidates.find(candidate => existsSync(candidate));

if (!browserExecutable) throw new Error('No Chrome-compatible browser found.');
if (!new URL(baseUrl).hostname.startsWith('stage.')) {
  throw new Error('The field/payroll walkthrough may only mutate the staging Demo Operations workspace.');
}

mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  geolocation: phoenix,
  permissions: ['geolocation'],
  reducedMotion: 'reduce',
});
const adminPage = await context.newPage();

async function loginThroughUi(page, username, password) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#company').fill(companyName);
  await page.locator('#username').fill(username);
  await page.locator('#login-password').fill(password);
  await Promise.all([
    page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 20_000 }),
    page.getByRole('button', { name: 'Sign In' }).click(),
  ]);
  await page.waitForTimeout(1500);
  return page.evaluate(() => ({
    apiBase: localStorage.getItem('tc_api_base'),
    token: localStorage.getItem('tc_token'),
  }));
}

async function api(apiBase, token, path, options = {}) {
  const response = await fetch(`${apiBase}/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${data.error || ''}`);
  return data;
}

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(outputDir, `${name}.png`) });
  console.log(`Captured ${name}`);
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3500);
}

function ymdInPhoenix(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(ymd, days) {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousSundayToSaturday() {
  const today = ymdInPhoenix();
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const from = addDays(today, -(day + 7));
  return { from, to: addDays(from, 6), overtimeDate: addDays(from, 3) };
}

try {
  const adminSession = await loginThroughUi(adminPage, adminUsername, adminPassword);
  const [settings, roles] = await Promise.all([
    api(adminSession.apiBase, adminSession.token, '/admin/settings'),
    api(adminSession.apiBase, adminSession.token, '/admin/roles'),
  ]);
  const workerRoleIds = roles
    .filter(role => role.parent_role === 'worker')
    .map(role => Number(role.id));
  if (!workerRoleIds.length) throw new Error('At least one worker role is required for the payroll walkthrough.');

  await api(adminSession.apiBase, adminSession.token, '/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      week_start: 1,
      work_week_end: 0,
      overtime_rule: 'weekly',
      overtime_threshold: 40,
      overtime_multiplier: 1.5,
      regular_shift_hours: 8,
    }),
  });
  const deductions = JSON.stringify({
    version: 1,
    items: [
      { id: 'demo_retirement', name: 'Retirement contribution', kind: 'percent', value: 3 },
      { id: 'demo_health', name: 'Health plan', kind: 'fixed', value: 45 },
    ],
  });
  if (settings.deductions !== deductions) {
    await api(adminSession.apiBase, adminSession.token, '/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        deductions,
        expected_settings: { deductions: settings.deductions || '' },
      }),
    });
  }
  const paycheckRules = JSON.stringify({
    version: 1,
    rulesets: [{
      id: 'demo_weekly_field',
      name: payrollRulesetName,
      roles: workerRoleIds,
      schedule: {
        frequency: 'weekly',
        periodBasis: 'work_week',
        payWeekday: 5,
        anchorDate: null,
        daysOfMonth: [],
        dayOfMonth: 30,
        weekendShift: 'before',
      },
      deductions: {
        timing: 'every',
        group: { by: 'pair', applyOn: 'second' },
        combineGroup: true,
        exemptAmountCents: 0,
        cap: { type: 'none', valueCents: 0, valuePct: 0 },
        minNetCents: 0,
        scope: 'all',
        selectedDeductionIds: [],
      },
      notes: 'Weekly Friday payroll for the prior completed Monday-Sunday work week.',
    }],
  });
  if (settings.paycheck_rules !== paycheckRules) {
    await api(adminSession.apiBase, adminSession.token, '/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        paycheck_rules: paycheckRules,
        expected_settings: { paycheck_rules: settings.paycheck_rules || '' },
      }),
    });
  }

  const workers = await api(adminSession.apiBase, adminSession.token, '/admin/workers?all_roles=true');
  const defaultWorkerRole = roles.find(role => role.is_builtin && role.name === 'Worker')
    || roles.find(role => role.parent_role === 'worker');
  const workersMissingRoles = workers.filter(item => item.role === 'worker' && !item.role_id);
  for (const item of workersMissingRoles) {
    await api(adminSession.apiBase, adminSession.token, `/admin/workers/${item.id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role_id: defaultWorkerRole.id }),
    });
  }
  let worker = workers.find(item => item.username === workerUsername);
  if (!worker) {
    worker = await api(adminSession.apiBase, adminSession.token, '/admin/workers', {
      method: 'POST',
      body: JSON.stringify({
        username: workerUsername,
        password: workerPassword,
        full_name: workerName,
        first_name: 'Jordan',
        last_name: 'Lee',
        role: 'worker',
        language: 'English',
        hourly_rate: 34,
        rate_type: 'hourly',
        overtime_rule: 'daily',
        worker_type: 'employee',
      }),
    });
  }
  if (worker.overtime_rule !== 'daily' || Number(worker.hourly_rate) !== 34) {
    worker = await api(adminSession.apiBase, adminSession.token, `/admin/workers/${worker.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ overtime_rule: 'daily', hourly_rate: 34 }),
    });
  }

  const projects = (await api(adminSession.apiBase, adminSession.token, '/work')).filter(project => project.active !== false);
  const primaryProject = projects.find(project => !project.geo_radius_ft) || projects[0];
  const secondProject = projects.find(project => project.id !== primaryProject.id && !project.geo_radius_ft) || projects[1];
  if (!primaryProject || !secondProject) throw new Error('Two active demo projects are required.');

  const workerLogin = await fetch(`${adminSession.apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: companyName, username: workerUsername, password: workerPassword }),
  });
  let workerSession = await workerLogin.json();
  if (!workerLogin.ok) throw new Error(`Worker login failed: ${workerSession.error || workerLogin.status}`);
  if (workerSession.must_change_password) {
    const setupResponse = await fetch(`${adminSession.apiBase}/api/auth/complete-setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_token: workerSession.setup_token, new_password: workerPassword }),
    });
    workerSession = await setupResponse.json();
    if (!setupResponse.ok) throw new Error(`Worker setup failed: ${workerSession.error || setupResponse.status}`);
  }

  await api(adminSession.apiBase, workerSession.token, '/auth/accept-terms', { method: 'POST', body: '{}' });
  await api(adminSession.apiBase, workerSession.token, '/clock/cancel', { method: 'DELETE' }).catch(() => {});

  const reportWeek = previousSundayToSaturday();
  const approvedEntries = await api(
    adminSession.apiBase,
    adminSession.token,
    `/admin/entries/recently-approved?from=${reportWeek.from}&to=${reportWeek.to}`,
  );
  const priorWalkthroughEntries = approvedEntries.filter(entry => (
    Number(entry.user_id) === Number(worker.id) && entry.notes === 'Travel and staging'
  ));
  await Promise.all(priorWalkthroughEntries.map(entry => api(
    adminSession.apiBase,
    adminSession.token,
    `/admin/entries/${entry.id}/reject`,
    { method: 'PATCH', body: JSON.stringify({ note: 'Replaced by marketing walkthrough capture' }) },
  )));

  const pendingEntries = await api(adminSession.apiBase, adminSession.token, '/admin/entries/pending');
  let walkthroughEntries = pendingEntries.entries?.filter(entry => entry.user_id === worker.id) || [];
  const pendingReportEntries = walkthroughEntries.filter(entry => entry.notes === reportEntryNote);
  await Promise.all(pendingReportEntries.map(entry => api(
    adminSession.apiBase,
    adminSession.token,
    `/admin/entries/${entry.id}/approve`,
    { method: 'PATCH', body: '{}' },
  )));
  walkthroughEntries = walkthroughEntries.filter(entry => entry.notes !== reportEntryNote);
  if (walkthroughEntries.length > 1) {
    await Promise.all(walkthroughEntries.map(entry => api(
      adminSession.apiBase,
      adminSession.token,
      `/admin/entries/${entry.id}/reject`,
      { method: 'PATCH', body: JSON.stringify({ note: 'Replaced by marketing walkthrough capture' }) },
    )));
    walkthroughEntries = [];
  }
  const locatedWalkthroughEntry = walkthroughEntries.length === 1
    && walkthroughEntries[0].clock_in_lat != null
    && walkthroughEntries[0].clock_out_lat != null
    ? walkthroughEntries[0]
    : null;
  if (!locatedWalkthroughEntry) {
    const now = new Date();
    const clockInAt = new Date(now.getTime() - 8 * 60 * 60 * 1000);
    const walkthroughDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(walkthroughDate);
    await api(adminSession.apiBase, workerSession.token, '/clock/in', {
      method: 'POST',
      body: JSON.stringify({
        project_id: primaryProject.id,
        notes: 'Travel and staging',
        lat: phoenix.latitude,
        lng: phoenix.longitude,
        local_work_date: localDate,
        timezone: 'America/Phoenix',
        clock_in_time: clockInAt.toISOString(),
      }),
    });
    await api(adminSession.apiBase, workerSession.token, '/clock/out', {
      method: 'POST',
      body: JSON.stringify({
        lat: phoenix.latitude + 0.0024,
        lng: phoenix.longitude - 0.0018,
        local_clock_in: '07:00',
        local_clock_out: '15:00',
        break_minutes: 0,
      }),
    });
  }

  const reportData = await api(
    adminSession.apiBase,
    adminSession.token,
    `/admin/workers/${worker.id}/entries?from=${reportWeek.from}&to=${reportWeek.to}&explain=1`,
  );
  const existingReportEntries = reportData.entries?.filter(entry => entry.notes === reportEntryNote) || [];
  const reportHasOvertime = existingReportEntries.some(entry => Number(entry.overtime_hours) > 0);
  if (!reportHasOvertime) {
    await Promise.all(existingReportEntries.map(entry => api(
      adminSession.apiBase,
      adminSession.token,
      `/admin/entries/${entry.id}/reject`,
      { method: 'PATCH', body: JSON.stringify({ note: 'Replaced by overtime report walkthrough' }) },
    )));
    const reportEntry = await api(adminSession.apiBase, adminSession.token, `/admin/workers/${worker.id}/entries`, {
      method: 'POST',
      body: JSON.stringify({
        work_date: reportWeek.overtimeDate,
        start_time: '07:00',
        end_time: '17:00',
        project_id: primaryProject.id,
        break_minutes: 0,
        notes: reportEntryNote,
      }),
    });
    await api(adminSession.apiBase, adminSession.token, `/admin/entries/${reportEntry.id}/edit`, {
      method: 'PATCH',
      body: JSON.stringify({
        work_date: reportWeek.overtimeDate,
        start_time: '07:00',
        end_time: '17:00',
        project_id: primaryProject.id,
        wage_type: reportEntry.wage_type || 'regular',
        overtime_hours_override: 2,
      }),
    });
    await api(adminSession.apiBase, adminSession.token, `/admin/entries/${reportEntry.id}/approve`, {
      method: 'PATCH',
      body: '{}',
    });
  }

  const workerPage = await context.newPage();
  await workerPage.addInitScript(({ token }) => localStorage.setItem('tc_token', token), { token: workerSession.token });
  await workerPage.goto(`${baseUrl}/timeclock`, { waitUntil: 'domcontentloaded' });
  await settle(workerPage);
  const dismissHint = workerPage.getByRole('button', { name: 'Dismiss' }).first();
  if (await dismissHint.isVisible().catch(() => false)) await dismissHint.click();
  const projectPicker = workerPage.locator('.project-wheel-trigger').first();
  await projectPicker.waitFor({ state: 'visible', timeout: 15_000 });
  await shot(workerPage, 'clock-start');

  await projectPicker.click();
  await shot(workerPage, 'clock-projects');
  await workerPage.locator('.project-wheel-option').filter({ hasText: primaryProject.name }).click();
  await shot(workerPage, 'clock-selected');
  await workerPage.getByRole('button', { name: /^Clock In$/ }).click();
  await workerPage.getByRole('button', { name: /Clock Out/i }).waitFor({ timeout: 15_000 });
  await shot(workerPage, 'clock-confirmed');
  await api(adminSession.apiBase, workerSession.token, '/clock/cancel', { method: 'DELETE' });
  await workerPage.close();

  await adminPage.evaluate(({ token }) => localStorage.setItem('tc_token', token), { token: adminSession.token });
  await adminPage.goto(`${baseUrl}/timeclock#wf-live`, { waitUntil: 'domcontentloaded' });
  await settle(adminPage);
  await shot(adminPage, 'live');

  await adminPage.getByRole('tab', { name: /Approvals/ }).click();
  const targetRow = adminPage.locator('.approval-row').filter({ hasText: workerName }).first();
  await targetRow.waitFor({ timeout: 15_000 });
  await shot(adminPage, 'approvals-top');
  await targetRow.scrollIntoViewIfNeeded();
  await adminPage.evaluate(() => window.scrollBy(0, 400));
  await shot(adminPage, 'approvals-scrolled');

  await targetRow.locator('.approval-expand').click();
  await shot(adminPage, 'details');
  await targetRow.getByRole('button', { name: /View location/i }).click();
  await targetRow.locator('.leaflet-container').waitFor({ state: 'visible' });
  await adminPage.waitForTimeout(1200);
  await shot(adminPage, 'location');
  await targetRow.getByRole('button', { name: /Hide map/i }).click();
  await shot(adminPage, 'location-closed');

  await targetRow.getByRole('button', { name: /Split/i }).click();
  await shot(adminPage, 'split');
  const timeInputs = targetRow.locator('input[type="time"]');
  const firstEndTime = timeInputs.nth(1);
  const firstEndTimeBox = await firstEndTime.boundingBox();
  if (!firstEndTimeBox) throw new Error('The first split end-time input is not visible.');
  await firstEndTime.click({
    position: { x: firstEndTimeBox.width * 0.38, y: firstEndTimeBox.height / 2 },
  });
  await shot(adminPage, 'split-time-selected');
  const typeEndTime = firstEndTime.pressSequentially('30', { delay: 650 });
  await adminPage.waitForTimeout(50);
  await shot(adminPage, 'split-time-typing');
  await typeEndTime;
  await shot(adminPage, 'split-time');
  const projectSelects = targetRow.locator('select');
  const secondProjectSelect = projectSelects.nth(1);
  await secondProjectSelect.click();
  await adminPage.waitForTimeout(500);
  await shot(adminPage, 'split-project-open');
  await secondProjectSelect.selectOption(String(secondProject.id));
  await adminPage.keyboard.press('Escape');
  await secondProjectSelect.evaluate(select => select.blur());
  await adminPage.waitForTimeout(100);
  await shot(adminPage, 'split-project');
  await targetRow.getByRole('button', { name: /Split.*Save/i }).click();
  await adminPage.locator('.approval-row').filter({ hasText: workerName }).nth(1).waitFor({ timeout: 15_000 });
  await shot(adminPage, 'split-saved');

  let rows = adminPage.locator('.approval-row').filter({ hasText: workerName });
  await rows.nth(0).getByRole('button', { name: /Approve/i }).click();
  await adminPage.waitForTimeout(800);
  await shot(adminPage, 'one-approved');
  rows = adminPage.locator('.approval-row').filter({ hasText: workerName });
  await rows.nth(0).getByRole('button', { name: /Approve/i }).click();
  await adminPage.waitForTimeout(800);
  await shot(adminPage, 'both-approved');

  await adminPage.evaluate(() => {
    localStorage.setItem('opsfloa_report_sections', JSON.stringify({
      workers: true,
      projects: true,
      overtime: true,
      export: true,
    }));
  });
  await adminPage.goto(`${baseUrl}/timeclock?capture=reports#wf-reports`, { waitUntil: 'domcontentloaded' });
  await settle(adminPage);
  await adminPage.getByRole('heading', { name: /^Reports$/ }).waitFor({ state: 'visible' });
  const teamReports = adminPage.getByRole('button', { name: /Team Member reports/i });
  await teamReports.scrollIntoViewIfNeeded();
  await adminPage.evaluate(() => window.scrollBy(0, -70));
  await shot(adminPage, 'reports-collapsed');

  const collapsedScrollTop = await adminPage.evaluate(() => window.scrollY);
  await teamReports.click();
  const reportWorkerRow = adminPage.locator('.member-report-row').filter({ hasText: workerName }).first();
  await reportWorkerRow.waitFor({ state: 'visible', timeout: 15_000 });
  await adminPage.evaluate(scrollTop => window.scrollTo(0, scrollTop), collapsedScrollTop);
  await shot(adminPage, 'reports-team-expanded');
  await adminPage.evaluate(() => window.scrollBy(0, 164));
  await shot(adminPage, 'reports-team-open');

  const teamScrollTop = await adminPage.evaluate(() => window.scrollY);
  await reportWorkerRow.click();
  const generateEntries = adminPage.getByRole('button', { name: /^Generate entries$/ });
  await generateEntries.waitFor({ state: 'visible', timeout: 15_000 });
  const lastTwoWeeks = adminPage.getByRole('button', { name: /^Last two weeks$/ });
  await lastTwoWeeks.click();
  await adminPage.waitForTimeout(900);
  await adminPage.evaluate(scrollTop => {
    window.scrollTo(0, scrollTop);
    document.body.style.paddingBottom = '300px';
  }, teamScrollTop);
  await shot(adminPage, 'reports-worker-expanded');
  await adminPage.evaluate(() => window.scrollBy(0, 272));
  await shot(adminPage, 'reports-worker-selected');

  const lastWeek = adminPage.getByRole('button', { name: /^Last week$/ });
  await lastWeek.click();
  await shot(adminPage, 'reports-last-week');

  await Promise.all([
    adminPage.waitForResponse(response => response.url().includes(`/api/admin/workers/${worker.id}/entries?`) && response.ok()),
    generateEntries.click(),
  ]);
  const detailsToggle = adminPage.getByText('Details', { exact: true });
  await detailsToggle.waitFor({ state: 'visible', timeout: 15_000 });
  await shot(adminPage, 'reports-generated');

  const overtimeBadge = adminPage.getByText(/^OT Hrs\s+/).first();
  await detailsToggle.click();
  await overtimeBadge.waitFor({ state: 'visible', timeout: 15_000 });
  await shot(adminPage, 'reports-details');

  const overtimeDateRow = overtimeBadge.locator('..');
  await overtimeDateRow.click();
  await adminPage.getByText(/overtime/i).last().waitFor({ state: 'visible', timeout: 15_000 });
  await shot(adminPage, 'reports-overtime-date');

  const previewBill = adminPage.getByRole('button', { name: /^Preview Bill$/ });
  await previewBill.scrollIntoViewIfNeeded();
  await adminPage.evaluate(() => window.scrollBy(0, 250));
  await shot(adminPage, 'reports-preview-ready');

  const previewScrollTop = await adminPage.evaluate(() => window.scrollY);
  await previewBill.click();
  const billPreview = adminPage.locator('iframe[title="Bill Preview"]');
  await billPreview.waitFor({ state: 'visible', timeout: 20_000 });
  await adminPage.waitForTimeout(2500);
  await adminPage.evaluate(scrollTop => window.scrollTo(0, scrollTop), previewScrollTop);
  await shot(adminPage, 'reports-bill-preview');
  await adminPage.evaluate(() => window.scrollBy(0, 520));
  await shot(adminPage, 'reports-bill-preview-full');

  await adminPage.getByRole('tab', { name: /^Payroll$/ }).click();
  const payrollCard = adminPage.getByRole('heading', { name: /Run payroll/i }).locator('..');
  await payrollCard.locator('option').filter({ hasText: payrollRulesetName }).first().waitFor({ state: 'attached', timeout: 15_000 });
  const runPayroll = payrollCard.getByRole('button', { name: /^Run$/ });
  await runPayroll.waitFor({ state: 'visible' });
  await payrollCard.locator('table').waitFor({ state: 'visible', timeout: 15_000 });
  await payrollCard.getByRole('button', { name: /custom date range/i }).click();
  await payrollCard.getByRole('button', { name: /scheduled pay periods/i }).click();
  await payrollCard.locator('table').waitFor({ state: 'hidden' });
  await payrollCard.scrollIntoViewIfNeeded();
  await adminPage.evaluate(() => window.scrollBy(0, -80));
  await shot(adminPage, 'payroll-ready');

  await Promise.all([
    adminPage.waitForResponse(response => response.url().includes('/api/admin/payroll-run?') && response.ok()),
    runPayroll.click(),
  ]);
  await payrollCard.locator('table').waitFor({ state: 'visible' });
  await adminPage.evaluate(() => window.scrollBy(0, 220));
  await shot(adminPage, 'payroll-results');
} finally {
  await context.close();
  await browser.close();
}
