import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import { labelSg, labelPl } from '../companyLabels';

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

const DEFAULT_CATEGORIES = ['Fuel', 'Tools & Equipment', 'Supplies', 'Meals', 'Travel', 'Lodging', 'Parking', 'Other'];

export function ReimbursementRow({ item, onUpdate, knownCategories = DEFAULT_CATEGORIES, locale = 'en-US' }) {
  const t = useT();
  const resolveCategory = cat => cat && knownCategories.includes(cat) ? cat : cat ? 'Other' : null;
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(item.admin_notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const act = async status => {
    setSaving(true); setError('');
    try {
      const r = await api.patch(`/reimbursements/admin/${item.id}`, {
        status,
        admin_notes: notes || null,
        updated_at: item.updated_at,
      });
      onUpdate(r.data);
      setExpanded(false);
    } catch (err) {
      const msg = err.response?.status === 409
        ? t.concurrentModification
        : err.response?.data?.error || t.failedSave;
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={s.card}>
      <div style={s.row} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={s.workerName}>{item.full_name} <span style={s.username}>@{item.username}</span></div>
        <div style={s.rowMid}>
          <span style={s.amount}>{fmtMoney(item.amount)}</span>
          {item.category && <span style={s.cat}>{resolveCategory(item.category)}</span>}
          {item.project_name && <span style={s.projectTag}>{item.project_name}</span>}
          <span style={s.date}>{fmtDate(item.expense_date, locale)}</span>
        </div>
        <div style={s.rowRight}>
          {item.qbo_purchase_id && (
            <span style={s.qboBadge}>QB ✓</span>
          )}
          <StatusBadge status={item.status} />
          <span style={s.chevron}>{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div style={s.detail}>
          <div style={s.desc}>{item.description}</div>
          {item.miles && (
            <div style={s.milesMeta}>
              🚗 {parseFloat(item.miles).toFixed(1)} miles × ${parseFloat(item.mileage_rate).toFixed(4)}/mi = {fmtMoney(item.amount)}
            </div>
          )}
          {item.receipt_url && (
            <div style={{ marginBottom: 10 }}>
              <a href={item.receipt_url} target="_blank" rel="noopener noreferrer" style={s.receiptLink}>
                {t.viewReceiptAdmin}
              </a>
            </div>
          )}
          <div style={s.notesRow}>
            <label style={s.notesLabel}>{t.notesForWorker}</label>
            <textarea
              style={s.textarea}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t.reasonPlaceholder}
              rows={2}
              maxLength={1000}
            />
            <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{notes.length}/1000</div>
          </div>
          {error && <div role="alert" style={s.error}>{error}</div>}
          <div style={s.actions}>
            {item.status !== 'approved' && (
              <button style={{ ...s.approveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => act('approved')} disabled={saving}>
                {saving ? t.saving : t.approveBtn}
              </button>
            )}
            {item.status !== 'rejected' && (
              <button style={{ ...s.rejectBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => act('rejected')} disabled={saving}>
                {saving ? t.saving : t.rejectBtn}
              </button>
            )}
            {item.status !== 'pending' && (
              <button style={{ ...s.actionResetBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => act('pending')} disabled={saving}>
                {t.resetPending}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReimbursementsAdmin({ settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workLabel = labelSg(settings?.label_work, 'work', user?.language);
  const workLabelPlural = labelPl(settings?.label_work, 'work', user?.language);
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const [items, setItems] = useState([]);
  const [mileageRate, setMileageRate] = useState(0.67);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [workers, setWorkers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [categories, setCategories] = useState({ active: [], known: [] });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ user_id: '', miles: '', amount: '', description: '', category: '', expense_date: new Date().toLocaleDateString('en-CA'), status: 'approved', project_id: '' });
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);
  const [noReceipt, setNoReceipt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const fileRef = useRef();
  const isMileage = form.category === 'Mileage';

  // Extra filters + sort (client-side, on top of the status filter)
  const [filterWorker, setFilterWorker] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const resetFilters = () => {
    setFilterWorker(''); setFilterCategory(''); setFilterProject('');
    setFilterFrom(''); setFilterTo(''); setFilterSearch(''); setSortBy('date_desc');
  };
  const anyFilterActive = filterWorker || filterCategory || filterProject || filterFrom || filterTo || filterSearch || sortBy !== 'date_desc';

  const filterLabels = {
    pending:  t.filterPending || t.statusPendingLabel,
    approved: t.filterApproved || t.statusApprovedLabel,
    rejected: t.filterRejected || t.statusRejectedLabel,
    all:      t.filterAllLabel,
  };

  const load = useCallback(() => {
    setLoadError('');
    const params = filter !== 'all' ? `?status=${filter}` : '';
    api.get(`/reimbursements/admin${params}`)
      .then(r => { setItems(r.data.items); setMileageRate(r.data.mileage_rate); })
      .catch(() => setLoadError(t.failedLoad || 'Failed to load reimbursements.'))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    api.get('/admin/workers').then(r => setWorkers(r.data)).catch(silentError('reimbursementsadmin'));
    api.get('/projects').then(r => setProjects(r.data)).catch(silentError('reimbursementsadmin'));
    api.get('/reimbursements/categories').then(r => setCategories(r.data)).catch(silentError('reimbursementsadmin'));
  }, []);

  const handleFileChange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setFormError(t.fileTooLarge || 'File must be under 10 MB'); return; }
    const reader = new FileReader();
    reader.onload = ev => { setReceiptFile(ev.target.result); setReceiptPreview(ev.target.result); };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!isMileage && !noReceipt && !receiptFile) { setFormError(t.receiptRequired); return; }
    setSaving(true); setFormError(''); setFormSuccess('');
    try {
      const payload = {
        user_id: form.user_id,
        description: form.description || null,
        category: form.category || null,
        expense_date: form.expense_date,
        project_id: form.project_id || null,
        status: form.status,
        receipt: receiptFile || null,
      };
      if (isMileage) {
        payload.miles = form.miles;
      } else {
        payload.amount = form.amount;
      }
      await api.post('/reimbursements/admin', payload);
      setFormSuccess(t.expenseAdded);
      setShowForm(false);
      setForm({ user_id: '', miles: '', amount: '', description: '', category: '', expense_date: new Date().toLocaleDateString('en-CA'), status: 'approved', project_id: '' });
      setReceiptFile(null); setReceiptPreview(null); setNoReceipt(false);
      load();
    } catch (err) {
      setFormError(err.response?.data?.error || t.failedAddExpense);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = updated => {
    setItems(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i));
  };

  const visibleItems = useMemo(() => {
    const search = filterSearch.trim().toLowerCase();
    let out = items.filter(i => {
      if (filterWorker && String(i.user_id) !== String(filterWorker)) return false;
      if (filterCategory && (i.category || '') !== filterCategory) return false;
      if (filterProject && String(i.project_id || '') !== String(filterProject)) return false;
      if (filterFrom && String(i.expense_date).substring(0, 10) < filterFrom) return false;
      if (filterTo && String(i.expense_date).substring(0, 10) > filterTo) return false;
      if (search) {
        const hay = [i.full_name, i.username, i.description, i.category, i.project_name].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    const sorters = {
      date_desc:   (a, b) => String(b.expense_date).localeCompare(String(a.expense_date)) || b.created_at.localeCompare(a.created_at),
      date_asc:    (a, b) => String(a.expense_date).localeCompare(String(b.expense_date)) || a.created_at.localeCompare(b.created_at),
      amount_desc: (a, b) => parseFloat(b.amount) - parseFloat(a.amount),
      amount_asc:  (a, b) => parseFloat(a.amount) - parseFloat(b.amount),
      worker_asc:  (a, b) => (a.full_name || '').localeCompare(b.full_name || ''),
    };
    return [...out].sort(sorters[sortBy] || sorters.date_desc);
  }, [items, filterWorker, filterCategory, filterProject, filterFrom, filterTo, filterSearch, sortBy]);

  const totals = visibleItems.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + parseFloat(i.amount);
    return acc;
  }, {});

  // Workers used for filter dropdown — only those with expenses in the current list
  const workersInList = useMemo(() => {
    const map = new Map();
    items.forEach(i => { if (i.user_id && !map.has(i.user_id)) map.set(i.user_id, i.full_name); });
    return Array.from(map, ([id, name]) => ({ id, full_name: name })).sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [items]);

  const projectsInList = useMemo(() => {
    const map = new Map();
    items.forEach(i => { if (i.project_id && !map.has(i.project_id)) map.set(i.project_id, i.project_name || '—'); });
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const categoriesInList = useMemo(() => {
    const set = new Set();
    items.forEach(i => { if (i.category) set.add(i.category); });
    return Array.from(set).sort();
  }, [items]);

  const allWorkers = [{ id: user?.id, full_name: `${user?.full_name || 'Me'} (you)` }, ...workers.filter(w => w.id !== user?.id)];

  return (
    <div style={s.wrap}>
      {loadError && <p style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{loadError}</p>}
      <div style={s.header}>
        <div style={s.title}>{t.expenseReimbursements}</div>
        <div style={s.headerRight}>
          <button style={s.addBtn} onClick={() => { setShowForm(v => !v); setFormError(''); setFormSuccess(''); }}>
            {showForm ? `✕ ${t.cancel}` : t.addExpense}
          </button>
          <div style={s.filters}>
            {['pending', 'approved', 'rejected', 'all'].map(f => (
              <button key={f} style={filter === f ? s.filterActive : s.filter} onClick={() => setFilter(f)}>
                {filterLabels[f]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Secondary filters + sort */}
      <div style={s.filterBar}>
        <input
          type="text"
          placeholder={t.raSearchPlaceholder}
          value={filterSearch}
          onChange={e => setFilterSearch(e.target.value)}
          style={{ ...s.filterInput, flex: '2 1 220px' }}
          aria-label={t.raSearchAria}
        />
        <select style={s.filterInput} value={filterWorker} onChange={e => setFilterWorker(e.target.value)} aria-label={t.raFilterWorkerAria}>
          <option value="">{`All ${workerLabelPlural}`}</option>
          {workersInList.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
        </select>
        <select style={s.filterInput} value={filterCategory} onChange={e => setFilterCategory(e.target.value)} aria-label={t.raFilterCategoryAria}>
          <option value="">{t.raAllCategories}</option>
          {categoriesInList.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {projectsInList.length > 0 && (
          <select style={s.filterInput} value={filterProject} onChange={e => setFilterProject(e.target.value)} aria-label={t.raFilterProjectAria}>
            <option value="">{`All ${workLabelPlural}`}</option>
            {projectsInList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <input type="date" style={s.filterInput} value={filterFrom} onChange={e => setFilterFrom(e.target.value)} aria-label={t.raFromDateAria} />
        <input type="date" style={s.filterInput} value={filterTo} onChange={e => setFilterTo(e.target.value)} aria-label={t.raToDateAria} />
        <select style={s.filterInput} value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label={t.raSortByAria}>
          <option value="date_desc">Date ↓ (newest)</option>
          <option value="date_asc">Date ↑ (oldest)</option>
          <option value="amount_desc">Amount ↓</option>
          <option value="amount_asc">Amount ↑</option>
          <option value="worker_asc">{`${workerLabel} A-Z`}</option>
        </select>
        {anyFilterActive && (
          <button type="button" onClick={resetFilters} style={s.resetBtn}>{t.reset}</button>
        )}
      </div>

      {formSuccess && <div style={s.successMsg}>{formSuccess}</div>}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.formRow}>
            <div style={s.field}>
              <label style={s.fieldLabel}>{workerLabel}</label>
              <select style={s.input} value={form.user_id} onChange={e => setForm(f => ({ ...f, user_id: e.target.value }))} required>
                <option value="">{`Select ${workerLabel.toLowerCase()}`}</option>
                {allWorkers.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.fieldLabel}>{t.date} *</label>
              <input style={s.input} type="date" value={form.expense_date} onChange={e => setForm(f => ({ ...f, expense_date: e.target.value }))} required />
            </div>
            <div style={s.field}>
              <label style={s.fieldLabel}>{t.categoryLabel}</label>
              <select style={s.input} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value, miles: '', amount: '' }))}>
                <option value="">{t.selectPlaceholder}</option>
                {categories.active.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {isMileage ? (
              <div style={s.field}>
                <label style={s.fieldLabel}>{t.milesLabel} *</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input style={{ ...s.input, width: 90 }} type="number" min="0.1" step="0.1" placeholder="0.0" value={form.miles} onChange={e => setForm(f => ({ ...f, miles: e.target.value }))} required />
                  {form.miles > 0 && (
                    <span style={s.mileageCalc}>= ${(parseFloat(form.miles) * mileageRate).toFixed(2)}</span>
                  )}
                </div>
              </div>
            ) : (
              <div style={s.field}>
                <label style={s.fieldLabel}>{t.amountLabel}</label>
                <input style={{ ...s.input, width: 100 }} type="number" min="0.01" step="0.01" placeholder="0.00" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required={!isMileage} />
              </div>
            )}
            <div style={s.field}>
              <label style={s.fieldLabel}>{t.statusLabel}</label>
              <select style={s.input} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="approved">{t.statusApprovedLabel}</option>
                <option value="pending">{t.statusPendingLabel}</option>
              </select>
            </div>
            {projects.length > 0 && (
              <div style={s.field}>
                <label style={s.fieldLabel}>{workLabel}</label>
                <select style={s.input} value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                  <option value="">{`No ${workLabel.toLowerCase()}`}</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div style={s.field}>
            <label style={s.fieldLabel}>{t.descriptionLabel}</label>
            <input style={{ ...s.input, width: '100%' }} type="text" maxLength={500} placeholder={t.descriptionPlaceholder} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          {!isMileage && (
            <div style={s.field}>
              <label style={s.fieldLabel}>{t.receiptLabel}</label>
              <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => { handleFileChange(e); setNoReceipt(false); }} />
              {!noReceipt && (
                <button type="button" style={s.uploadBtn} onClick={() => fileRef.current.click()}>
                  {receiptFile ? t.receiptAttached : t.attachReceipt}
                </button>
              )}
              {receiptPreview && !noReceipt && receiptPreview.startsWith('data:image') && (
                <img src={receiptPreview} alt="Receipt" style={s.preview} />
              )}
              <label style={s.checkLabel}>
                <input type="checkbox" checked={noReceipt} onChange={e => { setNoReceipt(e.target.checked); if (e.target.checked) { setReceiptFile(null); setReceiptPreview(null); } }} />
                {' '}{t.noReceiptAvailable}
              </label>
            </div>
          )}
          {formError && <div style={s.errorMsg}>{formError}</div>}
          <button style={{ ...s.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : t.addExpenseBtn}</button>
        </form>
      )}

      {!loading && visibleItems.length > 0 && (
        <div style={s.summary}>
          <span style={{ fontWeight: 600 }}>
            {visibleItems.length} request{visibleItems.length !== 1 ? 's' : ''}
            {visibleItems.length !== items.length && <span style={{ color: '#6b7280', fontWeight: 500 }}> of {items.length}</span>}
          </span>
          <span>Total: <b>{fmtMoney(Object.values(totals).reduce((a, b) => a + b, 0))}</b></span>
        </div>
      )}

      {loading ? null : visibleItems.length === 0 ? (
        <div style={s.empty}>
          {items.length === 0 ? t.noReimbursementsFilter : 'No expenses match the current filters.'}
        </div>
      ) : (
        <div style={s.list}>
          {visibleItems.map(item => (
            <ReimbursementRow key={item.id} item={item} onUpdate={handleUpdate} knownCategories={categories.known} locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  headerRight: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  title: { fontSize: 17, fontWeight: 700, color: '#111827' },
  addBtn: { padding: '7px 16px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  successMsg: { color: '#059669', fontWeight: 600, fontSize: 13, padding: '8px 12px', background: '#d1fae5', borderRadius: 7 },
  errorMsg: { color: '#dc2626', fontSize: 13 },
  form: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  formRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '7px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 13 },
  uploadBtn: { padding: '7px 12px', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer', alignSelf: 'flex-start' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280', cursor: 'pointer', marginTop: 6 },
  preview: { marginTop: 6, maxWidth: 180, maxHeight: 140, borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'cover' },
  submitBtn: { padding: '9px 22px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', alignSelf: 'flex-start' },
  filters: { display: 'flex', gap: 6 },
  filterBar: {
    display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    padding: '10px 12px',
  },
  filterInput: {
    padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7,
    fontSize: 13, color: '#111827', background: '#fff', flex: '1 1 140px',
    minWidth: 120,
  },
  resetBtn: {
    padding: '7px 12px', background: '#f3f4f6', border: '1px solid #d1d5db',
    borderRadius: 7, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer',
  },
  filter: { padding: '6px 14px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  filterActive: { padding: '6px 14px', background: 'var(--ops-page-accent)', border: '1px solid var(--ops-page-accent)', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' },
  summary: { display: 'flex', gap: 16, fontSize: 13, color: '#6b7280' },
  empty: { color: '#6b7280', fontSize: 14, textAlign: 'center', padding: '24px 0' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer', flexWrap: 'wrap' },
  workerName: { fontSize: 14, fontWeight: 700, color: '#111827', minWidth: 130 },
  username: { fontWeight: 400, color: '#6b7280', fontSize: 12 },
  rowMid: { display: 'flex', gap: 10, alignItems: 'center', flex: 1, flexWrap: 'wrap' },
  rowRight: { display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto' },
  amount: { fontSize: 16, fontWeight: 700, color: '#111827' },
  cat: { fontSize: 11, fontWeight: 600, background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 8 },
  projectTag: { fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', padding: '2px 8px', borderRadius: 8 },
  date: { fontSize: 12, color: '#6b7280' },
  badge: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 8 },
  chevron: { fontSize: 13, color: '#6b7280' },
  detail: { padding: '0 16px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 10 },
  desc: { fontSize: 14, color: '#374151', paddingTop: 12 },
  receiptLink: { color: 'var(--ops-page-accent)', fontSize: 13, fontWeight: 600, textDecoration: 'none' },
  notesRow: { display: 'flex', flexDirection: 'column', gap: 4 },
  notesLabel: { fontSize: 12, fontWeight: 600, color: '#666' },
  textarea: { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 13, resize: 'vertical', fontFamily: 'inherit' },
  error: { color: '#dc2626', fontSize: 13 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  approveBtn: { padding: '8px 18px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  rejectBtn: { padding: '8px 18px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  actionResetBtn: { padding: '8px 18px', background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  milesMeta: { fontSize: 13, color: '#059669', fontWeight: 600, background: '#f0fdf4', borderRadius: 6, padding: '5px 10px' },
  mileageCalc: { fontSize: 12, color: '#059669', fontWeight: 600, whiteSpace: 'nowrap' },
  qboBadge: { fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 8, background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7' },
};
