import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import UomConversionModal from './UomConversionModal';
import { useT } from '../../hooks/useT';
import { useAuth } from '../../contexts/AuthContext';
import { langToLocale } from '../../utils';
import { SkeletonList } from '../Skeleton';
import ModalShell from '../ModalShell';
import ColumnHeaderMenu from './ColumnHeaderMenu';
import { silentError } from '../../errorReporter';
const TYPE_COLORS = {
  receive:  { color: '#059669', bg: '#d1fae5' },
  issue:    { color: '#d97706', bg: '#fef3c7' },
  transfer: { color: '#2563eb', bg: '#dbeafe' },
  adjust:   { color: '#6b7280', bg: '#f3f4f6' },
  convert:  { color: '#8b5cf6', bg: '#ede9fe' },
};
const TX_PAGE_SIZE_PREF_KEY = 'inventory_transactions_page_size';
const TX_MOBILE_VIEW_PREF_KEY = 'inventory_transactions_mobile_view';
const TX_PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

function readNumberPref(key, fallback, allowed) {
  try {
    const value = parseInt(localStorage.getItem(key), 10);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readMobileViewPref(key) {
  try {
    return localStorage.getItem(key) === 'list' ? 'list' : 'card';
  } catch {
    return 'card';
  }
}

function formatQty(value) {
  const qty = parseFloat(value);
  if (Number.isNaN(qty)) return '-';
  return qty % 1 === 0 ? String(parseInt(qty, 10)) : qty.toFixed(2);
}

function TransactionForm({ isAdmin, locations, projects, settings, onSave, onCancel, onConversionSaved }) {
  const t = useT();
  const workLabel = settings?.label_work || 'Project';
  const TYPE_LABELS = {
    receive:  t.invTxTypeReceive,
    issue:    t.invTxTypeIssue,
    transfer: t.invTxTypeTransfer,
    adjust:   t.invTxTypeAdjust,
    convert:  t.invTxTypeConvert,
  };
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [locationStock, setLocationStock] = useState(null); // { quantity, unit, uom_id } at from_location
  const [conversionPrompt, setConversionPrompt] = useState(null); // { uom, baseUnit, field }
  const [form, setForm] = useState({
    type: isAdmin ? 'receive' : 'issue',
    item_id: '',
    quantity: '',
    uom_id: '',
    to_uom_id: '',
    to_quantity: '',
    from_location_id: '',
    to_location_id: '',
    area_id:        '',
    rack_id:        '',
    bay_id:         '',
    compartment_id: '',
    project_id: '',
    notes: '',
    reference_no: '',
    unit_cost: '',
    supplier_id: '',
    lot_number: '',
  });
  const [itemUoms, setItemUoms] = useState([]);
  // Cascading bin options for the destination location
  const [binOpts, setBinOpts] = useState({ areas: [], racks: [], bays: [], compartments: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  useEffect(() => {
    api.get('/inventory/items?active=true').then(r => setItems(r.data)).catch(silentError('inventory-transactions fetch'));
    if (isAdmin) api.get('/inventory/suppliers').then(r => setSuppliers(r.data)).catch(silentError('inventory-transactions fetch'));
  }, [isAdmin]);

  // Load UOMs when item changes
  useEffect(() => {
    setItemUoms([]);
    set('uom_id', ''); set('to_uom_id', ''); set('to_quantity', '');
    setLocationStock(null);
    if (!form.item_id) return;
    api.get(`/inventory/items/${form.item_id}/uoms`)
      .then(r => setItemUoms(r.data.filter(u => u.active)))
      .catch(silentError('inventory-transactions fetch'));
  }, [form.item_id]);

  // Prompt for conversion factor when admin selects a non-base UOM with factor=1
  const checkConversionNeeded = (uomId, field) => {
    if (!isAdmin || !uomId || !form.item_id) return;
    const uom = itemUoms.find(u => String(u.id) === String(uomId));
    if (uom && !uom.is_base && parseFloat(uom.factor) === 1) {
      const baseUom  = itemUoms.find(u => u.is_base);
      const baseUnit = baseUom
        ? `${baseUom.unit}${baseUom.unit_spec ? ` (${baseUom.unit_spec})` : ''}`
        : items.find(i => String(i.id) === form.item_id)?.unit || 'base unit';
      setConversionPrompt({ uom, baseUnit, field });
    }
  };

  useEffect(() => { checkConversionNeeded(form.uom_id, 'uom_id'); }, [form.uom_id]);
  useEffect(() => { checkConversionNeeded(form.to_uom_id, 'to_uom_id'); }, [form.to_uom_id]);

  // Load current stock at from_location when item + location both set (for issue/transfer)
  useEffect(() => {
    setLocationStock(null);
    const locId = form.from_location_id;
    if (!form.item_id || !locId || !['issue', 'transfer', 'convert'].includes(form.type)) return;
    api.get(`/inventory/stock?location_id=${locId}`)
      .then(r => {
        const row = (r.data.stock || r.data).find(s => String(s.item_id) === String(form.item_id));
        setLocationStock(row || null);
      })
      .catch(silentError('inventory-transactions fetch'));
  }, [form.item_id, form.from_location_id, form.type]);

  // Cascade bin options when destination location changes
  useEffect(() => {
    const locId = form.to_location_id;
    set('area_id', ''); set('rack_id', ''); set('bay_id', ''); set('compartment_id', '');
    setBinOpts({ areas: [], racks: [], bays: [], compartments: [] });
    if (!locId) return;
    api.get(`/inventory/setup/areas?location_id=${locId}&active=true`)
      .then(r => setBinOpts(b => ({ ...b, areas: r.data })))
      .catch(silentError('inventory-transactions fetch'));
  }, [form.to_location_id]);

  useEffect(() => {
    set('rack_id', ''); set('bay_id', ''); set('compartment_id', '');
    setBinOpts(b => ({ ...b, racks: [], bays: [], compartments: [] }));
    if (!form.area_id) return;
    api.get(`/inventory/setup/racks?area_id=${form.area_id}&active=true`)
      .then(r => setBinOpts(b => ({ ...b, racks: r.data })))
      .catch(silentError('inventory-transactions fetch'));
  }, [form.area_id]);

  useEffect(() => {
    set('bay_id', ''); set('compartment_id', '');
    setBinOpts(b => ({ ...b, bays: [], compartments: [] }));
    if (!form.rack_id) return;
    api.get(`/inventory/setup/bays?rack_id=${form.rack_id}&active=true`)
      .then(r => setBinOpts(b => ({ ...b, bays: r.data })))
      .catch(silentError('inventory-transactions fetch'));
  }, [form.rack_id]);

  useEffect(() => {
    set('compartment_id', '');
    setBinOpts(b => ({ ...b, compartments: [] }));
    if (!form.bay_id) return;
    api.get(`/inventory/setup/compartments?bay_id=${form.bay_id}&active=true`)
      .then(r => setBinOpts(b => ({ ...b, compartments: r.data })))
      .catch(silentError('inventory-transactions fetch'));
  }, [form.bay_id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const activeLocations = locations.filter(l => l.active);

  const submit = async e => {
    e.preventDefault();
    setError(''); setWarning('');
    if (!form.item_id) return setError(t.invTxSelectItemErr);
    const qty = parseFloat(form.quantity);
    if (!form.quantity || isNaN(qty) || qty === 0) return setError(t.invTxNonZeroErr);
    setSaving(true);
    try {
      const payload = {
        type: form.type,
        item_id: parseInt(form.item_id),
        quantity: qty,
        from_location_id: form.from_location_id ? parseInt(form.from_location_id) : undefined,
        to_location_id: form.to_location_id ? parseInt(form.to_location_id) : undefined,
        uom_id:         form.uom_id    ? parseInt(form.uom_id)    : undefined,
        to_uom_id:      form.to_uom_id ? parseInt(form.to_uom_id) : undefined,
        to_quantity:    form.to_quantity ? parseFloat(form.to_quantity) : undefined,
        area_id:        form.area_id        ? parseInt(form.area_id)        : undefined,
        rack_id:        form.rack_id        ? parseInt(form.rack_id)        : undefined,
        bay_id:         form.bay_id         ? parseInt(form.bay_id)         : undefined,
        compartment_id: form.compartment_id ? parseInt(form.compartment_id) : undefined,
        project_id: form.project_id ? parseInt(form.project_id) : undefined,
        notes: form.notes || undefined,
        reference_no: form.reference_no || undefined,
        unit_cost: form.unit_cost !== '' ? parseFloat(form.unit_cost) : undefined,
        supplier_id: form.supplier_id ? parseInt(form.supplier_id) : undefined,
        lot_number: form.lot_number || undefined,
      };
      const r = await api.post('/inventory/transactions', payload);
      if (r.data.warning === 'stock_negative') {
        setWarning(t.invTxStockNegativeWarn);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || t.invTxFailedSave);
    } finally {
      setSaving(false);
    }
  };

  const showFrom  = ['issue', 'transfer', 'convert'].includes(form.type);
  const showTo    = ['receive', 'transfer'].includes(form.type);
  const showToAdj = form.type === 'adjust';
  const isConvert = form.type === 'convert';

  // Auto-suggest to_quantity when both UOMs have factors
  const suggestedToQty = (() => {
    if (!isConvert || !form.quantity || !form.to_uom_id) return null;
    const src = form.uom_id ? itemUoms.find(u => String(u.id) === form.uom_id) : null;
    const tgt = itemUoms.find(u => String(u.id) === form.to_uom_id);
    if (!tgt) return null;
    const srcFactor = src ? parseFloat(src.factor) : 1;
    const tgtFactor = parseFloat(tgt.factor);
    if (!tgtFactor) return null;
    return ((parseFloat(form.quantity) * srcFactor) / tgtFactor).toFixed(4).replace(/\.?0+$/, '');
  })();

  return (
    <form className="inventory-transaction-form" onSubmit={submit} style={f.form}>
      <div className="inventory-transaction-title-row" style={f.titleRow}>
        <h3 style={f.title}>{t.invTxLogMovement}</h3>
        <button type="button" className="inventory-transaction-close" style={f.closeBtn} onClick={onCancel} aria-label={t.labelModalClose || t.invtxClose}>
          X
        </button>
      </div>
      {error   && <div style={f.error}>{error}</div>}
      {warning && <div style={f.warning}>{warning}</div>}

      {isAdmin && (
        <div style={f.field}>
          <label htmlFor="itx-type" style={f.label}>{t.invTxTypeLabel}</label>
          <select id="itx-type" style={f.input} value={form.type} onChange={e => set('type', e.target.value)}>
            <option value="receive">{t.invTxTypeReceiveDesc}</option>
            <option value="issue">{t.invTxTypeIssueDesc}</option>
            <option value="transfer">{t.invTxTypeTransferDesc}</option>
            <option value="adjust">{t.invTxTypeAdjustDesc}</option>
            <option value="convert">{t.invTxTypeConvertDesc}</option>
          </select>
        </div>
      )}

      <div className="inventory-transaction-grid" style={f.row}>
        <div style={f.field}>
          <label htmlFor="itx-item" style={f.label}>{t.invTxColItem} *</label>
          <select id="itx-item" style={f.input} value={form.item_id} onChange={e => {
            const item = items.find(i => String(i.id) === e.target.value);
            set('item_id', e.target.value);
            if (item?.unit_cost) set('unit_cost', String(item.unit_cost));
          }}>
            <option value="">{t.invTxSelectItem}</option>
            {items.map(i => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
          </select>
        </div>
        {itemUoms.length > 0 && (
          <div style={f.field}>
            <label htmlFor="itx-uom" style={f.label}>{isConvert ? t.invTxConvertFrom : t.invTxUomLabel}</label>
            <select id="itx-uom" style={f.input} value={form.uom_id} onChange={e => set('uom_id', e.target.value)}>
              <option value="">{t.invTxDefaultUnit}</option>
              {itemUoms.map(u => (
                <option key={u.id} value={u.id}>
                  {u.unit}{u.unit_spec ? ` (${u.unit_spec})` : ''}{u.is_base ? ` — ${t.invTxBaseUnit}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div style={f.field}>
          <label htmlFor="itx-qty" style={f.label}>
            {t.quantity} *
            {form.type === 'adjust' && <span style={f.hint}> {t.invTxAdjHint}</span>}
            {isConvert && <span style={f.hint}> {t.invTxConvertHint}</span>}
          </label>
          <input
            id="itx-qty"
            style={f.input} type="number" step="any"
            min={form.type === 'adjust' ? undefined : 0}
            value={form.quantity} onChange={e => set('quantity', e.target.value)}
            placeholder={form.type === 'adjust' ? t.invTxAdjQtyPlaceholder : t.invTxQtyPlaceholder}
          />
        </div>
      </div>

      {isConvert && (
        <div className="inventory-transaction-grid" style={f.row}>
          <div style={f.field}>
            <label htmlFor="itx-to-uom" style={f.label}>{t.invTxConvertToUom}</label>
            <select id="itx-to-uom" style={f.input} value={form.to_uom_id} onChange={e => set('to_uom_id', e.target.value)}>
              <option value="">{t.invTxSelectTargetUom}</option>
              {itemUoms.filter(u => String(u.id) !== form.uom_id).map(u => (
                <option key={u.id} value={u.id}>
                  {u.unit}{u.unit_spec ? ` (${u.unit_spec})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={f.field}>
            <label htmlFor="itx-to-qty" style={f.label}>
              {t.invTxResultingQty}
              {suggestedToQty && <span style={f.hint}> — {t.invTxSuggested} {suggestedToQty}</span>}
            </label>
            <input
              id="itx-to-qty"
              style={f.input} type="number" step="any" min="0"
              value={form.to_quantity}
              onChange={e => set('to_quantity', e.target.value)}
              placeholder={suggestedToQty || t.invTxTargetQtyPlaceholder}
            />
          </div>
        </div>
      )}

      {showFrom && (
        <div style={f.field}>
          <label htmlFor="itx-from-loc" style={f.label}>{t.invTxFromLoc}</label>
          <select id="itx-from-loc" style={f.input} value={form.from_location_id} onChange={e => set('from_location_id', e.target.value)}>
            <option value="">{t.invCycSelectLocation}</option>
            {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {locationStock && (() => {
            const qty = parseFloat(locationStock.quantity);
            const stockUnit = locationStock.uom_unit
              ? `${locationStock.uom_unit}${locationStock.uom_spec ? ` (${locationStock.uom_spec})` : ''}`
              : locationStock.unit;
            return (
              <div style={f.stockHint}>
                {t.invTxOnHand} <strong>{qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} {stockUnit}</strong>
                {locationStock.uom_unit && locationStock.unit !== locationStock.uom_unit && (
                  <span style={{ color: '#6b7280' }}> {t.invTxSysConverts}</span>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {(showTo || showToAdj) && (
        <>
          <div style={f.field}>
            <label htmlFor="itx-to-loc" style={f.label}>{showToAdj ? t.invTxLocOnly : t.invTxToLoc}</label>
            <select id="itx-to-loc" style={f.input} value={form.to_location_id} onChange={e => set('to_location_id', e.target.value)}>
              <option value="">{t.invCycSelectLocation}</option>
              {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          {binOpts.areas.length > 0 && (
            <div className="inventory-transaction-bin-grid" style={f.binRow}>
              <div style={f.binField}>
                <label htmlFor="itx-bin-area" style={f.label}>{t.binLabelArea}</label>
                <select id="itx-bin-area" style={f.input} value={form.area_id} onChange={e => set('area_id', e.target.value)}>
                  <option value="">{t.none}</option>
                  {binOpts.areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              {form.area_id && binOpts.racks.length > 0 && (
                <div style={f.binField}>
                  <label htmlFor="itx-bin-rack" style={f.label}>{t.binLabelRack}</label>
                  <select id="itx-bin-rack" style={f.input} value={form.rack_id} onChange={e => set('rack_id', e.target.value)}>
                    <option value="">{t.none}</option>
                    {binOpts.racks.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
              )}
              {form.rack_id && binOpts.bays.length > 0 && (
                <div style={f.binField}>
                  <label htmlFor="itx-bin-bay" style={f.label}>{t.binLabelBay}</label>
                  <select id="itx-bin-bay" style={f.input} value={form.bay_id} onChange={e => set('bay_id', e.target.value)}>
                    <option value="">{t.none}</option>
                    {binOpts.bays.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
              {form.bay_id && binOpts.compartments.length > 0 && (
                <div style={f.binField}>
                  <label htmlFor="itx-bin-compartment" style={f.label}>{t.binLabelCompartment}</label>
                  <select id="itx-bin-compartment" style={f.input} value={form.compartment_id} onChange={e => set('compartment_id', e.target.value)}>
                    <option value="">{t.none}</option>
                    {binOpts.compartments.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {(form.type === 'issue' || form.type === 'receive') && (
        <div style={f.field}>
          <label htmlFor="itx-project" style={f.label}>{workLabel}</label>
          <select id="itx-project" style={f.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">{t.none}</option>
            {projects.filter(p => p.active !== false).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      {isAdmin && (
        <>
          <div className="inventory-transaction-grid" style={f.row}>
            <div style={f.field}>
              <label htmlFor="itx-unit-cost" style={f.label}>{t.invTxUnitCost}</label>
              <input id="itx-unit-cost" style={f.input} type="number" min="0" step="0.01" value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} placeholder={t.optional} />
            </div>
            <div style={f.field}>
              <label htmlFor="itx-ref-po" style={f.label}>{t.invTxRefPO}</label>
              <input id="itx-ref-po" style={f.input} maxLength={100} value={form.reference_no} onChange={e => set('reference_no', e.target.value)} placeholder={t.optional} />
            </div>
          </div>
          <div className="inventory-transaction-grid" style={f.row}>
            {form.type === 'receive' && suppliers.length > 0 && (
              <div style={f.field}>
                <label htmlFor="itx-supplier" style={f.label}>{t.invPOSupplier}</label>
                <select id="itx-supplier" style={f.input} value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)}>
                  <option value="">{t.none}</option>
                  {suppliers.map(sup => <option key={sup.id} value={sup.id}>{sup.name}</option>)}
                </select>
              </div>
            )}
            {(form.type === 'receive' || form.type === 'adjust') && (
              <div style={f.field}>
                <label htmlFor="itx-lot" style={f.label}>{t.invTxLotBatch}</label>
                <input id="itx-lot" style={f.input} value={form.lot_number} onChange={e => set('lot_number', e.target.value)} placeholder={t.optional} />
              </div>
            )}
          </div>
        </>
      )}

      <div style={f.field}>
        <label htmlFor="itx-notes" style={f.label}>{t.notes}</label>
        <textarea id="itx-notes" style={{ ...f.input, minHeight: 60, resize: 'vertical' }} maxLength={1000} value={form.notes} onChange={e => set('notes', e.target.value)} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.notes || '').length}/1000</div>
      </div>

      <div className="inventory-transaction-actions" style={f.actions}>
        <button type="button" style={f.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="submit" style={{ ...f.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} disabled={saving}>{saving ? t.saving : t.invTxLogTx}</button>
      </div>

      {conversionPrompt && (
        <UomConversionModal
          itemId={form.item_id}
          uom={conversionPrompt.uom}
          baseUnit={conversionPrompt.baseUnit}
          onSaved={updatedList => {
            setItemUoms(updatedList.filter(u => u.active));
            setConversionPrompt(null);
            onConversionSaved?.();
          }}
          onDismiss={() => setConversionPrompt(null)}
        />
      )}
    </form>
  );
}

export default function InventoryTransactions({ isAdmin, locations, projects, settings, onTransaction, onConversionSaved }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workLabel = settings?.label_work || 'Project';
  const TYPE_LABELS = {
    receive:  t.invTxTypeReceive,
    issue:    t.invTxTypeIssue,
    transfer: t.invTxTypeTransfer,
    adjust:   t.invTxTypeAdjust,
    convert:  t.invTxTypeConvert,
  };
  const [transactions, setTransactions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [filters, setFilters] = useState({
    type: '',
    from_location_id: '',
    to_location_id: '',
    project_id: '',
    from: '',
    to: '',
    supplier_id: '',
    lot_number: '',
    item_search: '',
    by_search: '',
    notes_search: '',
  });
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [suppliers, setSuppliers] = useState([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => readNumberPref(TX_PAGE_SIZE_PREF_KEY, 50, TX_PAGE_SIZE_OPTIONS));
  const [mobileView, setMobileView] = useState(() => readMobileViewPref(TX_MOBILE_VIEW_PREF_KEY));

  useEffect(() => {
    if (isAdmin) api.get('/inventory/suppliers').then(r => setSuppliers(r.data)).catch(silentError('inventory-transactions fetch'));
  }, [isAdmin]);

  useEffect(() => {
    try {
      localStorage.setItem(TX_PAGE_SIZE_PREF_KEY, String(pageSize));
    } catch {
      // Storage is best-effort only.
    }
  }, [pageSize]);

  useEffect(() => {
    try {
      localStorage.setItem(TX_MOBILE_VIEW_PREF_KEY, mobileView);
    } catch {
      // Storage is best-effort only.
    }
  }, [mobileView]);

  const load = useCallback(async (nextPage = 0) => {
    setLoading(true);
    try {
      const offset = nextPage * pageSize;
      const params = new URLSearchParams({ limit: pageSize, offset });
      if (filters.type) params.set('type', filters.type);
      if (filters.from_location_id) params.set('from_location_id', filters.from_location_id);
      if (filters.to_location_id) params.set('to_location_id', filters.to_location_id);
      if (filters.project_id) params.set('project_id', filters.project_id);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.supplier_id) params.set('supplier_id', filters.supplier_id);
      if (filters.lot_number) params.set('lot_number', filters.lot_number);
      if (filters.item_search) params.set('item_search', filters.item_search);
      if (filters.by_search) params.set('by_search', filters.by_search);
      if (filters.notes_search) params.set('notes_search', filters.notes_search);
      params.set('sort', sortBy);
      params.set('dir', sortDir);
      const r = await api.get(`/inventory/transactions?${params}`);
      setTransactions(r.data.transactions);
      setTotal(r.data.total);
      setPage(nextPage);
    } catch {
      setError(t.invTxFailedLoad);
    } finally {
      setLoading(false);
    }
  }, [filters, pageSize, sortBy, sortDir]);

  useEffect(() => { load(0); }, [load]);

  const handleSave = () => {
    setShowForm(false);
    load(0);
    onTransaction?.();
  };

  const setFilter = (k, v) => {
    setPage(0);
    setFilters(f => ({ ...f, [k]: v }));
  };
  const setColumnSort = (key, dir) => {
    setPage(0);
    setSortBy(key);
    setSortDir(dir);
  };

  const activeLocations = locations.filter(l => l.active);
  const txSuggestions = {
    items: transactions.flatMap(row => [row.item_name, row.sku]),
    by: transactions.map(row => row.performed_by_name),
    notes: transactions.flatMap(row => [row.notes, row.reference_no]),
    lots: transactions.map(row => row.lot_number),
  };
  const resetFilters = () => {
    setPage(0);
    setFilters({
      type: '',
      from_location_id: '',
      to_location_id: '',
      project_id: '',
      from: '',
      to: '',
      supplier_id: '',
      lot_number: '',
      item_search: '',
      by_search: '',
      notes_search: '',
    });
  };
  const hasFilters = !!(
    filters.item_search || filters.by_search || filters.notes_search || filters.type ||
    filters.from_location_id || filters.to_location_id || filters.project_id || filters.from ||
    filters.to || filters.supplier_id || filters.lot_number
  );
  const pageStart = total === 0 ? 0 : page * pageSize + 1;
  const pageEnd = Math.min((page + 1) * pageSize, total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canPrevPage = page > 0;
  const canNextPage = pageEnd < total;

  return (
    <div style={s.wrap}>
      {showForm && (
        <div style={s.formOverlay} onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <ModalShell
            onClose={() => setShowForm(false)}
            ariaLabel={t.invTxLogMovement}
            className="inventory-transaction-modal"
            style={s.formModal}
          >
            <TransactionForm
              isAdmin={isAdmin}
              locations={locations}
              projects={projects}
              settings={settings}
              onSave={handleSave}
              onCancel={() => setShowForm(false)}
              onConversionSaved={onConversionSaved}
            />
          </ModalShell>
        </div>
      )}
      <>
        <div className="inventory-transaction-toolbar" style={s.toolbar}>
            <div className="inventory-transaction-date" style={s.dateWrap}>
              <span style={s.dateLabel}>{t.invTxColFrom}</span>
              <input style={s.dateInput} type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)} />
            </div>
            <div className="inventory-transaction-date" style={s.dateWrap}>
              <span style={s.dateLabel}>{t.invTxColTo}</span>
              <input style={s.dateInput} type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)} />
            </div>
            {(filters.from || filters.to) && (
              <button style={s.clearDates} onClick={() => { setPage(0); setFilters(f => ({ ...f, from: '', to: '' })); }} title={t.invTxClearDates}>{t.invTxClearDates}</button>
            )}
            {hasFilters && (
              <button
                style={s.clearDates}
                onClick={resetFilters}
              >
                {t.invtxClear}
              </button>
            )}
            <button
              style={s.addBtn}
              onClick={() => setShowForm(true)}
            >
              {isAdmin ? t.invTxLogMovementBtn : t.invTxIssueMaterialsBtn}
            </button>
          </div>

          <div style={s.mobileControls} className="inventory-mobile-controls">
            <div style={s.mobileViewToggle} aria-label={t.invtxMobileViewLabel}>
              {['card', 'list'].map(mode => (
                <button
                  key={mode}
                  type="button"
                  style={{ ...s.mobileViewBtn, ...(mobileView === mode ? s.mobileViewBtnActive : {}) }}
                  onClick={() => setMobileView(mode)}
                >
                  {mode === 'card' ? t.invtxViewCards : t.invtxViewList}
                </button>
              ))}
            </div>
          </div>

          {error && <div role="alert" style={s.error}>{error}</div>}

          {loading ? (
            <SkeletonList count={4} rows={2} />
          ) : transactions.length === 0 ? (
            <div style={s.empty}>
              <p>{t.invTxNoTx}</p>
            </div>
          ) : (
            <>
              <div
                className={`inventory-table-wrap inventory-transaction-table-wrap ${mobileView === 'list' ? 'inventory-mobile-table-active' : ''}`}
                style={s.tableWrap}
              >
                <table style={s.table}>
                  <thead>
                    <tr style={s.thead}>
                      <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColDate} sortKey="date" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} />
                      </th>
                      <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColType} sortKey="type" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType={isAdmin ? 'select' : null} filterValue={filters.type} onFilter={v => setFilter('type', v)} options={[{ value: '', label: t.invTxAllTypes }, ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))]} />
                      </th>
                      <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColItem} sortKey="item" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={filters.item_search} onFilter={v => setFilter('item_search', v)} suggestions={txSuggestions.items} placeholder={t.invItemOrSku} />
                      </th>
                      <th style={{ ...s.th, textAlign: 'right' }}>
                        <ColumnHeaderMenu label={t.invTxColQty} align="right" sortKey="quantity" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} />
                      </th>
                      <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColFrom} sortKey="from" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="select" filterValue={filters.from_location_id} onFilter={v => setFilter('from_location_id', v)} options={[{ value: '', label: t.invCycAllLocations }, ...activeLocations.map(l => ({ value: String(l.id), label: l.name }))]} />
                      </th>
                      <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColTo} sortKey="to" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="select" filterValue={filters.to_location_id} onFilter={v => setFilter('to_location_id', v)} options={[{ value: '', label: t.invCycAllLocations }, ...activeLocations.map(l => ({ value: String(l.id), label: l.name }))]} />
                      </th>
                      <th style={s.th}>
                        <ColumnHeaderMenu label={workLabel} sortKey="project" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType={projects?.length > 0 ? 'select' : null} filterValue={filters.project_id} onFilter={v => setFilter('project_id', v)} options={[{ value: '', label: `${t.invtxAllPrefix} ${workLabel.toLowerCase()}` }, ...(projects || []).filter(p => p.active !== false).map(p => ({ value: String(p.id), label: p.name }))]} />
                      </th>
                      {isAdmin && <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColSupplier} sortKey="supplier" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType={suppliers.length > 0 ? 'select' : null} filterValue={filters.supplier_id} onFilter={v => setFilter('supplier_id', v)} options={[{ value: '', label: t.invTxAllSuppliers }, ...suppliers.map(sup => ({ value: String(sup.id), label: sup.name }))]} />
                      </th>}
                      {isAdmin && <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColLot} sortKey="lot" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={filters.lot_number} onFilter={v => setFilter('lot_number', v)} suggestions={txSuggestions.lots} placeholder={t.invTxLotFilter} />
                      </th>}
                      {isAdmin && <th style={s.th}>
                        <ColumnHeaderMenu label={t.invTxColBy} sortKey="by" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={filters.by_search} onFilter={v => setFilter('by_search', v)} suggestions={txSuggestions.by} placeholder={t.invPerson} />
                      </th>}
                      <th style={s.th}>
                        <ColumnHeaderMenu label={t.notes} sortKey={null} activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={filters.notes_search} onFilter={v => setFilter('notes_search', v)} suggestions={txSuggestions.notes} placeholder={t.invNotesOrRef} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx, i) => {
                      const tc = TYPE_COLORS[tx.type] || TYPE_COLORS.adjust;
                      return (
                        <tr key={tx.id} style={i % 2 === 0 ? s.rowEven : s.row}>
                          <td style={{ ...s.td, whiteSpace: 'nowrap', color: '#6b7280', fontSize: 12 }}>
                            {new Date(tx.created_at).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </td>
                          <td style={s.td}>
                            <span style={{ ...s.badge, color: tc.color, background: tc.bg }}>{TYPE_LABELS[tx.type]}</span>
                          </td>
                          <td style={{ ...s.td, fontWeight: 600 }}>{tx.item_name}</td>
                          <td style={{ ...s.td, textAlign: 'right', fontWeight: 700 }}>
                            {formatQty(tx.quantity)} {tx.unit}
                          </td>
                          <td style={{ ...s.td, color: '#6b7280', fontSize: 13 }}>{tx.from_location_name || '—'}</td>
                          <td style={{ ...s.td, color: '#6b7280', fontSize: 13 }}>{tx.to_location_name || '—'}</td>
                          <td style={{ ...s.td, fontSize: 13 }}>{tx.project_name || '—'}</td>
                          {isAdmin && <td style={{ ...s.td, fontSize: 13, color: '#6b7280' }}>{tx.supplier_name || '—'}</td>}
                          {isAdmin && <td style={{ ...s.td, fontSize: 12, fontFamily: 'monospace', color: tx.lot_number ? '#374151' : '#9ca3af' }}>{tx.lot_number || '—'}</td>}
                          {isAdmin && <td style={{ ...s.td, fontSize: 13 }}>{tx.performed_by_name}</td>}
                          <td style={{ ...s.td, color: '#6b7280', fontSize: 13, maxWidth: 200 }}>{tx.notes || (tx.reference_no ? `${t.invtxRefPrefix} ${tx.reference_no}` : '—')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div
                style={s.mobileCards}
                className={`inventory-mobile-cards ${mobileView === 'list' ? 'inventory-mobile-cards-hidden' : ''}`}
              >
                {transactions.map(tx => {
                  const tc = TYPE_COLORS[tx.type] || TYPE_COLORS.adjust;
                  const movement = [tx.from_location_name || t.invtxOrigin, tx.to_location_name || t.invtxDestination].join(' -> ');
                  const details = [tx.supplier_name, tx.lot_number, tx.performed_by_name].filter(Boolean).join(' - ');
                  return (
                    <article key={tx.id} style={s.mobileCard}>
                      <div style={s.mobileCardTop}>
                        <span style={{ ...s.badge, color: tc.color, background: tc.bg }}>{TYPE_LABELS[tx.type]}</span>
                        <span style={s.mobileDate}>
                          {new Date(tx.created_at).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                      <div style={s.mobileTitleRow}>
                        <strong style={s.mobileCardTitle}>{tx.item_name}</strong>
                        <strong style={s.mobileQty}>{formatQty(tx.quantity)} {tx.unit}</strong>
                      </div>
                      <div style={s.mobileDetailGrid}>
                        <div>
                          <span style={s.mobileLabel}>{t.invtxMovement}</span>
                          <span style={s.mobileText}>{movement}</span>
                        </div>
                        {tx.project_name && (
                          <div>
                            <span style={s.mobileLabel}>{workLabel}</span>
                            <span style={s.mobileText}>{tx.project_name}</span>
                          </div>
                        )}
                        {isAdmin && details && (
                          <div>
                            <span style={s.mobileLabel}>{t.invtxDetails}</span>
                            <span style={s.mobileText}>{details}</span>
                          </div>
                        )}
                        {(tx.notes || tx.reference_no) && (
                          <div>
                            <span style={s.mobileLabel}>{t.invtxNotesLabel}</span>
                            <span style={s.mobileText}>{tx.notes || `${t.invtxRefPrefix} ${tx.reference_no}`}</span>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <div style={s.pagination}>
                <div style={s.paginationMeta}>
                  <span style={s.pageInfo}>{t.invtxShowing} {pageStart}-{pageEnd} {t.invtxOf} {total}</span>
                  <span style={s.pageInfo}>{t.invtxPage} {page + 1} {t.invtxOf} {pageCount}</span>
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
                      {TX_PAGE_SIZE_OPTIONS.map(size => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </label>
                  <div style={s.pageButtons}>
                    <button
                      style={{ ...s.pageBtn, ...(!canPrevPage ? s.pageBtnDisabled : {}) }}
                      disabled={!canPrevPage}
                      onClick={() => load(Math.max(0, page - 1))}
                    >
                      {t.invtxPrev}
                    </button>
                    <button
                      style={{ ...s.pageBtn, ...(!canNextPage ? s.pageBtnDisabled : {}) }}
                      disabled={!canNextPage}
                      onClick={() => load(page + 1)}
                    >
                      {t.invtxNext}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
    </div>
  );
}

const f = {
  form:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24, margin: 16 },
  titleRow:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20 },
  title:     { fontSize: 17, fontWeight: 700, color: '#111827', margin: 0 },
  closeBtn:  { border: '1px solid #d1d5db', background: '#fff', color: '#64748b', borderRadius: 8, width: 34, height: 34, fontSize: 16, cursor: 'pointer', flexShrink: 0 },
  error:     { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 14 },
  warning:   { background: '#fef3c7', color: '#92400e', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 14 },
  row:       { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field:     { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160, marginBottom: 14 },
  label:     { fontSize: 12, fontWeight: 600, color: '#374151' },
  hint:      { fontSize: 11, color: '#6b7280', fontWeight: 400 },
  input:     { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff', width: '100%', boxSizing: 'border-box' },
  binRow:    { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  binField:  { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 100 },
  actions:   { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  cancelBtn: { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  saveBtn:   { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  stockHint: { marginTop: 5, fontSize: 12, color: '#374151', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '5px 10px' },
};

const s = {
  wrap:        { padding: 16, minWidth: 0, maxWidth: '100%', overflowX: 'hidden' },
  formOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 150, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto' },
  formModal:   { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 720, marginTop: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' },
  toolbar:     { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, minWidth: 0, maxWidth: '100%' },
  select:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151' },
  searchInput: { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#374151', background: '#fff', minWidth: 220, flex: '1 1 240px' },
  dirBtn:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  dateWrap:    { display: 'flex', alignItems: 'center', gap: 5 },
  dateLabel:   { fontSize: 12, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' },
  dateInput:   { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#374151', background: '#fff' },
  clearDates:  { padding: '7px 11px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fee2e2', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  addBtn:      { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginLeft: 'auto', whiteSpace: 'nowrap' },
  mobileControls: { display: 'none' },
  mobileViewToggle: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, border: '1px solid #d1d5db', borderRadius: 9, background: '#f8fafc' },
  mobileViewBtn: { border: 'none', borderRadius: 7, padding: '8px 10px', background: 'transparent', color: '#64748b', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  mobileViewBtnActive: { background: '#fff', color: '#111827', boxShadow: '0 1px 3px rgba(15,23,42,0.12)' },
  error:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:       { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:   { fontSize: 40, marginBottom: 12 },
  tableWrap:   { overflowX: 'auto', maxWidth: '100%', minWidth: 0, borderRadius: 10, border: '1px solid #e5e7eb', paddingBottom: 12, scrollbarGutter: 'stable' },
  table:       { width: '100%', borderCollapse: 'collapse', minWidth: 700 },
  thead:       { background: '#f9fafb' },
  th:          { padding: '10px 12px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:         { borderBottom: '1px solid #f3f4f6' },
  rowEven:     { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:          { padding: '10px 12px', fontSize: 14, color: '#374151' },
  badge:       { display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700 },
  mobileCards: { display: 'none' },
  mobileCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  mobileCardTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  mobileDate: { fontSize: 12, color: '#64748b', fontWeight: 700, whiteSpace: 'nowrap' },
  mobileTitleRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start', marginBottom: 12 },
  mobileCardTitle: { fontSize: 16, color: '#111827', lineHeight: 1.25 },
  mobileQty: { fontSize: 16, color: '#111827', textAlign: 'right', whiteSpace: 'nowrap' },
  mobileDetailGrid: { display: 'grid', gridTemplateColumns: '1fr', gap: 8, paddingTop: 10, borderTop: '1px solid #f1f5f9' },
  mobileLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 },
  mobileText: { display: 'block', fontSize: 13, color: '#334155', lineHeight: 1.35 },
  pagination:  { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '10px 0 14px', minWidth: 0, maxWidth: '100%' },
  paginationMeta: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  paginationControls: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', minWidth: 0 },
  pageButtons: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, minWidth: 0 },
  pageInfo:    { fontSize: 13, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' },
  pageSizeLabel: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' },
  pageSizeSelect: { padding: '6px 9px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700 },
  pageBtn:     { padding: '7px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  pageBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
};
