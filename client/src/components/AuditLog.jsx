import React, { useState, useEffect } from 'react';
import api from '../api';
import { formatInTz, langToLocale } from '../utils';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { SkeletonList } from './Skeleton';
import EmptyState from './EmptyState';

function formatDt(str, tz, locale = 'en-US') {
  return {
    date: formatInTz(str, tz, { month: 'short', day: 'numeric', year: 'numeric' }, locale),
    time: formatInTz(str, tz, { hour: 'numeric', minute: '2-digit' }, locale),
  };
}

function ActionBadge({ action, actionMeta }) {
  const meta = actionMeta[action] || { label: action, color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 6, fontSize: 12, fontWeight: 600, color: meta.color, background: meta.bg }}>
      {meta.label}
    </span>
  );
}

export default function AuditLog({ timezone = '', settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workerLabel = settings?.label_worker || 'Team Member';
  const workerLabelPlural = workerLabel.endsWith('s') ? workerLabel : `${workerLabel}s`;
  const workLabel = settings?.label_work || 'Project';
  const workLabelPlural = workLabel.endsWith('s') ? workLabel : `${workLabel}s`;
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const LIMIT = 25;

  const ACTION_META = {
    'worker.created':      { label: t.auditWorkerAdded,       color: '#059669', bg: '#d1fae5' },
    'worker.invited':      { label: t.auditWorkerInvited,      color: '#8b5cf6', bg: '#ede9fe' },
    'worker.updated':      { label: t.auditWorkerUpdated,      color: 'var(--ops-page-accent)', bg: '#dbeafe' },
    'worker.deleted':      { label: t.auditWorkerRemoved,      color: '#ef4444', bg: '#fee2e2' },
    'worker.restored':     { label: t.auditWorkerRestored,     color: '#059669', bg: '#d1fae5' },
    'project.created':     { label: t.auditProjectCreated,     color: '#059669', bg: '#d1fae5' },
    'project.updated':     { label: t.auditProjectUpdated,     color: 'var(--ops-page-accent)', bg: '#dbeafe' },
    'project.deleted':     { label: t.auditProjectRemoved,     color: '#ef4444', bg: '#fee2e2' },
    'project.restored':    { label: t.auditProjectRestored,    color: '#059669', bg: '#d1fae5' },
    'entry.approved':      { label: t.auditEntryApproved,      color: '#059669', bg: '#d1fae5' },
    'entry.rejected':      { label: t.auditEntryRejected,      color: '#dc2626', bg: '#fee2e2' },
    'pay_period.locked':   { label: t.auditPayPeriodLocked,    color: '#d97706', bg: '#fef3c7' },
    'pay_period.unlocked': { label: t.auditPayPeriodUnlocked,  color: '#6b7280', bg: '#f3f4f6' },
    'settings.updated':    { label: t.auditSettingsUpdated,    color: '#d97706', bg: '#fef3c7' },
  };

  const ACTION_GROUPS = {
    '': t.filterAllActions,
    worker: workerLabelPlural,
    project: workLabelPlural,
    entry: t.filterEntries,
    pay_period: t.filterPayPeriods,
    settings: t.filterSettings,
  };

  const load = async (pg) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: pg * LIMIT });
      if (group) params.set('group', group);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const r = await api.get(`/admin/audit-log?${params}`);
      setEntries(r.data.entries);
      setTotal(r.data.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setPage(0); }, [group, from, to]);
  useEffect(() => { load(page); }, [page, group, from, to]);

  const totalPages = Math.ceil(total / LIMIT);
  const goTo = pg => setPage(pg);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h3 style={styles.title}>{t.auditLogHeading}</h3>
        <span style={styles.totalBadge}>{total} {t.auditEvents}</span>
      </div>

      <div className="filter-row" style={styles.filters}>
        <select style={styles.filterSelect} value={group} onChange={e => setGroup(e.target.value)}>
          {Object.entries(ACTION_GROUPS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
        <input style={styles.filterDate} type="date" value={from} onChange={e => setFrom(e.target.value)} placeholder={t.fromDate} title={t.fromDate} />
        <input style={styles.filterDate} type="date" value={to} onChange={e => setTo(e.target.value)} placeholder={t.toDate} title={t.toDate} />
        {(group || from || to) && (
          <button style={styles.clearBtn} onClick={() => { setGroup(''); setFrom(''); setTo(''); }}>{t.auditClear}</button>
        )}
      </div>

      {loading && entries.length === 0 ? (
        <SkeletonList count={5} rows={2} />
      ) : entries.length === 0 ? (
        <EmptyState mark="A" title={t.auditNoActivity} body={t.auditEmptySub} />
      ) : (
        <>
          <div style={styles.list}>
            {entries.map(e => {
              const dt = formatDt(e.created_at, timezone, locale);
              return (
                <div key={e.id} style={styles.row}>
                  <div style={styles.rowTime}>
                    <span style={styles.rowDate}>{dt.date}</span>
                    <span style={styles.rowClock}>{dt.time}</span>
                  </div>
                  <div style={styles.rowBody}>
                    <div style={styles.rowTop}>
                      <ActionBadge action={e.action} actionMeta={ACTION_META} />
                      {e.entity_name && <span style={styles.entityName}>{e.entity_name}</span>}
                    </div>
                    <div style={styles.rowActor}>{t.auditBy} {e.actor_name}</div>
                    {e.details && Object.keys(e.details).length > 0 && (
                      <div style={styles.details}>
                        {Object.entries(e.details).map(([k, v]) => (
                          <span key={k} style={styles.detailChip}>{k}: {String(v)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div style={styles.pagination}>
              <button style={{ ...styles.pageBtn, ...(page === 0 || loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.firstPage} onClick={() => goTo(0)} disabled={page === 0 || loading}>«</button>
              <button style={{ ...styles.pageBtn, ...(page === 0 || loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => goTo(page - 1)} disabled={page === 0 || loading}>‹ {t.paginationPrev}</button>
              <span style={styles.pageInfo}>{t.paginationPage} {page + 1} {t.ofLabel} {totalPages}</span>
              <button style={{ ...styles.pageBtn, ...(page >= totalPages - 1 || loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => goTo(page + 1)} disabled={page >= totalPages - 1 || loading}>{t.paginationNext} ›</button>
              <button style={{ ...styles.pageBtn, ...(page >= totalPages - 1 || loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.lastPage} onClick={() => goTo(totalPages - 1)} disabled={page >= totalPages - 1 || loading}>»</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 },
  title: { fontSize: 17, fontWeight: 700, margin: 0 },
  totalBadge: { fontSize: 12, background: '#f3f4f6', color: '#6b7280', padding: '2px 10px', borderRadius: 20, fontWeight: 600 },
  filters: { display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  filterSelect: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, background: '#fff' },
  filterDate: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  clearBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer' },
  list: { display: 'flex', flexDirection: 'column', gap: 1 },
  row: { display: 'flex', gap: 16, padding: '12px 4px', borderBottom: '1px solid #f3f4f6', alignItems: 'flex-start' },
  rowTime: { display: 'flex', flexDirection: 'column', minWidth: 90, flexShrink: 0 },
  rowDate: { fontSize: 13, fontWeight: 500, color: '#374151' },
  rowClock: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 },
  entityName: { fontSize: 13, fontWeight: 600, color: '#111827' },
  rowActor: { fontSize: 12, color: '#6b7280' },
  details: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 },
  detailChip: { fontSize: 11, background: '#f9fafb', border: '1px solid #e5e7eb', color: '#6b7280', padding: '1px 7px', borderRadius: 4 },
  pagination: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 16, justifyContent: 'center' },
  pageBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '6px 12px', fontSize: 13, color: '#374151', cursor: 'pointer' },
  pageInfo: { fontSize: 13, color: '#6b7280', padding: '0 8px' },
};
