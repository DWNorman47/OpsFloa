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

// The seven money categories that match server/constants/projectMoneyEnums.js.
// Kept here as a literal because the client doesn't import server constants;
// the route's CHECK constraint is the unbypassable source of truth.
const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

const STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', fg: '#374151', label: 'Draft' },
  sent:      { bg: '#dbeafe', fg: '#1d4ed8', label: 'Sent' },
  accepted:  { bg: '#d1fae5', fg: '#065f46', label: 'Accepted' },
  declined:  { bg: '#fee2e2', fg: '#991b1b', label: 'Declined' },
  expired:   { bg: '#fef3c7', fg: '#92400e', label: 'Expired' },
  withdrawn: { bg: '#e5e7eb', fg: '#6b7280', label: 'Withdrawn' },
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {c.label}
    </span>
  );
}

// Module-local shorthand kept for the few places the previous code path
// used `formatCents`. The shared formatMoney from utils/format is now
// the canonical helper; alias preserved to keep the diff small.
const formatCents = (c) => formatMoney(c, { showCents: true });

// ── List view ────────────────────────────────────────────────────────────────

function EstimatesList({ onOpen, onNew }) {
  const [estimates, setEstimates] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (statusFilter) params.status = statusFilter;
      if (filter) params.q = filter;
      const { data } = await api.get('/estimates', { params });
      setEstimates(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) {
      silentError(err);
    } finally {
      setLoading(false);
    }
  }, [filter, statusFilter, page]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 1 when the filters change so an empty result-set on
  // page 7 doesn't leave the user looking at "no data" when they
  // adjust a filter.
  useEffect(() => { setPage(1); }, [filter, statusFilter]);

  // Sort the current page client-side. For now this re-orders only the
  // visible 50 rows; once a backend sort_by/sort_order param is added,
  // this becomes a pass-through.
  const sortedEstimates = useMemo(
    () => sortRows(estimates, sort, {
      total_cents: r => parseFloat(r.total_cents) || 0,
      created_at: r => r.created_at,
    }),
    [estimates, sort]
  );

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>Estimates</h1>
          <a href="/change-orders" style={{ fontSize: 14, color: '#1a56db', textDecoration: 'none', fontWeight: 600 }}>
            Change Orders →
          </a>
        </div>
        <button onClick={onNew} style={styles.primaryBtn}>
          + New Estimate
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search by project / client / number..."
          aria-label="Search estimates"
          value={filter}
          onChange={e => setFilter(e.target.value)}
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
        estimates.length === 0 ? (
          <EmptyState
            title="No estimates yet"
            body="Draft your first estimate to start the project money flow."
            actionLabel="+ New Estimate"
            onAction={onNew}
          />
        ) : (
          <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="estimate_number" sort={sort} setSort={setSort}>Number</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>Project</SortHeader>
                  <SortHeader sortKey="client_name_snapshot" sort={sort} setSort={setSort}>Client</SortHeader>
                  <SortHeader sortKey="total_cents" sort={sort} setSort={setSort} align="right">Total</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>Status</SortHeader>
                  <SortHeader sortKey="created_at" sort={sort} setSort={setSort}>Created</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedEstimates.map(e => (
                  <tr key={e.id} style={styles.tableRow} onClick={() => onOpen(e.id)}>
                    <td style={styles.td}><strong>{e.estimate_number}</strong></td>
                    <td style={styles.td}>{e.project_name}</td>
                    <td style={styles.td}>{e.client_name_snapshot}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(e.total_cents)}</td>
                    <td style={styles.td}><StatusBadge status={e.status} /></td>
                    <td style={styles.td}>{new Date(e.created_at).toLocaleDateString()}</td>
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

// ── Create / edit form ────────────────────────────────────────────────────────

function EstimateForm({ existing, onSave, onCancel }) {
  const toast = useToast();
  // Track whether the form has unsaved edits so the tab-close /
  // refresh prompt fires only when there's something to lose.
  // Flips true on first user change, back to false after a successful
  // save (via setDirty(false) in handleSave's success branch).
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const [head, setHead] = useState({
    project_name: existing?.project_name || '',
    client_name_snapshot: existing?.client_name_snapshot || '',
    client_email: existing?.client_email || '',
    project_address: existing?.project_address || '',
    scope_summary: existing?.scope_summary || '',
    overhead_pct: existing?.overhead_pct || 0,
    margin_pct: existing?.margin_pct || 0,
    contingency_pct: existing?.contingency_pct || 0,
    tax_pct: existing?.tax_pct || 0,
    valid_until: existing?.valid_until ? existing.valid_until.slice(0, 10) : '',
    notes: existing?.notes || '',
    exclusions: existing?.exclusions || '',
    terms: existing?.terms || '',
  });
  const [lines, setLines] = useState(existing?.lines?.length > 0
    ? existing.lines.map(l => ({ ...l }))
    : [{ category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0 }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Every mutator marks the form dirty so the tab-close prompt knows
  // there's something to lose. Marked clean again on successful save.
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

  // Live totals — pure-function math mirroring server/constants/projectMoneyEnums.js
  // computeEstimateTotals. Lines that don't parse count as zero (same defensive rule).
  const totals = (() => {
    const subtotal = lines.reduce((sum, l) => {
      const cents = Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unit_cost_cents, 10) || 0));
      return sum + Math.max(0, cents);
    }, 0);
    const ohPct = parseFloat(head.overhead_pct) || 0;
    const mgPct = parseFloat(head.margin_pct) || 0;
    const ctPct = parseFloat(head.contingency_pct) || 0;
    const txPct = parseFloat(head.tax_pct) || 0;
    const overhead    = Math.round(subtotal * (ohPct / 100));
    const marginBase  = subtotal + overhead;
    const margin      = Math.round(marginBase * (mgPct / 100));
    const preCont     = marginBase + margin;
    const contingency = Math.round(preCont * (ctPct / 100));
    const preTax      = preCont + contingency;
    const tax         = Math.round(preTax * (txPct / 100));
    return { subtotal, overhead, margin, contingency, tax, total: preTax + tax };
  })();

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const payload = {
        ...head,
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
      let response;
      if (existing) {
        await api.patch(`/estimates/${existing.id}`, payload);
        await api.put(`/estimates/${existing.id}/lines`, { lines: payload.lines });
        response = await api.get(`/estimates/${existing.id}`);
      } else {
        response = await api.post('/estimates', payload);
      }
      toast(existing ? 'Estimate updated' : 'Estimate saved', 'success');
      setDirty(false);  // mark clean so the leave-prompt doesn't fire
      onSave(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save estimate');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>
          {existing ? `Edit ${existing.estimate_number}` : 'New Estimate'}
        </h1>
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
          <Field label="Project name" required>
            <input value={head.project_name} onChange={e => updateHead('project_name', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Client name" required>
            <input value={head.client_name_snapshot} onChange={e => updateHead('client_name_snapshot', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Client email">
            <input type="email" value={head.client_email} onChange={e => updateHead('client_email', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Project address">
            <input value={head.project_address} onChange={e => updateHead('project_address', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Valid until">
            <input type="date" value={head.valid_until} onChange={e => updateHead('valid_until', e.target.value)} style={styles.input} />
          </Field>
        </div>
        <Field label="Scope summary">
          <textarea value={head.scope_summary} onChange={e => updateHead('scope_summary', e.target.value)} style={{ ...styles.input, minHeight: 60 }} />
        </Field>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Line items</h3>
        <div style={styles.linesTableWrap}>
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
                      <MoneyInput
                        valueCents={l.unit_cost_cents}
                        onChange={cents => updateLine(i, 'unit_cost_cents', cents)}
                        style={{ padding: '6px 8px 6px 22px', fontSize: 14 }}
                      />
                    </td>
                    <td style={{ ...styles.lineTd, textAlign: 'right', fontWeight: 600 }}>
                      {formatCents(total)}
                    </td>
                    <td style={styles.lineTd}>
                      <button onClick={() => removeLine(i)} style={styles.iconBtn} title="Remove">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={addLine} style={styles.ghostBtn}>+ Add line</button>
          <CatalogPicker onPick={(picked) => {
            // Append a new line pre-filled from the catalog item.
            setLines(arr => [...arr, {
              category: picked.category || 'materials',
              description: picked.description,
              qty: 1,
              unit: picked.unit || '',
              unit_cost_cents: picked.unit_cost_cents,
            }]);
          }} />
        </div>
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
          <Field label="Contingency %">
            <input type="number" step="0.1" min="0" max="100" value={head.contingency_pct} onChange={e => updateHead('contingency_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label="Tax %">
            <input type="number" step="0.01" min="0" max="100" value={head.tax_pct} onChange={e => updateHead('tax_pct', e.target.value)} style={styles.input} />
          </Field>
        </div>
        <div style={styles.totalsBox}>
          <TotalsRow label="Subtotal" value={totals.subtotal} />
          <TotalsRow label={`Overhead (${head.overhead_pct || 0}%)`} value={totals.overhead} />
          <TotalsRow label={`Margin (${head.margin_pct || 0}%)`} value={totals.margin} />
          <TotalsRow label={`Contingency (${head.contingency_pct || 0}%)`} value={totals.contingency} />
          <TotalsRow label={`Tax (${head.tax_pct || 0}%)`} value={totals.tax} />
          <TotalsRow label="Total" value={totals.total} bold />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Notes &amp; terms</h3>
        <Field label="Exclusions">
          <textarea value={head.exclusions} onChange={e => updateHead('exclusions', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
        <Field label="Terms">
          <textarea value={head.terms} onChange={e => updateHead('terms', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
        <Field label="Notes (internal)">
          <textarea value={head.notes} onChange={e => updateHead('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
      </div>
    </div>
  );
}

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

// Modal picker that searches /catalog/items, lets the user select one,
// resolves it via /catalog/items/:id/estimate-line, and passes the line
// shape up. Lightweight; opens inline rather than a true modal so it
// doesn't fight with the rest of the form.
function CatalogPicker({ onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const params = q ? { q } : {};
    const t = setTimeout(() => {
      api.get('/catalog/items', { params, limit: 30 })
        .then(({ data }) => setItems(data.items || []))
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  async function pick(item) {
    try {
      const { data } = await api.get(`/catalog/items/${item.id}/estimate-line`);
      onPick(data);
      setOpen(false);
      setQ('');
    } catch { /* ignore */ }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ background: '#f0f4ff', color: '#1d4ed8', border: '1px solid #c7d2fe', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
        + From catalog
      </button>
    );
  }
  return (
    <div style={{
      position: 'absolute', zIndex: 50, background: '#fff',
      border: '1px solid #d1d5db', borderRadius: 8, padding: 12,
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)', width: 480, maxHeight: 360, overflow: 'auto',
      marginTop: 40,
    }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          autoFocus
          placeholder="Search catalog..."
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, flex: 1 }}
        />
        <button onClick={() => { setOpen(false); setQ(''); }} style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      {loading ? (
        <div style={{ fontSize: 13, color: '#6b7280', padding: 12 }}>Searching...</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 13, color: '#6b7280', padding: 12 }}>No matches.</div>
      ) : (
        <div>
          {items.map(item => (
            <div
              key={item.id}
              onClick={() => pick(item)}
              style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.background = '#f3f4f6'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ fontWeight: 600, color: '#111827' }}>{item.name}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                {item.sku && `${item.sku} · `}
                {item.unit && `per ${item.unit}`}
                {item.sell_price_cents != null && ` · ${formatCents(item.sell_price_cents)}`}
                {!item.is_stocked && ' · catalog only'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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

// ── Detail view ──────────────────────────────────────────────────────────────

function EstimateDetail({ id, onBack, onEdit }) {
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [sendToken, setSendToken] = useState(null);
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/estimates/${id}`);
      setEstimate(data);
    } catch (err) {
      silentError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function send() {
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await api.post(`/estimates/${id}/send`);
      setEstimate(data);
      setSendToken(data.response_token);
      // Auto-copy the acceptance URL to clipboard. Without this the
      // admin sees the URL card, then has to click Copy as a separate
      // step. Auto-copy lets them paste straight into an email.
      const url = `${window.location.origin}/e/${data.response_token}`;
      try { await navigator.clipboard?.writeText(url); } catch {}
      toast('Sent — acceptance URL copied to clipboard', 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!await confirm({
      title: 'Withdraw this estimate?',
      body: 'It will no longer be acceptable by the client.',
      confirmLabel: 'Withdraw',
      tone: 'danger',
    })) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/estimates/${id}/withdraw`);
      toast('Withdrawn', 'success');
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Withdraw failed');
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    if (!await confirm({
      title: 'Convert to project?',
      body: 'This seeds the project budget from the estimate categories.',
      confirmLabel: 'Convert',
    })) return;
    setBusy(true);
    setActionError(null);
    try {
      const { data } = await api.post(`/estimates/${id}/convert`);
      toast(`Project created with ${data.categories_seeded || 0} budget categories`, 'success');
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Convert failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!estimate) return null;

  const isDraft = estimate.status === 'draft';
  const isSent = estimate.status === 'sent';
  const isAccepted = estimate.status === 'accepted';

  // Group lines by category for display.
  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of estimate.lines || []) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to list</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>
            {estimate.estimate_number} <StatusBadge status={estimate.status} />
          </h1>
          <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
            {estimate.project_name} · {estimate.client_name_snapshot}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isDraft && (
            <>
              <button onClick={onEdit} style={styles.ghostBtn}>Edit</button>
              <button onClick={send} disabled={busy} style={styles.primaryBtn}>
                {busy ? 'Sending...' : 'Send to client'}
              </button>
            </>
          )}
          {isSent && (
            <button onClick={withdraw} disabled={busy} style={styles.ghostBtn}>Withdraw</button>
          )}
          {isAccepted && !estimate.converted_project_id && (
            <button onClick={convert} disabled={busy} style={styles.primaryBtn}>
              Convert to project
            </button>
          )}
          {estimate.converted_project_id && (
            <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
              ✓ Converted to project #{estimate.converted_project_id}
            </span>
          )}
        </div>
      </div>

      {actionError && <div style={styles.errorBox}>{actionError}</div>}

      {sendToken && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>Acceptance link generated</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 12px' }}>
            Share this URL with the client. They'll see the full estimate and can accept or decline.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={`${window.location.origin}/e/${sendToken}`}
              onClick={e => e.target.select()}
              style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
            />
            <button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/e/${sendToken}`)} style={styles.primaryBtn}>
              Copy
            </button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>Line items</h3>
        {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
          <div key={category} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              {category}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <tbody>
                {linesByCat[category].map(l => (
                  <tr key={l.id}>
                    <td style={{ padding: '4px 0' }}>{l.description}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: '#6b7280', width: 100 }}>
                      {l.qty} {l.unit || ''}
                    </td>
                    <td style={{ padding: '4px 0', textAlign: 'right', width: 120 }}>
                      {formatCents(l.total_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <div style={{ ...styles.totalsBox, marginTop: 16 }}>
          <TotalsRow label="Subtotal" value={estimate.subtotal_cents} />
          {estimate.overhead_pct > 0 && <TotalsRow label={`Overhead (${estimate.overhead_pct}%)`} value={Math.round(estimate.subtotal_cents * estimate.overhead_pct / 100)} />}
          {estimate.margin_pct > 0 && <TotalsRow label={`Margin (${estimate.margin_pct}%)`} value="—" />}
          <TotalsRow label="Total" value={estimate.total_cents} bold />
        </div>
      </div>

      {(estimate.exclusions || estimate.terms) && (
        <div style={styles.formCard}>
          {estimate.exclusions && <>
            <h3 style={styles.formH3}>Exclusions</h3>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{estimate.exclusions}</pre>
          </>}
          {estimate.terms && <>
            <h3 style={styles.formH3}>Terms</h3>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{estimate.terms}</pre>
          </>}
        </div>
      )}

      {estimate.accepted_signer_name && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>Accepted by</h3>
          <div style={{ fontSize: 14 }}>
            <strong>{estimate.accepted_signer_name}</strong> on {new Date(estimate.responded_at).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

export default function EstimatesPage() {
  const { user } = useAuth();
  const [view, setView] = useState({ kind: 'list' });

  function openDetail(id) { setView({ kind: 'detail', id }); }
  function openNew()       { setView({ kind: 'form', existing: null }); }
  function openEdit()      {
    if (view.kind !== 'detail') return;
    // Detail view loads itself, but the form needs the row. Easiest:
    // fetch fresh in the form via a lookup on existing.id, but here we
    // just push a form view that fetches the row inside.
    setView(v => ({ kind: 'form', existing: { id: v.id } }));
  }
  function backToList() { setView({ kind: 'list' }); }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AppHeader currentApp="sales" userRole={user?.role} />
      <main id="main-content">
        {view.kind === 'list' && (
          <EstimatesList onOpen={openDetail} onNew={openNew} />
        )}
        {view.kind === 'detail' && (
          <EstimateDetail id={view.id} onBack={backToList} onEdit={openEdit} />
        )}
        {view.kind === 'form' && (
          <EstimateFormLoader existing={view.existing} onSave={(saved) => setView({ kind: 'detail', id: saved.id })} onCancel={() => view.existing ? setView({ kind: 'detail', id: view.existing.id }) : backToList()} />
        )}
      </main>
    </div>
  );
}

// Form loader resolves the existing estimate before rendering the form,
// so the edit path can load by id alone.
function EstimateFormLoader({ existing, onSave, onCancel }) {
  const [resolved, setResolved] = useState(existing && !existing.id ? existing : null);
  const [loading, setLoading] = useState(existing?.id && !existing?.project_name);
  useEffect(() => {
    if (existing?.id && !existing?.project_name) {
      api.get(`/estimates/${existing.id}`).then(({ data }) => {
        setResolved(data);
        setLoading(false);
      }).catch(() => setLoading(false));
    }
  }, [existing]);
  if (loading) return <SkeletonList rows={4} />;
  return <EstimateForm existing={resolved} onSave={onSave} onCancel={onCancel} />;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  primaryBtn: { background: '#1a56db', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn:   { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  iconBtn:    { background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px' },
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
  linesTableWrap: { overflowX: 'auto' },
  lineTh: { textAlign: 'left', padding: '6px 4px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' },
  lineTd: { padding: '4px', verticalAlign: 'middle' },
  totalsBox: { background: '#f9fafb', padding: '12px 16px', borderRadius: 6, marginTop: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
