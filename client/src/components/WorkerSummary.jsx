import React, { useState, useMemo } from 'react';
import { fmtHours, formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { startOfWeek } from '../utils/weekBounds';

function getDateRange(key, weekStart = 1) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'all') return { from: null, to: null };
  if (key === 'last_30') {
    const from = new Date(today); from.setDate(from.getDate() - 29);
    return { from, to: today };
  }
  if (key === 'this_month') {
    return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: today };
  }
  if (key === 'this_week') {
    return { from: startOfWeek(today, weekStart), to: today };
  }
  if (key === 'last_week') {
    const start = startOfWeek(today, weekStart);
    const from = new Date(start); from.setDate(from.getDate() - 7);
    const to = new Date(start);   to.setDate(to.getDate() - 1);
    return { from, to };
  }
  return { from: null, to: null };
}

function entryHours(e) {
  const s = new Date(`1970-01-01T${e.start_time}`);
  const en = new Date(`1970-01-01T${e.end_time}`);
  return (en - s) / 3600000 - (e.break_minutes || 0) / 60;
}

// Client mirror of the server's rate-aware overtime (server/utils/rateAwareOvertime.js,
// default "rate when worked" method, single multiplier). Kept in sync by hand so
// the worker's own estimate matches what they'll be paid. This is an ESTIMATE:
// it doesn't model tiered/rest-day/7th-day premiums or the weighted-average
// method. ALL worked hours (regular + prevailing) count toward one threshold, and
// each overtime hour is paid at the rate it earned. Honors overtime_hours_override.
function rateAwareSplit(entries, { rule, threshold, mult, rate, prevailingRate }) {
  const worked = entries.filter(e => e.start_time && e.end_time);
  const baseRateOf = e => (e.wage_type === 'prevailing' ? (parseFloat(prevailingRate) || 0) : rate);
  const otOf = new Map();

  // Per-entry override carved out first (as the server does).
  const auto = [];
  for (const e of worked) {
    if (e.overtime_hours_override != null) {
      const total = entryHours(e);
      otOf.set(e, Math.max(0, Math.min(total, parseFloat(e.overtime_hours_override))));
    } else auto.push(e);
  }

  if (rule === 'none') {
    for (const e of auto) otOf.set(e, 0);
  } else {
    const bucketKey = e => {
      if (rule === 'weekly') {
        const d = new Date(e.work_date.substring(0, 10) + 'T00:00:00');
        const jan4 = new Date(d.getFullYear(), 0, 4);
        const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
        return `${d.getFullYear()}-W${week}`;
      }
      return e.work_date.substring(0, 10);
    };
    const buckets = {};
    for (const e of auto) { const k = bucketKey(e); (buckets[k] = buckets[k] || []).push(e); }
    for (const es of Object.values(buckets)) {
      // Chronological fill: straight time up to the threshold, the rest overtime.
      es.sort((a, b) => `${a.work_date}${a.start_time || ''}`.localeCompare(`${b.work_date}${b.start_time || ''}`));
      let regLeft = threshold;
      for (const e of es) {
        const total = entryHours(e);
        const reg = Math.max(0, Math.min(total, regLeft));
        otOf.set(e, total - reg);
        regLeft -= reg;
      }
    }
  }

  let regularHours = 0, overtimeHours = 0, prevailingHours = 0, cost = 0;
  for (const e of worked) {
    const total = entryHours(e);
    const ot = otOf.get(e) || 0;
    const st = total - ot;
    const br = baseRateOf(e);
    overtimeHours += ot;
    cost += st * br + ot * br * mult;
    if (e.wage_type === 'prevailing') prevailingHours += st;
    else regularHours += st;
  }
  return { regularHours, overtimeHours, prevailingHours, cost };
}

export default function WorkerSummary({ entries, hourlyRate, rateType = 'hourly', overtimeMultiplier = 1.5, prevailingRate = 0, overtimeRule = 'daily', overtimeThreshold = 8, weekStart = 1, showWages = false, currency = 'USD', overtimeEnabled = true }) {
  const t = useT();
  const RANGES = [
    { label: t.thisWeek, key: 'this_week' },
    { label: t.lastWeek, key: 'last_week' },
    { label: t.thisMonth, key: 'this_month' },
    { label: t.last30Days, key: 'last_30' },
    { label: t.allTime, key: 'all' },
  ];
  const [range, setRange] = useState('this_week');
  const { from, to } = getDateRange(range, weekStart);

  const filtered = useMemo(() => {
    return entries.filter(e => {
      const d = new Date(e.work_date.substring(0, 10) + 'T00:00:00');
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }, [entries, from, to]);

  const totalHours = filtered.reduce((sum, e) => sum + entryHours(e), 0);
  const rate = parseFloat(hourlyRate) || 30;
  // Straight regular / all overtime / straight prevailing + the hourly cost —
  // prevailing & multi-rate hours now earn overtime, matching the server.
  const { regularHours, overtimeHours, prevailingHours, cost: hourlyCost } = rateAwareSplit(
    filtered, { rule: overtimeRule, threshold: overtimeThreshold, mult: overtimeMultiplier, rate, prevailingRate }
  );

  let estimatedPay;
  if (rateType === 'daily') {
    const regularDays = new Set(filtered.filter(e => e.wage_type === 'regular').map(e => String(e.work_date).substring(0, 10))).size;
    // Daily-rate workers earn per worked day; overtime + prevailing are estimated
    // hourly on top (an approximation — exact daily-rate math lives server-side).
    const otCost = overtimeHours * (rate / overtimeThreshold) * overtimeMultiplier;
    estimatedPay = (regularDays * rate) + otCost + (prevailingHours * (parseFloat(prevailingRate) || 0));
  } else {
    estimatedPay = hourlyCost;
  }

  const byProject = {};
  filtered.forEach(e => {
    const name = e.project_name || t.unknownProject;
    byProject[name] = (byProject[name] || 0) + entryHours(e);
  });

  return (
    <div style={styles.card} className="mobile-card">
      <div style={styles.header}>
        <h2 style={styles.heading}>{t.mySummary}</h2>
        <div style={styles.rangeTabs} className="range-tabs">
          {RANGES.map(r => (
            <button
              key={r.key}
              style={range === r.key ? styles.rangeActive : styles.rangeBtn}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p style={styles.empty}>{t.noEntriesPeriod}</p>
      ) : (
        <>
          <div style={styles.statsGrid} className="stats-grid">
            <div style={styles.stat}>
              <div style={styles.statValue}>{fmtHours(totalHours)}</div>
              <div style={styles.statLabel}>{t.totalHoursLabel}</div>
            </div>
            <div style={styles.stat}>
              <div style={styles.statValue}>{fmtHours(regularHours)}</div>
              <div style={styles.statLabel}>{t.regularLabel}</div>
            </div>
            {overtimeEnabled && overtimeHours > 0 && (
              <div style={styles.stat}>
                <div style={{ ...styles.statValue, color: '#d97706' }}>{fmtHours(overtimeHours)}</div>
                <div style={styles.statLabel}>{t.overtimeLabel}</div>
              </div>
            )}
            {prevailingHours > 0 && (
              <div style={styles.stat}>
                <div style={{ ...styles.statValue, color: '#8b5cf6' }}>{fmtHours(prevailingHours)}</div>
                <div style={styles.statLabel}>{t.prevailingLabel}</div>
              </div>
            )}
            {showWages && (
              <div style={styles.stat}>
                <div style={{ ...styles.statValue, color: '#059669' }}>{formatCurrency(estimatedPay, currency)}</div>
                <div style={styles.statLabel}>{t.estEarnings}</div>
              </div>
            )}
          </div>

          {Object.keys(byProject).length > 1 && (
            <div style={styles.projectBreakdown}>
              <div style={styles.breakdownTitle}>{t.byProject}</div>
              {Object.entries(byProject).sort((a, b) => b[1] - a[1]).map(([name, hours]) => (
                <div key={name} style={styles.projectRow}>
                  <span style={styles.projectName}>{name}</span>
                  <div style={styles.barWrap}>
                    <div style={{ ...styles.bar, width: `${(hours / totalHours) * 100}%` }} />
                  </div>
                  <span style={styles.projectHours}>{fmtHours(hours)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  heading: { fontSize: 18, fontWeight: 700 },
  rangeTabs: { display: 'flex', gap: 4, flexWrap: 'nowrap' },
  rangeBtn: { padding: '5px 10px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 12, color: '#6b7280', cursor: 'pointer', fontWeight: 500 },
  rangeActive: { padding: '5px 10px', background: 'var(--ops-page-accent)', border: 'none', borderRadius: 6, fontSize: 12, color: '#fff', cursor: 'pointer', fontWeight: 700 },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 16, marginBottom: 20 },
  // Flat labeled numbers — no border/background/radius. The previous
  // bordered tiles read as buttons and admins/workers were tapping them.
  stat: { padding: '4px 0' },
  statValue: { fontSize: 22, fontWeight: 800, color: '#1a1a1a', marginBottom: 2 },
  statLabel: { fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' },
  empty: { color: '#6b7280', fontSize: 14 },
  projectBreakdown: { borderTop: '1px solid #f0f0f0', paddingTop: 16 },
  breakdownTitle: { fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 10 },
  projectRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  projectName: { fontSize: 13, fontWeight: 600, minWidth: 100, flex: 1 },
  barWrap: { flex: 2, height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' },
  bar: { height: '100%', background: 'var(--ops-page-accent)', borderRadius: 4, transition: 'width 0.3s ease' },
  projectHours: { fontSize: 13, color: '#555', minWidth: 36, textAlign: 'right' },
};
