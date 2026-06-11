// Submittals — architect/owner approval workflow for material/equipment
// specs. Independent compliance module; mirrors the page patterns of
// EstimatesPage / ChangeOrdersPage.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import AppHeader from '../components/AppHeader';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import Pagination from '../components/Pagination';
import SortHeader, { sortRows } from '../components/SortHeader';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { formatDate, formatDateTime } from '../utils/format';
import { silentError } from '../errorReporter';

const STATUS_COLORS = {
  draft:             { bg: '#f3f4f6', fg: '#374151', label: 'Draft' },
  pending_internal:  { bg: '#fef3c7', fg: '#92400e', label: 'Pending Internal' },
  sent_to_reviewer:  { bg: '#dbeafe', fg: '#1d4ed8', label: 'Sent to Reviewer' },
  approved:          { bg: '#d1fae5', fg: '#065f46', label: 'Approved' },
  approved_as_noted: { bg: '#a7f3d0', fg: '#065f46', label: 'Approved As Noted' },
  revise_resubmit:   { bg: '#fed7aa', fg: '#9a3412', label: 'Revise & Resubmit' },
  rejected:          { bg: '#fee2e2', fg: '#991b1b', label: 'Rejected' },
  closed:            { bg: '#e0e7ff', fg: '#3730a3', label: 'Closed' },
  void:              { bg: '#e5e7eb', fg: '#6b7280', label: 'Void' },
};

const STAMPS = [
  { value: 'approved',          label: 'Approved' },
  { value: 'approved_as_noted', label: 'Approved As Noted' },
  { value: 'revise_resubmit',   label: 'Revise & Resubmit' },
  { value: 'rejected',          label: 'Rejected' },
];

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{c.label}</span>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

function SubmittalsList({ onOpen, onNew }) {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'required_by', dir: 'asc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (statusFilter) params.status = statusFilter;
      if (q) params.q = q;
      const { data } = await api.get('/submittals', { params });
      setItems(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [statusFilter, q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [statusFilter, q]);

  const sortedItems = useMemo(
    () => sortRows(items, sort, {
      required_by: r => r.required_by,
      revision: r => parseInt(r.revision, 10) || 0,
    }),
    [items, sort]
  );
  useEffect(() => {
    api.get('/admin/projects').then(({ data }) => setProjects(data || [])).catch(() => {});
    api.get('/submittals/overdue').then(({ data }) => setOverdue(data.items || [])).catch(() => {});
  }, []);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>Submittals</h1>
        <button onClick={() => onNew(projects)} style={styles.primaryBtn}>+ New Submittal</button>
      </div>

      {overdue.length > 0 && (
        <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#991b1b', marginBottom: 4 }}>
            {overdue.length} submittal{overdue.length === 1 ? '' : 's'} approaching required-by date
          </div>
          <div style={{ fontSize: 12, color: '#7f1d1d' }}>
            {overdue.slice(0, 3).map(o => o.submittal_number).join(', ')}
            {overdue.length > 3 && `, +${overdue.length - 3} more`}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search by title / number / description..."
          aria-label="Search submittals"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={styles.searchInput}
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          style={styles.select}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_COLORS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>
      {loading ? <SkeletonList rows={4} /> :
        items.length === 0 ? (
          <EmptyState
            title="No submittals yet"
            body="Track material and equipment specs for architect/owner approval before installation."
            actionLabel="+ New Submittal"
            onAction={() => onNew(projects)}
          />
        ) : (
          <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="submittal_number" sort={sort} setSort={setSort}>Number</SortHeader>
                  <SortHeader sortKey="spec_section" sort={sort} setSort={setSort}>Spec</SortHeader>
                  <SortHeader sortKey="title" sort={sort} setSort={setSort}>Title</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>Project</SortHeader>
                  <SortHeader sortKey="required_by" sort={sort} setSort={setSort}>Required by</SortHeader>
                  <SortHeader sortKey="revision" sort={sort} setSort={setSort}>Rev</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(s => (
                  <tr key={s.id} style={styles.tableRow} onClick={() => onOpen(s.id)}>
                    <td style={styles.td}><strong>{s.submittal_number}</strong></td>
                    <td style={styles.td}>{s.spec_section || '—'}</td>
                    <td style={styles.td}>{s.title}</td>
                    <td style={styles.td}>{s.project_name}</td>
                    <td style={styles.td}>{s.required_by ? new Date(s.required_by).toLocaleDateString() : '—'}</td>
                    <td style={styles.td}>{s.revision > 0 ? `R${s.revision}` : '—'}</td>
                    <td style={styles.td}><StatusBadge status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </div>
  );
}

// ── New form ─────────────────────────────────────────────────────────────────

function NewSubmittalForm({ projects, onSave, onCancel }) {
  const [form, setForm] = useState({
    project_id: projects[0]?.id || '',
    submittal_number: '',
    spec_section: '',
    title: '',
    description: '',
    reviewer_name: '',
    reviewer_email: '',
    reviewer_org: '',
    required_by: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  function update(k, v) { setDirty(true); setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    setError(null); setSaving(true);
    try {
      if (!form.project_id) { setError('Choose a project'); setSaving(false); return; }
      if (!form.title.trim()) { setError('Title is required'); setSaving(false); return; }
      if (!form.submittal_number.trim()) { setError('Submittal number is required'); setSaving(false); return; }
      const { project_id, ...payload } = form;
      const { data } = await api.post(`/projects/${project_id}/submittals`, payload);
      setDirty(false);
      onSave(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create submittal');
    } finally { setSaving(false); }
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>New Submittal</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={styles.ghostBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
      {error && <div style={styles.errorBox}>{error}</div>}
      <div style={styles.formCard}>
        <div style={styles.grid2}>
          <Field label="Project" required>
            <select value={form.project_id} onChange={e => update('project_id', e.target.value)} style={styles.input}>
              <option value="">— Choose —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Submittal number" required>
            <input value={form.submittal_number} onChange={e => update('submittal_number', e.target.value)} placeholder="e.g. SUB-A-001" style={styles.input} />
          </Field>
          <Field label="Spec section">
            <input value={form.spec_section} onChange={e => update('spec_section', e.target.value)} placeholder="e.g. 06 10 00" style={styles.input} />
          </Field>
          <Field label="Required by">
            <input type="date" value={form.required_by} onChange={e => update('required_by', e.target.value)} style={styles.input} />
          </Field>
        </div>
        <Field label="Title" required>
          <input value={form.title} onChange={e => update('title', e.target.value)} style={styles.input} />
        </Field>
        <Field label="Description">
          <textarea value={form.description} onChange={e => update('description', e.target.value)} style={{ ...styles.input, minHeight: 60 }} />
        </Field>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Reviewer (architect / owner)</h3>
        <div style={styles.grid2}>
          <Field label="Name">
            <input value={form.reviewer_name} onChange={e => update('reviewer_name', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Email">
            <input type="email" value={form.reviewer_email} onChange={e => update('reviewer_email', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Organization">
            <input value={form.reviewer_org} onChange={e => update('reviewer_org', e.target.value)} style={styles.input} />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Notes (internal)</h3>
        <textarea value={form.notes} onChange={e => update('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function SubmittalDetail({ id, onBack }) {
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [stampForm, setStampForm] = useState({ open: false, stamp: 'approved', response_notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/submittals/${id}`);
      setS(data);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function action(path, label) {
    setBusy(true); setError(null);
    try { await api.post(`/submittals/${id}/${path}`); await load(); }
    catch (err) { setError(err.response?.data?.error || `${label} failed`); }
    finally { setBusy(false); }
  }
  async function submitStamp() {
    setBusy(true); setError(null);
    try {
      await api.post(`/submittals/${id}/stamp`, {
        stamp: stampForm.stamp,
        response_notes: stampForm.response_notes || null,
      });
      setStampForm({ open: false, stamp: 'approved', response_notes: '' });
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Stamp failed'); }
    finally { setBusy(false); }
  }
  async function revise() {
    if (!await confirm({
      title: 'Create a new revision?',
      body: 'The current submittal will be marked superseded.',
      confirmLabel: 'Create revision',
    })) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post(`/submittals/${id}/revise`);
      onBack(); // navigate back; the new revision is a separate id in the list
    } catch (err) { setError(err.response?.data?.error || 'Revise failed'); setBusy(false); }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!s) return null;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to submittals</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>
            {s.submittal_number}{s.revision > 0 && <span style={{ fontSize: 14, color: '#6b7280' }}> · Rev {s.revision}</span>}
            {' '}<StatusBadge status={s.status} />
          </h1>
          <div style={{ fontSize: 16, color: '#374151', marginTop: 4 }}>{s.title}</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
            {s.project_name}{s.spec_section && ` · Spec ${s.spec_section}`}
            {s.required_by && ` · Required by ${new Date(s.required_by).toLocaleDateString()}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {s.status === 'draft' && (
            <button onClick={() => action('send-internal', 'Send')} disabled={busy} style={styles.primaryBtn}>Send Internal</button>
          )}
          {s.status === 'pending_internal' && (
            <button onClick={() => action('send-reviewer', 'Send')} disabled={busy} style={styles.primaryBtn}>Send to Reviewer</button>
          )}
          {s.status === 'sent_to_reviewer' && (
            <button onClick={() => setStampForm(f => ({ ...f, open: true }))} disabled={busy} style={styles.primaryBtn}>Record Stamp</button>
          )}
          {['approved', 'approved_as_noted'].includes(s.status) && (
            <button onClick={() => action('close', 'Close')} disabled={busy} style={styles.ghostBtn}>Close</button>
          )}
          {['revise_resubmit', 'rejected'].includes(s.status) && (
            <button onClick={revise} disabled={busy} style={styles.primaryBtn}>Create Revision</button>
          )}
          {s.status !== 'void' && (
            <button onClick={() => action('void', 'Void')} disabled={busy} style={{ ...styles.ghostBtn, color: '#991b1b', borderColor: '#fecaca' }}>Void</button>
          )}
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {stampForm.open && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>Record reviewer stamp</h3>
          <Field label="Stamp" required>
            <select value={stampForm.stamp} onChange={e => setStampForm(f => ({ ...f, stamp: e.target.value }))} style={styles.input}>
              {STAMPS.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
            </select>
          </Field>
          <Field label="Response notes (appended to submittal notes)">
            <textarea value={stampForm.response_notes} onChange={e => setStampForm(f => ({ ...f, response_notes: e.target.value }))} style={{ ...styles.input, minHeight: 60 }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setStampForm({ open: false, stamp: 'approved', response_notes: '' })} style={styles.ghostBtn}>Cancel</button>
            <button onClick={submitStamp} disabled={busy} style={styles.primaryBtn}>Record</button>
          </div>
        </div>
      )}

      {s.description && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Description</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, color: '#374151', margin: 0 }}>{s.description}</pre>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Reviewer</h3>
        <div style={styles.grid2}>
          <Info label="Name" value={s.reviewer_name} />
          <Info label="Organization" value={s.reviewer_org} />
          <Info label="Email" value={s.reviewer_email} />
          <Info label="Sent to reviewer" value={s.sent_to_reviewer_at ? new Date(s.sent_to_reviewer_at).toLocaleDateString() : null} />
        </div>
        {s.reviewer_stamp && (
          <div style={{ marginTop: 12, padding: 12, background: '#f9fafb', borderRadius: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Stamp received</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>
              {STAMPS.find(st => st.value === s.reviewer_stamp)?.label || s.reviewer_stamp}
            </div>
            {s.reviewer_responded_at && (
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                {new Date(s.reviewer_responded_at).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Documents ({s.documents?.length || 0})</h3>
        {!s.documents?.length ? (
          <div style={{ fontSize: 14, color: '#6b7280' }}>No documents attached.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {s.documents.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0' }}>
                    <strong>{d.name}</strong>{' '}
                    <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>{d.kind}</span>
                  </td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>
                    <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1a56db', fontSize: 13, fontWeight: 600 }}>Open</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {s.audit?.length > 0 && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Audit trail</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {s.audit.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '4px 0', color: '#6b7280' }}>{new Date(a.created_at).toLocaleString()}</td>
                  <td style={{ padding: '4px 0' }}><strong>{a.action.replace(/_/g, ' ')}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function SubmittalsPage() {
  const { user } = useAuth();
  const [view, setView] = useState({ kind: 'list' });

  function openNew(projects) { setView({ kind: 'form', projects }); }
  function openDetail(id)    { setView({ kind: 'detail', id }); }
  function backToList()      { setView({ kind: 'list' }); }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AppHeader currentApp="field" userRole={user?.role} />
      <main id="main-content">
        {view.kind === 'list'   && <SubmittalsList onOpen={openDetail} onNew={openNew} />}
        {view.kind === 'form'   && <NewSubmittalForm projects={view.projects || []} onSave={(saved) => setView({ kind: 'detail', id: saved.id })} onCancel={backToList} />}
        {view.kind === 'detail' && <SubmittalDetail id={view.id} onBack={backToList} />}
      </main>
    </div>
  );
}

// ── Small parts ──────────────────────────────────────────────────────────────

function Field({ label, required, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 14 }}>
      <span>
        {label}
        {required && (
          <>
            <span aria-hidden="true" style={{ color: '#ef4444' }}>*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </span>
      {children}
    </label>
  );
}
function Info({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: '#111827' }}>{value || '—'}</div>
    </div>
  );
}

const styles = {
  primaryBtn: { background: '#1a56db', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  searchInput: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, flex: 1, minWidth: 240 },
  select: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tableRow: { borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  td: { padding: '12px 14px', color: '#111827' },
  formCard: { background: '#fff', borderRadius: 8, padding: 20, marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' },
  formH3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
