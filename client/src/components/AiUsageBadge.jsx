import React, { useEffect, useState } from 'react';
import api from '../api';

// Small "N / limit AI requests this month" pill for the Claude-backed office
// tools. Re-fetches whenever `refreshSignal` changes (bump it after each call).
export default function AiUsageBadge({ refreshSignal = 0 }) {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/office/usage', { suppressToast: true })
      .then(({ data }) => { if (!cancelled) setUsage(data); })
      .catch(() => { /* metering unavailable — just hide the badge */ });
    return () => { cancelled = true; };
  }, [refreshSignal]);

  if (!usage || typeof usage.limit !== 'number') return null;
  const { count, limit } = usage;
  const atLimit = count >= limit;
  const near = !atLimit && count >= limit * 0.85;

  return (
    <div style={styles.wrap}>
      <span
        style={{ ...styles.badge, ...(atLimit ? styles.full : near ? styles.near : null) }}
        title="Counts summaries, document questions, and drafts. Resets at the start of each month."
      >
        {count.toLocaleString()} / {limit.toLocaleString()} AI requests this month
      </span>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 },
  badge: {
    fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#64748b',
    background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 999, padding: '3px 10px',
  },
  near: { color: '#92400e', background: '#fffbeb', borderColor: '#fde68a' },
  full: { color: '#b91c1c', background: '#fef2f2', borderColor: '#fecaca' },
};
