// Change orders portfolio — mid-project scope adjustments that bump
// budget categories on accept. Mirrors EstimatesPage structurally
// because the data shape and lifecycle are so similar, but each CO is
// tied to an existing project (no "create from scratch" path that
// stands alone).

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
import { formatMoney, formatDate, formatDateTime } from '../utils/format';
import { silentError } from '../errorReporter';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

const STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', fg: '#374151', label: 'Draft' },
  sent:      { bg: '#dbeafe', fg: '#1d4ed8', label: 'Sent' },
  accepted:  { bg: '#d1fae5', fg: '#065f46', label: 'Accepted' },
  declined:  { bg: '#fee2e2', fg: '#991b1b', label: 'Declined' },
  withdrawn: { bg: '#e5e7eb', fg: '#6b7280', label: 'Withdrawn' },
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

const formatCents = (c) => formatMoney(c, { showCents: true });

// ── List view ────────────────────────────────────────────────────────────────

function ChangeOrdersList({ onOpen, onNew }) {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [projects, setProjects] = useState([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (statusFilter) params.status = statusFilter;
      const { data } = await api.get('/change-orders', { params });
      setItems(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [statusFilter, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [statusFilter]);

  const sortedItems = useMemo(
    () => sortRows(items, sort, {
      total_cents: r => parseFloat(r.total_cents) || 0,
      created_at: r => r.created_at,
    }),
    [items, sort]
  );

  useEffect(() => {
    api.get('/admin/projects').then(({ data }) => setProjects(data || [])).catch(() => {});
  }, []);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>Change Orders</h1>
          <a href="/sales" style={{ fontSize: 14, color: '#1a56db', textDecoration: 'none', fontWeight: 600 }}>
            ← Estimates
          </a>
        </div>
        <button onClick={() => onNew(projects)} style={styles.primaryBtn}>+ New Change Order</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
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
            title="No change orders yet"
            body="Create a CO to amend an existing project's scope and budget."
            actionLabel="+ New Change Order"
            onAction={() => onNew(projects)}
          />
        ) : (
          <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="co_number" sort={sort} setSort={setSort}>Number</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>Project</SortHeader>
                  <SortHeader sortKey="description" sort={sort} setSort={setSort}>Description</SortHeader>
                  <SortHeader sortKey="total_cents" sort={sort} setSort={setSort} align="right">Total</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>Status</SortHeader>
                  <SortHeader sortKey="created_at" sort={sort} setSort={setSort}>Created</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(co => (
                  <tr key={co.id} style={styles.tableRow} onClick={() => onOpen(co.id)}>
                    <td style={styles.td}><strong>{co.co_number}</strong></td>
                    <td style={styles.td}>{co.project_name}</td>
                    <td style={styles.td}>{co.description}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(co.total_cents)}</td>
                    <td style={styles.td}><StatusBadge status={co.status} /></td>
                    <td style={styles.td}>{new Date(co.created_at).toLocaleDateString()}</td>
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

// ── Create form ──────────────────────────────────────────────────────────────

function NewChangeOrderForm({ projects, onSave, onCancel }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [head, setHead] = useState({
    description: '', overhead_pct: 0, margin_pct: 0, tax_pct: 0, notes: '',
  });
  const [lines, setLines] = useState([{ category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  function updateHead(k, v) { setDirty(true); setHead(h => ({ ...h, [k]: v })); }
  function updateLine(i, k, v) {
    setDirty(true);
    setLines(arr => arr.map((line, idx) => idx === i ? { ...line, [k]: v } : line));
  }
  function addLine() {
    setDirty(true);
    setLines(arr => [...arr, { category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0 }]);
  }
  function removeLine(i) {
    setDirty(true);
    setLines(arr => arr.filter((_, idx) => idx !== i));
  }

  const totals = (() => {
    const subtotal = lines.reduce((sum, l) => {
      const cents = Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unit_cost_cents, 10) || 0));
      return sum + Math.max(0, cents);
    }, 0);
    const ohPct = parseFloat(head.overhead_pct) || 0;
    const mgPct = parseFloat(head.margin_pct) || 0;
    const txPct = parseFloat(head.tax_pct) || 0;
    const overhead   = Math.round(subtotal * (ohPct / 100));
    const marginBase = subtotal + overhead;
    const margin     = Math.round(marginBase * (mgPct / 100));
    const preTax     = marginBase + margin;
    const tax        = Math.round(preTax * (txPct / 100));
    return { subtotal, overhead, margin, tax, total: preTax + tax };
  })();

  async function handleSave() {
    setError(null); setSaving(true);
    try {
      if (!projectId) { setError('Choose a project'); setSaving(false); return; }
      if (!head.description.trim()) { setError('Description is required'); setSaving(false); return; }
      const payload = {
        description: head.description,
        overhead_pct: parseFloat(head.overhead_pct) || 0,
        margin_pct: parseFloat(head.margin_pct) || 0,
        tax_pct: parseFloat(head.tax_pct) || 0,
        notes: head.notes || null,
        lines: lines
          .filter(l => l.description?.toString().trim())
          .map(l => ({
            category: l.category,
            description: l.description,
            qty: parseFloat(l.qty) || 0,
            unit: l.unit || null,
            unit_cost_cents: parseInt(l.unit_cost_cents, 10) || 0,
          })),
      };
      const { data } = await api.post(`/projects/${projectId}/change-orders`, payload);
      setDirty(false);
      onSave(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save change order');
    } finally { setSaving(false); }
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>New Change Order</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={styles.ghostBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Project</h3>
        <div style={styles.grid2}>
          <Field label="Project" required>
            <select value={projectId} onChange={e => { setDirty(true); setProjectId(e.target.value); }} style={styles.input}>
              <option value="">— Choose —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Description" required>
            <input value={head.description} onChange={e => updateHead('description', e.target.value)} placeholder="e.g. Add second-floor electrical rough-in" style={styles.input} />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Line items</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={styles.lineTh}>Category</th>
                <th style={styles.lineTh}>Description</th>
                <th style={{ ...styles.lineTh, width: 80 }}>Qty</th>
                <th style={{ ...styles.lineTh, width: 80 }}>Unit</th>
                <th style={{ ...styles.lineTh, width: 120, textAlign: 'right' }}>Unit cost</th>
                <th style={{ ...styles.lineTh, width: 100, textAlign: 'right' }}>Total</th>
                <th style={{ ...styles.lineTh, width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const total = Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unit_cost_cents, 10) || 0));
                return (
                  <tr key={i}>
                    <td style={styles.lineTd}>
                      <select value={l.category} onChange={e => updateLine(i, 'category', e.target.value)} style={{ ...styles.input, padding: '6px 8px' }}>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td style={styles.lineTd}>
                      <input value={l.description} onChange={e => updateLine(i, 'description', e.target.value)} style={{ ...styles.input, padding: '6px 8px' }} />
                    </td>
                    <td style={styles.lineTd}>
                      <input type="number" step="0.01" min="0" value={l.qty} onChange={e => updateLine(i, 'qty', e.target.value)} style={{ ...styles.input, padding: '6px 8px' }} />
                    </td>
                    <td style={styles.lineTd}>
                      <input value={l.unit || ''} onChange={e => updateLine(i, 'unit', e.target.value)} style={{ ...styles.input, padding: '6px 8px' }} />
                    </td>
                    <td style={styles.lineTd}>
                      <MoneyInput valueCents={l.unit_cost_cents} onChange={cents => updateLine(i, 'unit_cost_cents', cents)} style={{ padding: '6px 8px 6px 22px', fontSize: 14 }} />
                    </td>
                    <td style={{ ...styles.lineTd, textAlign: 'right', fontWeight: 600 }}>{formatCents(total)}</td>
                    <td style={styles.lineTd}>
                      <button onClick={() => removeLine(i)} style={styles.iconBtn} title="Remove">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button onClick={addLine} style={{ ...styles.ghostBtn, marginTop: 12 }}>+ Add line</button>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Markup &amp; tax</h3>
        <div style={styles.grid4}>
          <Field label="Overhead %">
            <input type="number" step="0.1" min="0" max="100" value={head.overhead_pct} onChange={e => updateHead('overhead_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Margin %">
            <input type="number" step="0.1" min="0" max="100" value={head.margin_pct} onChange={e => updateHead('margin_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Tax %">
            <input type="number" step="0.01" min="0" max="100" value={head.tax_pct} onChange={e => updateHead('tax_pct', e.target.value)} style={styles.input} />
          </Field>
          <div />
        </div>
        <div style={styles.totalsBox}>
          <TotalsRow label="Subtotal" value={totals.subtotal} />
          <TotalsRow label={`Overhead (${head.overhead_pct || 0}%)`} value={totals.overhead} />
          <TotalsRow label={`Margin (${head.margin_pct || 0}%)`} value={totals.margin} />
          <TotalsRow label={`Tax (${head.tax_pct || 0}%)`} value={totals.tax} />
          <TotalsRow label="Total (will bump project budget)" value={totals.total} bold />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Internal notes</h3>
        <textarea value={head.notes} onChange={e => updateHead('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function ChangeOrderDetail({ id, onBack }) {
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [co, setCo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sendToken, setSendToken] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/change-orders/${id}`);
      setCo(data);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function send() {
    setError(null); setBusy(true);
    try {
      const { data } = await api.post(`/change-orders/${id}/send`);
      setCo(data);
      setSendToken(data.response_token);
      const url = `${window.location.origin}/co/${data.response_token}`;
      try { await navigator.clipboard?.writeText(url); } catch {}
      toast('Sent — acceptance URL copied to clipboard', 'success');
    } catch (err) {
      setError(err.response?.data?.error || 'Send failed');
    } finally { setBusy(false); }
  }
  async function withdraw() {
    if (!await confirm({
      title: 'Withdraw this change order?',
      confirmLabel: 'Withdraw',
      tone: 'danger',
    })) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/change-orders/${id}/withdraw`);
      toast('Withdrawn', 'success');
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Withdraw failed'); }
    finally { setBusy(false); }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!co) return null;

  const isDraft = co.status === 'draft';
  const isSent = co.status === 'sent';

  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of co.lines || []) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to change orders</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>
            {co.co_number} <StatusBadge status={co.status} />
          </h1>
          <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>{co.project_name}</div>
          <div style={{ fontSize: 14, color: '#111827', marginTop: 4 }}>{co.description}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isDraft && (
            <button onClick={send} disabled={busy} style={styles.primaryBtn}>
              {busy ? 'Sending...' : 'Send to client'}
            </button>
          )}
          {isSent && (
            <button onClick={withdraw} disabled={busy} style={styles.ghostBtn}>Withdraw</button>
          )}
          {co.budget_applied_at && (
            <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
              ✓ Budget bumped {new Date(co.budget_applied_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {sendToken && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>Acceptance link generated</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 12px' }}>
            Share this URL with the client. On accept, the project budget is bumped by the CO's category totals in the same transaction.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={`${window.location.origin}/co/${sendToken}`}
              onClick={e => e.target.select()}
              style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
            />
            <button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/co/${sendToken}`)} style={styles.primaryBtn}>Copy</button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Line items</h3>
        {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
          <div key={category} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{category}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <tbody>
                {linesByCat[category].map(l => (
                  <tr key={l.id}>
                    <td style={{ padding: '4px 0' }}>{l.description}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: '#6b7280', width: 100 }}>{l.qty} {l.unit || ''}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', width: 120 }}>{formatCents(l.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <div style={{ ...styles.totalsBox, marginTop: 16 }}>
          <TotalsRow label="Subtotal" value={co.subtotal_cents} />
          <TotalsRow label="Total" value={co.total_cents} bold />
        </div>
      </div>

      {co.accepted_signer_name && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Accepted by</h3>
          <div style={{ fontSize: 14 }}>
            <strong>{co.accepted_signer_name}</strong> on {new Date(co.responded_at).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function ChangeOrdersPage() {
  const { user } = useAuth();
  const [view, setView] = useState({ kind: 'list' });

  function openNew(projects) { setView({ kind: 'form', projects }); }
  function openDetail(id)    { setView({ kind: 'detail', id }); }
  function backToList()      { setView({ kind: 'list' }); }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AppHeader currentApp="sales" userRole={user?.role} />
      <main id="main-content">
        {view.kind === 'list' && <ChangeOrdersList onOpen={openDetail} onNew={openNew} />}
        {view.kind === 'detail' && <ChangeOrderDetail id={view.id} onBack={backToList} />}
        {view.kind === 'form' && (
          <NewChangeOrderForm projects={view.projects || []} onSave={(saved) => setView({ kind: 'detail', id: saved.id })} onCancel={backToList} />
        )}
      </main>
    </div>
  );
}

// ── Small parts ──────────────────────────────────────────────────────────────

function Field({ label, required, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
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
function TotalsRow({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: bold ? '2px solid #111827' : '1px solid #f3f4f6', fontWeight: bold ? 700 : 400, fontSize: bold ? 16 : 14 }}>
      <span>{label}</span>
      <span>{formatCents(value)}</span>
    </div>
  );
}

const styles = {
  primaryBtn: { background: '#1a56db', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn:   { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  iconBtn:    { background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px' },
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
  lineTh: { textAlign: 'left', padding: '6px 4px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' },
  lineTd: { padding: '4px', verticalAlign: 'middle' },
  totalsBox: { background: '#f9fafb', padding: '12px 16px', borderRadius: 6, marginTop: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
