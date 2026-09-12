import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'public', 'captures');
const captureWorkDir = resolve(root, 'renders', 'capture-work');
const baseUrl = process.env.OPSFLOA_CAPTURE_URL || 'https://stage.opsfloa.com';
const browserCandidates = [
  process.env.REMOTION_BROWSER_EXECUTABLE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const browserExecutable = browserCandidates.find(candidate => existsSync(candidate));

if (!browserExecutable) {
  throw new Error('No Chrome-compatible browser found. Set REMOTION_BROWSER_EXECUTABLE.');
}

mkdirSync(outputDir, { recursive: true });
mkdirSync(captureWorkDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: browserExecutable,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();

async function settle() {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function capture(name, path, { scrollY = 0 } = {}) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  await settle();
  if (scrollY) {
    await page.evaluate(y => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(500);
  }
  const output = resolve(outputDir, `${name}.png`);
  await page.screenshot({ path: output, fullPage: false });
  console.log(`Captured ${name}: ${page.url()}`);
}

async function createDemoPlan() {
  const planPath = resolve(captureWorkDir, 'demo-site-plan.png');
  const planPage = await context.newPage();
  await planPage.setViewportSize({ width: 1440, height: 900 });
  await planPage.setContent(`<!doctype html>
    <html><head><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 1440px; height: 900px; overflow: hidden; background: #f8fafc; }
      svg { display: block; width: 1440px; height: 900px; font-family: Arial, sans-serif; }
      .fine { stroke: #94a3b8; stroke-width: 2; fill: none; }
      .contour { stroke: #9a6b35; stroke-width: 3; fill: none; }
      .boundary { stroke: #172554; stroke-width: 5; fill: rgba(59,130,246,.05); }
      .utility { stroke: #dc2626; stroke-width: 3; stroke-dasharray: 14 10; fill: none; }
      .label { fill: #172554; font-size: 18px; font-weight: 700; }
      .small { fill: #475569; font-size: 14px; }
    </style></head><body>
      <svg viewBox="0 0 1440 900" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#dbe4ee" stroke-width="1"/>
          </pattern>
          <pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <line x1="0" y1="0" x2="0" y2="12" stroke="#93c5fd" stroke-width="3"/>
          </pattern>
        </defs>
        <rect width="1440" height="900" fill="#fbfdff"/>
        <rect x="35" y="35" width="1370" height="830" fill="url(#grid)" stroke="#172554" stroke-width="3"/>
        <path class="boundary" d="M175 170 L1120 120 L1270 665 L960 790 L240 730 Z"/>
        <path d="M60 750 C350 650 720 650 1380 520" stroke="#64748b" stroke-width="34" fill="none" opacity=".35"/>
        <path d="M65 744 C420 655 840 620 1375 527" stroke="#475569" stroke-width="3" fill="none"/>
        <path d="M65 760 C420 671 840 636 1375 543" stroke="#475569" stroke-width="3" fill="none"/>
        <path class="contour" d="M80 260 C340 120 690 190 980 310 S1310 390 1380 320"/>
        <path class="contour" d="M70 325 C330 195 660 250 945 360 S1260 450 1385 385"/>
        <path class="contour" d="M65 395 C350 275 650 315 905 420 S1240 505 1380 450"/>
        <path class="contour" d="M70 470 C335 360 620 375 855 480 S1185 570 1380 520"/>
        <rect x="425" y="265" width="470" height="265" rx="4" fill="url(#hatch)" stroke="#2563eb" stroke-width="4"/>
        <rect x="500" y="320" width="320" height="155" fill="#ffffff" stroke="#172554" stroke-width="4"/>
        <path class="utility" d="M215 610 L410 520 L900 445 L1180 255"/>
        <circle cx="410" cy="520" r="11" fill="#fff" stroke="#dc2626" stroke-width="4"/>
        <circle cx="900" cy="445" r="11" fill="#fff" stroke="#dc2626" stroke-width="4"/>
        <text x="500" y="305" class="label">PROPOSED BUILDING PAD</text>
        <text x="585" y="405" class="label">OFFICE / WAREHOUSE</text>
        <text x="585" y="432" class="small">FFE 102.50</text>
        <text x="1030" y="292" class="small">102</text>
        <text x="1050" y="352" class="small">101</text>
        <text x="1080" y="420" class="small">100</text>
        <text x="1100" y="486" class="small">99</text>
        <text x="270" y="586" fill="#dc2626" font-size="15" font-weight="700">PROPOSED STORM</text>
        <text x="95" y="95" class="label">CIVIL SITE PLAN - GRADING & DRAINAGE</text>
        <text x="95" y="120" class="small">Demo Operations | Cedar Learning Center Rollout | C-201</text>
        <g transform="translate(1080 690)">
          <rect width="280" height="130" fill="#fff" stroke="#172554" stroke-width="2"/>
          <text x="18" y="30" class="label">CEDAR LEARNING CENTER</text>
          <text x="18" y="56" class="small">GRADING PLAN</text>
          <text x="18" y="82" class="small">SCALE: 1\" = 20'-0\"</text>
          <text x="18" y="108" class="small">SHEET C-201</text>
        </g>
      </svg>
    </body></html>`);
  await planPage.screenshot({ path: planPath });
  await planPage.close();
  return planPath;
}

async function capturePlanRoom(planPath) {
  await page.goto(`${baseUrl}/tool-apps/planroom/index.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('#filePlans').setInputFiles(planPath);
  await page.locator('#tradeSel').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#tradeSel').selectOption('dirt');
  await page.waitForTimeout(4000);
  const output = resolve(outputDir, 'plan-room.png');
  await page.screenshot({ path: output, fullPage: false });
  console.log(`Captured plan-room: ${page.url()}`);
}

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#company').fill('Demo Operations');
  await page.locator('#username').fill(process.env.OPSFLOA_CAPTURE_USERNAME || 'Admin');
  await page.locator('#login-password').fill(process.env.OPSFLOA_CAPTURE_PASSWORD || 'Admin123');
  await Promise.all([
    page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15_000 }),
    page.getByRole('button', { name: 'Sign In' }).click(),
  ]);

  const demoPlanPath = await createDemoPlan();

  await capture('timeclock', '/timeclock');
  await capture('workforce-live', '/timeclock#wf-live');
  await capture('workforce-approvals', '/timeclock#wf-approvals');
  await capture('workforce-payroll', '/timeclock#wf-payroll');
  await capturePlanRoom(demoPlanPath);
  await capture('projects', '/work');
  await capture('estimates', '/work#estimates');
  await capture('change-orders', '/work#change_orders');
  await capture('invoices', '/work#invoices');
  await capture('performance', '/financial-reports#performance');
} finally {
  await context.close();
  await browser.close();
}
