import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line,
} from 'recharts';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { labelSg, labelPl } from '../companyLabels';
import { SkeletonStatRow, SkeletonList } from './Skeleton';

import { silentError } from '../errorReporter';
const BLUE = '#1a56db';
const GREEN = '#059669';
const ORANGE = '#d97706';

const PRESET_DAYS = [14, 30, 90];

function toLocalDate(d) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n + 1);
  return toLocalDate(d);
}

function today() {
  return toLocalDate(new Date());
}

function startOfWeek(dateStr, weekStart) {
  const d = new Date(`${dateStr}T00:00:00`);
  const ws = ((Number(weekStart) % 7) + 7) % 7;
  const daysSinceStart = (d.getDay() - ws + 7) % 7;
  d.setDate(d.getDate() - daysSinceStart);
  return d;
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={styles.statCard}>
      <div style={{ ...styles.statValue, color: color || '#111827' }}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
      {sub && <div style={styles.statSub}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }) {
  return <h3 style={styles.sectionTitle}>{children}</h3>;
}

function HorizontalBars({ data, color, noDataLabel }) {
  if (!data || data.length === 0) return <p style={styles.empty}>{noDataLabel}</p>;
  const max = Math.max(...data.map(d => d.hours));
  return (
    <div style={styles.hBarList}>
      {data.map((d, i) => (
        <div key={i} style={styles.hBarRow}>
          <div style={styles.hBarLabel} title={d.name}>{d.name}</div>
          <div style={styles.hBarTrack}>
            <div style={{ ...styles.hBarFill, width: `${(d.hours / max) * 100}%`, background: color }} />
          </div>
          <div style={styles.hBarValue}>{d.hours}h</div>
        </div>
      ))}
    </div>
  );
}


function presetLabel(days, t) {
  if (days === 14) return t.ad14Days;
  if (days === 30) return t.ad30Days;
  if (days === 90) return t.ad90Days;
  return `${days}d`;
}

export default function AnalyticsDashboard({ weekStart = 1, settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const workerLabelPluralLower = workerLabelPlural.toLowerCase();
  const formatDay = dateStr => new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const formatWeek = dateStr => new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState(14); // days; null = custom
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const from = showCustom ? customFrom : daysAgo(preset);
  const to = showCustom ? customTo : today();

  useEffect(() => {
    setLoading(true);
    setData(null);
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    api.get(`/admin/analytics?${params}`)
      .then(r => setData(r.data))
      .catch(silentError('analyticsdashboard'))
      .finally(() => setLoading(false));
  }, [from, to]);

  // Fill daily chart — build a date range and zero-fill missing days
  // These useMemo calls must come before any early returns (rules of hooks)
  const dailyFilled = useMemo(() => {
    if (!data) return [];
    const { daily_hours = [] } = data;
    const dailyMap = Object.fromEntries(daily_hours.map(d => [d.date, parseFloat(d.hours)]));
    const result = [];
    if (showCustom && customFrom && customTo) {
      const start = new Date(customFrom + 'T00:00:00');
      const end = new Date(customTo + 'T00:00:00');
      const rangeDays = Math.min(90, Math.round((end - start) / 86400000) + 1);
      for (let i = 0; i < rangeDays; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = toLocalDate(d);
        result.push({ date: key, hours: dailyMap[key] || 0 });
      }
    } else if (!showCustom) {
      for (let i = preset - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = toLocalDate(d);
        result.push({ date: key, hours: dailyMap[key] || 0 });
      }
    } else {
      // Custom mode but dates not fully set — show whatever server returned
      daily_hours.forEach(d => result.push({ date: d.date, hours: parseFloat(d.hours) }));
    }
    return result;
  }, [data, showCustom, customFrom, customTo, preset]);

  // Fill weekly chart
  const weeklyFilled = useMemo(() => {
    if (!data) return [];
    const { weekly_hours = [] } = data;
    const weeklyMap = Object.fromEntries((weekly_hours || []).map(d => [d.week_start, parseFloat(d.hours)]));
    const result = [];
    if (showCustom) {
      // Use server data as-is for custom range
      (weekly_hours || []).forEach(w => result.push({ week_start: w.week_start, hours: parseFloat(w.hours) }));
    } else {
      const start = startOfWeek(from, weekStart);
      const end = startOfWeek(to, weekStart);
      const maxWeeks = 14;
      for (let d = new Date(start), weeks = 0; d <= end && weeks < maxWeeks; d.setDate(d.getDate() + 7), weeks++) {
        const key = toLocalDate(d);
        result.push({ week_start: key, hours: weeklyMap[key] || 0 });
      }
    }
    return result;
  }, [data, showCustom, customFrom, customTo, from, to, weekStart]);

  if (loading) return <><SkeletonStatRow count={4} style={{ marginBottom: 16 }} /><SkeletonList count={4} /></>;
  if (!data) return <p style={{ color: '#e53e3e' }}>{t.failedLoadAnalytics}</p>;

  const { summary, daily_hours, weekly_hours, project_hours, worker_hours } = data;

  const rangeLabel = showCustom
    ? (customFrom && customTo ? `${customFrom} – ${customTo}` : t.adCustom)
    : presetLabel(preset, t);

  return (
    <div style={styles.wrap}>
      {/* Date range controls */}
      <div style={styles.rangeRow}>
        <div style={styles.presetGroup}>
          {PRESET_DAYS.map(days => (
            <button
              key={days}
              style={{ ...styles.presetBtn, ...((!showCustom && preset === days) ? styles.presetBtnActive : {}) }}
              onClick={() => { setPreset(days); setShowCustom(false); }}
            >
              {presetLabel(days, t)}
            </button>
          ))}
          <button
            style={{ ...styles.presetBtn, ...(showCustom ? styles.presetBtnActive : {}) }}
            onClick={() => { setShowCustom(true); if (!customFrom) setCustomFrom(daysAgo(30)); if (!customTo) setCustomTo(today()); }}
          >
            {t.adCustom}
          </button>
        </div>
        {showCustom && (
          <div style={styles.customRange}>
            <input type="date" style={styles.dateInput} value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            <span style={{ fontSize: 12, color: '#6b7280' }}>–</span>
            <input type="date" style={styles.dateInput} value={customTo} onChange={e => setCustomTo(e.target.value)} />
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div style={styles.statRow}>
        <StatCard
          label={t.hoursThisWeek}
          value={`${summary.hours_this_week}h`}
          sub={`${summary.active_workers_this_week} ${workerLabelPluralLower} active`}
          color={BLUE}
        />
        <StatCard
          label={t.hoursThisMonth}
          value={`${summary.hours_this_month}h`}
          sub={`${summary.active_workers_this_month} ${workerLabelPluralLower} active`}
          color={GREEN}
        />
        <StatCard
          label={t.pendingApprovalsAnalytics}
          value={summary.pending_approvals}
          sub={summary.pending_approvals > 0 ? t.needsReview : t.allCaughtUpAnalytics}
          color={summary.pending_approvals > 0 ? ORANGE : GREEN}
        />
        {(parseFloat(summary.mileage_this_month) > 0 || parseFloat(summary.mileage_this_week) > 0) && (
          <StatCard
            label={t.mileageThisMonth}
            value={`${summary.mileage_this_month} mi`}
            sub={t.mileageThisWeek.replace('{n}', summary.mileage_this_week)}
            color="#8b5cf6"
          />
        )}
      </div>

      {/* Daily hours bar chart */}
      <div style={styles.card}>
        <SectionTitle>{t.dailyHoursChart} <span style={styles.rangeTag}>{rangeLabel}</span></SectionTitle>
        {dailyFilled.every(d => d.hours === 0) ? (
          <p style={styles.empty}>{t.noEntries14Days}</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyFilled} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <XAxis
                dataKey="date"
                tickFormatter={formatDay}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                interval={Math.max(0, Math.floor(dailyFilled.length / 10) - 1)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip
                formatter={v => [`${v}h`, t.chartHoursLabel]}
                labelFormatter={formatDay}
                contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }}
              />
              <Bar dataKey="hours" radius={[4, 4, 0, 0]}>
                {dailyFilled.map((d, i) => (
                  <Cell key={i} fill={d.hours > 0 ? BLUE : '#e5e7eb'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Weekly hours trend */}
      <div style={styles.card}>
        <SectionTitle>{t.weeklyHoursChart} <span style={styles.rangeTag}>{rangeLabel}</span></SectionTitle>
        {weeklyFilled.every(d => d.hours === 0) ? (
          <p style={styles.empty}>{t.noEntries12Weeks}</p>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={weeklyFilled} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <XAxis
                dataKey="week_start"
                tickFormatter={formatWeek}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                interval={Math.max(0, Math.floor(weeklyFilled.length / 8) - 1)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip
                formatter={v => [`${v}h`, t.chartHoursLabel]}
                labelFormatter={d => `${t.weekOf} ${formatWeek(d)}`}
                contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }}
              />
              <Line
                type="monotone"
                dataKey="hours"
                stroke={BLUE}
                strokeWidth={2}
                dot={{ fill: BLUE, r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Project and worker breakdown */}
      <div style={styles.twoCol}>
        <div style={styles.card}>
          <SectionTitle>{`Hours by project`} <span style={styles.rangeTag}>{rangeLabel}</span></SectionTitle>
          <HorizontalBars data={project_hours} color={BLUE} noDataLabel={t.noDataYet} />
        </div>
        <div style={styles.card}>
          <SectionTitle>{`Hours by ${workerLabel.toLowerCase()}`} <span style={styles.rangeTag}>{rangeLabel}</span></SectionTitle>
          <HorizontalBars data={worker_hours} color={GREEN} noDataLabel={t.noDataYet} />
        </div>
      </div>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 20 },
  rangeRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  presetGroup: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  presetBtn: { fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 20, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' },
  presetBtnActive: { background: '#1a56db', color: '#fff', borderColor: '#1a56db' },
  customRange: { display: 'flex', alignItems: 'center', gap: 6 },
  dateInput: { fontSize: 12, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, color: '#374151' },
  rangeTag: { fontSize: 11, fontWeight: 400, color: '#6b7280', marginLeft: 6 },
  statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16, minWidth: 0 },
  statCard: { background: '#fff', borderRadius: 12, padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', minWidth: 0 },
  statValue: { fontSize: 32, fontWeight: 800, lineHeight: 1, marginBottom: 6 },
  statLabel: { fontSize: 13, fontWeight: 600, color: '#374151' },
  statSub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  card: { background: '#fff', borderRadius: 12, padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', minWidth: 0, maxWidth: '100%' },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 16, minWidth: 0 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 16, margin: '0 0 16px', display: 'flex', alignItems: 'baseline' },
  empty: { color: '#6b7280', fontSize: 13 },
  hBarList: { display: 'flex', flexDirection: 'column', gap: 10 },
  hBarRow: { display: 'flex', alignItems: 'center', gap: 10 },
  hBarLabel: { width: 120, fontSize: 13, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 },
  hBarTrack: { flex: 1, minWidth: 0, height: 10, background: '#f3f4f6', borderRadius: 5, overflow: 'hidden' },
  hBarFill: { height: '100%', borderRadius: 5, transition: 'width 0.4s ease' },
  hBarValue: { width: 40, fontSize: 12, color: '#6b7280', textAlign: 'right', flexShrink: 0 },
};
