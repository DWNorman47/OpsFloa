import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import MoneyInput from '../components/MoneyInput';
import Pagination from '../components/Pagination';
import SortHeader, { sortRows } from '../components/SortHeader';
import TabBar from '../components/TabBar';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { formatMoney } from '../utils/format';
import { silentError } from '../errorReporter';
import { useT } from '../hooks/useT';

// ── Constants ────────────────────────────────────────────────────────────────

const PO_STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', fg: '#374151', labelKey: 'subStatusDraft' },
  issued:    { bg: '#dbeafe', fg: '#1d4ed8', labelKey: 'subStatusIssued' },
  partial:   { bg: '#fef3c7', fg: '#92400e', labelKey: 'subStatusPartial' },
  complete:  { bg: '#d1fae5', fg: '#065f46', labelKey: 'subStatusComplete' },
  cancelled: { bg: '#e5e7eb', fg: '#6b7280', labelKey: 'subStatusCancelled' },
};

function StatusBadge({ status }) {
  const t = useT();
  const c = PO_STATUS_COLORS[status] || PO_STATUS_COLORS.draft;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {t[c.labelKey]}
    </span>
  );
}

const formatCents = (c) => formatMoney(c, { showCents: true });

// ── Subs directory ───────────────────────────────────────────────────────────

function SubsList({ onOpen, onNew }) {
  const t = useT();
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
      <div className="admin-page-header">
        <input
          type="search"
          placeholder={t.subSearchPlaceholder}
          aria-label={t.subSearchAria}
          value={q}
          onChange={e => setQ(e.target.value)}
          style={styles.searchInput}
        />
        <button onClick={onNew} style={styles.primaryBtn}>{t.subNewSub}</button>
      </div>
      {loading ? <SkeletonList rows={3} /> :
        subs.length === 0 ? (
          <EmptyState
            title={t.subEmptyTitle}
            body={t.subEmptyBody}
            actionLabel={t.subNewSub}
            onAction={onNew}
          />
        ) : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="name" sort={sort} setSort={setSort}>{t.subName}</SortHeader>
                  <SortHeader sortKey="scope_specialty" sort={sort} setSort={setSort}>{t.subScope}</SortHeader>
                  <SortHeader sortKey="contact_name" sort={sort} setSort={setSort}>{t.subContact}</SortHeader>
                  <SortHeader sortKey="license_number" sort={sort} setSort={setSort}>{t.subLicense}</SortHeader>
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
          <div className="admin-cards-mobile">
            {sortedSubs.map(s => (
              <div
                key={s.id}
                className="admin-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(s.id)}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen(s.id))}
              >
                <div className="admin-card-row">
                  <span className="admin-card-title">{s.name}</span>
                  {s.scope_specialty && <span className="admin-card-sub">{s.scope_specialty}</span>}
                </div>
                {s.contact_name && <div className="admin-card-sub">{s.contact_name}</div>}
                {s.contact_email && <div className="admin-card-sub">{s.contact_email}</div>}
                {s.license_number && <div className="admin-card-sub">{t.subLicense}: {s.license_number}</div>}
              </div>
            ))}
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </>
  );
}

function SubForm({ existing, onSave, onCancel }) {
  const t = useT();
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
      setError(err.response?.data?.error || t.subSaveFailed);
    } finally { setSaving(false); }
  }

  return (
    <div style={styles.formCard}>
      <h3 style={styles.formH3}>{existing ? t.subEditSub : t.subNewSubTitle}</h3>
      {error && <div style={styles.errorBox}>{error}</div>}
      <div className="admin-form-grid-2">
        <Field label={t.subName} required>
          <input value={form.name} onChange={e => update('name', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.subScopeSpecialty}>
          <input value={form.scope_specialty} onChange={e => update('scope_specialty', e.target.value)} placeholder={t.subScopeSpecialtyPlaceholder} style={styles.input} />
        </Field>
        <Field label={t.subContactName}>
          <input value={form.contact_name} onChange={e => update('contact_name', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.subContactEmail}>
          <input type="email" value={form.contact_email} onChange={e => update('contact_email', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.subContactPhone}>
          <input value={form.contact_phone} onChange={e => update('contact_phone', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.subLicenseNumber}>
          <input value={form.license_number} onChange={e => update('license_number', e.target.value)} style={styles.input} />
        </Field>
      </div>
      <Field label={t.subNotes}>
        <textarea value={form.notes} onChange={e => update('notes', e.target.value)} style={{ ...styles.input, minHeight: 60 }} />
      </Field>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onCancel} style={styles.ghostBtn}>{t.subCancel}</button>
        <button onClick={handleSave} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.subSaving : t.subSave}
        </button>
      </div>
    </div>
  );
}

function SubDetail({ id, onBack, onEdit }) {
  const t = useT();
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
        <button onClick={onBack} style={styles.ghostBtn}>← {t.subBackToSubs}</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>{sub.name}</h2>
          {sub.scope_specialty && <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>{sub.scope_specialty}</div>}
        </div>
        <button onClick={onEdit} style={styles.ghostBtn}>{t.subEdit}</button>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.subContact}</h3>
        <div className="admin-form-grid-2">
          <Info label={t.subContactName} value={sub.contact_name} />
          <Info label={t.subEmail} value={sub.contact_email} />
          <Info label={t.subPhone} value={sub.contact_phone} />
          <Info label={t.subLicense} value={sub.license_number} />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.subOpenPos} ({sub.open_pos?.length || 0})</h3>
        {sub.open_pos?.length === 0 ? (
          <div style={{ fontSize: 14, color: '#6b7280' }}>{t.subNoOpenPos}</div>
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
          <h3 style={styles.formH3}>{t.subDocuments} ({sub.documents.length})</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {sub.documents.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 0' }}><strong>{d.name}</strong> <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>{d.doc_type}</span></td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>
                    {d.expires_on && <span style={{ fontSize: 12, color: '#6b7280' }}>{t.subExpires} {new Date(d.expires_on).toLocaleDateString()}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sub.notes && (
        <div style={styles.formCard}>
          <h3 style={styles.formH3}>{t.subNotes}</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{sub.notes}</pre>
        </div>
      )}
    </>
  );
}

// ── Sub POs portfolio ────────────────────────────────────────────────────────

function SubPOsList({ onOpen }) {
  const t = useT();
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
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label={t.subFilterByStatusAria}
          style={styles.select}
        >
          <option value="">{t.subAllStatuses}</option>
          {Object.entries(PO_STATUS_COLORS).map(([k, v]) => (
            <option key={k} value={k}>{t[v.labelKey]}</option>
          ))}
        </select>
      </div>
      {loading ? <SkeletonList rows={3} /> :
        pos.length === 0 ? (
          <EmptyState
            title={t.subPoEmptyTitle}
            body={t.subPoEmptyBody}
          />
        ) : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="po_number" sort={sort} setSort={setSort}>{t.subPoNumber}</SortHeader>
                  <SortHeader sortKey="sub_name" sort={sort} setSort={setSort}>{t.subSub}</SortHeader>
                  <SortHeader sortKey="project_name" sort={sort} setSort={setSort}>{t.subProject}</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>{t.subStatus}</SortHeader>
                  <SortHeader sortKey="amount_cents" sort={sort} setSort={setSort} align="right">{t.subAmount}</SortHeader>
                  <SortHeader sortKey="paid_cents" sort={sort} setSort={setSort} align="right">{t.subPaid}</SortHeader>
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
          <div className="admin-cards-mobile">
            {sortedPos.map(po => (
              <div
                key={po.id}
                className="admin-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(po.id)}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen(po.id))}
              >
                <div className="admin-card-row">
                  <span className="admin-card-title">{po.po_number}</span>
                  <StatusBadge status={po.status} />
                </div>
                <div className="admin-card-sub">{po.sub_name}</div>
                <div className="admin-card-sub">{po.project_name}</div>
                <div className="admin-card-row">
                  <span className="admin-card-sub">{t.subPaid} {formatCents(po.paid_cents)}</span>
                  <strong style={{ fontSize: 14 }}>{formatCents(po.amount_cents)}</strong>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </>
  );
}

function SubPODetail({ id, onBack }) {
  const t = useT();
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
      toast(t.subToastPoIssued, 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || t.subIssueFailed); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!await confirm({
      title: t.subCancelPoConfirmTitle,
      body: t.subCancelPoConfirmBody,
      confirmLabel: t.subCancelPo,
      tone: 'danger',
    })) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/subcontract-pos/${id}/cancel`);
      toast(t.subToastPoCancelled, 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || t.subCancelFailed); }
    finally { setBusy(false); }
  }
  async function recordPayment() {
    setBusy(true); setError(null);
    try {
      const amt = parseInt(payForm.amount_cents, 10);
      if (!Number.isFinite(amt) || amt < 0) {
        setError(t.subAmountInvalid);
        setBusy(false);
        return;
      }
      await api.post(`/subcontract-pos/${id}/payments`, {
        amount_cents: amt,
        paid_date: payForm.paid_date,
        invoice_ref: payForm.invoice_ref || null,
        notes: payForm.notes || null,
      });
      toast(t.subToastPaymentRecorded, 'success');
      setShowPayForm(false);
      setPayForm({ amount_cents: 0, paid_date: new Date().toISOString().slice(0, 10), invoice_ref: '', notes: '' });
      await load();
    } catch (err) { setError(err.response?.data?.error || t.subPaymentFailed); }
    finally { setBusy(false); }
  }

  if (loading) return <SkeletonList rows={3} />;
  if (!po) return null;

  return (
    <>
      {confirmDialog}
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← {t.subBackToPos}</button>
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
              {busy ? '...' : t.subIssuePo}
            </button>
          )}
          {['draft', 'issued', 'partial'].includes(po.status) && (
            <button onClick={cancel} disabled={busy} style={{ ...styles.ghostBtn, color: '#991b1b', borderColor: '#fecaca' }}>
              {t.subCancelPo}
            </button>
          )}
          {['issued', 'partial'].includes(po.status) && (
            <button onClick={() => setShowPayForm(true)} style={styles.primaryBtn}>
              {t.subRecordPayment}
            </button>
          )}
        </div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.subSummary}</h3>
        <div className="admin-form-grid-4">
          <Info label={t.subAmount} value={formatCents(po.amount_cents)} />
          <Info label={t.subPaid} value={formatCents(po.paid_cents)} />
          <Info label={t.subRemaining} value={formatCents(po.remaining_cents)} />
          <Info label={t.subRetainage} value={`${po.retainage_pct}%`} />
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.subScopeOfWork}</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, color: '#374151', margin: 0 }}>
          {po.scope_of_work}
        </pre>
      </div>

      {showPayForm && (
        <div style={{ ...styles.formCard, background: '#fef3c7' }}>
          <h3 style={styles.formH3}>{t.subRecordPayment}</h3>
          <div className="admin-form-grid-2">
            <Field label={t.subAmount} required>
              <MoneyInput
                valueCents={payForm.amount_cents}
                onChange={cents => setPayForm(f => ({ ...f, amount_cents: cents }))}
              />
            </Field>
            <Field label={t.subPaidDate} required>
              <input
                type="date"
                value={payForm.paid_date}
                onChange={e => setPayForm(f => ({ ...f, paid_date: e.target.value }))}
                style={styles.input}
              />
            </Field>
            <Field label={t.subInvoiceRef}>
              <input
                value={payForm.invoice_ref}
                onChange={e => setPayForm(f => ({ ...f, invoice_ref: e.target.value }))}
                style={styles.input}
              />
            </Field>
            <Field label={t.subNotes}>
              <input
                value={payForm.notes}
                onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
                style={styles.input}
              />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setShowPayForm(false)} style={styles.ghostBtn}>{t.subCancel}</button>
            <button onClick={recordPayment} disabled={busy} style={styles.primaryBtn}>
              {busy ? '...' : t.subRecord}
            </button>
          </div>
        </div>
      )}

      <div style={styles.formCard}>
        <h3 style={styles.formH3}>{t.subPayments} ({po.payments?.length || 0})</h3>
        {!po.payments?.length ? (
          <div style={{ fontSize: 14, color: '#6b7280' }}>{t.subNoPayments}</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ ...styles.th, padding: '8px 0' }}>{t.subDate}</th>
                <th style={{ ...styles.th, padding: '8px 0' }}>{t.subAmount}</th>
                <th style={{ ...styles.th, padding: '8px 0' }}>{t.subInvoiceRef}</th>
                <th style={{ ...styles.th, padding: '8px 0' }}>{t.subNotes}</th>
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
  const t = useT();
  const { user } = useAuth();
  const [tab, setTab] = useState('subs');
  const [view, setView] = useState({ kind: 'list' });

  function openSub(id)    { setView({ kind: 'sub-detail', id }); }
  function openSubNew()   { setView({ kind: 'sub-form', existing: null }); }
  function openSubEdit(s) { setView({ kind: 'sub-form', existing: s }); }
  function openPo(id)     { setView({ kind: 'po-detail', id }); }
  function backToList()   { setView({ kind: 'list' }); }

  return (
    <PageShell currentApp="subs" maxWidth={1100} headerProps={{ userRole: user?.role }}>
      <div className="admin-page-shell">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>{t.subSubcontractors}</h1>
        <TabBar
          active={tab}
          onChange={(id) => { setTab(id); setView({ kind: 'list' }); }}
          tabs={[
            { id: 'subs', label: t.subDirectory },
            { id: 'pos', label: t.subPurchaseOrders },
          ]}
        />

        {tab === 'subs' && view.kind === 'list'        && <SubsList onOpen={openSub} onNew={openSubNew} />}
        {tab === 'subs' && view.kind === 'sub-form'    && <SubForm existing={view.existing} onSave={(s) => openSub(s.id)} onCancel={() => view.existing ? openSub(view.existing.id) : backToList()} />}
        {tab === 'subs' && view.kind === 'sub-detail'  && <SubDetail id={view.id} onBack={backToList} onEdit={() => openSubEdit({ id: view.id })} />}

        {tab === 'pos' && view.kind === 'list'        && <SubPOsList onOpen={openPo} />}
        {tab === 'pos' && view.kind === 'po-detail'   && <SubPODetail id={view.id} onBack={backToList} />}
      </div>
    </PageShell>
  );
}

// ── Small parts ──────────────────────────────────────────────────────────────

function Field({ label, required, children }) {
  const t = useT();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
      <span>
        {label}
        {required && (
          <>
            <span aria-hidden="true" style={{ color: '#ef4444' }}>*</span>
            <span className="sr-only"> ({t.subRequired})</span>
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
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #cbd5e1', padding: '9px 14px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  searchInput: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, flex: 1, minWidth: 240 },
  select: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
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
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
