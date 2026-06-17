import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';

import { silentError } from '../errorReporter';
function fmtDate(str, locale = 'en-US') {
  const d = new Date(String(str).substring(0, 10) + 'T00:00:00');
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMoney(v) {
  return `$${Number(v).toFixed(2)}`;
}

function StatusBadge({ status }) {
  const colors = {
    pending:  { background: '#fef3c7', color: '#92400e' },
    approved: { background: '#d1fae5', color: '#065f46' },
    rejected: { background: '#fee2e2', color: '#991b1b' },
  };
  return (
    <span style={{ ...s.badge, ...(colors[status] || colors.pending) }}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function ReimbursementsView({ settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workLabel = settings?.label_work || 'Project';
  const [items, setItems] = useState([]);
  const [mileageRate, setMileageRate] = useState(0.67);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [categories, setCategories] = useState({ active: [], known: [] });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ miles: '', amount: '', description: '', category: '', expense_date: new Date().toLocaleDateString('en-CA'), project_id: '' });
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);
  const [noReceipt, setNoReceipt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const fileRef = useRef();

  const isMileage = form.category === 'Mileage';
  const resolveCategory = cat => cat && categories.known.includes(cat) ? cat : cat ? 'Other' : null;

  const load = () => {
    setLoadError('');
    api.get('/reimbursements')
      .then(r => { setItems(r.data.items); setMileageRate(r.data.mileage_rate); })
      .catch(() => setLoadError(t.failedLoad))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/projects').then(r => setProjects(r.data)).catch(silentError('reimbursementsview')); }, []);
  useEffect(() => { api.get('/reimbursements/categories').then(r => setCategories(r.data)).catch(silentError('reimbursementsview')); }, []);

  const handleFileChange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError(t.fileTooLarge || 'File must be under 10 MB'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      setReceiptFile(ev.target.result);
      setReceiptPreview(ev.target.result);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!isMileage && !noReceipt && !receiptFile) { setError(t.receiptRequired); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const payload = {
        description: form.description || null,
        category: form.category || null,
        expense_date: form.expense_date,
        project_id: form.project_id || null,
        receipt: receiptFile || null,
      };
      if (isMileage) {
        payload.miles = form.miles;
      } else {
        payload.amount = form.amount;
      }
      await api.post('/reimbursements', payload);
      setSuccess(t.submitSuccess);
      setTimeout(() => setSuccess(''), 4000);
      setShowForm(false);
      setForm({ miles: '', amount: '', description: '', category: '', expense_date: new Date().toLocaleDateString('en-CA'), project_id: '' });
      setReceiptFile(null); setReceiptPreview(null); setNoReceipt(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || t.failedSave);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async id => {
    setPendingDeleteId(null);
    setDeleteError('');
    try {
      await api.delete(`/reimbursements/${id}`);
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (err) {
      setDeleteError(err.response?.data?.error || t.failedSave);
    }
  };

  if (loading) return null;
  if (loadError) return <p style={{ color: '#dc2626', fontSize: 13, padding: 16 }}>{loadError}</p>;

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div style={s.title}>{t.reimbursementsTitle}</div>
        <button style={s.addBtn} onClick={() => { setShowForm(v => !v); setError(''); setSuccess(''); }}>
          {showForm ? `✕ ${t.cancel}` : t.newRequest}
        </button>
      </div>

      {success && <div style={s.successMsg}>{success}</div>}
      {deleteError && <div style={s.errorMsg}>{deleteError}</div>}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.formRow}>
            <div style={s.field}>
              <label htmlFor="rv-date" style={s.label}>{t.date} *</label>
              <input id="rv-date" style={s.input} type="date" value={form.expense_date} onChange={e => setForm(f => ({ ...f, expense_date: e.target.value }))} required max={new Date().toLocaleDateString('en-CA')} disabled={saving} />
            </div>
            <div style={s.field}>
              <label htmlFor="rv-category" style={s.label}>{t.categoryLabel}</label>
              <select id="rv-category" style={s.input} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value, miles: '', amount: '' }))} disabled={saving}>
                <option value="">{t.selectPlaceholder}</option>
                {categories.active.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {isMileage ? (
              <div style={s.field}>
                <label htmlFor="rv-miles" style={s.label}>{t.milesLabel} *</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input id="rv-miles" style={{ ...s.input, width: 100 }} type="number" min="0.1" step="0.1" placeholder="0.0" value={form.miles} onChange={e => setForm(f => ({ ...f, miles: e.target.value }))} required disabled={saving} />
                  {form.miles > 0 && (
                    <span style={s.mileageCalc}>= ${(parseFloat(form.miles) * mileageRate).toFixed(2)} @ ${mileageRate}/mi</span>
                  )}
                </div>
              </div>
            ) : (
              <div style={s.field}>
                <label htmlFor="rv-amount" style={s.label}>{t.amountLabel}</label>
                <input id="rv-amount" style={{ ...s.input, width: 110 }} type="number" min="0.01" step="0.01" placeholder="0.00" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required={!isMileage} disabled={saving} />
              </div>
            )}
            {projects.length > 0 && (
              <div style={s.field}>
                <label htmlFor="rv-project" style={s.label}>{workLabel}</label>
                <select id="rv-project" style={s.input} value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} disabled={saving}>
                  <option value="">{`No ${workLabel.toLowerCase()}`}</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div style={s.field}>
            <label htmlFor="rv-description" style={s.label}>{t.descriptionLabel}</label>
            <input id="rv-description" style={{ ...s.input, width: '100%' }} type="text" maxLength={500} placeholder={isMileage ? t.mileageDescPlaceholder : t.descriptionPlaceholder} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} disabled={saving} />
            <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{form.description.length}/500</div>
          </div>
          {!isMileage && (
            <div style={s.field}>
              <label style={s.label}>{t.receiptLabel}</label>
              <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => { handleFileChange(e); setNoReceipt(false); }} />
              {!noReceipt && (
                <button type="button" style={s.uploadBtn} onClick={() => fileRef.current.click()}>
                  {receiptFile ? t.receiptAttached : t.attachReceipt}
                </button>
              )}
              {receiptPreview && !noReceipt && receiptPreview.startsWith('data:image') && (
                <img src={receiptPreview} alt={t.receiptPreviewAlt} style={s.preview} />
              )}
              {receiptPreview && !noReceipt && receiptPreview.startsWith('data:application/pdf') && (
                <div style={s.pdfHint}>{t.pdfAttached}</div>
              )}
              <label style={s.checkLabel}>
                <input type="checkbox" checked={noReceipt} onChange={e => { setNoReceipt(e.target.checked); if (e.target.checked) { setReceiptFile(null); setReceiptPreview(null); } }} />
                {' '}{t.noReceiptAvailable}
              </label>
            </div>
          )}
          {error && <div role="alert" style={s.errorMsg}>{error}</div>}
          <button style={{ ...s.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>
            {saving ? t.submitting : t.submitRequest}
          </button>
        </form>
      )}

      {items.length === 0 && !showForm ? (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>💰</div>
          <p style={s.emptyTitle}>{t.noReimbursementsYet}</p>
          <p style={s.emptySubtitle}>Submit your first expense request using the button above.</p>
        </div>
      ) : (
        <div style={s.list}>
          {items.map(item => (
            <div key={item.id} style={s.card}>
              <div style={s.cardTop}>
                <div style={s.cardLeft}>
                  <span style={s.amount}>{fmtMoney(item.amount)}</span>
                  {item.category && <span style={s.category}>{resolveCategory(item.category)}</span>}
                  {item.project_name && <span style={s.projectTag}>{item.project_name}</span>}
                </div>
                <div style={s.cardRight}>
                  <StatusBadge status={item.status} />
                  {item.status === 'pending' && (
                    pendingDeleteId === item.id ? (
                      <>
                        <button style={s.deleteConfirmBtn} onClick={() => handleDelete(item.id)}>{t.confirm}</button>
                        <button style={s.deleteCancelBtn} onClick={() => setPendingDeleteId(null)}>{t.cancel}</button>
                      </>
                    ) : (
                      <button style={s.deleteBtn} aria-label={t.deleteReimbursement} onClick={() => setPendingDeleteId(item.id)}>✕</button>
                    )
                  )}
                </div>
              </div>
              <div style={s.desc}>{item.description}</div>
              {item.miles && (
                <div style={s.milesMeta}>
                  {parseFloat(item.miles).toFixed(1)} mi × ${parseFloat(item.mileage_rate).toFixed(4)}/mi
                </div>
              )}
              <div style={s.meta}>
                <span>{fmtDate(item.expense_date, locale)}</span>
                {item.receipt_url && (
                  <a href={item.receipt_url} target="_blank" rel="noopener noreferrer" style={s.receiptLink}>{t.viewReceipt}</a>
                )}
              </div>
              {item.admin_notes && (
                <div style={s.adminNote}>{t.adminNotePrefix}{item.admin_notes}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 17, fontWeight: 700, color: '#111827' },
  addBtn: { padding: '8px 16px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  successMsg: { color: '#059669', fontWeight: 600, fontSize: 13, padding: '8px 12px', background: '#d1fae5', borderRadius: 7 },
  errorMsg: { color: '#dc2626', fontSize: 13 },
  form: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  formRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 14 },
  uploadBtn: { padding: '8px 14px', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer', alignSelf: 'flex-start' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280', cursor: 'pointer', marginTop: 6 },
  preview: { marginTop: 8, maxWidth: 220, maxHeight: 180, borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'cover' },
  pdfHint: { marginTop: 8, fontSize: 12, color: '#6b7280' },
  submitBtn: { padding: '10px 24px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', alignSelf: 'flex-start' },
  emptyState: { textAlign: 'center', padding: '48px 20px' },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyTitle: { fontSize: 15, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptySubtitle: { fontSize: 13, color: '#6b7280', margin: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8 },
  amount: { fontSize: 18, fontWeight: 700, color: '#111827' },
  category: { fontSize: 11, fontWeight: 600, background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 8 },
  projectTag: { fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', padding: '2px 8px', borderRadius: 8 },
  badge: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 8 },
  deleteBtn: { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, padding: '2px 4px' },
  deleteConfirmBtn: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  deleteCancelBtn: { background: '#e5e7eb', color: '#374151', border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  desc: { fontSize: 14, color: '#374151' },
  meta: { display: 'flex', gap: 14, fontSize: 12, color: '#6b7280', alignItems: 'center' },
  receiptLink: { color: 'var(--ops-page-accent)', textDecoration: 'none', fontWeight: 600 },
  adminNote: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', background: '#f9fafb', borderRadius: 6, padding: '5px 10px', marginTop: 2 },
  milesMeta: { fontSize: 12, color: '#6b7280' },
  mileageCalc: { fontSize: 12, color: '#059669', fontWeight: 600, whiteSpace: 'nowrap' },
};
