// Change orders portfolio — mid-project scope adjustments that bump
// budget categories on accept. Mirrors EstimatesPage structurally
// because the data shape and lifecycle are so similar, but each CO is
// tied to an existing project (no "create from scratch" path that
// stands alone).

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
import { useT } from '../hooks/useT';
import { getT } from '../i18n';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { formatMoney } from '../utils/format';
import { formatDate, formatDateTime } from '../utils';
import { computeBreakdown } from '../utils/estimateMath';
import { silentError } from '../errorReporter';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

const STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', fg: '#374151', labelKey: 'coStatusDraft' },
  sent:      { bg: '#dbeafe', fg: '#1d4ed8', labelKey: 'coStatusSent' },
  accepted:  { bg: '#d1fae5', fg: '#065f46', labelKey: 'coStatusAccepted' },
  declined:  { bg: '#fee2e2', fg: '#991b1b', labelKey: 'coStatusDeclined' },
  withdrawn: { bg: '#e5e7eb', fg: '#6b7280', labelKey: 'coStatusWithdrawn' },
};

// Displayed category labels, resolved per-render via t[CATEGORY_LABEL_KEYS[c]].
const CATEGORY_LABEL_KEYS = {
  labor:       'coCatLabor',
  materials:   'coCatMaterials',
  equipment:   'coCatEquipment',
  subs:        'coCatSubs',
  overhead:    'coCatOverhead',
  contingency: 'coCatContingency',
  other:       'coCatOther',
};

function StatusBadge({ status }) {
  const t = useT();
  const c = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{t[c.labelKey]}</span>
  );
}

const formatCents = (c) => formatMoney(c, { showCents: true });

// ── List view ────────────────────────────────────────────────────────────────

function ChangeOrdersList({ onOpen, onNew }) {
  const t = useT();
  const { user } = useAuth();
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
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label={t.coFilterStatusAria}
            style={styles.select}
          >
            <option value="">{t.coAllStatuses}</option>
            {Object.entries(STATUS_COLORS).map(([k, v]) => (
              <option key={k} value={k}>{t[v.labelKey]}</option>
            ))}
          </select>
        </div>
        <button onClick={() => onNew(projects)} style={styles.primaryBtn}>+ {t.coNew}</button>
      </div>
      {loading ? <SkeletonList rows={4} /> :
        items.length === 0 ? (
          <EmptyState
            title={t.coEmptyTitle}
            body={t.coEmptyBody}
            actionLabel={`+ ${t.coNew}`}
            onAction={() => onNew(projects)}
          />
        ) : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="co_number" sort={sort} setSort={setSort}>{t.coNumber}</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>{t.coProject}</SortHeader>
                  <SortHeader sortKey="description" sort={sort} setSort={setSort}>{t.coDescription}</SortHeader>
                  <SortHeader sortKey="total_cents" sort={sort} setSort={setSort} align="right">{t.coTotal}</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>{t.coStatus}</SortHeader>
                  <SortHeader sortKey="created_at" sort={sort} setSort={setSort}>{t.coCreated}</SortHeader>
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
                    <td style={styles.td}>{formatDate(co.created_at, user?.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-cards-mobile">
            {sortedItems.map(co => (
              <div
                key={co.id}
                className="admin-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(co.id)}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen(co.id))}
              >
                <div className="admin-card-row">
                  <span className="admin-card-title">{co.co_number}</span>
                  <StatusBadge status={co.status} />
                </div>
                <div className="admin-card-sub">{co.project_name}</div>
                <div className="admin-card-sub" style={{ color: '#374151' }}>{co.description}</div>
                <div className="admin-card-row">
                  <span className="admin-card-sub">{formatDate(co.created_at, user?.language)}</span>
                  <strong style={{ fontSize: 14 }}>{formatCents(co.total_cents)}</strong>
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

// ── Create form ──────────────────────────────────────────────────────────────

function NewChangeOrderForm({ projects, onSave, onCancel }) {
  const t = useT();
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [head, setHead] = useState({
    description: '', overhead_pct: 0, margin_pct: 0, tax_pct: 0, notes: '',
  });
  const [lines, setLines] = useState([{ category: 'labor', description: '', qty: 1, unit: 'hr', unit_cost_cents: 0 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  function clearFieldError(k) {
    setFieldErrors(prev => (prev[k] ? { ...prev, [k]: undefined } : prev));
  }
  function updateHead(k, v) { setDirty(true); clearFieldError(k); setHead(h => ({ ...h, [k]: v })); }
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
    setError(null);
    const fe = {};
    if (!projectId) fe.projectId = t.coErrChooseProject;
    if (!head.description.trim()) fe.description = t.coErrDescRequired;
    if (Object.keys(fe).length) { setFieldErrors(fe); return; }
    setFieldErrors({}); setSaving(true);
    try {
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
      setError(err.response?.data?.error || t.coErrSave);
    } finally { setSaving(false); }
  }

  return (
    <div className="admin-page-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>{t.coFormNewTitle}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={styles.ghostBtn}>{t.coCancel}</button>
          <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
            {saving ? t.coSaving : t.coSave}
          </button>
        </div>
      </div>
      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.coProject}</h3>
        <div className="admin-form-grid-2">
          <Field label={t.coProject} required error={fieldErrors.projectId}>
            <select value={projectId} onChange={e => { setDirty(true); clearFieldError('projectId'); setProjectId(e.target.value); }} style={{ ...styles.input, ...(fieldErrors.projectId ? styles.inputInvalid : {}) }}>
              <option value="">{t.coChoose}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t.coDescription} required error={fieldErrors.description}>
            <input value={head.description} onChange={e => updateHead('description', e.target.value)} placeholder={t.coDescPlaceholder} style={{ ...styles.input, ...(fieldErrors.description ? styles.inputInvalid : {}) }} />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.coLineItems}</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={styles.lineTh}>{t.coCategory}</th>
                <th style={styles.lineTh}>{t.coDescription}</th>
                <th style={{ ...styles.lineTh, width: 80 }}>{t.coQty}</th>
                <th style={{ ...styles.lineTh, width: 80 }}>{t.coUnit}</th>
                <th style={{ ...styles.lineTh, width: 120, textAlign: 'right' }}>{t.coUnitCost}</th>
                <th style={{ ...styles.lineTh, width: 100, textAlign: 'right' }}>{t.coTotal}</th>
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
                      <button onClick={() => removeLine(i)} style={styles.iconBtn} title={t.coRemove}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button onClick={addLine} style={{ ...styles.ghostBtn, marginTop: 12 }}>+ {t.coAddLine}</button>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.coMarkupTax}</h3>
        <div className="admin-form-grid-4">
          <Field label={t.coOverheadPct}>
            <input type="number" step="0.1" min="0" max="100" value={head.overhead_pct} onChange={e => updateHead('overhead_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.coMarginPct}>
            <input type="number" step="0.1" min="0" max="100" value={head.margin_pct} onChange={e => updateHead('margin_pct', e.target.value)} style={styles.input} />
          </Field>
          <Field label={t.coTaxPct}>
            <input type="number" step="0.01" min="0" max="100" value={head.tax_pct} onChange={e => updateHead('tax_pct', e.target.value)} style={styles.input} />
          </Field>
          <div />
        </div>
        <div style={styles.totalsBox}>
          <TotalsRow label={t.coSubtotal} value={totals.subtotal} />
          <TotalsRow label={`${t.coOverhead} (${head.overhead_pct || 0}%)`} value={totals.overhead} />
          <TotalsRow label={`${t.coMargin} (${head.margin_pct || 0}%)`} value={totals.margin} />
          <TotalsRow label={`${t.coTax} (${head.tax_pct || 0}%)`} value={totals.tax} />
          <TotalsRow label={t.coTotalBumpBudget} value={totals.total} bold />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.coInternalNotes}</h3>
        <textarea value={head.notes} onChange={e => updateHead('notes', e.target.value)} style={{ ...styles.input, minHeight: 50 }} />
      </div>

      <div className="ops-form-actions">
        <button onClick={onCancel} style={styles.ghostBtn}>{t.coCancel}</button>
        <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.coSaving : t.coSave}
        </button>
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function ChangeOrderDetail({ id, onBack }) {
  const t = useT();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [co, setCo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sendToken, setSendToken] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);

  // Browser-side CO PDF — lazy-imports react-pdf only on download and
  // pulls company letterhead from /company-info. Mirrors the estimate
  // and lien-waiver PDF flow.
  async function downloadPDF() {
    if (!co) return;
    setPdfGenerating(true);
    setError(null);
    try {
      const [{ pdf }, { default: ChangeOrderPDF }, companyRes] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../components/ChangeOrderPDF'),
        api.get('/company-info').catch(() => ({ data: {} })),
      ]);
      // Render the PDF in the CLIENT's language (resolved from the
      // project's client), not the admin's UI language.
      const pdfT = getT(co.client_language);
      const statusLabel = pdfT[STATUS_COLORS[co.status]?.labelKey] || co.status;
      const el = React.createElement(ChangeOrderPDF, { changeOrder: co, companyInfo: companyRes.data || {}, t: pdfT, statusLabel });
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = String(co.co_number || co.id).replace(/[^a-z0-9]/gi, '');
      a.download = `change-order-${safe}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(t.coErrPdf);
    } finally {
      setPdfGenerating(false);
    }
  }

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
      toast(t.coToastSent, 'success');
    } catch (err) {
      setError(err.response?.data?.error || t.coErrSend);
    } finally { setBusy(false); }
  }
  async function withdraw() {
    if (!await confirm({
      title: t.coWithdrawConfirmTitle,
      confirmLabel: t.coWithdraw,
      tone: 'danger',
    })) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/change-orders/${id}/withdraw`);
      toast(t.coToastWithdrawn, 'success');
      await load();
    } catch (err) { setError(err.response?.data?.error || t.coErrWithdraw); }
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

  // Full markup→tax cascade (COs carry no separate contingency), same
  // helper the PDF uses, so screen and document agree to the cent.
  const breakdown = computeBreakdown({
    subtotalCents: co.subtotal_cents,
    overheadPct: co.overhead_pct,
    marginPct: co.margin_pct,
    contingencyPct: 0,
    taxPct: co.tax_pct,
  });

  return (
    <div className="admin-page-shell">
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← {t.coBackToList}</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>
            {co.co_number} <StatusBadge status={co.status} />
          </h1>
          <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>{co.project_name}</div>
          <div style={{ fontSize: 14, color: '#111827', marginTop: 4 }}>{co.description}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={downloadPDF} disabled={pdfGenerating} style={styles.ghostBtn}>
            {pdfGenerating ? t.coGenerating : t.coDownloadPdf}
          </button>
          {isDraft && (
            <button onClick={send} disabled={busy} style={styles.primaryBtn}>
              {busy ? t.coSending : t.coSendToClient}
            </button>
          )}
          {isSent && (
            <button onClick={withdraw} disabled={busy} style={styles.ghostBtn}>{t.coWithdraw}</button>
          )}
          {co.budget_applied_at && (
            <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
              ✓ {t.coBudgetBumped} {formatDate(co.budget_applied_at, user?.language)}
            </span>
          )}
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {sendToken && (
        <div style={{ ...styles.formCard, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <h3 style={styles.formH3}>{t.coAcceptanceLink}</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 12px' }}>
            {t.coAcceptanceLinkBody}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={`${window.location.origin}/co/${sendToken}`}
              onClick={e => e.target.select()}
              style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
            />
            <button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/co/${sendToken}`)} style={styles.primaryBtn}>{t.coCopy}</button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.coLineItems}</h3>
        {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
          <div key={category} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{t[CATEGORY_LABEL_KEYS[category]]}</div>
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
          <TotalsRow label={t.coSubtotal} value={breakdown.subtotal} />
          {co.overhead_pct > 0 && <TotalsRow label={`${t.coOverhead} (${co.overhead_pct}%)`} value={breakdown.overhead} />}
          {co.margin_pct > 0 && <TotalsRow label={`${t.coMargin} (${co.margin_pct}%)`} value={breakdown.margin} />}
          {co.tax_pct > 0 && <TotalsRow label={`${t.coTax} (${co.tax_pct}%)`} value={breakdown.tax} />}
          <TotalsRow label={t.coTotal} value={breakdown.total} bold />
        </div>
      </div>

      {co.accepted_signer_name && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>{t.coAcceptedBy}</h3>
          <div style={{ fontSize: 14 }}>
            <strong>{co.accepted_signer_name}</strong> on {formatDateTime(co.responded_at, user?.language)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────
// Change Orders is a tab of the Projects module (see ProjectsPage); this renders
// just the list/detail/form content. The shell, header, and module TabBar come
// from the Projects page.

export function ChangeOrdersPanel() {
  const [view, setView] = useState({ kind: 'list' });

  function openNew(projects) { setView({ kind: 'form', projects }); }
  function openDetail(id)    { setView({ kind: 'detail', id }); }
  function backToList()      { setView({ kind: 'list' }); }

  return (
    <>
      {view.kind === 'list' && <ChangeOrdersList onOpen={openDetail} onNew={openNew} />}
      {view.kind === 'detail' && <ChangeOrderDetail id={view.id} onBack={backToList} />}
      {view.kind === 'form' && (
        <NewChangeOrderForm projects={view.projects || []} onSave={(saved) => setView({ kind: 'detail', id: saved.id })} onCancel={backToList} />
      )}
    </>
  );
}

// ── Small parts ──────────────────────────────────────────────────────────────

function Field({ label, required, error, children }) {
  const t = useT();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
      <span>
        {label}
        {required && (
          <>
            <span aria-hidden="true" style={{ color: '#ef4444' }}>*</span>
            <span className="sr-only"> ({t.coRequired})</span>
          </>
        )}
      </span>
      {children}
      {error && <span className="ops-field-error" role="alert">{error}</span>}
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
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  ghostBtn:   { background: '#fff', color: '#374151', border: '1px solid #cbd5e1', padding: '9px 14px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  iconBtn:    { background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px' },
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
  lineTh: { textAlign: 'left', padding: '6px 4px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' },
  lineTd: { padding: '4px', verticalAlign: 'middle' },
  totalsBox: { background: '#f9fafb', padding: '12px 16px', borderRadius: 6, marginTop: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
