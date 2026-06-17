import React, { useState } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';

export default function MFASetup() {
  const t = useT();
  const { user, updateUser } = useAuth();
  const [step, setStep] = useState('idle'); // idle | setup | disable
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const startSetup = async () => {
    setError('');
    setLoading(true);
    try {
      const r = await api.get('/auth/mfa/setup');
      setQr(r.data.qr);
      setSecret(r.data.secret);
      setCode('');
      setStep('setup');
    } catch (err) {
      setError(err.response?.data?.error || t.mfaFailedSetup);
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/mfa/enable', { code });
      updateUser({ mfa_enabled: true });
      setStep('idle');
      setCode('');
    } catch (err) {
      setError(err.response?.data?.error || t.mfaFailedEnable);
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/mfa/disable', { password });
      updateUser({ mfa_enabled: false });
      setStep('idle');
      setPassword('');
    } catch (err) {
      setError(err.response?.data?.error || t.mfaFailedDisable);
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  const cancel = () => { setStep('idle'); setCode(''); setPassword(''); setError(''); };

  return (
    <div style={s.card}>
      <div style={s.row}>
        <div>
          <div style={s.label}>{t.mfaTitle}</div>
          <div style={s.sub}>
            {user?.mfa_enabled ? t.mfaEnabledDesc : t.mfaDisabledDesc}
          </div>
        </div>
        {step === 'idle' && (
          user?.mfa_enabled
            ? <button style={s.disableBtn} onClick={() => { setStep('disable'); setError(''); }}>{t.mfaDisableBtn}</button>
            : <button style={{ ...s.enableBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={startSetup} disabled={loading}>
                {loading ? t.loading : t.mfaEnableBtn}
              </button>
        )}
      </div>

      {step === 'setup' && (
        <div style={s.setupBox}>
          <p style={s.hint}>{t.mfaScanHint}</p>
          <img src={qr} alt="MFA QR code" style={s.qr} />
          <div style={s.manualCode}>
            <span style={s.manualLabel}>{t.mfaManualCode}</span>
            <code style={s.secretCode}>{secret}</code>
          </div>
          <form onSubmit={handleEnable} style={s.form}>
            <input
              style={s.codeInput}
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder={t.mfaCodePlaceholder}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
            {error && <p style={s.error}>{error}</p>}
            <div style={s.btnRow}>
              <button type="button" style={s.cancelBtn} onClick={cancel}>{t.cancel}</button>
              <button style={{ ...s.confirmBtn, ...(loading || code.length !== 6 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={loading || code.length !== 6}>
                {loading ? t.mfaVerifying : t.mfaConfirmEnable}
              </button>
            </div>
          </form>
        </div>
      )}

      {step === 'disable' && (
        <div style={s.setupBox}>
          <p style={s.hint}>{t.mfaDisableHint}</p>
          <form onSubmit={handleDisable} style={s.form}>
            <input
              style={s.codeInput}
              type="password"
              placeholder={t.mfaPasswordPlaceholder}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              required
            />
            {error && <p style={s.error}>{error}</p>}
            <div style={s.btnRow}>
              <button type="button" style={s.cancelBtn} onClick={cancel}>{t.cancel}</button>
              <button style={{ ...s.confirmBtn, background: '#dc2626', ...(loading || !password ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={loading || !password}>
                {loading ? t.mfaDisabling : t.mfaDisableMFA}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)', marginBottom: 16 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  label: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 2 },
  sub: { fontSize: 12, color: '#6b7280' },
  enableBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  disableBtn: { background: 'none', border: '1px solid #d1d5db', color: '#374151', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  setupBox: { marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 16 },
  hint: { fontSize: 13, color: '#6b7280', marginBottom: 14 },
  qr: { display: 'block', width: 180, height: 180, margin: '0 auto 14px' },
  manualCode: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, marginBottom: 16 },
  manualLabel: { fontSize: 12, color: '#6b7280' },
  secretCode: { fontSize: 12, background: '#f3f4f6', padding: '4px 10px', borderRadius: 6, letterSpacing: 2, color: '#374151', wordBreak: 'break-all', textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320, margin: '0 auto' },
  codeInput: { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 18, textAlign: 'center', letterSpacing: 4, fontWeight: 700 },
  error: { color: '#e53e3e', fontSize: 13, margin: 0 },
  btnRow: { display: 'flex', gap: 10 },
  cancelBtn: { flex: 1, padding: '9px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  confirmBtn: { flex: 1, padding: '9px', background: '#059669', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
};
