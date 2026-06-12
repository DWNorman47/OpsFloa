/**
 * Statement of Compliance capture — the weekly attestation required by
 * WH-347 / Davis-Bacon. Modal form with typed signature (WH-347 accepts
 * electronic signatures as long as the signer is identified and the
 * statement text is captured alongside the signature).
 *
 * Current state queried from GET /signatures?project_id=&week_ending=.
 * If already signed, shows signer + date and a "Re-sign" option.
 */

import React, { useState, useEffect } from 'react';
import api from '../api';
import ModalShell from './ModalShell';
import { useT } from '../hooks/useT';

export default function CertifiedPayrollSignature({
  projectId = null,
  weekEnding,             // 'YYYY-MM-DD' — the Saturday / end-of-week of the report
  onClose,
  onSigned,
  defaultName = '',
  defaultTitle = '',
}) {
  const t = useT();
  const [complianceText, setComplianceText] = useState('');
  const [existing, setExisting] = useState(null);
  const [name, setName] = useState(defaultName);
  const [title, setTitle] = useState(defaultTitle);
  const [signature, setSignature] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    params.set('week_ending', weekEnding);
    api.get(`/certified-payroll/signatures?${params}`)
      .then(r => {
        setComplianceText(r.data.default_compliance_text || '');
        setExisting(r.data.signature);
      })
      .catch(() => setError(t.cpsErrLoad));
  }, [projectId, weekEnding]);

  const submit = async () => {
    if (!name.trim()) { setError(t.cpsErrNameRequired); return; }
    if (!signature.trim()) { setError(t.cpsErrSignatureRequired); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/certified-payroll/signatures', {
        project_id: projectId,
        week_ending: weekEnding,
        signer_name: name.trim(),
        signer_title: title.trim(),
        signature_data: signature.trim(),
      });
      onSigned?.(r.data.signature);
      onClose?.();
    } catch (err) {
      setError(err.response?.data?.error || t.cpsErrSave);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} labelId="cp-sign-title" maxWidth={680}>
      <h2 id="cp-sign-title" style={styles.title}>{t.cpsStatementOfCompliance}</h2>
      <p style={styles.subtitle}>{t.cpsWeekEnding} {weekEnding}{projectId ? ` · ${t.cpsProjectPrefix}${projectId}` : ''}</p>

      {existing && (
        <div role="status" style={styles.existing}>
          {t.cpsAlreadySignedBy} <strong>{existing.signer_name}</strong>
          {existing.signer_title ? ` (${existing.signer_title})` : ''}{' · '}
          {new Date(existing.signed_at).toLocaleString()}.
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{t.cpsReSignNote}</div>
        </div>
      )}

      <div style={styles.complianceBox} role="document" aria-label={t.cpsStatementTextAria}>
        {complianceText.split('\n\n').map((p, i) => <p key={i} style={styles.complianceP}>{p}</p>)}
      </div>

      <div style={styles.fields}>
        <label style={styles.field}>
          <span style={styles.label}>{t.cpsYourFullName}</span>
          <input
            style={styles.input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t.cpsNamePlaceholder}
            maxLength={200}
            autoFocus
          />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t.cpsYourTitle}</span>
          <input
            style={styles.input}
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t.cpsTitlePlaceholder}
            maxLength={200}
          />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t.cpsTypedSignature}</span>
          <input
            style={{ ...styles.input, fontFamily: '"Dancing Script", "Segoe Script", cursive', fontSize: 22 }}
            value={signature}
            onChange={e => setSignature(e.target.value)}
            placeholder={t.cpsTypedSignaturePlaceholder}
            maxLength={2000}
          />
          <span style={styles.note}>{t.cpsElectronicNote}</span>
        </label>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.actions}>
        <button type="button" onClick={onClose} style={styles.cancelBtn}>Cancel</button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          style={{ ...styles.signBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
        >
          {saving ? 'Signing…' : existing ? 'Re-sign' : 'Sign'}
        </button>
      </div>
    </ModalShell>
  );
}

const styles = {
  title:       { fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 },
  subtitle:    { fontSize: 13, color: '#6b7280', marginTop: 4 },
  existing:    { background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#92400e', marginTop: 14 },
  complianceBox: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, marginTop: 14, maxHeight: 220, overflowY: 'auto' },
  complianceP: { fontSize: 12, color: '#374151', lineHeight: 1.55, margin: '0 0 10px' },
  fields:      { display: 'flex', flexDirection: 'column', gap: 14, marginTop: 18 },
  field:       { display: 'flex', flexDirection: 'column', gap: 4 },
  label:       { fontSize: 12, fontWeight: 700, color: '#374151' },
  input:       { padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 },
  note:        { fontSize: 11, color: '#6b7280', marginTop: 3 },
  error:       { color: '#991b1b', fontSize: 13, marginTop: 10 },
  actions:     { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  cancelBtn:   { padding: '9px 18px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, color: '#374151', cursor: 'pointer' },
  signBtn:     { padding: '9px 22px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
};
