/**
 * Per-worker fringe benefit editor. Five WH-347 categories: health,
 * pension, vacation, apprenticeship, other. Admins enter a per-hour rate
 * for each; zero or unset means "no fringe of this type."
 *
 * Renders inline in the worker's expanded row on the Manage Workers page.
 * Only mounted when the Certified Payroll addon is on AND the company
 * has cp_track_fringes enabled.
 */

import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { silentError } from '../errorReporter';

const CATEGORY_KEYS = ['health', 'pension', 'vacation', 'apprenticeship', 'other'];

export default function WorkerFringes({ userId, currency = 'USD' }) {
  const t = useT();
  const CATEGORIES = [
    { key: 'health',         label: t.wfHealth },
    { key: 'pension',        label: t.wfPension },
    { key: 'vacation',       label: t.wfVacation },
    { key: 'apprenticeship', label: t.wfApprenticeship },
    { key: 'other',          label: t.wfOther },
  ];
  const [rates, setRates] = useState({ health: '', pension: '', vacation: '', apprenticeship: '', other: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/certified-payroll/workers/${userId}/fringes`)
      .then(r => {
        const next = { health: '', pension: '', vacation: '', apprenticeship: '', other: '' };
        (r.data.fringes || []).forEach(f => { next[f.category] = String(f.rate_per_hour ?? ''); });
        setRates(next);
      })
      .catch(silentError('workerfringes'))
      .finally(() => setLoading(false));
  }, [userId]);

  const save = async () => {
    setSaving(true); setSaved(false); setError('');
    try {
      const payload = CATEGORIES.map(c => ({
        category: c.key,
        rate_per_hour: rates[c.key] === '' ? 0 : parseFloat(rates[c.key]) || 0,
      }));
      await api.put(`/certified-payroll/workers/${userId}/fringes`, { fringes: payload });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.response?.data?.error || t.wfSaveError);
    } finally {
      setSaving(false);
    }
  };

  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency + ' ';
  const total = CATEGORIES.reduce((s, c) => s + (parseFloat(rates[c.key]) || 0), 0);

  if (loading) return <div style={styles.loading}>{t.wfLoading}</div>;

  return (
    <div style={styles.wrap}>
      <div style={styles.headerRow}>
        <span style={styles.title}>{t.wfTitle}</span>
        <span style={styles.total}>{t.wfTotal}: {sym}{total.toFixed(4)}/hr</span>
      </div>
      <p style={styles.hint}>{t.wfHint}</p>
      <div style={styles.grid}>
        {CATEGORIES.map(c => (
          <div key={c.key} style={styles.field}>
            <label style={styles.label}>{c.label}</label>
            <div style={styles.inputGroup}>
              <span style={styles.prefix}>{sym}</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                style={styles.input}
                value={rates[c.key]}
                onChange={e => setRates(r => ({ ...r, [c.key]: e.target.value }))}
                placeholder="0.0000"
              />
              <span style={styles.suffix}>/hr</span>
            </div>
          </div>
        ))}
      </div>
      {error && <div role="alert" style={styles.error}>{error}</div>}
      <div style={styles.actions}>
        {saved && <span style={styles.savedMsg}>{t.wfSaved}</span>}
        <button
          type="button"
          style={{ ...styles.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
          onClick={save}
          disabled={saving}
        >
          {saving ? t.wfSaving : t.wfSaveBtn}
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrap:        { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginTop: 12 },
  headerRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  title:       { fontSize: 14, fontWeight: 700, color: '#111827' },
  total:       { fontSize: 13, fontWeight: 600, color: '#059669' },
  hint:        { fontSize: 12, color: '#6b7280', margin: '0 0 12px' },
  grid:        { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 },
  field:       { display: 'flex', flexDirection: 'column', gap: 4 },
  label:       { fontSize: 12, fontWeight: 600, color: '#374151' },
  inputGroup:  { display: 'flex', alignItems: 'center', border: '1px solid #d1d5db', borderRadius: 7, overflow: 'hidden', background: '#fff' },
  prefix:      { padding: '0 8px', fontSize: 13, color: '#6b7280', borderRight: '1px solid #e5e7eb' },
  input:       { flex: 1, padding: '7px 8px', border: 'none', fontSize: 13, outline: 'none', minWidth: 0 },
  suffix:      { padding: '0 8px', fontSize: 12, color: '#6b7280', borderLeft: '1px solid #e5e7eb' },
  actions:     { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  saveBtn:     { padding: '7px 16px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  savedMsg:    { fontSize: 13, color: '#059669', fontWeight: 600 },
  loading:     { padding: 12, fontSize: 13, color: '#6b7280' },
  error:       { color: '#991b1b', fontSize: 13, marginTop: 8 },
};
