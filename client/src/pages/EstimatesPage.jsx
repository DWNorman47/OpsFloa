import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import { isImpersonating, openToolTab } from '../openTool';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import MoneyInput from '../components/MoneyInput';
import Pagination from '../components/Pagination';
import SortHeader, { sortRows } from '../components/SortHeader';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useCents } from '../hooks/useMoney';
import { useCurrency } from '../contexts/SettingsContext';
import { formatDate, formatDateTime } from '../utils';
import { computeBreakdown } from '../utils/estimateMath';
import { silentError } from '../errorReporter';
import { useT } from '../hooks/useT';
import { getT } from '../i18n';

// The seven money categories that match server/constants/projectMoneyEnums.js.
// Kept here as a literal because the client doesn't import server constants;
// the route's CHECK constraint is the unbypassable source of truth.
const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

// Maps a category VALUE (used in logic/API) to its i18n key for display only.
// The values themselves are never translated.
const CATEGORY_LABEL_KEYS = {
  labor: 'estCatLabor',
  materials: 'estCatMaterials',
  equipment: 'estCatEquipment',
  subs: 'estCatSubs',
  overhead: 'estCatOverhead',
  contingency: 'estCatContingency',
  other: 'estCatOther',
};

const STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', fg: '#374151', labelKey: 'estStatusDraft' },
  sent:      { bg: '#dbeafe', fg: '#1d4ed8', labelKey: 'estStatusSent' },
  accepted:  { bg: '#d1fae5', fg: '#065f46', labelKey: 'estStatusAccepted' },
  declined:  { bg: '#fee2e2', fg: '#991b1b', labelKey: 'estStatusDeclined' },
  expired:   { bg: '#fef3c7', fg: '#92400e', labelKey: 'estStatusExpired' },
  withdrawn: { bg: '#e5e7eb', fg: '#6b7280', labelKey: 'estStatusWithdrawn' },
};

function StatusBadge({ status }) {
  const t = useT();
  const c = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {t[c.labelKey]}
    </span>
  );
}

// Module-local shorthand kept for the few places the previous code path
// used `formatCents`. The shared formatMoney from utils/format is now
// the canonical helper; alias preserved to keep the diff small.

// ── List view ────────────────────────────────────────────────────────────────

// "Bid due" chip — only while still bidding (draft/sent); red overdue, amber soon
function BidDueChip({ dueAt, status, language }) {
  if (!dueAt || !['draft', 'sent'].includes(status)) return null;
  const days = daysUntil(dueAt);
  if (days === null) return null;
  const overdue = days < 0, soon = days >= 0 && days < 2;
  const color = overdue ? '#dc2626' : soon ? '#b45309' : '#6b7280';
  const bg = overdue ? '#fee2e2' : soon ? '#fef3c7' : '#eef2f7';
  const txt = new Date(dueAt).toLocaleString(language || undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <span title="Bid due" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color, background: bg, padding: '2px 7px', borderRadius: 999, whiteSpace: 'nowrap' }}>
      ⏰ {txt}
    </span>
  );
}

function EstimatesList({ onOpen, onNew }) {
  const formatCents = useCents();
  const t = useT();
  const { user } = useAuth();
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
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          <input
            type="search"
            placeholder={t.estSearchPlaceholder}
            aria-label={t.estSearchAria}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={styles.searchInput}
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label={t.estFilterStatusAria}
            style={styles.select}
          >
            <option value="">{t.estAllStatuses}</option>
            {Object.entries(STATUS_COLORS).map(([k, v]) => (
              <option key={k} value={k}>{t[v.labelKey]}</option>
            ))}
          </select>
        </div>
        <button onClick={onNew} style={styles.primaryBtn}>
          {t.estNew}
        </button>
      </div>
      {loading ? <SkeletonList rows={4} /> :
        estimates.length === 0 ? (
          <EmptyState
            title={t.estEmptyTitle}
            body={t.estEmptyBody}
            actionLabel={t.estNew}
            onAction={onNew}
          />
        ) : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="estimate_number" sort={sort} setSort={setSort}>{t.estNumber}</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>{t.estProject}</SortHeader>
                  <SortHeader sortKey="client_name_snapshot" sort={sort} setSort={setSort}>{t.estClient}</SortHeader>
                  <SortHeader sortKey="total_cents" sort={sort} setSort={setSort} align="right">{t.estTotal}</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>{t.estStatus}</SortHeader>
                  <SortHeader sortKey="created_at" sort={sort} setSort={setSort}>{t.estCreated}</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedEstimates.map(e => (
                  <tr key={e.id} style={styles.tableRow} onClick={() => onOpen(e.id)}>
                    <td style={styles.td}><strong>{e.estimate_number}</strong></td>
                    <td style={styles.td}>{e.project_name}</td>
                    <td style={styles.td}>{e.client_name_snapshot}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(e.total_cents)}</td>
                    <td style={styles.td}><div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><StatusBadge status={e.status} /><BidDueChip dueAt={e.bid_due_at} status={e.status} language={user?.language} /></div></td>
                    <td style={styles.td}>{formatDate(e.created_at, user?.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-cards-mobile">
            {sortedEstimates.map(e => (
              <div
                key={e.id}
                className="admin-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(e.id)}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen(e.id))}
              >
                <div className="admin-card-row">
                  <span className="admin-card-title">{e.estimate_number}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><StatusBadge status={e.status} /><BidDueChip dueAt={e.bid_due_at} status={e.status} language={user?.language} /></div>
                </div>
                <div className="admin-card-sub">{e.project_name}</div>
                <div className="admin-card-sub">{e.client_name_snapshot}</div>
                <div className="admin-card-row">
                  <span className="admin-card-sub">{formatDate(e.created_at, user?.language)}</span>
                  <strong style={{ fontSize: 14 }}>{formatCents(e.total_cents)}</strong>
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

// ── Create / edit form ────────────────────────────────────────────────────────

// stored UTC timestamp -> local "YYYY-MM-DDTHH:mm" for a datetime-local input
function toLocalDatetime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// days until a due timestamp (negative = overdue); null if unset
function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return (d.getTime() - Date.now()) / 86400000;
}

function EstimateForm({ existing, onSave, onCancel }) {
  const formatCents = useCents();
  const t = useT();
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
    bid_due_at: existing?.bid_due_at ? toLocalDatetime(existing.bid_due_at) : '',
    notes: existing?.notes || '',
    exclusions: existing?.exclusions || '',
    terms: existing?.terms || '',
  });
  const [lines, setLines] = useState(existing?.lines?.length > 0
    ? existing.lines.map(l => ({ ...l }))
    : [{ category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0, cost_cents: null }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  function clearFieldError(k) {
    setFieldErrors(prev => (prev[k] ? { ...prev, [k]: undefined } : prev));
  }
  // Every mutator marks the form dirty so the tab-close prompt knows
  // there's something to lose. Marked clean again on successful save.
  function updateHead(k, v) { setDirty(true); clearFieldError(k); setHead(h => ({ ...h, [k]: v })); }
  function updateLine(i, k, v) {
    setDirty(true);
    setLines(arr => arr.map((line, idx) => idx === i ? { ...line, [k]: v } : line));
  }
  function addLine() {
    setDirty(true);
    setLines(arr => [...arr, { category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0, cost_cents: null }]);
  }
  function removeLine(i) {
    setDirty(true);
    setLines(arr => arr.filter((_, idx) => idx !== i));
  }
  // Save a line back to the material catalog so it pre-fills future estimates.
  // The line's unit cost is already the client-facing price, so it lands as the
  // catalog item's sell price. Creates a catalog-only row (is_stocked=false).
  async function saveLineToCatalog(line) {
    const desc = line.description?.toString().trim();
    if (!desc) { toast(t.estSaveToCatalogEmpty, 'error'); return; }
    try {
      await api.post('/catalog/items', {
        name: desc,
        unit: line.unit || null,
        sell_price_cents: parseInt(line.unit_cost_cents, 10) || 0,
        // Preserve the cost basis so a re-picked catalog line restores cost too
        // (unit_cost is dollars on the catalog item).
        unit_cost: line.cost_cents == null || line.cost_cents === '' ? null : (parseInt(line.cost_cents, 10) / 100),
        default_estimate_category: line.category || null,
      });
      toast(t.estSavedToCatalog, 'success');
    } catch (err) {
      toast(err.response?.data?.error || t.estSaveToCatalogError, 'error');
    }
  }

  // Live totals — pure-function math mirroring server/constants/projectMoneyEnums.js
  // computeEstimateTotals. Lines that don't parse count as zero (same defensive rule).
  const totals = (() => {
    const subtotal = lines.reduce((sum, l) => {
      const cents = Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unit_cost_cents, 10) || 0));
      return sum + Math.max(0, cents);
    }, 0);
    // Cost baseline = qty × cost (falling back to price where cost is blank) —
    // matches what the converted project's budget will carry.
    const costBaseline = lines.reduce((sum, l) => {
      const price = parseInt(l.unit_cost_cents, 10) || 0;
      const cost = l.cost_cents == null || l.cost_cents === '' ? price : (parseInt(l.cost_cents, 10) || 0);
      return sum + Math.max(0, Math.round((parseFloat(l.qty) || 0) * cost));
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
    const total       = preTax + tax;
    // Est. margin = contract (pre-tax) − cost baseline. Tax is a pass-through,
    // so margin is measured against the pre-tax contract.
    const estMargin   = preTax - costBaseline;
    return { subtotal, costBaseline, overhead, margin, contingency, tax, total, estMargin, preTax };
  })();

  async function handleSave() {
    setError(null);
    const fe = {};
    if (!head.project_name.trim()) fe.project_name = t.estErrProjectNameRequired;
    if (!head.client_name_snapshot.trim()) fe.client_name_snapshot = t.estErrClientNameRequired;
    if (Object.keys(fe).length) { setFieldErrors(fe); return; }
    setFieldErrors({});
    setSaving(true);
    try {
      const payload = {
        ...head,
        bid_due_at: head.bid_due_at ? new Date(head.bid_due_at).toISOString() : null,
        lines: lines
          .filter(l => l.description?.toString().trim())
          .map(l => ({
            category: l.category,
            description: l.description,
            qty: parseFloat(l.qty) || 0,
            unit: l.unit || null,
            unit_cost_cents: parseInt(l.unit_cost_cents, 10) || 0,
            cost_cents: l.cost_cents == null || l.cost_cents === '' ? null : parseInt(l.cost_cents, 10),
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
      toast(existing ? t.estToastUpdated : t.estToastSaved, 'success');
      setDirty(false);  // mark clean so the leave-prompt doesn't fire
      onSave(response.data);
    } catch (err) {
      setError(err.response?.data?.error || t.estErrSave);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-page-shell">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>
          {existing ? `${t.estEdit} ${existing.estimate_number}` : t.estFormNewTitle}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={styles.ghostBtn}>{t.estCancel}</button>
          <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
            {saving ? t.estSaving : t.estSave}
          </button>
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.estProject}</h3>
        <div className="admin-form-grid-2">
          <Field label={t.estProjectName} required error={fieldErrors.project_name}>
            <input value={head.project_name} onChange={e => updateHead('project_name', e.target.value)} style={{ ...styles.input, ...(fieldErrors.project_name ? styles.inputInvalid : {}) }} />
          </Field>
          <Field label={t.estClientName} required error={fieldErrors.client_name_snapshot}>
            <input value={head.client_name_snapshot} onChange={e => updateHead('client_name_snapshot', e.target.value)} style={{ ...styles.input, ...(fieldErrors.client_name_snapshot ? styles.inputInvalid : {}) }} />
          </Field>
          <Field label={t.estClientEmail}>
            <input type="email" value={head.client_email} onChange={e => updateHead('client_email', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.estProjectAddress}>
            <input value={head.project_address} onChange={e => updateHead('project_address', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.estValidUntil}>
            <input type="date" value={head.valid_until} onChange={e => updateHead('valid_until', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.estBidDue}>
            <input type="datetime-local" value={head.bid_due_at} onChange={e => updateHead('bid_due_at', e.target.value)} style={styles.input} title={t.estBidDueHint} />
          </Field>
        </div>
        <Field label={t.estScopeSummary}>
          <textarea value={head.scope_summary} onChange={e => updateHead('scope_summary', e.target.value)} style={{ ...styles.input, minHeight: 60 }} />
        </Field>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.estLineItems}</h3>
        <div style={styles.linesTableWrap}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={styles.lineTh}>{t.estCategory}</th>
                <th style={styles.lineTh}>{t.estDescription}</th>
                <th style={{ ...styles.lineTh, width: 80 }}>{t.estQty}</th>
                <th style={{ ...styles.lineTh, width: 80 }}>{t.estUnit}</th>
                <th style={{ ...styles.lineTh, width: 110, textAlign: 'right' }}>{t.estLineCost}</th>
                <th style={{ ...styles.lineTh, width: 120, textAlign: 'right' }}>{t.estLinePrice}</th>
                <th style={{ ...styles.lineTh, width: 100, textAlign: 'right' }}>{t.estTotal}</th>
                <th style={{ ...styles.lineTh, width: 64 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const total = Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unit_cost_cents, 10) || 0));
                return (
                  <tr key={i}>
                    <td style={styles.lineTd}>
                      <select value={l.category} onChange={e => updateLine(i, 'category', e.target.value)} style={{ ...styles.input, padding: '6px 8px' }}>
                        {CATEGORIES.map(c => <option key={c} value={c}>{t[CATEGORY_LABEL_KEYS[c]]}</option>)}
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
                      {/* Cost is optional — blank means "use price as the cost
                          baseline" (no line margin claimed). Shown empty, not $0. */}
                      <input
                        type="number" step="0.01" min="0"
                        value={l.cost_cents == null || l.cost_cents === '' ? '' : (parseInt(l.cost_cents, 10) / 100)}
                        onChange={e => {
                          const v = e.target.value;
                          updateLine(i, 'cost_cents', v === '' || !Number.isFinite(parseFloat(v)) ? null : Math.round(parseFloat(v) * 100));
                        }}
                        placeholder="—"
                        style={{ ...styles.input, padding: '6px 8px', fontSize: 14, textAlign: 'right' }}
                      />
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
                    <td style={{ ...styles.lineTd, whiteSpace: 'nowrap' }}>
                      <button onClick={() => saveLineToCatalog(l)} style={styles.iconBtn} title={t.estSaveToCatalog}>🔖</button>
                      <button onClick={() => removeLine(i)} style={styles.iconBtn} title={t.estRemove}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={addLine} style={styles.ghostBtn}>{t.estAddLine}</button>
          <LinePicker onAdd={(newLines) => {
            // Append one or more lines pre-filled from the catalog or an
            // equipment asset. Flip dirty so the tab-close prompt fires,
            // just like after any other line edit.
            setDirty(true);
            setLines(arr => [...arr, ...newLines]);
          }} />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.estMarkupTax}</h3>
        <div className="admin-form-grid-4">
          <Field label={t.estOverheadPct}>
            <input type="number" step="0.1" min="0" max="100" value={head.overhead_pct} onChange={e => updateHead('overhead_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.estMarginPct}>
            <input type="number" step="0.1" min="0" max="100" value={head.margin_pct} onChange={e => updateHead('margin_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.estContingencyPct}>
            <input type="number" step="0.1" min="0" max="100" value={head.contingency_pct} onChange={e => updateHead('contingency_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.estTaxPct}>
            <input type="number" step="0.01" min="0" max="100" value={head.tax_pct} onChange={e => updateHead('tax_pct', e.target.value)} style={styles.input} />
          </Field>
        </div>
        <div style={styles.totalsBox}>
          <TotalsRow label={t.estSubtotal} value={totals.subtotal} />
          <TotalsRow label={`${t.estOverhead} (${head.overhead_pct || 0}%)`} value={totals.overhead} />
          <TotalsRow label={`${t.estMargin} (${head.margin_pct || 0}%)`} value={totals.margin} />
          <TotalsRow label={`${t.estContingency} (${head.contingency_pct || 0}%)`} value={totals.contingency} />
          <TotalsRow label={`${t.estTax} (${head.tax_pct || 0}%)`} value={totals.tax} />
          <TotalsRow label={t.estTotal} value={totals.total} bold />
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #d1d5db' }}>
            <TotalsRow label={t.estCostBaseline} value={totals.costBaseline} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontWeight: 700, fontSize: 14, color: totals.estMargin < 0 ? '#dc2626' : '#047857' }}>
              <span>{t.estMarginProfit}{totals.preTax > 0 ? ` (${((totals.estMargin / totals.preTax) * 100).toFixed(1)}%)` : ''}</span>
              <span>{formatCents(totals.estMargin)}</span>
            </div>
          </div>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.estNotesTerms}</h3>
        <Field label={t.estExclusions}>
          <textarea value={head.exclusions} onChange={e => updateHead('exclusions', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
        <Field label={t.estTerms}>
          <textarea value={head.terms} onChange={e => updateHead('terms', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
        <Field label={t.estNotesInternal}>
          <textarea value={head.notes} onChange={e => updateHead('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
      </div>

      <div className="ops-form-actions">
        <button onClick={onCancel} style={styles.ghostBtn}>{t.estCancel}</button>
        <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.estSaving : t.estSave}
        </button>
      </div>
    </div>
  );
}

function Field({ label, required, error, children }) {
  const t = useT();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
      <span>
        {label}
        {required && (
          <>
            <span aria-hidden="true" style={{ color: '#ef4444' }}>*</span>
            <span className="sr-only"> ({t.estRequired})</span>
          </>
        )}
      </span>
      {children}
      {error && <span className="ops-field-error" role="alert">{error}</span>}
    </label>
  );
}

// One unified library picker for estimate lines. A single search spans both
// reference sources, merged into one list:
//   • Catalog items  — priced reference costs (materials, rental references,
//                      subs, labor…) → one line each
//   • Owned machines — equipment assets → their mobilization + operating (or
//                      rent-out) lines, resolved from the rates on the asset
// No copying between the two (see the estimate-phase model): the picker just
// reads both, so it feels like one library with a single source of truth per
// rate. Opens inline. onAdd receives an ARRAY of line shapes to append.
function LinePicker({ onAdd }) {
  const formatCents = useCents();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [catalogItems, setCatalogItems] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(false);

  // Localized "Machine — <part>" description for an equipment line.
  const EQ_PART_LABELS = {
    mobilization: t.estEqMobilization, operating: t.estEqOperating, rental: t.estEqRental,
  };

  // Owned machines: fetched once when the picker opens, filtered locally.
  useEffect(() => {
    if (!open) return;
    api.get('/equipment')
      .then(({ data }) => setEquipment(Array.isArray(data) ? data : []))
      .catch(() => setEquipment([]));
  }, [open]);

  // Catalog: searched server-side as the query changes.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const timer = setTimeout(() => {
      api.get('/catalog/items', { params: q ? { q } : {}, limit: 30 })
        .then(({ data }) => setCatalogItems(data.items || []))
        .catch(() => setCatalogItems([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [q, open]);

  const needle = q.trim().toLowerCase();
  const machineResults = needle
    ? equipment.filter(a => `${a.name} ${a.unit_number || ''}`.toLowerCase().includes(needle))
    : equipment;
  const results = [
    ...catalogItems.map(it => ({ ...it, _type: 'catalog' })),
    ...machineResults.map(a => ({ ...a, _type: 'equipment' })),
  ];

  async function pick(row) {
    try {
      if (row._type === 'catalog') {
        const { data } = await api.get(`/catalog/items/${row.id}/estimate-line`);
        onAdd([{
          category: data.category || 'materials',
          description: data.description,
          qty: 1,
          unit: data.unit || '',
          unit_cost_cents: data.unit_cost_cents,
          cost_cents: data.cost_cents ?? null,
        }]);
      } else {
        const { data } = await api.get(`/equipment/${row.id}/estimate-lines`);
        const lines = (data.lines || []).map(l => ({
          category: l.category || 'equipment',
          description: EQ_PART_LABELS[l.part] ? `${data.name} — ${EQ_PART_LABELS[l.part]}` : data.name,
          qty: l.qty ?? 1,
          unit: l.unit || '',
          unit_cost_cents: l.unit_cost_cents,
          cost_cents: null,
        }));
        if (!lines.length) return;
        onAdd(lines);
      }
      close();
    } catch { /* ignore */ }
  }

  function close() { setOpen(false); setQ(''); }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ background: '#f0f4ff', color: '#1d4ed8', border: '1px solid #c7d2fe', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
        {t.estFromLibrary}
      </button>
    );
  }
  return (
    <div style={{
      position: 'absolute', zIndex: 50, background: '#fff',
      border: '1px solid #d1d5db', borderRadius: 8, padding: 12,
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)', width: 480, maxHeight: 380, overflow: 'auto',
      marginTop: 40,
    }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          autoFocus
          placeholder={t.estSearchLibrary}
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ flex: 1, boxSizing: 'border-box', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }}
        />
        <button onClick={close} style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      {loading && results.length === 0 ? (
        <div style={{ fontSize: 13, color: '#6b7280', padding: 12 }}>{t.estSearching}</div>
      ) : results.length === 0 ? (
        <div style={{ fontSize: 13, color: '#6b7280', padding: 12 }}>{t.estNoMatches}</div>
      ) : (
        <div>
          {results.map(row => (
            <div
              key={`${row._type}-${row.id}`}
              onClick={() => pick(row)}
              style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.background = '#f3f4f6'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 600, color: '#111827' }}>{row.name}</span>
                {row._type === 'equipment' && (
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6d28d9', background: '#ede9fe', padding: '1px 6px', borderRadius: 6 }}>{t.estLibMachine}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                {row._type === 'catalog' ? (
                  <>
                    {row.sku && `${row.sku} · `}
                    {row.unit && `${t.estPer} ${row.unit}`}
                    {row.sell_price_cents != null && ` · ${formatCents(row.sell_price_cents)}`}
                    {!row.is_stocked && ` · ${t.estCatalogOnly}`}
                  </>
                ) : (
                  <>
                    {row.unit_number && `${row.unit_number} · `}
                    {row.operating_rate != null ? `${formatCents(Math.round(parseFloat(row.operating_rate) * 100))}/${row.operating_unit || 'hr'}`
                      : row.rent_out_rate != null ? `${formatCents(Math.round(parseFloat(row.rent_out_rate) * 100))}/${row.rent_out_unit || 'day'}`
                      : t.estEqNoRates}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TotalsRow({ label, value, bold }) {
  const formatCents = useCents();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: bold ? '2px solid #111827' : '1px solid #f3f4f6', fontWeight: bold ? 700 : 400, fontSize: bold ? 16 : 14 }}>
      <span>{label}</span>
      <span>{formatCents(value)}</span>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────────

function EstimateDetail({ id, onBack, onEdit }) {
  const formatCents = useCents();
  const currency = useCurrency();
  const t = useT();
  const { user } = useAuth();
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [sendToken, setSendToken] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // The takeoff add-on lights up the "Take off in Plan Room" launch (same
  // entitlement gate the Tools page uses; trial/exempt companies get it too).
  const hasPlanroom = !!(user?.addon_planroom || ['exempt', 'trial'].includes(user?.subscription_status));

  // Build the client-facing estimate PDF in the browser. Lazy-imports
  // @react-pdf/renderer (heavy) only when the admin actually downloads,
  // and pulls company letterhead from /company-info — same pattern as
  // the lien-waiver PDF.
  async function downloadPDF() {
    if (!estimate) return;
    setPdfGenerating(true);
    setActionError(null);
    try {
      const [{ pdf }, { default: EstimatePDF }, companyRes] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../components/EstimatePDF'),
        api.get('/company-info').catch(() => ({ data: {} })),
      ]);
      // Render the PDF in the CLIENT's language (the document recipient),
      // not the admin's UI language. getT falls back to English when the
      // client has no language set.
      const pdfLang = estimate.client_language;
      const pdfT = getT(pdfLang);
      const statusLabel = pdfT[STATUS_COLORS[estimate.status]?.labelKey] || estimate.status;
      const el = React.createElement(EstimatePDF, { estimate, currency, companyInfo: companyRes.data || {}, language: pdfLang, statusLabel });
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = String(estimate.estimate_number || estimate.id).replace(/[^a-z0-9]/gi, '');
      a.download = `estimate-${safe}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(t.estErrPdf);
    } finally {
      setPdfGenerating(false);
    }
  }

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
      toast(t.estToastSent, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.estErrSend);
    } finally {
      setBusy(false);
    }
  }

  // Get the client-facing link again for an already-sent estimate. The raw token
  // isn't in the estimate payload (server keeps it out), so fetch it, reveal the
  // link card, and auto-copy — same end state as right after sending.
  async function copyLink() {
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await api.post(`/estimates/${id}/link`);
      setSendToken(data.response_token);
      const url = `${window.location.origin}/e/${data.response_token}`;
      try { await navigator.clipboard?.writeText(url); } catch {}
      toast(t.estToastLinkCopied, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.estErrLink);
    } finally {
      setBusy(false);
    }
  }

  async function attachPlan(file) {
    if (!file) return;
    setActionError(null);
    setBusy(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const { data } = await api.post(`/estimates/${id}/plan-pdf`, { dataUrl, name: file.name });
      setEstimate(data);
      toast(t.estPlanAttached, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.estPlanAttachError);
    } finally {
      setBusy(false);
    }
  }

  async function removePlan() {
    setBusy(true);
    setActionError(null);
    try {
      const { data } = await api.delete(`/estimates/${id}/plan-pdf`);
      setEstimate(data);
    } catch (err) {
      setActionError(err.response?.data?.error || t.estPlanAttachError);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!await confirm({
      title: t.estWithdrawConfirmTitle,
      body: t.estWithdrawConfirmBody,
      confirmLabel: t.estWithdraw,
      tone: 'danger',
    })) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/estimates/${id}/withdraw`);
      toast(t.estToastWithdrawn, 'success');
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || t.estErrWithdraw);
    } finally {
      setBusy(false);
    }
  }

  // Clone this estimate into a fresh draft (the "duplicate to revise" path +
  // repeat-job reuse). Returns to the list, where the new "… (copy)" draft shows.
  async function duplicate() {
    setBusy(true);
    setActionError(null);
    try {
      const { data } = await api.post(`/estimates/${id}/duplicate`);
      toast(`${t.estToastDuplicated} ${data.estimate_number}`, 'success');
      onBack();
    } catch (err) {
      setActionError(err.response?.data?.error || t.estErrDuplicate);
    } finally {
      setBusy(false);
    }
  }

  // Admin records a deal closed off-app (phone / handshake), then is offered to
  // convert straight to a project — so a won job never gets stuck in "sent".
  async function markAccepted() {
    if (!await confirm({
      title: t.estMarkAcceptedTitle,
      body: t.estMarkAcceptedBody,
      confirmLabel: t.estMarkAccepted,
    })) return;
    setBusy(true);
    setActionError(null);
    let ok = false;
    try {
      await api.post(`/estimates/${id}/accept`, {});
      toast(t.estToastAccepted, 'success');
      await load();
      ok = true;
    } catch (err) {
      setActionError(err.response?.data?.error || t.estErrAccept);
    } finally {
      setBusy(false);
    }
    if (ok && await confirm({
      title: t.estConvertConfirmTitle,
      body: t.estConvertNowBody,
      confirmLabel: t.estConvert,
    })) {
      await convert();
    }
  }

  async function convert() {
    if (!await confirm({
      title: t.estConvertConfirmTitle,
      body: t.estConvertConfirmBody,
      confirmLabel: t.estConvert,
    })) return;
    setBusy(true);
    setActionError(null);
    try {
      const { data } = await api.post(`/estimates/${id}/convert`);
      toast(`${t.estToastConvertedPrefix} ${data.categories_seeded || 0} ${t.estToastConvertedSuffix}`, 'success');
      await load();
    } catch (err) {
      setActionError(err.response?.data?.error || t.estErrConvert);
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

  // Full markup→tax cascade, same helper the PDF uses, so the on-screen
  // totals match the downloaded document to the cent.
  const breakdown = computeBreakdown({
    subtotalCents: estimate.subtotal_cents,
    overheadPct: estimate.overhead_pct,
    marginPct: estimate.margin_pct,
    contingencyPct: estimate.contingency_pct,
    taxPct: estimate.tax_pct,
  });

  return (
    <div className="admin-page-shell">
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← {t.estBackToList}</button>
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
          <button onClick={downloadPDF} disabled={pdfGenerating} style={styles.ghostBtn}>
            {pdfGenerating ? t.estGenerating : t.estDownloadPdf}
          </button>
          <button onClick={duplicate} disabled={busy} style={styles.ghostBtn}>{t.estDuplicate}</button>
          {isDraft && (
            <>
              <button onClick={onEdit} style={styles.ghostBtn}>{t.estEdit}</button>
              <button onClick={send} disabled={busy} style={styles.primaryBtn}>
                {busy ? t.estSending : t.estSendToClient}
              </button>
            </>
          )}
          {!isDraft && (
            <button onClick={copyLink} disabled={busy} style={styles.ghostBtn}>🔗 {t.estCopyLink}</button>
          )}
          {isSent && (
            <button onClick={withdraw} disabled={busy} style={styles.ghostBtn}>{t.estWithdraw}</button>
          )}
          {(isDraft || isSent) && (
            <button onClick={markAccepted} disabled={busy} style={styles.primaryBtn}>{t.estMarkAccepted}</button>
          )}
          {isAccepted && !estimate.converted_project_id && (
            <button onClick={convert} disabled={busy} style={styles.primaryBtn}>
              {t.estConvertToProject}
            </button>
          )}
          {estimate.converted_project_id && (
            <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
              ✓ {t.estConvertedToProject} #{estimate.converted_project_id}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>📐 {t.estPlans}</span>
        {estimate.plan_pdf_url ? (
          <>
            <a href={estimate.plan_pdf_url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--ops-page-accent)', fontWeight: 600, wordBreak: 'break-all' }}>
              {estimate.plan_pdf_name || 'plan.pdf'}
            </a>
            <button onClick={removePlan} disabled={busy} style={{ ...styles.ghostBtn, padding: '4px 10px', fontSize: 12 }}>{t.estPlanRemove}</button>
            {hasPlanroom && (
              <a
                className="ops-button-primary"
                href={`/tool-apps/planroom/index.html?estimate=${estimate.id}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => { if (isImpersonating()) { e.preventDefault(); openToolTab(`/tool-apps/planroom/index.html?estimate=${estimate.id}`); } }}
                style={{ fontSize: 12, padding: '5px 12px', textDecoration: 'none' }}
              >
                📐 {t.estTakeoffInPlanRoom}
              </a>
            )}
          </>
        ) : (
          <span style={{ fontSize: 13, color: '#6b7280' }}>{t.estPlanNone}</span>
        )}
        <label style={{ ...styles.ghostBtn, padding: '4px 10px', fontSize: 12, cursor: busy ? 'default' : 'pointer', marginLeft: 'auto' }}>
          {busy ? t.estGenerating : (estimate.plan_pdf_url ? t.estPlanReplace : t.estPlanAttach)}
          <input type="file" accept="application/pdf,image/*" hidden disabled={busy} onChange={e => { const f = e.target.files[0]; e.target.value = ''; attachPlan(f); }} />
        </label>
      </div>

      {actionError && <div style={styles.errorBox}>{actionError}</div>}

      {sendToken && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>{t.estAcceptanceLink}</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 12px' }}>
            {t.estAcceptanceLinkBody}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={`${window.location.origin}/e/${sendToken}`}
              onClick={e => e.target.select()}
              style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
            />
            <button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/e/${sendToken}`)} style={styles.primaryBtn}>
              {t.estCopy}
            </button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.estLineItems}</h3>
        {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
          <div key={category} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              {t[CATEGORY_LABEL_KEYS[category]]}
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
          <TotalsRow label={t.estSubtotal} value={breakdown.subtotal} />
          {estimate.overhead_pct > 0 && <TotalsRow label={`${t.estOverhead} (${estimate.overhead_pct}%)`} value={breakdown.overhead} />}
          {estimate.margin_pct > 0 && <TotalsRow label={`${t.estMargin} (${estimate.margin_pct}%)`} value={breakdown.margin} />}
          {estimate.contingency_pct > 0 && <TotalsRow label={`${t.estContingency} (${estimate.contingency_pct}%)`} value={breakdown.contingency} />}
          {estimate.tax_pct > 0 && <TotalsRow label={`${t.estTax} (${estimate.tax_pct}%)`} value={breakdown.tax} />}
          <TotalsRow label={t.estTotal} value={breakdown.total} bold />
        </div>
      </div>

      {(estimate.exclusions || estimate.terms) && (
        <div style={styles.formCard}>
          {estimate.exclusions && <>
            <h3 style={styles.formH3}>{t.estExclusions}</h3>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{estimate.exclusions}</pre>
          </>}
          {estimate.terms && <>
            <h3 style={styles.formH3}>{t.estTerms}</h3>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{estimate.terms}</pre>
          </>}
        </div>
      )}

      {estimate.accepted_signer_name && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>{t.estAcceptedBy}</h3>
          <div style={{ fontSize: 14 }}>
            <strong>{estimate.accepted_signer_name}</strong> {t.estOn} {formatDateTime(estimate.responded_at, user?.language)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
// Estimates is a tab of the Projects module (see ProjectsPage), so this renders
// just the list/detail/form content — the surrounding shell, header, and module
// TabBar are provided by the Projects page.

export function EstimatesPanel() {
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
    <>
      {view.kind === 'list' && (
        <EstimatesList onOpen={openDetail} onNew={openNew} />
      )}
      {view.kind === 'detail' && (
        <EstimateDetail id={view.id} onBack={backToList} onEdit={openEdit} />
      )}
      {view.kind === 'form' && (
        <EstimateFormLoader existing={view.existing} onSave={(saved) => setView({ kind: 'detail', id: saved.id })} onCancel={() => view.existing ? setView({ kind: 'detail', id: view.existing.id }) : backToList()} />
      )}
    </>
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
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  ghostBtn:   { background: '#fff', color: '#374151', border: '1px solid #cbd5e1', padding: '9px 14px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  iconBtn:    { background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px' },
  searchInput: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, flex: 1, minWidth: 240 },
  select: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  inputInvalid: { borderColor: 'var(--ops-danger, #dc2626)', boxShadow: '0 0 0 1px var(--ops-danger, #dc2626)' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tableRow: { borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  td: { padding: '12px 14px', color: '#111827' },
  formCard: { background: '#fff', borderRadius: 8, padding: 18, marginBottom: 16, border: '1px solid var(--ops-border, #e2e8f0)', boxShadow: 'var(--ops-shadow-sm, 0 1px 4px rgba(15,23,42,0.04))' },
  formH3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 },
  linesTableWrap: { overflowX: 'auto' },
  lineTh: { textAlign: 'left', padding: '6px 4px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' },
  lineTd: { padding: '4px', verticalAlign: 'middle' },
  totalsBox: { background: '#f9fafb', padding: '12px 16px', borderRadius: 6, marginTop: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
