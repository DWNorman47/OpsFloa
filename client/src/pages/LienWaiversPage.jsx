// Lien waivers — compliance tracking in both directions (from_sub / from_us)
// across 4 waiver types (conditional/unconditional × progress/final).
// The closeout module's auto-status checklist items read from the waiver
// status here, so receiving a sub waiver flips the closeout's
// "lien_waivers_subs" item to done in real time.

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

const STATUS_COLORS = {
  draft:      { bg: '#f3f4f6', fg: '#374151', label: 'Draft' },
  sent:       { bg: '#dbeafe', fg: '#1d4ed8', label: 'Sent' },
  signed:     { bg: '#d1fae5', fg: '#065f46', label: 'Signed' },
  received:   { bg: '#a7f3d0', fg: '#065f46', label: 'Received' },
  superseded: { bg: '#e5e7eb', fg: '#6b7280', label: 'Superseded' },
  void:       { bg: '#e5e7eb', fg: '#9ca3af', label: 'Void' },
};

const TYPE_LABELS = {
  conditional_progress:    'Conditional · Progress',
  unconditional_progress:  'Unconditional · Progress',
  conditional_final:       'Conditional · Final',
  unconditional_final:     'Unconditional · Final',
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{c.label}</span>
  );
}

function DirectionBadge({ direction }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: direction === 'from_sub' ? '#9a3412' : '#0e7490',
      background: direction === 'from_sub' ? '#fed7aa' : '#cffafe',
      padding: '2px 6px', borderRadius: 8, textTransform: 'uppercase',
    }}>
      {direction === 'from_sub' ? 'From Sub' : 'From Us'}
    </span>
  );
}

const formatCents = (c) => formatMoney(c, { showCents: true });

// ── List ─────────────────────────────────────────────────────────────────────

function LienWaiversList({ onOpen, onNew }) {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  const [outstanding, setOutstanding] = useState([]);
  const [projects, setProjects] = useState([]);
  const [subs, setSubs] = useState([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'through_date', dir: 'desc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (statusFilter) params.status = statusFilter;
      if (dirFilter) params.direction = dirFilter;
      const { data } = await api.get('/lien-waivers', { params });
      setItems(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [statusFilter, dirFilter, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [statusFilter, dirFilter]);

  const sortedItems = useMemo(
    () => sortRows(items, sort, {
      amount_cents: r => parseFloat(r.amount_cents) || 0,
      through_date: r => r.through_date,
      project_name: r => r.project_name,
    }),
    [items, sort]
  );
  useEffect(() => {
    api.get('/lien-waivers/outstanding').then(({ data }) => setOutstanding(data.items || [])).catch(() => {});
    api.get('/admin/projects').then(({ data }) => setProjects(data || [])).catch(() => {});
    api.get('/subcontractors').then(({ data }) => setSubs(data.items || [])).catch(() => {});
  }, []);

  return (
    <div className="admin-page-shell" style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px' }}>
      <div className="admin-page-header">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>Lien Waivers</h1>
        <button onClick={() => onNew({ projects, subs })} style={styles.primaryBtn}>+ New Waiver</button>
      </div>

      {outstanding.length > 0 && (
        <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>
            {outstanding.length} sub payment{outstanding.length === 1 ? '' : 's'} require a waiver but haven't received one
          </div>
          <div style={{ fontSize: 12, color: '#7c3a00' }}>
            {outstanding.slice(0, 3).map(o => `${o.subcontractor_name || 'Unknown sub'} (${o.po_number})`).join(', ')}
            {outstanding.length > 3 && `, +${outstanding.length - 3} more`}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
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
        <select
          value={dirFilter}
          onChange={e => setDirFilter(e.target.value)}
          aria-label="Filter by direction"
          style={styles.select}
        >
          <option value="">All directions</option>
          <option value="from_sub">From Sub</option>
          <option value="from_us">From Us</option>
        </select>
      </div>

      {loading ? <SkeletonList rows={4} /> :
        items.length === 0 ? (
          <EmptyState
            title="No lien waivers yet"
            body="Track conditional/unconditional waivers signed in either direction so retainage release is well-documented."
            actionLabel="+ New Waiver"
            onAction={() => onNew({ projects, subs })}
          />
        ) : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="direction" sort={sort} setSort={setSort}>Direction</SortHeader>
                  <SortHeader sortKey="waiver_type" sort={sort} setSort={setSort}>Type</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>Project / Sub</SortHeader>
                  <SortHeader sortKey="amount_cents" sort={sort} setSort={setSort} align="right">Amount</SortHeader>
                  <SortHeader sortKey="through_date" sort={sort} setSort={setSort}>Through</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(w => (
                  <tr key={w.id} style={styles.tableRow} onClick={() => onOpen(w.id)}>
                    <td style={styles.td}><DirectionBadge direction={w.direction} /></td>
                    <td style={styles.td}>{TYPE_LABELS[w.waiver_type] || w.waiver_type}</td>
                    <td style={styles.td}>
                      <div>{w.project_name}</div>
                      {w.subcontractor_name && <div style={{ fontSize: 12, color: '#6b7280' }}>{w.subcontractor_name}</div>}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(w.amount_cents)}</td>
                    <td style={styles.td}>{new Date(w.through_date).toLocaleDateString()}</td>
                    <td style={styles.td}><StatusBadge status={w.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-cards-mobile">
            {sortedItems.map(w => (
              <div
                key={w.id}
                className="admin-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(w.id)}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen(w.id))}
              >
                <div className="admin-card-row">
                  <span className="admin-card-title">{TYPE_LABELS[w.waiver_type] || w.waiver_type}</span>
                  <DirectionBadge direction={w.direction} />
                </div>
                <div className="admin-card-sub">{w.project_name}</div>
                {w.subcontractor_name && <div className="admin-card-sub">{w.subcontractor_name}</div>}
                <div className="admin-card-row">
                  <span className="admin-card-sub">Through {new Date(w.through_date).toLocaleDateString()}</span>
                  <StatusBadge status={w.status} />
                </div>
                <div className="admin-card-row">
                  <span />
                  <strong style={{ fontSize: 14 }}>{formatCents(w.amount_cents)}</strong>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </div>
  );
}

// ── New form ─────────────────────────────────────────────────────────────────

function NewLienWaiverForm({ projects, subs, onSave, onCancel }) {
  const [form, setForm] = useState({
    project_id: projects[0]?.id || '',
    direction: 'from_sub',
    waiver_type: 'conditional_progress',
    subcontractor_id: '',
    amount_cents: 0,
    through_date: new Date().toISOString().slice(0, 10),
    state: '',
    signer_name: '',
    signer_title: '',
    signer_company: '',
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
      if (form.direction === 'from_sub' && !form.subcontractor_id) {
        setError('Subcontractor is required for from_sub waivers'); setSaving(false); return;
      }
      const amt = parseInt(form.amount_cents, 10);
      if (!Number.isFinite(amt) || amt < 0) {
        setError('Amount (cents) must be a non-negative integer'); setSaving(false); return;
      }
      const { project_id, ...rest } = form;
      const payload = {
        ...rest,
        amount_cents: amt,
        subcontractor_id: form.subcontractor_id || null,
      };
      const { data } = await api.post(`/projects/${project_id}/lien-waivers`, payload);
      setDirty(false);
      onSave(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create waiver');
    } finally { setSaving(false); }
  }

  const isFromSub = form.direction === 'from_sub';

  return (
    <div className="admin-page-shell" style={{ maxWidth: 800, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>New Lien Waiver</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={styles.ghostBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Direction &amp; type</h3>
        <div className="admin-form-grid-2">
          <Field label="Direction" required>
            <select value={form.direction} onChange={e => update('direction', e.target.value)} style={styles.input}>
              <option value="from_sub">From Sub (sub waives against us)</option>
              <option value="from_us">From Us (we waive to owner)</option>
            </select>
          </Field>
          <Field label="Waiver type" required>
            <select value={form.waiver_type} onChange={e => update('waiver_type', e.target.value)} style={styles.input}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Project" required>
            <select value={form.project_id} onChange={e => update('project_id', e.target.value)} style={styles.input}>
              <option value="">— Choose —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          {isFromSub && (
            <Field label="Subcontractor" required>
              <select value={form.subcontractor_id} onChange={e => update('subcontractor_id', e.target.value)} style={styles.input}>
                <option value="">— Choose —</option>
                {subs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Amount &amp; date</h3>
        <div className="admin-form-grid-2">
          <Field label="Amount" required>
            <MoneyInput
              valueCents={form.amount_cents}
              onChange={cents => update('amount_cents', cents)}
            />
          </Field>
          <Field label="Through date" required>
            <input
              type="date"
              value={form.through_date}
              onChange={e => update('through_date', e.target.value)}
              style={styles.input}
            />
          </Field>
          <Field label="State (2-letter code)">
            <input
              maxLength={2}
              value={form.state}
              onChange={e => update('state', e.target.value.toUpperCase())}
              placeholder="CA, TX, NY, FL"
              style={styles.input}
            />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Signer</h3>
        <div className="admin-form-grid-2">
          <Field label="Name" required>
            <input value={form.signer_name} onChange={e => update('signer_name', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Company" required>
            <input value={form.signer_company} onChange={e => update('signer_company', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Title">
            <input value={form.signer_title} onChange={e => update('signer_title', e.target.value)} placeholder="e.g. President" style={styles.input} />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Notes</h3>
        <textarea value={form.notes} onChange={e => update('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function LienWaiverDetail({ id, onBack }) {
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [w, setW] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sendToken, setSendToken] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);

  async function downloadPDF() {
    if (!w) return;
    setPdfGenerating(true);
    try {
      const [{ pdf }, { default: LienWaiverPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../components/LienWaiverPDF'),
      ]);
      const el = React.createElement(LienWaiverPDF, { waiver: w });
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeId = String(w.id).replace(/[^a-z0-9]/gi, '');
      a.download = `lien-waiver-${safeId}-${w.waiver_type}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('PDF generation failed');
    } finally { setPdfGenerating(false); }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/lien-waivers/${id}`);
      setW(data);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function send() {
    setBusy(true); setError(null);
    try {
      const { data } = await api.post(`/lien-waivers/${id}/send`);
      setW(data);
      setSendToken(data.sign_token);
      const url = `${window.location.origin}/lien-waiver-sign/${data.sign_token}`;
      try { await navigator.clipboard?.writeText(url); } catch {}
      toast('Sent — signing URL copied to clipboard', 'success');
    } catch (err) { setError(err.response?.data?.error || 'Send failed'); }
    finally { setBusy(false); }
  }
  async function signInternal() {
    setBusy(true); setError(null);
    try {
      await api.post(`/lien-waivers/${id}/sign-internal`, { signature_method: 'typed', signature_data: w.signer_name });
      toast('Signed', 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || 'Sign failed'); }
    finally { setBusy(false); }
  }
  async function markSigned() {
    setBusy(true); setError(null);
    try {
      await api.post(`/lien-waivers/${id}/mark-signed`);
      toast('Marked received', 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || 'Mark-signed failed'); }
    finally { setBusy(false); }
  }
  async function convertUnconditional() {
    setBusy(true); setError(null);
    try {
      await api.post(`/lien-waivers/${id}/convert-unconditional`);
      toast('Unconditional waiver created', 'success');
      onBack();
    } catch (err) { setError(err.response?.data?.error || 'Convert failed'); setBusy(false); }
  }
  async function voidIt() {
    if (!await confirm({
      title: 'Void this waiver?',
      body: 'It will no longer be a valid legal record.',
      confirmLabel: 'Void',
      tone: 'danger',
    })) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/lien-waivers/${id}/void`);
      toast('Voided', 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!w) return null;

  const isFromSub = w.direction === 'from_sub';
  const isConditional = w.waiver_type.startsWith('conditional_');

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to lien waivers</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <DirectionBadge direction={w.direction} />
            <StatusBadge status={w.status} />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#111827' }}>
            {TYPE_LABELS[w.waiver_type] || w.waiver_type}
          </h1>
          <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
            {w.project_name}{w.subcontractor_name && ` · ${w.subcontractor_name}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={downloadPDF} disabled={pdfGenerating} style={styles.ghostBtn}>
            {pdfGenerating ? 'Generating...' : 'Download PDF'}
          </button>
          {w.status === 'draft' && (
            <button onClick={send} disabled={busy} style={styles.primaryBtn}>Send (generate sign link)</button>
          )}
          {w.status === 'draft' && !isFromSub && (
            <button onClick={signInternal} disabled={busy} style={styles.ghostBtn}>Sign internally</button>
          )}
          {w.status === 'sent' && (
            <button onClick={markSigned} disabled={busy} style={styles.primaryBtn}>Mark signed (received)</button>
          )}
          {isConditional && ['signed', 'received'].includes(w.status) && (
            <button onClick={convertUnconditional} disabled={busy} style={styles.primaryBtn}>
              Convert to Unconditional
            </button>
          )}
          {w.status !== 'void' && (
            <button onClick={voidIt} disabled={busy} style={{ ...styles.ghostBtn, color: '#991b1b', borderColor: '#fecaca' }}>Void</button>
          )}
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {sendToken && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>Signing link generated</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 12px' }}>
            Share this URL with the counterparty for typed-signature capture. v1 ships data + signing flow; PDF state-specific forms are a follow-up.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={`${window.location.origin}/lien-waiver-sign/${sendToken}`}
              onClick={e => e.target.select()}
              style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
            />
            <button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/lien-waiver-sign/${sendToken}`)} style={styles.primaryBtn}>Copy</button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Summary</h3>
        <div className="admin-form-grid-4">
          <Info label="Amount" value={formatCents(w.amount_cents)} />
          <Info label="Through date" value={new Date(w.through_date).toLocaleDateString()} />
          <Info label="State" value={w.state} />
          <Info label="Signature method" value={w.signature_method} />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Signer</h3>
        <div className="admin-form-grid-2">
          <Info label="Name" value={w.signer_name} />
          <Info label="Company" value={w.signer_company} />
          <Info label="Title" value={w.signer_title} />
          <Info label="Signed at" value={w.signed_at ? new Date(w.signed_at).toLocaleString() : null} />
        </div>
      </div>

      {w.documents?.length > 0 && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Documents ({w.documents.length})</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {w.documents.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0' }}><strong>{d.name}</strong></td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>
                    <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1a56db', fontSize: 13, fontWeight: 600 }}>Open</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {w.notes && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Notes</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{w.notes}</pre>
        </div>
      )}
    </div>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function LienWaiversPage() {
  const { user } = useAuth();
  const [view, setView] = useState({ kind: 'list' });

  function openNew(ctx)   { setView({ kind: 'form', ctx }); }
  function openDetail(id) { setView({ kind: 'detail', id }); }
  function backToList()   { setView({ kind: 'list' }); }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AppHeader currentApp="workforce" userRole={user?.role} />
      <main id="main-content">
        {view.kind === 'list'   && <LienWaiversList onOpen={openDetail} onNew={openNew} />}
        {view.kind === 'form'   && <NewLienWaiverForm projects={view.ctx?.projects || []} subs={view.ctx?.subs || []} onSave={(saved) => setView({ kind: 'detail', id: saved.id })} onCancel={backToList} />}
        {view.kind === 'detail' && <LienWaiverDetail id={view.id} onBack={backToList} />}
      </main>
    </div>
  );
}

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
