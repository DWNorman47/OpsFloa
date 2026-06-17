import PasswordInput from '../components/PasswordInput';
import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import api from '../api';

export default function Register() {
  const { loginWithToken } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const [form, setForm] = useState({ company_name: '', first_name: '', middle_name: '', last_name: '', email: '', username: '', password: '' });
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(null); // email address waiting for confirmation
  const [resendState, setResendState] = useState('idle'); // 'idle' | 'sending' | 'sent'

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleNameChange = (k, v) => {
    const updated = { ...form, [k]: v };
    setForm(f => {
      const next = { ...f, [k]: v };
      if (!usernameEdited) {
        const first = k === 'first_name' ? v : f.first_name;
        const last = k === 'last_name' ? v : f.last_name;
        const suggested = (first.charAt(0) + last).toLowerCase().replace(/[^a-z0-9]/g, '');
        next.username = suggested;
      }
      return next;
    });
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setSaving(true);
    const full_name = [form.first_name, form.middle_name, form.last_name].filter(Boolean).join(' ');
    try {
      const r = await api.post('/auth/register', { ...form, full_name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { suppressToast: true });
      if (r.data.pending_confirmation) { setConfirming(r.data.email); return; }
      await loginWithToken(r.data.token);
      try { const saved = JSON.parse(localStorage.getItem('tc_companies') || '[]'); localStorage.setItem('tc_companies', JSON.stringify([form.company_name.trim(), ...saved.filter(c => c.toLowerCase() !== form.company_name.trim().toLowerCase())])); } catch {}
      navigate('/timeclock#wf-live');
    } catch (err) {
      setError(err.response?.data?.error || t.registerFailed);
    } finally {
      setSaving(false);
    }
  };

  if (confirming) return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.logo}>OpsFloa</h1>
        <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 12 }}>📧</div>
        <h2 style={styles.title}>{t.registerCheckEmailTitle}</h2>
        <p style={{ color: '#666', fontSize: 14, textAlign: 'center', marginBottom: 16 }}>
          {t.registerCheckEmailDesc.split('{email}')[0]}<strong>{confirming}</strong>{t.registerCheckEmailDesc.split('{email}')[1]}
        </p>
        <p style={{ color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
          {t.registerDidntGetIt}{' '}
          <button style={{ background: 'none', border: 'none', color: resendState === 'sent' ? '#059669' : 'var(--ops-page-accent)', fontWeight: 600, cursor: resendState === 'idle' ? 'pointer' : 'default', fontSize: 13, padding: 0 }}
            disabled={resendState !== 'idle'}
            onClick={async () => {
              setResendState('sending');
              try { await api.post('/auth/resend-confirmation', { email: confirming }); } catch {}
              setResendState('sent');
              setTimeout(() => setResendState('idle'), 4000);
            }}>
            {resendState === 'sending' ? t.sending : resendState === 'sent' ? t.registerSent : t.registerResend}
          </button>.
        </p>
      </div>
    </div>
  );

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.logo}>OpsFloa</h1>
        <h2 style={styles.title}>{t.registerTitle}</h2>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label htmlFor="reg-company" style={styles.label}>{t.companyName}</label>
          <input
            id="reg-company"
            style={styles.input}
            placeholder={t.registerCompanyPh}
            maxLength={100}
            value={form.company_name}
            onChange={e => set('company_name', e.target.value)}
            onBlur={e => set('company_name', e.target.value.trim())}
            required
          />
          <label htmlFor="reg-first-name" style={styles.label}>{t.firstName}</label>
          <input
            id="reg-first-name"
            style={styles.input}
            placeholder={t.registerFirstNamePh}
            value={form.first_name}
            onChange={e => handleNameChange('first_name', e.target.value)}
            required
          />
          <label htmlFor="reg-middle-name" style={styles.label}>{t.registerMiddleName} <span style={styles.hint}>{t.optionalHint}</span></label>
          <input
            id="reg-middle-name"
            style={styles.input}
            placeholder={t.registerMiddleNamePh}
            value={form.middle_name}
            onChange={e => set('middle_name', e.target.value)}
          />
          <label htmlFor="reg-last-name" style={styles.label}>{t.lastName}</label>
          <input
            id="reg-last-name"
            style={styles.input}
            placeholder={t.registerLastNamePh}
            value={form.last_name}
            onChange={e => handleNameChange('last_name', e.target.value)}
            required
          />
          <label htmlFor="reg-email" style={styles.label}>{t.email}</label>
          <input
            id="reg-email"
            style={styles.input}
            type="email"
            placeholder={t.registerEmailPh}
            value={form.email}
            onChange={e => set('email', e.target.value)}
            onBlur={e => set('email', e.target.value.trim())}
            required
          />
          <label htmlFor="reg-username" style={styles.label}>{t.username}</label>
          <input
            id="reg-username"
            style={styles.input}
            placeholder={t.registerUsernamePh}
            maxLength={50}
            value={form.username}
            autoComplete="off"
            onChange={e => { setUsernameEdited(!!e.target.value); set('username', e.target.value); }}
            onBlur={e => set('username', e.target.value.trim())}
            required
          />
          <label htmlFor="reg-password" style={styles.label}>{t.loginPasswordLabel}</label>
          <PasswordInput
            id="reg-password"
            style={styles.input}
            placeholder={t.registerPasswordPh}
            value={form.password}
            onChange={e => set('password', e.target.value)}
            required
            minLength={8}
          />
          {error && <p role="alert" style={styles.error}>{error}</p>}
          <button style={styles.btn} type="submit" disabled={saving}>
            {saving ? t.registerCreating : t.registerCreateBtn}
          </button>
        </form>
        <p style={styles.loginLink}>
          {t.registerAlreadyHaveAccount} <Link to="/login" style={styles.link}>{t.registerLogIn}</Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { background: '#fff', borderRadius: 14, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.09)', width: '100%', maxWidth: 400 },
  logo: { fontSize: 22, fontWeight: 800, color: 'var(--ops-page-accent)', marginBottom: 4, textAlign: 'center' },
  title: { fontSize: 18, fontWeight: 700, color: '#1a202c', marginBottom: 24, textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151', marginTop: 8 },
  input: { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 },
  error: { color: '#e53e3e', fontSize: 13, margin: '4px 0 0' },
  btn: { marginTop: 16, padding: '11px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: 'pointer' },
  loginLink: { marginTop: 20, textAlign: 'center', fontSize: 13, color: '#666' },
  link: { color: 'var(--ops-page-accent)', fontWeight: 600, textDecoration: 'none' },
  hint: { fontWeight: 400, color: '#6b7280', fontSize: 12 },
};
