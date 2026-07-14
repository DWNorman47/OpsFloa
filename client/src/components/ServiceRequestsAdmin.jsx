/**
 * Admin view of customer-submitted service requests. Shows the public intake
 * URL, a toggle to enable/disable submissions, and a paginated list of
 * requests with status filters and conversion-to-work action.
 */

import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { silentError } from '../errorReporter';
import EmptyState from './EmptyState';
import { SkeletonList } from './Skeleton';
import { labelSg } from '../companyLabels';

const STATUS_FILTERS = [
  { key: 'new',       label: 'New' },
  { key: 'in_review', label: 'In review' },
  { key: 'converted', label: 'Converted' },
  { key: 'declined',  label: 'Declined' },
  { key: 'spam',      label: 'Spam' },
  { key: 'all',       label: 'All' },
];

export default function ServiceRequestsAdmin({ settings = null }) {
  const t = useT();
  const { user, updateUser } = useAuth();
  const clientLabel = labelSg(settings?.label_client, 'client', user?.language);
  const clientLabelLower = clientLabel.toLowerCase();
  const [accepting, setAccepting] = useState(!!user?.accepts_service_requests);
  const [savingToggle, setSavingToggle] = useState(false);
  const [filter, setFilter] = useState('new');
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [notesDraft, setNotesDraft] = useState({});
  const [convertingId, setConvertingId] = useState(null);
  const [error, setError] = useState('');
  const [recipients, setRecipients] = useState([]);
  const [recipientsLoaded, setRecipientsLoaded] = useState(false);

  const publicUrl = useMemo(() => {
    if (!user?.company_slug) return null;
    const origin = window.location.origin;
    return `${origin}/r/${user.company_slug}`;
  }, [user?.company_slug]);

  const load = () => {
    setLoading(true); setError('');
    api.get(`/admin/service-requests?status=${filter}`)
      .then(r => setRequests(r.data.requests || []))
      .catch(() => setError(t.srFailedToLoad))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  useEffect(() => {
    api.get('/admin/service-requests/recipients')
      .then(r => { setRecipients(r.data.recipients || []); setRecipientsLoaded(true); })
      .catch(silentError('servicerequests-recipients'));
  }, []);

  const toggleRecipient = async (userId, next) => {
    // Optimistic update
    setRecipients(rs => rs.map(u => u.id === userId ? { ...u, notify_service_requests: next } : u));
    try {
      await api.patch(`/admin/service-requests/recipients/${userId}`, { notify: next });
    } catch {
      // revert on failure
      setRecipients(rs => rs.map(u => u.id === userId ? { ...u, notify_service_requests: !next } : u));
    }
  };

  const toggleAccepting = async () => {
    setSavingToggle(true);
    try {
      const r = await api.patch('/admin/service-requests/settings', { accepts_service_requests: !accepting });
      setAccepting(r.data.accepts_service_requests);
      updateUser?.({ accepts_service_requests: r.data.accepts_service_requests });
    } catch { /* no-op */ } finally { setSavingToggle(false); }
  };

  const copyUrl = () => {
    if (!publicUrl) return;
    navigator.clipboard?.writeText(publicUrl).catch(silentError('servicerequests-copy'));
  };

  const updateStatus = async (id, status) => {
    try {
      await api.patch(`/admin/service-requests/${id}`, { status });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to update'); }
  };

  const saveNotes = async (id) => {
    try {
      await api.patch(`/admin/service-requests/${id}`, { admin_notes: notesDraft[id] || '' });
      setRequests(rs => rs.map(r => r.id === id ? { ...r, admin_notes: notesDraft[id] || '' } : r));
    } catch (err) { setError(err.response?.data?.error || 'Failed to save notes'); }
  };

  const convert = async (req) => {
    const projectName = window.prompt(
      `Project name:`,
      `${t.srProjectFromRequest || 'Request from'} ${req.requester_name}`,
    );
    if (!projectName) return;
    setConvertingId(req.id);
    try {
      await api.post(`/admin/service-requests/${req.id}/convert`, {
        project_name: projectName,
        address: req.requester_address || undefined,
      });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Conversion failed'); }
    finally { setConvertingId(null); }
  };

  const convertToWorkOrder = async (req) => {
    const title = window.prompt('Work order title:', `Service call — ${req.requester_name}`);
    if (!title) return;
    setConvertingId(req.id);
    try {
      await api.post(`/admin/service-requests/${req.id}/convert-work-order`, {
        title,
        address: req.requester_address || undefined,
      });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Conversion failed'); }
    finally { setConvertingId(null); }
  };

  return (
    <div style={s.wrap}>
      {/* Public URL + accepting toggle */}
      <div style={s.settingsCard}>
        <div style={{ flex: 1 }}>
          <div style={s.settingsLabel}>{t.srPublicIntakeForm}</div>
          {publicUrl ? (
            <div style={s.urlRow}>
              <code style={s.url}>{publicUrl}</code>
              <button onClick={copyUrl} style={s.copyBtn}>{t.copy}</button>
              <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={s.viewBtn}>{t.open}</a>
            </div>
          ) : (
            <div style={s.hint}>Your company needs a slug. Contact support to have one assigned.</div>
          )}
          <div style={s.hint}>Share this link with {clientLabelLower}s so they can submit service, support, or project requests.</div>
        </div>
        <div style={s.statusGroup}>
          <div style={accepting ? s.statusOn : s.statusOff}>
            <span style={s.statusDot}></span>
            {accepting ? 'Accepting requests' : 'Paused - form shows a pause message'}
          </div>
          <button
            type="button"
            onClick={toggleAccepting}
            disabled={savingToggle || !publicUrl}
            style={accepting ? s.pauseBtn : s.startBtn}
          >
            {savingToggle ? 'Saving...' : accepting ? 'Pause' : 'Start accepting'}
          </button>
        </div>
      </div>

      {/* Notification recipients */}
      {recipientsLoaded && (
        <div style={s.recipientsCard}>
          <div style={s.recipientsHeader}>
            <div>
              <div style={s.recipientsTitle}>{t.srNotificationRecipients}</div>
              <div style={s.recipientsHint}>Admins listed here receive an email + Inbox item for every new request.</div>
            </div>
            <div style={s.recipientsCount}>
              {recipients.filter(r => r.notify_service_requests).length} of {recipients.length} on
            </div>
          </div>
          <div style={s.recipientsList}>
            {recipients.map(r => (
              <label key={r.id} style={s.recipientRow}>
                <input
                  type="checkbox"
                  checked={!!r.notify_service_requests}
                  onChange={e => toggleRecipient(r.id, e.target.checked)}
                />
                <span style={s.recipientName}>{r.full_name}</span>
                {r.email ? (
                  <span style={s.recipientEmail}>{r.email}</span>
                ) : (
                  <span style={s.recipientNoEmail}>no email - won't be emailed</span>
                )}
              </label>
            ))}
          </div>
          <div style={s.recipientsFooter}>
            {'Edit available categories in Administration > Workspace > Advanced Controls > Service Request Categories.'}
          </div>
        </div>
      )}

      {/* Status filters */}
      <div style={s.filterBar}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={filter === f.key ? s.filterActive : s.filter}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div role="alert" style={s.error}>{error}</div>}

      {loading ? (
        <SkeletonList count={3} />
      ) : requests.length === 0 ? (
        <EmptyState
          mark="R"
          title={filter === 'all' ? 'No requests yet' : `No ${filter.replace('_', ' ')} requests`}
          body={`New ${clientLabelLower} requests will appear here when someone submits your intake form.`}
          tone={filter === 'new' ? 'good' : 'neutral'}
        />
      ) : (
        <div style={s.list}>
          {requests.map(r => {
            const open = expandedId === r.id;
            return (
              <div key={r.id} style={s.card}>
                <div style={s.row} onClick={() => setExpandedId(open ? null : r.id)}>
                  <div style={s.name}>{r.requester_name}</div>
                  <div style={s.categoryPill}>{r.category || 'Request'}</div>
                  <div style={s.statusPill(r.status)}>{r.status.replace('_', ' ')}</div>
                  <div style={s.created}>{new Date(r.created_at).toLocaleString()}</div>
                  <span style={s.chevron}>{open ? '▼' : '▶'}</span>
                </div>
                {open && (
                  <div style={s.detail}>
                    <div style={s.contact}>
                      {r.requester_email && <a href={`mailto:${r.requester_email}`} style={s.contactLink}>{r.requester_email}</a>}
                      {r.requester_phone && <a href={`tel:${r.requester_phone}`} style={s.contactLink}>{r.requester_phone}</a>}
                      {r.requester_address && <span style={s.contactText}>{r.requester_address}</span>}
                    </div>
                    <div style={s.descBlock}>{r.description}</div>
                    {r.converted_project_id && (
                      <div style={s.convertedLabel}>
                        Converted to project: <strong>{r.converted_project_name || `#${r.converted_project_id}`}</strong>
                      </div>
                    )}
                    {r.converted_work_order_id && (
                      <div style={s.convertedLabel}>
                        Converted to work order: <strong>{r.converted_work_order_title || `#${r.converted_work_order_id}`}</strong>
                      </div>
                    )}
                    <div style={s.notesBlock}>
                      <label style={s.notesLabel}>{t.srInternalNotes}</label>
                      <textarea
                        style={s.notesInput}
                        rows={2}
                        value={notesDraft[r.id] ?? r.admin_notes ?? ''}
                        onChange={e => setNotesDraft(d => ({ ...d, [r.id]: e.target.value }))}
                        placeholder={t.srAdminPrivateNotePlaceholder}
                      />
                      <button onClick={() => saveNotes(r.id)} style={s.smallBtn}>{t.srSaveNotes}</button>
                    </div>
                    <div style={s.actions}>
                      {r.status !== 'converted' && (
                        <>
                          {r.status === 'new' && (
                            <button onClick={() => updateStatus(r.id, 'in_review')} style={s.reviewBtn}>{t.srMarkInReview}</button>
                          )}
                          <button
                            onClick={() => convert(r)}
                            disabled={convertingId === r.id}
                            style={s.convertBtn}
                          >
                            {convertingId === r.id ? 'Converting...' : `Convert to project`}
                          </button>
                          <button
                            onClick={() => convertToWorkOrder(r)}
                            disabled={convertingId === r.id}
                            style={s.convertBtn}
                          >
                            {convertingId === r.id ? 'Converting...' : 'Convert to work order'}
                          </button>
                          <button onClick={() => updateStatus(r.id, 'declined')} style={s.declineBtn}>Decline</button>
                          <button onClick={() => updateStatus(r.id, 'spam')} style={s.spamBtn}>Spam</button>
                        </>
                      )}
                      {r.reviewed_by_name && (
                        <span style={s.reviewedBy}>
                          {r.status} by {r.reviewed_by_name} - {new Date(r.reviewed_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap:          { display: 'flex', flexDirection: 'column', gap: 16 },
  settingsCard:  { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  settingsLabel: { fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 },
  urlRow:        { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
  url:           { background: '#f3f4f6', padding: '6px 10px', borderRadius: 6, fontSize: 12, color: '#111827', fontFamily: 'ui-monospace, monospace' },
  copyBtn:       { padding: '6px 10px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  viewBtn:       { padding: '6px 10px', background: '#f3f4f6', color: '#374151', borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: 'none' },
  hint:          { fontSize: 12, color: '#6b7280', marginTop: 4 },
  statusGroup:   { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 },
  statusOn:      { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: '#d1fae5', color: '#065f46', fontSize: 12, fontWeight: 700 },
  statusOff:     { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 700 },
  statusDot:     { width: 8, height: 8, borderRadius: '50%', background: 'currentColor' },
  startBtn:      { padding: '7px 14px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  pauseBtn:      { padding: '7px 14px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  recipientsCard:   { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: 16 },
  recipientsHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
  recipientsTitle:  { fontSize: 14, fontWeight: 700, color: '#111827' },
  recipientsHint:   { fontSize: 12, color: '#6b7280', marginTop: 2 },
  recipientsCount:  { fontSize: 12, fontWeight: 600, color: '#059669' },
  recipientsList:   { display: 'flex', flexDirection: 'column', gap: 6 },
  recipientRow:     { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' },
  recipientName:    { fontSize: 13, fontWeight: 600, color: '#111827' },
  recipientEmail:   { fontSize: 12, color: '#6b7280', marginLeft: 'auto' },
  recipientNoEmail: { fontSize: 12, color: '#92400e', marginLeft: 'auto', fontStyle: 'italic' },
  recipientsFooter: { fontSize: 11, color: '#9ca3af', marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6' },
  filterBar:     { display: 'flex', gap: 6, flexWrap: 'wrap' },
  filter:        { padding: '6px 14px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  filterActive:  { padding: '6px 14px', background: 'var(--ops-page-accent)', border: '1px solid var(--ops-page-accent)', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' },
  error:         { color: '#991b1b', background: '#fee2e2', padding: 10, borderRadius: 7, fontSize: 13 },
  loading:       { color: '#6b7280', fontSize: 14, padding: 20, textAlign: 'center' },
  list:          { display: 'flex', flexDirection: 'column', gap: 8 },
  card:          { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' },
  row:           { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer', flexWrap: 'wrap' },
  name:          { fontSize: 14, fontWeight: 700, color: '#111827' },
  categoryPill:  { fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#4338ca', padding: '2px 8px', borderRadius: 8 },
  statusPill:    (status) => {
    const colors = {
      new:       { bg: '#dbeafe', fg: '#1e40af' },
      in_review: { bg: '#fef3c7', fg: '#92400e' },
      converted: { bg: '#d1fae5', fg: '#065f46' },
      declined:  { bg: '#f3f4f6', fg: '#4b5563' },
      spam:      { bg: '#fee2e2', fg: '#991b1b' },
    }[status] || { bg: '#f3f4f6', fg: '#4b5563' };
    return { fontSize: 11, fontWeight: 700, background: colors.bg, color: colors.fg, padding: '2px 8px', borderRadius: 8, textTransform: 'capitalize' };
  },
  created:       { fontSize: 11, color: '#6b7280', marginLeft: 'auto' },
  chevron:       { fontSize: 13, color: '#6b7280' },
  detail:        { padding: '0 14px 14px', borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 10 },
  contact:       { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13, color: '#374151', paddingTop: 10 },
  contactLink:   { color: 'var(--ops-page-accent)', textDecoration: 'none', fontWeight: 600 },
  contactText:   { color: '#4b5563' },
  descBlock:     { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 7, padding: 12, fontSize: 13, color: '#111827', whiteSpace: 'pre-wrap' },
  convertedLabel:{ fontSize: 13, color: '#065f46', background: '#d1fae5', padding: '6px 10px', borderRadius: 6 },
  notesBlock:    { display: 'flex', flexDirection: 'column', gap: 4 },
  notesLabel:    { fontSize: 12, fontWeight: 600, color: '#374151' },
  notesInput:    { padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' },
  smallBtn:      { padding: '5px 10px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer', alignSelf: 'flex-start' },
  actions:       { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  reviewBtn:     { padding: '7px 14px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  convertBtn:    { padding: '7px 14px', background: '#059669', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, color: '#fff', cursor: 'pointer' },
  declineBtn:    { padding: '7px 14px', background: 'none', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  spamBtn:       { padding: '7px 14px', background: 'none', border: '1px solid #fca5a5', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#b91c1c', cursor: 'pointer' },
  reviewedBy:    { fontSize: 11, color: '#6b7280', marginLeft: 'auto' },
};
