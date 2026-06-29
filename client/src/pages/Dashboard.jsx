import React, { lazy, Suspense, useState, useEffect, useRef } from 'react';
import ErrorBoundary from '../components/ErrorBoundary';
import { useAuth } from '../contexts/AuthContext';
import ClockInOut from '../components/ClockInOut';
import TimeEntryForm from '../components/TimeEntryForm';
import EntryList from '../components/EntryList';
import UpcomingShifts from '../components/UpcomingShifts';
import CompanyChat from '../components/CompanyChat';
import AppHeader from '../components/AppHeader';
import { PageIntro } from '../components/PageShell';
import TabBar from '../components/TabBar';
import { getT } from '../i18n';
import { langToLocale } from '../utils';
import api from '../api';
import { getOrFetch, setCached } from '../offlineDb';
import { useOffline } from '../contexts/OfflineContext';
import OfflineBanner from '../components/OfflineBanner';
import SignatureModal from '../components/SignatureModal';
import { WorkforcePanel } from './AdminDashboard';
import { userCanSeeModule } from '../modulePermissions';

import { silentError } from '../errorReporter';
// Secondary tabs — lazy-loaded on first visit
const TimesheetView    = lazy(() => import('../components/TimesheetView'));
const WorkerSummary    = lazy(() => import('../components/WorkerSummary'));
const TimesheetSignOff = lazy(() => import('../components/TimesheetSignOff'));
const TimeOffTab       = lazy(() => import('../components/TimeOffTab'));
const AvailabilityTab  = lazy(() => import('../components/AvailabilityTab'));
const WorkerSchedule   = lazy(() => import('../components/WorkerSchedule'));
const ReimbursementsView = lazy(() => import('../components/ReimbursementsView'));

function TabLoader() {
  return <div className="ops-loading-state">Loading...</div>;
}

const TIME_TAB_ALIASES = {
  availability: 'schedule',
  expenses: 'reimbursements',
};

function normalizeTimeHash(rawHash) {
  const hash = String(rawHash || '').replace('#', '').trim().toLowerCase();
  return TIME_TAB_ALIASES[hash] || hash;
}

export default function Dashboard() {
  const { user } = useAuth();
  const { onSync } = useOffline() || {};
  const t = getT(user?.language);
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState(null);
  const [companyInfo, setCompanyInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [headerClock, setHeaderClock] = useState(null); // null=loading, false=not clocked in, {clock_in_time}=clocked in
  const [headerElapsed, setHeaderElapsed] = useState(0);
  const headerTimerRef = useRef(null);
  const [entriesVersion, setEntriesVersion] = useState(0);
  const TABS = ['clock', 'messages', 'timesheet', 'timeoff', 'schedule', 'reimbursements'];
  const rawHashTab = window.location.hash.replace('#', '');
  const hashTab = normalizeTimeHash(rawHashTab);
  // #availability is legacy — it used to be a top-level tab; now it opens the
  // Availability sub-tab inside Schedule. Anyone with a bookmarked link still
  // lands in the right place.
  const initialTab = TABS.includes(hashTab) ? hashTab : 'clock';
  const [tab, setTab] = useState(initialTab);
  const [scheduleSubtab, setScheduleSubtab] = useState(rawHashTab === 'availability' ? 'availability' : 'schedule');
  // Personal (own time clock) vs Workforce (admin oversight) groups. The group
  // row only appears for admins who can see both; everyone else just gets their
  // one group. Workforce tabs carry a '#wf-' hash. An oversight-only admin (can
  // see Workforce but not the personal clock) defaults to the Workforce group.
  const [group, setGroup] = useState(() => {
    if (window.location.hash.startsWith('#wf-')) return 'workforce';
    if (userCanSeeModule(user, 'timeclock')) return 'personal';
    return userCanSeeModule(user, 'workforce') ? 'workforce' : 'personal';
  });
  const [entryView, setEntryView] = useState('list');
  const [shiftPrefill, setShiftPrefill] = useState(null);
  const [chatUnread, setChatUnread] = useState(false);
  const workLabel = settings?.label_work || 'Project';

  const handleFillFromShift = shift => {
    setShiftPrefill(shift);
    setTab('clock');
  };

  const fetchData = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [entries, projects, settings, ci] = await Promise.all([
        getOrFetch('entries', () => api.get('/time-entries').then(r => r.data)),
        getOrFetch('projects', () => api.get('/projects').then(r => r.data)),
        getOrFetch('settings', () => api.get('/settings').then(r => r.data)),
        api.get('/company-info').then(r => r.data).catch(() => ({})),
      ]);
      setEntries(entries);
      setProjects(projects);
      setSettings(settings);
      setCompanyInfo(ci);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const refreshEntries = async () => {
    try {
      const data = await api.get('/time-entries').then(r => r.data);
      await setCached('entries', data);
      setEntries(data);
      setEntriesVersion(v => v + 1);
      setRefreshError(false);
    } catch {
      setRefreshError(true);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // Fetch clock status for header timer (independent of ClockInOut component)
  useEffect(() => {
    api.get('/clock/status').then(r => setHeaderClock(r.data || false)).catch(() => setHeaderClock(false));
  }, []);

  // Tick header elapsed timer while clocked in
  useEffect(() => {
    clearInterval(headerTimerRef.current);
    if (headerClock && headerClock.clock_in_time) {
      const tick = () => setHeaderElapsed(Math.floor((Date.now() - new Date(headerClock.clock_in_time)) / 1000));
      tick();
      headerTimerRef.current = setInterval(tick, 1000);
    } else {
      setHeaderElapsed(0);
    }
    return () => clearInterval(headerTimerRef.current);
  }, [headerClock]);

  // When timeclock feature is off, redirect away from clock-only tabs
  useEffect(() => {
    if (settings && settings.module_timeclock === false && ['clock', 'messages', 'timesheet'].includes(tab)) {
      setTab('timeoff');
      history.replaceState(null, '', '#timeoff');
    }
  }, [settings]);

  // Re-fetch entries after offline queue syncs
  useEffect(() => {
    if (!onSync) return;
    return onSync(count => { if (count > 0) refreshEntries(); });
  }, [onSync]);

  // Background chat unread check (only when not on messages tab)
  useEffect(() => {
    if (tab === 'messages') return;
    const check = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      api.get('/chat').then(r => {
        const lastRead = localStorage.getItem('chatLastRead');
        const hasUnread = r.data.some(
          m => m.sender_id !== user?.id && (!lastRead || new Date(m.created_at) > new Date(lastRead))
        );
        setChatUnread(hasUnread);
      }).catch(silentError('dashboard'));
    };
    check();
    const iv = setInterval(check, 60000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, [tab, user?.id]);

  const handleEntryAdded = entry => {
    setEntries(prev => [entry, ...prev]);
    setEntriesVersion(v => v + 1);
    setHeaderClock(false); // worker clocked out
  };

  const handleClockedIn = clockStatus => {
    setHeaderClock(clockStatus); // worker clocked in
  };
  const handleEntryDeleted = id => {
    setEntries(prev => prev.filter(e => e.id !== id));
    setEntriesVersion(v => v + 1);
  };
  const handleEntryUpdated = entry => {
    setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, ...entry } : e));
    setEntriesVersion(v => v + 1);
  };

  const handleExportPDF = (signatureDataUrl) => {
    const win = window.open('', '_blank');
    const workerName = user?.full_name || '';
    const workerEmail = user?.email || '';
    let sorted = [...entries].sort((a, b) => a.work_date.localeCompare(b.work_date));

    // Free plan: export is limited to the latest completed Mon–Sun week
    if (settings?.plan === 'free' && settings?.subscription_status !== 'trial') {
      const today = new Date();
      const dow = today.getDay();
      const lastSun = new Date(today); lastSun.setDate(today.getDate() - (dow === 0 ? 7 : dow));
      const lastMon = new Date(lastSun); lastMon.setDate(lastSun.getDate() - 6);
      const ws = lastMon.toLocaleDateString('en-CA');
      const we = lastSun.toLocaleDateString('en-CA');
      sorted = sorted.filter(e => { const d = String(e.work_date).substring(0, 10); return d >= ws && d <= we; });
    }

    const fmtTime = s => { const [h, m] = s.split(':'); const hr = parseInt(h); return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`; };
    const locale = langToLocale(user?.language);
    const fmtDate = d => new Date(d.substring(0, 10) + 'T00:00:00').toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const fmtDateShort = d => new Date(d.substring(0, 10) + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
    const fmtH = h => { const wh = Math.floor(h); const wm = Math.round((h - wh) * 60); return wm > 0 ? `${wh}h ${wm}m` : `${wh}h`; };
    const fmtMoney = v => `$${v.toFixed(2)}`;

    // Pay period
    const dates = sorted.map(e => e.work_date);
    const periodStart = dates.length ? fmtDateShort(dates[0]) : '—';
    const periodEnd = dates.length ? fmtDateShort(dates[dates.length - 1]) : '—';

    // Invoice metadata
    const now = new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const invoiceNo = `INV-${now.getFullYear()}${pad2(now.getMonth()+1)}${pad2(now.getDate())}-${String(Date.now()).slice(-5)}`;
    const invoiceDate = now.toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });

    // Company info (Bill To)
    const ci = companyInfo || {};
    const billToLines = [
      ci.name || user?.company_name || '',
      ci.address || '',
      ci.phone || '',
      ci.contact_email || '',
    ].filter(Boolean);

    // Feature flags
    const showProject = settings?.feature_project_integration !== false;
    const overtimeEnabled = settings?.feature_overtime !== false;

    // Rates
    const workerRate = parseFloat(user?.hourly_rate) || parseFloat(settings?.default_hourly_rate) || 0;
    const prevRate = parseFloat(settings?.prevailing_wage_rate) || 0;
    const showRateType = prevRate > 0;
    const otMultiplier = parseFloat(settings?.overtime_multiplier) || 1.5;
    const otRule = settings?.overtime_rule || 'daily';
    const otThreshold = parseFloat(settings?.overtime_threshold) || 8;

    // For weekly OT: track cumulative regular hours per ISO week
    const weeklyAccum = {};
    const getWeekKey = dateStr => {
      const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
      const day = d.getDay();
      const monday = new Date(d); monday.setDate(d.getDate() - ((day + 6) % 7));
      return monday.toLocaleDateString('en-CA');
    };

    // Build table rows + accumulate totals
    let regularHours = 0, overtimeHours = 0, prevailingHours = 0;
    let regularPay = 0, overtimePay = 0, prevailingPay = 0;

    const rows = sorted.map(e => {
      let ms = new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`);
      if (ms < 0) ms += 86400000;
      const h = Math.max(0, ms / 3600000 - (e.break_minutes || 0) / 60);
      const isPrev = e.wage_type === 'prevailing';

      if (isPrev) {
        prevailingHours += h;
        prevailingPay += h * prevRate;
      } else if (overtimeEnabled) {
        let regH = 0, otH = 0;
        if (otRule === 'daily') {
          regH = Math.min(h, otThreshold);
          otH = Math.max(0, h - otThreshold);
        } else {
          const wk = getWeekKey(e.work_date);
          const prior = weeklyAccum[wk] || 0;
          weeklyAccum[wk] = prior + h;
          if (prior >= otThreshold) { otH = h; }
          else if (prior + h > otThreshold) { regH = otThreshold - prior; otH = h - regH; }
          else { regH = h; }
        }
        regularHours += regH;
        overtimeHours += otH;
        regularPay += regH * workerRate;
        overtimePay += otH * workerRate * otMultiplier;
      } else {
        regularHours += h;
        regularPay += h * workerRate;
      }

      const badge = isPrev
        ? `<span style="background:#d97706;color:#fff;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700">${t.prevailing}</span>`
        : `<span style="background:#2563eb;color:#fff;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700">${t.regular}</span>`;
      return `<tr>
        <td>${fmtDate(e.work_date)}</td>
        ${showProject ? `<td>${e.project_name || '—'}</td>` : ''}
        <td style="color:#6b7280">${e.notes || ''}</td>
        <td>${fmtTime(e.start_time)}</td>
        <td>${fmtTime(e.end_time)}</td>
        ${showRateType ? `<td>${badge}</td>` : ''}
        <td style="text-align:right;font-weight:600">${fmtH(h)}</td>
      </tr>`;
    }).join('');

    const totalHours = regularHours + overtimeHours + prevailingHours;
    const totalPay = regularPay + overtimePay + prevailingPay;

    // Summary rows
    const sumRows = [
      regularHours > 0 ? `<tr><td>${t.regularHours}</td><td style="text-align:right">${fmtH(regularHours)}</td></tr>` : '',
      overtimeEnabled && overtimeHours > 0 ? `<tr><td>${t.overtimeHours}</td><td style="text-align:right">${fmtH(overtimeHours)}</td></tr>` : '',
      prevailingHours > 0 ? `<tr><td>${t.prevailingHours}</td><td style="text-align:right">${fmtH(prevailingHours)}</td></tr>` : '',
      `<tr style="border-top:1px solid #e5e7eb;font-weight:600"><td>${t.totalHours}</td><td style="text-align:right">${fmtH(totalHours)}</td></tr>`,
      workerRate > 0 && regularHours > 0 ? `<tr><td>${t.regularPay} (${fmtMoney(workerRate)}/hr)</td><td style="text-align:right">${fmtMoney(regularPay)}</td></tr>` : '',
      overtimeEnabled && overtimeHours > 0 && workerRate > 0 ? `<tr><td>${t.overtimePay} (${otMultiplier}×)</td><td style="text-align:right">${fmtMoney(overtimePay)}</td></tr>` : '',
      prevRate > 0 && prevailingHours > 0 ? `<tr><td>${t.prevailingPay} (${fmtMoney(prevRate)}/hr)</td><td style="text-align:right">${fmtMoney(prevailingPay)}</td></tr>` : '',
    ].filter(Boolean).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice — ${workerName}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;color:#111;font-size:13px;padding:40px;background:#fff}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px}
.brand{font-size:22px;font-weight:800;color:var(--ops-page-accent)}
.brand-sub{font-size:12px;color:#6b7280;margin-top:2px}
.inv-title{font-size:32px;font-weight:800;color:#111;text-align:right}
.inv-meta{text-align:right;margin-top:6px;line-height:1.8;font-size:13px;color:#6b7280}
.inv-meta strong{color:#111;margin-left:6px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:28px;padding-bottom:24px;border-bottom:2px solid #e5e7eb}
.party-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:8px}
.party-name{font-size:15px;font-weight:700;color:#111;margin-bottom:4px}
.party-detail{font-size:12px;color:#6b7280;line-height:1.7}
.period-bar{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 16px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
.period-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#3b82f6}
.period-val{font-size:14px;font-weight:700;color:#1d4ed8}
table{width:100%;border-collapse:collapse;margin-bottom:28px}
th{background:#f9fafb;padding:9px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:2px solid #e5e7eb}
td{padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151;vertical-align:middle}
tr:last-child td{border-bottom:none}
.summary-wrap{display:grid;grid-template-columns:1fr 320px;gap:32px;margin-bottom:24px}
.thank-you{font-size:12px;color:#6b7280;line-height:1.8;padding-top:8px}
.sum-table{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px}
.sum-table tr td{padding:9px 14px;border-bottom:1px solid #f3f4f6}
.sum-table tr:last-child td{border-bottom:none}
.total-row{background:var(--ops-page-accent);color:#fff!important;font-weight:700;font-size:14px}
.total-row td{color:#fff!important;padding:11px 14px}
.footer{border-top:1px solid #e5e7eb;padding-top:14px;display:flex;justify-content:space-between;font-size:11px;color:#9ca3af}
@media print{body{padding:20px}}
</style></head><body>

<div class="header">
  <div>
    <div class="brand">Ops Flow Assist</div>
    <div class="brand-sub">${t.employeeTimeInvoice}</div>
  </div>
  <div>
    <div class="inv-title">${t.invoiceLabel}</div>
    <div class="inv-meta">
      ${t.pdfInvoiceNo}<strong>${invoiceNo}</strong><br>
      ${t.pdfInvoiceDate}<strong>${invoiceDate}</strong>
    </div>
  </div>
</div>

<div class="parties">
  <div>
    <div class="party-label">${t.from}</div>
    <div class="party-name">${workerName}</div>
    <div class="party-detail">${workerEmail}</div>
  </div>
  <div>
    <div class="party-label">${t.billTo}</div>
    <div class="party-detail">${billToLines.map((l, i) => i === 0 ? `<span class="party-name">${l}</span>` : l).join('<br>')}</div>
  </div>
</div>

<div class="period-bar">
  <span class="period-label">${t.payPeriod}</span>
  <span class="period-val">${periodStart} – ${periodEnd}</span>
</div>

<table>
  <thead><tr>
    <th>${t.date}</th>${showProject ? `<th>${workLabel}</th>` : ''}<th>${t.descriptionLabel}</th><th>${t.clockIn}</th><th>${t.clockOut}</th>${showRateType ? `<th>${t.rateTypeLabel}</th>` : ''}<th style="text-align:right">${t.hours}</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="summary-wrap">
  <div class="thank-you">
    ${t.thankYouInvoice}
  </div>
  <div class="sum-table">
    <table style="width:100%;border-collapse:collapse">
      ${sumRows}
      <tr class="total-row"><td>${t.totalDue}</td><td style="text-align:right">${totalPay > 0 ? fmtMoney(totalPay) : '—'}</td></tr>
    </table>
  </div>
</div>

${signatureDataUrl ? `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end">
  <div style="text-align:center">
    <img src="${signatureDataUrl}" style="height:60px;display:block;margin-bottom:4px" />
    <div style="font-size:11px;color:#9ca3af;border-top:1px solid #d1d5db;padding-top:4px;min-width:200px">${workerName} — ${t.pdfDigitalSignature}</div>
  </div>
</div>` : ''}

<div class="footer">
  <span>${t.pdfGeneratedBy}</span>
  <span>${invoiceDate}</span>
</div>

</body></html>`;

    win.document.write(html);
    win.document.close();
    win.print();
  };

  const fmtHeaderElapsed = secs => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const switchTab = nextTab => {
    setTab(nextTab);
    history.replaceState(null, '', `#${nextTab}`);
    if (nextTab === 'messages') {
      setChatUnread(false);
      localStorage.setItem('chatLastRead', new Date().toISOString());
    }
  };

  useEffect(() => {
    const syncGroupFromHash = () => {
      const rawHash = window.location.hash || '';
      if (rawHash.startsWith('#wf-')) {
        setGroup('workforce');
      } else if (userCanSeeModule(user, 'timeclock')) {
        setGroup('personal');
        const nextTab = normalizeTimeHash(rawHash);
        if (TABS.includes(nextTab)) {
          setTab(nextTab);
          setScheduleSubtab(rawHash.replace('#', '') === 'availability' ? 'availability' : 'schedule');
        }
      }
    };
    syncGroupFromHash();
    window.addEventListener('hashchange', syncGroupFromHash);
    return () => window.removeEventListener('hashchange', syncGroupFromHash);
  }, [user]);

  const timeTabs = [
    ...(settings?.module_timeclock !== false ? [
      { id: 'clock', label: t.tabClock },
      { id: 'messages', label: t.tabMessages, dot: chatUnread ? '#ef4444' : null },
      { id: 'timesheet', label: t.tabTimesheet },
    ] : []),
    ...(settings?.feature_pto !== false ? [{ id: 'timeoff', label: t.tabTimeOff }] : []),
    ...(settings?.feature_scheduling !== false ? [{ id: 'schedule', label: t.tabSchedule }] : []),
    ...(settings?.feature_reimbursements !== false ? [{ id: 'reimbursements', label: t.tabExpenses }] : []),
  ];

  // Workforce (oversight) is a second group within this module. Visibility is
  // permission-based, not role-based: anyone holding workforce perms can see it
  // (including a custom non-admin role granted approve_entries, etc.). The
  // Personal/Workforce switcher only appears when the user has BOTH halves; an
  // oversight-only user (no personal clock perms) goes straight to Workforce, so
  // removing the personal time perms never strands them without Workforce.
  const hasPersonal = userCanSeeModule(user, 'timeclock');
  const hasWorkforce = settings?.module_timeclock !== false && userCanSeeModule(user, 'workforce');
  const showGroupRow = hasPersonal && hasWorkforce;
  const effectiveGroup = showGroupRow ? group : (hasWorkforce && !hasPersonal ? 'workforce' : 'personal');
  const switchGroup = g => {
    setGroup(g);
    if (g === 'personal') history.replaceState(null, '', `#${tab}`);
    else history.replaceState(null, '', '#wf-live');
  };

  return (
    <div style={styles.page}>
      <OfflineBanner />
      <AppHeader
        currentApp="timeclock"
        features={settings}
        rightExtras={headerClock && <span style={styles.headerTimer} className="header-clock-timer-desktop">Live {fmtHeaderElapsed(headerElapsed)}</span>}
        companyBandExtras={headerClock && <span className="header-clock-timer-mobile" style={styles.headerTimerMobile}>Live {fmtHeaderElapsed(headerElapsed)}</span>}
      />

      {showSignatureModal && (
        <SignatureModal
          onConfirm={sig => { setShowSignatureModal(false); handleExportPDF(sig); }}
          onCancel={() => setShowSignatureModal(false)}
          required={(settings?.invoice_signature ?? 'optional') === 'required'}
        />
      )}

      <main id="main-content" style={{ ...styles.main, ...(effectiveGroup === 'workforce' ? { maxWidth: 900 } : {}) }} className="mobile-main">
        {showGroupRow && (
          <div className="ops-workflow-tabs" role="tablist" aria-label="Time Clock sections">
            <button type="button" role="tab" aria-selected={effectiveGroup === 'personal'}
              className={`ops-workflow-tab ${effectiveGroup === 'personal' ? 'is-active' : ''}`.trim()}
              onClick={() => switchGroup('personal')}>{t.timeGroupPersonal}</button>
            <button type="button" role="tab" aria-selected={effectiveGroup === 'workforce'}
              className={`ops-workflow-tab ${effectiveGroup === 'workforce' ? 'is-active' : ''}`.trim()}
              onClick={() => switchGroup('workforce')}>{t.timeGroupWorkforce}</button>
          </div>
        )}
        {effectiveGroup === 'workforce' ? (
          <WorkforcePanel />
        ) : (
        <>
        <PageIntro
          introId="timeclock"
          kicker="Today"
          title={`Keep the day simple${user?.full_name ? `, ${user.full_name.split(' ')[0]}` : ''}.`}
          description="The daily actions are first. Timesheets, schedule, time off, and expenses stay close without crowding the clock-in flow."
          meta={headerClock ? <span className="ops-pill good">Clocked in</span> : <span className="ops-pill">Ready</span>}
        />
        <TabBar active={tab} onChange={switchTab} tabs={timeTabs} breakpoint={720} />

        {tab === 'messages' && <CompanyChat settings={settings} onRead={() => { setChatUnread(false); localStorage.setItem('chatLastRead', new Date().toISOString()); }} />}

        {tab === 'clock' && (
          loading ? <TabLoader /> : (
            <>
              <ClockInOut projects={projects} onEntryAdded={handleEntryAdded} onClockedIn={handleClockedIn} t={t} geolocationEnabled={settings?.feature_geolocation ?? false} projectsEnabled={settings?.feature_project_integration !== false} workLabel={workLabel} />
              <TimeEntryForm projects={projects} onEntryAdded={handleEntryAdded} t={t} prefill={shiftPrefill} projectsEnabled={settings?.feature_project_integration !== false} workLabel={workLabel} />
            </>
          )
        )}

        {tab === 'timesheet' && (
          <ErrorBoundary key="timesheet" mode="inline" label="Timesheet">
          <Suspense fallback={<TabLoader />}>
            <UpcomingShifts onFillEntry={handleFillFromShift} workLabel={workLabel} />
            {!loading && <WorkerSummary entries={entries} hourlyRate={user?.hourly_rate} rateType={user?.rate_type ?? 'hourly'} overtimeMultiplier={settings?.overtime_multiplier ?? 1.5} prevailingRate={settings?.prevailing_wage_rate ?? 0} overtimeEnabled={settings?.feature_overtime ?? true} overtimeRule={settings?.overtime_rule ?? 'daily'} overtimeThreshold={settings?.overtime_threshold ?? 8} weekStart={settings?.week_start ?? 1} showWages={settings?.show_worker_wages ?? false} currency={settings?.currency ?? 'USD'} />}
            <TimesheetSignOff t={t} refreshKey={entriesVersion} />
            <div style={styles.timesheetToolbar}>
              <div style={styles.viewToggle}>
                <button style={entryView === 'timesheet' ? styles.toggleActive : styles.toggleBtn} onClick={() => setEntryView('timesheet')}>{t.timesheetView}</button>
                <button style={entryView === 'list' ? styles.toggleActive : styles.toggleBtn} onClick={() => setEntryView('list')}>{t.listView}</button>
              </div>
              {!loading && entries.length > 0 && (
                <button style={styles.exportBtn} onClick={() => {
                  if ((settings?.invoice_signature ?? 'optional') === 'none') handleExportPDF(null);
                  else setShowSignatureModal(true);
                }}>{t.exportPDF}</button>
              )}
            </div>
            {refreshError && <p style={{ color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', fontSize: 13, margin: '0 0 8px' }}>{t.loadError} <button onClick={() => { setRefreshError(false); refreshEntries(); }} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#b45309' }}>{t.retry}</button></p>}
            {loadError ? <p style={{ color: '#dc2626', padding: '12px' }}>{t.loadError} <button onClick={fetchData} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' }}>{t.retry}</button></p> : loading ? <p>{t.loadingEntries}</p> : entryView === 'timesheet' ? (
              <TimesheetView entries={entries} language={user?.language} projects={projects} onRefresh={refreshEntries} weekStart={settings?.week_start ?? 1} />
            ) : (
              <EntryList entries={entries} onDeleted={handleEntryDeleted} onUpdated={handleEntryUpdated} t={t} language={user?.language} currentUserId={user?.id} projects={projects} onRefresh={refreshEntries} workLabel={workLabel} />
            )}
          </Suspense>
          </ErrorBoundary>
        )}

        {tab === 'timeoff' && settings?.feature_pto !== false && <ErrorBoundary key="timeoff" mode="inline" label="Time Off"><Suspense fallback={<TabLoader />}><TimeOffTab /></Suspense></ErrorBoundary>}

        {tab === 'schedule' && (
          <div>
            <TabBar
              active={scheduleSubtab}
              onChange={next => {
                setScheduleSubtab(next);
                history.replaceState(null, '', next === 'availability' ? '#availability' : '#schedule');
              }}
              tabs={[
                { id: 'schedule', label: t.tabSchedule },
                { id: 'availability', label: t.tabAvailability },
              ]}
              breakpoint={420}
            />
            {scheduleSubtab === 'schedule' && (
              <Suspense fallback={<TabLoader />}><WorkerSchedule /></Suspense>
            )}
            {scheduleSubtab === 'availability' && (
              <ErrorBoundary key="availability" mode="inline" label="Availability">
                <Suspense fallback={<TabLoader />}><AvailabilityTab /></Suspense>
              </ErrorBoundary>
            )}
          </div>
        )}

        {tab === 'reimbursements' && settings?.feature_reimbursements !== false && <Suspense fallback={<TabLoader />}><ReimbursementsView settings={settings} /></Suspense>}
        </>
        )}
      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', '--ops-page-accent': '#2563eb' },
  header: { background: 'var(--ops-page-accent)', color: '#fff', padding: '0 24px', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 0, minHeight: 'calc(56px + env(safe-area-inset-top))', display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'sticky', top: 0, zIndex: 100 },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 56 },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  logo: { fontWeight: 700, fontSize: 20 },
  companyName: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  userName: { fontSize: 14 },
  langSelect: { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '5px 8px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  headerBtn: { background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  headerTimer: { fontSize: 13, fontWeight: 800, color: '#0f766e', background: '#ecfdf5', border: '1px solid #bbf7d0', padding: '4px 10px', borderRadius: 7, fontVariantNumeric: 'tabular-nums' },
  headerTimerMobile: { fontSize: 12, fontWeight: 800, color: '#0f766e', fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  main: { maxWidth: 760, margin: '16px auto 24px', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 14 },
  tabs: { display: 'flex', gap: 4, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 10, padding: 4, width: '100%' },
  tab: { flex: 1, padding: '12px 0', background: 'none', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14, color: '#64748b', cursor: 'pointer', textAlign: 'center' },
  tabActive: { flex: 1, padding: '12px 0', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 7, fontWeight: 800, fontSize: 14, color: 'var(--ops-page-accent)', cursor: 'pointer', boxShadow: '0 1px 4px rgba(15,23,42,0.06)', textAlign: 'center', position: 'relative' },
  subtabBar: { display: 'flex', gap: 6, background: '#f1f5f9', border: '1px solid #e2e8f0', padding: 4, borderRadius: 10, marginBottom: 16 },
  subtab: { flex: 1, padding: '9px 0', background: 'none', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, color: '#64748b', cursor: 'pointer' },
  subtabActive: { flex: 1, padding: '9px 0', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 7, fontWeight: 800, fontSize: 13, color: 'var(--ops-page-accent)', cursor: 'pointer', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' },
  unreadDot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#ef4444', marginLeft: 4, verticalAlign: 'middle', flexShrink: 0 },
  timesheetToolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  viewToggle: { display: 'flex', gap: 4, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: 3, width: 'fit-content' },
  exportBtn: { background: 'none', border: '1px solid #d1d5db', color: '#374151', padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  toggleBtn: { padding: '6px 14px', background: 'none', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13, color: '#64748b', cursor: 'pointer' },
  toggleActive: { padding: '6px 14px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, fontWeight: 800, fontSize: 13, color: 'var(--ops-page-accent)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(15,23,42,0.08)' },
};
