import React, { useState } from 'react';
import api from '../api';
import PasswordInput from './PasswordInput';
import { useModalA11y } from '../hooks/useModalA11y';

export default function ChangePassword({ onClose, t }) {
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);
  const modalRef = useModalA11y(onClose);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (form.new_password !== form.confirm_password) {
      setError(t.passwordsMustMatch);
      return;
    }
    setSaving(true);
    try {
      const r = await api.post('/auth/change-password', {
        current_password: form.current_password,
        new_password: form.new_password,
      });
      // Server bumps token_version on password change, which invalidates
      // every outstanding token. It returns a fresh one for the current
      // device so the user doesn't get kicked out here.
      if (r.data?.token) {
        try { localStorage.setItem('tc_token', r.data.token); } catch { /* quota */ }
      }
      setSuccess(true);
      setTimeout(() => { setSuccess(false); onClose(); }, 1500);
    } catch (err) {
      setError(err.response?.data?.error || t.failedChangePassword);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="change-password-title" style={styles.modal}>
        <h3 id="change-password-title" style={styles.title}>{t.changePasswordTitle}</h3>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label htmlFor="cp-current" style={styles.label}>{t.currentPassword}</label>
          <PasswordInput id="cp-current" style={styles.input} value={form.current_password} onChange={e => set('current_password', e.target.value)} required minLength={8} autoFocus />
          <label htmlFor="cp-new" style={styles.label}>{t.newPassword}</label>
          <PasswordInput id="cp-new" style={styles.input} value={form.new_password} onChange={e => set('new_password', e.target.value)} required minLength={8} />
          <label htmlFor="cp-confirm" style={styles.label}>{t.confirmNewPassword}</label>
          <PasswordInput id="cp-confirm" style={styles.input} value={form.confirm_password} onChange={e => set('confirm_password', e.target.value)} required />
          {error && <p role="alert" style={styles.error}>{error}</p>}
          {success && <p style={styles.success}>{t.passwordChanged}</p>}
          <div style={styles.buttons}>
            <button type="button" style={styles.cancelBtn} onClick={onClose}>{t.cancel}</button>
            <button type="submit" style={{ ...styles.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} disabled={saving}>{saving ? t.saving : t.save}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#fff', borderRadius: 12, padding: '32px 28px', width: '100%', maxWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  title: { marginBottom: 20, fontSize: 18, fontWeight: 700 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontSize: 13, fontWeight: 600, color: '#555' },
  input: { padding: '9px 11px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 },
  error: { color: '#e53e3e', fontSize: 13 },
  success: { color: '#38a169', fontSize: 13 },
  buttons: { display: 'flex', gap: 10, marginTop: 8 },
  cancelBtn: { flex: 1, padding: '10px', background: '#f0f0f0', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14 },
  saveBtn: { flex: 1, padding: '10px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14 },
};
