import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { useCents } from '../hooks/useMoney';
import { SkeletonList, SkeletonBlock } from './Skeleton';
import AssetLabelModal from './inventory/AssetLabelModal';

function today() { return new Date().toLocaleDateString('en-CA'); }

function fmtEquipmentDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const parsed = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Rate-period picker shared by the rent-out and operating rate fields.
function UnitSelect({ t, value, onChange }) {
  return (
    <select style={styles.unitSelect} value={value} onChange={e => onChange(e.target.value)} aria-label={t.eqPerUnit}>
      <option value="hour">{t.eqPerUnit} {t.eqUnitHour}</option>
      <option value="day">{t.eqPerUnit} {t.eqUnitDay}</option>
      <option value="week">{t.eqPerUnit} {t.eqUnitWeek}</option>
      <option value="month">{t.eqPerUnit} {t.eqUnitMonth}</option>
    </select>
  );
}

// ── Equipment Item Form (admin) ────────────────────────────────────────────────

function ItemForm({ initial, onSaved, onCancel }) {
  const t = useT();
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    type: initial?.type ?? '',
    unit_number: initial?.unit_number ?? '',
    maintenance_interval_hours: initial?.maintenance_interval_hours ?? '',
    notes: initial?.notes ?? '',
    purchase_cost: initial?.purchase_cost ?? '',
    rent_out_rate: initial?.rent_out_rate ?? '',
    rent_out_unit: initial?.rent_out_unit ?? 'day',
    mobilization_cost: initial?.mobilization_cost ?? '',
    operating_rate: initial?.operating_rate ?? '',
    operating_unit: initial?.operating_unit ?? 'hour',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isEdit = !!initial?.id;

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.name.trim()) { setError(t.equipmentNameRequired); return; }
    setSaving(true); setError('');
    try {
      const r = isEdit
        ? await api.patch(`/equipment/${initial.id}`, { ...form, updated_at: initial.updated_at })
        : await api.post('/equipment', form);
      onSaved(r.data, isEdit);
    } catch (err) {
      const msg = err.response?.status === 409
        ? t.concurrentModification
        : err.response?.data?.error || t.failedToSave;
      setError(msg);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h3 style={styles.formTitle}>{isEdit ? t.editEquipment : t.addEquipmentTitle}</h3>
      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-name" style={styles.label}>{t.name} *</label>
          <input id="eq-name" style={styles.input} type="text" placeholder={t.equipmentNamePlaceholder} value={form.name} onChange={e => set('name', e.target.value)} required maxLength={255} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-type" style={styles.label}>{t.equipmentType}</label>
          <input id="eq-type" style={styles.input} type="text" placeholder={t.equipmentTypePlaceholder} value={form.type} onChange={e => set('type', e.target.value)} maxLength={100} />
        </div>
      </div>
      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-unit" style={styles.label}>{t.unitSerial}</label>
          <input id="eq-unit" style={styles.input} type="text" placeholder={t.equipmentUnitPlaceholder} value={form.unit_number} onChange={e => set('unit_number', e.target.value)} maxLength={100} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-maintenance" style={styles.label}>{t.maintenanceEvery} <span style={styles.optional}>({t.optional})</span></label>
          <input id="eq-maintenance" style={styles.input} type="number" min="0" placeholder={t.equipmentIntervalPlaceholder} value={form.maintenance_interval_hours} onChange={e => set('maintenance_interval_hours', e.target.value)} />
        </div>
      </div>
      <div style={styles.fieldGroup}>
        <label htmlFor="eq-notes" style={styles.label}>{t.notes}</label>
        <input id="eq-notes" style={styles.input} type="text" placeholder={t.optionalNotes} value={form.notes} onChange={e => set('notes', e.target.value)} maxLength={1000} />
      </div>

      <div style={styles.ratesSection}>
        <div style={styles.ratesHeader}>{t.eqRatesSection}</div>
        <p style={styles.ratesHint}>{t.eqRatesHint}</p>
        <div style={styles.row}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t.eqPurchaseCost}</label>
            <input style={styles.input} type="number" min="0" step="0.01" value={form.purchase_cost} onChange={e => set('purchase_cost', e.target.value)} />
          </div>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t.eqRentOutRate}</label>
            <div style={styles.rateRow}>
              <input style={styles.input} type="number" min="0" step="0.01" value={form.rent_out_rate} onChange={e => set('rent_out_rate', e.target.value)} />
              <UnitSelect t={t} value={form.rent_out_unit} onChange={v => set('rent_out_unit', v)} />
            </div>
            <span style={styles.subHint}>{t.eqRentOutHint}</span>
          </div>
        </div>
        <div style={styles.row}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t.eqMobilization}</label>
            <input style={styles.input} type="number" min="0" step="0.01" value={form.mobilization_cost} onChange={e => set('mobilization_cost', e.target.value)} />
            <span style={styles.subHint}>{t.eqMobilizationHint}</span>
          </div>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t.eqOperatingRate}</label>
            <div style={styles.rateRow}>
              <input style={styles.input} type="number" min="0" step="0.01" value={form.operating_rate} onChange={e => set('operating_rate', e.target.value)} />
              <UnitSelect t={t} value={form.operating_unit} onChange={v => set('operating_unit', v)} />
            </div>
            <span style={styles.subHint}>{t.eqOperatingHint}</span>
          </div>
        </div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : isEdit ? t.saveChanges : t.addEquipmentTitle}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Log Hours Form ─────────────────────────────────────────────────────────────

function LogHoursForm({ item, projects, onLogged, onCancel }) {
  const t = useT();
  const { user } = useAuth();
  const [form, setForm] = useState({
    log_date: today(),
    hours: '',
    project_id: '',
    operator_name: user?.full_name ?? '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.hours || parseFloat(form.hours) <= 0) { setError(t.hoursRequiredMsg); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post(`/equipment/${item.id}/hours`, form);
      if (r.data?.offline) {
        onLogged(item.id, { id: 'pending-' + Date.now(), pending: true, ...form, project_name: '' }, parseFloat(form.hours));
        return;
      }
      onLogged(item.id, r.data, parseFloat(form.hours));
    } catch (err) {
      setError(err.response?.data?.error || t.failedToLogHours);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h3 style={styles.formTitle}>{t.logHoursTitle} — {item.name}</h3>
      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-log-date" style={styles.label}>{t.date} *</label>
          <input id="eq-log-date" style={styles.input} type="date" value={form.log_date} onChange={e => set('log_date', e.target.value)} required max={new Date().toLocaleDateString('en-CA')} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-hours" style={styles.label}>{t.hours} *</label>
          <input id="eq-hours" style={{ ...styles.input, maxWidth: 110 }} type="number" min="0.5" step="0.5" placeholder="0.0" value={form.hours} onChange={e => set('hours', e.target.value)} required />
        </div>
      </div>
      <div style={styles.row}>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label htmlFor="eq-project" style={styles.label}>Project</label>
            <select id="eq-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No project`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div style={styles.fieldGroup}>
          <label htmlFor="eq-operator" style={styles.label}>{t.operatorField}</label>
          <input id="eq-operator" style={styles.input} type="text" placeholder={t.operatorField} value={form.operator_name} onChange={e => set('operator_name', e.target.value)} maxLength={255} />
        </div>
      </div>
      <div style={styles.fieldGroup}>
        <label htmlFor="eq-log-notes" style={styles.label}>{t.notes} <span style={styles.optional}>({t.optional})</span></label>
        <input id="eq-log-notes" style={styles.input} type="text" placeholder={t.optionalNotes} value={form.notes} onChange={e => set('notes', e.target.value)} maxLength={1000} />
      </div>
      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : t.logHoursBtn}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Equipment Card ─────────────────────────────────────────────────────────────

function EquipmentCard({ item, projects, isAdmin, onEdit, onDeleted, onHoursLogged }) {
  const t = useT();
  const { user } = useAuth();
  const formatCents = useCents();
  const locale = langToLocale(user?.language);
  // Actual usage cost is derived only when the operating rate is hourly — the
  // hours log records hours, so an hourly rate multiplies cleanly. Non-hourly
  // operating rates show hours only (no assumed hours-per-day conversion).
  const hourlyRate = (item.operating_unit === 'hour' && item.operating_rate != null)
    ? parseFloat(item.operating_rate) : null;
  const costCents = h => (hourlyRate != null ? Math.round(parseFloat(h.hours) * hourlyRate * 100) : null);
  const [expanded, setExpanded] = useState(false);
  const [loggingHours, setLoggingHours] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const [hours, setHours] = useState([]);
  const [loadingHours, setLoadingHours] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = useState(null);
  const [entryDeleteError, setEntryDeleteError] = useState('');

  const totalHours = parseFloat(item.total_hours || 0);
  const interval = item.maintenance_interval_hours;
  const maintenancePct = interval ? (totalHours / interval) : null;
  const nearMaintenance = maintenancePct !== null && maintenancePct >= 0.85;
  const overMaintenance = maintenancePct !== null && maintenancePct >= 1.0;

  const loadHours = async () => {
    setLoadingHours(true);
    try {
      const r = await api.get(`/equipment/${item.id}/hours`);
      setHours(r.data);
    } finally { setLoadingHours(false); }
  };

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && hours.length === 0 && !loadingHours) loadHours();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try { await api.delete(`/equipment/${item.id}`); onDeleted(item.id); }
    catch { setDeleteError(t.failedToRemove); setConfirmingDelete(false); }
    finally { setDeleting(false); }
  };

  const handleDeleteEntry = async (entryId, entryHours) => {
    setEntryDeleteError('');
    try {
      await api.delete(`/equipment/hours/${entryId}`);
      setHours(prev => prev.filter(h => h.id !== entryId));
      onHoursLogged(item.id, -parseFloat(entryHours));
      setPendingDeleteEntryId(null);
    } catch { setEntryDeleteError(t.failedToDeleteEntry); setPendingDeleteEntryId(null); }
  };

  return (
    <div style={{ ...styles.card, ...(overMaintenance ? styles.cardOverdue : nearMaintenance ? styles.cardWarning : {}) }}>
      <div style={styles.cardHeader} onClick={handleExpand} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && handleExpand()}>
        <div style={styles.cardLeft}>
          <div style={styles.itemName}>{item.name}</div>
          <div style={styles.itemMeta}>
            {item.type && <span>{item.type}</span>}
            {item.unit_number && <span style={styles.unitTag}>{item.unit_number}</span>}
            {item.last_logged && <span>{t.lastLogged} {fmtEquipmentDate(item.last_logged, locale)}</span>}
          </div>
        </div>
        <div style={styles.cardRight}>
          <div style={styles.hoursDisplay}>
            <span style={styles.hoursNum}>{totalHours.toFixed(1)}</span>
            <span style={styles.hoursLabel}>hrs</span>
          </div>
          {interval && (
            <div style={styles.maintenanceBar}>
              <div style={{
                ...styles.maintenanceFill,
                width: `${Math.min(maintenancePct * 100, 100)}%`,
                background: overMaintenance ? '#ef4444' : nearMaintenance ? '#f59e0b' : '#10b981',
              }} />
              <span style={{ ...styles.maintenanceText, color: overMaintenance ? '#ef4444' : nearMaintenance ? '#d97706' : '#6b7280' }}>
                {overMaintenance ? `⚠ ${t.overdueLabel}` : nearMaintenance ? `⚠ ${t.dueSoon}` : `/ ${interval}h`}
              </span>
            </div>
          )}
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {loggingHours ? (
            <LogHoursForm
              item={item}
              projects={projects}
              onLogged={(id, entry, hrs) => {
                setHours(prev => [entry, ...prev]);
                onHoursLogged(id, hrs);
                setLoggingHours(false);
              }}
              onCancel={() => setLoggingHours(false)}
            />
          ) : (
            <div style={styles.bodyActions}>
              <button style={styles.logBtn} onClick={() => setLoggingHours(true)}>+ {t.logHoursBtn}</button>
              <button style={styles.editBtn} onClick={() => setShowLabel(true)}>🏷 {t.eqLabelBtn}</button>
              {isAdmin && (
                <>
                  <button style={styles.editBtn} onClick={() => onEdit(item)}>{t.edit}</button>
                  {confirmingDelete ? (
                    <>
                      <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? '…' : t.confirm}</button>
                      <button style={styles.cancelBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
                      {deleteError && <span style={styles.inlineError}>{deleteError}</span>}
                    </>
                  ) : (
                    <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.removeBtn}</button>
                  )}
                </>
              )}
            </div>
          )}
          {showLabel && <AssetLabelModal asset={item} onClose={() => setShowLabel(false)} />}

          {!loggingHours && (
            <div style={styles.hoursHistory}>
              <div style={styles.historyTitle}>{t.hoursHistory}</div>
              {loadingHours ? (
                <SkeletonBlock width="100%" height={48} style={{ marginTop: 8 }} />
              ) : hours.length === 0 ? (
                <p style={styles.hint}>{t.noHoursLogged}</p>
              ) : (
                <table style={styles.histTable}>
                  <thead>
                    <tr>
                      <th style={styles.hth}>{t.date}</th>
                      <th style={styles.hth}>{t.hours}</th>
                      {hourlyRate != null && <th style={{ ...styles.hth, textAlign: 'right' }}>{t.eqUsageCost}</th>}
                      <th style={styles.hth}>{t.operatorField}</th>
                      <th style={styles.hth}>Project</th>
                      <th style={styles.hth}>{t.notes}</th>
                      <th style={styles.hth}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {hours.map(h => (
                      <tr key={h.id}>
                        <td style={styles.htd}>{fmtEquipmentDate(h.log_date, locale)}</td>
                        <td style={{ ...styles.htd, fontWeight: 700 }}>
                          {parseFloat(h.hours).toFixed(1)}
                          {h.pending && <span style={styles.pendingBadge}>⏳</span>}
                        </td>
                        {hourlyRate != null && <td style={{ ...styles.htd, textAlign: 'right' }}>{formatCents(costCents(h))}</td>}
                        <td style={styles.htd}>{h.operator_name || '—'}</td>
                        <td style={styles.htd}>{h.project_name || '—'}</td>
                        <td style={{ ...styles.htd, color: '#6b7280' }}>{h.notes || ''}</td>
                        <td style={styles.htd}>
                          {!h.pending && (pendingDeleteEntryId === h.id ? (
                            <>
                              <button style={styles.confirmEntryDeleteBtn} onClick={() => handleDeleteEntry(h.id, h.hours)}>{t.confirm}</button>
                              <button style={styles.cancelEntryBtn} onClick={() => setPendingDeleteEntryId(null)}>{t.cancel}</button>
                            </>
                          ) : (
                            <button style={styles.delEntryBtn} aria-label={t.deleteEntry} onClick={() => setPendingDeleteEntryId(h.id)}>✕</button>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {hourlyRate != null && hours.length > 0 && (
                    <tfoot>
                      <tr>
                        <td style={{ ...styles.htd, fontWeight: 700 }}>{t.eqTotal}</td>
                        <td style={{ ...styles.htd, fontWeight: 700 }}>
                          {hours.reduce((s, h) => s + (parseFloat(h.hours) || 0), 0).toFixed(1)}
                        </td>
                        <td style={{ ...styles.htd, fontWeight: 800, textAlign: 'right' }}>
                          {formatCents(hours.reduce((s, h) => s + (costCents(h) || 0), 0))}
                        </td>
                        <td style={styles.htd} colSpan={3}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              )}
              {entryDeleteError && <p style={styles.inlineError}>{entryDeleteError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function EquipmentLog({ projects }) {
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    api.get('/equipment').then(r => setItems(r.data)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) api.get('/equipment').then(r => setItems(r.data)); }); }, [onSync]);

  const handleSaved = (item, isEdit) => {
    if (isEdit) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, ...item } : i));
      setEditing(null);
    } else {
      setItems(prev => [...prev, item]);
      setShowForm(false);
    }
  };

  const handleHoursLogged = (itemId, delta) => {
    setItems(prev => prev.map(i =>
      i.id === itemId
        ? { ...i, total_hours: Math.max(0, parseFloat(i.total_hours || 0) + delta).toFixed(2) }
        : i
    ));
  };

  const totalHrs = useMemo(() => items.reduce((s, i) => s + parseFloat(i.total_hours || 0), 0), [items]);
  const overdueCount = useMemo(() => items.filter(i => i.maintenance_interval_hours && parseFloat(i.total_hours) >= i.maintenance_interval_hours).length, [items]);

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>{t.equipmentHours}</h1>
          <p style={styles.summary}>
            {items.length} · {totalHrs.toFixed(0)} {t.totalHoursLogged}
            {overdueCount > 0 && <span style={styles.overdueNote}> · {overdueCount} {t.maintenanceOverdue}</span>}
          </p>
        </div>
        {isAdmin && !showForm && !editing && (
          <button style={styles.newBtn} onClick={() => setShowForm(true)}>{t.addEquipment}</button>
        )}
      </div>

      {(showForm || editing) && (
        <div style={styles.formCard}>
          <ItemForm
            initial={editing || null}
            onSaved={handleSaved}
            onCancel={() => { setShowForm(false); setEditing(null); }}
          />
        </div>
      )}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : items.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No equipment yet</p>
          <p style={styles.emptyText}>{isAdmin ? t.noEquipmentAdmin : t.noEquipmentWorker}</p>
          {isAdmin && !showForm && !editing && <button type="button" style={styles.emptyCtaBtn} onClick={() => setShowForm(true)}>{t.addEquipment}</button>}
        </div>
      ) : (
        <div style={styles.list}>
          {items.map(item => (
            <EquipmentCard
              key={item.id}
              item={item}
              projects={projects}
              isAdmin={isAdmin}
              onEdit={i => { setEditing(i); setShowForm(false); }}
              onDeleted={id => setItems(prev => prev.filter(i => i.id !== id))}
              onHoursLogged={handleHoursLogged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  ratesSection: { marginTop: 18, paddingTop: 16, borderTop: '1px solid #e5e7eb' },
  ratesHeader: { fontSize: 13, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.04em' },
  ratesHint: { fontSize: 12, color: '#6b7280', margin: '4px 0 12px' },
  rateRow: { display: 'flex', gap: 8, alignItems: 'stretch' },
  unitSelect: { border: '1px solid #d1d5db', borderRadius: 8, padding: '0 8px', fontSize: 13, background: '#fff', color: '#374151', flexShrink: 0 },
  subHint: { display: 'block', fontSize: 11, color: '#9ca3af', marginTop: 3 },
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  overdueNote: { color: '#ef4444', fontWeight: 700 },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  emptyCtaBtn: { marginTop: 14, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  // Card
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardWarning: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #f59e0b' },
  cardOverdue: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #ef4444' },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', cursor: 'pointer', gap: 12 },
  cardLeft: { flex: 1, minWidth: 0 },
  itemName: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4 },
  itemMeta: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  unitTag: { background: '#f3f4f6', padding: '1px 7px', borderRadius: 8, fontWeight: 600 },
  cardRight: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  hoursDisplay: { display: 'flex', alignItems: 'baseline', gap: 2 },
  hoursNum: { fontSize: 20, fontWeight: 800, color: '#111827' },
  hoursLabel: { fontSize: 11, color: '#6b7280' },
  maintenanceBar: { display: 'flex', flexDirection: 'column', gap: 2, width: 80 },
  maintenanceFill: { height: 4, borderRadius: 2 },
  maintenanceText: { fontSize: 10, fontWeight: 600 },
  chevron: { fontSize: 10, color: '#6b7280' },
  cardBody: { padding: '0 16px 14px', borderTop: '1px solid #f3f4f6' },
  bodyActions: { display: 'flex', gap: 8, marginTop: 12, marginBottom: 14 },
  logBtn: { background: '#059669', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  editBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '7px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '7px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  confirmEntryDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  cancelEntryBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 11, cursor: 'pointer', padding: '2px 4px' },
  inlineError: { fontSize: 12, color: '#ef4444', margin: '4px 0 0' },
  hoursHistory: { marginTop: 4 },
  historyTitle: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', marginBottom: 8 },
  histTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  hth: { textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 8px', borderBottom: '1px solid #e5e7eb' },
  htd: { padding: '6px 8px', borderBottom: '1px solid #f9fafb', color: '#374151' },
  delEntryBtn: { background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 12, padding: '2px 4px' },
  pendingBadge: { fontSize: 9, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 5px', borderRadius: 6, marginLeft: 6, verticalAlign: 'middle' },
  // Form
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 180 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  optional: { fontWeight: 400, color: '#6b7280' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '11px 22px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '11px 22px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
};
