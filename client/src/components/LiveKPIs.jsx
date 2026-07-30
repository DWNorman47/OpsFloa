import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';

export default function LiveKPIs({ refreshToken = 0 }) {
  const t = useT();
  const [kpis, setKpis] = useState(null);
  const [error, setError] = useState('');

  const load = () =>
    api.get('/admin/kpis')
      .then(r => { setKpis(r.data); setError(''); })
      .catch(() => setError(t.failedToLoad));

  useEffect(() => {
    load();
    const timer = setInterval(load, 300000);
    return () => clearInterval(timer);
  }, [refreshToken]);

  // Single card with internal cells, not four separate cards — the four-card
  // layout was reading as four buttons and users were clicking them
  // expecting drilldowns. Hairline dividers between cells are added in CSS
  // (kpi-cell rules) so they wrap correctly to a 2x2 grid on mobile.
  if (error) return (
    <div style={styles.cardWrap}>
      <div style={{ padding: '14px 16px', color: '#b91c1c', fontSize: 14, textAlign: 'center' }}>
        {error}
      </div>
    </div>
  );

  if (!kpis) return (
    <div style={styles.cardWrap}>
      <div style={styles.grid} className="kpi-grid">
        {[t.pendingApprovals, t.clockedInNow, t.hoursThisWeek, t.workersWithOT].map(label => (
          <div key={label} style={styles.cell} className="kpi-cell">
            <div style={styles.skelValue} />
            <div style={styles.label}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );

  const cards = [
    { label: t.pendingApprovals, value: kpis.pending_approvals, color: kpis.pending_approvals > 0 ? '#d97706' : '#059669' },
    { label: t.clockedInNow, value: kpis.clocked_in_count, color: '#1a56db' },
    { label: t.hoursThisWeek, value: kpis.company_hours_this_week, color: '#1a56db' },
    { label: t.workersWithOT, value: kpis.overtime_workers_this_week, color: kpis.overtime_workers_this_week > 0 ? '#dc2626' : '#059669' },
  ];

  return (
    <div style={styles.cardWrap}>
      <div style={styles.grid} className="kpi-grid">
        {cards.map(c => (
          <div key={c.label} style={styles.cell} className="kpi-cell">
            <div style={{ ...styles.value, color: c.color }}>{c.value}</div>
            <div style={styles.label}>{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  cardWrap: {
    background: '#fff', borderRadius: 10, boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
    overflow: 'hidden', marginBottom: 20,
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' },
  cell: { padding: '14px 16px', textAlign: 'center' },
  value: { fontSize: 28, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 },
  skelValue: { height: 34, width: 48, background: '#e5e7eb', borderRadius: 6, margin: '0 auto 6px', animation: 'pulse 1.5s ease-in-out infinite' },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.03em' },
};
