import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useT } from '../../hooks/useT';
import { useAuth } from '../../contexts/AuthContext';
import { langToLocale } from '../../utils';
import { useMoney } from '../../hooks/useMoney';
import { SkeletonList } from '../Skeleton';
import ModalShell from '../ModalShell';

import { silentError } from '../../errorReporter';
function useStatus(t) {
  return {
    draft:      { label: t.invPODraft,      color: '#6b7280', bg: '#f3f4f6' },
    submitted:  { label: t.invPOSubmitted,  color: '#2563eb', bg: '#dbeafe' },
    partial:    { label: t.invPOPartial,    color: '#d97706', bg: '#fef3c7' },
    received:   { label: t.invPOReceived,   color: '#059669', bg: '#d1fae5' },
    cancelled:  { label: t.invPOCancelled,  color: '#6b7280', bg: '#f3f4f6' },
  };
}

function StatusBadge({ status }) {
  const t = useT();
  const STATUS = useStatus(t);
  const st = STATUS[status] || STATUS.draft;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700,
      color: st.color, background: st.bg, whiteSpace: 'nowrap' }}>
      {st.label}
    </span>
  );
}

// ── Receive Modal ──────────────────────────────────────────────────────────────

function formatDate(value, locale) {
  if (!value) return '';
  const datePart = String(value).slice(0, 10);
  const date = new Date(`${datePart}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale);
}

function ReceiveModal({ po, locations, onDone, onClose }) {
  const t = useT();
  const defaultLoc = po.to_location_id ? String(po.to_location_id) : '';
  const [locationId, setLocationId] = useState(defaultLoc);
  const [qtys, setQtys] = useState(() => {
    const init = {};
    (po.lines || []).forEach(l => {
      const remaining = parseFloat(l.qty_ordered) - parseFloat(l.qty_received);
      init[l.id] = remaining > 0 ? String(remaining) : '';
    });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const openLines = (po.lines || []).filter(l =>
    parseFloat(l.qty_ordered) - parseFloat(l.qty_received) > 0
  );

  const submit = async () => {
    setError('');
    if (!locationId) return setError(t.invPOSelectReceiveLoc);
    const lines = openLines
      .map(l => ({ line_id: l.id, qty_to_receive: parseFloat(qtys[l.id] || 0) }))
      .filter(l => l.qty_to_receive > 0);
    if (lines.length === 0) return setError(t.invPOEnterQty);
    setSaving(true);
    try {
      const r = await api.post(`/inventory/purchase-orders/${po.id}/receive`, {
        location_id: parseInt(locationId),
        lines,
      });
      onDone(r.data);
    } catch (err) {
      setError(err.response?.data?.error || t.invPOFailedReceive);
    } finally { setSaving(false); }
  };

  return (
    <div style={m.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <ModalShell onClose={onClose} titleId="po-receive-title" style={m.modal}>
        <div style={m.header}>
          <h3 id="po-receive-title" style={m.title}>{t.invPOReceiveTitle} — {po.po_number}</h3>
          <button style={m.closeBtn} aria-label={t.labelModalClose} onClick={onClose}>X</button>
        </div>

        {error && <div role="alert" style={m.error}>{error}</div>}

        <div style={m.field}>
          <label style={m.label}>{t.invPOReceivingLoc}</label>
          <select style={m.input} value={locationId} onChange={e => setLocationId(e.target.value)}>
            <option value="">{t.invCycSelectLocation}</option>
            {locations.filter(l => l.active).map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>

        <div style={{ overflowX: 'auto', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={m.th}>{t.invTxColItem}</th>
                <th style={{ ...m.th, textAlign: 'right' }}>{t.invPOColOrdered}</th>
                <th style={{ ...m.th, textAlign: 'right' }}>{t.invPOColReceived}</th>
                <th style={{ ...m.th, textAlign: 'right' }}>{t.invPOColRemaining}</th>
                <th style={{ ...m.th, textAlign: 'right' }}>{t.invPOColReceiveNow}</th>
              </tr>
            </thead>
            <tbody>
              {openLines.map((line, i) => {
                const remaining = parseFloat(line.qty_ordered) - parseFloat(line.qty_received);
                return (
                  <tr key={line.id} style={{ background: i % 2 === 0 ? '#fafafa' : '#fff', borderBottom: '1px solid #f3f4f6' }}>
                    <td style={m.td}>
                      <div style={{ fontWeight: 600 }}>{line.item_name}</div>
                      {line.sku && <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{line.sku}</div>}
                    </td>
                    <td style={{ ...m.td, textAlign: 'right', color: '#6b7280' }}>{parseFloat(line.qty_ordered)} {line.unit}</td>
                    <td style={{ ...m.td, textAlign: 'right', color: '#6b7280' }}>{parseFloat(line.qty_received)}</td>
                    <td style={{ ...m.td, textAlign: 'right', fontWeight: 700 }}>{remaining}</td>
                    <td style={{ ...m.td, textAlign: 'right' }}>
                      <input
                        style={m.qtyInput}
                        type="number"
                        min="0"
                        max={remaining}
                        step="any"
                        value={qtys[line.id] || ''}
                        onChange={e => setQtys(q => ({ ...q, [line.id]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={m.actions}>
          <button style={m.cancelBtn} onClick={onClose}>{t.cancel}</button>
          <button style={{ ...m.confirmBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submit} disabled={saving}>
            {saving ? t.invPOReceiving : t.invPOConfirmReceipt}
          </button>
        </div>
      </ModalShell>
    </div>
  );
}

// ── PO Detail ──────────────────────────────────────────────────────────────────

function PODetail({ po: initialPo, locations, suppliers, onBack, onUpdate }) {
  const fmtMoney = useMoney();
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const STATUS = useStatus(t);
  const [po, setPo]           = useState(initialPo);
  const [lines, setLines]     = useState(initialPo.lines || []);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [addingLine, setAddingLine]   = useState(false);
  const [items, setItems]     = useState([]);
  const [newLine, setNewLine] = useState({ item_id: '', qty_ordered: '', unit_cost: '', notes: '' });
  const [lineErr, setLineErr] = useState('');
  const [saving, setSaving]   = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    supplier_id: po.supplier_id ? String(po.supplier_id) : '',
    to_location_id: po.to_location_id ? String(po.to_location_id) : '',
    expected_date: po.expected_date ? po.expected_date.slice(0,10) : '',
    reference_no: po.reference_no || '',
    notes: po.notes || '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [actionErr, setActionErr]   = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [pendingRemoveLineId, setPendingRemoveLineId] = useState(null);
  const [removeLineErr, setRemoveLineErr] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent]       = useState(false);

  useEffect(() => {
    if (addingLine) {
      api.get('/inventory/items?active=true').then(r => setItems(r.data)).catch(silentError('inventorypurchaseorders'));
    }
  }, [addingLine]);

  const isDraft     = po.status === 'draft';
  const canReceive  = ['submitted', 'partial'].includes(po.status);
  const isFinished  = ['received', 'cancelled'].includes(po.status);

  const nextActionText = {
    draft:     t.invPONextActionDraft,
    submitted: t.invPONextActionSubmitted,
    partial:   t.invPONextActionPartial,
    received:  t.invPONextActionReceived,
    cancelled: t.invPONextActionCancelled,
  }[po.status];

  const totalOrdered  = lines.reduce((s, l) => s + parseFloat(l.qty_ordered), 0);
  const totalReceived = lines.reduce((s, l) => s + parseFloat(l.qty_received), 0);

  const submitPO = async () => {
    if (lines.length === 0) return setActionErr(t.invPOSubmitAtLeastOne);
    setActionErr(''); setSaving(true);
    try {
      const r = await api.patch(`/inventory/purchase-orders/${po.id}`, { status: 'submitted' });
      setPo(r.data);
      onUpdate();
    } catch (err) { setActionErr(err.response?.data?.error || t.invPOFailedSubmit); }
    finally { setSaving(false); }
  };

  const cancelPO = async () => {
    setConfirmingCancel(false);
    setActionErr(''); setSaving(true);
    try {
      await api.delete(`/inventory/purchase-orders/${po.id}`);
      onBack(true); // true = reload list
    } catch (err) { setActionErr(err.response?.data?.error || t.invPOFailedCancel); }
    finally { setSaving(false); }
  };

  const saveEdit = async () => {
    setActionErr(''); setEditSaving(true);
    try {
      const r = await api.patch(`/inventory/purchase-orders/${po.id}`, {
        supplier_id: editForm.supplier_id ? parseInt(editForm.supplier_id) : null,
        to_location_id: editForm.to_location_id ? parseInt(editForm.to_location_id) : null,
        expected_date: editForm.expected_date || null,
        reference_no: editForm.reference_no,
        notes: editForm.notes,
      });
      setPo(r.data);
      setEditing(false);
      onUpdate();
    } catch (err) { setActionErr(err.response?.data?.error || t.invPOFailedSave); }
    finally { setEditSaving(false); }
  };

  const addLine = async () => {
    setLineErr('');
    if (!newLine.item_id) return setLineErr(t.invPOSelectItem);
    if (!newLine.qty_ordered || parseFloat(newLine.qty_ordered) <= 0) return setLineErr(t.invPOPositiveQty);
    setSaving(true);
    try {
      const r = await api.post(`/inventory/purchase-orders/${po.id}/lines`, {
        item_id: parseInt(newLine.item_id),
        qty_ordered: parseFloat(newLine.qty_ordered),
        unit_cost: newLine.unit_cost !== '' ? parseFloat(newLine.unit_cost) : null,
        notes: newLine.notes,
      });
      setLines(r.data);
      setNewLine({ item_id: '', qty_ordered: '', unit_cost: '', notes: '' });
      setAddingLine(false);
      onUpdate();
    } catch (err) { setLineErr(err.response?.data?.error || t.invPOFailedAddLine); }
    finally { setSaving(false); }
  };

  const removeLine = async (lineId) => {
    setPendingRemoveLineId(null);
    setRemoveLineErr('');
    try {
      const r = await api.delete(`/inventory/purchase-orders/${po.id}/lines/${lineId}`);
      setLines(r.data);
      onUpdate();
    } catch (err) { setRemoveLineErr(err.response?.data?.error || t.invPOFailedRemoveLine); }
  };

  const emailPO = async () => {
    setActionErr(''); setEmailSending(true); setEmailSent(false);
    try {
      await api.post(`/inventory/purchase-orders/${po.id}/email`);
      setEmailSent(true);
      setTimeout(() => setEmailSent(false), 4000);
    } catch (err) {
      setActionErr(err.response?.data?.error || t.invPOFailedEmail);
    } finally {
      setEmailSending(false);
    }
  };

  const handleReceiveDone = (updated) => {
    setPo(updated);
    setLines(updated.lines || []);
    setReceiveOpen(false);
    onUpdate();
  };

  return (
    <div style={d.wrap}>
      <button style={d.backBtn} onClick={() => onBack(false)}>{t.invPOBackToOrders}</button>

      {/* Header card */}
      <div style={d.headerCard}>
        <div style={d.headerTop}>
          <div>
            <div style={d.poNumber}>{po.po_number}</div>
            <div style={d.poMeta}>
              {t.invPOCreatedBy} {po.created_by_name} · {formatDate(po.created_at, locale)}
              {po.order_date && ` · ${t.invPOOrderedOn} ${formatDate(po.order_date, locale)}`}
            </div>
          </div>
          <div style={d.headerActions}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <StatusBadge status={po.status} />
              {nextActionText && (
                <span style={d.nextActionHint}>{nextActionText}</span>
              )}
            </div>
            {isDraft && !editing && (
              <>
                <button style={d.editBtn} onClick={() => setEditing(true)}>{t.invPOEditBtn}</button>
                <button style={{ ...d.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submitPO} disabled={saving}>{t.invPOSubmitBtn}</button>
              </>
            )}
            {editing && (
              <>
                <button style={d.cancelEditBtn} onClick={() => setEditing(false)}>{t.cancel}</button>
                <button style={{ ...d.submitBtn, ...(editSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={saveEdit} disabled={editSaving}>{editSaving ? t.saving : t.save}</button>
              </>
            )}
            {po.supplier_name && !isDraft && (
              <button
                style={{ ...d.editBtn, color: emailSent ? '#059669' : '#2563eb', borderColor: emailSent ? '#059669' : '#bfdbfe', background: emailSent ? '#d1fae5' : '#eff6ff', ...(emailSending ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                onClick={emailPO}
                disabled={emailSending}
                title={`${t.invpoEmailToTitle} ${po.supplier_name}`}
              >
                {emailSending ? t.invPOEmailSending : emailSent ? t.invPOEmailSent : t.invPOEmailBtn}
              </button>
            )}
            {canReceive && (
              <button style={d.receiveBtn} onClick={() => setReceiveOpen(true)}>{t.invPOReceiveBtn}</button>
            )}
            {!isFinished && (confirmingCancel ? (
              <>
                <button style={{ ...d.confirmCancelBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={cancelPO} disabled={saving}>{saving ? '…' : t.confirm}</button>
                <button style={d.smallCancelBtn} onClick={() => setConfirmingCancel(false)}>{t.cancel}</button>
              </>
            ) : (
              <button style={d.cancelBtn} onClick={() => setConfirmingCancel(true)}>
                {isDraft ? t.invPODeleteBtn : t.invPOCancelBtn}
              </button>
            ))}
          </div>
        </div>

        {actionErr && <div style={d.error}>{actionErr}</div>}

        {editing ? (
          <div style={d.editGrid}>
            <div style={d.editField}>
              <label style={d.editLabel}>{t.invPOSupplier}</label>
              <select style={d.editInput} value={editForm.supplier_id} onChange={e => setEditForm(f => ({ ...f, supplier_id: e.target.value }))}>
                <option value="">{t.none}</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={d.editField}>
              <label style={d.editLabel}>{t.invPODefaultReceiveLoc}</label>
              <select style={d.editInput} value={editForm.to_location_id} onChange={e => setEditForm(f => ({ ...f, to_location_id: e.target.value }))}>
                <option value="">{t.none}</option>
                {locations.filter(l => l.active).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div style={d.editField}>
              <label style={d.editLabel}>{t.invPOExpectedDate}</label>
              <input style={d.editInput} type="date" value={editForm.expected_date} onChange={e => setEditForm(f => ({ ...f, expected_date: e.target.value }))} />
            </div>
            <div style={d.editField}>
              <label style={d.editLabel}>{t.invPOSupplierRef}</label>
              <input style={d.editInput} value={editForm.reference_no} onChange={e => setEditForm(f => ({ ...f, reference_no: e.target.value }))} placeholder={t.invPOSupplierRef} />
            </div>
            <div style={{ ...d.editField, flexBasis: '100%' }}>
              <label style={d.editLabel}>{t.notes}</label>
              <textarea style={{ ...d.editInput, minHeight: 52, resize: 'vertical' }} value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} maxLength={1000} />
              <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(editForm.notes || '').length}/1000</div>
            </div>
          </div>
        ) : (
          <div style={d.infoGrid}>
            <div style={d.infoItem}>
              <span style={d.infoLabel}>{t.invPOSupplier}</span>
              <span style={d.infoValue}>{po.supplier_name || <em style={{ color: '#6b7280' }}>{t.none}</em>}</span>
            </div>
            <div style={d.infoItem}>
              <span style={d.infoLabel}>{t.invPOReceiveTo}</span>
              <span style={d.infoValue}>{po.to_location_name || <em style={{ color: '#6b7280' }}>{t.invPONotSet}</em>}</span>
            </div>
            <div style={d.infoItem}>
              <span style={d.infoLabel}>{t.invPOExpected}</span>
              <span style={d.infoValue}>{po.expected_date ? formatDate(po.expected_date, locale) : <em style={{ color: '#6b7280' }}>{t.invPONotSet}</em>}</span>
            </div>
            {po.reference_no && (
              <div style={d.infoItem}>
                <span style={d.infoLabel}>{t.invPOSupplierRefLabel}</span>
                <span style={d.infoValue}>{po.reference_no}</span>
              </div>
            )}
            {po.notes && (
              <div style={{ ...d.infoItem, flexBasis: '100%' }}>
                <span style={d.infoLabel}>{t.notes}</span>
                <span style={d.infoValue}>{po.notes}</span>
              </div>
            )}
          </div>
        )}

        {/* Progress bar (non-draft) */}
        {!isDraft && totalOrdered > 0 && (
          <div style={d.progress}>
            <div style={d.progressBar}>
              <div style={{ ...d.progressFill, width: `${Math.min(100, (totalReceived / totalOrdered) * 100)}%` }} />
            </div>
            <span style={d.progressText}>{totalReceived}/{totalOrdered} {t.invPOItemsReceived}</span>
          </div>
        )}
      </div>

      {/* Lines table */}
      <div style={d.linesHeader}>
        <div style={d.linesTitle}>{t.invPOLineItems}</div>
        {isDraft && !addingLine && (
          <button style={d.addLineBtn} onClick={() => setAddingLine(true)}>{t.invPOAddItem}</button>
        )}
      </div>

      {lines.length === 0 ? (
        <div style={d.emptyLines}>{t.invPONoLines}</div>
      ) : (
        <>
        <div className="inventory-table-wrap inventory-po-lines-table-wrap" style={d.tableWrap}>
          <table style={d.table}>
            <thead>
              <tr style={d.thead}>
                <th style={d.th}>{t.invTxColItem}</th>
                <th style={d.th}>{t.colSku}</th>
                <th style={d.th}>{t.colUnit}</th>
                <th style={{ ...d.th, textAlign: 'right' }}>{t.invPOColQtyOrdered}</th>
                <th style={{ ...d.th, textAlign: 'right' }}>{t.invPOColQtyReceived}</th>
                <th style={{ ...d.th, textAlign: 'right' }}>{t.invPOColRemaining}</th>
                <th style={{ ...d.th, textAlign: 'right' }}>{t.invPOColUnitCost}</th>
                {isDraft && <th style={d.th}></th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const remaining = parseFloat(line.qty_ordered) - parseFloat(line.qty_received);
                return (
                  <tr key={line.id} style={i % 2 === 0 ? d.rowEven : d.row}>
                    <td style={{ ...d.td, fontWeight: 600 }}>{line.item_name}</td>
                    <td style={{ ...d.td, fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{line.sku || '—'}</td>
                    <td style={{ ...d.td, color: '#6b7280' }}>{line.unit}</td>
                    <td style={{ ...d.td, textAlign: 'right' }}>{parseFloat(line.qty_ordered)}</td>
                    <td style={{ ...d.td, textAlign: 'right', color: parseFloat(line.qty_received) > 0 ? '#059669' : '#9ca3af' }}>
                      {parseFloat(line.qty_received)}
                    </td>
                    <td style={{ ...d.td, textAlign: 'right', fontWeight: remaining > 0 ? 700 : 400,
                      color: remaining > 0 ? '#d97706' : '#059669' }}>
                      {remaining > 0 ? remaining : t.invpoDone}
                    </td>
                    <td style={{ ...d.td, textAlign: 'right', color: '#6b7280' }}>
                      {line.unit_cost != null ? fmtMoney(line.unit_cost) : '—'}
                    </td>
                    {isDraft && (
                      <td style={d.td}>
                        {pendingRemoveLineId === line.id ? (
                          <>
                            <button style={d.confirmLineRemoveBtn} onClick={() => removeLine(line.id)}>{t.confirm}</button>
                            <button style={d.removeBtn} aria-label={t.cancelRemoveLine} onClick={() => setPendingRemoveLineId(null)}>X</button>
                          </>
                        ) : (
                          <button style={d.removeBtn} aria-label={t.removeLine} onClick={() => setPendingRemoveLineId(line.id)}>{t.invpoRemove}</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            {lines.length > 0 && (
              <tfoot>
                <tr style={d.totalRow}>
                  <td colSpan={3} style={{ ...d.td, fontWeight: 700 }}>{t.invPOTotal}</td>
                  <td style={{ ...d.td, textAlign: 'right', fontWeight: 700 }}>{totalOrdered}</td>
                  <td style={{ ...d.td, textAlign: 'right', fontWeight: 700, color: '#059669' }}>{totalReceived}</td>
                  <td style={{ ...d.td, textAlign: 'right', fontWeight: 700, color: totalOrdered - totalReceived > 0 ? '#d97706' : '#059669' }}>
                    {totalOrdered - totalReceived > 0 ? totalOrdered - totalReceived : t.invpoDone}
                  </td>
                  <td style={{ ...d.td, textAlign: 'right', fontWeight: 700 }}>
                    {lines.some(l => l.unit_cost != null)
                      ? fmtMoney(lines.reduce((s, l) => s + (l.unit_cost ? parseFloat(l.unit_cost) * parseFloat(l.qty_ordered) : 0), 0))
                      : '—'}
                  </td>
                  {isDraft && <td style={d.td} />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div style={d.mobileLineCards} className="inventory-mobile-cards">
          <div style={d.mobileLineSummary}>
            <span style={d.mobileSummaryLabel}>{t.invPOTotal}</span>
            <strong>{totalReceived}/{totalOrdered} {t.invpoItemsReceivedShort}</strong>
          </div>
          {lines.map(line => {
            const ordered = parseFloat(line.qty_ordered);
            const received = parseFloat(line.qty_received);
            const remaining = ordered - received;
            return (
              <article key={line.id} style={d.mobileLineCard}>
                <div style={d.mobileLineTop}>
                  <div>
                    <strong style={d.mobileLineTitle}>{line.item_name}</strong>
                    <span style={d.mobileLineSub}>{[line.sku, line.unit].filter(Boolean).join(' - ')}</span>
                  </div>
                  <strong style={{ ...d.mobileRemaining, color: remaining > 0 ? '#d97706' : '#059669' }}>
                    {remaining > 0 ? remaining : t.invpoDone}
                  </strong>
                </div>
                <div style={d.mobileMetrics}>
                  <div><span style={d.mobileLabel}>{t.invPOColQtyOrdered}</span><span style={d.mobileMetric}>{ordered}</span></div>
                  <div><span style={d.mobileLabel}>{t.invPOColQtyReceived}</span><span style={d.mobileMetric}>{received}</span></div>
                  <div><span style={d.mobileLabel}>{t.invPOColUnitCost}</span><span style={d.mobileMetric}>{line.unit_cost != null ? fmtMoney(line.unit_cost) : '-'}</span></div>
                </div>
              </article>
            );
          })}
        </div>
        </>
      )}

      {removeLineErr && <div style={d.lineErr}>{removeLineErr}</div>}

      {/* Add line form */}
      {addingLine && (
        <div style={d.addLineForm}>
          {lineErr && <div style={d.lineErr}>{lineErr}</div>}
          <div style={d.addLineRow}>
            <div style={d.addLineField}>
              <label style={d.editLabel}>{t.invTxColItem} *</label>
              <select style={d.editInput} value={newLine.item_id}
                onChange={e => {
                  const item = items.find(i => String(i.id) === e.target.value);
                  setNewLine(f => ({ ...f, item_id: e.target.value,
                    unit_cost: item?.unit_cost != null ? String(item.unit_cost) : f.unit_cost }));
                }}>
                <option value="">{t.selectPlaceholder} {t.invTxColItem}…</option>
                {items.map(i => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
              </select>
            </div>
            <div style={{ ...d.addLineField, maxWidth: 100 }}>
              <label style={d.editLabel}>{t.invPOQtyLabel}</label>
              <input style={d.editInput} type="number" min="0.001" step="any"
                value={newLine.qty_ordered} onChange={e => setNewLine(f => ({ ...f, qty_ordered: e.target.value }))} />
            </div>
            <div style={{ ...d.addLineField, maxWidth: 110 }}>
              <label style={d.editLabel}>{t.invPOColUnitCost}</label>
              <input style={d.editInput} type="number" min="0" step="0.01"
                value={newLine.unit_cost} onChange={e => setNewLine(f => ({ ...f, unit_cost: e.target.value }))}
                placeholder={t.optional} />
            </div>
            <div style={d.addLineField}>
              <label style={d.editLabel}>{t.notes}</label>
              <input style={d.editInput} value={newLine.notes}
                onChange={e => setNewLine(f => ({ ...f, notes: e.target.value }))} placeholder={t.optional} maxLength={500} />
            </div>
            <div style={d.addLineBtns}>
              <button style={d.cancelEditBtn} onClick={() => { setAddingLine(false); setLineErr(''); }}>{t.cancel}</button>
              <button style={{ ...d.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={addLine} disabled={saving}>
                {saving ? t.saving : t.invPOAddLineBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {receiveOpen && (
        <ReceiveModal
          po={{ ...po, lines }}
          locations={locations}
          onDone={handleReceiveDone}
          onClose={() => setReceiveOpen(false)}
        />
      )}
    </div>
  );
}

// ── Create PO Form ─────────────────────────────────────────────────────────────

function POCreateForm({ locations, suppliers, prefillItems, onSaved, onCancel }) {
  const t = useT();
  const [form, setForm] = useState({
    supplier_id: '',
    to_location_id: '',
    project_id: '',
    order_date: new Date().toISOString().slice(0,10),
    expected_date: '',
    reference_no: '',
    notes: '',
  });
  const [projects, setProjects] = useState([]);
  const [lines, setLines]   = useState(() =>
    (prefillItems || []).map(item => {
      const itemId = item.item_id || item.id;
      return {
        key: itemId,
        item_id: String(itemId),
        item_name: item.item_name,
        sku: item.sku,
        unit: item.unit,
        qty_ordered: String(item.reorder_qty > 0 ? item.reorder_qty : 1),
        unit_cost: item.unit_cost != null ? String(item.unit_cost) : '',
        notes: '',
      };
    })
  );
  const [items, setItems]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    api.get('/inventory/items?active=true').then(r => setItems(r.data)).catch(silentError('inventorypurchaseorders'));
    api.get('/work').then(r => setProjects(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const addLine = () => setLines(ls => [...ls, {
    key: Date.now(), item_id: '', item_name: '', sku: '', unit: '',
    qty_ordered: '1', unit_cost: '', notes: '',
  }]);

  const updateLine = (key, field, value) => setLines(ls =>
    ls.map(l => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      if (field === 'item_id') {
        const item = items.find(i => String(i.id) === value);
        updated.item_name = item?.name || '';
        updated.sku = item?.sku || '';
        updated.unit = item?.unit || '';
        if (item?.unit_cost != null && !updated.unit_cost) updated.unit_cost = String(item.unit_cost);
      }
      return updated;
    })
  );

  const removeLine = (key) => setLines(ls => ls.filter(l => l.key !== key));

  const submit = async () => {
    setError('');
    const validLines = lines.filter(l => l.item_id && parseFloat(l.qty_ordered) > 0);
    if (validLines.length === 0) return setError(t.invPOAddAtLeastOne);
    setSaving(true);
    try {
      const payload = {
        supplier_id: form.supplier_id ? parseInt(form.supplier_id) : null,
        to_location_id: form.to_location_id ? parseInt(form.to_location_id) : null,
        project_id: form.project_id ? parseInt(form.project_id) : null,
        order_date: form.order_date,
        expected_date: form.expected_date || null,
        reference_no: form.reference_no,
        notes: form.notes,
        lines: validLines.map(l => ({
          item_id: parseInt(l.item_id),
          qty_ordered: parseFloat(l.qty_ordered),
          unit_cost: l.unit_cost !== '' ? parseFloat(l.unit_cost) : null,
          notes: l.notes,
        })),
      };
      const r = await api.post('/inventory/purchase-orders', payload);
      onSaved(r.data);
    } catch (err) {
      setError(err.response?.data?.error || t.invPOFailedCreate);
    } finally { setSaving(false); }
  };

  return (
    <div style={c.wrap}>
      <h3 style={c.title}>{t.invPONewPO}</h3>
      {error && <div role="alert" style={c.error}>{error}</div>}

      <div style={c.row}>
        <div style={c.field}>
          <label style={c.label}>{t.invPOSupplier}</label>
          <select style={c.input} value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)}>
            <option value="">{t.none}</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={c.field}>
          <label style={c.label}>{t.invPODefaultReceiveLoc}</label>
          <select style={c.input} value={form.to_location_id} onChange={e => set('to_location_id', e.target.value)}>
            <option value="">{t.none}</option>
            {locations.filter(l => l.active).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div style={c.field}>
          <label style={c.label}>{t.invPOProject}</label>
          <select style={c.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">{t.none}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={c.field}>
          <label style={c.label}>{t.invPOOrderDate}</label>
          <input style={c.input} type="date" value={form.order_date} onChange={e => set('order_date', e.target.value)} />
        </div>
        <div style={c.field}>
          <label style={c.label}>{t.invPOExpectedDate}</label>
          <input style={c.input} type="date" value={form.expected_date} onChange={e => set('expected_date', e.target.value)} />
        </div>
        <div style={c.field}>
          <label style={c.label}>{t.invPOSupplierRef}</label>
          <input style={c.input} value={form.reference_no} onChange={e => set('reference_no', e.target.value)} placeholder={t.optional} />
        </div>
      </div>

      <div style={c.field}>
        <label style={c.label}>{t.notes}</label>
        <textarea style={{ ...c.input, minHeight: 52, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} maxLength={1000} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.notes || '').length}/1000</div>
      </div>

      <div style={c.linesHeader}>
        <div style={c.linesTitle}>{t.invPOLineItems}</div>
        <button style={c.addLineBtn} onClick={addLine}>{t.invPOAddItem}</button>
      </div>

      {lines.length === 0 ? (
        <div style={c.emptyLines}>{t.invPONoItems}</div>
      ) : (
        <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #e5e7eb', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={c.th}>{t.invTxColItem}</th>
                <th style={{ ...c.th, width: 90 }}>{t.invPOQtyLabel}</th>
                <th style={{ ...c.th, width: 110 }}>{t.invPOColUnitCost}</th>
                <th style={c.th}>{t.notes}</th>
                <th style={{ ...c.th, width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={line.key} style={{ background: i % 2 === 0 ? '#fafafa' : '#fff', borderBottom: '1px solid #f3f4f6' }}>
                  <td style={c.td}>
                    <select style={c.cellInput} value={line.item_id}
                      onChange={e => updateLine(line.key, 'item_id', e.target.value)}>
                      <option value="">{t.selectPlaceholder} {t.invTxColItem}…</option>
                      {items.map(i => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
                    </select>
                  </td>
                  <td style={c.td}>
                    <input style={{ ...c.cellInput, textAlign: 'right' }} type="number" min="0.001" step="any"
                      value={line.qty_ordered} onChange={e => updateLine(line.key, 'qty_ordered', e.target.value)} />
                  </td>
                  <td style={c.td}>
                    <input style={{ ...c.cellInput, textAlign: 'right' }} type="number" min="0" step="0.01"
                      value={line.unit_cost} onChange={e => updateLine(line.key, 'unit_cost', e.target.value)}
                      placeholder="—" />
                  </td>
                  <td style={c.td}>
                    <input style={c.cellInput} value={line.notes}
                      onChange={e => updateLine(line.key, 'notes', e.target.value)} placeholder={t.optional} maxLength={500} />
                  </td>
                  <td style={c.td}>
                    <button style={c.removeBtn} aria-label={t.removeLine} onClick={() => removeLine(line.key)}>X</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={c.actions}>
        <button style={c.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button style={{ ...c.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submit} disabled={saving}>
          {saving ? t.invPOCreating : t.invPOCreateDraft}
        </button>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function InventoryPurchaseOrders({ locations, suppliers: suppliersProp, prefillLowStock, onPrefillHandled }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const STATUS = useStatus(t);
  const [view, setView]         = useState('list'); // 'list' | 'create' | 'detail'
  const [pos, setPos]           = useState([]);
  const [posTotal, setPosTotal] = useState(0);
  const [posOffset, setPosOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [loadDetailError, setLoadDetailError] = useState('');
  const [poSearch, setPoSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');
  const PO_PAGE = 100;
  const [suppliers, setSuppliers] = useState(suppliersProp || []);
  const [prefillItems, setPrefillItems] = useState(null); // null = no prefill

  // Load suppliers if not provided
  useEffect(() => {
    if (!suppliersProp || suppliersProp.length === 0) {
      api.get('/inventory/suppliers').then(r => setSuppliers(r.data)).catch(silentError('inventorypurchaseorders'));
    }
  }, []);

  // Handle low-stock reorder prefill
  useEffect(() => {
    if (!prefillLowStock) return;
    api.get('/inventory/stock/low').then(r => {
      setPrefillItems(r.data);
      setView('create');
      onPrefillHandled?.();
    }).catch(() => {
      setView('create');
      setPrefillItems([]);
      onPrefillHandled?.();
    });
  }, [prefillLowStock]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPosOffset(0);
    try {
      const params = new URLSearchParams({ limit: PO_PAGE, offset: 0 });
      if (poSearch.trim()) params.set('q', poSearch.trim());
      if (filterStatus) params.set('status', filterStatus);
      if (filterSupplier) params.set('supplier_id', filterSupplier);
      const r = await api.get(`/inventory/purchase-orders?${params}`);
      setPos(r.data.orders);
      setPosTotal(r.data.total);
    } catch { setError(t.invPOFailedLoad); }
    finally { setLoading(false); }
  }, [poSearch, filterStatus, filterSupplier]);

  const loadMorePos = async () => {
    const nextOffset = posOffset + PO_PAGE;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: PO_PAGE, offset: nextOffset });
      if (poSearch.trim()) params.set('q', poSearch.trim());
      if (filterStatus) params.set('status', filterStatus);
      if (filterSupplier) params.set('supplier_id', filterSupplier);
      const r = await api.get(`/inventory/purchase-orders?${params}`);
      setPos(prev => [...prev, ...r.data.orders]);
      setPosOffset(nextOffset);
    } catch { /* non-fatal */ }
    finally { setLoadingMore(false); }
  };

  const hasPOFilters = Boolean(poSearch.trim() || filterStatus || filterSupplier);
  const clearPOFilters = () => {
    setPoSearch('');
    setFilterStatus('');
    setFilterSupplier('');
  };

  useEffect(() => { if (view === 'list') load(); }, [load, view]);

  const openDetail = async (po) => {
    setLoadDetailError('');
    try {
      const r = await api.get(`/inventory/purchase-orders/${po.id}`);
      setSelected(r.data);
      setView('detail');
    } catch { setLoadDetailError(t.invPOFailedLoadDetails); }
  };

  const handleSaved = (newPo) => {
    setPrefillItems(null);
    openDetail(newPo);
    load();
  };

  const handleBack = (reload) => {
    setSelected(null);
    setView('list');
    if (reload) load();
  };

  if (view === 'create') {
    return (
      <POCreateForm
        locations={locations}
        suppliers={suppliers}
        prefillItems={prefillItems}
        onSaved={handleSaved}
        onCancel={() => { setPrefillItems(null); setView('list'); }}
      />
    );
  }

  if (view === 'detail' && selected) {
    return (
      <PODetail
        po={selected}
        locations={locations}
        suppliers={suppliers}
        onBack={handleBack}
        onUpdate={load}
      />
    );
  }

  // List view
  return (
    <div style={l.wrap}>
      <div style={l.toolbar}>
        <input
          type="search"
          style={l.searchInput}
          value={poSearch}
          onChange={e => setPoSearch(e.target.value)}
          placeholder={t.invpoSearchOrders}
        />
        <select style={l.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">{t.invPOAllStatuses}</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {suppliers.length > 0 && (
          <select style={l.select} value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)}>
            <option value="">{t.invPOAllSuppliers}</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {hasPOFilters && (
          <button style={l.clearBtn} onClick={clearPOFilters}>{t.invpoClear}</button>
        )}
        <button style={l.createBtn} onClick={() => { setPrefillItems([]); setView('create'); }}>{t.invPONewPOBtn}</button>
      </div>

      {!loading && !error && (
        <div style={l.filterMeta}>
          {hasPOFilters ? `${t.invpoShowing} ${pos.length} ${t.invpoOf} ${posTotal} ${t.invpoMatchingOrders}` : `${posTotal} ${t.invpoOrders}`}
        </div>
      )}

      {error && <div role="alert" style={l.error}>{error}</div>}
      {loadDetailError && <div style={l.error}>{loadDetailError}</div>}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : pos.length === 0 ? (
        <div style={l.empty}>
          <p>{hasPOFilters ? t.invpoNoMatchFilters : t.invPONoPOs}</p>
        </div>
      ) : (
        <>
        <div style={l.list}>
          {pos.map(po => {
            const ordered  = parseFloat(po.total_ordered  || 0);
            const received = parseFloat(po.total_received || 0);
            const pct = ordered > 0 ? Math.round((received / ordered) * 100) : 0;
            return (
              <div key={po.id} style={l.card} onClick={() => openDetail(po)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && openDetail(po)}>
                <div style={l.cardTop}>
                  <div style={l.cardLeft}>
                    <div style={l.cardPo}>{po.po_number}</div>
                    <div style={l.cardMeta}>
                      {po.supplier_name || <em style={{ color: '#6b7280' }}>{t.invPONoSupplier}</em>}
                      {' · '}
                      {formatDate(po.created_at, locale)}
                      {po.expected_date && ` · ${t.invPOExpected} ${formatDate(po.expected_date, locale)}`}
                    </div>
                  </div>
                  <div style={l.cardRight}>
                    <StatusBadge status={po.status} />
                    <span style={l.lineCount}>{po.line_count} {t.invPOItems}</span>
                  </div>
                </div>
                {po.status !== 'draft' && po.status !== 'cancelled' && ordered > 0 && (
                  <div style={l.cardProgress}>
                    <div style={l.progressBar}>
                      <div style={{ ...l.progressFill, width: `${pct}%`,
                        background: pct >= 100 ? '#059669' : '#2563eb' }} />
                    </div>
                    <span style={l.progressText}>{received}/{ordered} {t.invPOColReceived}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {pos.length < posTotal && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <button style={{ ...l.loadMoreBtn, ...(loadingMore ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={loadMorePos} disabled={loadingMore}>
              {loadingMore ? t.loading : t.loadMore}
            </button>
            <span style={{ marginLeft: 10, fontSize: 13, color: '#6b7280' }}>{pos.length} / {posTotal}</span>
          </div>
        )}
        </>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Receive modal
const m = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 16 },
  modal:     { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 580, width: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title:     { fontSize: 16, fontWeight: 700, color: '#111827' },
  closeBtn:  { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0 },
  error:     { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 },
  field:     { marginBottom: 14 },
  label:     { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:     { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box' },
  th:        { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  td:        { padding: '8px 10px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  qtyInput:  { width: 80, padding: '4px 6px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, textAlign: 'right' },
  actions:   { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  confirmBtn:{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};

// Detail
const d = {
  wrap:         { padding: 16 },
  backBtn:      { background: 'none', border: 'none', color: '#2563eb', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginBottom: 16, padding: 0 },
  headerCard:   { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 },
  headerTop:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 },
  poNumber:     { fontSize: 20, fontWeight: 800, color: '#111827' },
  poMeta:       { fontSize: 12, color: '#6b7280', marginTop: 2 },
  headerActions:{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' },
  nextActionHint: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', textAlign: 'right', maxWidth: 260 },
  editBtn:      { padding: '7px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  cancelEditBtn:{ padding: '7px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  submitBtn:    { padding: '7px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  receiveBtn:   { padding: '7px 16px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  cancelBtn:    { padding: '7px 14px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fee2e2', color: '#dc2626', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  confirmCancelBtn: { padding: '7px 14px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  smallCancelBtn: { padding: '7px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 13, cursor: 'pointer' },
  confirmLineRemoveBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  error:        { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '8px 12px', marginTop: 8, fontSize: 13 },
  infoGrid:     { display: 'flex', flexWrap: 'wrap', gap: '8px 24px', marginTop: 4 },
  infoItem:     { display: 'flex', flexDirection: 'column', gap: 2 },
  infoLabel:    { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  infoValue:    { fontSize: 14, color: '#374151' },
  editGrid:     { display: 'flex', flexWrap: 'wrap', gap: '8px 12px', marginTop: 8 },
  editField:    { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 140 },
  editLabel:    { fontSize: 11, fontWeight: 700, color: '#6b7280' },
  editInput:    { padding: '7px 9px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, width: '100%', boxSizing: 'border-box', background: '#fff' },
  progress:     { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 },
  progressBar:  { flex: 1, height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', background: '#2563eb', borderRadius: 3, transition: 'width 0.3s' },
  progressText: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' },
  linesHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  linesTitle:   { fontSize: 15, fontWeight: 700, color: '#374151' },
  addLineBtn:   { padding: '6px 14px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  emptyLines:   { fontSize: 13, color: '#6b7280', padding: '16px 0' },
  tableWrap:    { overflowX: 'auto', borderRadius: 10, border: '1px solid #e5e7eb', marginBottom: 16 },
  table:        { width: '100%', borderCollapse: 'collapse', minWidth: 520 },
  thead:        { background: '#f9fafb' },
  th:           { padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:          { borderBottom: '1px solid #f3f4f6' },
  rowEven:      { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:           { padding: '10px 12px', fontSize: 14, color: '#374151' },
  totalRow:     { background: '#f0fdf4', borderTop: '2px solid #d1fae5' },
  mobileLineCards: { display: 'none' },
  mobileLineSummary: { background: '#111827', color: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 3 },
  mobileSummaryLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 },
  mobileLineCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  mobileLineTop: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start', marginBottom: 12 },
  mobileLineTitle: { display: 'block', fontSize: 16, color: '#111827', lineHeight: 1.25 },
  mobileLineSub: { display: 'block', marginTop: 3, fontSize: 12, color: '#64748b', lineHeight: 1.3 },
  mobileRemaining: { fontSize: 16, whiteSpace: 'nowrap', textAlign: 'right' },
  mobileMetrics: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, paddingTop: 10, borderTop: '1px solid #f1f5f9' },
  mobileLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 },
  mobileMetric: { display: 'block', fontSize: 13, color: '#334155', lineHeight: 1.35, fontWeight: 700 },
  removeBtn:    { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 4px' },
  addLineForm:  { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 16 },
  lineErr:      { background: '#fee2e2', color: '#dc2626', borderRadius: 7, padding: '6px 10px', marginBottom: 10, fontSize: 13 },
  addLineRow:   { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' },
  addLineField: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 140 },
  addLineBtns:  { display: 'flex', gap: 6, alignSelf: 'flex-end' },
};

// Create form
const c = {
  wrap:       { padding: 16 },
  title:      { fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 16 },
  error:      { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 },
  row:        { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field:      { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160, marginBottom: 12 },
  label:      { fontSize: 12, fontWeight: 600, color: '#374151' },
  input:      { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', width: '100%', boxSizing: 'border-box' },
  linesHeader:{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, marginTop: 4 },
  linesTitle: { fontSize: 14, fontWeight: 700, color: '#374151' },
  addLineBtn: { padding: '6px 14px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  emptyLines: { fontSize: 13, color: '#6b7280', padding: '12px 0', marginBottom: 16 },
  th:         { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '2px solid #e5e7eb', background: '#f9fafb' },
  td:         { padding: '6px 8px', borderBottom: '1px solid #f3f4f6' },
  cellInput:  { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' },
  removeBtn:  { background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 14, padding: '3px 5px' },
  actions:    { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  cancelBtn:  { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  saveBtn:    { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};

// List
const l = {
  wrap:         { padding: 16 },
  toolbar:      { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 },
  searchInput:  { flex: '1 1 220px', minWidth: 190, padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#111827' },
  select:       { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151' },
  clearBtn:     { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer' },
  filterMeta:   { margin: '-6px 0 14px', fontSize: 13, color: '#6b7280' },
  loadMoreBtn:  { padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  createBtn:    { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginLeft: 'auto', whiteSpace: 'nowrap' },
  error:        { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:        { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:    { fontSize: 40, marginBottom: 12 },
  list:         { display: 'flex', flexDirection: 'column', gap: 10 },
  card:         { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, cursor: 'pointer', transition: 'border-color 0.15s' },
  cardTop:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  cardLeft:     { flex: 1, minWidth: 0 },
  cardPo:       { fontSize: 16, fontWeight: 800, color: '#111827', fontFamily: 'monospace' },
  cardMeta:     { fontSize: 12, color: '#6b7280', marginTop: 2 },
  cardRight:    { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  lineCount:    { fontSize: 12, color: '#6b7280' },
  cardProgress: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 },
  progressBar:  { flex: 1, height: 5, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
  progressText: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' },
};
