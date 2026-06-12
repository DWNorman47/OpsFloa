import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { silentError } from '../errorReporter';

/**
 * Self-contained editor for the mileage reimbursement rate. Loads and
 * saves via /admin/advanced-settings/mileage_rate.
 *
 * Renders using row/label/inputGroup styles that match ManageRates so it
 * slots cleanly into a section's body without extra padding artifacts.
 */
export default function MileageRateEditor() {
  const t = useT();
  const [cfg, setCfg] = useState(null);
  const [rate, setRate] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.get('/admin/advanced-settings')
      .then(r => {
        const m = r.data?.mileage_rate;
        setCfg(m);
        setRate(String(m?.rate ?? 0.67));
      })
      .catch(err => { setError(t.advSettingsLoadFailed || 'Failed to load'); silentError('mileage rate load')(err); });
  }, []);

  const save = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await api.patch('/admin/advanced-settings/mileage_rate', { rate });
      setCfg(r.data?.mileage_rate || { rate: parseFloat(rate) });
      setDirty(false);
      setSuccess(t.advSettingsSaved || 'Saved');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError(t.advSettingsFailed || 'Save failed');
      silentError('mileage rate save')(err);
    } finally {
      setSaving(false);
    }
  };

  if (!cfg && !error) {
    return <div className="ops-loading-state">{t.advSettingsLoading || 'Loading…'}</div>;
  }

  return (
    <>
      <div style={styles.row}>
        <div>
          <label htmlFor="mileage-rate" style={styles.label}>{t.mileageRateSection || 'Mileage reimbursement rate'}</label>
          {t.mileageRateSub && <div style={styles.sub}>{t.mileageRateSub}</div>}
        </div>
        <div style={styles.inputGroup}>
          <span style={styles.prefix}>$</span>
          <input
            id="mileage-rate"
            style={styles.input}
            type="number"
            min="0"
            max="10"
            step="0.001"
            value={rate}
            onChange={e => { setRate(e.target.value); setDirty(true); }}
          />
          <span style={styles.suffix}>{t.mileageRateHint || 'per mile'}</span>
        </div>
      </div>
      {(error || success || dirty) && (
        <div style={styles.footer}>
          {error && <span role="alert" style={styles.error}>{error}</span>}
          {success && <span style={styles.success}>{success}</span>}
          {dirty && (
            <button
              type="button"
              style={{ ...styles.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
              onClick={save}
              disabled={saving}
            >
              {saving ? (t.saving || 'Saving…') : (t.saveRate || 'Save')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// These mirror the shape of ManageRates.styles.{row,label,inputGroup,input,prefix,suffix}
// so the editor slots in seamlessly under a sectionBody.
const styles = {
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 20px', borderBottom: '1px solid #f9fafb' },
  label: { fontSize: 13, fontWeight: 500, color: '#374151', display: 'block' },
  sub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  input: { width: 90, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14, textAlign: 'right' },
  prefix: { fontSize: 14, color: '#6b7280' },
  suffix: { fontSize: 13, color: '#6b7280', whiteSpace: 'nowrap' },
  footer: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderTop: '1px solid #f3f4f6' },
  saveBtn: { marginLeft: 'auto', padding: '7px 16px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  loading: { padding: '14px 20px', fontSize: 13, color: '#6b7280' },
  error: { color: '#dc2626', fontSize: 13 },
  success: { color: '#059669', fontSize: 13, fontWeight: 600 },
};
