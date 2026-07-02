import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useT } from '../../hooks/useT';
import { SkeletonList } from '../Skeleton';

const DEFAULT_UNITS = ['each', 'box', 'bag', 'bundle', 'pallet', 'lb', 'kg', 'ft', 'm', 'sq ft', 'gal', 'L', 'roll', 'sheet', 'piece', 'other'];

function SectionHeader({ children, count, warn }) {
  return (
    <div style={s.sectionHeader}>
      <span style={s.sectionTitle}>{children}</span>
      {count != null && (
        <span style={{ ...s.sectionBadge, ...(warn ? s.sectionBadgeWarn : s.sectionBadgeOk) }}>{count}</span>
      )}
    </div>
  );
}

export default function InventoryConversions({ onConversionChange }) {
  const t = useT();
  const [rows, setRows]       = useState([]);
  const [items, setItems]     = useState([]);
  const [units, setUnits]     = useState({ active: DEFAULT_UNITS, known: DEFAULT_UNITS });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [conversionSearch, setConversionSearch] = useState('');

  // Add form state
  const [addOpen, setAddOpen]         = useState(false);
  const [addItemId, setAddItemId]     = useState('');
  const [addUnit, setAddUnit]         = useState('each');
  const [addCustomUnit, setAddCustomUnit] = useState('');
  const [addSpec, setAddSpec]         = useState('');
  const [addFactor, setAddFactor]     = useState('');
  const [addSaving, setAddSaving]     = useState(false);
  const [addError, setAddError]       = useState('');

  // Inline edit state
  const [editingId, setEditingId]   = useState(null);
  const [editFactor, setEditFactor] = useState('');
  const [saving, setSaving]         = useState(false);
  const [saveErr, setSaveErr]       = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [conv, itemList, unitsRes] = await Promise.all([
        api.get('/inventory/uom-conversions'),
        api.get('/inventory/items?active=true'),
        api.get('/inventory/units'),
      ]);
      setRows(conv.data);
      setItems(itemList.data);
      setUnits(unitsRes.data);
    } catch { setError(t.invConvFailedLoad); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Add new conversion ───────────────────────────────────────────────────────

  const resetAdd = () => {
    setAddOpen(false); setAddItemId(''); setAddUnit('each');
    setAddCustomUnit(''); setAddSpec(''); setAddFactor(''); setAddError('');
  };

  const submitAdd = async () => {
    const unit = addUnit === 'other' ? addCustomUnit.trim() : addUnit;
    if (!addItemId) return setAddError(t.invConvSelectItemErr);
    if (!unit) return setAddError(t.invConvEnterUnitErr);
    const f = parseFloat(addFactor);
    if (!addFactor || isNaN(f) || f <= 0) return setAddError(t.invConvEnterFactorErr);
    setAddSaving(true); setAddError('');
    try {
      await api.post(`/inventory/items/${addItemId}/uoms`, {
        unit, unit_spec: addSpec.trim() || null, factor: f, is_base: false,
      });
      resetAdd();
      load();
      onConversionChange?.();
    } catch (err) {
      setAddError(err.response?.data?.error || t.invSetupFailedSave);
      setAddSaving(false);
    }
  };

  // ── Inline edit ─────────────────────────────────────────────────────────────

  const startEdit = (row) => {
    setEditingId(row.uom_id);
    setEditFactor(parseFloat(row.factor) === 1 ? '' : String(parseFloat(row.factor)));
    setSaveErr('');
  };

  const cancelEdit = () => { setEditingId(null); setSaveErr(''); };

  const saveEdit = async (row) => {
    const n = parseFloat(editFactor);
    if (!editFactor || isNaN(n) || n <= 0) { setSaveErr(t.invConvEnterPositive); return; }
    setSaving(true); setSaveErr('');
    try {
      await api.patch(`/inventory/items/${row.item_id}/uoms/${row.uom_id}`, { factor: n });
      setEditingId(null);
      load();
      onConversionChange?.();
    } catch (err) {
      setSaveErr(err.response?.data?.error || t.invSetupFailedSave);
    } finally { setSaving(false); }
  };

  // ── Split into pending (factor=1) vs configured ──────────────────────────────
  const conversionQuery = conversionSearch.trim().toLowerCase();
  const filteredRows = conversionQuery
    ? rows.filter(r => [
        r.item_name,
        r.sku,
        r.base_unit,
        r.unit,
        r.unit_spec,
        String(r.factor ?? ''),
      ].some(value => String(value || '').toLowerCase().includes(conversionQuery)))
    : rows;
  const pending    = filteredRows.filter(r => parseFloat(r.factor) === 1);
  const configured = filteredRows.filter(r => parseFloat(r.factor) !== 1);

  const renderRow = (row, i, isPending) => {
    const isEditing = editingId === row.uom_id;
    const factorNum = parseFloat(row.factor);
    const uomLabel  = row.unit + (row.unit_spec ? ` (${row.unit_spec})` : '');
    const meaning   = factorNum !== 1
      ? `1 ${row.unit} = ${factorNum % 1 === 0 ? factorNum.toFixed(0) : factorNum} ${row.base_unit}`
      : null;

    return (
      <tr key={row.uom_id} style={i % 2 === 0 ? s.rowEven : s.row}>
        <td style={{ ...s.td, fontWeight: 600 }}>{row.item_name}</td>
        <td style={{ ...s.td, color: '#6b7280' }}>{row.base_unit}</td>
        <td style={{ ...s.td, fontWeight: 600 }}>{uomLabel}</td>
        <td style={{ ...s.td, textAlign: 'center' }}>
          {isEditing ? (
            <input
              type="number" min="0.0001" step="any"
              value={editFactor}
              onChange={e => setEditFactor(e.target.value)}
              style={s.factorInput}
              autoFocus
              placeholder={t.invConvFactorPlaceholder}
              onKeyDown={e => { if (e.key === 'Enter') saveEdit(row); if (e.key === 'Escape') cancelEdit(); }}
            />
          ) : isPending ? (
            <span style={s.pendingBadge}>{t.invConvNotSet}</span>
          ) : (
            <span style={s.factorBadge}>{factorNum % 1 === 0 ? factorNum.toFixed(0) : factorNum}</span>
          )}
        </td>
        <td style={{ ...s.td, color: '#6b7280', fontSize: 13 }}>
          {isEditing
            ? (parseFloat(editFactor) > 0
                ? `1 ${row.unit} = ${parseFloat(editFactor) % 1 === 0 ? parseFloat(editFactor).toFixed(0) : parseFloat(editFactor)} ${row.base_unit}`
                : '-')
            : (meaning || <span style={{ color: '#d97706' }}>{t.invConvNeedsFactor}</span>)}
        </td>
        <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
          {isEditing ? (
            <>
              {saveErr && <span style={s.inlineErr}>{saveErr} </span>}
              <button style={{ ...s.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveEdit(row)} disabled={saving}>{saving ? t.saving : t.save}</button>
              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
            </>
          ) : (
            <button style={{ ...s.editBtn, ...(isPending ? s.editBtnPending : {}) }} onClick={() => startEdit(row)}>
              {isPending ? t.invConvSetFactor : t.invcvEdit}
            </button>
          )}
        </td>
      </tr>
    );
  };

  const tableHead = (
    <thead>
      <tr style={s.thead}>
        <th style={s.th}>{t.invTxColItem}</th>
        <th style={s.th}>{t.invConvColBase}</th>
        <th style={s.th}>{t.invConvColAlt}</th>
        <th style={{ ...s.th, textAlign: 'center' }}>{t.uomFactor}</th>
        <th style={s.th}>{t.invConvColMeaning}</th>
        <th style={s.th}></th>
      </tr>
    </thead>
  );

  const selectedItem = items.find(i => String(i.id) === String(addItemId));

  return (
    <div style={s.wrap}>

      {/* ── Add Conversion ──────────────────────────────────────────────────── */}
      <div style={s.addSection}>
        {!addOpen ? (
          <button style={s.addBtn} onClick={() => setAddOpen(true)}>{t.invConvAddBtn}</button>
        ) : (
          <div style={s.addForm}>
            <div style={s.addTitle}>{t.invConvFormTitle}</div>
            {addError && <div style={s.addError}>{addError}</div>}
            <div style={s.addRow}>
              <div style={s.addField}>
                <label htmlFor="ic-item" style={s.addLabel}>{t.invTxColItem} *</label>
                <select id="ic-item" style={s.addInput} value={addItemId} onChange={e => setAddItemId(e.target.value)}>
                  <option value="">{t.invTxSelectItem}</option>
                  {items.map(i => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
                </select>
                {selectedItem && <div style={s.baseUomNote}>{t.invConvBaseUnitNote} <strong>{selectedItem.unit}</strong></div>}
              </div>
              <div style={s.addField}>
                <label htmlFor="ic-unit" style={s.addLabel}>{t.invConvAltUnitLabel} *</label>
                <select id="ic-unit" style={s.addInput} value={addUnit} onChange={e => setAddUnit(e.target.value)}>
                  {units.active.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                {addUnit === 'other' && (
                  <input style={{ ...s.addInput, marginTop: 4 }} value={addCustomUnit}
                    onChange={e => setAddCustomUnit(e.target.value)} placeholder={t.invConvUnitNamePlaceholder} />
                )}
              </div>
              <div style={s.addField}>
                <label htmlFor="ic-spec" style={s.addLabel}>{t.invConvSpecLabel} <span style={s.optional}>({t.optional.toLowerCase()})</span></label>
                <input id="ic-spec" style={s.addInput} value={addSpec} onChange={e => setAddSpec(e.target.value)} placeholder={t.invConvSpecPlaceholder} />
              </div>
              <div style={s.addField}>
                <label htmlFor="ic-factor" style={s.addLabel}>
                  {t.invConvFactorLabel} * <span style={s.optional}>
                    {selectedItem ? `${t.invConvHowMany} ${selectedItem.unit} ${t.invConvPerOne} ${addUnit === 'other' ? (addCustomUnit || 'unit') : addUnit}` : ''}
                  </span>
                </label>
                <input id="ic-factor" style={s.addInput} type="number" min="0.0001" step="any"
                  value={addFactor} onChange={e => setAddFactor(e.target.value)} placeholder={t.invConvFactorPlaceholder} />
              </div>
            </div>
            <div style={s.addActions}>
              <button style={{ ...s.cancelBtn, ...(addSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={resetAdd} disabled={addSaving}>{t.cancel}</button>
              <button style={{ ...s.saveBtn, ...(addSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submitAdd} disabled={addSaving}>
                {addSaving ? t.saving : t.invConvSaveConversion}
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <div role="alert" style={s.errorMsg}>{error}</div>}
      {loading && <SkeletonList count={3} rows={1} />}

      {!loading && !error && (
        <>
          <div style={s.filterBar}>
            <input
              type="search"
              style={s.searchInput}
              value={conversionSearch}
              onChange={e => setConversionSearch(e.target.value)}
              placeholder={t.invcvSearchPlaceholder}
            />
            {conversionQuery && (
              <button style={s.clearBtn} onClick={() => setConversionSearch('')}>{t.invcvClear}</button>
            )}
          </div>
          <div style={s.filterMeta}>
            {conversionQuery
              ? `${t.invcvShowing} ${filteredRows.length} ${t.invcvOf} ${rows.length} ${t.invcvMatchingConversions}`
              : `${rows.length} ${t.invcvConversions}`}
          </div>
          {/* ── Needs Setup ───────────────────────────────────────────────── */}
          {pending.length > 0 && (
            <div style={s.section}>
              <SectionHeader count={pending.length} warn>{t.invConvNeedsSetup}</SectionHeader>
              <p style={s.sectionDesc}>{t.invConvNeedsSetupDesc}</p>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  {tableHead}
                  <tbody>{pending.map((row, i) => renderRow(row, i, true))}</tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Configured ────────────────────────────────────────────────── */}
          {configured.length > 0 && (
            <div style={s.section}>
              <SectionHeader count={configured.length}>{t.invConvConfigured}</SectionHeader>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  {tableHead}
                  <tbody>{configured.map((row, i) => renderRow(row, i, false))}</tbody>
                </table>
              </div>
            </div>
          )}

          {rows.length === 0 && (
            <div style={s.emptyState}>
              <p style={s.emptyTitle}>{t.invConvEmptyTitle}</p>
              <p style={s.emptySub}>{t.invConvEmptySub}</p>
            </div>
          )}
          {rows.length > 0 && filteredRows.length === 0 && (
            <div style={s.emptyState}>
              <p style={s.emptyTitle}>{t.invcvNoMatchTitle}</p>
              <p style={s.emptySub}>{t.invcvNoMatchSub}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const s = {
  wrap:           { padding: 16 },
  addSection:     { marginBottom: 20 },
  addBtn:         { padding: '9px 18px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  addForm:        { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 },
  addTitle:       { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 14 },
  addError:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 },
  addRow:         { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
  addField:       { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160 },
  addLabel:       { fontSize: 12, fontWeight: 600, color: '#374151' },
  optional:       { fontWeight: 400, color: '#6b7280', fontSize: 11 },
  addInput:       { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff', width: '100%', boxSizing: 'border-box' },
  baseUomNote:    { fontSize: 12, color: '#6b7280', marginTop: 4 },
  addActions:     { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  filterBar:      { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 6px' },
  searchInput:    { flex: '1 1 260px', minWidth: 220, padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#111827' },
  clearBtn:       { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer' },
  filterMeta:     { margin: '0 0 14px', fontSize: 13, color: '#6b7280' },
  section:        { marginBottom: 28 },
  sectionHeader:  { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  sectionTitle:   { fontSize: 14, fontWeight: 700, color: '#374151' },
  sectionBadge:   { display: 'inline-block', padding: '1px 9px', borderRadius: 10, fontSize: 12, fontWeight: 700 },
  sectionBadgeWarn: { background: '#fef3c7', color: '#b45309' },
  sectionBadgeOk:   { background: '#d1fae5', color: '#059669' },
  sectionDesc:    { fontSize: 13, color: '#6b7280', marginBottom: 12, lineHeight: 1.5 },
  error:          { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13 },
  errorMsg:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', margin: '0 0 16px', fontSize: 14 },
  empty:          { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyState:     { textAlign: 'center', padding: '48px 24px', color: '#6b7280' },
  emptyIcon:      { fontSize: 40, marginBottom: 12 },
  emptyTitle:     { fontSize: 16, fontWeight: 700, color: '#374151', margin: '0 0 8px' },
  emptySub:       { fontSize: 13, color: '#6b7280', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 },
  tableWrap:      { overflowX: 'auto', borderRadius: 10, border: '1px solid #e5e7eb' },
  table:          { width: '100%', borderCollapse: 'collapse', minWidth: 580 },
  thead:          { background: '#f9fafb' },
  th:             { padding: '10px 12px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:            { borderBottom: '1px solid #f3f4f6' },
  rowEven:        { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:             { padding: '10px 12px', fontSize: 14, color: '#374151' },
  factorBadge:    { display: 'inline-block', padding: '2px 10px', borderRadius: 10, fontSize: 13, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8' },
  pendingBadge:   { display: 'inline-block', padding: '2px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#fef3c7', color: '#b45309' },
  factorInput:    { width: 80, padding: '5px 8px', borderRadius: 6, border: '2px solid #3b82f6', fontSize: 14, fontWeight: 700, textAlign: 'center' },
  editBtn:        { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 4px' },
  editBtnPending: { padding: '5px 12px', borderRadius: 7, border: 'none', background: '#d97706', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  saveBtn:        { padding: '7px 14px', borderRadius: 7, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginRight: 4 },
  cancelBtn:      { padding: '7px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  inlineErr:      { fontSize: 12, color: '#dc2626', marginRight: 6 },
};
