import React, { useState } from 'react';
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
        return out;
      }),
  };
}

export default function DeductionsSettings({ settings, onSettingsUpdated }) {
  const t = useT();
  const [items, setItems] = useState(() => parseItems(settings?.deductions));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const change = (next) => { setItems(next); setSaved(false); };

  const save = async () => {
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
      <DeductionListEditor items={items} onChange={change} />
      <p style={s.note}>{t.dedNote}</p>
      {error && <p role="alert" style={s.error}>{error}</p>}
      <div style={s.actions}>
        <button style={{ ...s.saveBtn, ...(saving ? { opacity: 0.6 } : {}) }} onClick={save} disabled={saving}>
          {saving ? t.dedSaving : t.dedSave}
        </button>
        {saved && <span style={s.savedMsg}>{t.dedSaved}</span>}
      </div>
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  desc: { fontSize: 13, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5, maxWidth: 620 },
  note: { fontSize: 12, color: '#475569', margin: '10px 0 0', lineHeight: 1.5, maxWidth: 620, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 6, padding: '7px 11px' },
  error: { color: '#ef4444', fontSize: 13, marginTop: 12 },
  actions: { display: 'flex', alignItems: 'center', gap: 14, marginTop: 18 },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  savedMsg: { fontSize: 13, color: '#059669', fontWeight: 600 },
};
