import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';
import { parseBinQR } from './BinLabelModal';
import { parseItemQR } from './ItemLabelModal';
import UomConversionModal from './UomConversionModal';
import { useT } from '../../hooks/useT';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate } from '../../utils';
import { SkeletonList } from '../Skeleton';
import ModalShell from '../ModalShell';
import { labelSg, labelPl } from '../../companyLabels';

import { silentError } from '../../errorReporter';
function useCountTypes(t) {
  return {
    cycle:     { label: t.invCycCycleCount,     color: '#2563eb', bg: '#dbeafe',   desc: t.invCycCycleDesc },
    full:      { label: t.invCycFullCount,      color: '#8b5cf6', bg: '#ede9fe',   desc: t.invCycFullDesc },
    audit:     { label: t.invCycAuditCount,     color: '#d97706', bg: '#fef3c7',   desc: t.invCycAuditDesc },
    reconcile: { label: t.invCycReconcileCount, color: '#059669', bg: '#d1fae5',   desc: t.invCycReconcileDesc },
  };
}

function useStatusColors(t) {
  return {
    draft:       { color: '#6b7280', bg: '#f3f4f6', label: t.invCycDraft },
    in_progress: { color: '#2563eb', bg: '#dbeafe', label: t.invCycInProgress },
    completed:   { color: '#059669', bg: '#d1fae5', label: t.invCycCompleted },
  };
}

function TypeBadge({ type }) {
  const t = useT();
  const COUNT_TYPES = useCountTypes(t);
  const ct = COUNT_TYPES[type] || COUNT_TYPES.cycle;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700,
      color: ct.color, background: ct.bg, whiteSpace: 'nowrap' }}>
      {ct.label}
    </span>
  );
}

function formatLineStatus(status, t) {
  const map = {
    pending:         t.invccStatusPending,
    counted:         t.invccStatusCounted,
    needs_audit:     t.invccStatusNeedsAudit,
    audited:         t.invccStatusAudited,
    needs_reconcile: t.invccStatusNeedsReconcile,
    reconciled:      t.invccStatusReconciled,
    accepted:        t.invccStatusAccepted,
    overridden:      t.invccStatusOverridden,
  };
  if (!status || status === 'pending') return t.invccStatusPending;
  return map[status] || status
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function CycleCountDetail({ count, settings, onBack, onComplete }) {
  const t = useT();
  const { user } = useAuth();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const COUNT_TYPES = useCountTypes(t);
  const STATUS_COLORS = useStatusColors(t);
  const ROLE_LABELS = {
    counter:    t.invCycRoleCounter,
    auditor:    t.invCycRoleAuditor,
    reconciler: t.invCycRoleReconciler,
  };
  const ROLE_LABELS_PLURAL = {
    counter:    t.invCycRoleCounters,
    auditor:    t.invCycRoleAuditors,
    reconciler: t.invCycRoleReconcilers,
  };
  const [lines, setLines] = useState(count.lines || []);
  const [countData, setCountData] = useState(count);
  const [saving, setSaving] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reportLines, setReportLines] = useState(null); // non-null after completion
  // UOM support: per-line selected UOM and lazy-loaded item UOM lists
  const [lineUomSelections, setLineUomSelections] = useState({}); // { [lineId]: uomId | null }
  const [lineInputValues, setLineInputValues]     = useState({}); // { [lineId]: string }
  const [itemUomCache, setItemUomCache]           = useState({}); // { [itemId]: [uoms] }
  const [conversionPrompt, setConversionPrompt]   = useState(null); // { lineId, itemId, uom, baseUnit }
  // Workers + assignments
  const [workers, setWorkers] = useState(count.workers || []);
  const [assignments, setAssignments] = useState(count.assignments || []);
  const [tab, setTab] = useState('lines'); // 'lines' | 'workers'
  const [lineSearch, setLineSearch] = useState('');
  const [lineStatusFilter, setLineStatusFilter] = useState('');
  const [lineSort, setLineSort] = useState('default');
  const [allWorkers, setAllWorkers] = useState([]);
  const [workersLoaded, setWorkersLoaded] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [overrideModal, setOverrideModal] = useState(null); // { line }
  const [overrideQty, setOverrideQty] = useState('');
  const [overrideNotes, setOverrideNotes] = useState('');
  const [overriding, setOverriding] = useState(false);

  const fetchItemUoms = async (itemId) => {
    if (itemUomCache[itemId]) return;
    try {
      const r = await api.get(`/inventory/items/${itemId}/uoms`);
      setItemUomCache(prev => ({ ...prev, [itemId]: r.data.filter(u => u.active) }));
    } catch (err) { silentError('cycle-count-misc')(err); }
  };

  const loadAllWorkers = async () => {
    if (workersLoaded) return;
    try {
      const r = await api.get('/admin/workers');
      setAllWorkers(r.data || []);
      setWorkersLoaded(true);
    } catch (err) { silentError('cycle-count-misc')(err); }
  };

  const saveWorker = async (userId, roles) => {
    try {
      const r = await api.post(`/inventory/cycle-counts/${count.id}/workers`, { users: [{ user_id: userId, roles }] });
      setWorkers(r.data);
    } catch (e) { setSaveError(e.response?.data?.error || t.invCycFailedSaveWorker); }
  };

  const removeWorker = async (userId) => {
    try {
      await api.delete(`/inventory/cycle-counts/${count.id}/workers/${userId}`);
      setWorkers(prev => prev.filter(w => w.user_id !== userId));
    } catch (e) { setSaveError(e.response?.data?.error || t.invCycFailedRemoveWorker); }
  };

  const distribute = async () => {
    setDistributing(true);
    try {
      const r = await api.post(`/inventory/cycle-counts/${count.id}/distribute`);
      // Reload assignments
      const detail = await api.get(`/inventory/cycle-counts/${count.id}`);
      setAssignments(detail.data.assignments || []);
      setCountData(detail.data);
      if (r.data.assigned === 0) setSaveError(t.invCycNoLinesDistribute);
    } catch (e) { setSaveError(e.response?.data?.error || t.invCycFailedDistribute); }
    finally { setDistributing(false); }
  };

  const reopen = async () => {
    setReopening(true);
    try {
      await api.post(`/inventory/cycle-counts/${count.id}/reopen`);
      // Reload full detail so lines and assignments reflect the reset server state.
      // Without this, lines still show 'accepted' and the Complete button is immediately
      // enabled — clicking it produces a confusing 422 error from the server.
      const detail = await api.get(`/inventory/cycle-counts/${count.id}`);
      setCountData(detail.data);
      setLines(detail.data.lines || []);
      setAssignments(detail.data.assignments || []);
    } catch (e) { setError(e.response?.data?.error || t.invCycFailedReopen); }
    finally { setReopening(false); }
  };

  const submitOverride = async () => {
    if (!overrideModal) return;
    setOverriding(true);
    try {
      const r = await api.post(`/inventory/cycle-counts/${count.id}/lines/${overrideModal.line.id}/override`, {
        counted_qty: parseFloat(overrideQty),
        notes: overrideNotes,
      });
      setLines(prev => prev.map(l => l.id === overrideModal.line.id ? { ...l, ...r.data.line } : l));
      if (r.data.auto_completed) {
        setCountData(prev => ({ ...prev, status: 'completed' }));
        setReportLines(lines.map(l => l.id === overrideModal.line.id ? { ...l, ...r.data.line } : l));
      }
      setOverrideModal(null); setOverrideQty(''); setOverrideNotes('');
    } catch (e) { setSaveError(e.response?.data?.error || t.invCycFailedOverride); }
    finally { setOverriding(false); }
  };

  // ── Scan Mode ────────────────────────────────────────────────────────────────
  const [saveError, setSaveError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [uncountedMsg, setUncountedMsg] = useState('');
  const [scanMode, setScanMode] = useState(false);
  const [currentBin, setCurrentBin] = useState(null); // { type, id, name }
  const [highlightedId, setHighlightedId] = useState(null);
  const [scanFeedback, setScanFeedback] = useState(''); // success/error message
  const [useMobileLineCards, setUseMobileLineCards] = useState(false);
  const scanInputRef = useRef(null);
  const lineInputRefs = useRef({}); // { [lineId]: inputElement }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(max-width: 768px)');
    const update = () => setUseMobileLineCards(query.matches);
    update();
    if (query.addEventListener) {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  // Keep scan input focused whenever scan mode is on and nothing else is focused
  useEffect(() => {
    if (!scanMode) return;
    const refocus = () => {
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        scanInputRef.current?.focus();
      }
    };
    document.addEventListener('click', refocus);
    scanInputRef.current?.focus();
    return () => document.removeEventListener('click', refocus);
  }, [scanMode]);

  // Auto-focus line count input when a line is highlighted
  useEffect(() => {
    if (highlightedId != null) {
      const el = lineInputRefs.current[highlightedId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => el.focus(), 150);
      }
    }
  }, [highlightedId]);

  const showFeedback = (msg, isError = false) => {
    setScanFeedback({ msg, isError });
    setTimeout(() => setScanFeedback(''), 2500);
  };

  const processScan = (raw) => {
    const value = raw.trim();
    if (!value) return;

    // 1. Try to parse as bin QR code
    const bin = parseBinQR(value);
    if (bin) {
      setCurrentBin(bin);
      setHighlightedId(null);
      showFeedback(`${t.invCycBinSetFeedback} ${bin.name}`);
      return;
    }

    // 2. Try to parse as item QR code
    const itemQR = parseItemQR(value);
    if (itemQR) {
      const match = lines.find(l => l.item_id === itemQR.id);
      if (match) {
        setLineSearch('');
        setLineStatusFilter('');
        setHighlightedId(match.id);
        showFeedback(`${t.invCycFoundFeedback} ${match.item_name}`);
      } else {
        showFeedback(`"${itemQR.name}" ${t.invCycItemNotInCount}`, true);
      }
      return;
    }

    // 3. Try to match against item SKUs in the count lines
    const match = lines.find(l =>
      l.sku && l.sku.trim().toLowerCase() === value.toLowerCase()
    );
    if (match) {
      setLineSearch('');
      setLineStatusFilter('');
      setHighlightedId(match.id);
      showFeedback(`${t.invCycFoundFeedback} ${match.item_name}`);
    } else {
      showFeedback(`"${value}" ${t.invCycNotFoundInCount}`, true);
    }
  };

  const isAudit = countData.count_type === 'audit';
  const isFull  = countData.count_type === 'full';
  const isCompleted = countData.status === 'completed';
  const canShowExpected = !isAudit || isCompleted;

  const patchLine = async (line, countedQty, countedUomId) => {
    setSaving(line.id);
    try {
      const payload = { counted_qty: countedQty };
      // Always send counted_uom_id so the server can compute correct variance
      payload.counted_uom_id = countedUomId !== undefined ? countedUomId : (lineUomSelections[line.id] ?? null);
      const r = await api.patch(`/inventory/cycle-counts/${count.id}/lines/${line.id}`, payload);
      const updatedLine = r.data.line || r.data; // backwards-compat if server ever returns raw line
      setLines(prev => prev.map(l => l.id === line.id ? { ...l, ...updatedLine } : l));
      if (r.data.auto_completed) {
        setCountData(prev => ({ ...prev, status: 'completed' }));
        setReportLines(lines.map(l => l.id === line.id ? { ...l, ...updatedLine } : l));
      }
    } catch (e) {
      setSaveError(e.response?.data?.error || t.invCycFailedSave);
    } finally {
      setSaving(null);
    }
  };

  const advanceStatus = async () => {
    setStatusError('');
    try {
      const r = await api.patch(`/inventory/cycle-counts/${count.id}`, { status: 'in_progress' });
      setCountData(r.data);
    } catch (e) { setStatusError(e.response?.data?.error || t.invCycFailedStatus); }
  };

  const complete = async () => {
    setCompleting(true); setError('');
    try {
      await api.post(`/inventory/cycle-counts/${count.id}/complete`);
      setConfirmOpen(false);
      setCountData(prev => ({ ...prev, status: 'completed' }));
      setReportLines(lines); // show variance report
    } catch (e) {
      // Keep the confirm dialog open so the admin can retry; show error above it
      setError(e.response?.data?.error || t.invCycFailedComplete);
    } finally {
      setCompleting(false);
    }
  };

  const downloadVarianceCSV = (reportData) => {
    const header = [t.invCycColItem, t.invCycColSku, t.invCycColUnit, t.invCycColExpected, t.invCycColCounted, t.invCycColVariance];
    const rows = reportData.map(l => {
      const expected = parseFloat(l.expected_qty);
      const counted  = l.counted_qty != null ? parseFloat(l.counted_qty) : '';
      const variance = l.variance != null ? l.variance : (counted !== '' ? counted - expected : '');
      return [
        `"${l.item_name.replace(/"/g, '""')}"`,
        l.sku || '',
        l.unit,
        expected,
        counted,
        variance,
      ].join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `variance-report-${count.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const FINAL_LINE_STATUSES = ['accepted', 'reconciled', 'overridden', 'audited'];
  const uncounted = lines.filter(l => !FINAL_LINE_STATUSES.includes(l.line_status)).length;
  const countedLineCount = Math.max(0, lines.length - uncounted);
  const progressPct = lines.length > 0 ? Math.round((countedLineCount / lines.length) * 100) : 0;
  const getLineVariance = (line) => {
    if (line.counted_qty === null || line.counted_qty === undefined) return null;
    const fallback = parseFloat(line.counted_qty) - parseFloat(line.expected_qty);
    const value = parseFloat(line.variance ?? fallback);
    return Number.isNaN(value) ? null : value;
  };
  const lineMatchesFilter = (line) => {
    const search = lineSearch.trim().toLowerCase();
    const text = [
      line.item_name,
      line.sku,
      line.unit,
      line.stock_uom_unit,
      line.counted_by_name,
      line.location_name,
      line.line_status,
    ].filter(Boolean).join(' ').toLowerCase();
    const status = line.line_status || 'pending';
    const isFinal = FINAL_LINE_STATUSES.includes(status);
    const variance = getLineVariance(line);
    const statusMatch =
      !lineStatusFilter ||
      (lineStatusFilter === 'remaining' && !isFinal) ||
      (lineStatusFilter === 'finished' && isFinal) ||
      (lineStatusFilter === 'not_counted' && (line.counted_qty === null || line.counted_qty === undefined)) ||
      (lineStatusFilter === 'with_variance' && canShowExpected && variance !== null && variance !== 0) ||
      lineStatusFilter === status;

    return (!search || text.includes(search)) && statusMatch;
  };
  const sortLines = (sourceLines) => {
    if (lineSort === 'default') return sourceLines;
    const copy = [...sourceLines];
    copy.sort((a, b) => {
      if (lineSort === 'item') return (a.item_name || '').localeCompare(b.item_name || '');
      if (lineSort === 'status') return (a.line_status || 'pending').localeCompare(b.line_status || 'pending') || (a.item_name || '').localeCompare(b.item_name || '');
      if (lineSort === 'counter') return (a.counted_by_name || '').localeCompare(b.counted_by_name || '') || (a.item_name || '').localeCompare(b.item_name || '');
      if (lineSort === 'variance') {
        const av = Math.abs(getLineVariance(a) ?? -1);
        const bv = Math.abs(getLineVariance(b) ?? -1);
        return bv - av || (a.item_name || '').localeCompare(b.item_name || '');
      }
      return 0;
    });
    return copy;
  };
  const visibleLines = sortLines(lines.filter(lineMatchesFilter));
  const hasLineFilter = lineSearch.trim() || lineStatusFilter || lineSort !== 'default';
  const variantLines = lines.filter(l => {
    if (l.counted_qty === null || l.counted_qty === undefined) return false;
    return getLineVariance(l) !== 0;
  });
  const sc = STATUS_COLORS[countData.status] || STATUS_COLORS.draft;

  // Group lines by location for full counts
  const groupedLines = isFull
    ? visibleLines.reduce((acc, line) => {
        const loc = line.location_name || t.invCycUnknownLocation;
        if (!acc[loc]) acc[loc] = [];
        acc[loc].push(line);
        return acc;
      }, {})
    : null;

  const renderLine = (line, i) => {
    const counted = line.counted_qty !== null && line.counted_qty !== undefined;
    // variance is now stored in stock UOM units by the server
    const variance = line.variance != null ? parseFloat(line.variance) : null;
    const showExpected = !isAudit || isCompleted;
    const isHighlighted = highlightedId === line.id;
    const rowStyle = isHighlighted
      ? { ...d.row, background: '#fef9c3', outline: '2px solid #f59e0b' }
      : i % 2 === 0 ? d.rowEven : d.row;

    // UOM resolution
    const stockUnit      = line.stock_uom_unit  || line.unit;  // unit of the expected qty
    const stockUomId     = line.stock_uom_id    || null;
    const stockFactor    = parseFloat(line.stock_uom_factor  || 1);
    const availableUoms  = itemUomCache[line.item_id] || [];
    const selectedUomId  = lineUomSelections[line.id] !== undefined
      ? lineUomSelections[line.id] : stockUomId;
    const selectedUom    = availableUoms.find(u => u.id === selectedUomId);
    const selectedUnit   = selectedUom ? `${selectedUom.unit}${selectedUom.unit_spec ? ` (${selectedUom.unit_spec})` : ''}` : stockUnit;
    const isDifferentUom = selectedUomId !== stockUomId;

    // Conversion hint: show what the current input value converts to in stock units
    const inputVal = lineInputValues[line.id];
    let conversionHint = null;
    if (isDifferentUom && inputVal !== undefined && inputVal !== '') {
      const n = parseFloat(inputVal);
      if (!isNaN(n) && selectedUom) {
        const countedFactor = parseFloat(selectedUom.factor || 1);
        const inStockUnits = n * (countedFactor / stockFactor);
        conversionHint = `= ${inStockUnits % 1 === 0 ? inStockUnits.toFixed(0) : inStockUnits.toFixed(3).replace(/\.?0+$/, '')} ${stockUnit}`;
      }
    }

    return (
      <tr key={line.id} id={`ccline-${line.id}`} style={rowStyle}>
        <td style={{ ...d.td, fontWeight: 600 }}>{line.item_name}</td>
        <td style={{ ...d.td, fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{line.sku || '—'}</td>
        <td style={{ ...d.td, color: '#6b7280' }}>{stockUnit}</td>
        {showExpected && (
          <td style={{ ...d.td, textAlign: 'right' }}>{parseFloat(line.expected_qty)}</td>
        )}
        <td style={{ ...d.td }}>
          {!isCompleted ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  ref={el => { lineInputRefs.current[line.id] = el; }}
                  style={{ ...d.countInput, ...(isHighlighted ? { borderColor: '#f59e0b', boxShadow: '0 0 0 2px #fde68a' } : {}) }}
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={counted ? line.counted_qty : ''}
                  placeholder="—"
                  disabled={saving === line.id}
                  onChange={e => setLineInputValues(prev => ({ ...prev, [line.id]: e.target.value }))}
                  onFocus={() => { if (!itemUomCache[line.item_id]) fetchItemUoms(line.item_id); }}
                  onBlur={e => {
                    const val = e.target.value;
                    if (val !== '' && val !== String(line.counted_qty)) patchLine(line, parseFloat(val));
                    if (scanMode) setTimeout(() => scanInputRef.current?.focus(), 50);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.target.blur(); setHighlightedId(null); }
                  }}
                />
                {/* UOM selector — only shown if item has alternate UOMs */}
                {availableUoms.length > 1 && (
                  <select
                    style={d.uomSelect}
                    value={selectedUomId ?? ''}
                    onChange={e => {
                      const newUomId = e.target.value ? parseInt(e.target.value) : null;
                      setLineUomSelections(prev => ({ ...prev, [line.id]: newUomId }));
                      // Check if conversion factor needs to be set
                      const newUom = availableUoms.find(u => u.id === newUomId);
                      if (newUom && !newUom.is_base && parseFloat(newUom.factor) === 1) {
                        setConversionPrompt({ lineId: line.id, itemId: line.item_id, uom: newUom, baseUnit: stockUnit });
                      }
                      // If a qty is already entered, re-patch with new UOM
                      const inputEl = lineInputRefs.current[line.id];
                      if (inputEl && inputEl.value !== '') {
                        patchLine(line, parseFloat(inputEl.value), newUomId);
                      }
                    }}
                  >
                    {availableUoms.map(u => (
                      <option key={u.id} value={u.id}>
                        {u.unit}{u.unit_spec ? ` (${u.unit_spec})` : ''}{u.is_base ? ` — ${t.invTxBaseUnit}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {conversionHint && (
                <span style={{ fontSize: 11, color: '#6b7280' }}>{conversionHint}</span>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'right' }}>
              <span>{counted ? parseFloat(line.counted_qty) : '—'}</span>
              {line.counted_uom_unit && line.counted_uom_unit !== stockUnit && (
                <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 4 }}>{line.counted_uom_unit}</span>
              )}
            </div>
          )}
        </td>
        {showExpected && (
          <td style={{ ...d.td, textAlign: 'right', fontWeight: variance !== null && variance !== 0 ? 700 : 400,
            color: variance === null ? '#9ca3af' : variance > 0 ? '#059669' : variance < 0 ? '#dc2626' : '#374151' }}>
            {variance === null ? '—' : `${variance > 0 ? '+' : ''}${variance % 1 === 0 ? variance.toFixed(0) : variance.toFixed(3).replace(/\.?0+$/, '')} ${stockUnit}`}
          </td>
        )}
        <td style={{ ...d.td, fontSize: 13, color: '#6b7280' }}>{line.counted_by_name || '—'}</td>
        <td style={d.td}>
          {line.line_status && line.line_status !== 'pending' && (
            <span style={{ ...d.lineStatusBadge, ...lineStatusStyle(line.line_status) }}>
              {formatLineStatus(line.line_status, t)}
            </span>
          )}
        </td>
        {!isCompleted && (
          <td style={d.td}>
            <button style={d.overrideBtn} onClick={() => { setOverrideModal({ line }); setOverrideQty(line.counted_qty != null ? String(line.counted_qty) : ''); setOverrideNotes(''); }}>
              {t.invCycOverride}
            </button>
          </td>
        )}
      </tr>
    );
  };

  const renderTableHead = (showExpected) => (
    <thead>
      <tr style={d.thead}>
        <th style={d.th}>{t.invCycColItem}</th>
        <th style={d.th}>{t.invCycColSku}</th>
        <th style={d.th}>{t.invCycColUnit}</th>
        {showExpected && <th style={{ ...d.th, textAlign: 'right' }}>{t.invCycColExpected}</th>}
        <th style={{ ...d.th, textAlign: 'right' }}>{t.invCycColCounted}</th>
        {showExpected && <th style={{ ...d.th, textAlign: 'right' }}>{t.invCycColVariance}</th>}
        <th style={d.th}>{t.invCycColCountedBy}</th>
        <th style={d.th}>{t.invCycColStatus}</th>
        {!isCompleted && <th style={d.th} />}
      </tr>
    </thead>
  );

  const renderLineCard = (line) => {
    const counted = line.counted_qty !== null && line.counted_qty !== undefined;
    const variance = line.variance != null ? parseFloat(line.variance) : null;
    const showExpected = !isAudit || isCompleted;
    const isHighlighted = highlightedId === line.id;
    const stockUnit      = line.stock_uom_unit  || line.unit;
    const stockUomId     = line.stock_uom_id    || null;
    const stockFactor    = parseFloat(line.stock_uom_factor || 1);
    const availableUoms  = itemUomCache[line.item_id] || [];
    const selectedUomId  = lineUomSelections[line.id] !== undefined
      ? lineUomSelections[line.id] : stockUomId;
    const selectedUom    = availableUoms.find(u => u.id === selectedUomId);
    const isDifferentUom = selectedUomId !== stockUomId;
    const inputVal = lineInputValues[line.id];
    let conversionHint = null;
    if (isDifferentUom && inputVal !== undefined && inputVal !== '' && selectedUom) {
      const n = parseFloat(inputVal);
      if (!isNaN(n)) {
        const countedFactor = parseFloat(selectedUom.factor || 1);
        const inStockUnits = n * (countedFactor / stockFactor);
        conversionHint = `= ${inStockUnits % 1 === 0 ? inStockUnits.toFixed(0) : inStockUnits.toFixed(3).replace(/\.?0+$/, '')} ${stockUnit}`;
      }
    }

    return (
      <article key={line.id} id={`ccline-card-${line.id}`} style={{ ...d.mobileLineCard, ...(isHighlighted ? d.mobileLineCardHighlighted : {}) }}>
        <div style={d.mobileLineCardTop}>
          <div>
            <strong style={d.mobileLineTitle}>{line.item_name}</strong>
            <span style={d.mobileLineMeta}>{[line.sku, stockUnit].filter(Boolean).join(' - ') || stockUnit}</span>
          </div>
          {line.line_status && line.line_status !== 'pending' && (
            <span style={{ ...d.lineStatusBadge, ...lineStatusStyle(line.line_status) }}>
              {formatLineStatus(line.line_status, t)}
            </span>
          )}
        </div>

        {showExpected && (
          <div style={d.mobileLineStats}>
            <div>
              <span style={d.mobileLineLabel}>{t.invCycColExpected}</span>
              <strong>{parseFloat(line.expected_qty)} {stockUnit}</strong>
            </div>
            <div>
              <span style={d.mobileLineLabel}>{t.invCycColVariance}</span>
              <strong style={{
                color: variance === null ? '#64748b' : variance > 0 ? '#059669' : variance < 0 ? '#dc2626' : '#334155',
              }}>
                {variance === null ? '-' : `${variance > 0 ? '+' : ''}${variance % 1 === 0 ? variance.toFixed(0) : variance.toFixed(3).replace(/\.?0+$/, '')} ${stockUnit}`}
              </strong>
            </div>
          </div>
        )}

        <div style={d.mobileCountField}>
          <label style={d.mobileLineLabel}>{t.invCycColCounted}</label>
          {!isCompleted ? (
            <>
              <div style={d.mobileCountInputRow}>
                <input
                  ref={el => { lineInputRefs.current[line.id] = el; }}
                  style={{ ...d.countInput, width: '100%', textAlign: 'left', ...(isHighlighted ? { borderColor: '#f59e0b', boxShadow: '0 0 0 2px #fde68a' } : {}) }}
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={counted ? line.counted_qty : ''}
                  placeholder="-"
                  disabled={saving === line.id}
                  onChange={e => setLineInputValues(prev => ({ ...prev, [line.id]: e.target.value }))}
                  onFocus={() => { if (!itemUomCache[line.item_id]) fetchItemUoms(line.item_id); }}
                  onBlur={e => {
                    const val = e.target.value;
                    if (val !== '' && val !== String(line.counted_qty)) patchLine(line, parseFloat(val));
                    if (scanMode) setTimeout(() => scanInputRef.current?.focus(), 50);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.target.blur(); setHighlightedId(null); }
                  }}
                />
                {availableUoms.length > 1 && (
                  <select
                    style={{ ...d.uomSelect, minWidth: 104 }}
                    value={selectedUomId ?? ''}
                    onChange={e => {
                      const newUomId = e.target.value ? parseInt(e.target.value) : null;
                      setLineUomSelections(prev => ({ ...prev, [line.id]: newUomId }));
                      const newUom = availableUoms.find(u => u.id === newUomId);
                      if (newUom && !newUom.is_base && parseFloat(newUom.factor) === 1) {
                        setConversionPrompt({ lineId: line.id, itemId: line.item_id, uom: newUom, baseUnit: stockUnit });
                      }
                      const inputEl = lineInputRefs.current[line.id];
                      if (inputEl && inputEl.value !== '') {
                        patchLine(line, parseFloat(inputEl.value), newUomId);
                      }
                    }}
                  >
                    {availableUoms.map(u => (
                      <option key={u.id} value={u.id}>
                        {u.unit}{u.unit_spec ? ` (${u.unit_spec})` : ''}{u.is_base ? ` - ${t.invTxBaseUnit}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {conversionHint && <span style={d.mobileHint}>{conversionHint}</span>}
            </>
          ) : (
            <strong>{counted ? parseFloat(line.counted_qty) : '-'} {line.counted_uom_unit && line.counted_uom_unit !== stockUnit ? line.counted_uom_unit : stockUnit}</strong>
          )}
        </div>

        <div style={d.mobileLineFooter}>
          <span>{t.invCycColCountedBy}: {line.counted_by_name || '-'}</span>
          {!isCompleted && (
            <button style={d.overrideBtn} onClick={() => { setOverrideModal({ line }); setOverrideQty(line.counted_qty != null ? String(line.counted_qty) : ''); setOverrideNotes(''); }}>
              {t.invCycOverride}
            </button>
          )}
        </div>
      </article>
    );
  };

  const showExpected = canShowExpected;

  return (
    <div style={d.wrap}>
      <button style={d.back} onClick={onBack}>{t.invCycBackToList}</button>

      <div style={d.header}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={d.title}>{COUNT_TYPES[countData.count_type]?.label || t.invCycCountLabel} — {countData.location_name}</h2>
            <TypeBadge type={countData.count_type} />
          </div>
          <p style={d.sub}>{t.invCycStartedBy} {countData.started_by_name} - {formatDate(countData.started_at, user?.language)}</p>
          {isAudit && !isCompleted && (
            <p style={{ ...d.sub, color: '#d97706', fontWeight: 600, marginTop: 4 }}>
              {t.invCycAuditMode}
            </p>
          )}
          <div style={d.detailProgress}>
            <div style={d.detailProgressTop}>
              <strong>{countedLineCount}/{lines.length} {t.invCycItemsCounted}</strong>
              <span>{isCompleted ? t.invCycCompleted : `${uncounted} ${t.invccRemaining}`}</span>
            </div>
            <div style={d.detailProgressBar}>
              <div style={{ ...d.detailProgressFill, width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
        <div className="inventory-count-header-actions" style={d.headerRight}>
          <span style={{ ...d.statusBadge, color: sc.color, background: sc.bg }}>{sc.label}</span>
          {countData.status === 'draft' && (
            <button style={d.advanceBtn} onClick={advanceStatus}>{t.invCycStartCounting}</button>
          )}
          {countData.status === 'in_progress' && (
            <>
              <button
                style={{ ...d.scanModeBtn, ...(scanMode ? d.scanModeBtnActive : {}) }}
                onClick={() => { setScanMode(s => !s); setHighlightedId(null); setCurrentBin(null); }}
              >
                {scanMode ? t.invCycScanModeOn : t.invCycScanMode}
              </button>
              <button
                style={{ ...d.completeBtn, opacity: uncounted > 0 ? 0.5 : 1 }}
                onClick={() => uncounted > 0 ? setUncountedMsg(`${uncounted} ${t.invCycItemsNotCounted}`) : setConfirmOpen(true)}
              >
                {t.invCycCompleteCount}
              </button>
            </>
          )}
          {countData.status === 'completed' && (
            <button style={{ ...d.advanceBtn, background: '#6b7280', ...(reopening ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={reopen} disabled={reopening}>
              {reopening ? t.invCycReopening : t.invCycReopenCount}
            </button>
          )}
        </div>
      </div>

      {saveError && <div style={d.error}>{saveError}</div>}
      {statusError && <div style={d.error}>{statusError}</div>}
      {uncountedMsg && <div style={d.warnMsg}>{uncountedMsg}</div>}
      {error && <div role="alert" style={d.error}>{error}</div>}

      {/* ── Tab Navigation ── */}
      <div className="inventory-count-tabs" style={d.tabRow}>
        <button style={{ ...d.tab, ...(tab === 'lines' ? d.tabActive : {}) }} onClick={() => setTab('lines')}>
          {t.invCycTabLines} ({hasLineFilter ? `${visibleLines.length}/${lines.length}` : lines.length})
        </button>
        <button style={{ ...d.tab, ...(tab === 'workers' ? d.tabActive : {}) }}
          onClick={() => { setTab('workers'); loadAllWorkers(); }}>
          {workerPlural} ({workers.length})
        </button>
      </div>

      {/* ── Workers Panel ── */}
      {tab === 'workers' && (
        <div style={d.workersPanel}>
          <div className="inventory-count-workers-header" style={d.workersPanelHeader}>
            <strong style={{ fontSize: 14 }}>{t.invccAssign} {workerPlural.toLowerCase()}</strong>
            {!isCompleted && (
              <button style={{ ...d.distributeBtn, ...(distributing || workers.filter(w => w.roles.includes('counter')).length === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={distribute} disabled={distributing || workers.filter(w => w.roles.includes('counter')).length === 0}>
                {distributing ? t.invCycDistributing : t.invCycDistributeLines}
              </button>
            )}
          </div>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
            {t.invccAssignHelp}
          </p>

          {/* Existing assigned workers */}
          {workers.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {workers.map(w => (
                <div key={w.user_id} className="inventory-count-worker-row" style={d.workerRow}>
                  <span style={d.workerName}>{w.full_name}</span>
                  <div className="inventory-count-roles" style={d.rolesRow}>
                    {['counter', 'auditor', 'reconciler'].map(role => (
                      <label key={role} style={d.roleLabel}>
                        <input type="checkbox" style={{ marginRight: 4 }}
                          checked={w.roles.includes(role)}
                          disabled={isCompleted}
                          onChange={e => {
                            const newRoles = e.target.checked
                              ? [...w.roles, role]
                              : w.roles.filter(r => r !== role);
                            saveWorker(w.user_id, newRoles);
                          }}
                        />
                        {ROLE_LABELS[role] || role}
                      </label>
                    ))}
                  </div>
                  {!isCompleted && (
                    <button className="inventory-count-remove-worker" style={d.removeWorkerBtn} onClick={() => removeWorker(w.user_id)}>{t.invccRemove} {workerLabel.toLowerCase()}</button>
                  )}
                </div>
              ))}
            </div>
          )}

                  {/* Add team member from company list */}
          {!isCompleted && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '0 0 6px' }}>{t.invccAdd} {workerLabel.toLowerCase()}</p>
              <select style={d.workerSelect}
                value=""
                onChange={e => {
                  const uid = parseInt(e.target.value);
                  if (!uid) return;
                  if (workers.find(w => w.user_id === uid)) return;
                  saveWorker(uid, ['counter']);
                }}>
                <option value="">{t.invccSelect} {workerLabel.toLowerCase()}...</option>
                {allWorkers
                  .filter(w => !workers.find(x => x.user_id === w.id))
                  .map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
              </select>
            </div>
          )}

          {/* Assignment summary by line */}
          {assignments.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '0 0 8px' }}>{t.invCycLineAssignments} ({assignments.length})</p>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {(['counter', 'auditor', 'reconciler']).map(role => {
                  const roleAssignments = assignments.filter(a => a.role === role);
                  if (roleAssignments.length === 0) return null;
                  const byWorker = roleAssignments.reduce((acc, a) => {
                    const key = a.worker_name;
                    acc[key] = (acc[key] || 0) + 1;
                    return acc;
                  }, {});
                  return (
                    <div key={role} style={{ marginBottom: 8 }}>
                      <strong>{ROLE_LABELS_PLURAL[role] || role}</strong>{' '}
                      {Object.entries(byWorker).map(([name, cnt]) => `${name} (${cnt})`).join(' · ')}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Scan Panel ── */}
      {scanMode && (
        <div style={d.scanPanel}>
          <div className="inventory-count-scan-bin-row" style={d.scanBinRow}>
            <span style={d.scanBinLabel}>
        {currentBin
          ? <><strong>{currentBin.name}</strong> <span style={{ color: '#6b7280', fontSize: 12 }}>({currentBin.type})</span></>
          : <span style={{ color: '#6b7280' }}>{t.invCycNoBinScanned}</span>
        }
            </span>
            {currentBin && (
              <button style={d.scanClearBtn} onClick={() => setCurrentBin(null)}>{t.invCycClearBin}</button>
            )}
          </div>
          <div className="inventory-count-scan-input-row" style={d.scanInputRow}>
            <input
              ref={scanInputRef}
              style={d.scanInput}
              type="text"
              placeholder={t.invCycScanPlaceholder}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  processScan(e.target.value);
                  e.target.value = '';
                }
              }}
              onChange={() => {}} // controlled by ref
            />
          </div>
          {scanFeedback && (
            <div style={{ ...d.scanFeedback, color: scanFeedback.isError ? '#dc2626' : '#059669',
              background: scanFeedback.isError ? '#fee2e2' : '#d1fae5' }}>
              {scanFeedback.msg}
            </div>
          )}
          <p style={d.scanHint}>{t.invCycScanHint}</p>
        </div>
      )}

      {tab === 'lines' && lines.length > 0 && (
        <>
          <div className="inventory-count-line-filters" style={d.lineFilters}>
            <input
              type="search"
              value={lineSearch}
              onChange={e => setLineSearch(e.target.value)}
              placeholder={t.invccLineSearchPlaceholder}
              style={d.lineFilterInput}
            />
            <select
              value={lineStatusFilter}
              onChange={e => setLineStatusFilter(e.target.value)}
              style={d.lineFilterSelect}
            >
              <option value="">{t.invccFilterAllLines}</option>
              <option value="remaining">{t.invccFilterRemaining}</option>
              <option value="finished">{t.invccFilterFinished}</option>
              <option value="not_counted">{t.invccFilterNotCounted}</option>
              {showExpected && <option value="with_variance">{t.invccFilterHasVariance}</option>}
              <option value="pending">{t.invccStatusPending}</option>
              <option value="counted">{t.invccStatusCounted}</option>
              <option value="needs_audit">{t.invccStatusNeedsAudit}</option>
              <option value="needs_reconcile">{t.invccStatusNeedsReconcile}</option>
              <option value="accepted">{t.invccStatusAccepted}</option>
              <option value="overridden">{t.invccStatusOverridden}</option>
              <option value="audited">{t.invccStatusAudited}</option>
            </select>
            <select
              value={lineSort}
              onChange={e => setLineSort(e.target.value)}
              style={d.lineFilterSelect}
            >
              <option value="default">{t.invccSortDefault}</option>
              <option value="item">{t.invccSortItem}</option>
              <option value="status">{t.invccSortStatus}</option>
              <option value="counter">{t.invccSortCounter}</option>
              {showExpected && <option value="variance">{t.invccSortVariance}</option>}
            </select>
            {hasLineFilter && (
              <button
                type="button"
                style={d.lineFilterClear}
                onClick={() => { setLineSearch(''); setLineStatusFilter(''); setLineSort('default'); }}
              >
                {t.invccClear}
              </button>
            )}
          </div>
          {hasLineFilter && (
            <p style={d.filterCount}>
              {t.invccShowing} {visibleLines.length} {t.invccOf} {lines.length} {t.invccCountLines}
            </p>
          )}
        </>
      )}

      {tab === 'lines' && lines.length === 0 ? (
        <div style={d.empty}>{t.invCycNoItems}</div>
      ) : tab === 'lines' && visibleLines.length === 0 ? (
        <div style={d.empty}>{t.invccNoLinesMatch}</div>
      ) : tab === 'lines' && isFull ? (
        // Full count: render grouped lines by location
        Object.entries(groupedLines).map(([locName, locLines]) => (
          <div key={locName} style={{ marginBottom: 24 }}>
            <div style={d.locationHeader}>{locName}</div>
            {useMobileLineCards ? (
              <div style={d.mobileLineList}>
                {locLines.map(line => renderLineCard(line))}
              </div>
            ) : (
              <div className="inventory-count-table-wrap" style={d.tableWrap}>
                <table style={d.table}>
                  {renderTableHead(showExpected)}
                  <tbody>{locLines.map((line, i) => renderLine(line, i))}</tbody>
                </table>
              </div>
            )}
          </div>
        ))
      ) : tab === 'lines' ? (
        useMobileLineCards ? (
          <div style={d.mobileLineList}>
            {visibleLines.map(line => renderLineCard(line))}
          </div>
        ) : (
          <div className="inventory-count-table-wrap" style={d.tableWrap}>
            <table style={d.table}>
              {renderTableHead(showExpected)}
              <tbody>{visibleLines.map((line, i) => renderLine(line, i))}</tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === 'lines' && uncounted > 0 && countData.status === 'in_progress' && (
        <p style={d.uncountedNote}>{uncounted} {t.invCycItemsNotCounted}</p>
      )}

      {reportLines && (
        <div style={d.modalOverlay}>
          <ModalShell
            onClose={() => { setReportLines(null); onComplete(); }}
            titleId="cyc-variance-title"
            className="inventory-count-modal"
            style={{ ...d.modal, maxWidth: 560 }}
          >
            <h3 id="cyc-variance-title" style={d.modalTitle}>{t.invCycVarianceReport}</h3>
            {(() => {
              const withVariance = reportLines.filter(l => {
                if (l.counted_qty == null) return false;
                return parseFloat(l.variance ?? (parseFloat(l.counted_qty) - parseFloat(l.expected_qty))) !== 0;
              });
              const noVariance = reportLines.filter(l => {
                if (l.counted_qty == null) return true;
                return parseFloat(l.variance ?? (parseFloat(l.counted_qty) - parseFloat(l.expected_qty))) === 0;
              });
              return (
                <>
                  <p style={d.modalBody}>
                    {withVariance.length === 0
                      ? t.invCycNoVariances
                      : `${withVariance.length} ${t.invCycWithVariance} ${noVariance.length} ${t.invCycMatched}`}
                  </p>
                  <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb' }}>
                          <th style={d.rth}>{t.invCycColItem}</th>
                          <th style={{ ...d.rth, textAlign: 'right' }}>{t.invCycColExpected}</th>
                          <th style={{ ...d.rth, textAlign: 'right' }}>{t.invCycColCounted}</th>
                          <th style={{ ...d.rth, textAlign: 'right' }}>{t.invCycColVariance}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...withVariance, ...noVariance].map((l, i) => {
                          const expected = parseFloat(l.expected_qty);
                          const counted  = l.counted_qty != null ? parseFloat(l.counted_qty) : null;
                          const variance = l.variance != null ? parseFloat(l.variance) : (counted != null ? counted - expected : null);
                          const isVar    = variance !== null && variance !== 0;
                          return (
                            <tr key={l.id} style={{ background: isVar ? '#fff7ed' : (i % 2 === 0 ? '#fafafa' : '#fff') }}>
                              <td style={{ ...d.rtd, fontWeight: isVar ? 700 : 400 }}>
                                {isFull && l.location_name ? <span style={{ color: '#6b7280', marginRight: 4 }}>{l.location_name} —</span> : ''}
                                {l.item_name}
                              </td>
                              <td style={{ ...d.rtd, textAlign: 'right', color: '#6b7280' }}>{expected} {l.unit}</td>
                              <td style={{ ...d.rtd, textAlign: 'right' }}>{counted != null ? `${counted} ${l.unit}` : <em style={{ color: '#6b7280' }}>{t.invCycNotCounted}</em>}</td>
                              <td style={{ ...d.rtd, textAlign: 'right', fontWeight: 700,
                                color: variance === null ? '#9ca3af' : variance > 0 ? '#059669' : variance < 0 ? '#dc2626' : '#374151' }}>
                                {variance === null ? '—' : variance > 0 ? `+${variance}` : variance}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
            <div className="inventory-count-modal-actions" style={d.modalActions}>
              <button style={d.cancelBtn} onClick={() => { setReportLines(null); onComplete(); }}>{t.cancel}</button>
              <button style={{ ...d.confirmBtn, background: '#2563eb' }} onClick={() => downloadVarianceCSV(reportLines)}>
                {t.invCycDownloadCSV}
              </button>
            </div>
          </ModalShell>
        </div>
      )}

      {confirmOpen && (
        <div style={d.modalOverlay}>
          <ModalShell
            onClose={() => !completing && setConfirmOpen(false)}
            titleId="cyc-confirm-title"
            className="inventory-count-modal"
            style={d.modal}
          >
            <h3 id="cyc-confirm-title" style={d.modalTitle}>{t.invCycConfirmComplete} {COUNT_TYPES[countData.count_type]?.label || ''}?</h3>
            {variantLines.length > 0 ? (
              <>
                <p style={d.modalBody}>{variantLines.length} {t.invCycAdjustments}</p>
                <ul style={d.modalList}>
                  {variantLines.map(l => {
                    const v = l.variance != null ? parseFloat(l.variance) : parseFloat(l.counted_qty) - parseFloat(l.expected_qty);
                    return (
                      <li key={l.id} style={d.modalListItem}>
                        {isFull && l.location_name ? `${l.location_name} — ` : ''}{l.item_name}: {v > 0 ? `+${v}` : v} {l.unit}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p style={d.modalBody}>{t.invCycNoVariancesConfirm}</p>
            )}
            <div className="inventory-count-modal-actions" style={d.modalActions}>
              <button style={d.cancelBtn} onClick={() => setConfirmOpen(false)}>{t.cancel}</button>
              <button style={{ ...d.confirmBtn, ...(completing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={complete} disabled={completing}>
                {completing ? t.invCycCompleting : t.invCycConfirmBtn}
              </button>
            </div>
          </ModalShell>
        </div>
      )}

      {conversionPrompt && (
        <UomConversionModal
          itemId={conversionPrompt.itemId}
          uom={conversionPrompt.uom}
          baseUnit={conversionPrompt.baseUnit}
          onSaved={updatedList => {
            setItemUomCache(prev => ({
              ...prev,
              [conversionPrompt.itemId]: updatedList.filter(u => u.active),
            }));
            setConversionPrompt(null);
          }}
          onDismiss={() => setConversionPrompt(null)}
        />
      )}

      {/* ── Override Modal ── */}
      {overrideModal && (
        <div style={d.modalOverlay}>
          <ModalShell
            onClose={() => setOverrideModal(null)}
            titleId="cyc-override-title"
            className="inventory-count-modal"
            style={d.modal}
          >
            <h3 id="cyc-override-title" style={d.modalTitle}>{t.invCycOverrideTitle}: {overrideModal.line.item_name}</h3>
            <p style={d.modalBody}>
              {t.invCycOverrideExpected}: {parseFloat(overrideModal.line.expected_qty)} {overrideModal.line.unit}.
              {' '}{t.invCycOverrideDesc}
            </p>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>{t.invCycOverrideCounted}</label>
              <input type="number" min="0" step="any"
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, width: '100%', boxSizing: 'border-box' }}
                value={overrideQty} onChange={e => setOverrideQty(e.target.value)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>{t.notesOptional}</label>
              <input type="text" maxLength={500}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, width: '100%', boxSizing: 'border-box' }}
                value={overrideNotes} onChange={e => setOverrideNotes(e.target.value)} />
            </div>
            <div className="inventory-count-modal-actions" style={d.modalActions}>
              <button style={d.cancelBtn} onClick={() => setOverrideModal(null)}>{t.cancel}</button>
              <button style={{ ...d.confirmBtn, background: '#7c3aed', ...(overriding || overrideQty === '' ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                onClick={submitOverride} disabled={overriding || overrideQty === ''}>
                {overriding ? t.invCycOverrideSaving : t.invCycOverride}
              </button>
            </div>
          </ModalShell>
        </div>
      )}
    </div>
  );
}

export default function InventoryCycleCounts({ locations, settings, onComplete }) {
  const t = useT();
  const { user } = useAuth();
  const COUNT_TYPES = useCountTypes(t);
  const STATUS_COLORS = useStatusColors(t);
  const [counts, setCounts] = useState([]);
  const [countsTotal, setCountsTotal] = useState(0);
  const [countsOffset, setCountsOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newLocationId, setNewLocationId] = useState('');
  const [newCountType, setNewCountType] = useState('cycle');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [countSearch, setCountSearch] = useState('');
  const [createError, setCreateError] = useState('');
  const [loadDetailError, setLoadDetailError] = useState('');

  const CC_PAGE = 100;

  const load = useCallback(async () => {
    setLoading(true); setCountsOffset(0);
    try {
      const params = new URLSearchParams({ limit: CC_PAGE, offset: 0 });
      if (filterStatus) params.set('status', filterStatus);
      if (filterType) params.set('count_type', filterType);
      if (filterLocation) params.set('location_id', filterLocation);
      if (countSearch.trim()) params.set('q', countSearch.trim());
      const r = await api.get(`/inventory/cycle-counts?${params}`);
      setCounts(r.data.counts);
      setCountsTotal(r.data.total);
    } catch { setError(t.invCycFailedLoad); }
    finally { setLoading(false); }
  }, [filterStatus, filterType, filterLocation, countSearch]);

  const loadMoreCounts = async () => {
    const nextOffset = countsOffset + CC_PAGE;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: CC_PAGE, offset: nextOffset });
      if (filterStatus) params.set('status', filterStatus);
      if (filterType) params.set('count_type', filterType);
      if (filterLocation) params.set('location_id', filterLocation);
      if (countSearch.trim()) params.set('q', countSearch.trim());
      const r = await api.get(`/inventory/cycle-counts?${params}`);
      setCounts(prev => [...prev, ...r.data.counts]);
      setCountsOffset(nextOffset);
    } catch { /* non-fatal */ }
    finally { setLoadingMore(false); }
  };

  useEffect(() => { load(); }, [load]);

  const startCount = async () => {
    setCreateError('');
    setCreating(true);
    try {
      const payload = { count_type: newCountType, notes: null };
      if (newCountType !== 'full') payload.location_id = parseInt(newLocationId);
      const r = await api.post('/inventory/cycle-counts', payload);
      setSelected(r.data);
      load();
    } catch (e) {
      setCreateError(e.response?.data?.error || t.invCycFailedCreate);
    } finally {
      setCreating(false); setNewLocationId('');
    }
  };

  const openCount = async (count) => {
    setLoadDetailError('');
    try {
      const r = await api.get(`/inventory/cycle-counts/${count.id}`);
      setSelected(r.data);
    } catch { setLoadDetailError(t.invCycFailedLoadDetails); }
  };

  const handleComplete = () => {
    setSelected(null);
    load();
    onComplete?.();
  };

  if (selected) {
    return (
      <CycleCountDetail
        count={selected}
        settings={settings}
        onBack={() => { setSelected(null); load(); }}
        onComplete={handleComplete}
      />
    );
  }

  const activeLocations = locations.filter(l => l.active);
  const needsLocation = newCountType !== 'full';
  const hasCountListFilter = countSearch.trim() || filterStatus || filterType || filterLocation;

  return (
    <div style={s.wrap}>
      {/* Start new count */}
      <div style={s.startCard}>
        <div className="inventory-count-start-row" style={s.startRow}>
          <select style={s.typeSelect} value={newCountType} onChange={e => { setNewCountType(e.target.value); setNewLocationId(''); }}>
            {Object.entries(COUNT_TYPES).map(([key, ct]) => (
              <option key={key} value={key}>{ct.label}</option>
            ))}
          </select>
          {needsLocation && (
            <select style={s.select} value={newLocationId} onChange={e => setNewLocationId(e.target.value)}>
              <option value="">{t.invCycSelectLocation}</option>
              {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button style={{ ...s.startBtn, ...(creating || (needsLocation && !newLocationId) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={startCount} disabled={creating || (needsLocation && !newLocationId)}>
            {creating ? t.invCycCreating : t.invCycStartCount}
          </button>
        </div>
        {newCountType && (
          <p style={s.typeDesc}>{COUNT_TYPES[newCountType]?.desc}</p>
        )}
        {createError && <p style={s.inlineError}>{createError}</p>}
      </div>

      {/* Filters */}
      <div className="inventory-count-filters" style={s.filters}>
        <input
          type="search"
          value={countSearch}
          onChange={e => setCountSearch(e.target.value)}
          placeholder={t.invccSearchCountsPlaceholder}
          style={s.searchInput}
        />
        <select style={s.select} value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="">{t.invCycAllTypes}</option>
          {Object.entries(COUNT_TYPES).map(([key, ct]) => (
            <option key={key} value={key}>{ct.label}</option>
          ))}
        </select>
        <select style={s.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">{t.invCycAllStatuses}</option>
          <option value="draft">{t.invCycDraft}</option>
          <option value="in_progress">{t.invCycInProgress}</option>
          <option value="completed">{t.invCycCompleted}</option>
        </select>
        <select style={s.select} value={filterLocation} onChange={e => setFilterLocation(e.target.value)}>
          <option value="">{t.invCycAllLocations}</option>
          {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {hasCountListFilter && (
          <button
            type="button"
            style={s.clearBtn}
            onClick={() => { setCountSearch(''); setFilterType(''); setFilterStatus(''); setFilterLocation(''); }}
          >
            {t.invccClear}
          </button>
        )}
      </div>
      {!loading && (
        <p style={s.filterMeta}>
          {hasCountListFilter ? `${t.invccShowing} ${counts.length} ${t.invccOf} ${countsTotal} ${t.invccMatchingCounts}` : `${countsTotal} ${t.invccCounts}`}
        </p>
      )}

      {error && <div role="alert" style={s.error}>{error}</div>}
      {loadDetailError && <p style={s.inlineError}>{loadDetailError}</p>}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : counts.length === 0 ? (
        <div style={s.empty}>
          <p>{hasCountListFilter ? t.invccNoCountsMatch : t.invCycNoCountsYet}</p>
        </div>
      ) : (
        <>
        <div style={s.list}>
          {counts.map(count => {
            const sc = STATUS_COLORS[count.status] || STATUS_COLORS.draft;
            const pct = count.line_count > 0 ? Math.round((count.counted_count / count.line_count) * 100) : 0;
            return (
              <div key={count.id} style={s.card} onClick={() => openCount(count)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && openCount(count)}>
                <div style={s.cardTop}>
                  <div>
                    <div style={s.cardTitle}>{count.location_name}</div>
                    <div style={s.cardMeta}>
                      {t.invCycStartedBy} {count.started_by_name} - {formatDate(count.started_at, user?.language)}
                      {count.completed_at && ` - ${t.invCycCompleted} ${formatDate(count.completed_at, user?.language)}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <TypeBadge type={count.count_type} />
                    <span style={{ ...s.badge, color: sc.color, background: sc.bg }}>{sc.label}</span>
                  </div>
                </div>
                <div style={s.cardProgress}>
                  <span style={s.cardProgressText}>{count.counted_count}/{count.line_count} {t.invCycItemsCounted}</span>
                  {count.status !== 'completed' && count.line_count > 0 && (
                    <div style={s.progressBar}>
                      <div style={{ ...s.progressFill, width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {counts.length < countsTotal && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <button style={{ ...s.loadMoreBtn, ...(loadingMore ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={loadMoreCounts} disabled={loadingMore}>
              {loadingMore ? t.loading : t.loadMore}
            </button>
            <span style={{ marginLeft: 10, fontSize: 13, color: '#6b7280' }}>{counts.length} / {countsTotal}</span>
          </div>
        )}
        </>
      )}
    </div>
  );
}

function lineStatusStyle(status) {
  const map = {
    pending:          { color: '#6b7280', background: '#f3f4f6' },
    counted:          { color: '#2563eb', background: '#dbeafe' },
    needs_audit:      { color: '#d97706', background: '#fef3c7' },
    audited:          { color: '#7c3aed', background: '#ede9fe' },
    needs_reconcile:  { color: '#dc2626', background: '#fee2e2' },
    reconciled:       { color: '#059669', background: '#d1fae5' },
    accepted:         { color: '#059669', background: '#d1fae5' },
    overridden:       { color: '#6b7280', background: '#e5e7eb' },
  };
  return map[status] || { color: '#6b7280', background: '#f3f4f6' };
}

const d = {
  wrap:          { padding: 16 },
  back:          { background: 'none', border: 'none', color: '#2563eb', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginBottom: 16, padding: 0 },
  header:        { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20 },
  title:         { fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 },
  sub:           { fontSize: 13, color: '#6b7280', margin: 0 },
  headerRight:   { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  detailProgress:{ marginTop: 12, maxWidth: 360 },
  detailProgressTop: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 6, fontSize: 12, color: '#64748b' },
  detailProgressBar: { height: 7, borderRadius: 999, background: '#e5e7eb', overflow: 'hidden' },
  detailProgressFill: { height: '100%', borderRadius: 999, background: '#2563eb', transition: 'width 0.25s ease' },
  statusBadge:   { padding: '4px 14px', borderRadius: 12, fontSize: 13, fontWeight: 700 },
  advanceBtn:    { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  completeBtn:   { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  scanModeBtn:   { padding: '8px 16px', borderRadius: 8, border: '2px solid #d97706', background: '#fff', color: '#d97706', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  scanModeBtnActive: { background: '#d97706', color: '#fff' },
  scanPanel:     { background: '#fffbeb', border: '2px solid #f59e0b', borderRadius: 10, padding: '14px 16px', marginBottom: 16 },
  scanBinRow:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  scanBinLabel:  { fontSize: 14, color: '#374151', flex: 1 },
  scanClearBtn:  { padding: '3px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, color: '#6b7280', cursor: 'pointer' },
  scanInputRow:  { marginBottom: 8 },
  scanInput:     { width: '100%', padding: '10px 12px', borderRadius: 8, border: '2px solid #f59e0b', fontSize: 14, background: '#fff', color: '#111827', boxSizing: 'border-box', outline: 'none' },
  scanFeedback:  { padding: '7px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600, marginBottom: 8 },
  scanHint:      { fontSize: 12, color: '#78716c', lineHeight: 1.5, margin: 0 },
  error:         { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:         { textAlign: 'center', padding: 40, color: '#6b7280' },
  lineFilters:   { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 190px 170px auto', gap: 8, alignItems: 'center', marginBottom: 10 },
  lineFilterInput: { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff' },
  lineFilterSelect: { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#374151', background: '#fff' },
  lineFilterClear: { padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer' },
  filterCount:   { fontSize: 12, color: '#64748b', margin: '-4px 0 12px' },
  tableWrap:     { overflowX: 'auto', borderRadius: 10, border: '1px solid #e5e7eb' },
  table:         { width: '100%', borderCollapse: 'collapse', minWidth: 500 },
  thead:         { background: '#f9fafb' },
  th:            { padding: '10px 12px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:           { borderBottom: '1px solid #f3f4f6' },
  rowEven:       { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:            { padding: '10px 12px', fontSize: 14, color: '#374151' },
  countInput:    { width: 80, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14, textAlign: 'right' },
  uomSelect:     { padding: '5px 6px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, color: '#374151', background: '#f9fafb', cursor: 'pointer' },
  mobileLineList:{ display: 'grid', gap: 10 },
  mobileLineCard:{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  mobileLineCardHighlighted: { borderColor: '#f59e0b', boxShadow: '0 0 0 2px #fde68a' },
  mobileLineCardTop: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'start', marginBottom: 12 },
  mobileLineTitle: { display: 'block', fontSize: 15, fontWeight: 800, color: '#111827', lineHeight: 1.25 },
  mobileLineMeta: { display: 'block', marginTop: 3, fontSize: 12, color: '#64748b', lineHeight: 1.35 },
  mobileLineStats: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '10px 0', borderTop: '1px solid #f1f5f9', borderBottom: '1px solid #f1f5f9', marginBottom: 12, fontSize: 13, color: '#334155' },
  mobileLineLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  mobileCountField: { display: 'grid', gap: 5, marginBottom: 12 },
  mobileCountInputRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' },
  mobileHint: { fontSize: 12, color: '#64748b' },
  mobileLineFooter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12, color: '#64748b' },
  uncountedNote: { textAlign: 'center', fontSize: 13, color: '#d97706', fontWeight: 600, marginTop: 12 },
  locationHeader:{ fontSize: 13, fontWeight: 700, color: '#374151', padding: '8px 0 6px', borderBottom: '2px solid #e5e7eb', marginBottom: 4 },
  modalOverlay:  { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 },
  modal:         { background: '#fff', borderRadius: 14, padding: 28, maxWidth: 460, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', maxHeight: '80vh', overflowY: 'auto' },
  modalTitle:    { fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 12 },
  modalBody:     { fontSize: 14, color: '#374151', marginBottom: 12 },
  modalList:     { margin: '0 0 16px', paddingLeft: 20 },
  modalListItem: { fontSize: 14, color: '#374151', marginBottom: 4 },
  modalActions:  { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn:     { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  confirmBtn:    { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  rth:           { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  rtd:           { padding: '8px 10px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  warnMsg:       { color: '#92400e', fontSize: 13, margin: '6px 0 0' },
  inlineError:   { color: '#dc2626', fontSize: 13, margin: '6px 0 0' },
  // Tabs
  tabRow:        { display: 'flex', gap: 6, marginBottom: 16, padding: 4, border: '1px solid #e5e7eb', borderRadius: 10, background: '#f8fafc' },
  tab:           { flex: 1, padding: '9px 12px', background: 'transparent', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, color: '#64748b', cursor: 'pointer' },
  tabActive:     { color: '#111827', background: '#fff', boxShadow: '0 1px 4px rgba(15,23,42,0.08)' },
  // Workers panel
  workersPanel:  { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 16 },
  workersPanelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  distributeBtn: { padding: '7px 14px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  workerRow:     { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' },
  workerName:    { fontSize: 14, fontWeight: 600, color: '#111827', flex: 1, minWidth: 120 },
  rolesRow:      { display: 'flex', gap: 12, flexWrap: 'wrap' },
  roleLabel:     { fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', cursor: 'pointer' },
  removeWorkerBtn: { padding: '3px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, color: '#dc2626', cursor: 'pointer' },
  workerSelect:  { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151', width: '100%' },
  // Line status
  lineStatusBadge: { padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  overrideBtn:   { padding: '3px 8px', borderRadius: 6, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
};

const s = {
  wrap:          { padding: 16 },
  loadMoreBtn:   { padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  startCard:     { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 12 },
  startRow:      { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  typeSelect:    { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151', minWidth: 160 },
  filters:       { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  searchInput:   { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#111827', flex: '1 1 220px', minWidth: 180, boxSizing: 'border-box' },
  select:        { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151', flex: 1, minWidth: 140 },
  clearBtn:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer' },
  filterMeta:    { fontSize: 12, color: '#64748b', margin: '-8px 0 12px' },
  typeDesc:      { margin: '8px 0 0', fontSize: 13, color: '#6b7280' },
  startBtn:      { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  error:         { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:         { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:     { fontSize: 40, marginBottom: 12 },
  list:          { display: 'flex', flexDirection: 'column', gap: 10 },
  card:          { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, cursor: 'pointer', transition: 'border-color 0.15s' },
  cardTop:       { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  cardTitle:     { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 2 },
  cardMeta:      { fontSize: 12, color: '#6b7280' },
  cardProgress:  { display: 'flex', alignItems: 'center', gap: 12 },
  cardProgressText: { fontSize: 13, color: '#6b7280', whiteSpace: 'nowrap' },
  progressBar:   { flex: 1, height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' },
  progressFill:  { height: '100%', background: '#2563eb', borderRadius: 3, transition: 'width 0.3s' },
  badge:         { display: 'inline-block', padding: '3px 12px', borderRadius: 12, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' },
  inlineError:   { color: '#dc2626', fontSize: 13, margin: '6px 0 0' },
  warnMsg:       { color: '#92400e', fontSize: 13, margin: '6px 0 0' },
};
