import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import api from '../api';

/**
 * Blocking clickwrap gate for logged-in users who haven't accepted the CURRENT
 * legal docs — existing accounts (no acceptance row) and invited workers on
 * first login. Shown from `user.needs_terms` (set by the server). Accepting posts
 * to /auth/accept-terms and clears the flag; the overlay covers the whole app so
 * it can't be dismissed without accepting.
 */
export default function TermsGate() {
  const { user, updateUser } = useAuth();
  const t = useT();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!user || !user.needs_terms) return null;

  const accept = async () => {
    setSaving(true); setError('');
    try {
      await api.post('/auth/accept-terms', {});
      updateUser({ needs_terms: false });
    } catch {
      setError(t.termsGateFailed);
      setSaving(false);
    }
  };

  return (
    <div style={s.overlay} role="dialog" aria-modal="true" aria-labelledby="terms-gate-title">
      <div style={s.card}>
        <h2 id="terms-gate-title" style={s.title}>{t.termsGateTitle}</h2>
        <p style={s.body}>{t.termsGateBody}</p>
        <label style={s.agree}>
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            {t.registerAgreePre}{' '}
            <a href="/eula" target="_blank" rel="noopener noreferrer" style={s.link}>{t.registerAgreeEula}</a>{' '}
            {t.registerAgreeAnd}{' '}
            <a href="/privacy" target="_blank" rel="noopener noreferrer" style={s.link}>{t.registerAgreePrivacy}</a>.
          </span>
        </label>
        {error && <p role="alert" style={s.error}>{error}</p>}
        <button onClick={accept} disabled={!checked || saving}
          style={{ ...s.btn, ...(!checked || saving ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}>
          {saving ? t.termsGateSaving : t.termsGateAccept}
        </button>
      </div>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100000, padding: 16 },
  card: { background: '#fff', borderRadius: 14, padding: '32px 30px', width: '100%', maxWidth: 440, boxShadow: '0 10px 40px rgba(0,0,0,0.25)' },
  title: { fontSize: 19, fontWeight: 700, color: '#111827', margin: '0 0 8px' },
  body: { fontSize: 14, color: '#4b5563', lineHeight: 1.6, margin: '0 0 16px' },
  agree: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: '#374151', lineHeight: 1.5, cursor: 'pointer' },
  link: { color: 'var(--ops-page-accent)', fontWeight: 600 },
  error: { color: '#e53e3e', fontSize: 13, margin: '10px 0 0' },
  btn: { marginTop: 18, width: '100%', padding: '11px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: 'pointer' },
};
