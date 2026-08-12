import React from 'react';
import { fmtHours } from '../utils';
import { useT } from '../hooks/useT';

// One member as a single-column table row: name + their period summary metrics.
// Selecting it fills the report area below the table (state lives in the parent).
export default function MemberReportRow({ worker, overtimeEnabled = true, selected = false, onSelect, pinned = false, onTogglePin }) {
  const t = useT();
  const total = parseFloat(worker.total_hours) || 0;
  const regular = parseFloat(worker.regular_hours) || 0;
  const overtime = parseFloat(worker.overtime_hours) || 0;
  const prevailing = parseFloat(worker.prevailing_hours) || 0;
  return (
    <div
      style={{ ...styles.row, ...(selected ? styles.rowSelected : {}) }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
    >
      {onTogglePin && (
        <button
          style={{ ...styles.pinBtn, ...(pinned ? styles.pinBtnOn : {}) }}
          onClick={e => { e.stopPropagation(); onTogglePin(); }}
          title={pinned ? t.trUnpin : t.trPin}
          aria-label={pinned ? t.trUnpin : t.trPin}
          aria-pressed={pinned}
        >📌</button>
      )}
      <div style={styles.ident}>
        <span style={styles.name}>{worker.full_name}</span>
        <span style={styles.username}>@{worker.username}</span>
      </div>
      <div style={styles.metrics}>
        <Metric label={t.totalMetric} value={fmtHours(total)} />
        {regular > 0 && <Metric label={t.regularMetric} value={fmtHours(regular)} color="#2563eb" />}
        {overtimeEnabled && overtime > 0 && <Metric label={t.overtimeMetric} value={fmtHours(overtime)} color="#dc2626" />}
        {prevailing > 0 && <Metric label={t.prevailingMetric} value={fmtHours(prevailing)} color="#d97706" />}
        <Metric label={t.entriesMetric} value={worker.total_entries || 0} />
      </div>
      <span style={{ ...styles.pick, ...(selected ? styles.pickOn : {}) }}>{selected ? '✓' : '›'}</span>
    </div>
  );
}

function Metric({ label, value, color }) {
  return (
    <div style={styles.metric}>
      <span style={{ ...styles.metricVal, color: color || '#222' }}>{value}</span>
      <span style={styles.metricLabel}>{label}</span>
    </div>
  );
}

const styles = {
  row: { background: '#fff', display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', flexWrap: 'wrap' },
  pinBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '2px 2px', lineHeight: 1, opacity: 0.4, transform: 'rotate(40deg)', transition: 'opacity .12s, transform .12s', flex: '0 0 auto' },
  pinBtnOn: { opacity: 1, transform: 'rotate(0deg) scale(1.1)' },
  rowSelected: { background: '#eef2ff', boxShadow: 'inset 3px 0 0 var(--ops-page-accent, #4338ca)' },
  ident: { display: 'flex', flexDirection: 'column', minWidth: 140 },
  name: { fontWeight: 700, fontSize: 15 },
  username: { color: '#6b7280', fontSize: 12.5 },
  metrics: { display: 'flex', gap: 20, flex: 1, flexWrap: 'wrap' },
  metric: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 56 },
  metricVal: { fontWeight: 700, fontSize: 17 },
  metricLabel: { fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 },
  pick: { color: '#c7c9cf', fontSize: 16, fontWeight: 700, marginLeft: 'auto' },
  pickOn: { color: 'var(--ops-page-accent, #4338ca)' },
};
