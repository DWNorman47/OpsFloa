// Booking admin — manage appointment types, shift types, and per-user
// bookable windows. Same pattern as the other admin pages in this
// session: self-contained, tab-based, no shared component library.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import AppHeader from '../components/AppHeader';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import Pagination from '../components/Pagination';
import SortHeader, { sortRows } from '../components/SortHeader';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { formatDateTime } from '../utils/format';
import { silentError } from '../errorReporter';
import { useT } from '../hooks/useT';

const LOCATION_KINDS = [
  { value: 'phone',  labelKey: 'bkLocPhone' },
  { value: 'video',  labelKey: 'bkLocVideo' },
  { value: 'onsite', labelKey: 'bkLocOnsite' },
  { value: 'office', labelKey: 'bkLocOffice' },
  { value: 'other',  labelKey: 'bkLocOther' },
];

const STATUS_COLORS = {
  booked:       { bg: '#dbeafe', fg: '#1d4ed8', labelKey: 'bkStatusBooked' },
  confirmed:    { bg: '#d1fae5', fg: '#065f46', labelKey: 'bkStatusConfirmed' },
  completed:    { bg: '#a7f3d0', fg: '#065f46', labelKey: 'bkStatusCompleted' },
  cancelled:    { bg: '#fee2e2', fg: '#991b1b', labelKey: 'bkStatusCancelled' },
  no_show:      { bg: '#fef3c7', fg: '#92400e', labelKey: 'bkStatusNoShow' },
  rescheduled:  { bg: '#e5e7eb', fg: '#6b7280', labelKey: 'bkStatusRescheduled' },
};

// Weekday label keys, indexed Sun..Sat. Resolved to localized strings
// in-render via t[...]; values sent to the API stay numeric (0..6).
const WEEKDAY_LABEL_KEYS = ['bkDaySun', 'bkDayMon', 'bkDayTue', 'bkDayWed', 'bkDayThu', 'bkDayFri', 'bkDaySat'];

// ── Appointment Types tab ────────────────────────────────────────────────────

function AppointmentTypesTab() {
  const t = useT();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/appointment-types');
      setItems(data.items || []);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (editing) {
    return <AppointmentTypeEditor id={editing} onBack={() => { setEditing(null); load(); }} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={styles.h2}>{t.bkApptTypesCount} ({items.length})</h2>
        <button onClick={() => setShowForm(s => !s)} style={styles.primaryBtn}>
          {showForm ? t.bkCancel : t.bkNewType}
        </button>
      </div>

      {showForm && (
        <NewAppointmentTypeForm onSave={() => { setShowForm(false); load(); }} onCancel={() => setShowForm(false)} />
      )}

      {loading ? <SkeletonList rows={3} /> :
        items.length === 0 ? (
          <EmptyState title={t.bkNoApptTypesTitle} body={t.bkNoApptTypesBody} />
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <th style={styles.th}>{t.bkName}</th>
                  <th style={styles.th}>{t.bkSlug}</th>
                  <th style={styles.th}>{t.bkDuration}</th>
                  <th style={styles.th}>{t.bkLocation}</th>
                  <th style={styles.th}>{t.bkPublic}</th>
                </tr>
              </thead>
              <tbody>
                {items.map(at => (
                  <tr key={at.id} style={styles.tableRow} onClick={() => setEditing(at.id)}>
                    <td style={styles.td}><strong>{at.name}</strong></td>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{at.slug}</td>
                    <td style={styles.td}>{at.duration_minutes} {t.bkMinAbbr}</td>
                    <td style={styles.td}>{at.location_kind}</td>
                    <td style={styles.td}>{at.is_public ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  );
}

function NewAppointmentTypeForm({ onSave, onCancel }) {
  const t = useT();
  const [form, setForm] = useState({
    name: '', description: '',
    duration_minutes: 30, buffer_before_min: 0, buffer_after_min: 0,
    advance_notice_hrs: 24, max_advance_days: 60, slot_interval_min: 30,
    location_kind: 'phone', location_detail: '',
    is_public: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  function update(k, v) { setDirty(true); setForm(f => ({ ...f, [k]: v })); }

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.post('/appointment-types', {
        ...form,
        duration_minutes:   parseInt(form.duration_minutes, 10),
        buffer_before_min:  parseInt(form.buffer_before_min, 10) || 0,
        buffer_after_min:   parseInt(form.buffer_after_min, 10) || 0,
        advance_notice_hrs: parseInt(form.advance_notice_hrs, 10),
        max_advance_days:   parseInt(form.max_advance_days, 10),
        slot_interval_min:  parseInt(form.slot_interval_min, 10),
      });
      setDirty(false);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || t.bkFailedToCreate);
    } finally { setSaving(false); }
  }

  return (
    <div style={styles.formCard}>
      {error && <div style={styles.errorBox}>{error}</div>}
      <div className="admin-form-grid-2">
        <Field label={t.bkName} required>
          <input value={form.name} onChange={e => update('name', e.target.value)} placeholder={t.bkNamePlaceholder} style={styles.input} />
        </Field>
        <Field label={t.bkDurationMinutes} required>
          <input type="number" min="15" step="15" value={form.duration_minutes} onChange={e => update('duration_minutes', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.bkLocationKind}>
          <select value={form.location_kind} onChange={e => update('location_kind', e.target.value)} style={styles.input}>
            {LOCATION_KINDS.map(l => <option key={l.value} value={l.value}>{t[l.labelKey]}</option>)}
          </select>
        </Field>
        <Field label={t.bkPublicBookable}>
          <select value={form.is_public ? 'yes' : 'no'} onChange={e => update('is_public', e.target.value === 'yes')} style={styles.input}>
            <option value="yes">{t.bkPublicYes}</option>
            <option value="no">{t.bkPublicNo}</option>
          </select>
        </Field>
      </div>
      <Field label={t.bkDescription}>
        <textarea value={form.description} onChange={e => update('description', e.target.value)} style={{ ...styles.input, minHeight: 60 }} />
      </Field>
      <Field label={t.bkLocationDetail}>
        <input value={form.location_detail} onChange={e => update('location_detail', e.target.value)} style={styles.input} />
      </Field>

      <h3 style={{ ...styles.h3, marginTop: 16 }}>{t.bkSchedulingRules}</h3>
      <div className="admin-form-grid-4">
        <Field label={t.bkBufferBefore}>
          <input type="number" min="0" value={form.buffer_before_min} onChange={e => update('buffer_before_min', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.bkBufferAfter}>
          <input type="number" min="0" value={form.buffer_after_min} onChange={e => update('buffer_after_min', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.bkAdvanceNotice}>
          <input type="number" min="0" value={form.advance_notice_hrs} onChange={e => update('advance_notice_hrs', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.bkMaxAdvance}>
          <input type="number" min="1" value={form.max_advance_days} onChange={e => update('max_advance_days', e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.bkSlotInterval}>
          <input type="number" min="15" step="15" value={form.slot_interval_min} onChange={e => update('slot_interval_min', e.target.value)} style={styles.input} />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onCancel} style={styles.ghostBtn}>{t.bkCancel}</button>
        <button onClick={save} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.bkSaving : t.bkCreate}
        </button>
      </div>
    </div>
  );
}

function AppointmentTypeEditor({ id, onBack }) {
  const t = useT();
  const [type, setType] = useState(null);
  const [shiftTypes, setShiftTypes] = useState([]);
  const [bookableUsers, setBookableUsers] = useState([]);
  const [allowedUserIds, setAllowedUserIds] = useState([]);
  const [allowedShiftTypeIds, setAllowedShiftTypeIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [td, sts, users] = await Promise.all([
        api.get(`/appointment-types/${id}`).then(r => r.data),
        api.get('/shift-types').then(r => r.data.items),
        api.get('/admin/workers').then(r => r.data.filter(u => u.bookable)).catch(() => []),
      ]);
      setType(td);
      setShiftTypes(sts || []);
      setBookableUsers(users || []);
      setAllowedUserIds(td.allowed_user_ids || []);
      setAllowedShiftTypeIds(td.allowed_shift_type_ids || []);
      // Reloading is not a user edit — keep the dirty flag where it was.
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  function toggleUser(uid) {
    setDirty(true);
    setAllowedUserIds(arr => arr.includes(uid) ? arr.filter(x => x !== uid) : [...arr, uid]);
  }
  function toggleShiftType(stid) {
    setDirty(true);
    setAllowedShiftTypeIds(arr => arr.includes(stid) ? arr.filter(x => x !== stid) : [...arr, stid]);
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await Promise.all([
        api.put(`/appointment-types/${id}/users`, { user_ids: allowedUserIds }),
        api.put(`/appointment-types/${id}/shift-types`, { shift_type_ids: allowedShiftTypeIds }),
      ]);
      setDirty(false);
      onBack();
    } catch (err) { setError(err.response?.data?.error || t.bkSaveFailed); }
    finally { setSaving(false); }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!type) return null;

  return (
    <div>
      <button onClick={onBack} style={styles.ghostBtn}>{t.bkBack}</button>
      <h2 style={{ ...styles.h2, marginTop: 12 }}>{type.name}</h2>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <h3 style={styles.h3}>{t.bkEligibleUsers}</h3>
        {bookableUsers.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6b7280' }}>
            {t.bkNoBookableUsersYet}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, color: '#6b7280' }}>
              {allowedUserIds.length === 0
                ? t.bkEligibleEmptyHint
                : `${allowedUserIds.length} ${t.bkSelectedOnlyAssigned}`}
            </label>
            {bookableUsers.map(u => (
              <label key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                <input type="checkbox" checked={allowedUserIds.includes(u.id)} onChange={() => toggleUser(u.id)} />
                <span>{u.full_name}</span>
                {u.bookable_role_label && <span style={{ fontSize: 12, color: '#6b7280' }}>· {u.bookable_role_label}</span>}
              </label>
            ))}
          </div>
        )}
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.h3}>{t.bkAllowedShiftTypes}</h3>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 10px' }}>
          {t.bkAllowedShiftTypesHint}
        </p>
        {shiftTypes.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6b7280' }}>{t.bkNoShiftTypesDefined}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shiftTypes.map(st => (
              <label key={st.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                <input type="checkbox" checked={allowedShiftTypeIds.includes(st.id)} onChange={() => toggleShiftType(st.id)} />
                {st.color && <span style={{ width: 12, height: 12, borderRadius: 3, background: st.color, display: 'inline-block' }} />}
                <span>{st.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onBack} style={styles.ghostBtn}>{t.bkCancel}</button>
        <button onClick={save} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.bkSaving : t.bkSave}
        </button>
      </div>
    </div>
  );
}

// ── Shift Types tab ─────────────────────────────────────────────────────────

function ShiftTypesTab() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ open: false, name: '', color: '#1a56db', description: '' });
  const [error, setError] = useState(null);
  // Dirty only when the create panel is open AND a field has been
  // touched — toggling the panel open by itself is not data loss.
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  function updateField(k, v) { setDirty(true); setForm(f => ({ ...f, [k]: v })); }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/shift-types');
      setItems(data.items || []);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setError(null);
    try {
      await api.post('/shift-types', form);
      setForm({ open: false, name: '', color: '#1a56db', description: '' });
      setDirty(false);
      await load();
    } catch (err) { setError(err.response?.data?.error || t.bkFailed); }
  }

  async function archive(id) {
    if (!await confirm({
      title: t.bkArchiveShiftTypeTitle,
      body: t.bkArchiveShiftTypeBody,
      confirmLabel: t.bkArchive,
    })) return;
    try {
      await api.post(`/shift-types/${id}/archive`);
      toast(t.bkArchived, 'success');
      await load();
    }
    catch (err) { setError(err.response?.data?.error || t.bkArchiveFailed); }
  }

  return (
    <div>
      {confirmDialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={styles.h2}>{t.bkShiftTypesCount} ({items.length})</h2>
        <button
          onClick={() => {
            // Closing the create panel clears whatever was being typed;
            // mark clean so the unsaved-changes prompt doesn't fire after
            // the user explicitly chose Cancel.
            if (form.open) setDirty(false);
            setForm(f => ({ ...f, open: !f.open }));
          }}
          style={styles.primaryBtn}
        >
          {form.open ? t.bkCancel : t.bkNewShiftType}
        </button>
      </div>

      {form.open && (
        <div style={styles.formCard}>
          {error && <div style={styles.errorBox}>{error}</div>}
          <div style={styles.grid3}>
            <Field label={t.bkName} required>
              <input value={form.name} onChange={e => updateField('name', e.target.value)} placeholder={t.bkShiftNamePlaceholder} style={styles.input} />
            </Field>
            <Field label={t.bkColor}>
              <input type="color" value={form.color} onChange={e => updateField('color', e.target.value)} style={{ ...styles.input, height: 36, padding: 2 }} />
            </Field>
            <Field label={t.bkDescription}>
              <input value={form.description} onChange={e => updateField('description', e.target.value)} style={styles.input} />
            </Field>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={create} style={styles.primaryBtn}>{t.bkCreate}</button>
          </div>
        </div>
      )}

      {loading ? <SkeletonList rows={3} /> :
        items.length === 0 ? (
          <EmptyState title={t.bkNoShiftTypesTitle} body={t.bkNoShiftTypesBody} />
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <th style={styles.th}></th>
                  <th style={styles.th}>{t.bkName}</th>
                  <th style={styles.th}>{t.bkDescription}</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {items.map(st => (
                  <tr key={st.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ ...styles.td, width: 40 }}>
                      {st.color && <span style={{ width: 16, height: 16, borderRadius: 4, background: st.color, display: 'inline-block' }} />}
                    </td>
                    <td style={styles.td}><strong>{st.name}</strong></td>
                    <td style={styles.td}>{st.description || '—'}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <button onClick={() => archive(st.id)} style={styles.iconBtn}>{t.bkArchive}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  );
}

// ── Bookable Users tab ──────────────────────────────────────────────────────

function BookableUsersTab() {
  const t = useT();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/workers');
      setUsers((data || []).filter(u => u.active));
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (editing) {
    return <UserBookingEditor userId={editing} userName={users.find(u => u.id === editing)?.full_name} onBack={() => { setEditing(null); load(); }} />;
  }

  return (
    <div>
      <h2 style={styles.h2}>{t.bkBookableUsers}</h2>
      <p style={{ fontSize: 13, color: '#6b7280', marginTop: -8, marginBottom: 12 }}>
        {t.bkBookableUsersHint}
      </p>
      {loading ? <SkeletonList rows={4} /> : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeader}>
                <th style={styles.th}>{t.bkName}</th>
                <th style={styles.th}>{t.bkRoleLabel}</th>
                <th style={styles.th}>{t.bkTimezone}</th>
                <th style={styles.th}>{t.bkBookable}</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={styles.tableRow} onClick={() => setEditing(u.id)}>
                  <td style={styles.td}><strong>{u.full_name}</strong></td>
                  <td style={styles.td}>{u.bookable_role_label || '—'}</td>
                  <td style={styles.td}>{u.timezone || '—'}</td>
                  <td style={styles.td}>
                    {u.bookable
                      ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46' }}>{t.bkYes}</span>
                      : <span style={{ fontSize: 11, color: '#6b7280' }}>{t.bkNo}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserBookingEditor({ userId, userName, onBack }) {
  const t = useT();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [bookable, setBookable] = useState(false);
  const [roleLabel, setRoleLabel] = useState('');
  const [timezone, setTimezone] = useState('');
  const [windows, setWindows] = useState([]);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/users/${userId}/booking`);
      setConfig(data);
      setBookable(!!data.user.bookable);
      setRoleLabel(data.user.bookable_role_label || '');
      setTimezone(data.user.timezone || '');
      setWindows((data.windows || []).map(w => ({
        weekday: w.weekday,
        start_time: w.start_time?.slice(0, 5) || '09:00',
        end_time:   w.end_time?.slice(0, 5)   || '17:00',
        active: w.active,
      })));
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  function addWindow() {
    setDirty(true);
    setWindows(arr => [...arr, { weekday: 1, start_time: '09:00', end_time: '17:00', active: true }]);
  }
  function updateWindow(i, k, v) {
    setDirty(true);
    setWindows(arr => arr.map((w, idx) => idx === i ? { ...w, [k]: v } : w));
  }
  function removeWindow(i) {
    setDirty(true);
    setWindows(arr => arr.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.put(`/users/${userId}/booking`, {
        bookable, bookable_role_label: roleLabel || null, timezone: timezone || null,
        windows: windows.map(w => ({
          weekday: parseInt(w.weekday, 10),
          start_time: w.start_time,
          end_time: w.end_time,
          active: w.active,
        })),
      });
      setDirty(false);
      onBack();
    } catch (err) { setError(err.response?.data?.error || t.bkSaveFailed); }
    finally { setSaving(false); }
  }

  if (loading) return <SkeletonList rows={4} />;

  const weekdayLabels = WEEKDAY_LABEL_KEYS.map(k => t[k]);

  return (
    <div>
      <button onClick={onBack} style={styles.ghostBtn}>{t.bkBack}</button>
      <h2 style={{ ...styles.h2, marginTop: 12 }}>{t.bkBookingConfig} — {userName}</h2>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.formCard}>
        <div style={styles.grid3}>
          <Field label={t.bkBookable}>
            <select value={bookable ? 'yes' : 'no'} onChange={e => { setDirty(true); setBookable(e.target.value === 'yes'); }} style={styles.input}>
              <option value="no">{t.bkBookableNo}</option>
              <option value="yes">{t.bkYes}</option>
            </select>
          </Field>
          <Field label={t.bkRoleLabel}>
            <input value={roleLabel} onChange={e => { setDirty(true); setRoleLabel(e.target.value); }} placeholder={t.bkRoleLabelPlaceholder} style={styles.input} />
          </Field>
          <Field label={t.bkTimezone}>
            <input value={timezone} onChange={e => { setDirty(true); setTimezone(e.target.value); }} placeholder={t.bkTimezonePlaceholder} style={styles.input} />
          </Field>
        </div>
      </div>

      <div style={styles.formCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={styles.h3}>{t.bkWeeklyWindows} ({windows.length})</h3>
          <button onClick={addWindow} style={styles.ghostBtn}>{t.bkAddWindow}</button>
        </div>
        {windows.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6b7280' }}>{t.bkNoWindowsSet}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr><th style={styles.th}>{t.bkWeekday}</th><th style={styles.th}>{t.bkStart}</th><th style={styles.th}>{t.bkEnd}</th><th style={styles.th}>{t.bkActive}</th><th style={styles.th}></th></tr>
            </thead>
            <tbody>
              {windows.map((w, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={styles.td}>
                    <select value={w.weekday} onChange={e => updateWindow(i, 'weekday', parseInt(e.target.value, 10))} style={{ ...styles.input, padding: '4px 8px' }}>
                      {weekdayLabels.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
                    </select>
                  </td>
                  <td style={styles.td}>
                    <input type="time" value={w.start_time} onChange={e => updateWindow(i, 'start_time', e.target.value)} style={{ ...styles.input, padding: '4px 8px' }} />
                  </td>
                  <td style={styles.td}>
                    <input type="time" value={w.end_time} onChange={e => updateWindow(i, 'end_time', e.target.value)} style={{ ...styles.input, padding: '4px 8px' }} />
                  </td>
                  <td style={styles.td}>
                    <input type="checkbox" checked={w.active} onChange={e => updateWindow(i, 'active', e.target.checked)} />
                  </td>
                  <td style={styles.td}>
                    <button onClick={() => removeWindow(i)} style={styles.iconBtn}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onBack} style={styles.ghostBtn}>{t.bkCancel}</button>
        <button onClick={save} disabled={saving} style={styles.primaryBtn}>
          {saving ? t.bkSaving : t.bkSave}
        </button>
      </div>
    </div>
  );
}

// ── Upcoming Appointments tab ───────────────────────────────────────────────

function AppointmentsTab() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'scheduled_at', dir: 'asc' });
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT };
      if (statusFilter) params.status = statusFilter;
      else params.from = new Date().toISOString();
      const { data } = await api.get('/appointments', { params });
      setItems(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1 });
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [statusFilter, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [statusFilter]);

  const sortedItems = useMemo(
    () => sortRows(items, sort, {
      scheduled_at: r => r.scheduled_at,
    }),
    [items, sort]
  );

  async function cancel(id) {
    if (!await confirm({
      title: t.bkCancelApptTitle,
      body: t.bkCancelApptBody,
      confirmLabel: t.bkCancelAppointment,
      tone: 'danger',
    })) return;
    try {
      await api.post(`/appointments/${id}/cancel`, {});
      toast(t.bkAppointmentCancelled, 'success');
      await load();
    }
    catch { /* ignore */ }
  }

  return (
    <div>
      {confirmDialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={styles.h2}>{t.bkAppointments}</h2>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label={t.bkFilterByStatus}
          style={styles.input}
        >
          <option value="">{t.bkUpcomingDefault}</option>
          {Object.entries(STATUS_COLORS).map(([k, v]) => <option key={k} value={k}>{t[v.labelKey]}</option>)}
        </select>
      </div>
      {loading ? <SkeletonList rows={3} /> :
        items.length === 0 ? <EmptyState title={t.bkNoAppointments} body={t.bkNoAppointmentsBody} /> : (
          <>
          <div className="admin-table-desktop" style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <SortHeader sortKey="scheduled_at" sort={sort} setSort={setSort}>{t.bkWhen}</SortHeader>
                  <SortHeader sortKey="appointment_type_name" sort={sort} setSort={setSort}>{t.bkType}</SortHeader>
                  <SortHeader sortKey="client_name" sort={sort} setSort={setSort}>{t.bkClient}</SortHeader>
                  <SortHeader sortKey="assigned_user_name" sort={sort} setSort={setSort}>{t.bkAssignedTo}</SortHeader>
                  <SortHeader sortKey="status" sort={sort} setSort={setSort}>{t.bkStatus}</SortHeader>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(a => {
                  const c = STATUS_COLORS[a.status] || STATUS_COLORS.booked;
                  return (
                    <tr key={a.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={styles.td}>{formatDateTime(a.scheduled_at)}</td>
                      <td style={styles.td}>{a.appointment_type_name}</td>
                      <td style={styles.td}>{a.client_name}<br /><span style={{ fontSize: 11, color: '#6b7280' }}>{a.client_email}</span></td>
                      <td style={styles.td}>{a.assigned_user_name}</td>
                      <td style={styles.td}>
                        <span style={{ fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg, padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase' }}>{t[c.labelKey]}</span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {(a.status === 'booked' || a.status === 'confirmed') && (
                          <button onClick={() => cancel(a.id)} style={styles.iconBtn}>{t.bkCancel}</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="admin-cards-mobile">
            {sortedItems.map(a => {
              const c = STATUS_COLORS[a.status] || STATUS_COLORS.booked;
              return (
                <div key={a.id} className="admin-card" style={{ cursor: 'default' }}>
                  <div className="admin-card-row">
                    <span className="admin-card-title">{formatDateTime(a.scheduled_at)}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg, padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase' }}>{t[c.labelKey]}</span>
                  </div>
                  <div className="admin-card-sub" style={{ color: '#374151', fontWeight: 600 }}>{a.appointment_type_name}</div>
                  <div className="admin-card-sub">{a.client_name} · {a.client_email}</div>
                  <div className="admin-card-sub">{t.bkAssignedTo} {a.assigned_user_name}</div>
                  {(a.status === 'booked' || a.status === 'confirmed') && (
                    <button onClick={() => cancel(a.id)} style={{ ...styles.iconBtn, alignSelf: 'flex-end' }}>{t.bkCancel}</button>
                  )}
                </div>
              );
            })}
          </div>
          <Pagination page={meta.page} pages={meta.pages} onChange={setPage} />
          </>
        )
      }
    </div>
  );
}

// ── Page shell ──────────────────────────────────────────────────────────────

export default function BookingPage() {
  const t = useT();
  const { user } = useAuth();
  const [tab, setTab] = useState('appointments');

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AppHeader currentApp="workforce" userRole={user?.role} />
      <main id="main-content" className="admin-page-shell" style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>{t.bkTitle}</h1>
        <div style={styles.tabRow}>
          <Tab id="appointments" label={t.bkAppointments} tab={tab} setTab={setTab} />
          <Tab id="types"        label={t.bkAppointmentTypes} tab={tab} setTab={setTab} />
          <Tab id="shifts"       label={t.bkShiftTypes} tab={tab} setTab={setTab} />
          <Tab id="users"        label={t.bkBookableUsers} tab={tab} setTab={setTab} />
        </div>
        {tab === 'appointments' && <AppointmentsTab />}
        {tab === 'types'        && <AppointmentTypesTab />}
        {tab === 'shifts'       && <ShiftTypesTab />}
        {tab === 'users'        && <BookableUsersTab />}
      </main>
    </div>
  );
}

function Tab({ id, label, tab, setTab }) {
  const active = tab === id;
  return (
    <button
      type="button"
      onClick={() => setTab(id)}
      aria-current={active ? 'page' : undefined}
      style={{ ...styles.tabBtn, ...(active ? styles.tabBtnActive : {}) }}
    >
      {label}
    </button>
  );
}

function Field({ label, required, children }) {
  const t = useT();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 12 }}>
      <span>
        {label}
        {required && (
          <>
            <span aria-hidden="true" style={{ color: '#ef4444' }}>*</span>
            <span className="sr-only"> {t.bkRequiredSr}</span>
          </>
        )}
      </span>
      {children}
    </label>
  );
}

const styles = {
  h2: { fontSize: 18, fontWeight: 700, margin: 0, color: '#111827' },
  h3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' },
  tabRow: { display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb' },
  tabBtn: { background: 'transparent', border: 'none', borderBottom: '2px solid transparent', padding: '10px 16px', fontSize: 14, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  tabBtnActive: { borderBottomColor: '#1a56db', color: '#1a56db' },
  primaryBtn: { background: '#1a56db', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  iconBtn: { background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tableRow: { borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  td: { padding: '12px 14px', color: '#111827' },
  formCard: { background: '#fff', borderRadius: 8, padding: 20, marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
