/**
 * SSN last-4 editor. The server encrypts at rest and never returns the
 * plaintext after saving, so this component only ever sees three states:
 *   - not set (hasSsn=false): input is empty, ready to accept 4 digits
 *   - set + idle (hasSsn=true): shows "●●●●" as a placeholder; click Edit
 *     to replace; Clear button removes it entirely
 *   - editing: input is visible, masked with type=password so it doesn't
 *     shoulder-surf
 */

import React, { useState, useEffect } from 'react';
import api from '../api';
import { silentError } from '../errorReporter';
import { useT } from '../hooks/useT';

export default function WorkerSsn({ userId }) {
  const t = useT();
  const [hasSsn, setHasSsn] = useState(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/certified-payroll/workers/${userId}/ssn`)
      .then(r => setHasSsn(!!r.data.hasSsn))
      .catch(silentError('workerssn'));
  }, [userId]);

  const save = async () => {
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 4) { setError(t.ssnEnter4Digits); return; }
    setSaving(true); setError('');
    try {
      await api.put(`/certified-payroll/workers/${userId}/ssn`, { ssn_last4: digits });
      setHasSsn(true);
      setEditing(false);
      setValue('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(t.ssnConfirmClear)) return;
    setSaving(true); setError('');
    try {
      await api.put(`/certified-payroll/workers/${userId}/ssn`, { ssn_last4: '' });
      setHasSsn(false);
      setValue('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to clear');
    } finally {
      setSaving(false);
    }
  };

  if (hasSsn === null) return null; // initial load

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        <span style={styles.label}>{t.ssnLabel}</span>
        {editing ? (
          <div style={styles.editGroup}>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              placeholder="••••"
              value={value}
              onChange={e => setValue(e.target.value.replace(/\D/g, ''))}
              style={styles.input}
              autoFocus
            />
            <button type="button" style={styles.saveBtn} onClick={save} disabled={saving}>
              {saving ? '…' : t.save}
            </button>
            <button type="button" style={styles.cancelBtn} onClick={() => { setEditing(false); setValue(''); setError(''); }}>
              {t.cancel}
            </button>
          </div>
        ) : (
          <div style={styles.viewGroup}>
            <span style={styles.value}>{hasSsn ? '●●●●' : <em style={{ color: '#9ca3af' }}>{t.ssnNotSet}</em>}</span>
            {saved && <span style={styles.saved}>✓ {t.saved || 'Saved'}</span>}
            <button type="button" style={styles.editBtn} onClick={() => setEditing(true)}>
              {hasSsn ? t.ssnChange : t.ssnAdd}
            </button>
            {hasSsn && <button type="button" style={styles.clearBtn} onClick={clear} disabled={saving}>{t.ssnClear}</button>}
          </div>
        )}
      </div>
      <p style={styles.note}>{t.ssnStorageNote}</p>
      {error && <div role="alert" style={styles.error}>{error}</div>}
    </div>
  );
}

const styles = {
  wrap:      { borderTop: '1px solid #eeeeee', padding: '12px 0' },
  row:       { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  label:     { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, flex: '0 0 auto' },
  value:     { fontSize: 14, color: '#111827', fontFamily: 'ui-monospace, monospace', letterSpacing: 2 },
  viewGroup: { display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' },
  editGroup: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' },
  input:     { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14, width: 80, letterSpacing: 3, textAlign: 'center', fontFamily: 'ui-monospace, monospace' },
  editBtn:   { padding: '5px 12px', background: 'none', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  clearBtn:  { padding: '5px 12px', background: 'none', border: '1px solid #fca5a5', borderRadius: 7, fontSize: 12, fontWeight: 600, color: '#b91c1c', cursor: 'pointer' },
  saveBtn:   { padding: '6px 14px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { padding: '6px 12px', background: '#f3f4f6', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 500, color: '#6b7280', cursor: 'pointer' },
  saved:     { fontSize: 12, color: '#059669', fontWeight: 600 },
  note:      { fontSize: 11, color: '#6b7280', margin: '7px 0 0', lineHeight: 1.45 },
  error:     { color: '#991b1b', fontSize: 12, marginTop: 6 },
};
