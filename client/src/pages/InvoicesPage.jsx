import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import MoneyInput from '../components/MoneyInput';
import Pagination from '../components/Pagination';
import SortHeader, { sortRows } from '../components/SortHeader';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useCents } from '../hooks/useMoney';
import { useCurrency } from '../contexts/SettingsContext';
import { formatDate } from '../utils';
import { silentError } from '../errorReporter';
import { useT } from '../hooks/useT';
import { getT } from '../i18n';

// Same seven money categories as the server CHECK constraint. Category labels
// reuse the estimate keys (estCat*) — the vocabulary is identical.
const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const CATEGORY_LABEL_KEYS = {
  labor: 'estCatLabor', materials: 'estCatMaterials', equipment: 'estCatEquipment',
  subs: 'estCatSubs', overhead: 'estCatOverhead', contingency: 'estCatContingency', other: 'estCatOther',
};

const STATUS_COLORS = {
  draft:   { bg: '#f3f4f6', fg: '#374151', labelKey: 'invStatusDraft' },
  sent:    { bg: '#dbeafe', fg: '#1d4ed8', labelKey: 'invStatusSent' },
  partial: { bg: '#fef3c7', fg: '#92400e', labelKey: 'invStatusPartial' },
  paid:    { bg: '#d1fae5', fg: '#065f46', labelKey: 'invStatusPaid' },
  void:    { bg: '#e5e7eb', fg: '#6b7280', labelKey: 'invStatusVoid' },
};

const PAYMENT_METHODS = ['check', 'card', 'cash', 'ach', 'other'];
const METHOD_LABEL_KEYS = {
  check: 'invMethodCheck', card: 'invMethodCard', cash: 'invMethodCash', ach: 'invMethodAch', other: 'invMethodOther',
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

// ── List ──────────────────────────────────────────────────────────────────────

function InvoicesList({ onOpen, onNew, onFromEstimate, onFromProject }) {
  const formatCents = useCents();
  const t = useT();
  const { user } = useAuth();
  const [invoices, setInvoices] = useState([]);
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
      const { data } = await api.get('/invoices', { params });
      setInvoices(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) {
      silentError(err);
    } finally {
      setLoading(false);
    }
  }, [filter, statusFilter, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [filter, statusFilter]);

  const sorted = useMemo(
    () => sortRows(invoices, sort, {
      total_cents: r => parseFloat(r.total_cents) || 0,
      amount_paid_cents: r => parseFloat(r.amount_paid_cents) || 0,
      // The "Balance" column shows total − paid, so it must sort by that, not by amount paid.
      balance: r => Math.max(0, (parseInt(r.total_cents, 10) || 0) - (parseInt(r.amount_paid_cents, 10) || 0)),
      created_at: r => r.created_at,
    }),
    [invoices, sort]
  );

  const balanceOf = r => Math.max(0, (parseInt(r.total_cents, 10) || 0) - (parseInt(r.amount_paid_cents, 10) || 0));

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          <input
            type="search"
            placeholder={t.invSearchPlaceholder}
            aria-label={t.invSearchAria}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={styles.searchInput}
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label={t.invFilterStatusAria}
            style={styles.select}
          >
            <option value="">{t.invAllStatuses}</option>
            {Object.entries(STATUS_COLORS).map(([k, v]) => (
              <option key={k} value={k}>{t[v.labelKey]}</option>
            ))}
          </select>
        </div>
        <NewInvoiceMenu onNew={onNew} onFromEstimate={onFromEstimate} onFromProject={onFromProject} />
      </div>
      {loading ? <SkeletonList rows={4} /> :
        invoices.length === 0 ? (
          <EmptyState
            title={t.invEmptyTitle}
            body={t.invEmptyBody}
            actionLabel={t.invNewBlank}
            onAction={onNew}
          />
        ) : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="invoice_number" sort={sort} setSort={setSort}>{t.invNumber}</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>{t.invProject}</SortHeader>
                  <SortHeader sortKey="client_name_snapshot" sort={sort} setSort={setSort}>{t.invClient}</SortHeader>
                  <SortHeader sortKey="total_cents" sort={sort} setSort={setSort} align="right">{t.invTotal}</SortHeader>
                  <SortHeader sortKey="balance" sort={sort} setSort={setSort} align="right">{t.invBalance}</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>{t.invStatus}</SortHeader>
                  <SortHeader sortKey="created_at" sort={sort} setSort={setSort}>{t.invCreated}</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sorted.map(inv => (
                  <tr key={inv.id} style={styles.tableRow} onClick={() => onOpen(inv.id)}>
                    <td style={styles.td}><strong>{inv.invoice_number}</strong></td>
                    <td style={styles.td}>{inv.project_name}</td>
                    <td style={styles.td}>{inv.client_name_snapshot}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(inv.total_cents)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(balanceOf(inv))}</td>
                    <td style={styles.td}><StatusBadge status={inv.status} /></td>
                    <td style={styles.td}>{formatDate(inv.created_at, user?.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-cards-mobile">
            {sorted.map(inv => (
              <div
                key={inv.id}
                className="admin-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(inv.id)}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen(inv.id))}
              >
                <div className="admin-card-row">
                  <span className="admin-card-title">{inv.invoice_number}</span>
                  <StatusBadge status={inv.status} />
                </div>
                <div className="admin-card-sub">{inv.project_name}</div>
                <div className="admin-card-sub">{inv.client_name_snapshot}</div>
                <div className="admin-card-row">
                  <span className="admin-card-sub">{t.invBalance}: {formatCents(balanceOf(inv))}</span>
                  <strong style={{ fontSize: 14 }}>{formatCents(inv.total_cents)}</strong>
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

// "New" split into three sources (David's decision: scratch / estimate / project).
function NewInvoiceMenu({ onNew, onFromEstimate, onFromProject }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={styles.primaryBtn}>{t.invNew}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={styles.menu}>
            <div style={styles.menuHead}>{t.invNewChoose}</div>
            <button style={styles.menuItem} onClick={() => { setOpen(false); onNew(); }}>{t.invNewBlank}</button>
            <button style={styles.menuItem} onClick={() => { setOpen(false); onFromEstimate(); }}>{t.invNewFromEstimate}</button>
            <button style={styles.menuItem} onClick={() => { setOpen(false); onFromProject(); }}>{t.invNewFromProject}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Source pickers (from-estimate / from-project) ──────────────────────────────

function SourcePicker({ title, placeholder, fetchItems, renderItem, onPick, onCancel }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchItems().then(rows => setItems(rows || [])).catch(() => setItems([])).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = q
    ? items.filter(it => JSON.stringify(it).toLowerCase().includes(q.toLowerCase()))
    : items;

  async function pick(it) {
    setBusy(true);
    try { await onPick(it); } finally { setBusy(false); }
  }

  return (
    <div className="admin-page-shell">
      <div style={{ marginBottom: 16 }}>
        <button onClick={onCancel} style={styles.ghostBtn}>← {t.invBackToList}</button>
      </div>
      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{title}</h3>
        <input autoFocus placeholder={placeholder} value={q} onChange={e => setQ(e.target.value)} style={{ ...styles.input, marginBottom: 12 }} />
        {loading ? <SkeletonList rows={3} /> :
          filtered.length === 0 ? (
            <div style={{ fontSize: 14, color: '#6b7280', padding: 16 }}>{t.invNoMatches}</div>
          ) : (
            <div>
              {filtered.map(it => (
                <button key={it.id} disabled={busy} onClick={() => pick(it)} style={styles.pickRow}>
                  {renderItem(it)}
                </button>
              ))}
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Create / edit draft form ───────────────────────────────────────────────────

function InvoiceForm({ existing, onSave, onCancel }) {
  const formatCents = useCents();
  const t = useT();
  const toast = useToast();
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const [head, setHead] = useState({
    project_name: existing?.project_name || '',
    client_name_snapshot: existing?.client_name_snapshot || '',
    client_email: existing?.client_email || '',
    project_address: existing?.project_address || '',
    tax_pct: existing?.tax_pct || 0,
    retainage_pct: existing?.retainage_pct || 0,
    issue_date: existing?.issue_date ? existing.issue_date.slice(0, 10) : '',
    due_date: existing?.due_date ? existing.due_date.slice(0, 10) : '',
    terms: existing?.terms || '',
    notes: existing?.notes || '',
  });
  const [lines, setLines] = useState(existing?.lines?.length > 0
    ? existing.lines.map(l => ({ ...l }))
    : [{ category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0 }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  function clearFieldError(k) { setFieldErrors(prev => (prev[k] ? { ...prev, [k]: undefined } : prev)); }
  function updateHead(k, v) { setDirty(true); clearFieldError(k); setHead(h => ({ ...h, [k]: v })); }
  function updateLine(i, k, v) { setDirty(true); setLines(arr => arr.map((line, idx) => idx === i ? { ...line, [k]: v } : line)); }
  function addLine() { setDirty(true); setLines(arr => [...arr, { category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0 }]); }
  function removeLine(i) { setDirty(true); setLines(arr => arr.filter((_, idx) => idx !== i)); }

  // Live totals — mirrors server computeInvoiceTotals (subtotal → tax → retainage).
  const totals = (() => {
    const subtotal = lines.reduce((sum, l) => {
      const cents = Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unit_cost_cents, 10) || 0));
      return sum + Math.max(0, cents);
    }, 0);
    const txPct = parseFloat(head.tax_pct) || 0;
    const rtPct = parseFloat(head.retainage_pct) || 0;
    const tax = Math.round(subtotal * (txPct / 100));
    const total = subtotal + tax;
    const retainage_held = Math.round(total * (rtPct / 100));
    return { subtotal, tax, total, retainage_held };
  })();

  async function handleSave() {
    setError(null);
    const fe = {};
    if (!head.client_name_snapshot.trim()) fe.client_name_snapshot = t.invErrClientNameRequired;
    if (Object.keys(fe).length) { setFieldErrors(fe); return; }
    setFieldErrors({});
    setSaving(true);
    try {
      const payload = {
        ...head,
        project_name: head.project_name || null,
        issue_date: head.issue_date || null,
        due_date: head.due_date || null,
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
        await api.patch(`/invoices/${existing.id}`, payload);
        await api.put(`/invoices/${existing.id}/lines`, { lines: payload.lines });
        response = await api.get(`/invoices/${existing.id}`);
      } else {
        response = await api.post('/invoices', payload);
      }
      toast(existing ? t.invToastUpdated : t.invToastSaved, 'success');
      setDirty(false);
      onSave(response.data);
    } catch (err) {
      setError(err.response?.data?.error || t.invErrSave);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-page-shell">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>
          {existing ? `${t.invEdit} ${existing.invoice_number || ''}` : t.invFormNewTitle}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={styles.ghostBtn}>{t.invCancel}</button>
          <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
            {saving ? t.invSaving : t.invSave}
          </button>
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.invClientSection}</h3>
        <div className="admin-form-grid-2">
          <Field label={t.invClientName} required error={fieldErrors.client_name_snapshot}>
            <input value={head.client_name_snapshot} onChange={e => updateHead('client_name_snapshot', e.target.value)} style={{ ...styles.input, ...(fieldErrors.client_name_snapshot ? styles.inputInvalid : {}) }} />
          </Field>
          <Field label={t.invClientEmail}>
            <input type="email" value={head.client_email} onChange={e => updateHead('client_email', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.invProjectName}>
            <input value={head.project_name} onChange={e => updateHead('project_name', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.invProjectAddress}>
            <input value={head.project_address} onChange={e => updateHead('project_address', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.invIssueDate}>
            <input type="date" value={head.issue_date} onChange={e => updateHead('issue_date', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.invDueDate}>
            <input type="date" value={head.due_date} onChange={e => updateHead('due_date', e.target.value)} style={styles.input} />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.invLineItems}</h3>
        <div style={styles.linesTableWrap}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={styles.lineTh}>{t.invCategory}</th>
                <th style={styles.lineTh}>{t.invDescription}</th>
                <th style={{ ...styles.lineTh, width: 80 }}>{t.invQty}</th>
                <th style={{ ...styles.lineTh, width: 80 }}>{t.invUnit}</th>
                <th style={{ ...styles.lineTh, width: 120, textAlign: 'right' }}>{t.invUnitCost}</th>
                <th style={{ ...styles.lineTh, width: 100, textAlign: 'right' }}>{t.invTotal}</th>
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
                      <MoneyInput valueCents={l.unit_cost_cents} onChange={cents => updateLine(i, 'unit_cost_cents', cents)} style={{ padding: '6px 8px 6px 22px', fontSize: 14 }} />
                    </td>
                    <td style={{ ...styles.lineTd, textAlign: 'right', fontWeight: 600 }}>{formatCents(total)}</td>
                    <td style={styles.lineTd}>
                      <button onClick={() => removeLine(i)} style={styles.iconBtn} title={t.invRemove}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={addLine} style={styles.ghostBtn}>{t.invAddLine}</button>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.invSubtotal} · {t.invTax} · {t.invRetainagePct}</h3>
        <div className="admin-form-grid-2">
          <Field label={t.invTaxPct}>
            <input type="number" step="0.01" min="0" max="100" value={head.tax_pct} onChange={e => updateHead('tax_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.invRetainagePct}>
            <input type="number" step="0.1" min="0" max="100" value={head.retainage_pct} onChange={e => updateHead('retainage_pct', e.target.value)} style={styles.input} />
          </Field>
        </div>
        <div style={styles.totalsBox}>
          <TotalsRow label={t.invSubtotal} value={totals.subtotal} />
          <TotalsRow label={`${t.invTax} (${head.tax_pct || 0}%)`} value={totals.tax} />
          <TotalsRow label={t.invTotal} value={totals.total} bold />
          {totals.retainage_held > 0 && <TotalsRow label={`${t.invRetainageHeld} (${head.retainage_pct || 0}%)`} value={totals.retainage_held} />}
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.invNotesTerms}</h3>
        <Field label={t.invTerms}>
          <textarea value={head.terms} onChange={e => updateHead('terms', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
        <Field label={t.invNotesInternal}>
          <textarea value={head.notes} onChange={e => updateHead('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
        </Field>
      </div>

      <div className="ops-form-actions">
        <button onClick={onCancel} style={styles.ghostBtn}>{t.invCancel}</button>
        <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.invSaving : t.invSave}
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
            <span className="sr-only"> ({t.invRequired})</span>
          </>
        )}
      </span>
      {children}
      {error && <span className="ops-field-error" role="alert">{error}</span>}
    </label>
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

// ── Detail ─────────────────────────────────────────────────────────────────────

function InvoiceDetail({ id, onBack, onEdit }) {
  const formatCents = useCents();
  const currency = useCurrency();
  const t = useT();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [sendToken, setSendToken] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/invoices/${id}`);
      setInvoice(data);
    } catch (err) {
      silentError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function downloadPDF() {
    if (!invoice) return;
    setPdfGenerating(true);
    setActionError(null);
    try {
      const [{ pdf }, { default: InvoicePDF }, companyRes] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../components/InvoicePDF'),
        api.get('/company-info').catch(() => ({ data: {} })),
      ]);
      const pdfLang = invoice.client_language;
      const pdfT = getT(pdfLang);
      const statusLabel = pdfT[STATUS_COLORS[invoice.status]?.labelKey] || invoice.status;
      const el = React.createElement(InvoicePDF, { invoice, currency, companyInfo: companyRes.data || {}, language: pdfLang, statusLabel });
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = String(invoice.invoice_number || invoice.id).replace(/[^a-z0-9]/gi, '');
      a.download = `invoice-${safe}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(t.invErrPdf);
    } finally {
      setPdfGenerating(false);
    }
  }

  async function send() {
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await api.post(`/invoices/${id}/send`);
      setInvoice(data);
      setSendToken(data.response_token);
      const url = `${window.location.origin}/i/${data.response_token}`;
      try { await navigator.clipboard?.writeText(url); } catch {}
      // The server emails the client when there's an email on file; otherwise the
      // admin shares the copied link (shown in the card below).
      if (data.email?.sent) toast(`${t.invToastEmailed} ${data.email.to}`, 'success');
      else toast(t.invToastSent, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.invErrSend);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await api.post(`/invoices/${id}/link`);
      setSendToken(data.response_token);
      const url = `${window.location.origin}/i/${data.response_token}`;
      try { await navigator.clipboard?.writeText(url); } catch {}
      toast(t.invToastLinkCopied, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.invErrLink);
    } finally {
      setBusy(false);
    }
  }

  async function recordPayment(payment) {
    setActionError(null);
    setBusy(true);
    try {
      const { data } = await api.post(`/invoices/${id}/payments`, payment);
      setInvoice(data);
      setShowPay(false);
      toast(t.invToastPayment, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.invErrPayment);
    } finally {
      setBusy(false);
    }
  }

  async function voidInvoice() {
    if (!await confirm({ title: t.invVoidConfirmTitle, body: t.invVoidConfirmBody, confirmLabel: t.invVoid, tone: 'danger' })) return;
    setBusy(true);
    setActionError(null);
    try {
      const { data } = await api.post(`/invoices/${id}/void`);
      setInvoice(data);
      toast(t.invToastVoided, 'success');
    } catch (err) {
      setActionError(err.response?.data?.error || t.invErrVoid);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!invoice) return null;

  const isDraft = invoice.status === 'draft';
  const isVoid = invoice.status === 'void';
  const canPay = ['sent', 'partial'].includes(invoice.status);
  const paid = parseInt(invoice.amount_paid_cents, 10) || 0;
  const total = parseInt(invoice.total_cents, 10) || 0;
  const balance = Math.max(0, total - paid);

  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of invoice.lines || []) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
  }

  return (
    <div className="admin-page-shell">
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← {t.invBackToList}</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>
            {invoice.invoice_number} <StatusBadge status={invoice.status} />
          </h1>
          <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
            {invoice.project_name ? `${invoice.project_name} · ` : ''}{invoice.client_name_snapshot}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={downloadPDF} disabled={pdfGenerating} style={styles.ghostBtn}>
            {pdfGenerating ? t.invGenerating : t.invDownloadPdf}
          </button>
          {isDraft && (
            <>
              <button onClick={onEdit} style={styles.ghostBtn}>{t.invEdit}</button>
              <button onClick={send} disabled={busy} style={styles.primaryBtn}>{busy ? t.invSending : t.invSendToClient}</button>
            </>
          )}
          {!isDraft && !isVoid && (
            <button onClick={copyLink} disabled={busy} style={styles.ghostBtn}>🔗 {t.invCopyLink}</button>
          )}
          {canPay && (
            <button onClick={() => setShowPay(v => !v)} disabled={busy} style={styles.primaryBtn}>{t.invRecordPayment}</button>
          )}
          {!isVoid && (
            <button onClick={voidInvoice} disabled={busy} style={styles.ghostBtn}>{t.invVoid}</button>
          )}
        </div>
      </div>

      {actionError && <div style={styles.errorBox}>{actionError}</div>}

      {sendToken && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>{t.invShareLink}</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 12px' }}>{t.invShareLinkBody}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={`${window.location.origin}/i/${sendToken}`} onClick={e => e.target.select()} style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, flex: 1 }} />
            <button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/i/${sendToken}`)} style={styles.primaryBtn}>{t.invCopy}</button>
          </div>
        </div>
      )}

      {showPay && (
        <PaymentForm balanceCents={balance} onSubmit={recordPayment} onCancel={() => setShowPay(false)} busy={busy} />
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.invLineItems}</h3>
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
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: '#6b7280', width: 100 }}>{l.qty} {l.unit || ''}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', width: 120 }}>{formatCents(l.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <div style={{ ...styles.totalsBox, marginTop: 16 }}>
          <TotalsRow label={t.invSubtotal} value={invoice.subtotal_cents} />
          {invoice.tax_pct > 0 && <TotalsRow label={`${t.invTax} (${invoice.tax_pct}%)`} value={invoice.tax_cents} />}
          <TotalsRow label={t.invTotal} value={invoice.total_cents} bold />
          {invoice.retainage_held_cents > 0 && <TotalsRow label={`${t.invRetainageHeld} (${invoice.retainage_pct}%)`} value={invoice.retainage_held_cents} />}
          {paid > 0 && <TotalsRow label={t.invAmountPaid} value={paid} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontWeight: 700, fontSize: 16, color: balance === 0 ? '#059669' : '#111827' }}>
            <span>{balance === 0 && total > 0 ? t.invPaidInFull : t.invBalanceDue}</span>
            <span>{formatCents(balance)}</span>
          </div>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.invPayments}</h3>
        {(invoice.payments || []).length === 0 ? (
          <div style={{ fontSize: 14, color: '#6b7280' }}>{t.invNoPayments}</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {invoice.payments.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '6px 0' }}>{formatDate(p.paid_date)}</td>
                  <td style={{ padding: '6px 8px', color: '#6b7280' }}>{t[METHOD_LABEL_KEYS[p.method]] || p.method}{p.reference ? ` · ${p.reference}` : ''}</td>
                  <td style={{ padding: '6px 0', textAlign: 'right', fontWeight: 600 }}>{formatCents(p.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {invoice.terms && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>{t.invTerms}</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{invoice.terms}</pre>
        </div>
      )}
    </div>
  );
}

function PaymentForm({ balanceCents, onSubmit, onCancel, busy }) {
  const t = useT();
  const [amount, setAmount] = useState(balanceCents);
  const [method, setMethod] = useState('check');
  const [paidDate, setPaidDate] = useState(() => {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [reference, setReference] = useState('');

  function submit() {
    const cents = parseInt(amount, 10) || 0;
    if (cents <= 0) return;
    onSubmit({ amount_cents: cents, method, paid_date: paidDate || null, reference: reference || null });
  }

  return (
    <div style={{ ...styles.formCard, background: '#f0fdf4', border: '1px solid #86efac' }}>
      <h3 style={styles.formH3}>{t.invRecordPayment}</h3>
      <div className="admin-form-grid-2">
        <Field label={t.invPaymentAmount}>
          <MoneyInput valueCents={amount} onChange={setAmount} style={{ padding: '8px 10px 8px 22px' }} />
        </Field>
        <Field label={t.invPaymentMethod}>
          <select value={method} onChange={e => setMethod(e.target.value)} style={styles.input}>
            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{t[METHOD_LABEL_KEYS[m]]}</option>)}
          </select>
        </Field>
        <Field label={t.invPaymentDate}>
          <input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.invPaymentReference}>
          <input value={reference} onChange={e => setReference(e.target.value)} style={styles.input} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onCancel} style={styles.ghostBtn}>{t.invCancel}</button>
        <button onClick={submit} disabled={busy} style={styles.primaryBtn}>{busy ? t.invRecording : t.invRecordBtn}</button>
      </div>
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────────
// Invoices is a tab of the Projects module (see ProjectsPage), so this renders
// just the list/detail/form content — the shell + module TabBar come from Projects.

export function InvoicesPanel() {
  const t = useT();
  const toast = useToast();
  const [view, setView] = useState({ kind: 'list' });

  function openDetail(id) { setView({ kind: 'detail', id }); }
  function openNew() { setView({ kind: 'form', existing: null }); }
  function openEdit() {
    if (view.kind !== 'detail') return;
    setView(v => ({ kind: 'form', existing: { id: v.id } }));
  }
  function backToList() { setView({ kind: 'list' }); }

  async function createFrom(path, item) {
    try {
      const { data } = await api.post(path);
      setView({ kind: 'detail', id: data.id });
    } catch (err) {
      toast(err.response?.data?.error || t.invErrCreateSource, 'error');
    }
  }

  return (
    <>
      {view.kind === 'list' && (
        <InvoicesList
          onOpen={openDetail}
          onNew={openNew}
          onFromEstimate={() => setView({ kind: 'pickEstimate' })}
          onFromProject={() => setView({ kind: 'pickProject' })}
        />
      )}
      {view.kind === 'pickEstimate' && (
        <SourcePicker
          title={t.invSelectEstimate}
          placeholder={t.invSearchEstimates}
          fetchItems={() => api.get('/estimates', { params: { status: 'accepted', limit: 100 } }).then(r => r.data.items || [])}
          renderItem={est => (
            <>
              <span style={{ fontWeight: 600 }}>{est.estimate_number}</span>
              <span style={{ color: '#6b7280' }}> · {est.project_name} · {est.client_name_snapshot}</span>
            </>
          )}
          onPick={est => createFrom(`/invoices/from-estimate/${est.id}`, est)}
          onCancel={backToList}
        />
      )}
      {view.kind === 'pickProject' && (
        <SourcePicker
          title={t.invSelectProject}
          placeholder={t.invSearchProjects}
          fetchItems={() => api.get('/projects').then(r => Array.isArray(r.data) ? r.data : (r.data.items || []))}
          renderItem={p => (
            <>
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              {p.client_name && <span style={{ color: '#6b7280' }}> · {p.client_name}</span>}
            </>
          )}
          onPick={p => createFrom(`/invoices/from-project/${p.id}`, p)}
          onCancel={backToList}
        />
      )}
      {view.kind === 'detail' && (
        <InvoiceDetail id={view.id} onBack={backToList} onEdit={openEdit} />
      )}
      {view.kind === 'form' && (
        <InvoiceFormLoader existing={view.existing} onSave={saved => setView({ kind: 'detail', id: saved.id })} onCancel={() => view.existing ? setView({ kind: 'detail', id: view.existing.id }) : backToList()} />
      )}
    </>
  );
}

function InvoiceFormLoader({ existing, onSave, onCancel }) {
  const t = useT();
  const needsLoad = !!(existing?.id && !existing?.client_name_snapshot);
  const [resolved, setResolved] = useState(existing && !existing.id ? existing : null);
  const [loading, setLoading] = useState(needsLoad);
  useEffect(() => {
    if (needsLoad) {
      api.get(`/invoices/${existing.id}`)
        .then(({ data }) => { setResolved(data); setLoading(false); })
        .catch(() => setLoading(false));
    }
  }, [existing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading) return <SkeletonList rows={4} />;
  // A failed edit-load must NOT fall through to a blank "New invoice" form —
  // saving that would create a duplicate. Show the error + a way back instead.
  if (needsLoad && !resolved) {
    return (
      <div className="admin-page-shell">
        <div style={styles.errorBox}>{t.invErrLoad}</div>
        <button onClick={onCancel} style={styles.ghostBtn}>← {t.invBackToList}</button>
      </div>
    );
  }
  return <InvoiceForm existing={resolved} onSave={onSave} onCancel={onCancel} />;
}

// ── Styles (mirrors EstimatesPage) ─────────────────────────────────────────────

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
  tableRow: { borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  td: { padding: '12px 14px', color: '#111827' },
  formCard: { background: '#fff', borderRadius: 8, padding: 18, marginBottom: 16, border: '1px solid var(--ops-border, #e2e8f0)', boxShadow: 'var(--ops-shadow-sm, 0 1px 4px rgba(15,23,42,0.04))' },
  formH3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' },
  linesTableWrap: { overflowX: 'auto' },
  lineTh: { textAlign: 'left', padding: '6px 4px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' },
  lineTd: { padding: '4px', verticalAlign: 'middle' },
  totalsBox: { background: '#f9fafb', padding: '12px 16px', borderRadius: 6, marginTop: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
  menu: { position: 'absolute', top: '100%', right: 0, marginTop: 6, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50, minWidth: 240, overflow: 'hidden' },
  menuHead: { fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 14px 6px' },
  menuItem: { display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '10px 14px', fontSize: 14, color: '#111827', cursor: 'pointer' },
  pickRow: { display: 'block', width: '100%', textAlign: 'left', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px', fontSize: 14, cursor: 'pointer', marginBottom: 6 },
};
