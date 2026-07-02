import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useT } from '../../hooks/useT';
import { useAuth } from '../../contexts/AuthContext';
import { langToLocale } from '../../utils';
import { SkeletonList } from '../Skeleton';
import ModalShell from '../ModalShell';
import ColumnHeaderMenu from './ColumnHeaderMenu';
import InventoryColumnPicker from './InventoryColumnPicker';
import { labelSg } from '../../companyLabels';

import { silentError } from '../../errorReporter';
function formatBin(area_name, rack_name, bay_name, compartment_name) {
  return [area_name, rack_name, bay_name, compartment_name]
    .filter(Boolean).join(' > ') || null;
}

function formatDate(iso, locale = 'en-US') {
  if (!iso) return '-';
  return new Date(iso).toLocaleString(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const TYPE_COLOR  = { receive: '#059669', issue: '#dc2626', transfer: '#2563eb', adjust: '#d97706', count: '#7c3aed', convert: '#0891b2' };
const STOCK_COLUMN_PREF_KEY = 'inventory_stock_columns';
const STOCK_PAGE_SIZE_PREF_KEY = 'inventory_stock_page_size';
const DEFAULT_STOCK_COLUMNS = {
  item: true,
  sku: true,
  category: true,
  location: true,
  area: true,
  rack: true,
  bay: true,
  compartment: true,
  bin: false,
  quantity: true,
  unit: true,
  unit_cost: true,
  value: true,
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

// History Panel

function HistoryPanel({ item, onClose }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const TYPE_LABELS = {
    receive: t.invTxTypeReceive, issue: t.invTxTypeIssue, transfer: t.invTxTypeTransfer,
    adjust: t.invTxTypeAdjust, count: t.invCycCycleCount, convert: t.invTxTypeConvert,
  };
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = () => {
    setLoading(true); setError('');
    api.get(`/inventory/transactions?item_id=${item.item_id}&limit=30`)
      .then(r => setRows(r.data.transactions || r.data))
      .catch(() => setError(t.invStockFailedHistory))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [item.item_id]);

  return (
    <div style={h.overlay} onClick={onClose}>
      <ModalShell onClose={onClose} titleId="is-history-title" className="inventory-history-sheet" style={h.panel} onClick={e => e.stopPropagation()}>
        <div style={h.header}>
          <div>
            <div id="is-history-title" style={h.title}>{item.item_name}</div>
            <div style={h.sub}>{t.invStockRecentMovements}</div>
          </div>
          <button style={h.close} aria-label={t.labelModalClose} onClick={onClose}>X</button>
        </div>
        {error && <div role="alert" style={h.error}>{error} <button style={h.retryBtn} onClick={load}>{t.tryAgain || t.invskTryAgain}</button></div>}
        {loading ? (
          <SkeletonList count={3} rows={1} />
        ) : rows.length === 0 ? (
          <div style={h.empty}>{t.invStockNoHistory}</div>
        ) : (
          <div className="inventory-history-table-wrap" style={h.tableWrap}>
            <table style={h.table}>
              <thead>
                <tr style={h.thead}>
                  <th style={h.th}>{t.invTxColDate}</th>
                  <th style={h.th}>{t.invTxColType}</th>
                  <th style={{ ...h.th, textAlign: 'right' }}>{t.invTxColQty}</th>
                  <th style={h.th}>{t.invPOReceivingLocLabel}</th>
                  <th style={h.th}>{t.invTxColBy}</th>
                  <th style={h.th}>{t.notes}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const qty = parseFloat(r.quantity);
                  const isOut = ['issue', 'transfer'].includes(r.type);
                  const sign = r.type === 'adjust' ? (qty >= 0 ? '+' : '') : (isOut ? '-' : '+');
                  const color = r.type === 'adjust' ? (qty >= 0 ? '#059669' : '#dc2626') : (isOut ? '#dc2626' : '#059669');
                  const location = r.to_location_name || r.from_location_name || '-';
                  return (
                    <tr key={r.id} style={i % 2 === 0 ? h.rowEven : h.row}>
                      <td style={{ ...h.td, fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{formatDate(r.created_at, locale)}</td>
                      <td style={h.td}>
                        <span style={{ ...h.badge, color: TYPE_COLOR[r.type] || '#374151', background: '#f3f4f6' }}>
                          {TYPE_LABELS[r.type] || r.type}
                        </span>
                      </td>
                      <td style={{ ...h.td, textAlign: 'right', fontWeight: 700, color }}>
                        {sign}{Math.abs(qty) % 1 === 0 ? Math.abs(qty).toFixed(0) : Math.abs(qty).toFixed(2)} {r.unit || ''}
                      </td>
                      <td style={{ ...h.td, fontSize: 12 }}>{location}</td>
                      <td style={{ ...h.td, fontSize: 12 }}>{r.performed_by_name || '-'}</td>
                      <td style={{ ...h.td, fontSize: 12, color: '#6b7280' }}>{r.notes || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ModalShell>
    </div>
  );
}

const h = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  panel:     { background: '#fff', borderRadius: '12px 12px 0 0', width: '100%', maxWidth: 900, maxHeight: '70vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' },
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 20px 14px', borderBottom: '1px solid #e5e7eb' },
  title:     { fontSize: 16, fontWeight: 700, color: '#111827' },
  sub:       { fontSize: 12, color: '#6b7280', marginTop: 2 },
  close:     { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: '2px 6px' },
  error:     { background: '#fee2e2', color: '#dc2626', padding: '10px 20px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 10 },
  retryBtn:  { background: 'none', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  empty:     { padding: '40px 20px', textAlign: 'center', color: '#6b7280', fontSize: 14 },
  tableWrap: { overflowY: 'auto', flex: 1 },
  table:     { width: '100%', borderCollapse: 'collapse' },
  thead:     { background: '#f9fafb', position: 'sticky', top: 0 },
  th:        { padding: '8px 12px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:       { borderBottom: '1px solid #f3f4f6' },
  rowEven:   { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:        { padding: '8px 12px', fontSize: 13, color: '#374151' },
  badge:     { display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 },
};

// Quick Adjust Modal

function AdjustModal({ item, locations, onClose, onDone }) {
  const t = useT();
  const [qty, setQty]       = useState('');
  const [locId, setLocId]   = useState(item.location_id || '');
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [warning, setWarning] = useState('');

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = async () => {
    const n = parseFloat(qty);
    if (isNaN(n) || n === 0) { setError(t.invStockQtyAdjError); return; }
    if (!locId) { setError(t.invStockSelectLocError); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/inventory/transactions', {
        type: 'adjust',
        item_id: item.item_id,
        quantity: n,
        to_location_id: parseInt(locId),
        notes: notes.trim() || undefined,
      });
      if (r.data.warning === 'stock_negative') {
        setWarning(t.invTxStockNegativeWarn);
      } else {
        onDone();
      }
    } catch (e) {
      setError(e.response?.data?.error || t.invStockAdjFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={a.overlay} onClick={onClose}>
      <ModalShell onClose={onClose} titleId="is-adj-title" className="inventory-stock-modal" style={a.modal} onClick={e => e.stopPropagation()}>
        <div style={a.header}>
          <div id="is-adj-title" style={a.title}>{t.invStockCurrentStock} - {item.item_name}</div>
          <button style={a.close} aria-label={t.labelModalClose} onClick={onClose}>X</button>
        </div>
        <div style={a.body}>
          <div className="inventory-stock-current-row" style={a.currentRow}>
            <span style={a.currentLabel}>{t.invStockCurrentStock}</span>
            <span style={a.currentQty}>{parseFloat(item.quantity) % 1 === 0 ? parseFloat(item.quantity).toFixed(0) : parseFloat(item.quantity).toFixed(2)} {item.unit}</span>
          </div>
          {error && <div role="alert" style={a.error}>{error}</div>}
          {warning && <div style={{ ...a.error, background: '#fef3c7', color: '#92400e' }}>{warning}</div>}
          <label htmlFor="is-adj-qty" style={a.label}>{t.invStockAdjQtyLabel}</label>
          <input
            id="is-adj-qty"
            type="number"
            step="any"
            placeholder={t.invAdjustPlaceholder}
            value={qty}
            onChange={e => setQty(e.target.value)}
            style={a.input}
            autoFocus
          />
          <label htmlFor="is-adj-loc" style={a.label}>{t.invStockAdjLocLabel}</label>
          <select id="is-adj-loc" value={locId} onChange={e => setLocId(e.target.value)} style={a.input}>
            <option value="">{t.invStockSelectLocOption}</option>
            {locations.filter(l => l.active).map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label htmlFor="is-adj-notes" style={a.label}>{t.invStockAdjNotesLabel}</label>
            <span style={{ fontSize: 11, color: '#6b7280' }}>{notes.length}/1000</span>
          </div>
          <input
            id="is-adj-notes"
            type="text"
            placeholder={t.invStockAdjReasonPlaceholder}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={a.input}
            maxLength={1000}
          />
          <div className="inventory-stock-modal-actions" style={a.actions}>
            <button style={{ ...a.cancel, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={warning ? onDone : onClose} disabled={saving}>{warning ? t.back : t.cancel}</button>
            {!warning && <button style={{ ...a.save, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submit} disabled={saving}>{saving ? t.saving : t.invStockSaveAdj}</button>}
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

const a = {
  overlay:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1010, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal:       { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 20px 14px', borderBottom: '1px solid #e5e7eb' },
  title:       { fontSize: 15, fontWeight: 700, color: '#111827' },
  close:       { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer' },
  body:        { padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  currentRow:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f9fafb', borderRadius: 8, padding: '10px 14px' },
  currentLabel:{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' },
  currentQty:  { fontSize: 18, fontWeight: 800, color: '#111827' },
  error:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '8px 12px', fontSize: 13 },
  label:       { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: -4 },
  input:       { padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, width: '100%', boxSizing: 'border-box' },
  actions:     { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
  cancel:      { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  save:        { padding: '9px 18px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  hint:        { fontSize: 12, color: '#059669', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '4px 10px' },
};

// Quick Issue Modal (workers)

function IssueModal({ item, projects, settings, onClose, onDone }) {
  const t = useT();
  const { user } = useAuth();
  const workLabel = labelSg(settings?.label_work, 'work', user?.language);
  const [qty, setQty]             = useState('');
  const [uomId, setUomId]         = useState(item.uom_id ? String(item.uom_id) : '');
  const [itemUoms, setItemUoms]   = useState([]);
  const [projectId, setProjectId] = useState('');
  const [notes, setNotes]         = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [warning, setWarning]     = useState('');

  const available = parseFloat(item.quantity);
  const stockUnit = item.unit_spec ? `${item.unit} (${item.unit_spec})` : item.unit;

  useEffect(() => {
    api.get(`/inventory/items/${item.item_id}/uoms`)
      .then(r => setItemUoms(r.data.filter(u => u.active)))
      .catch(silentError('inventorystock'));
  }, [item.item_id]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const selectedUom = itemUoms.find(u => String(u.id) === uomId);
  const stockUom    = item.uom_id ? itemUoms.find(u => u.id === item.uom_id) : null;

  // Conversion hint: how many of the selected UOM equal the available stock
  const availableInSelected = (() => {
    if (!selectedUom || !stockUom) return null;
    const sf = parseFloat(stockUom.factor || 1);
    const tf = parseFloat(selectedUom.factor || 1);
    if (!tf || sf === tf) return null;
    const converted = (available * sf) / tf;
    return `${converted % 1 === 0 ? converted.toFixed(0) : converted.toFixed(2)} ${selectedUom.unit}`;
  })();

  const submit = async () => {
    const n = parseFloat(qty);
    if (isNaN(n) || n <= 0) { setError(t.invStockIssueQtyError); return; }
    // Only enforce client-side limit when issuing in the same UOM as stock
    if ((!uomId || uomId === String(item.uom_id)) && n > available) {
      setError(`${t.invStockCannotExceed} (${available % 1 === 0 ? available.toFixed(0) : available.toFixed(2)} ${stockUnit})`);
      return;
    }
    setSaving(true); setError('');
    try {
      const r = await api.post('/inventory/transactions', {
        type: 'issue',
        item_id: item.item_id,
        quantity: n,
        uom_id: uomId ? parseInt(uomId) : undefined,
        from_location_id: item.location_id,
        project_id: projectId ? parseInt(projectId) : undefined,
        notes: notes.trim() || undefined,
      });
      if (r.data.warning === 'stock_negative') {
        setWarning(t.invTxStockNegativeWarn);
      } else {
        onDone();
      }
    } catch (e) {
      setError(e.response?.data?.error || t.invStockIssueFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={a.overlay} onClick={onClose}>
      <ModalShell onClose={onClose} titleId="is-issue-title" className="inventory-stock-modal" style={a.modal} onClick={e => e.stopPropagation()}>
        <div style={a.header}>
          <div id="is-issue-title" style={a.title}>{t.invTxTypeIssue} - {item.item_name}</div>
          <button style={a.close} aria-label={t.labelModalClose} onClick={onClose}>X</button>
        </div>
        <div style={a.body}>
          <div className="inventory-stock-current-row" style={a.currentRow}>
            <span style={a.currentLabel}>{t.invStockAvailableAt} {item.location_name}</span>
            <span style={a.currentQty}>{available % 1 === 0 ? available.toFixed(0) : available.toFixed(2)} {stockUnit}</span>
          </div>
          {error && <div role="alert" style={a.error}>{error}</div>}
          {warning && <div style={{ ...a.error, background: '#fef3c7', color: '#92400e' }}>{warning}</div>}
          <label htmlFor="is-issue-qty" style={a.label}>{t.invStockQtyToIssue}</label>
          <input
            id="is-issue-qty"
            type="number"
            step="any"
            min="0.001"
            placeholder={t.invStockQtyPlaceholder}
            value={qty}
            onChange={e => setQty(e.target.value)}
            style={a.input}
            autoFocus
          />
          {itemUoms.length > 1 && (
            <>
              <label htmlFor="is-issue-unit" style={a.label}>{t.invStockUnitLabel}</label>
              <select id="is-issue-unit" value={uomId} onChange={e => setUomId(e.target.value)} style={a.input}>
                <option value="">{t.invStockDefaultUnit} ({item.unit})</option>
                {itemUoms.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.unit}{u.unit_spec ? ` (${u.unit_spec})` : ''}{u.is_base ? ` - ${t.invTxBaseUnit}` : ''}
                  </option>
                ))}
              </select>
              {availableInSelected && (
                <div style={a.hint}>~ {availableInSelected} {t.invStockAvailableInUnit}</div>
              )}
            </>
          )}
          {projects && projects.length > 0 && (
            <>
              <label htmlFor="is-issue-project" style={a.label}>{workLabel}</label>
              <select id="is-issue-project" value={projectId} onChange={e => setProjectId(e.target.value)} style={a.input}>
                <option value="">No {workLabel.toLowerCase()}</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </>
          )}
          <label htmlFor="is-issue-notes" style={a.label}>{t.invStockAdjNotesLabel}</label>
          <input
            id="is-issue-notes"
            type="text"
            placeholder={t.invStockIssuePlaceholder}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={a.input}
            maxLength={1000}
          />
          <div className="inventory-stock-modal-actions" style={a.actions}>
            <button style={{ ...a.cancel, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={warning ? onDone : onClose} disabled={saving}>{warning ? t.back : t.cancel}</button>
            {!warning && <button style={{ ...a.save, background: '#d97706', ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submit} disabled={saving}>
              {saving ? t.invStockIssuing : t.invStockIssueMaterials}
            </button>}
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

// Main Stock Component

const STOCK_PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

export default function InventoryStock({ isAdmin, locations, projects, settings, onStockChange, onReorderClick }) {
  const t = useT();
  const [stock, setStock]           = useState([]);
  const [stockTotal, setStockTotal] = useState(0);
  const [stockPage, setStockPage] = useState(0);
  const [stockPageSize, setStockPageSize] = useState(() => readNumberPref(STOCK_PAGE_SIZE_PREF_KEY, 100, STOCK_PAGE_SIZE_OPTIONS));
  const [lowItems, setLowItems]     = useState([]);
  const [locationFilter, setLocationFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [itemFilter, setItemFilter] = useState('');
  const [skuFilter, setSkuFilter] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [rackFilter, setRackFilter] = useState('');
  const [bayFilter, setBayFilter] = useState('');
  const [compartmentFilter, setCompartmentFilter] = useState('');
  const [binFilter, setBinFilter] = useState('');
  const [categories, setCategories] = useState([]);
  const [sortBy, setSortBy] = useState('location');
  const [sortDir, setSortDir] = useState('asc');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [mobileView, setMobileView] = useState(() => {
    try {
      return localStorage.getItem('inventory_stock_mobile_view') === 'list' ? 'list' : 'card';
    } catch {
      return 'card';
    }
  });
  const [selectedColumns, setSelectedColumns] = useState(() => readJsonPref(STOCK_COLUMN_PREF_KEY, DEFAULT_STOCK_COLUMNS));
  const [exportingCsv, setExportingCsv] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [historyItem, setHistoryItem] = useState(null);
  const [adjustItem, setAdjustItem]   = useState(null);
  const [issueItem, setIssueItem]     = useState(null);

  const buildStockParams = useCallback((limit = stockPageSize, offset = stockPage * stockPageSize) => {
      const params = new URLSearchParams({ limit, offset });
      if (locationFilter) params.set('location_id', locationFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (itemFilter) params.set('item_search', itemFilter);
      if (skuFilter) params.set('sku_search', skuFilter);
      if (areaFilter) params.set('area_search', areaFilter);
      if (rackFilter) params.set('rack_search', rackFilter);
      if (bayFilter) params.set('bay_search', bayFilter);
      if (compartmentFilter) params.set('compartment_search', compartmentFilter);
      if (binFilter) params.set('bin_search', binFilter);
      params.set('sort', sortBy);
      params.set('dir', sortDir);
      return params;
  }, [locationFilter, categoryFilter, statusFilter, itemFilter, skuFilter, areaFilter, rackFilter, bayFilter, compartmentFilter, binFilter, sortBy, sortDir, stockPage, stockPageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildStockParams();
      const [s, l, cats] = await Promise.all([
        api.get(`/inventory/stock?${params}`),
        isAdmin ? api.get('/inventory/stock/low') : Promise.resolve({ data: [] }),
        api.get('/inventory/items/categories'),
      ]);
      const stockRows = Array.isArray(s.data?.stock)
        ? s.data.stock
        : Array.isArray(s.data)
          ? s.data
          : [];
      setStock(stockRows);
      setStockTotal(s.data?.total ?? stockRows.length);
      setLowItems(Array.isArray(l.data) ? l.data : []);
      setCategories(Array.isArray(cats.data) ? cats.data : []);
    } catch (e) {
      setError(t.invStockFailedLoad);
    } finally {
      setLoading(false);
    }
  }, [buildStockParams, isAdmin]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem('inventory_stock_mobile_view', mobileView);
    } catch {
      // Storage is best-effort only.
    }
  }, [mobileView]);

  useEffect(() => {
    try {
      localStorage.setItem(STOCK_PAGE_SIZE_PREF_KEY, String(stockPageSize));
    } catch {
      // Storage is best-effort only.
    }
  }, [stockPageSize]);

  useEffect(() => {
    try {
      localStorage.setItem(STOCK_COLUMN_PREF_KEY, JSON.stringify(selectedColumns));
    } catch {
      // Storage is best-effort only.
    }
  }, [selectedColumns]);

  const setColumnSort = (key, dir) => {
    setSortBy(key);
    setSortDir(dir);
    setStockPage(0);
  };

  const setStockFilter = setter => value => {
    setter(value);
    setStockPage(0);
  };

  const stockSuggestions = {
    items: stock.map(row => row.item_name),
    skus: stock.map(row => row.sku),
    areas: stock.map(row => row.area_name),
    racks: stock.map(row => row.rack_name),
    bays: stock.map(row => row.bay_name),
    compartments: stock.map(row => row.compartment_name),
    bins: stock.flatMap(row => [row.area_name, row.rack_name, row.bay_name, row.compartment_name, formatBin(row.area_name, row.rack_name, row.bay_name, row.compartment_name)]),
  };

  const stockStatus = (qty, reorderPoint) => {
    const q = parseFloat(qty);
    if (q <= 0) return { label: t.invStockStatusOut, color: '#dc2626', bg: '#fee2e2' };
    if (reorderPoint > 0 && q <= reorderPoint) return { label: t.invStockStatusLow, color: '#d97706', bg: '#fef3c7' };
    return { label: t.invStockStatusInStock, color: '#059669', bg: '#d1fae5' };
  };

  const downloadCSV = async () => {
    if (!stockTotal || exportingCsv) return;
    setExportingCsv(true);
    let rowsForExport = [];
    try {
      const batchSize = 500;
      for (let offset = 0; offset < stockTotal; offset += batchSize) {
        const params = buildStockParams(batchSize, offset);
        const r = await api.get(`/inventory/stock?${params}`);
        rowsForExport = rowsForExport.concat(r.data.stock || []);
      }
    } catch (err) {
      setError(t.exportFailed || t.invskExportFailed);
      setExportingCsv(false);
      return;
    }
    const header = [t.invTxColItem, t.colSku, t.colCategory, t.invValColLocation, t.invStockColBin,
      t.invTxColQty, t.colUnit, t.colUnitCost, t.invValColTotalValue, t.invStockColStatus].join(',');
    const rows = rowsForExport.map(row => {
      const qty = parseFloat(row.quantity);
      const cost = parseFloat(row.unit_cost);
      const status = stockStatus(qty, row.reorder_point);
      const bin = [row.area_name, row.rack_name, row.bay_name, row.compartment_name].filter(Boolean).join(' > ') || '';
      return [
        csvCell(row.item_name),
        csvCell(row.sku),
        csvCell(row.category),
        csvCell(row.location_name),
        csvCell(bin),
        qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2),
        csvCell(row.unit),
        cost ? cost.toFixed(2) : '',
        cost && qty > 0 ? (cost * qty).toFixed(2) : '',
        csvCell(status.label),
      ].join(',');
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-stock-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExportingCsv(false);
  };

  const handleAdjustDone = () => {
    setAdjustItem(null);
    load();
    if (onStockChange) onStockChange();
  };

  const handleIssueDone = () => {
    setIssueItem(null);
    load();
    if (onStockChange) onStockChange();
  };

  const toggleColumn = key => {
    setSelectedColumns(cols => ({ ...cols, [key]: !cols[key] }));
  };

  const hasAnyValue = getter => stock.some(row => {
    const value = getter(row);
    return value !== null && value !== undefined && String(value).trim() !== '';
  });

  const stockColumnDefs = [
    {
      key: 'item',
      label: t.invTxColItem,
      locked: true,
      sortKey: 'item',
      filterType: 'text',
      filterValue: itemFilter,
      onFilter: setStockFilter(setItemFilter),
      suggestions: stockSuggestions.items,
      placeholder: t.invskItemNamePlaceholder,
      headerStyle: s.th,
      cellStyle: { ...s.td, fontWeight: 600 },
      getValue: row => row.item_name,
    },
    {
      key: 'sku',
      label: t.colSku,
      sortKey: 'sku',
      filterType: 'text',
      filterValue: skuFilter,
      onFilter: setStockFilter(setSkuFilter),
      suggestions: stockSuggestions.skus,
      placeholder: t.invskSkuPlaceholder,
      cellStyle: { ...s.td, color: '#6b7280', fontFamily: 'monospace', fontSize: 12 },
      getValue: row => row.sku,
    },
    {
      key: 'category',
      label: t.colCategory,
      sortKey: 'category',
      filterType: 'select',
      filterValue: categoryFilter,
      onFilter: setStockFilter(setCategoryFilter),
      options: [{ value: '', label: t.allCategories || t.invskAllCategories }, ...categories.map(c => ({ value: c, label: c }))],
      getValue: row => row.category,
    },
    {
      key: 'location',
      label: t.invValColLocation,
      locked: true,
      sortKey: 'location',
      filterType: 'select',
      filterValue: locationFilter,
      onFilter: setStockFilter(setLocationFilter),
      options: [{ value: '', label: t.invCycAllLocations }, ...locations.filter(l => l.active).map(l => ({ value: String(l.id), label: l.name }))],
      getValue: row => row.location_name,
    },
    {
      key: 'area',
      label: t.invskColArea,
      sortKey: 'area',
      filterType: 'text',
      filterValue: areaFilter,
      onFilter: setStockFilter(setAreaFilter),
      suggestions: stockSuggestions.areas,
      placeholder: t.invskColArea,
      getValue: row => row.area_name,
    },
    {
      key: 'rack',
      label: t.invskColRack,
      sortKey: 'rack',
      filterType: 'text',
      filterValue: rackFilter,
      onFilter: setStockFilter(setRackFilter),
      suggestions: stockSuggestions.racks,
      placeholder: t.invskColRack,
      getValue: row => row.rack_name,
    },
    {
      key: 'bay',
      label: t.invskColBay,
      sortKey: 'bay',
      filterType: 'text',
      filterValue: bayFilter,
      onFilter: setStockFilter(setBayFilter),
      suggestions: stockSuggestions.bays,
      placeholder: t.invskColBay,
      getValue: row => row.bay_name,
    },
    {
      key: 'compartment',
      label: t.invskColCompartment,
      sortKey: 'compartment',
      filterType: 'text',
      filterValue: compartmentFilter,
      onFilter: setStockFilter(setCompartmentFilter),
      suggestions: stockSuggestions.compartments,
      placeholder: t.invskColCompartment,
      getValue: row => row.compartment_name,
    },
    {
      key: 'bin',
      label: t.invStockColBin,
      sortKey: 'bin',
      filterType: 'text',
      filterValue: binFilter,
      onFilter: setStockFilter(setBinFilter),
      suggestions: stockSuggestions.bins,
      placeholder: t.invskBinPathPlaceholder,
      cellStyle: { ...s.td, color: '#6b7280', fontSize: 12 },
      getValue: row => formatBin(row.area_name, row.rack_name, row.bay_name, row.compartment_name),
    },
    {
      key: 'quantity',
      label: t.invTxColQty,
      locked: true,
      align: 'right',
      sortKey: 'quantity',
      headerStyle: { ...s.th, textAlign: 'right' },
      cellStyle: row => ({ ...s.td, textAlign: 'right', fontWeight: 700, color: parseFloat(row.quantity) < 0 ? '#dc2626' : '#111827' }),
      getValue: row => {
        const qty = parseFloat(row.quantity);
        return qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2);
      },
    },
    {
      key: 'unit',
      label: t.colUnit,
      locked: true,
      sortKey: 'unit',
      cellStyle: { ...s.td, color: '#6b7280' },
      getValue: row => (
        <>
          {row.unit}
          {row.unit_spec && <span style={{ fontSize: 11, color: '#6b7280' }}> ({row.unit_spec})</span>}
        </>
      ),
      hasValue: row => row.unit,
    },
    {
      key: 'unit_cost',
      label: t.colUnitCost,
      adminOnly: true,
      align: 'right',
      sortKey: 'unit_cost',
      headerStyle: { ...s.th, textAlign: 'right' },
      cellStyle: { ...s.td, textAlign: 'right', color: '#6b7280' },
      getValue: row => {
        const cost = parseFloat(row.unit_cost);
        return cost ? `$${cost.toFixed(2)}` : null;
      },
    },
    {
      key: 'value',
      label: t.invValColTotalValue,
      adminOnly: true,
      align: 'right',
      sortKey: 'value',
      headerStyle: { ...s.th, textAlign: 'right' },
      cellStyle: { ...s.td, textAlign: 'right', fontWeight: 600 },
      getValue: row => {
        const qty = parseFloat(row.quantity);
        const cost = parseFloat(row.unit_cost);
        return cost && qty > 0 ? `$${(cost * qty).toFixed(2)}` : null;
      },
    },
    {
      key: 'status',
      label: t.invStockColStatus,
      locked: true,
      sortKey: 'status',
      filterType: 'select',
      filterValue: statusFilter,
      onFilter: setStockFilter(setStatusFilter),
      options: [{ value: '', label: t.allStatuses || t.invskAllStatuses }, { value: 'in', label: t.invStockStatusInStock }, { value: 'low', label: t.invStockStatusLow }, { value: 'out', label: t.invStockStatusOut }],
      getValue: row => {
        const status = stockStatus(row.quantity, row.reorder_point);
        return <span style={{ ...s.badge, color: status.color, background: status.bg }}>{status.label}</span>;
      },
      hasValue: () => true,
    },
    {
      key: 'actions',
      label: '',
      locked: true,
      headerStyle: s.th,
      cellStyle: { ...s.td, whiteSpace: 'nowrap' },
      getValue: row => {
        const qty = parseFloat(row.quantity);
        return (
          <>
            <button
              style={s.histBtn}
              title={t.invStockViewHistory}
              onClick={() => setHistoryItem(row)}
            >{t.invskLogBtn}</button>
            {isAdmin && (
              <button
                style={s.adjBtn}
                title={t.invStockQuickAdjust}
                onClick={() => setAdjustItem(row)}
              >+/-</button>
            )}
            {!isAdmin && qty > 0 && (
              <button
                style={s.issueBtn}
                title={t.invStockIssueMaterials}
                onClick={() => setIssueItem(row)}
              >{t.invStockIssueBtn}</button>
            )}
          </>
        );
      },
      hasValue: () => true,
    },
  ];

  const stockColumns = stockColumnDefs
    .filter(col => !col.adminOnly || isAdmin)
    .map(col => {
      const selected = col.locked || selectedColumns[col.key];
      const hasFilter = col.filterValue !== '' && col.filterValue != null;
      const hasValues = col.hasValue ? hasAnyValue(col.hasValue) : hasAnyValue(col.getValue);
      const visible = selected && (col.locked || hasValues || hasFilter);
      return { ...col, selected, hasValues, visible, emptyHidden: selected && !col.locked && !hasValues && !hasFilter };
    });
  const visibleStockColumns = stockColumns.filter(col => col.visible);
  const pageStart = stockTotal === 0 ? 0 : stockPage * stockPageSize + 1;
  const pageEnd = Math.min((stockPage + 1) * stockPageSize, stockTotal);
  const pageCount = Math.max(1, Math.ceil(stockTotal / stockPageSize));
  const canPrevPage = stockPage > 0;
  const canNextPage = pageEnd < stockTotal;
  const hasMobileFilters = !!(itemFilter || skuFilter || binFilter || locationFilter || categoryFilter || statusFilter || areaFilter || rackFilter || bayFilter || compartmentFilter);

  return (
    <div style={s.wrap}>
      {/* Low stock alert banner */}
      {isAdmin && lowItems.length > 0 && (
        <div style={s.alertBanner}>
          <span>{t.invskWarningPrefix} {lowItems.length} {t.invStockLowAlert}</span>
          {onReorderClick && (
            <button style={s.reorderBtn} onClick={onReorderClick}>
              {t.invStockCreateReorderPO}
            </button>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div style={s.filterBar}>
        {(itemFilter || skuFilter || areaFilter || rackFilter || bayFilter || compartmentFilter || binFilter || locationFilter || categoryFilter || statusFilter) && (
          <button
            style={s.refreshBtn}
            onClick={() => {
              setItemFilter('');
              setSkuFilter('');
              setAreaFilter('');
              setRackFilter('');
              setBayFilter('');
              setCompartmentFilter('');
              setBinFilter('');
              setLocationFilter('');
              setCategoryFilter('');
              setStatusFilter('');
              setStockPage(0);
            }}
          >
            {t.invskClear}
          </button>
        )}
        <button
          type="button"
          style={{ ...s.refreshBtn, ...s.refreshIconBtn }}
          onClick={load}
          aria-label={t.invStockRefresh}
          title={t.invStockRefresh}
        >
          &#8635;
        </button>
        {stockTotal > 0 && (
          <button style={{ ...s.refreshBtn, ...(exportingCsv ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadCSV} disabled={exportingCsv}>{exportingCsv ? t.invskExporting : t.invValDownloadCSV}</button>
        )}
        {stock.length > 0 && (
          <InventoryColumnPicker
            columns={stockColumns}
            selectedColumns={selectedColumns}
            onToggle={toggleColumn}
            onReset={() => setSelectedColumns(DEFAULT_STOCK_COLUMNS)}
            buttonStyle={s.refreshBtn}
          />
        )}
      </div>

      <div style={s.mobileControls} className="inventory-mobile-controls">
        <div style={s.mobileViewToggle} aria-label={t.invskMobileViewLabel}>
          {['card', 'list'].map(mode => (
            <button
              key={mode}
              type="button"
              style={{ ...s.mobileViewBtn, ...(mobileView === mode ? s.mobileViewBtnActive : {}) }}
              onClick={() => setMobileView(mode)}
            >
              {mode === 'card' ? t.invskViewCards : t.invskViewList}
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
              <span>{t.invskFilters}</span>
              {hasMobileFilters && <span style={s.mobileFilterBadge}>{t.invskActive}</span>}
              <span>{showMobileFilters ? t.invskHide : t.invskShow}</span>
            </button>
            {showMobileFilters && (
              <>
                <input
                  style={s.mobileInput}
                  value={itemFilter}
                  onChange={e => setStockFilter(setItemFilter)(e.target.value)}
                  placeholder={t.invFindItem}
                />
                <input
                  style={s.mobileInput}
                  value={skuFilter}
                  onChange={e => setStockFilter(setSkuFilter)(e.target.value)}
                  placeholder={t.invSkuPlaceholder}
                />
                <select style={s.mobileInput} value={locationFilter} onChange={e => setStockFilter(setLocationFilter)(e.target.value)}>
                  <option value="">{t.invCycAllLocations}</option>
                  {locations.filter(l => l.active).map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                </select>
                <input
                  style={s.mobileInput}
                  value={binFilter}
                  onChange={e => setStockFilter(setBinFilter)(e.target.value)}
                  placeholder={t.invAreaRackBayBin}
                />
                <select style={s.mobileInput} value={statusFilter} onChange={e => setStockFilter(setStatusFilter)(e.target.value)}>
                  <option value="">{t.allStatuses || t.invskAllStatuses}</option>
                  <option value="in">{t.invStockStatusInStock}</option>
                  <option value="low">{t.invStockStatusLow}</option>
                  <option value="out">{t.invStockStatusOut}</option>
                </select>
                <div style={s.mobileSortRow}>
                  <select style={s.mobileInput} value={sortBy} onChange={e => setColumnSort(e.target.value, sortDir)}>
                    <option value="item">{t.invskSortByItem}</option>
                    <option value="location">{t.invskSortByLocation}</option>
                    <option value="quantity">{t.invskSortByQuantity}</option>
                    <option value="status">{t.invskSortByStatus}</option>
                    <option value="value">{t.invskSortByValue}</option>
                  </select>
                  <button type="button" style={s.mobileSortBtn} onClick={() => setColumnSort(sortBy, sortDir === 'asc' ? 'desc' : 'asc')}>
                    {sortDir === 'asc' ? t.invskAZ : t.invskZA}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {error && <div role="alert" style={s.error}>{error}</div>}

      {loading ? (
        <SkeletonList count={5} rows={2} />
      ) : stock.length === 0 ? (
        <div style={s.empty}>
          <p>{locationFilter ? t.invStockNoStockAtLoc : t.invStockNoStock}</p>
          <p style={s.emptyHint}>{t.invStockReceiveHint}</p>
        </div>
      ) : (
        <>
        <div
          style={s.tableWrap}
          className={`inventory-table-wrap inventory-stock-table-wrap ${mobileView === 'list' ? 'inventory-mobile-table-active' : ''}`}
        >
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                {visibleStockColumns.map(col => (
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
              {stock.map((row, i) => (
                <tr
                  key={row.id}
                  style={{ ...(i % 2 === 0 ? s.rowEven : s.row), cursor: 'pointer' }}
                  onClick={() => setHistoryItem(row)}
                >
                  {visibleStockColumns.map(col => {
                    const style = typeof col.cellStyle === 'function' ? col.cellStyle(row) : (col.cellStyle || s.td);
                    const value = col.getValue(row);
                    return (
                      <td key={col.key} style={style} onClick={col.key === 'actions' ? e => e.stopPropagation() : undefined}>
                        {value ?? '-'}
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
          {stock.map(row => {
            const qty = parseFloat(row.quantity);
            const cost = parseFloat(row.unit_cost);
            const status = stockStatus(row.quantity, row.reorder_point);
            const bin = formatBin(row.area_name, row.rack_name, row.bay_name, row.compartment_name);
            return (
              <article
                key={row.id}
                style={s.mobileCard}
                onClick={() => setHistoryItem(row)}
              >
                <div style={s.mobileCardTop}>
                  <div style={s.mobileCardTitleWrap}>
                    <strong style={s.mobileCardTitle}>{row.item_name}</strong>
                    <span style={s.mobileCardSub}>{[row.sku, row.category].filter(Boolean).join(' · ') || t.invskNoSku}</span>
                  </div>
                  <span style={{ ...s.badge, color: status.color, background: status.bg }}>{status.label}</span>
                </div>
                <div style={s.mobileMetricRow}>
                  <div>
                    <span style={s.mobileLabel}>{t.invskLabelQty}</span>
                    <strong style={s.mobileValue}>{qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} {row.unit}</strong>
                  </div>
                  {isAdmin && cost > 0 && (
                    <div>
                      <span style={s.mobileLabel}>{t.invskLabelValue}</span>
                      <strong style={s.mobileValue}>${(cost * Math.max(qty, 0)).toFixed(2)}</strong>
                    </div>
                  )}
                </div>
                <div style={s.mobileDetailGrid}>
                  <div>
                    <span style={s.mobileLabel}>{t.invskLabelLocation}</span>
                    <span style={s.mobileText}>{row.location_name || '-'}</span>
                  </div>
                  {bin && (
                    <div>
                      <span style={s.mobileLabel}>{t.invskLabelBin}</span>
                      <span style={s.mobileText}>{bin}</span>
                    </div>
                  )}
                </div>
                <div style={s.mobileActions} onClick={e => e.stopPropagation()}>
                  <button style={s.histBtn} onClick={() => setHistoryItem(row)}>{t.invskLogBtn}</button>
                  {isAdmin && <button style={s.adjBtn} onClick={() => setAdjustItem(row)}>+/-</button>}
                  {!isAdmin && qty > 0 && <button style={s.issueBtn} onClick={() => setIssueItem(row)}>{t.invStockIssueBtn}</button>}
                </div>
              </article>
            );
          })}
        </div>
        <div style={s.paginationBar}>
          <div style={s.paginationMeta}>
            <span style={s.paginationText}>{t.invskShowing} {pageStart}-{pageEnd} {t.invskOf} {stockTotal}</span>
            <span style={s.paginationText}>{t.invskPage} {stockPage + 1} {t.invskOf} {pageCount}</span>
          </div>
          <div style={s.paginationControls}>
            <label style={s.pageSizeLabel}>
              <select
                style={s.pageSizeSelect}
                value={stockPageSize}
                onChange={e => {
                  setStockPageSize(parseInt(e.target.value, 10));
                  setStockPage(0);
                }}
              >
                {STOCK_PAGE_SIZE_OPTIONS.map(size => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </label>
            <div style={s.pageButtons}>
              <button
                style={{ ...s.pageBtn, ...(!canPrevPage ? s.pageBtnDisabled : {}) }}
                disabled={!canPrevPage}
                onClick={() => setStockPage(p => Math.max(0, p - 1))}
              >
                {t.invskPrev}
              </button>
              <button
                style={{ ...s.pageBtn, ...(!canNextPage ? s.pageBtnDisabled : {}) }}
                disabled={!canNextPage}
                onClick={() => setStockPage(p => p + 1)}
              >
                {t.invskNext}
              </button>
            </div>
          </div>
        </div>
        </>
      )}

      {historyItem && (
        <HistoryPanel item={historyItem} onClose={() => setHistoryItem(null)} />
      )}
      {adjustItem && (
        <AdjustModal
          item={adjustItem}
          locations={locations}
          onClose={() => setAdjustItem(null)}
          onDone={handleAdjustDone}
        />
      )}
      {issueItem && (
        <IssueModal
          item={issueItem}
          projects={projects || []}
          settings={settings}
          onClose={() => setIssueItem(null)}
          onDone={handleIssueDone}
        />
      )}
    </div>
  );
}

const s = {
  wrap:        { padding: 16, minWidth: 0, maxWidth: '100%', overflowX: 'hidden' },
  alertBanner: { background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  reorderBtn:  { padding: '6px 14px', borderRadius: 7, border: 'none', background: '#92400e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  filterBar:   { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' },
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
  searchForm:  { display: 'flex', flex: '1 1 260px', minWidth: 220 },
  searchInput: { flex: 1, padding: '8px 12px', borderRadius: '8px 0 0 8px', border: '1px solid #d1d5db', borderRight: 'none', fontSize: 14, minWidth: 0 },
  searchBtn:   { padding: '8px 14px', borderRadius: '0 8px 8px 0', border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  select:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151' },
  dirBtn:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  refreshBtn:  { padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  refreshIconBtn: { width: 38, minWidth: 38, height: 38, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, lineHeight: 1 },
  error:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:       { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:   { fontSize: 40, marginBottom: 12 },
  emptyHint:   { fontSize: 13, color: '#6b7280', marginTop: 4 },
  tableWrap:   { overflowX: 'auto', maxWidth: '100%', minWidth: 0, borderRadius: 10, border: '1px solid #e5e7eb', paddingBottom: 12, scrollbarGutter: 'stable' },
  table:       { width: '100%', borderCollapse: 'collapse', minWidth: 760 },
  thead:       { background: '#f9fafb' },
  th:          { padding: '10px 12px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:         { borderBottom: '1px solid #f3f4f6' },
  rowEven:     { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:          { padding: '10px 12px', fontSize: 14, color: '#374151' },
  badge:       { display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700 },
  paginationBar: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '10px 0 14px', minWidth: 0, maxWidth: '100%' },
  paginationMeta: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  paginationControls: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', minWidth: 0 },
  pageButtons: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, minWidth: 0 },
  paginationText: { fontSize: 13, color: '#6b7280', fontWeight: 600 },
  pageSizeLabel: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' },
  pageSizeSelect: { padding: '6px 9px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700 },
  pageBtn: { padding: '7px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  pageBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  histBtn:     { padding: '4px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb', fontSize: 13, cursor: 'pointer', marginRight: 4 },
  adjBtn:      { padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  issueBtn:    { padding: '4px 10px', borderRadius: 6, border: '1px solid #fcd34d', background: '#fef3c7', color: '#92400e', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  mobileCards: { display: 'none' },
  mobileCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,0.04)', cursor: 'pointer' },
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
