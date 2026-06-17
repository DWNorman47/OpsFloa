import React, { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useT } from '../hooks/useT';
import api from '../api';
import PasswordInput from '../components/PasswordInput';

export default function ResetPassword() {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    if (password !== confirm) { setError(t.resetPasswordsDontMatch); return; }
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password }, { suppressToast: true });
      navigate('/login?reset=1');
    } catch (err) {
      setError(err.response?.data?.error || t.resetFailed);
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.logo}>OpsFloa</h1>
          <p style={styles.body}>{t.resetInvalidLink} <Link to="/forgot-password" style={styles.link}>{t.resetRequestNew}</Link>.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.logo}>OpsFloa</h1>
        <h2 style={styles.title}>{t.resetTitle}</h2>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label htmlFor="reset-password" style={styles.label}>{t.resetNewPasswordLabel}</label>
          <PasswordInput
            id="reset-password"
            style={styles.input}
            placeholder={t.loginAtLeastChars}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={8}
            autoFocus
          />
          <label htmlFor="reset-confirm" style={styles.label}>{t.resetConfirmPasswordLabel}</label>
          <PasswordInput
            id="reset-confirm"
            style={styles.input}
            placeholder={t.loginRepeatPasswordPh}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />
          {error && <p role="alert" style={styles.error}>{error}</p>}
          <button style={styles.btn} type="submit" disabled={loading}>
            {loading ? t.saving : t.resetSetPasswordBtn}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { background: '#fff', borderRadius: 14, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.09)', width: '100%', maxWidth: 380 },
  logo: { fontSize: 22, fontWeight: 800, color: 'var(--ops-page-accent)', marginBottom: 4, textAlign: 'center' },
  title: { fontSize: 18, fontWeight: 700, color: '#1a202c', marginBottom: 20, textAlign: 'center' },
  body: { fontSize: 14, color: '#6b7280', textAlign: 'center', lineHeight: 1.6 },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  input: { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 },
  error: { color: '#e53e3e', fontSize: 13 },
  btn: { marginTop: 8, padding: '11px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: 'pointer' },
  link: { color: 'var(--ops-page-accent)', fontWeight: 600, textDecoration: 'none' },
};
