import React, { useState, useMemo } from 'react';
import { fmtHours } from '../utils';
import EntryPanel from './EntryPanel';
import api from '../api';
import { getT } from '../i18n';
import { langToLocale } from '../utils';
import { startOfWeek as computeStartOfWeek } from '../utils/weekBounds';

function startOfWeekFor(date, ws) { return computeStartOfWeek(date, ws ?? 1); }

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toDateKey(date) {
  return date.toLocaleDateString('en-CA');
}

function formatMonthDay(date, locale) {
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function formatWeekDay(date, locale) {
  return date.toLocaleDateString(locale, { weekday: 'short' });
}

function formatTime(t) {
  const [h, m] = t.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m}${hour < 12 ? 'a' : 'p'}`;
}

function netHours(start, end, breakMinutes) {
  const s = new Date(`1970-01-01T${start}`);
  let e = new Date(`1970-01-01T${end}`);
  if (e <= s) e = new Date(`1970-01-02T${end}`); // midnight-crossing
  return (e - s) / 3600000 - (breakMinutes || 0) / 60;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function TimesheetView({
  entries,
  language,
  projects = [],
  onRefresh,
  weekStart: companyWeekStart = 1,
  selectedWeekStart = null,
  onSelectedWeekStartChange,
}) {
  const t = getT(language);
  const locale = langToLocale(language);
  const [internalWeekStart, setInternalWeekStart] = useState(() => startOfWeekFor(new Date(), companyWeekStart));
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState('');
  const weekStart = selectedWeekStart || internalWeekStart;
  const setWeekStart = updater => {
    const next = typeof updater === 'function' ? updater(weekStart) : updater;
    if (selectedWeekStart && onSelectedWeekStartChange) onSelectedWeekStartChange(next);
    else setInternalWeekStart(next);
  };

  const prevWeek = () => setWeekStart(d => addDays(d, -7));
  const nextWeek = () => setWeekStart(d => addDays(d, 7));
  const goToday = () => setWeekStart(startOfWeekFor(new Date(), companyWeekStart));

  const copyLastWeek = async () => {
    setCopying(true);
    setCopyMsg('');
    try {
      const r = await api.post('/time-entries/copy-last-week');
      const { created, skipped } = r.data;
      setCopyMsg(`${created} entr${created === 1 ? 'y' : 'ies'} copied${skipped > 0 ? `, ${skipped} skipped` : ''}`);
      setTimeout(() => setCopyMsg(''), 4000);
      if (created > 0 && onRefresh) await onRefresh();
    } catch {
      setCopyMsg(t.copyFailed);
    } finally {
      setCopying(false);
    }
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const todayKey = toDateKey(new Date());

  // Group entries by date
  const byDate = useMemo(() => {
    const map = {};
    entries.forEach(e => {
      const key = e.work_date.substring(0, 10);
      if (!map[key]) map[key] = [];
      map[key].push(e);
    });
    return map;
  }, [entries]);

  const weekLabel = `${formatMonthDay(days[0], locale)} \u2013 ${formatMonthDay(days[6], locale)}, ${days[6].getFullYear()}`;

  const weekTotalHours = useMemo(() => days.reduce((sum, d) => {
    const key = toDateKey(d);
    return sum + (byDate[key] || []).reduce((s, e) => s + netHours(e.start_time, e.end_time, e.break_minutes), 0);
  }, 0), [days, byDate]);

  const weekTotalMiles = useMemo(() => days.reduce((sum, d) => {
    const key = toDateKey(d);
    return sum + (byDate[key] || []).reduce((s, e) => s + (parseFloat(e.mileage) || 0), 0);
  }, 0), [days, byDate]);

  return (
    <div style={styles.card} className="mobile-card">
      <div style={styles.header}>
        <div style={styles.navGroup}>
          <button style={styles.navBtn} aria-label={t.prevWeekLabel} onClick={prevWeek}>‹</button>
          <span style={styles.weekLabel}>{weekLabel}</span>
          <button style={styles.navBtn} aria-label={t.nextWeekLabel} onClick={nextWeek}>›</button>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.weekTotal}>{fmtHours(weekTotalHours)}</span>
          {weekTotalMiles > 0 && <span style={styles.weekMiles}>🚗 {weekTotalMiles.toFixed(1)} mi</span>}
          <button style={styles.todayBtn} onClick={goToday}>{t.todayBtn}</button>
          <button style={{ ...styles.todayBtn, borderColor: 'var(--ops-page-accent)', color: 'var(--ops-page-accent)', ...(copying ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={copyLastWeek} disabled={copying}>
            {copying ? t.saving : t.copyLastWeekBtn}
          </button>
          {copyMsg && <span style={{ fontSize: 12, color: '#6b7280' }}>{copyMsg}</span>}
        </div>
      </div>

      <div style={styles.grid}>
        {days.map(day => {
          const key = toDateKey(day);
          const dayEntries = byDate[key] || [];
          const dayHours = dayEntries.reduce((s, e) => s + netHours(e.start_time, e.end_time, e.break_minutes), 0);
          const dayMiles = dayEntries.reduce((s, e) => s + (parseFloat(e.mileage) || 0), 0);
          const isToday = key === todayKey;
          const isWeekend = day.getDay() === 0 || day.getDay() === 6;

          return (
            <div
              key={key}
              style={{
                ...styles.dayCol,
                background: isToday ? '#eff6ff' : isWeekend ? '#fafafa' : '#fff',
                borderTop: isToday ? '3px solid var(--ops-page-accent)' : '3px solid transparent',
              }}
            >
              <div style={styles.dayHeader}>
                <span style={{ ...styles.dayName, color: isToday ? 'var(--ops-page-accent)' : '#6b7280' }}>
                  {formatWeekDay(day, locale)}
                </span>
                <span style={{ ...styles.dayNum, fontWeight: isToday ? 700 : 400, color: isToday ? 'var(--ops-page-accent)' : '#374151' }}>
                  {day.getDate()}
                </span>
              </div>

              <div style={styles.entriesArea}>
                {dayEntries.length === 0 ? (
                  <div style={styles.emptyDay} />
                ) : (
                  dayEntries.map(e => (
                    <div
                      key={e.id}
                      style={{
                        ...styles.entryPill,
                        borderLeft: `3px solid ${e.wage_type === 'prevailing' ? '#d97706' : 'var(--ops-page-accent)'}`,
                        cursor: 'pointer',
                        outline: selectedEntry?.id === e.id ? '2px solid var(--ops-page-accent)' : 'none',
                      }}
                      onClick={() => setSelectedEntry(selectedEntry?.id === e.id ? null : e)}
                    >
                      <div style={styles.pillProject} title={e.project_name}>{e.project_name}</div>
                      <div style={styles.pillTimes}>{formatTime(e.start_time)}–{formatTime(e.end_time)}</div>
                      <div style={styles.pillHours}>{fmtHours(netHours(e.start_time, e.end_time, e.break_minutes))}</div>
                      {e.break_minutes > 0 && <div style={styles.pillBreak}>☕ {e.break_minutes}m</div>}
                      {e.mileage > 0 && <div style={styles.pillMileage}>🚗 {parseFloat(e.mileage).toFixed(1)} mi</div>}
                    </div>
                  ))
                )}
              </div>

              {dayEntries.length > 0 && (
                <div style={styles.dayFooter}>
                  <span style={styles.dayTotal}>{fmtHours(dayHours)}</span>
                  {dayMiles > 0 && <span style={styles.dayMiles}>{dayMiles.toFixed(1)} mi</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {selectedEntry && (
        <div style={styles.selectedPanel}>
          <div style={styles.selectedHeader}>
            <span style={styles.selectedTitle}>{selectedEntry.project_name} — {formatTime(selectedEntry.start_time)}–{formatTime(selectedEntry.end_time)}</span>
            <button style={styles.closeBtn} aria-label={t.labelModalClose} onClick={() => setSelectedEntry(null)}>✕</button>
          </div>
          <EntryPanel
            entry={selectedEntry}
            projects={projects}
            onRefresh={async () => { setSelectedEntry(null); if (onRefresh) await onRefresh(); }}
            onDeleted={() => setSelectedEntry(null)}
            onClose={() => setSelectedEntry(null)}
          />
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 },
  navGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  navBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 18, cursor: 'pointer', color: '#374151', lineHeight: 1 },
  weekLabel: { fontWeight: 700, fontSize: 15, color: '#111827' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  weekTotal: { fontWeight: 700, fontSize: 16, color: 'var(--ops-page-accent)' },
  weekMiles: { fontSize: 13, color: '#6b7280' },
  todayBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#374151' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(80px, 1fr))', gap: 4, overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
  dayCol: { borderRadius: 8, padding: '8px 6px', minHeight: 120, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 80 },
  dayHeader: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 6 },
  dayName: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  dayNum: { fontSize: 18, lineHeight: 1.2 },
  entriesArea: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 },
  emptyDay: { flex: 1 },
  entryPill: { background: '#f8faff', borderRadius: 5, padding: '5px 6px', fontSize: 11 },
  pillProject: { fontWeight: 700, color: '#1e3a5f', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pillTimes: { color: '#6b7280', fontSize: 10 },
  pillHours: { fontWeight: 700, color: 'var(--ops-page-accent)', marginTop: 2 },
  pillBreak: { color: '#6b7280', fontSize: 10 },
  pillMileage: { color: '#6b7280', fontSize: 10 },
  dayFooter: { borderTop: '1px solid #e5e7eb', paddingTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  dayTotal: { fontWeight: 700, fontSize: 12, color: 'var(--ops-page-accent)' },
  dayMiles: { fontSize: 10, color: '#6b7280' },
  selectedPanel: { marginTop: 16, padding: 16, background: '#f8faff', borderRadius: 10, border: '1px solid #93c5fd' },
  selectedHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  selectedTitle: { fontWeight: 700, fontSize: 14, color: '#1e3a5f' },
  closeBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '2px 6px' },
};
