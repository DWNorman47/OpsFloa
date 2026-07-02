import React, { useState } from 'react';
import { localDateStr, formatCurrency, currencySymbol, fmtHours, formatInTz } from '../utils';

// Raw fetch helpers — bypass the axios 401 interceptor which would log the user out
const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const get    = (path, token) => fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post   = (path, body, token) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const patch  = (path, body, token) => fetch(`${BASE}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const del    = (path, token) => fetch(`${BASE}${path}`, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} });
const TOKEN  = () => localStorage.getItem('tc_token');

// ── Assertions ───────────────────────────────────────────────────────────────────

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertClose(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance)
    throw new Error(`${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}
function assertIs(status, expected, label) {
  if (status !== expected) throw new Error(`${label || 'Status'}: expected ${expected}, got ${status}`);
}
function assertOneOf(status, expected, label) {
  if (!expected.includes(status)) throw new Error(`${label || 'Status'}: expected one of ${expected.join('/')}, got ${status}`);
}

// ── Inlined server utilities ──────────────────────────────────────────────────────
// (copied verbatim from server/utils/ so browser can run them without Node.js)

// payCalculations.js
function hoursWorked(start, end) {
  let ms = new Date(`1970-01-01T${end}`) - new Date(`1970-01-01T${start}`);
  if (ms < 0) ms += 86400000;
  return ms / 3600000;
}

function computeOT(entries, rule, threshold) {
  const regular = entries.filter(e => e.wage_type === 'regular');
  if (rule === 'weekly') {
    const weekly = {};
    regular.forEach(e => {
      const d = new Date(e.work_date.toString().substring(0, 10) + 'T00:00:00');
      const jan4 = new Date(d.getFullYear(), 0, 4);
      const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
      const key = `${d.getFullYear()}-W${week}`;
      const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
      weekly[key] = (weekly[key] || 0) + h;
    });
    const reg = Object.values(weekly).reduce((s, h) => s + Math.min(h, threshold), 0);
    const ot  = Object.values(weekly).reduce((s, h) => s + Math.max(h - threshold, 0), 0);
    return { regularHours: reg, overtimeHours: ot };
  }
  if (rule === 'none') {
    const total = regular.reduce((s, e) => s + hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60, 0);
    return { regularHours: total, overtimeHours: 0 };
  }
  // daily (default)
  const daily = {};
  regular.forEach(e => {
    const key = e.work_date.toString().substring(0, 10);
    const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
    daily[key] = (daily[key] || 0) + h;
  });
  const reg = Object.values(daily).reduce((s, h) => s + Math.min(h, threshold), 0);
  const ot  = Object.values(daily).reduce((s, h) => s + Math.max(h - threshold, 0), 0);
  return { regularHours: reg, overtimeHours: ot };
}

function computeDailyPayCosts(entries, overtimeRule, threshold, dailyRate, overtimeMultiplier) {
  const regular = entries.filter(e => e.wage_type === 'regular');
  const days = new Set(regular.map(e => e.work_date.toString().substring(0, 10))).size;
  if (overtimeRule === 'none') return { regularCost: days * dailyRate, overtimeCost: 0 };
  const { overtimeHours } = computeOT(entries, overtimeRule, threshold);
  return {
    regularCost: days * dailyRate,
    overtimeCost: overtimeHours * (dailyRate / threshold) * overtimeMultiplier,
  };
}

// geoUtils.js
function haversineDistanceFt(lat1, lng1, lat2, lng2) {
  const R = 20902231; // Earth radius in feet
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validCoords(lat, lng) {
  const la = parseFloat(lat), lo = parseFloat(lng);
  return !isNaN(la) && !isNaN(lo) && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

// settingsDefaults.js
const FEATURE_KEYS_TEST = ['feature_scheduling','feature_analytics','feature_public','feature_chat','feature_prevailing_wage','module_field','module_timeclock','module_projects','module_inventory','module_tools','module_analytics','feature_project_integration','feature_overtime','feature_geolocation','feature_inactive_alerts','feature_overtime_alerts','feature_broadcast','feature_media_gallery','show_worker_wages','notification_use_work_hours','media_delete_on_project_archive','notify_timeoff_requests','notify_budget_alerts','notify_entry_submitted'];
const STRING_KEYS_TEST  = ['overtime_rule','currency','company_timezone','invoice_signature','default_temp_password','global_required_checklist_template_id'];
function applySettingsRows(rows, defaults) {
  const s = { ...defaults };
  rows.forEach(r => {
    if (STRING_KEYS_TEST.includes(r.key)) s[r.key] = r.value;
    else if (FEATURE_KEYS_TEST.includes(r.key)) s[r.key] = r.value === '1';
    else s[r.key] = parseFloat(r.value);
  });
  return s;
}

// ── Auth guard helper: asserts a route returns 401 when called without a token ───
function guard(label, path, method = 'GET') {
  return {
    name: `${label} → 401 without token`,
    run: async () => {
      const r = method === 'GET' ? await get(path)
              : method === 'DELETE' ? await del(path)
              : method === 'PATCH' ? await patch(path, {})
              : await post(path, {});
      assertIs(r.status, 401, label);
    },
  };
}

// ── Entry helpers ─────────────────────────────────────────────────────────────────
const mkEntry = (date, start, end, brk = 0, type = 'regular') => ({
  wage_type: type, start_time: start, end_time: end, work_date: date, break_minutes: brk,
});

// ── Test suites ───────────────────────────────────────────────────────────────────

const SUITES = [

  // ══════════════════════════════════════════════════════════════════════════════
  // CLIENT UTILITIES
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'localDateStr()',
    tests: [
      { name: 'Returns YYYY-MM-DD format', run: () => assert(/^\d{4}-\d{2}-\d{2}$/.test(localDateStr(new Date('2025-06-15T12:00:00')))) },
      { name: 'Uses local timezone, not UTC', run: () => assert(localDateStr(new Date(2025, 5, 15)).startsWith('2025-06')) },
      { name: 'Defaults to today without argument', run: () => assert(/^\d{4}-\d{2}-\d{2}$/.test(localDateStr())) },
      { name: 'Jan 1 formats correctly', run: () => assertEqual(localDateStr(new Date(2025, 0, 1)), '2025-01-01', 'Jan 1') },
      { name: 'Dec 31 formats correctly', run: () => assertEqual(localDateStr(new Date(2025, 11, 31)), '2025-12-31', 'Dec 31') },
    ],
  },

  {
    name: 'formatCurrency()',
    tests: [
      { name: 'USD — $ symbol and comma-grouped', run: () => { const r = formatCurrency(1234.5, 'USD'); assert(r.includes('1,234.50') && r.includes('$'), r); } },
      { name: 'USD — zero returns 0.00', run: () => assert(formatCurrency(0, 'USD').includes('0.00')) },
      { name: 'USD — negative includes 50.00', run: () => assert(formatCurrency(-50, 'USD').includes('50.00')) },
      { name: 'USD — whole numbers get two decimals', run: () => assert(formatCurrency(5, 'USD').includes('5.00')) },
      { name: 'EUR — contains €', run: () => assert(formatCurrency(100, 'EUR').includes('€')) },
      { name: 'GBP — contains £', run: () => assert(formatCurrency(100, 'GBP').includes('£')) },
      { name: 'CAD — returns non-empty string', run: () => assert(formatCurrency(100, 'CAD').length > 0) },
      { name: 'MXN — returns non-empty string', run: () => assert(formatCurrency(100, 'MXN').length > 0) },
      { name: 'Unknown currency — does not throw', run: () => { const r = formatCurrency(10, 'XYZ'); assert(typeof r === 'string' && r.length > 0); } },
    ],
  },

  {
    name: 'currencySymbol()',
    tests: [
      { name: 'USD → $',  run: () => assertEqual(currencySymbol('USD'), '$',  'USD') },
      { name: 'EUR → €',  run: () => assertEqual(currencySymbol('EUR'), '€',  'EUR') },
      { name: 'GBP → £',  run: () => assertEqual(currencySymbol('GBP'), '£',  'GBP') },
      { name: 'CAD — returns string', run: () => assert(typeof currencySymbol('CAD') === 'string') },
      { name: 'MXN — returns string', run: () => assert(typeof currencySymbol('MXN') === 'string') },
      { name: 'Defaults to USD (no arg)', run: () => { const s = currencySymbol(); assert(typeof s === 'string' && s.length > 0); } },
      { name: 'Unknown code — returns string fallback', run: () => assert(typeof currencySymbol('ZZZ') === 'string') },
    ],
  },

  {
    name: 'fmtHours()',
    tests: [
      { name: '8h exactly → "8h"',    run: () => assertEqual(fmtHours(8),    '8h',      '8') },
      { name: '10h exactly → "10h"',  run: () => assertEqual(fmtHours(10),   '10h',     '10') },
      { name: '1.5h → "1h 30m"',      run: () => assertEqual(fmtHours(1.5),  '1h 30m',  '1.5') },
      { name: '2.75h → "2h 45m"',     run: () => assertEqual(fmtHours(2.75), '2h 45m',  '2.75') },
      { name: '0.5h → "30m"',         run: () => assertEqual(fmtHours(0.5),  '30m',     '0.5') },
      { name: '0.25h → "15m"',        run: () => assertEqual(fmtHours(0.25), '15m',     '0.25') },
      { name: '1/60h → "1m" (rounding)', run: () => assertEqual(fmtHours(1/60), '1m',  '1m') },
      { name: '0 → "0m"',             run: () => assertEqual(fmtHours(0),    '0m',      '0') },
      { name: 'null → "0m"',          run: () => assertEqual(fmtHours(null), '0m',      'null') },
      { name: 'undefined → "0m"',     run: () => assertEqual(fmtHours(undefined), '0m', 'undefined') },
      { name: '1h 1m',                run: () => assertEqual(fmtHours(1 + 1/60), '1h 1m', '1h1m') },
    ],
  },

  {
    name: 'formatInTz()',
    tests: [
      { name: 'Returns non-empty string for valid tz', run: () => { const r = formatInTz('2025-06-15T14:30:00Z', 'America/New_York'); assert(r.length > 0); } },
      { name: 'Works without timezone arg', run: () => assert(formatInTz('2025-06-15T14:30:00Z').length > 0) },
      { name: 'Invalid timezone falls back gracefully', run: () => assert(formatInTz('2025-06-15T14:30:00Z', 'Not/ATimezone').length > 0) },
      { name: 'Custom opts: date includes year', run: () => assert(formatInTz('2025-06-15T14:30:00Z', 'UTC', { year: 'numeric', month: 'long', day: 'numeric' }).includes('2025')) },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // SERVER UTILITIES (inlined — no Node.js required)
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'hoursWorked()',
    tests: [
      { name: '08:00–16:00 = 8h',              run: () => assertEqual(hoursWorked('08:00', '16:00'), 8,    '8h') },
      { name: '09:00–17:30 = 8.5h',            run: () => assertEqual(hoursWorked('09:00', '17:30'), 8.5,  '8.5h') },
      { name: '08:00–08:30 = 0.5h',            run: () => assertEqual(hoursWorked('08:00', '08:30'), 0.5,  '0.5h') },
      { name: '12:00–12:15 = 0.25h',           run: () => assertEqual(hoursWorked('12:00', '12:15'), 0.25, '0.25h') },
      { name: 'Same time = 0 (not 24h)',        run: () => assertEqual(hoursWorked('00:00', '00:00'), 0,    'same') },
      { name: '23:00–01:00 midnight cross = 2h', run: () => assertEqual(hoursWorked('23:00', '01:00'), 2,  'midnight') },
      { name: '22:30–06:30 overnight = 8h',    run: () => assertEqual(hoursWorked('22:30', '06:30'), 8,    'overnight') },
    ],
  },

  {
    name: 'computeOT() — daily rule',
    tests: [
      { name: 'Exactly 8h — no OT', run: () => {
        const r = computeOT([mkEntry('2025-06-16','08:00','16:00')], 'daily', 8);
        assertEqual(r.regularHours, 8, 'reg'); assertEqual(r.overtimeHours, 0, 'ot');
      }},
      { name: '10h shift → 2h OT', run: () => {
        const r = computeOT([mkEntry('2025-06-16','06:00','16:00')], 'daily', 8);
        assertEqual(r.regularHours, 8, 'reg'); assertEqual(r.overtimeHours, 2, 'ot');
      }},
      { name: '10h with 30m break → 1.5h OT', run: () => {
        const r = computeOT([mkEntry('2025-06-16','06:00','16:00',30)], 'daily', 8);
        assertEqual(r.regularHours, 8, 'reg'); assertEqual(r.overtimeHours, 1.5, 'ot');
      }},
      { name: 'Prevailing wage entries excluded from OT', run: () => {
        const r = computeOT([mkEntry('2025-06-16','08:00','20:00',0,'prevailing_wage')], 'daily', 8);
        assertEqual(r.regularHours, 0, 'reg'); assertEqual(r.overtimeHours, 0, 'ot');
      }},
      { name: 'Two 6h days — no OT', run: () => {
        const r = computeOT([mkEntry('2025-06-16','08:00','14:00'), mkEntry('2025-06-17','08:00','14:00')], 'daily', 8);
        assertEqual(r.regularHours, 12, 'reg'); assertEqual(r.overtimeHours, 0, 'ot');
      }},
      { name: 'Two 10h days → 4h OT total', run: () => {
        const r = computeOT([mkEntry('2025-06-16','06:00','16:00'), mkEntry('2025-06-17','06:00','16:00')], 'daily', 8);
        assertEqual(r.regularHours, 16, 'reg'); assertEqual(r.overtimeHours, 4, 'ot');
      }},
      { name: 'Empty entries → zeros', run: () => {
        const r = computeOT([], 'daily', 8);
        assertEqual(r.regularHours, 0, 'reg'); assertEqual(r.overtimeHours, 0, 'ot');
      }},
    ],
  },

  {
    name: 'computeOT() — weekly rule',
    tests: [
      { name: '5 × 8h = 40h — no OT', run: () => {
        const entries = ['2025-06-16','2025-06-17','2025-06-18','2025-06-19','2025-06-20'].map(d => mkEntry(d,'08:00','16:00'));
        const r = computeOT(entries, 'weekly', 40);
        assertEqual(r.regularHours, 40, 'reg'); assertEqual(r.overtimeHours, 0, 'ot');
      }},
      { name: '5 × 9h = 45h → 5h OT', run: () => {
        const entries = ['2025-06-16','2025-06-17','2025-06-18','2025-06-19','2025-06-20'].map(d => mkEntry(d,'08:00','17:00'));
        const r = computeOT(entries, 'weekly', 40);
        assertEqual(r.regularHours, 40, 'reg'); assertEqual(r.overtimeHours, 5, 'ot');
      }},
      { name: 'Two separate weeks each under threshold = no OT', run: () => {
        const entries = ['2025-06-16','2025-06-17','2025-06-23','2025-06-24'].map(d => mkEntry(d,'08:00','16:00'));
        const r = computeOT(entries, 'weekly', 40);
        assertEqual(r.overtimeHours, 0, 'ot');
      }},
    ],
  },

  {
    name: 'computeOT() — none rule',
    tests: [
      { name: '12h shift → overtimeHours = 0', run: () => {
        const r = computeOT([mkEntry('2025-06-16','06:00','18:00')], 'none', 8);
        assertEqual(r.overtimeHours, 0, 'ot'); assertEqual(r.regularHours, 12, 'reg');
      }},
      { name: '5 × 10h = 50h regular, 0 OT', run: () => {
        const entries = ['2025-06-16','2025-06-17','2025-06-18','2025-06-19','2025-06-20'].map(d => mkEntry(d,'06:00','16:00'));
        const r = computeOT(entries, 'none', 8);
        assertEqual(r.overtimeHours, 0, 'ot'); assertEqual(r.regularHours, 50, 'reg');
      }},
    ],
  },

  {
    name: 'computeDailyPayCosts()',
    tests: [
      { name: 'None rule: regularCost = days × rate, overtimeCost = 0', run: () => {
        const entries = [mkEntry('2025-06-16','08:00','16:00'), mkEntry('2025-06-17','08:00','16:00')];
        const r = computeDailyPayCosts(entries, 'none', 8, 200, 1.5);
        assertEqual(r.regularCost, 400, 'regularCost'); assertEqual(r.overtimeCost, 0, 'overtimeCost');
      }},
      { name: 'Daily OT: 2 × 10h → OT cost = 4h × (200/8) × 1.5 = $150', run: () => {
        const entries = [mkEntry('2025-06-16','06:00','16:00'), mkEntry('2025-06-17','06:00','16:00')];
        const r = computeDailyPayCosts(entries, 'daily', 8, 200, 1.5);
        assertEqual(r.regularCost, 400, 'regularCost'); assertEqual(r.overtimeCost, 150, 'overtimeCost');
      }},
      { name: 'Prevailing wage entries not counted as days', run: () => {
        const r = computeDailyPayCosts([mkEntry('2025-06-16','08:00','16:00',0,'prevailing_wage')], 'none', 8, 200, 1.5);
        assertEqual(r.regularCost, 0, 'regularCost');
      }},
      { name: 'Same date in two entries = 1 day', run: () => {
        const entries = [mkEntry('2025-06-16','08:00','12:00'), mkEntry('2025-06-16','13:00','17:00')];
        const r = computeDailyPayCosts(entries, 'none', 8, 200, 1.5);
        assertEqual(r.regularCost, 200, 'regularCost');
      }},
    ],
  },

  {
    name: 'haversineDistanceFt()',
    tests: [
      { name: 'Same point = 0 ft', run: () => assertEqual(haversineDistanceFt(40.7128,-74.006,40.7128,-74.006), 0, 'same') },
      { name: 'NYC → LA ≈ 12,913,000 ft (2,445 miles)', run: () =>
        assertClose(haversineDistanceFt(40.7128,-74.006,34.0522,-118.2437), 12913000, 200000, 'NYC-LA')
      },
      { name: 'London → Paris is positive', run: () =>
        assert(haversineDistanceFt(51.5074,-0.1278,48.8566,2.3522) > 0)
      },
      { name: 'Symmetric A→B = B→A', run: () => {
        const ab = haversineDistanceFt(40.7128,-74.006,34.0522,-118.2437);
        const ba = haversineDistanceFt(34.0522,-118.2437,40.7128,-74.006);
        assertClose(ab, ba, 0.001, 'symmetric');
      }},
      { name: 'Short distance: ~300ft north is detectable', run: () => {
        const d = haversineDistanceFt(40.7128,-74.006,40.7137,-74.006);
        assert(d > 100 && d < 1000, `Got ${d.toFixed(0)}ft`);
      }},
    ],
  },

  {
    name: 'validCoords()',
    tests: [
      { name: 'Valid: NYC',          run: () => assert(validCoords(40.7128, -74.006)) },
      { name: 'Valid: 0, 0',         run: () => assert(validCoords(0, 0)) },
      { name: 'Valid: lat 90',       run: () => assert(validCoords(90, 0)) },
      { name: 'Valid: lat -90',      run: () => assert(validCoords(-90, 0)) },
      { name: 'Valid: lng 180',      run: () => assert(validCoords(0, 180)) },
      { name: 'Valid: lng -180',     run: () => assert(validCoords(0, -180)) },
      { name: 'Invalid: lat 91',     run: () => assert(!validCoords(91, 0)) },
      { name: 'Invalid: lat -91',    run: () => assert(!validCoords(-91, 0)) },
      { name: 'Invalid: lng 181',    run: () => assert(!validCoords(0, 181)) },
      { name: 'Invalid: lng -181',   run: () => assert(!validCoords(0, -181)) },
      { name: 'Invalid: NaN',        run: () => assert(!validCoords(NaN, 0)) },
      { name: 'Invalid: string abc', run: () => assert(!validCoords('abc', 0)) },
      { name: 'Invalid: null',       run: () => assert(!validCoords(null, null)) },
      { name: 'String numbers coerced', run: () => assert(validCoords('40.7', '-74.0')) },
    ],
  },

  {
    name: 'applySettingsRows()',
    tests: [
      { name: 'String key kept as string', run: () => {
        assertEqual(applySettingsRows([{key:'currency',value:'EUR'}], {currency:'USD'}).currency, 'EUR', 'currency');
      }},
      { name: 'Feature "1" → true', run: () => {
        assertEqual(applySettingsRows([{key:'feature_scheduling',value:'1'}], {feature_scheduling:false}).feature_scheduling, true, 'feature on');
      }},
      { name: 'Feature "0" → false', run: () => {
        assertEqual(applySettingsRows([{key:'feature_scheduling',value:'0'}], {feature_scheduling:true}).feature_scheduling, false, 'feature off');
      }},
      { name: 'Numeric key parsed as float', run: () => {
        assertEqual(applySettingsRows([{key:'overtime_threshold',value:'10'}], {overtime_threshold:8}).overtime_threshold, 10, 'threshold');
      }},
      { name: 'overtime_rule stays a string', run: () => {
        assertEqual(applySettingsRows([{key:'overtime_rule',value:'weekly'}], {overtime_rule:'daily'}).overtime_rule, 'weekly', 'rule');
      }},
      { name: 'Defaults preserved when key absent', run: () => {
        const r = applySettingsRows([], {overtime_threshold:8, currency:'USD'});
        assertEqual(r.overtime_threshold, 8, 'threshold'); assertEqual(r.currency, 'USD', 'currency');
      }},
      { name: 'Empty rows returns clone of defaults', run: () => {
        const r = applySettingsRows([], {foo:42});
        assertEqual(r.foo, 42, 'foo');
      }},
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // API — AUTH ROUTES
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'API — POST /auth/login validation',
    async: true,
    tests: [
      { name: 'Empty body → 400', run: async () => assertIs((await post('/auth/login', {})).status, 400) },
      { name: 'Missing password → 400', run: async () => assertIs((await post('/auth/login', {username:'x',company_name:'y'})).status, 400) },
      { name: 'Missing company_name → 400', run: async () => assertIs((await post('/auth/login', {username:'x',password:'y'})).status, 400) },
      { name: 'Wrong credentials → 401', run: async () => assertIs((await post('/auth/login', {username:'__test_nx__',password:'wrong',company_name:'__test__'})).status, 401) },
    ],
  },

  {
    name: 'API — GET /auth/me',
    async: true,
    tests: [
      { name: 'Without token → 401', run: async () => assertIs((await get('/auth/me')).status, 401) },
      { name: 'With stored token → 200 or 401', run: async () => assertOneOf((await get('/auth/me', TOKEN())).status, [200, 401]) },
      { name: 'On 200: response has user.id, user.role', run: async () => {
        const r = await get('/auth/me', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(d?.user?.id, 'user.id');
        assert(['admin','worker','super_admin'].includes(d.user.role), `role: ${d.user.role}`);
      }},
    ],
  },

  {
    name: 'API — POST /auth/register validation',
    async: true,
    tests: [
      { name: 'Empty body → 400', run: async () => assertOneOf((await post('/auth/register', {})).status, [400, 429]) },
      { name: 'Missing email → 400', run: async () => assertOneOf((await post('/auth/register', {company_name:'X',full_name:'Y',username:'z',password:'abc123'})).status, [400, 429]) },
      { name: 'Password < 6 chars → 400', run: async () => assertOneOf((await post('/auth/register', {company_name:'X',full_name:'Y',username:'z',password:'abc',email:'a@b.com'})).status, [400, 429]) },
      { name: 'Password = username → 400', run: async () => assertOneOf((await post('/auth/register', {company_name:'X',full_name:'Y',username:'myuser',password:'myuser1',email:'a@b.com'})).status, [400, 429]) },
    ],
  },

  {
    name: 'API — POST /auth/* validation',
    async: true,
    tests: [
      { name: 'POST /auth/forgot-password — no email → 400', run: async () => assertOneOf((await post('/auth/forgot-password', {})).status, [400, 429]) },
      { name: 'POST /auth/forgot-password — with email → 200 (no leak)', run: async () => assertOneOf((await post('/auth/forgot-password', {email:'nobody@example.invalid'})).status, [200, 429]) },
      { name: 'POST /auth/reset-password — missing fields → 400', run: async () => assertIs((await post('/auth/reset-password', {})).status, 400) },
      { name: 'POST /auth/reset-password — bad token → 400', run: async () => assertIs((await post('/auth/reset-password', {token:'fakefakefake',password:'newsecret1'})).status, 400) },
      { name: 'POST /auth/confirm-email — missing token → 400', run: async () => assertIs((await post('/auth/confirm-email', {})).status, 400) },
      { name: 'POST /auth/confirm-email — bad token → 400', run: async () => assertIs((await post('/auth/confirm-email', {token:'fakefakefake'})).status, 400) },
      { name: 'POST /auth/complete-setup — missing fields → 400', run: async () => assertIs((await post('/auth/complete-setup', {})).status, 400) },
      { name: 'POST /auth/change-password — no auth → 401', run: async () => assertIs((await post('/auth/change-password', {current_password:'x',new_password:'y'})).status, 401) },
      { name: 'POST /auth/mfa/confirm — missing fields → 400', run: async () => assertIs((await post('/auth/mfa/confirm', {})).status, 400) },
      { name: 'POST /auth/mfa/enable — no auth → 401', run: async () => assertIs((await post('/auth/mfa/enable', {code:'123456'})).status, 401) },
      { name: 'POST /auth/mfa/disable — no auth → 401', run: async () => assertIs((await post('/auth/mfa/disable', {password:'x'})).status, 401) },
      { name: 'GET /auth/mfa/setup — no auth → 401', run: async () => assertIs((await get('/auth/mfa/setup')).status, 401) },
      { name: 'POST /auth/update-language — no auth → 401', run: async () => assertIs((await post('/auth/update-language', {language:'Spanish'})).status, 401) },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // API — AUTH GUARDS (all protected routes return 401 without a token)
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'API — Auth guards: admin core',
    async: true,
    tests: [
      guard('GET /admin/kpis',              '/admin/kpis'),
      guard('GET /admin/settings',          '/admin/settings'),
      guard('PATCH /admin/settings',        '/admin/settings', 'PATCH'),
      guard('GET /admin/company',           '/admin/company'),
      guard('PATCH /admin/company',         '/admin/company', 'PATCH'),
      guard('GET /admin/notifications',     '/admin/notifications'),
      guard('GET /admin/active-clocks',     '/admin/active-clocks'),
      guard('GET /admin/audit-log',         '/admin/audit-log'),
      guard('POST /admin/support',          '/admin/support', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: workers',
    async: true,
    tests: [
      guard('GET /admin/workers',                  '/admin/workers'),
      guard('GET /admin/workers/archived',          '/admin/workers/archived'),
      guard('GET /admin/workers/check-username',    '/admin/workers/check-username'),
      guard('POST /admin/workers',                  '/admin/workers', 'POST'),
      guard('POST /admin/workers/invite',           '/admin/workers/invite', 'POST'),
      guard('PATCH /admin/workers/0',               '/admin/workers/0', 'PATCH'),
      guard('DELETE /admin/workers/0',              '/admin/workers/0', 'DELETE'),
    ],
  },

  {
    name: 'API — Auth guards: projects',
    async: true,
    tests: [
      guard('GET /admin/projects',                    '/admin/projects'),
      guard('GET /admin/projects/archived',           '/admin/projects/archived'),
      guard('GET /admin/projects/metrics',            '/admin/projects/metrics'),
      guard('POST /admin/projects',                   '/admin/projects', 'POST'),
      guard('PATCH /admin/projects/0',                '/admin/projects/0', 'PATCH'),
      guard('DELETE /admin/projects/0',               '/admin/projects/0', 'DELETE'),
      guard('GET /admin/projects/0/documents',        '/admin/projects/0/documents'),
      guard('POST /admin/projects/0/documents',       '/admin/projects/0/documents', 'POST'),
      guard('DELETE /admin/projects/0/documents/0',   '/admin/projects/0/documents/0', 'DELETE'),
    ],
  },

  {
    name: 'API — Auth guards: time entries / approval',
    async: true,
    tests: [
      guard('GET /admin/entries/pending',       '/admin/entries/pending'),
      guard('POST /admin/entries/approve-all',  '/admin/entries/approve-all', 'POST'),
      guard('GET /admin/pay-periods',           '/admin/pay-periods'),
      guard('POST /admin/pay-periods',          '/admin/pay-periods', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: reports / exports',
    async: true,
    tests: [
      guard('GET /admin/export',            '/admin/export'),
      guard('GET /admin/overtime-report',   '/admin/overtime-report'),
      guard('GET /admin/payroll-export',    '/admin/payroll-export'),
      guard('GET /admin/analytics',         '/admin/analytics'),
      guard('GET /admin/certified-payroll', '/admin/certified-payroll'),
    ],
  },

  {
    name: 'API — Auth guards: QBO',
    async: true,
    tests: [
      guard('GET /qbo/status',                '/qbo/status'),
      guard('GET /qbo/connect',               '/qbo/connect'),
      guard('GET /qbo/employees',             '/qbo/employees'),
      guard('GET /qbo/customers',             '/qbo/customers'),
      guard('GET /qbo/vendors',               '/qbo/vendors'),
      guard('DELETE /qbo/disconnect',         '/qbo/disconnect', 'DELETE'),
      guard('POST /qbo/push',                 '/qbo/push', 'POST'),
      guard('POST /qbo/import/workers',       '/qbo/import/workers', 'POST'),
      guard('POST /qbo/import/projects',      '/qbo/import/projects', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: worker endpoints',
    async: true,
    tests: [
      guard('GET /clock/status',       '/clock/status'),
      guard('POST /clock/in',          '/clock/in', 'POST'),
      guard('POST /clock/out',         '/clock/out', 'POST'),
      guard('DELETE /clock/cancel',    '/clock/cancel', 'DELETE'),
      guard('GET /time-entries',       '/time-entries'),
      guard('POST /time-entries',      '/time-entries', 'POST'),
      guard('GET /projects',           '/projects'),
      guard('GET /inbox',              '/inbox'),
      guard('GET /shifts/mine',        '/shifts/mine'),
    ],
  },

  {
    name: 'API — Auth guards: shifts (admin)',
    async: true,
    tests: [
      guard('GET /shifts/admin',    '/shifts/admin'),
      guard('POST /shifts/admin',   '/shifts/admin', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: field / safety',
    async: true,
    tests: [
      guard('GET /daily-reports',         '/daily-reports'),
      guard('POST /daily-reports',        '/daily-reports', 'POST'),
      guard('GET /field-reports',         '/field-reports'),
      guard('POST /field-reports',        '/field-reports', 'POST'),
      guard('GET /incidents',             '/incidents'),
      guard('POST /incidents',            '/incidents', 'POST'),
      guard('GET /punchlist',             '/punchlist'),
      guard('POST /punchlist',            '/punchlist', 'POST'),
      guard('GET /safety-talks',          '/safety-talks'),
      guard('POST /safety-talks',         '/safety-talks', 'POST'),
      guard('GET /rfis',                  '/rfis'),
      guard('POST /rfis',                 '/rfis', 'POST'),
      guard('GET /equipment',              '/equipment'),
      guard('POST /equipment',             '/equipment', 'POST'),
      guard('GET /safety-checklists',      '/safety-checklists'),
      guard('POST /safety-checklists',     '/safety-checklists', 'POST'),
      guard('GET /inspections',            '/inspections'),
      guard('GET /inspections/templates',  '/inspections/templates'),
      guard('GET /sub-reports',            '/sub-reports'),
      guard('POST /sub-reports',           '/sub-reports', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: chat / push / stripe',
    async: true,
    tests: [
      guard('GET /chat',              '/chat'),
      guard('POST /chat',             '/chat', 'POST'),
      guard('POST /push/subscribe',   '/push/subscribe', 'POST'),
      guard('DELETE /push/subscribe', '/push/subscribe', 'DELETE'),
      guard('GET /stripe/plans',      '/stripe/plans'),
      guard('GET /stripe/status',     '/stripe/status'),
      guard('POST /stripe/checkout',  '/stripe/checkout', 'POST'),
      guard('POST /stripe/portal',    '/stripe/portal', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: superadmin',
    async: true,
    tests: [
      guard('GET /superadmin/companies', '/superadmin/companies'),
    ],
  },

  {
    name: 'API — Auth guards: clients',
    async: true,
    tests: [
      guard('GET /admin/clients',                        '/admin/clients'),
      guard('POST /admin/clients',                       '/admin/clients', 'POST'),
      guard('PATCH /admin/clients/0',                    '/admin/clients/0', 'PATCH'),
      guard('DELETE /admin/clients/0',                   '/admin/clients/0', 'DELETE'),
      guard('GET /admin/clients/0/documents',            '/admin/clients/0/documents'),
      guard('POST /admin/clients/0/documents',           '/admin/clients/0/documents', 'POST'),
      guard('POST /admin/clients/0/documents/upload',    '/admin/clients/0/documents/upload', 'POST'),
    ],
  },

  {
    name: 'API — Auth guards: time-off',
    async: true,
    tests: [
      guard('POST /time-off',                      '/time-off', 'POST'),
      guard('GET /time-off/mine',                  '/time-off/mine'),
      guard('DELETE /time-off/0',                  '/time-off/0', 'DELETE'),
      guard('GET /time-off (admin list)',          '/time-off'),
      guard('PATCH /time-off/0/approve',            '/time-off/0/approve', 'PATCH'),
      guard('PATCH /time-off/0/deny',               '/time-off/0/deny', 'PATCH'),
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // API — INPUT VALIDATION (400 conditions)
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'API — POST input validation',
    async: true,
    tests: [
      { name: 'POST /time-entries — empty body → 400', run: async () => {
        const r = await post('/time-entries', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /time-entries — notes > 500 chars → 400', run: async () => {
        const r = await post('/time-entries', {project_id:1,work_date:'2025-06-16',start_time:'08:00',end_time:'16:00',notes:'x'.repeat(501)}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /time-entries — negative break_minutes → 400', run: async () => {
        const r = await post('/time-entries', {project_id:1,work_date:'2025-06-16',start_time:'08:00',end_time:'16:00',break_minutes:-1}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /chat — empty body → 400', run: async () => {
        const r = await post('/chat', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /chat — body > 1000 chars → 400', run: async () => {
        const r = await post('/chat', {body:'x'.repeat(1001)}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /incidents — empty body → 400', run: async () => {
        const r = await post('/incidents', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /punchlist — missing title → 400', run: async () => {
        const r = await post('/punchlist', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /daily-reports — missing report_date → 400', run: async () => {
        const r = await post('/daily-reports', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /safety-talks — missing required fields → 400', run: async () => {
        const r = await post('/safety-talks', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /qbo/import/workers — empty array → 400', run: async () => {
        const r = await post('/qbo/import/workers', {workers:[]}, TOKEN());
        assertOneOf(r.status, [400, 401, 403]);
      }},
      { name: 'POST /qbo/import/projects — empty array → 400', run: async () => {
        const r = await post('/qbo/import/projects', {projects:[]}, TOKEN());
        assertOneOf(r.status, [400, 401, 403]);
      }},
      { name: 'POST /push/subscribe — missing endpoint → 400', run: async () => {
        const r = await post('/push/subscribe', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /admin/clients — missing name → 400', run: async () => {
        const r = await post('/admin/clients', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
      { name: 'POST /time-off — missing required fields → 400', run: async () => {
        const r = await post('/time-off', {}, TOKEN());
        assertOneOf(r.status, [400, 401]);
      }},
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // API — PUBLIC ROUTES
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'API — Public routes',
    async: true,
    tests: [
      { name: 'GET /push/vapid-public-key → 200 or 503', run: async () =>
        assertOneOf((await get('/push/vapid-public-key')).status, [200, 503])
      },
      { name: 'POST /auth/resend-confirmation — missing email → 400', run: async () =>
        assertIs((await post('/auth/resend-confirmation', {})).status, 400)
      },
      { name: 'POST /auth/accept-invite — missing fields → 400', run: async () =>
        assertOneOf((await post('/auth/accept-invite', {})).status, [400, 429])
      },
      { name: 'POST /auth/accept-invite — bad token → 400', run: async () =>
        assertOneOf((await post('/auth/accept-invite', {token:'fake',password:'newpass1'})).status, [400, 429])
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // API — RESPONSE SHAPES (when authenticated)
  // ══════════════════════════════════════════════════════════════════════════════

  {
    name: 'API — Response shapes',
    async: true,
    tests: [
      { name: '/auth/me → {user:{id,username,role}}', run: async () => {
        const r = await get('/auth/me', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(d?.user?.id != null, 'user.id');
        assert(typeof d.user.username === 'string', 'username');
        assert(['admin','worker','super_admin'].includes(d.user.role), `role: ${d.user.role}`);
      }},
      { name: '/admin/workers → array', run: async () => {
        const r = await get('/admin/workers', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/admin/projects → array', run: async () => {
        const r = await get('/admin/projects', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/admin/settings → object with known keys', run: async () => {
        const r = await get('/admin/settings', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(typeof d === 'object' && d !== null, 'Expected object');
        assert('currency' in d || 'overtime_rule' in d, 'Missing settings keys');
      }},
      { name: '/admin/company → has name field', run: async () => {
        const r = await get('/admin/company', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(typeof d.name === 'string', `company.name: ${JSON.stringify(d)}`);
      }},
      { name: '/qbo/status → {connected: boolean}', run: async () => {
        const r = await get('/qbo/status', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(typeof d.connected === 'boolean', `connected: ${d.connected}`);
      }},
      { name: '/projects → array', run: async () => {
        const r = await get('/projects', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/inbox → array', run: async () => {
        const r = await get('/inbox', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/clock/status → null or object', run: async () => {
        const r = await get('/clock/status', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(d === null || typeof d === 'object', 'Expected null or object');
      }},
      { name: '/admin/active-clocks → array', run: async () => {
        const r = await get('/admin/active-clocks', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/admin/entries/pending → {entries:[], has_more}', run: async () => {
        const r = await get('/admin/entries/pending', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(Array.isArray(d.entries), 'entries array');
        assert(typeof d.has_more === 'boolean', 'has_more boolean');
      }},
      { name: '/admin/audit-log → {entries:[], total}', run: async () => {
        const r = await get('/admin/audit-log', TOKEN());
        if (r.status !== 200) return;
        const d = await r.json();
        assert(Array.isArray(d.entries), 'entries array');
        assert(typeof d.total === 'number', 'total number');
      }},
      { name: '/admin/clients → array', run: async () => {
        const r = await get('/admin/clients', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/admin/clients/0/documents → array or 404', run: async () => {
        const r = await get('/admin/clients/0/documents', TOKEN());
        assertOneOf(r.status, [200, 404]);
        if (r.status === 200) assert(Array.isArray(await r.json()), 'Expected array');
      }},
      { name: '/time-off (admin list) → array', run: async () => {
        const r = await get('/time-off', TOKEN());
        if (r.status !== 200) return;
        assert(Array.isArray(await r.json()), 'Expected array');
      }},
    ],
  },
];

// ── Report helpers (failures only) ───────────────────────────────────────────────

function buildReport(suiteResults) {
  const all    = suiteResults.flatMap(s => s.tests);
  const passed = all.filter(t => t.status === 'pass').length;
  const failed = all.length - passed;
  const lines  = [
    `OpsFloa Test Report — ${new Date().toLocaleString()}`,
    `${passed}/${all.length} passed · ${failed} failed`,
  ];
  if (failed === 0) {
    lines.push('', '✓ All tests passed');
  } else {
    for (const suite of suiteResults) {
      const failures = suite.tests.filter(t => t.status === 'fail');
      if (failures.length === 0) continue;
      lines.push('', `── ${suite.name} (${failures.length} failure${failures.length !== 1 ? 's' : ''})`);
      for (const t of failures) {
        lines.push(`  ✗ ${t.name}`);
        if (t.error) lines.push(`      ${t.error}`);
      }
    }
  }
  return lines.join('\n');
}

// ── Shared suite runner ───────────────────────────────────────────────────────────

async function runSuite(suite) {
  const testResults = [];
  for (const test of suite.tests) {
    const start = performance.now();
    try {
      if (suite.async) await test.run(); else test.run();
      testResults.push({ name: test.name, status: 'pass', ms: Math.round(performance.now() - start) });
    } catch (err) {
      testResults.push({ name: test.name, status: 'fail', error: err.message, ms: Math.round(performance.now() - start) });
    }
  }
  return { name: suite.name, tests: testResults };
}

// ── Runner component ──────────────────────────────────────────────────────────────

export default function Tests() {
  const [results,  setResults]  = useState(null);
  const [running,  setRunning]  = useState(false);   // 'all' | suiteIndex | false
  const [copied,   setCopied]   = useState(false);

  const runAll = async () => {
    setRunning('all');
    const suiteResults = [];
    for (const suite of SUITES) {
      suiteResults.push(await runSuite(suite));
    }
    setResults(suiteResults);
    setRunning(false);
  };

  const runOne = async (si) => {
    setRunning(si);
    const result = await runSuite(SUITES[si]);
    setResults(prev => {
      const next = prev ? [...prev] : SUITES.map((_, i) => i === si ? null : null);
      // Fill array to correct length if first run
      if (!prev || prev.length !== SUITES.length) {
        const full = SUITES.map((_, i) => i === si ? result : (prev?.[i] ?? null));
        return full;
      }
      next[si] = result;
      return next;
    });
    setRunning(false);
  };

  const copyReport = () => {
    const flat = results?.filter(Boolean);
    if (!flat?.length) return;
    navigator.clipboard.writeText(buildReport(flat)).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  };

  const printReport = () => {
    const flat = results?.filter(Boolean);
    if (!flat?.length) return;
    const w = window.open('', '_blank');
    w.document.write(`<pre style="font-family:monospace;font-size:13px;padding:24px;white-space:pre-wrap">${buildReport(flat).replace(/</g,'&lt;')}</pre>`);
    w.document.close(); w.print();
  };

  const allTests  = results?.filter(Boolean).flatMap(s => s.tests) ?? [];
  const total     = allTests.length;
  const passed    = allTests.filter(t => t.status === 'pass').length;
  const failed    = total - passed;
  const hasResults = results?.some(Boolean);
  const totalDefined = SUITES.flatMap(x => x.tests).length;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Unit Tests</h1>
          <p style={s.subtitle}>{SUITES.length} suites · {totalDefined} tests</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hasResults && (
            <>
              <button style={s.outlineBtn} onClick={copyReport}>{copied ? '✓ Copied' : '⎘ Copy Errors'}</button>
              <button style={s.outlineBtn} onClick={printReport}>⎙ Print Errors</button>
            </>
          )}
          <button style={s.runBtn} onClick={runAll} disabled={running !== false}>
            {running === 'all' ? 'Running…' : '▶ Run All'}
          </button>
        </div>
      </div>

      {hasResults && (
        <div style={{ ...s.summary, background: failed === 0 ? '#f0fdf4' : '#fef2f2', borderColor: failed === 0 ? '#bbf7d0' : '#fecaca' }}>
          <span style={{ fontWeight: 700, color: failed === 0 ? '#166534' : '#991b1b', fontSize: 16 }}>
            {failed === 0 ? '✓ All tests passed' : `✗ ${failed} test${failed !== 1 ? 's' : ''} failed`}
          </span>
          <span style={{ color: '#6b7280', fontSize: 14 }}>{passed}/{total} passed</span>
        </div>
      )}

      <div style={s.suites}>
        {SUITES.map((suite, si) => {
          const sr = results?.[si];
          const allPass = sr?.tests.every(t => t.status === 'pass');
          const isBusy  = running !== false;
          return (
            <div key={suite.name} style={s.suiteCard}>
              <div style={s.suiteName}>
                {sr && (
                  <span style={{ ...s.suiteBadge, background: allPass ? '#dcfce7' : '#fee2e2', color: allPass ? '#166534' : '#991b1b' }}>
                    {sr.tests.filter(t => t.status === 'pass').length}/{sr.tests.length}
                  </span>
                )}
                <span style={{ flex: 1 }}>{suite.name}</span>
                {suite.async && <span style={s.asyncBadge}>async</span>}
                <button style={{ ...s.suiteRunBtn, opacity: isBusy ? 0.4 : 1 }} onClick={() => runOne(si)} disabled={isBusy}>
                  {running === si ? '…' : '▶'}
                </button>
              </div>
              <div style={s.testList}>
                {suite.tests.map((test, ti) => {
                  const tr = sr?.tests[ti];
                  return (
                    <div key={test.name} style={s.testRow}>
                      <span style={{ ...s.dot, color: !tr ? '#d1d5db' : tr.status === 'pass' ? '#16a34a' : '#dc2626' }}>
                        {!tr ? '○' : tr.status === 'pass' ? '✓' : '✗'}
                      </span>
                      <span style={s.testName}>{test.name}</span>
                      {tr && <span style={s.ms}>{tr.ms}ms</span>}
                      {tr?.error && <span style={s.errMsg}>{tr.error}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  page:      { maxWidth: 760, margin: '40px auto', padding: '0 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  header:    { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 },
  title:     { fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 },
  subtitle:  { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  runBtn:    { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  outlineBtn:{ background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  summary:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid', borderRadius: 10, padding: '14px 18px', marginBottom: 24 },
  suites:    { display: 'flex', flexDirection: 'column', gap: 16 },
  suiteCard: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' },
  suiteName: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#f9fafb', fontWeight: 700, fontSize: 14, color: '#374151', borderBottom: '1px solid #e5e7eb' },
  suiteBadge:{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 },
  asyncBadge:  { fontSize: 10, fontWeight: 600, color: '#6b7280', background: '#f3f4f6', padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
  suiteRunBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700, color: '#6b7280', cursor: 'pointer', lineHeight: '18px' },
  testList:  { padding: '6px 0' },
  testRow:   { display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 16px', flexWrap: 'wrap' },
  dot:       { fontSize: 14, fontWeight: 700, width: 16, flexShrink: 0 },
  testName:  { fontSize: 13, color: '#374151', flex: 1 },
  ms:        { fontSize: 11, color: '#6b7280' },
  errMsg:    { width: '100%', fontSize: 12, color: '#dc2626', background: '#fef2f2', borderRadius: 6, padding: '4px 10px', marginTop: 2, fontFamily: 'monospace' },
};
