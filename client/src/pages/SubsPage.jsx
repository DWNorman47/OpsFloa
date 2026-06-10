import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import AppHeader from '../components/AppHeader';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import MoneyInput from '../components/MoneyInput';
import Pagination from '../components/Pagination';
import SortHeader, { sortRows } from '../components/SortHeader';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { formatMoney } from '../utils/format';
import { silentError } from '../errorReporter';

// ── Constants ────────────────────────────────────────────────────────────────

const PO_STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', fg: '#374151', label: 'Draft' },
  issued:    { bg: '#dbeafe', fg: '#1d4ed8', label: 'Issued' },
  partial:   { bg: '#fef3c7', fg: '#92400e', label: 'Partial' },
  complete:  { bg: '#d1fae5', fg: '#065f46', label: 'Complete' },
  cancelled: { bg: '#e5e7eb', fg: '#6b7280', label: 'Cancelled' },
};

function StatusBadge({ status }) {
  const c = PO_STATUS_COLORS[status] || PO_STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {c.label}
    </span>
  );
}

const formatCents = (c) => formatMoney(c, { showCents: true });

// ── Subs directory ───────────────────────────────────────────────────────────

function SubsList({ onOpen, onNew }) {
  const [subs, setSubs] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (q) params.q = q;
      const { data } = await api.get('/subcontractors', { params });
      setSubs(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q]);

  const sortedSubs = useMemo(() => sortRows(subs, sort), [subs, sort]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search subs..."
          value={q}
          onChange={e => setQ(e.target.value)}
          style={styles.searchInput}
        />
        <button onClick={onNew} style={styles.primaryBtn}>+ New Sub</button>
      </div>
      {loading ? <SkeletonList rows={3} /> :
        subs.length === 0 ? (
          <EmptyState
            title="No subcontractors yet"
            body="Add the first sub to your directory. POs you issue to them roll up against the project's subs budget."
            actionLabel="+ New Sub"
            onAction={onNew}
          />
        ) : (
          <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="name" sort={sort} setSort={setSort}>Name</SortHeader>
                  <SortHeader sortKey="scope_specialty" sort={sort} setSort={setSort}>Scope</SortHeader>
                  <SortHeader sortKey="contact_name" sort={sort} setSort={setSort}>Contact</SortHeader>
                  <SortHeader sortKey="license_number" sort={sort} setSort={setSort}>License</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedSubs.map(s => (
                  <tr key={s.id} style={styles.tableRow} onClick={() => onOpen(s.id)}>
                    <td style={styles.td}><strong>{s.name}</strong></td>
                    <td style={styles.td}>{s.scope_specialty || '—'}</td>
                    <td style={styles.td}>
                      {s.contact_name && <div>{s.contact_name}</div>}
                      {s.contact_email && <div style={{ fontSize: 12, color: '#6b7280' }}>{s.contact_email}</div>}
                    </td>
                    <td style={styles.td}>{s.license_number || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </>
  );
}

function SubForm({ existing, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: existing?.name || '',
    contact_name: existing?.contact_name || '',
    contact_email: existing?.contact_email || '',
    contact_phone: existing?.contact_phone || '',
    license_number: existing?.license_number || '',
    scope_specialty: existing?.scope_specialty || '',
    notes: existing?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  function update(k, v) { setDirty(true); setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    setError(null); setSaving(true);
    try {
      const { data } = existing
        ? await api.patch(`/subcontractors/${existing.id}`, form)
        : await api.post('/subcontractors', form);
      setDirty(false);
      onSave(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save sub');
    } finally { setSaving(false); }
  }

  return (
    <div style={styles.formCard}>
      <h3 style={styles.formH3}>{existing ? 'Edit subcontractor' : 'New subcontractor'}</h3>
      {error && <div style={styles.errorBox}>{error}</div>}
      <div style={styles.grid2}>
        <Field label="Name" required>
          <input value={form.name} onChange={e => update('name', e.target.value)} style={styles.input} />
        </Field>
        <Field label="Scope specialty">
          <input value={form.scope_specialty} onChange={e => update('scope_specialty', e.target.value)} placeholder="e.g. Drywall, Electrical, HVAC" style={styles.input} />
        </Field>
        <Field label="Contact name">
          <input value={form.contact_name} onChange={e => update('contact_name', e.target.value)} style={styles.input} />
        </Field>
        <Field label="Contact email">
          <input type="email" value={form.contact_email} onChange={e => update('contact_email', e.target.value)} style={styles.input} />
        </Field>
        <Field label="Contact phone">
          <input value={form.contact_phone} onChange={e => update('contact_phone', e.target.value)} style={styles.input} />
        </Field>
        <Field label="License number">
          <input value={form.license_number} onChange={e => update('license_number', e.target.value)} style={styles.input} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea value={form.notes} onChange={e => update('notes', e.target.value)} style={{ ...styles.input, minHeight: 60 }} />
      </Field>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onCancel} style={styles.ghostBtn}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function SubDetail({ id, onBack, onEdit }) {
  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/subcontractors/${id}`);
      setSub(data);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <SkeletonList rows={3} />;
  if (!sub) return null;

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to subs</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>{sub.name}</h2>
          {sub.scope_specialty && <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>{sub.scope_specialty}</div>}
        </div>
        <button onClick={onEdit} style={styles.ghostBtn}>Edit</button>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Contact</h3>
        <div style={styles.grid2}>
          <Info label="Contact name" value={sub.contact_name} />
          <Info label="Email" value={sub.contact_email} />
          <Info label="Phone" value={sub.contact_phone} />
          <Info label="License" value={sub.license_number} />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Open POs ({sub.open_pos?.length || 0})</h3>
        {sub.open_pos?.length === 0 ? (
          <div style={{ fontSize: 14, color: '#6b7280' }}>No open POs.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {sub.open_pos.map(po => (
                <tr key={po.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0' }}><strong>{po.po_number}</strong></td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={po.status} /></td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>{formatCents(po.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {sub.documents?.length > 0 && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Documents ({sub.documents.length})</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {sub.documents.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0' }}><strong>{d.name}</strong> <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>{d.doc_type}</span></td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>
                    {d.expires_on && <span style={{ fontSize: 12, color: '#6b7280' }}>Expires {new Date(d.expires_on).toLocaleDateString()}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sub.notes && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Notes</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{sub.notes}</pre>
        </div>
      )}
    </>
  );
}

// ── Sub POs portfolio ────────────────────────────────────────────────────────

function SubPOsList({ onOpen }) {
  const [pos, setPos] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (statusFilter) params.status = statusFilter;
      const { data } = await api.get('/subcontract-pos', { params });
      setPos(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [statusFilter, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [statusFilter]);

  const sortedPos = useMemo(
    () => sortRows(pos, sort, {
      amount_cents: r => parseFloat(r.amount_cents) || 0,
      paid_cents: r => parseFloat(r.paid_cents) || 0,
    }),
    [pos, sort]
  );

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={styles.select}>
          <option value="">All statuses</option>
          {Object.entries(PO_STATUS_COLORS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>
      {loading ? <SkeletonList rows={3} /> :
        pos.length === 0 ? (
          <EmptyState
            title="No purchase orders yet"
            body="Sub POs are created against a specific project. Open a project to add one."
          />
        ) : (
          <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="po_number" sort={sort} setSort={setSort}>PO #</SortHeader>
                  <SortHeader sortKey="sub_name" sort={sort} setSort={setSort}>Sub</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>Project</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>Status</SortHeader>
                  <SortHeader sortKey="amount_cents" sort={sort} setSort={setSort} align="right">Amount</SortHeader>
                  <SortHeader sortKey="paid_cents" sort={sort} setSort={setSort} align="right">Paid</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedPos.map(po => (
                  <tr key={po.id} style={styles.tableRow} onClick={() => onOpen(po.id)}>
                    <td style={styles.td}><strong>{po.po_number}</strong></td>
                    <td style={styles.td}>{po.sub_name}</td>
                    <td style={styles.td}>{po.project_name}</td>
                    <td style={styles.td}><StatusBadge status={po.status} /></td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(po.amount_cents)}</td>
                    <td style={{ ...styles.td, textAlign: 'right', color: '#6b7280' }}>{formatCents(po.paid_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </>
  );
}

function SubPODetail({ id, onBack }) {
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [po, setPo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showPayForm, setShowPayForm] = useState(false);
  const [payForm, setPayForm] = useState({ amount_cents: 0, paid_date: new Date().toISOString().slice(0, 10), invoice_ref: '', notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/subcontract-pos/${id}`);
      setPo(data);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function issue() {
    setBusy(true); setError(null);
    try {
      await api.post(`/subcontract-pos/${id}/issue`);
      toast('PO issued', 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || 'Issue failed'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!await confirm({
      title: 'Cancel this PO?',
      body: 'Already-recorded payments remain in "spent" — only the open commitment evaporates.',
      confirmLabel: 'Cancel PO',
      tone: 'danger',
    })) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/subcontract-pos/${id}/cancel`);
      toast('PO cancelled', 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || 'Cancel failed'); }
    finally { setBusy(false); }
  }
  async function recordPayment() {
    setBusy(true); setError(null);
    try {
      const amt = parseInt(payForm.amount_cents, 10);
      if (!Number.isFinite(amt) || amt < 0) {
        setError('Amount must be a positive amount');
        setBusy(false);
        return;
      }
      await api.post(`/subcontract-pos/${id}/payments`, {
        amount_cents: amt,
        paid_date: payForm.paid_date,
        invoice_ref: payForm.invoice_ref || null,
        notes: payForm.notes || null,
      });
      toast('Payment recorded', 'success');
      setShowPayForm(false);
      setPayForm({ amount_cents: 0, paid_date: new Date().toISOString().slice(0, 10), invoice_ref: '', notes: '' });
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Payment failed'); }
    finally { setBusy(false); }
  }

  if (loading) return <SkeletonList rows={3} />;
  if (!po) return null;

  return (
    <>
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to POs</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>
            {po.po_number} <StatusBadge status={po.status} />
          </h2>
          <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
            {po.sub_name} · {po.project_name}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {po.status === 'draft' && (
            <button onClick={issue} disabled={busy} style={styles.primaryBtn}>
              {busy ? '...' : 'Issue PO'}
            </button>
          )}
          {['draft', 'issued', 'partial'].includes(po.status) && (
            <button onClick={cancel} disabled={busy} style={{ ...styles.ghostBtn, color: '#991b1b', borderColor: '#fecaca' }}>
              Cancel PO
            </button>
          )}
          {['issued', 'partial'].includes(po.status) && (
            <button onClick={() => setShowPayForm(true)} style={styles.primaryBtn}>
              Record payment
            </button>
          )}
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Summary</h3>
        <div style={styles.grid4}>
          <Info label="Amount" value={formatCents(po.amount_cents)} />
          <Info label="Paid" value={formatCents(po.paid_cents)} />
          <Info label="Remaining" value={formatCents(po.remaining_cents)} />
          <Info label="Retainage" value={`${po.retainage_pct}%`} />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Scope of work</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, color: '#374151', margin: 0 }}>
          {po.scope_of_work}
        </pre>
      </div>

      {showPayForm && (
        <div style={{ ...styles.formCard, background: '#fef3c7' }}>
          <h3 style={styles.formH3}>Record payment</h3>
          <div style={styles.grid2}>
            <Field label="Amount" required>
              <MoneyInput
                valueCents={payForm.amount_cents}
                onChange={cents => setPayForm(f => ({ ...f, amount_cents: cents }))}
              />
            </Field>
            <Field label="Paid date" required>
              <input
                type="date"
                value={payForm.paid_date}
                onChange={e => setPayForm(f => ({ ...f, paid_date: e.target.value }))}
                style={styles.input}
              />
            </Field>
            <Field label="Invoice ref">
              <input
                value={payForm.invoice_ref}
                onChange={e => setPayForm(f => ({ ...f, invoice_ref: e.target.value }))}
                style={styles.input}
              />
            </Field>
            <Field label="Notes">
              <input
                value={payForm.notes}
                onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
                style={styles.input}
              />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setShowPayForm(false)} style={styles.ghostBtn}>Cancel</button>
            <button onClick={recordPayment} disabled={busy} style={styles.primaryBtn}>
              {busy ? '...' : 'Record'}
            </button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Payments ({po.payments?.length || 0})</h3>
        {!po.payments?.length ? (
          <div style={{ fontSize: 14, color: '#6b7280' }}>No payments recorded.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ ...styles.th, padding: '8px 0' }}>Date</th>
                <th style={{ ...styles.th, padding: '8px 0' }}>Amount</th>
                <th style={{ ...styles.th, padding: '8px 0' }}>Invoice ref</th>
                <th style={{ ...styles.th, padding: '8px 0' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {po.payments.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0' }}>{new Date(p.paid_date).toLocaleDateString()}</td>
                  <td style={{ padding: '8px 0' }}><strong>{formatCents(p.amount_cents)}</strong></td>
                  <td style={{ padding: '8px 0' }}>{p.invoice_ref || '—'}</td>
                  <td style={{ padding: '8px 0', color: '#6b7280' }}>{p.notes || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function SubsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('subs');
  const [view, setView] = useState({ kind: 'list' });

  function openSub(id)    { setView({ kind: 'sub-detail', id }); }
  function openSubNew()   { setView({ kind: 'sub-form', existing: null }); }
  function openSubEdit(s) { setView({ kind: 'sub-form', existing: s }); }
  function openPo(id)     { setView({ kind: 'po-detail', id }); }
  function backToList()   { setView({ kind: 'list' }); }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AppHeader currentApp="subs" userRole={user?.role} />
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>Subcontractors</h1>
        <div style={styles.tabRow}>
          <button
            onClick={() => { setTab('subs'); setView({ kind: 'list' }); }}
            style={{ ...styles.tabBtn, ...(tab === 'subs' ? styles.tabBtnActive : {}) }}
          >
            Directory
          </button>
          <button
            onClick={() => { setTab('pos'); setView({ kind: 'list' }); }}
            style={{ ...styles.tabBtn, ...(tab === 'pos' ? styles.tabBtnActive : {}) }}
          >
            Purchase Orders
          </button>
        </div>

        {tab === 'subs' && view.kind === 'list'        && <SubsList onOpen={openSub} onNew={openSubNew} />}
        {tab === 'subs' && view.kind === 'sub-form'    && <SubForm existing={view.existing} onSave={(s) => openSub(s.id)} onCancel={() => view.existing ? openSub(view.existing.id) : backToList()} />}
        {tab === 'subs' && view.kind === 'sub-detail'  && <SubDetail id={view.id} onBack={backToList} onEdit={() => openSubEdit({ id: view.id })} />}

        {tab === 'pos' && view.kind === 'list'        && <SubPOsList onOpen={openPo} />}
        {tab === 'pos' && view.kind === 'po-detail'   && <SubPODetail id={view.id} onBack={backToList} />}
      </div>
    </div>
  );
}

// ── Small parts ──────────────────────────────────────────────────────────────

function Field({ label, required, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
      {label}{required && <span style={{ color: '#ef4444' }}>*</span>}
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
  tabRow: { display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb' },
  tabBtn: { background: 'transparent', border: 'none', borderBottom: '2px solid transparent', padding: '10px 16px', fontSize: 14, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  tabBtnActive: { borderBottomColor: '#1a56db', color: '#1a56db' },
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
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
