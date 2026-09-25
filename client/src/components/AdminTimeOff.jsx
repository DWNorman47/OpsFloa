import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { SkeletonList } from './Skeleton';
import { langToLocale } from '../utils';
import EmptyState from './EmptyState';
import { useConfirm } from './ConfirmDialog';

const TYPE_COLORS = { vacation: '#1d4ed8', sick: '#dc2626', personal: '#8b5cf6', other: '#6b7280' };
const STATUS_COLORS = { pending: '#d97706', approved: '#059669', denied: '#ef4444', revoked: '#6b7280' };

function fmt(d, locale = 'en-US') {
  if (!d) return '';
  return new Date(d.toString().substring(0, 10) + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Company working weekdays (0=Sun…6=Sat) from the Hours & Rules standard hours;
// Mon–Fri when none — mirrors the server (hoursRules.workDaysFromPolicy).
function workDaysFrom(settings) {
  try {
    const raw = settings?.hours_rules;
    const pol = typeof raw === 'string' && raw ? JSON.parse(raw) : (raw || {});
    const sh = pol?.standardHours || {};
    const d = Object.keys(sh).filter(k => sh[k] && sh[k].start && sh[k].end).map(Number).filter(n => n >= 0 && n <= 6);
    if (d.length) return new Set(d);
  } catch { /* fall through */ }
  return new Set([1, 2, 3, 4, 5]);
}

// Working days of [start,end] inside calendar year `year` (what the allowance counts).
function workingDaysInYear(start, end, year, workDays) {
  const lo = new Date(Math.max(Date.parse(start.substring(0, 10) + 'T00:00:00Z'), Date.UTC(year, 0, 1)));
  const hi = new Date(Math.min(Date.parse(end.substring(0, 10) + 'T00:00:00Z'), Date.UTC(year, 11, 31)));
  let n = 0;
  for (let d = lo; d <= hi; d = new Date(d.getTime() + 86400000)) if (workDays.has(d.getUTCDay())) n++;
  return n;
}

function days(start, end) {
  const s = new Date(start.substring(0, 10) + 'T00:00:00');
  const e = new Date(end.substring(0, 10) + 'T00:00:00');
  return Math.round((e - s) / 86400000) + 1;
}

export default function AdminTimeOff({ settings }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const toast = useToast();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [reviewNote, setReviewNote] = useState({});
  const [acting, setActing] = useState(null);
  const [actError, setActError] = useState('');
  const { confirm, dialog: confirmDialogEl } = useConfirm();
  // Per-employee sections default collapsed; track which are expanded.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleWorker = name => setExpanded(prev => {
    const n = new Set(prev);
    n.has(name) ? n.delete(name) : n.add(name);
    return n;
  });

  const annualDays = settings?.pto_annual_days || 0;

  // Used PTO per worker this year — approved VACATION only, working days only,
  // any request overlapping the year (same rule as the server's /balance).
  const currentYear = new Date().getFullYear();
  const workDays = workDaysFrom(settings);
  const dayHours = parseFloat(settings?.regular_shift_hours) > 0 ? parseFloat(settings.regular_shift_hours) : 8;
  const usedByWorker = {};
  requests.forEach(r => {
    if (r.status !== 'approved' || r.type !== 'vacation') return;
    const s0 = r.start_date.toString().substring(0, 10), e0 = r.end_date.toString().substring(0, 10);
    const d = (r.hours != null && s0 === e0)
      ? (Number(s0.substring(0, 4)) === currentYear ? (+r.hours) / dayHours : 0)
      : workingDaysInYear(s0, e0, currentYear, workDays);
    usedByWorker[r.worker_name] = Math.round(((usedByWorker[r.worker_name] || 0) + d) * 100) / 100;
  });

  const load = (status) => {
    setLoading(true);
    setLoadError(false);
    // Load all to compute balances accurately; filter client-side if needed
    api.get('/time-off', { params: {} })
      .then(r => setRequests(r.data))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(filter); }, [filter]);

  const act = async (id, action, extra = {}) => {
    if (action === 'revoke' && !(reviewNote[id] || '').trim()) { setActError(t.timeOffRevokeReasonRequired); return; }
    setActing(id + action);
    try {
      const body = action === 'revoke'
        ? { reason: reviewNote[id].trim() }
        : { review_note: reviewNote[id] || null, ...extra };
      const r = await api.patch(`/time-off/${id}/${action}`, body);
      setRequests(prev => prev.map(x => x.id === id ? { ...x, ...r.data } : x));
      setReviewNote(prev => { const n = { ...prev }; delete n[id]; return n; });
      toast(action === 'approve' ? t.requestApproved : action === 'revoke' ? t.timeOffRevokedToast : t.requestDenied, 'success');
    } catch (err) {
      const data = err.response?.data || {};
      if (err.response?.status === 409 && data.code === 'exceeds_allowance' && action === 'approve' && !extra.confirm) {
        setActing(null);
        const ok = await confirm({
          title: t.timeOffExceedsTitle,
          body: t.timeOffExceedsBody
            .replace('{request}', data.request_days).replace('{used}', data.used_days)
            .replace('{annual}', data.annual_days).replace('{year}', data.year),
          confirmLabel: t.timeOffApproveAnyway,
          tone: 'danger',
        });
        if (ok) return act(id, action, { confirm: true });
        return;
      }
      setActError(data.code === 'overlap' ? t.timeOffOverlapError : (data.error || t.actionFailed));
    } finally { setActing(null); }
  };

  const TYPE_LABELS = {
    vacation: t.timeOffVacation,
    sick: t.timeOffSick,
    personal: t.timeOffPersonal,
    other: t.timeOffOtherType,
  };
  const STATUS_LABELS = {
    pending: t.filterPending,
    approved: t.filterApproved,
    denied: t.filterDenied,
    revoked: t.timeOffStatusRevoked,
  };
  const FILTER_LABELS = {
    pending: t.filterPending,
    approved: t.filterApproved,
    denied: t.filterDenied,
    all: t.filterAll,
  };

  const visible = filter === 'all' ? requests : requests.filter(r => r.status === filter);
  // Group per employee. Within a worker, pending first then newest; employees
  // with pending requests sort to the top so they're easy to find while collapsed.
  const groups = (() => {
    const byWorker = new Map();
    for (const r of visible) {
      if (!byWorker.has(r.worker_name)) byWorker.set(r.worker_name, []);
      byWorker.get(r.worker_name).push(r);
    }
    return [...byWorker.entries()]
      .map(([worker, reqs]) => {
        const sorted = [...reqs].sort((a, b) => {
          const ap = a.status === 'pending', bp = b.status === 'pending';
          if (ap !== bp) return ap ? -1 : 1;
          return b.start_date.toString().localeCompare(a.start_date.toString());
        });
        return { worker, reqs: sorted, pendingCount: sorted.filter(x => x.status === 'pending').length };
      })
      .sort((a, b) => (b.pendingCount - a.pendingCount) || a.worker.localeCompare(b.worker));
  })();

  return (
    <div>
      <div style={s.headerRow}>
        <h2 style={s.title}>{t.timeOffRequests}</h2>
        <div style={s.filterGroup}>
          {['pending', 'approved', 'denied', 'all'].map(f => (
            <button key={f} style={{ ...s.filterBtn, ...(filter === f ? s.filterBtnActive : {}) }} onClick={() => setFilter(f)}>
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div style={s.loadError}>
          {t.failedLoadTimeOff}{' '}
          <button style={s.retryBtn} onClick={() => load(filter)}>{t.retry}</button>
        </div>
      ) : loading ? (
        <SkeletonList count={4} rows={2} />
      ) : visible.length === 0 ? (
        <EmptyState mark="T" title={t.noTimeOffRequests} body={t.timeOffEmptySub} tone={filter === 'pending' ? 'good' : 'neutral'} />
      ) : (
        <div style={s.list}>
          {groups.map(g => {
            const open = expanded.has(g.worker);
            const workerUsed = usedByWorker[g.worker] || 0;
            return (
            <div key={g.worker} style={s.group}>
              <button type="button" style={s.groupHeader} onClick={() => toggleWorker(g.worker)} aria-expanded={open}>
                <span style={s.groupChevron}>{open ? '▾' : '▸'}</span>
                <span style={s.groupName}>{g.worker}</span>
                {g.pendingCount > 0 && (
                  <span style={s.groupPending}>{g.pendingCount} {t.filterPending}</span>
                )}
                <span style={s.groupCount}>{g.reqs.length}</span>
                {annualDays > 0 && (
                  <span style={s.groupPto}>{workerUsed} / {annualDays} {t.days} {t.ptoUsed}</span>
                )}
              </button>

              {open && (
              <div style={s.groupBody}>
                {g.reqs.map(r => {
                  const d = days(r.start_date.toString(), r.end_date.toString());
                  return (
                  <div key={r.id} style={s.card}>
                    <div style={s.cardTop}>
                      <div style={s.dates}>
                        {fmt(r.start_date, locale)} – {fmt(r.end_date, locale)}
                        {r.hours != null
                          ? <span style={s.dayCount}>{(+r.hours)} {t.hoursShort}</span>
                          : <span style={s.dayCount}>{d} {d !== 1 ? t.daysLabel : t.dayLabel}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ ...s.typeBadge, background: TYPE_COLORS[r.type] + '22', color: TYPE_COLORS[r.type] }}>
                          {TYPE_LABELS[r.type] || r.type}
                        </span>
                        <span style={{ ...s.statusBadge, color: STATUS_COLORS[r.status] }}>
                          {STATUS_LABELS[r.status] || r.status}
                        </span>
                      </div>
                    </div>

                    {r.note && <p style={s.note}>{r.note}</p>}

                    {r.status === 'pending' && (
                      <div style={s.actionRow}>
                        <div style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column' }}>
                          <input
                            style={{ ...s.noteInput, flex: 'unset' }}
                            placeholder={t.reviewNotePlaceholder}
                            maxLength={500}
                            value={reviewNote[r.id] || ''}
                            onChange={e => setReviewNote(prev => ({ ...prev, [r.id]: e.target.value }))}
                          />
                          <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(reviewNote[r.id] || '').length}/500</div>
                        </div>
                        <button
                          style={{ ...s.approveBtn, ...(acting === r.id + 'approve' ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                          disabled={acting === r.id + 'approve'}
                          onClick={() => { setActError(''); act(r.id, 'approve'); }}
                        >
                          {acting === r.id + 'approve' ? t.saving : `✓ ${t.filterApproved}`}
                        </button>
                        <button
                          style={{ ...s.denyBtn, ...(acting === r.id + 'deny' ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                          disabled={acting === r.id + 'deny'}
                          onClick={() => { setActError(''); act(r.id, 'deny'); }}
                        >
                          {acting === r.id + 'deny' ? t.saving : t.denyAction}
                        </button>
                        {actError && <span style={s.actError}>{actError}</span>}
                      </div>
                    )}

                    {r.status === 'approved' && (
                      <div style={s.actionRow}>
                        <input
                          style={s.noteInput}
                          placeholder={t.timeOffRevokeReasonPlaceholder}
                          maxLength={500}
                          value={reviewNote[r.id] || ''}
                          onChange={e => setReviewNote(prev => ({ ...prev, [r.id]: e.target.value }))}
                        />
                        <button
                          style={{ ...s.revokeBtn, ...(acting === r.id + 'revoke' ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                          disabled={acting === r.id + 'revoke'}
                          onClick={() => { setActError(''); act(r.id, 'revoke'); }}
                        >
                          {acting === r.id + 'revoke' ? t.saving : t.timeOffRevoke}
                        </button>
                        {actError && <span style={s.actError}>{actError}</span>}
                      </div>
                    )}

                    {r.review_note && (
                      <p style={{ ...s.note, color: STATUS_COLORS[r.status] }}>{r.review_note}</p>
                    )}
                    {r.status === 'revoked' && r.revoke_reason && (
                      <p style={{ ...s.note, color: STATUS_COLORS.revoked }}>{t.timeOffStatusRevoked}: {r.revoke_reason}</p>
                    )}

                    <div style={s.meta}>
                      {t.submittedOn} {fmt(r.created_at, locale)}
                      {r.reviewer_name && ` · ${STATUS_LABELS[r.status] || r.status} by ${r.reviewer_name}`}
                    </div>
                  </div>
                  );
                })}
              </div>
              )}
            </div>
            );
          })}
        </div>
      )}
      {confirmDialogEl}
    </div>
  );
}

const s = {
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 },
  title: { fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 },
  filterGroup: { display: 'flex', gap: 4 },
  filterBtn: { padding: '6px 14px', border: '1px solid #e5e7eb', borderRadius: 7, background: '#f9fafb', color: '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  filterBtnActive: { background: 'var(--ops-page-accent)', color: '#fff', border: '1px solid var(--ops-page-accent)' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  group: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  groupHeader: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 18px', border: 'none', background: '#fff', cursor: 'pointer', textAlign: 'left' },
  groupChevron: { fontSize: 12, color: '#6b7280', width: 12, flexShrink: 0 },
  groupName: { fontSize: 15, fontWeight: 700, color: '#111827', flex: 1, minWidth: 0 },
  groupPending: { fontSize: 11, fontWeight: 700, color: '#d97706', background: '#fef3c7', padding: '2px 9px', borderRadius: 10, whiteSpace: 'nowrap' },
  groupCount: { fontSize: 12, color: '#6b7280', fontWeight: 600, minWidth: 18, textAlign: 'center' },
  groupPto: { fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' },
  groupBody: { display: 'flex', flexDirection: 'column', gap: 10, padding: '0 12px 12px', background: '#f9fafb' },
  card: { background: '#fff', borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 8 },
  workerName: { fontSize: 15, fontWeight: 700, color: '#111827' },
  ptoBadge: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  typeBadge: { fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
  statusBadge: { fontSize: 12, fontWeight: 700 },
  dates: { fontSize: 15, fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: 8 },
  dayCount: { fontSize: 12, color: '#6b7280', fontWeight: 400 },
  note: { fontSize: 13, color: '#6b7280', margin: '6px 0 0' },
  actionRow: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' },
  noteInput: { flex: 1, minWidth: 160, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13 },
  approveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  revokeBtn: { background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', padding: '7px 16px', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  denyBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  actError: { fontSize: 12, color: '#ef4444' },
  meta: { fontSize: 12, color: '#6b7280', marginTop: 8 },
  loadError: { background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', borderRadius: 8, padding: '12px 16px', fontSize: 14 },
  retryBtn: { background: 'none', border: 'none', color: '#dc2626', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0 },
};
