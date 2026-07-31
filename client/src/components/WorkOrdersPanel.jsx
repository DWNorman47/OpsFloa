import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { silentError } from '../errorReporter';
import { usePerm } from '../hooks/usePerm';
import { useAuth } from '../contexts/AuthContext';

const STATUSES = [
  { v: 'open', label: 'Open' },
  { v: 'scheduled', label: 'Scheduled' },
  { v: 'in_progress', label: 'In progress' },
  { v: 'completed', label: 'Completed' },
  { v: 'canceled', label: 'Canceled' },
];
const PRIORITIES = [
  { v: 'low', label: 'Low' },
  { v: 'normal', label: 'Normal' },
  { v: 'high', label: 'High' },
  { v: 'urgent', label: 'Urgent' },
];
const STATUS_COLOR = {
  open: '#64748b', scheduled: '#2563eb', in_progress: '#0d9488',
  completed: '#16a34a', canceled: '#94a3b8',
};
const PRIORITY_COLOR = { low: '#94a3b8', normal: '#64748b', high: '#d97706', urgent: '#dc2626' };

const BLANK = {
  title: '', client_id: '', project_id: '', address: '', status: 'open',
  priority: 'normal', assigned_to: '', scheduled_at: '', amount: '', description: '',
};

// TIMESTAMPTZ <-> <input type="datetime-local"> (which wants 'YYYY-MM-DDTHH:MM')
const toLocalInput = ts => (ts ? String(ts).slice(0, 16) : '');
const fmtWhen = ts => {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export const workOrderDisplayName = record => (
  record?.name || record?.full_name || record?.invoice_name || record?.username || ''
);

export default function WorkOrdersPanel() {
  const canManage = usePerm('manage_projects');
  const { user } = useAuth();
  const [orders, setOrders] = useState([]);
  const [clients, setClients] = useState([]);
  const [projects, setProjects] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null = closed; {} or a work order
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // 'active' | 'all' | a status

  const load = () => {
    setLoading(true);
    api.get('/work-orders')
      .then(r => setOrders(r.data || []))
      .catch(silentError('work orders'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    api.get('/admin/clients').then(r => setClients(r.data || [])).catch(silentError('wo clients'));
    api.get('/work').then(r => setProjects(r.data || [])).catch(silentError('wo projects'));
    api.get('/admin/workers').then(r => setWorkers(r.data || [])).catch(silentError('wo workers'));
  }, []);

  const nameOf = (list, id) => workOrderDisplayName(list.find(x => String(x.id) === String(id)));

  const openNew = () => { setForm(BLANK); setEditing({}); setError(''); };
  const openEdit = wo => {
    setForm({
      title: wo.title || '', client_id: wo.client_id || '', project_id: wo.project_id || '',
      address: wo.address || '', status: wo.status || 'open', priority: wo.priority || 'normal',
      assigned_to: wo.assigned_to || '', scheduled_at: toLocalInput(wo.scheduled_at),
      amount: wo.amount ?? '', description: wo.description || '',
    });
    setEditing(wo); setError('');
  };
  const close = () => { setEditing(null); setError(''); };

  const save = async () => {
    if (!form.title.trim()) { setError('A title is required.'); return; }
    setSaving(true); setError('');
    try {
      if (editing && editing.id) await api.patch(`/work-orders/${editing.id}`, form, { suppressToast: true });
      else await api.post('/work-orders', form, { suppressToast: true });
      close(); load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save the work order.');
    } finally { setSaving(false); }
  };

  const remove = async wo => {
    if (!window.confirm('Delete this work order?')) return;
    try { await api.delete(`/work-orders/${wo.id}`, { suppressToast: true }); close(); load(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not delete.'); }
  };

  // field-worker update: status + notes only, on their own assigned job
  const saveStatus = async () => {
    setSaving(true); setError('');
    try {
      await api.patch(`/work-orders/${editing.id}/status`,
        { status: form.status, description: form.description }, { suppressToast: true });
      close(); load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not update the work order.');
    } finally { setSaving(false); }
  };

  const visible = useMemo(() => {
    if (statusFilter === 'all') return orders;
    if (statusFilter === 'active') return orders.filter(o => o.status !== 'completed' && o.status !== 'canceled');
    return orders.filter(o => o.status === statusFilter);
  }, [orders, statusFilter]);

  const isAssignee = !!(editing && editing.id && user && editing.assigned_to === user.id);
  const canFieldUpdate = !canManage && isAssignee;   // tech can move status + notes
  const canEdit = canManage || canFieldUpdate;
  const lockAll = !canManage;                         // general fields: managers only
  const lockStatus = !canManage && !isAssignee;       // status + notes: manager or assignee

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        {canManage && <button className="ops-button-primary" onClick={openNew}>+ New work order</button>}
        <select style={styles.filter} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="active">Active</option>
          <option value="all">All</option>
          {STATUSES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <span style={styles.count}>{visible.length} work order{visible.length === 1 ? '' : 's'}</span>
      </div>

      {loading ? (
        <div style={styles.muted}>Loading…</div>
      ) : !visible.length ? (
        <div style={styles.empty}>
          No work orders here. A work order is a single job — a service call, a warranty callback, or a T&M extra.
        </div>
      ) : (
        <div style={styles.list}>
          {visible.map(wo => (
            <button key={wo.id} style={styles.row} onClick={() => openEdit(wo)}>
              <span style={styles.rowMain}>
                <span style={styles.rowTitle}>{wo.title}</span>
                <span style={styles.rowSub}>
                  {[nameOf(clients, wo.client_id), nameOf(projects, wo.project_id) && `↳ ${nameOf(projects, wo.project_id)}`,
                    nameOf(workers, wo.assigned_to), fmtWhen(wo.scheduled_at)].filter(Boolean).join(' · ') || 'No details yet'}
                </span>
              </span>
              <span style={styles.rowRight}>
                {wo.priority && wo.priority !== 'normal' && (
                  <span style={{ ...styles.pill, background: PRIORITY_COLOR[wo.priority] }}>{wo.priority}</span>
                )}
                <span style={{ ...styles.pill, background: STATUS_COLOR[wo.status] || '#64748b' }}>
                  {(STATUSES.find(s => s.v === wo.status) || {}).label || wo.status}
                </span>
                {wo.amount != null && wo.amount !== '' && <span style={styles.amt}>${Number(wo.amount).toLocaleString()}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {editing && (
        <div style={styles.modalBg} onClick={close}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>{editing.id ? (canManage ? 'Edit work order' : 'Work order') : 'New work order'}</h3>
            <div style={styles.grid}>
              <label style={styles.full}>Title
                <input style={styles.input} value={form.title} maxLength={255} disabled={lockAll}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Fix AC — no cooling" />
              </label>
              <label>Customer
                <select style={styles.input} value={form.client_id} disabled={lockAll} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}>
                  <option value="">—</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label>Project <span style={styles.optional}>(optional)</span>
                <select style={styles.input} value={form.project_id} disabled={lockAll} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                  <option value="">Standalone (service call)</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label style={styles.full}>Address
                <input style={styles.input} value={form.address} disabled={lockAll} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
              </label>
              <label>Status
                <select style={styles.input} value={form.status} disabled={lockStatus} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  {STATUSES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                </select>
              </label>
              <label>Priority
                <select style={styles.input} value={form.priority} disabled={lockAll} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                  {PRIORITIES.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
                </select>
              </label>
              <label>Assigned to
                <select style={styles.input} value={form.assigned_to} disabled={lockAll} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{workOrderDisplayName(w)}</option>)}
                </select>
              </label>
              <label>Scheduled
                <input type="datetime-local" style={styles.input} value={form.scheduled_at} disabled={lockAll}
                  onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))} />
              </label>
              <label>Amount ($)
                <input type="number" min="0" step="0.01" style={styles.input} value={form.amount} disabled={lockAll}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
              </label>
              <label style={styles.full}>Notes
                <textarea style={{ ...styles.input, minHeight: 70, resize: 'vertical' }} value={form.description} disabled={lockStatus}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </label>
            </div>
            {canFieldUpdate && <div style={styles.fieldHint}>You're assigned to this job — you can update its status and notes.</div>}
            {error && <div style={styles.error}>{error}</div>}
            <div style={styles.actions}>
              {canManage && editing.id && <button className="ops-button" style={styles.del} onClick={() => remove(editing)}>Delete</button>}
              <span style={{ flex: 1 }} />
              <button className="ops-button" onClick={close} disabled={saving}>{canEdit ? 'Cancel' : 'Close'}</button>
              {canEdit && (
                <button className="ops-button-primary" onClick={canManage ? save : saveStatus} disabled={saving}>
                  {saving ? 'Saving…' : (canManage ? 'Save' : 'Save status')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { padding: '4px 0 24px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 },
  filter: { padding: '7px 9px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#0f172a', fontSize: 13.5 },
  count: { color: '#94a3b8', fontSize: 13 },
  muted: { color: '#94a3b8', padding: 20 },
  empty: { color: '#64748b', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 28, textAlign: 'center', lineHeight: 1.6 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textAlign: 'left',
    padding: '12px 14px', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', cursor: 'pointer', width: '100%',
  },
  rowMain: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  rowTitle: { fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSub: { fontSize: 12.5, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  pill: { color: '#fff', fontSize: 11, fontWeight: 700, textTransform: 'capitalize', borderRadius: 999, padding: '2px 9px' },
  amt: { fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  modalBg: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90, padding: 16 },
  modal: { background: '#fff', borderRadius: 14, padding: 20, width: 'min(640px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.3)' },
  modalTitle: { margin: '0 0 14px', fontSize: 18, color: '#0f172a' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 },
  fieldHint: { marginTop: 10, fontSize: 12.5, color: '#0d9488' },
  full: { gridColumn: '1 / -1' },
  input: { width: '100%', boxSizing: 'border-box', marginTop: 5, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff', color: '#0f172a' },
  optional: { color: '#94a3b8', fontWeight: 400, fontSize: 12 },
  error: { marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13.5, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 },
  del: { color: '#b91c1c', borderColor: '#fecaca' },
};
