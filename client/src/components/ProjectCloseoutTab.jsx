// Project closeout tab — embedded version of the CloseoutPage's
// per-project view, mounted inside the existing ProjectsPage detail
// panel. Reads /projects/:id/closeout, supports the same transitions
// and manual-item toggling.

import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { SkeletonList } from './Skeleton';
import { silentError } from '../errorReporter';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { formatDate } from '../utils';

const STATUS_COLORS = {
  open:                  { bg: '#f3f4f6', fg: '#374151' },
  in_progress:           { bg: '#dbeafe', fg: '#1d4ed8' },
  substantially_complete:{ bg: '#fef3c7', fg: '#92400e' },
  final_complete:        { bg: '#d1fae5', fg: '#065f46' },
  closed:                { bg: '#a7f3d0', fg: '#065f46' },
  reopened:              { bg: '#fee2e2', fg: '#991b1b' },
};

const STATUS_LABEL_KEYS = {
  open:                   'pctStatusOpen',
  in_progress:            'pctStatusInProgress',
  substantially_complete: 'pctStatusSubstantiallyComplete',
  final_complete:         'pctStatusFinalComplete',
  closed:                 'pctStatusClosed',
  reopened:               'pctStatusReopened',
};

const ITEM_STATUS_LABEL_KEYS = {
  pending:     'pctItemPending',
  in_progress: 'pctItemInProgress',
  done:        'pctItemDone',
  waived:      'pctItemWaived',
  n_a:         'pctItemNA',
};

const ITEM_ICONS = {
  pending:     { fg: '#6b7280', icon: '○' },
  in_progress: { fg: '#1d4ed8', icon: '◐' },
  done:        { fg: '#065f46', icon: '●' },
  waived:      { fg: '#7c3aed', icon: '◆' },
  n_a:         { fg: '#9ca3af', icon: '⊘' },
};

export default function ProjectCloseoutTab({ projectId }) {
  const t = useT();
  const { user } = useAuth();
  const [closeout, setCloseout] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/projects/${projectId}/closeout`);
      setCloseout(data.closeout);
      setItems(data.items || []);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function openCloseout() {
    setBusy(true); setError(null);
    try {
      const { data } = await api.post(`/projects/${projectId}/closeout`);
      setCloseout(data.closeout);
      setItems(data.items || []);
    } catch (err) { setError(err.response?.data?.error || t.pctErrOpenFailed); }
    finally { setBusy(false); }
  }

  async function transition(to_status) {
    setBusy(true); setError(null);
    try {
      await api.post(`/projects/${projectId}/closeout/transition`, { to_status });
      await load();
    } catch (err) { setError(err.response?.data?.error || t.pctErrTransitionFailed); }
    finally { setBusy(false); }
  }

  async function toggleItem(item, newStatus) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/closeout-items/${item.id}`, { status: newStatus });
      await load();
    } catch (err) { setError(err.response?.data?.error || t.pctErrUpdateFailed); }
    finally { setBusy(false); }
  }

  if (loading) return <SkeletonList rows={3} />;

  if (!closeout) {
    return (
      <div style={styles.card}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>{t.pctNoCloseout}</h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          {t.pctNoCloseoutDesc}
        </p>
        <button onClick={openCloseout} disabled={busy} style={styles.btnPrimary}>
          {busy ? t.pctOpening : t.pctOpenCloseout}
        </button>
        {error && <div style={styles.errorBox}>{error}</div>}
      </div>
    );
  }

  const statusColor = STATUS_COLORS[closeout.status] || STATUS_COLORS.open;
  const completeCount = items.filter(i => ['done', 'waived', 'n_a'].includes(i.status)).length;

  return (
    <div>
      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <span style={{
            fontSize: 12, fontWeight: 700, background: statusColor.bg, color: statusColor.fg,
            padding: '4px 10px', borderRadius: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>{t[STATUS_LABEL_KEYS[closeout.status]] || t.pctStatusOpen}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {closeout.status === 'open' && (
              <button onClick={() => transition('in_progress')} disabled={busy} style={styles.btn}>{t.pctBeginCloseout}</button>
            )}
            {closeout.status === 'in_progress' && (
              <button onClick={() => transition('substantially_complete')} disabled={busy} style={styles.btnPrimary}>
                {t.pctMarkSubstantiallyComplete}
              </button>
            )}
            {closeout.status === 'substantially_complete' && (
              <button onClick={() => transition('final_complete')} disabled={busy} style={styles.btnPrimary}>
                {t.pctMarkFinalComplete}
              </button>
            )}
            {closeout.status === 'final_complete' && (
              <button onClick={() => transition('closed')} disabled={busy} style={styles.btnPrimary}>{t.pctClose}</button>
            )}
            {closeout.status === 'closed' && (
              <button onClick={() => transition('reopened')} disabled={busy} style={{ ...styles.btn, color: '#991b1b' }}>{t.pctReopen}</button>
            )}
          </div>
        </div>
        <div style={{ ...styles.grid4, marginTop: 14 }}>
          <Info label={t.pctInfoSubstantial} value={formatDate(closeout.substantial_completion_date, user?.language) || null} />
          <Info label={t.pctInfoFinal} value={formatDate(closeout.final_completion_date, user?.language) || null} />
          <Info label={t.pctInfoWarrantyStart} value={formatDate(closeout.warranty_start_date, user?.language) || null} />
          <Info label={t.pctInfoWarrantyMonths} value={closeout.warranty_months} />
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.h3}>{t.pctChecklist} ({completeCount} / {items.length} {t.pctComplete})</h3>
        {items.map(item => {
          const c = ITEM_ICONS[item.status] || ITEM_ICONS.pending;
          const isAuto = !!item.auto_source;
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ width: 24, fontSize: 18, color: c.fg, textAlign: 'center', flexShrink: 0 }}>{c.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                  {item.title}
                  {!item.required && <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6, fontWeight: 500 }}>{t.pctOptional}</span>}
                  {isAuto && <span style={{ fontSize: 9, color: '#1d4ed8', marginLeft: 6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t.pctAuto}</span>}
                </div>
                {item.completed_at && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
                    {t.pctCompleted} {formatDate(item.completed_at, user?.language)}
                  </div>
                )}
              </div>
              <div style={{ flexShrink: 0 }}>
                {isAuto ? (
                  <span style={{ fontSize: 11, color: c.fg, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t[ITEM_STATUS_LABEL_KEYS[item.status]] || item.status}</span>
                ) : (
                  <select
                    value={item.status}
                    onChange={e => toggleItem(item, e.target.value)}
                    disabled={busy}
                    style={{ padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}
                  >
                    <option value="pending">{t.pctItemPending}</option>
                    <option value="in_progress">{t.pctItemInProgress}</option>
                    <option value="done">{t.pctItemDone}</option>
                    <option value="waived">{t.pctItemWaived}</option>
                    <option value="n_a">{t.pctItemNA}</option>
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111827' }}>{value || '—'}</div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 8, padding: 18, marginBottom: 14, border: '1px solid #e5e7eb' },
  h3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
  btn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnPrimary: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 14, fontSize: 14 },
};
