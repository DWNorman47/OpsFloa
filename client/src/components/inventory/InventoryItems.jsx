import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import api from '../../api';
import ItemLabelModal from './ItemLabelModal';
import { useT } from '../../hooks/useT';
import ColumnHeaderMenu from './ColumnHeaderMenu';
import InventoryColumnPicker from './InventoryColumnPicker';

const ImportItemsModal = lazy(() => import('./ImportItemsModal'));

import { silentError } from '../../errorReporter';
const DEFAULT_UNITS = ['each', 'box', 'bag', 'bundle', 'pallet', 'lb', 'kg', 'ft', 'm', 'sq ft', 'gal', 'L', 'roll', 'sheet', 'piece', 'other'];
// Maps known internal unit VALUES to their translation key (prefix `invit`). Custom/unknown units render as-is.
const UNIT_LABELS = {
  each: 'invitUnitEach',
  box: 'invitUnitBox',
  bag: 'invitUnitBag',
  bundle: 'invitUnitBundle',
  pallet: 'invitUnitPallet',
  roll: 'invitUnitRoll',
  sheet: 'invitUnitSheet',
  piece: 'invitUnitPiece',
  other: 'invitUnitOther',
};
const ITEM_PAGE_SIZE_PREF_KEY = 'inventory_items_page_size';
const ITEM_COLUMN_PREF_KEY = 'inventory_items_columns';
const DEFAULT_ITEM_COLUMNS = {
  name: true,
  sku: true,
  category: true,
  unit: true,
  unit_cost: true,
  reorder_point: true,
  reorder_qty: true,
  status: true,
  actions: true,
};

function readJsonPref(key, fallback) {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || '{}') || {}) };
  } catch {
    return fallback;
  }
}

function readNumberPref(key, fallback, allowed) {
  try {
    const value = parseInt(localStorage.getItem(key), 10);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function ItemForm({ item, onSave, onCancel, activeUnits = DEFAULT_UNITS, knownUnits = DEFAULT_UNITS }) {
  const t = useT();
  const skuRef = useRef(null);
  const [skuScanning, setSkuScanning] = useState(false);

  const activateSKUScan = () => {
    setSkuScanning(true);
    skuRef.current?.focus();
    skuRef.current?.select();
  };

  const [form, setForm] = useState({
    name: item?.name || '',
    sku: item?.sku || '',
    description: item?.description || '',
    category: item?.category || '',
    unit: item?.unit || 'each',
    unit_spec: item?.unit_spec || '',
    unit_cost: item?.unit_cost != null ? String(item.unit_cost) : '',
    reorder_point: item?.reorder_point != null ? String(item.reorder_point) : '0',
    reorder_qty: item?.reorder_qty != null ? String(item.reorder_qty) : '0',
    customUnit: '',
    useCustomUnit: item ? !knownUnits.includes(item.unit) : false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleUnitChange = e => {
    if (e.target.value === 'other') { set('useCustomUnit', true); set('unit', ''); }
    else { set('useCustomUnit', false); set('unit', e.target.value); }
  };

  const submit = async e => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError(t.itemNameRequired);
    const unit = form.useCustomUnit ? form.customUnit.trim() : form.unit;
    if (!unit) return setError(t.itemUnitRequired);
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        description: form.description.trim() || null,
        category: form.category.trim() || null,
        unit,
        unit_spec: form.unit_spec.trim() || null,
        unit_cost: form.unit_cost !== '' ? parseFloat(form.unit_cost) : null,
        reorder_point: parseInt(form.reorder_point) || 0,
        reorder_qty: parseInt(form.reorder_qty) || 0,
      };
      if (item) await api.patch(`/inventory/items/${item.id}`, payload);
      else await api.post('/inventory/items', payload);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || t.failedSaveItem);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={f.form} className="inventory-item-form">
      <h3 style={f.title}>{item ? t.editItem : t.addItem}</h3>
      {error && <div role="alert" style={f.error}>{error}</div>}
      <div style={f.row} className="inventory-item-form-grid">
        <div style={f.field}>
          <label htmlFor="ii-name" style={f.label}>{t.itemNameLabel}</label>
          <input id="ii-name" style={f.input} maxLength={255} value={form.name} onChange={e => set('name', e.target.value)} placeholder={t.invItemNamePlaceholder} required />
        </div>
        <div style={f.field}>
          <label htmlFor="ii-sku" style={f.label}>{t.itemSkuLabel}</label>
          <div style={f.skuWrap}>
            <input
              ref={skuRef}
              style={{ ...f.input, ...(skuScanning ? f.skuScanning : {}) }}
              maxLength={100}
              value={form.sku}
              onChange={e => set('sku', e.target.value)}
              placeholder={skuScanning ? t.scanBarcodeNow : t.optional}
              onFocus={() => setSkuScanning(true)}
              onBlur={() => setSkuScanning(false)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); skuRef.current?.blur(); } }}
            />
            <button
              type="button"
              style={{ ...f.scanBtn, ...(skuScanning ? f.scanBtnActive : {}) }}
              onClick={activateSKUScan}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="16" height="16">
                <path d="M3 5h2M3 9h2M3 15h2M3 19h2M19 5h2M19 9h2M19 15h2M19 19h2" />
                <rect x="7" y="3" width="2" height="18" rx="0.5" fill="currentColor" stroke="none" />
                <rect x="11" y="3" width="1" height="18" rx="0.5" fill="currentColor" stroke="none" />
                <rect x="14" y="3" width="3" height="18" rx="0.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div style={f.row} className="inventory-item-form-grid">
        <div style={f.field}>
          <label htmlFor="ii-category" style={f.label}>{t.itemCategoryLabel}</label>
          <input id="ii-category" style={f.input} maxLength={100} value={form.category} onChange={e => set('category', e.target.value)} placeholder={t.invCategoryPlaceholder} />
        </div>
        <div style={f.field}>
          <label htmlFor="ii-unit" style={f.label}>{t.itemUnitLabel}</label>
          <select id="ii-unit" style={f.input} value={form.useCustomUnit ? 'other' : form.unit} onChange={handleUnitChange}>
            {activeUnits.map(u => <option key={u} value={u}>{UNIT_LABELS[u] ? t[UNIT_LABELS[u]] : u}</option>)}
          </select>
          {form.useCustomUnit && (
            <input style={{ ...f.input, marginTop: 6 }} value={form.customUnit} onChange={e => set('customUnit', e.target.value)} placeholder={t.enterUnit} />
          )}
        </div>
        <div style={f.field}>
          <label htmlFor="ii-unit-spec" style={f.label}>{t.itemUnitSpecLabel} <span style={{ fontWeight: 400, color: '#6b7280' }}>(e.g. "50 ct", "10x50")</span></label>
          <input id="ii-unit-spec" style={f.input} value={form.unit_spec} onChange={e => set('unit_spec', e.target.value)} placeholder={t.optional} />
        </div>
      </div>
      <div style={f.row} className="inventory-item-form-grid">
        <div style={f.field}>
          <label htmlFor="ii-unit-cost" style={f.label}>{t.itemUnitCostLabel}</label>
          <input id="ii-unit-cost" style={f.input} type="number" min="0" step="0.01" value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} placeholder="0.00" />
        </div>
        <div style={f.field}>
          <label htmlFor="ii-reorder-point" style={f.label}>{t.itemReorderPoint}</label>
          <input id="ii-reorder-point" style={f.input} type="number" min="0" step="1" value={form.reorder_point} onChange={e => set('reorder_point', e.target.value)} />
        </div>
        <div style={f.field}>
          <label htmlFor="ii-reorder-qty" style={f.label}>{t.itemReorderQty}</label>
          <input id="ii-reorder-qty" style={f.input} type="number" min="0" step="1" value={form.reorder_qty} onChange={e => set('reorder_qty', e.target.value)} />
        </div>
      </div>
      <div style={f.field}>
        <label htmlFor="ii-description" style={f.label}>{t.itemDescriptionLabel}</label>
        <textarea id="ii-description" style={{ ...f.input, minHeight: 60, resize: 'vertical' }} maxLength={1000} value={form.description} onChange={e => set('description', e.target.value)} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.description || '').length}/1000</div>
      </div>
      <div style={f.actions} className="inventory-item-form-actions">
        <button type="button" style={f.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="submit" style={{ ...f.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} disabled={saving}>{saving ? t.saving : item ? t.saveChanges : t.addItem}</button>
      </div>
    </form>
  );
}

// UOM Management Panel
function ItemUOMPanel({ item }) {
  const t = useT();
  const [uoms, setUOMs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [newForm, setNewForm] = useState({ unit: 'each', unit_spec: '', factor: '1', is_base: false });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pendingRemoveUomId, setPendingRemoveUomId] = useState(null);
  const [removeUomError, setRemoveUomError] = useState('');

  const load = () => {
    api.get(`/inventory/items/${item.id}/uoms`)
      .then(r => setUOMs(r.data))
      .catch(silentError('inventoryitems'))
      .finally(() => setLoading(false));
  };
  React.useEffect(() => { load(); }, [item.id]);

  const setN = (k, v) => setNewForm(f => ({ ...f, [k]: v }));
  const setE = (k, v) => setEditForm(f => ({ ...f, [k]: v }));

  const add = async () => {
    setError(''); setSaving(true);
    try {
      const rows = await api.post(`/inventory/items/${item.id}/uoms`, {
        unit: newForm.unit.trim(), unit_spec: newForm.unit_spec.trim() || null,
        factor: parseFloat(newForm.factor), is_base: newForm.is_base,
      });
      setUOMs(rows.data);
      setAddOpen(false);
      setNewForm({ unit: 'each', unit_spec: '', factor: '1', is_base: false });
    } catch (err) { setError(err.response?.data?.error || t.failedAddUOM); }
    finally { setSaving(false); }
  };

  const save = async (uomId) => {
    setError(''); setSaving(true);
    try {
      const rows = await api.patch(`/inventory/items/${item.id}/uoms/${uomId}`, {
        unit: editForm.unit, unit_spec: editForm.unit_spec || null,
        factor: parseFloat(editForm.factor), is_base: editForm.is_base,
      });
      setUOMs(rows.data); setEditingId(null);
    } catch (err) { setError(err.response?.data?.error || t.failedSaveUOM); }
    finally { setSaving(false); }
  };

  const remove = async (uomId) => {
    setPendingRemoveUomId(null);
    setRemoveUomError('');
    try {
      const rows = await api.delete(`/inventory/items/${item.id}/uoms/${uomId}`);
      setUOMs(rows.data);
    } catch (err) { setRemoveUomError(err.response?.data?.error || t.failedRemoveUOM); }
  };

  return (
    <div style={u.wrap}>
      <div style={u.header}>
        <div>
          <div style={u.title}>{t.unitsOfMeasure}</div>
          <div style={u.hint}>{t.uomHint}</div>
        </div>
        <button style={u.addBtn} onClick={() => setAddOpen(a => !a)}>
          {addOpen ? t.cancel : t.addUOM}
        </button>
      </div>

      {error && <div role="alert" style={u.error}>{error}</div>}
      {removeUomError && <div style={u.error}>{removeUomError}</div>}

      {addOpen && (
        <div style={u.addForm} className="inventory-uom-form">
          <div style={u.formRow} className="inventory-uom-form-row">
            <div style={u.field}>
              <label htmlFor="ii-uom-unit" style={u.label}>{t.uomUnit}</label>
              <input id="ii-uom-unit" style={u.input} value={newForm.unit} onChange={e => setN('unit', e.target.value)} placeholder={t.invUnitPlaceholder} />
            </div>
            <div style={u.field}>
              <label htmlFor="ii-uom-spec" style={u.label}>{t.uomSpec}</label>
              <input id="ii-uom-spec" style={u.input} value={newForm.unit_spec} onChange={e => setN('unit_spec', e.target.value)} placeholder={t.invUnitSpecPlaceholder} />
            </div>
            <div style={u.field}>
              <label htmlFor="ii-uom-factor" style={u.label}>{t.uomFactor}</label>
              <input id="ii-uom-factor" style={u.input} type="number" min="0.0001" step="any" value={newForm.factor} onChange={e => setN('factor', e.target.value)} />
            </div>
            <div style={u.field}>
              <label htmlFor="ii-uom-base" style={u.label}>{t.uomBase}</label>
              <input id="ii-uom-base" type="checkbox" checked={newForm.is_base} onChange={e => setN('is_base', e.target.checked)} style={{ marginTop: 10 }} />
            </div>
            <button style={{ ...u.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={add} disabled={saving}>{t.save}</button>
          </div>
          <p style={u.factorNote}>{t.uomFactorNote}</p>
        </div>
      )}

      {loading ? (
        <div style={u.empty}>{t.advSettingsLoading}</div>
      ) : uoms.length === 0 ? (
        <div style={u.empty}>{t.uomEmpty}</div>
      ) : (
        <table style={u.table}>
          <thead>
            <tr>
              <th style={u.th}>{t.uomUnit}</th>
              <th style={u.th}>{t.uomSpec}</th>
              <th style={{ ...u.th, textAlign: 'right' }}>{t.uomFactor}</th>
              <th style={u.th}>{t.uomBase}</th>
              <th style={u.th}></th>
            </tr>
          </thead>
          <tbody>
            {uoms.map(row => (
              <tr key={row.id} style={{ opacity: row.active ? 1 : 0.5 }}>
                {editingId === row.id ? (
                  <>
                    <td style={u.td}><input style={u.input} value={editForm.unit} onChange={e => setE('unit', e.target.value)} /></td>
                    <td style={u.td}><input style={u.input} value={editForm.unit_spec || ''} onChange={e => setE('unit_spec', e.target.value)} placeholder={t.optional} /></td>
                    <td style={u.td}><input style={{ ...u.input, width: 70, textAlign: 'right' }} type="number" min="0.0001" step="any" value={editForm.factor} onChange={e => setE('factor', e.target.value)} /></td>
                    <td style={u.td}><input type="checkbox" checked={!!editForm.is_base} onChange={e => setE('is_base', e.target.checked)} /></td>
                    <td style={{ ...u.td, whiteSpace: 'nowrap' }}>
                      <button style={{ ...u.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => save(row.id)} disabled={saving}>{t.save}</button>
                      <button style={u.cancelBtn} onClick={() => setEditingId(null)}>{t.cancel}</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ ...u.td, fontWeight: 600 }}>{row.unit}</td>
                    <td style={{ ...u.td, color: '#6b7280' }}>{row.unit_spec || '-'}</td>
                    <td style={{ ...u.td, textAlign: 'right' }}>{parseFloat(row.factor)}</td>
                    <td style={u.td}>{row.is_base ? <span style={u.baseBadge}>{t.uomBaseBadge}</span> : ''}</td>
                    <td style={{ ...u.td, whiteSpace: 'nowrap' }}>
                      <button style={u.iconBtn} aria-label={t.editUnit} onClick={() => { setEditingId(row.id); setEditForm({ unit: row.unit, unit_spec: row.unit_spec || '', factor: String(row.factor), is_base: row.is_base }); }}>{t.invitEdit}</button>
                      {!row.is_base && (pendingRemoveUomId === row.id ? (
                        <>
                          <button style={u.confirmRemoveBtn} onClick={() => remove(row.id)}>{t.confirm}</button>
                          <button style={u.iconBtn} aria-label={t.cancelRemove} onClick={() => setPendingRemoveUomId(null)}>X</button>
                        </>
                      ) : (
                        <button style={u.iconBtn} aria-label={t.removeUnit} onClick={() => setPendingRemoveUomId(row.id)}>{t.invitRemove}</button>
                      ))}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const u = {
  wrap:       { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginTop: 16 },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  title:      { fontSize: 14, fontWeight: 700, color: '#374151' },
  hint:       { fontSize: 12, color: '#6b7280', marginTop: 2 },
  addBtn:     { padding: '6px 14px', borderRadius: 7, border: 'none', background: '#92400e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  error:      { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 },
  addForm:    { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 12 },
  formRow:    { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
  field:      { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 80 },
  label:      { fontSize: 11, fontWeight: 600, color: '#6b7280' },
  input:      { padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, width: '100%', boxSizing: 'border-box' },
  factorNote: { fontSize: 11, color: '#6b7280', marginTop: 8, marginBottom: 0 },
  saveBtn:    { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-end' },
  cancelBtn:  { padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', marginLeft: 4 },
  empty:      { fontSize: 13, color: '#6b7280', padding: '8px 0' },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:         { padding: '6px 8px', fontWeight: 700, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', textAlign: 'left', borderBottom: '1px solid #e5e7eb' },
  td:         { padding: '8px 8px', color: '#374151', borderBottom: '1px solid #f3f4f6' },
  iconBtn:    { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 3px' },
  confirmRemoveBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  baseBadge:  { display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8' },
};

const ITEM_PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

export default function InventoryItems({ onItemChange }) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => readNumberPref(ITEM_PAGE_SIZE_PREF_KEY, 100, ITEM_PAGE_SIZE_OPTIONS));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');
  const [nameFilter, setNameFilter] = useState('');
  const [skuFilter, setSkuFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState([]);
  const [units, setUnits] = useState({ active: DEFAULT_UNITS, known: DEFAULT_UNITS });
  const [editingItem, setEditingItem] = useState(null); // null=none, false=new, obj=editing
  const [archiving, setArchiving] = useState(null);
  const [pendingArchiveItemId, setPendingArchiveItemId] = useState(null);
  const [archiveError, setArchiveError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [labelItem, setLabelItem] = useState(null);
  const [importing, setImporting] = useState(false);
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [selectedColumns, setSelectedColumns] = useState(() => readJsonPref(ITEM_COLUMN_PREF_KEY, DEFAULT_ITEM_COLUMNS));
  const [exportingCsv, setExportingCsv] = useState(false);
  const [mobileView, setMobileView] = useState(() => {
    try {
      return localStorage.getItem('inventory_items_mobile_view') === 'list' ? 'list' : 'card';
    } catch {
      return 'card';
    }
  });

  const buildItemParams = (limit = pageSize, offset = page * pageSize) => {
    const params = new URLSearchParams({ active: activeFilter, limit, offset });
    if (nameFilter) params.set('name_search', nameFilter);
    if (skuFilter) params.set('sku_search', skuFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    params.set('sort', sortBy);
    params.set('dir', sortDir);
    return params;
  };

  const load = async (p = page, size = pageSize) => {
    setLoading(true);
    try {
      const params = buildItemParams(size, p * size);
      const [itemsRes, cats, unitsRes] = await Promise.all([
        api.get(`/inventory/items?${params}`),
        api.get('/inventory/items/categories'),
        api.get('/inventory/units'),
      ]);
      setItems(itemsRes.data.items);
      setTotal(itemsRes.data.total);
      setCategories(cats.data);
      setUnits(unitsRes.data);
    } catch (e) {
      setError(t.loadError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setPage(0); load(0); }, [activeFilter, categoryFilter, nameFilter, skuFilter, sortBy, sortDir, pageSize]);

  useEffect(() => {
    try {
      localStorage.setItem('inventory_items_mobile_view', mobileView);
    } catch {
      // Storage is best-effort only.
    }
  }, [mobileView]);

  useEffect(() => {
    try {
      localStorage.setItem(ITEM_PAGE_SIZE_PREF_KEY, String(pageSize));
    } catch {
      // Storage is best-effort only.
    }
  }, [pageSize]);

  useEffect(() => {
    try {
      localStorage.setItem(ITEM_COLUMN_PREF_KEY, JSON.stringify(selectedColumns));
    } catch {
      // Storage is best-effort only.
    }
  }, [selectedColumns]);

  const setColumnSort = (key, dir) => {
    setSortBy(key);
    setSortDir(dir);
    setPage(0);
  };

  const toggleColumn = key => {
    setSelectedColumns(cols => ({ ...cols, [key]: !cols[key] }));
  };

  const itemSuggestions = {
    names: items.map(item => item.name),
    skus: items.map(item => item.sku),
  };
  const pageStart = total === 0 ? 0 : page * pageSize + 1;
  const pageEnd = Math.min((page + 1) * pageSize, total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canPrevPage = page > 0;
  const canNextPage = pageEnd < total;
  const hasMobileFilters = !!(nameFilter || skuFilter || categoryFilter || activeFilter !== 'true');

  const hasAnyValue = getter => items.some(item => {
    const value = getter(item);
    return value !== null && value !== undefined && String(value).trim() !== '';
  });

  const itemColumnDefs = [
    {
      key: 'name',
      label: t.colName,
      locked: true,
      sortKey: 'name',
      filterType: 'text',
      filterValue: nameFilter,
      onFilter: v => { setNameFilter(v); setPage(0); },
      suggestions: itemSuggestions.names,
      placeholder: t.colName,
      headerStyle: s.th,
      cellStyle: { ...s.td, fontWeight: 600 },
      getValue: item => item.name,
    },
    {
      key: 'sku',
      label: t.colSku,
      sortKey: 'sku',
      filterType: 'text',
      filterValue: skuFilter,
      onFilter: v => { setSkuFilter(v); setPage(0); },
      suggestions: itemSuggestions.skus,
      placeholder: t.colSku,
      cellStyle: { ...s.td, fontFamily: 'monospace', fontSize: 12, color: '#6b7280' },
      getValue: item => item.sku,
    },
    {
      key: 'category',
      label: t.colCategory,
      sortKey: 'category',
      filterType: 'select',
      filterValue: categoryFilter,
      onFilter: v => { setCategoryFilter(v); setPage(0); },
      options: [{ value: '', label: t.allCategories }, ...categories.map(c => ({ value: c, label: c }))],
      getValue: item => item.category,
    },
    {
      key: 'unit',
      label: t.colUnit,
      locked: true,
      sortKey: 'unit',
      cellStyle: { ...s.td, color: '#6b7280' },
      getValue: item => (
        <>
          {item.unit}{item.unit_spec ? <span style={{ color: '#6b7280', fontSize: 12 }}> ({item.unit_spec})</span> : ''}
        </>
      ),
      hasValue: item => item.unit,
    },
    {
      key: 'unit_cost',
      label: t.colUnitCost,
      align: 'right',
      sortKey: 'unit_cost',
      headerStyle: { ...s.th, textAlign: 'right' },
      cellStyle: { ...s.td, textAlign: 'right' },
      getValue: item => item.unit_cost != null ? `$${parseFloat(item.unit_cost).toFixed(2)}` : null,
    },
    {
      key: 'reorder_point',
      label: t.colReorderAt,
      align: 'right',
      sortKey: 'reorder_point',
      headerStyle: { ...s.th, textAlign: 'right' },
      cellStyle: { ...s.td, textAlign: 'right' },
      getValue: item => item.reorder_point > 0 ? item.reorder_point : null,
    },
    {
      key: 'reorder_qty',
      label: t.colReorderQty,
      align: 'right',
      sortKey: 'reorder_qty',
      headerStyle: { ...s.th, textAlign: 'right' },
      cellStyle: { ...s.td, textAlign: 'right' },
      getValue: item => item.reorder_qty > 0 ? item.reorder_qty : null,
    },
    {
      key: 'status',
      label: t.colStatus,
      locked: true,
      sortKey: 'status',
      filterType: 'select',
      filterValue: activeFilter,
      onFilter: v => { setActiveFilter(v || 'true'); setPage(0); },
      options: [{ value: 'true', label: t.itemActiveStatus }, { value: 'false', label: t.itemArchivedStatus }, { value: 'all', label: t.showArchived }],
      getValue: item => item.active
        ? <span style={{ ...s.badge, color: '#059669', background: '#d1fae5' }}>{t.itemActiveStatus}</span>
        : <span style={{ ...s.badge, color: '#6b7280', background: '#f3f4f6' }}>{t.itemArchivedStatus}</span>,
      hasValue: () => true,
    },
    {
      key: 'actions',
      label: '',
      locked: true,
      headerStyle: s.th,
      cellStyle: { ...s.td, whiteSpace: 'nowrap' },
      getValue: item => item.active ? (
        <>
          <button style={s.iconBtn} onClick={() => setLabelItem(item)} aria-label={t.printLabel}>{t.invitLabel}</button>
          <button style={s.iconBtn} onClick={() => setEditingItem(item)} aria-label={t.editItem}>{t.invitEdit}</button>
          {pendingArchiveItemId === item.id ? (
            <>
              <button style={{ ...s.confirmArchiveBtn, ...(archiving === item.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => archive(item)} disabled={archiving === item.id}>{t.confirm}</button>
              <button style={s.iconBtn} aria-label={t.cancelArchive} onClick={() => setPendingArchiveItemId(null)}>X</button>
            </>
          ) : (
            <button style={{ ...s.iconBtn, opacity: archiving === item.id ? 0.5 : 1 }} onClick={() => setPendingArchiveItemId(item.id)} title={t.archive}>{t.invitArchive}</button>
          )}
        </>
      ) : (
        <button style={s.iconBtn} onClick={() => restore(item)} title={t.restore}>{t.invitRestore}</button>
      ),
      hasValue: () => true,
    },
  ];

  const itemColumns = itemColumnDefs.map(col => {
    const selected = col.locked || selectedColumns[col.key];
    const hasFilter = col.filterValue !== '' && col.filterValue != null;
    const hasValues = col.hasValue ? hasAnyValue(col.hasValue) : hasAnyValue(col.getValue);
    const visible = selected && (col.locked || hasValues || hasFilter);
    return { ...col, selected, hasValues, visible, emptyHidden: selected && !col.locked && !hasValues && !hasFilter };
  });
  const visibleItemColumns = itemColumns.filter(col => col.visible);

  const downloadCSV = async () => {
    if (!total || exportingCsv) return;
    setExportingCsv(true);
    let rowsForExport = [];
    try {
      const batchSize = 500;
      for (let offset = 0; offset < total; offset += batchSize) {
        const params = buildItemParams(batchSize, offset);
        const r = await api.get(`/inventory/items?${params}`);
        rowsForExport = rowsForExport.concat(r.data.items || []);
      }
    } catch (err) {
      setError(t.exportFailed || 'Export failed. Try again.');
      setExportingCsv(false);
      return;
    }

    const header = [t.colName, t.colSku, t.colCategory, t.colUnit, t.colUnitCost, t.colReorderAt, t.colReorderQty, t.colStatus].map(csvCell).join(',');
    const rows = rowsForExport.map(item => [
      csvCell(item.name),
      csvCell(item.sku),
      csvCell(item.category),
      csvCell(item.unit_spec ? `${item.unit} (${item.unit_spec})` : item.unit),
      item.unit_cost != null ? parseFloat(item.unit_cost).toFixed(2) : '',
      item.reorder_point > 0 ? item.reorder_point : '',
      item.reorder_qty > 0 ? item.reorder_qty : '',
      csvCell(item.active ? t.itemActiveStatus : t.itemArchivedStatus),
    ].join(','));
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-items-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExportingCsv(false);
  };

  const handleSave = () => {
    setEditingItem(null);
    load();
    onItemChange?.();
  };

  const archive = async item => {
    setPendingArchiveItemId(null);
    setArchiveError('');
    setArchiving(item.id);
    try {
      await api.delete(`/inventory/items/${item.id}`);
      load();
      onItemChange?.();
    } catch (err) {
      setArchiveError(err.response?.data?.error || t.failedArchiveItem);
    } finally {
      setArchiving(null);
    }
  };

  const restore = async item => {
    setRestoreError('');
    try {
      await api.patch(`/inventory/items/${item.id}`, { active: true });
      load();
    } catch { setRestoreError(t.failedRestoreItem); }
  };

  return (
    <div style={s.wrap}>
      {editingItem !== null && (
        <div style={s.wrap}>
          <ItemForm
            item={editingItem || null}
            onSave={handleSave}
            onCancel={() => setEditingItem(null)}
            activeUnits={units.active}
            knownUnits={units.known}
          />
          {editingItem && <ItemUOMPanel item={editingItem} />}
        </div>
      )}

      {editingItem === null && (
        <>
          {/* Toolbar */}
          <div style={s.toolbar}>
            {(nameFilter || skuFilter || categoryFilter || activeFilter !== 'true') && (
              <button
                style={s.importBtn}
                onClick={() => {
                  setNameFilter('');
                  setSkuFilter('');
                  setCategoryFilter('');
                  setActiveFilter('true');
                  setPage(0);
                }}
              >
                {t.invitClearFilters}
              </button>
            )}
            <button style={s.importBtn} onClick={() => setImporting(true)}>{t.invImportBtn || 'Import'}</button>
            {total > 0 && (
              <button style={{ ...s.importBtn, ...(exportingCsv ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadCSV} disabled={exportingCsv}>
                {exportingCsv ? t.invExporting : t.downloadCsv}
              </button>
            )}
            {items.length > 0 && (
              <InventoryColumnPicker
                columns={itemColumns}
                selectedColumns={selectedColumns}
                onToggle={toggleColumn}
                onReset={() => setSelectedColumns(DEFAULT_ITEM_COLUMNS)}
                buttonStyle={s.importBtn}
              />
            )}
            <button style={s.addBtn} onClick={() => setEditingItem(false)}>{t.addItemBtn}</button>
          </div>

          <div style={s.mobileControls} className="inventory-mobile-controls">
            <div style={s.mobileViewToggle} aria-label={t.invitMobileViewLabel}>
              {['card', 'list'].map(mode => (
                <button
                  key={mode}
                  type="button"
                  style={{ ...s.mobileViewBtn, ...(mobileView === mode ? s.mobileViewBtnActive : {}) }}
                  onClick={() => setMobileView(mode)}
                >
                  {mode === 'card' ? t.invitViewCards : t.invitViewList}
                </button>
              ))}
            </div>
            {mobileView === 'card' && (
              <>
                <button
                  type="button"
                  style={{ ...s.mobileFilterToggle, ...(hasMobileFilters ? s.mobileFilterToggleActive : {}) }}
                  onClick={() => setShowMobileFilters(open => !open)}
                  aria-expanded={showMobileFilters}
                >
                  <span>{t.invitFilters}</span>
                  {hasMobileFilters && <span style={s.mobileFilterBadge}>{t.invitFilterActive}</span>}
                  <span>{showMobileFilters ? t.invitHide : t.invitShow}</span>
                </button>
                {showMobileFilters && (
                  <>
                    <input
                      style={s.mobileInput}
                      value={nameFilter}
                      onChange={e => { setNameFilter(e.target.value); setPage(0); }}
                      placeholder={t.invitFindItem}
                    />
                    <input
                      style={s.mobileInput}
                      value={skuFilter}
                      onChange={e => { setSkuFilter(e.target.value); setPage(0); }}
                      placeholder={t.invitSku}
                    />
                    <select style={s.mobileInput} value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setPage(0); }}>
                      <option value="">{t.allCategories}</option>
                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select style={s.mobileInput} value={activeFilter} onChange={e => { setActiveFilter(e.target.value || 'true'); setPage(0); }}>
                      <option value="true">{t.itemActiveStatus}</option>
                      <option value="false">{t.itemArchivedStatus}</option>
                      <option value="all">{t.showArchived}</option>
                    </select>
                    <div style={s.mobileSortRow}>
                      <select style={s.mobileInput} value={sortBy} onChange={e => setColumnSort(e.target.value, sortDir)}>
                        <option value="name">{t.invitSortByName}</option>
                        <option value="sku">{t.invitSortBySku}</option>
                        <option value="category">{t.invitSortByCategory}</option>
                        <option value="unit_cost">{t.invitSortByCost}</option>
                        <option value="reorder_point">{t.invitSortByReorderPoint}</option>
                      </select>
                      <button type="button" style={s.mobileSortBtn} onClick={() => setColumnSort(sortBy, sortDir === 'asc' ? 'desc' : 'asc')}>
                        {sortDir === 'asc' ? 'A-Z' : 'Z-A'}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {importing && (
            <Suspense fallback={null}>
              <ImportItemsModal
                onClose={() => setImporting(false)}
                onDone={() => { load(); onItemChange?.(); }}
              />
            </Suspense>
          )}

          {error && <div role="alert" style={s.error}>{error}</div>}

          {loading ? (
            <div style={s.empty}>{t.advSettingsLoading}</div>
          ) : items.length === 0 ? (
            <div style={s.empty}>
              <p>{t.itemsEmpty}</p>
            </div>
          ) : (
            <>
              <div
                style={s.tableWrap}
                className={`inventory-table-wrap inventory-items-table-wrap ${mobileView === 'list' ? 'inventory-mobile-table-active' : ''}`}
              >
                <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    {visibleItemColumns.map(col => (
                      <th key={col.key} style={col.headerStyle || s.th}>
                        {col.key === 'actions' ? null : (
                          <ColumnHeaderMenu
                            label={col.label}
                            align={col.align}
                            sortKey={col.sortKey}
                            activeSort={sortBy}
                            sortDir={sortDir}
                            onSort={setColumnSort}
                            filterType={col.filterType}
                            filterValue={col.filterValue}
                            onFilter={col.onFilter}
                            options={col.options}
                            suggestions={col.suggestions}
                            placeholder={col.placeholder}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={item.id} style={{ ...(i % 2 === 0 ? s.rowEven : s.row), opacity: item.active ? 1 : 0.55 }}>
                      {visibleItemColumns.map(col => {
                        const style = typeof col.cellStyle === 'function' ? col.cellStyle(item) : (col.cellStyle || s.td);
                        const value = col.getValue(item);
                        return (
                          <td key={col.key} style={style}>
                            {value == null || value === '' ? '-' : value}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
              <div
                style={s.mobileCards}
                className={`inventory-mobile-cards ${mobileView === 'list' ? 'inventory-mobile-cards-hidden' : ''}`}
              >
                {items.map(item => (
                  <article
                    key={item.id}
                    style={{ ...s.mobileCard, opacity: item.active ? 1 : 0.6 }}
                  >
                    <div style={s.mobileCardTop}>
                      <div style={s.mobileCardTitleWrap}>
                        <strong style={s.mobileCardTitle}>{item.name}</strong>
                        <span style={s.mobileCardSub}>{[item.sku, item.category].filter(Boolean).join(' · ') || t.invitNoSku}</span>
                      </div>
                      {item.active
                        ? <span style={{ ...s.badge, color: '#059669', background: '#d1fae5' }}>{t.itemActiveStatus}</span>
                        : <span style={{ ...s.badge, color: '#6b7280', background: '#f3f4f6' }}>{t.itemArchivedStatus}</span>}
                    </div>
                    <div style={s.mobileMetricRow}>
                      <div>
                        <span style={s.mobileLabel}>{t.invitUnitLabel}</span>
                        <strong style={s.mobileValue}>{item.unit}{item.unit_spec ? ` (${item.unit_spec})` : ''}</strong>
                      </div>
                      <div>
                        <span style={s.mobileLabel}>{t.invitCostLabel}</span>
                        <strong style={s.mobileValue}>{item.unit_cost != null ? `$${parseFloat(item.unit_cost).toFixed(2)}` : '-'}</strong>
                      </div>
                    </div>
                    <div style={s.mobileDetailGrid}>
                      <div>
                        <span style={s.mobileLabel}>{t.invitReorderLabel}</span>
                        <span style={s.mobileText}>
                          {t.invitReorderAt} {item.reorder_point > 0 ? item.reorder_point : '-'} · {t.invitReorderQtyShort} {item.reorder_qty > 0 ? item.reorder_qty : '-'}
                        </span>
                      </div>
                    </div>
                    <div style={s.mobileActions}>
                      {item.active ? (
                        <>
                          <button style={s.iconBtn} onClick={() => setLabelItem(item)} aria-label={t.printLabel}>{t.invitLabel}</button>
                          <button style={s.iconBtn} onClick={() => setEditingItem(item)} aria-label={t.editItem}>{t.invitEdit}</button>
                          {pendingArchiveItemId === item.id ? (
                            <>
                              <button style={{ ...s.confirmArchiveBtn, ...(archiving === item.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => archive(item)} disabled={archiving === item.id}>{t.confirm}</button>
                              <button style={s.iconBtn} aria-label={t.cancelArchive} onClick={() => setPendingArchiveItemId(null)}>X</button>
                            </>
                          ) : (
                            <button style={{ ...s.iconBtn, opacity: archiving === item.id ? 0.5 : 1 }} onClick={() => setPendingArchiveItemId(item.id)} title={t.archive}>{t.invitArchive}</button>
                          )}
                        </>
                      ) : (
                        <button style={s.iconBtn} onClick={() => restore(item)} title={t.restore}>{t.invitRestore}</button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              <div style={s.pagination}>
                <div style={s.paginationMeta}>
                  <span style={s.pageInfo}>{t.invitShowing} {pageStart}-{pageEnd} {t.invitOf} {total}</span>
                  <span style={s.pageInfo}>{t.invitPage} {page + 1} {t.invitOf} {pageCount}</span>
                </div>
                <div style={s.paginationControls}>
                  <label style={s.pageSizeLabel}>
                    <select
                      style={s.pageSizeSelect}
                      value={pageSize}
                      onChange={e => {
                        setPageSize(parseInt(e.target.value, 10));
                        setPage(0);
                      }}
                    >
                      {ITEM_PAGE_SIZE_OPTIONS.map(size => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </label>
                  <div style={s.pageButtons}>
                    <button
                      style={{ ...s.pageBtn, ...(!canPrevPage ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      disabled={!canPrevPage}
                      onClick={() => { const p = Math.max(0, page - 1); setPage(p); load(p); }}
                    >
                      {t.invitPrev}
                    </button>
                    <button
                      style={{ ...s.pageBtn, ...(!canNextPage ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      disabled={!canNextPage}
                      onClick={() => { const p = page + 1; setPage(p); load(p); }}
                    >
                      {t.invitNext}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {archiveError && <p style={s.inlineError}>{archiveError}</p>}
      {restoreError && <p style={s.inlineError}>{restoreError}</p>}
      {labelItem && (
        <ItemLabelModal item={labelItem} onClose={() => setLabelItem(null)} />
      )}
    </div>
  );
}

const f = {
  form:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24, margin: 16 },
  title:     { fontSize: 17, fontWeight: 700, color: '#111827', marginBottom: 20 },
  error:     { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 14 },
  row:       { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field:     { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160, marginBottom: 14 },
  label:     { fontSize: 12, fontWeight: 600, color: '#374151' },
  input:     { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff', width: '100%', boxSizing: 'border-box' },
  skuWrap:     { display: 'flex', gap: 6, alignItems: 'center' },
  skuScanning: { borderColor: '#f59e0b', boxShadow: '0 0 0 2px #fde68a', outline: 'none' },
  scanBtn:     { flexShrink: 0, padding: '7px 9px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center' },
  scanBtnActive: { borderColor: '#f59e0b', background: '#fffbeb', color: '#d97706' },
  actions:   { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  cancelBtn: { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  saveBtn:   { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};

const s = {
  wrap:        { padding: 16, minWidth: 0, maxWidth: '100%', overflowX: 'hidden' },
  toolbar:     { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, minWidth: 0, maxWidth: '100%' },
  mobileControls: { display: 'none' },
  mobileInput: { width: '100%', minWidth: 0, padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 14 },
  mobileViewToggle: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, border: '1px solid #d1d5db', borderRadius: 9, background: '#f8fafc' },
  mobileViewBtn: { border: 'none', borderRadius: 7, padding: '8px 10px', background: 'transparent', color: '#64748b', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  mobileViewBtnActive: { background: '#fff', color: '#111827', boxShadow: '0 1px 3px rgba(15,23,42,0.12)' },
  mobileFilterToggle: { width: '100%', border: '1px solid #d1d5db', borderRadius: 9, background: '#fff', color: '#334155', padding: '9px 11px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  mobileFilterToggleActive: { borderColor: '#bfdbfe', background: '#eff6ff', color: '#1d4ed8' },
  mobileFilterBadge: { marginRight: 'auto', padding: '2px 7px', borderRadius: 999, background: '#dbeafe', color: '#1d4ed8', fontSize: 11, fontWeight: 800 },
  mobileSortRow: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 },
  mobileSortBtn: { padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  searchRow:   { display: 'flex', gap: 0, flex: 1, minWidth: 200 },
  searchInput: { flex: 1, padding: '8px 12px', borderRadius: '8px 0 0 8px', border: '1px solid #d1d5db', borderRight: 'none', fontSize: 14 },
  searchBtn:   { padding: '8px 14px', borderRadius: '0 8px 8px 0', border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  select:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151' },
  dirBtn:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  toggle:      { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280', cursor: 'pointer', whiteSpace: 'nowrap' },
  addBtn:      { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  importBtn:   { padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  error:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:       { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:   { fontSize: 40, marginBottom: 12 },
  tableWrap:   { overflowX: 'auto', maxWidth: '100%', minWidth: 0, borderRadius: 10, border: '1px solid #e5e7eb', paddingBottom: 12, scrollbarGutter: 'stable' },
  table:       { width: '100%', borderCollapse: 'collapse', minWidth: 640 },
  thead:       { background: '#f9fafb' },
  th:          { padding: '10px 12px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:         { borderBottom: '1px solid #f3f4f6' },
  rowEven:     { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:          { padding: '10px 12px', fontSize: 14, color: '#374151' },
  badge:       { display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700 },
  iconBtn:     { background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '2px 4px', marginLeft: 2 },
  confirmArchiveBtn: { background: '#f59e0b', color: '#fff', border: 'none', padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  inlineError: { fontSize: 12, color: '#ef4444', padding: '4px 14px', margin: 0 },
  pagination:  { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '10px 0 14px', minWidth: 0, maxWidth: '100%' },
  paginationMeta: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  paginationControls: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', minWidth: 0 },
  pageButtons: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, minWidth: 0 },
  pageInfo:    { fontSize: 13, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' },
  pageSizeLabel: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' },
  pageSizeSelect: { padding: '6px 9px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700 },
  pageBtn:     { padding: '6px 12px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontWeight: 700, color: '#374151' },
  mobileCards: { display: 'none' },
  mobileCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  mobileCardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  mobileCardTitleWrap: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  mobileCardTitle: { fontSize: 16, color: '#111827', lineHeight: 1.25 },
  mobileCardSub: { fontSize: 12, color: '#64748b', lineHeight: 1.35 },
  mobileMetricRow: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 12 },
  mobileDetailGrid: { display: 'grid', gridTemplateColumns: '1fr', gap: 8, paddingTop: 10, borderTop: '1px solid #f1f5f9' },
  mobileLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 },
  mobileValue: { display: 'block', fontSize: 15, color: '#111827' },
  mobileText: { display: 'block', fontSize: 13, color: '#334155', lineHeight: 1.35 },
  mobileActions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
};
