import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { invalidateCache } from '../offlineDb';
import { silentError } from '../errorReporter';
import DeductionListEditor, { newDeduction } from './DeductionListEditor';

/**
 * Company-wide payroll deductions (social security, taxes, etc.). Edits the
 * `deductions` settings JSON and POSTs it back — the server engine
 * (server/utils/deductions.js) is the source of truth for how it's applied on a
 * pay stub. These apply to every worker; per-worker extras are added on the
 * worker's own screen.
 */

const KINDS = ['percent', 'fixed'];

// Settings JSON → form rows (all strings).
function parseItems(raw) {
  if (!raw) return [];
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  const items = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.items) ? obj.items : []);
  return items.map(it => ({
    id: it.id || newDeduction().id,
    name: String(it.name == null ? '' : it.name),
    kind: KINDS.includes(it.kind) ? it.kind : 'percent',
    value: it.value != null ? String(it.value) : '',
    cap: it.cap != null ? String(it.cap) : '',
    roleIds: Array.isArray(it.roleIds) ? it.roleIds : [],
  }));
}

// Form rows → the settings document (drops incomplete rows).
function toPolicy(items) {
  return {
    version: 1,
    items: items
      .filter(it => String(it.name).trim() && Number.isFinite(parseFloat(it.value)) && parseFloat(it.value) >= 0)
      .map(it => {
        const out = { id: it.id, name: String(it.name).trim().slice(0, 120), kind: it.kind, value: parseFloat(it.value) };
        const cap = parseFloat(it.cap);
        if (it.kind === 'percent' && Number.isFinite(cap) && cap > 0) out.cap = cap;
        if (Array.isArray(it.roleIds) && it.roleIds.length) out.roleIds = it.roleIds; // role-scoped; empty = all employees
        return out;
      }),
  };
}

export default function DeductionsSettings({ settings, onSettingsUpdated }) {
  const t = useT();
  const [items, setItems] = useState(() => parseItems(settings?.deductions));
  const [roles, setRoles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/admin/roles').then(r => setRoles(r.data || [])).catch(silentError('deductions-roles'));
  }, []);

  const change = (next) => { setItems(next); setSaved(false); };

  // A partially-filled row (a name OR a value but not a valid pair) would be silently
  // dropped by toPolicy while the UI still says "Saved" — so the admin thinks a deduction
  // is configured when it isn't. Block the save and say which row is wrong. A fully-blank
  // row (just-added, untouched) is fine to ignore.
  const validate = (rows) => {
    for (const it of rows) {
      const hasName = String(it.name).trim() !== '';
      const hasValue = String(it.value).trim() !== '';
      if (!hasName && !hasValue) continue;
      if (!hasName) return t.dedErrName;
      const v = parseFloat(it.value);
      if (!Number.isFinite(v) || v < 0) return t.dedErrValue;
      if (it.kind === 'percent' && v > 100) return t.dedErrPercent;
    }
    return '';
  };

  const save = async () => {
    const msg = validate(items);
    if (msg) { setError(msg); setSaved(false); return; }
    setSaving(true); setError('');
    try {
      const r = await api.patch('/admin/settings', { deductions: JSON.stringify(toPolicy(items)) });
      onSettingsUpdated?.(r.data);
      await invalidateCache?.('settings');
      setSaved(true);
    } catch (err) {
      setError(err?.response?.data?.error || t.dedSaveFailed);
      silentError('deductions')(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={s.card}>
      <p style={s.desc}>{t.dedDesc}</p>
      <DeductionListEditor items={items} onChange={change} roles={roles} />
      <p style={s.note}>{t.dedNote}</p>
      <div style={s.actions}>
        {saved && <span style={s.savedMsg}>{t.dedSaved}</span>}
        {error && <span role="alert" style={s.error}>{error}</span>}
        <button style={{ ...s.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={save} disabled={saving}>
          {saving ? t.dedSaving : t.dedSave}
        </button>
      </div>
    </div>
  );
}

const s = {
  card: {},
  desc: { fontSize: 13, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5, maxWidth: 620 },
  note: { fontSize: 12, color: '#475569', margin: '10px 0 0', lineHeight: 1.5, maxWidth: 620, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 6, padding: '7px 11px' },
  error: { color: '#e53e3e', fontSize: 13 },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '12px 20px', borderTop: '1px solid #f3f4f6', background: '#fafafa', margin: '16px -20px 0' },
  saveBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  savedMsg: { fontSize: 13, color: '#059669', fontWeight: 600 },
};
