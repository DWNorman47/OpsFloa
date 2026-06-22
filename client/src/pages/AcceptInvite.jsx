import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useT } from '../hooks/useT';
import api from '../api';
import PasswordInput from '../components/PasswordInput';

export default function AcceptInvite() {
  const t = useT();
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [username, setUsername] = useState('');
  const [companyName, setCompanyName] = useState('');

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError(t.invitePasswordsDontMatch);
    if (password.length < 6) return setError(t.invitePasswordTooShort);
    setLoading(true);
    try {
      const r = await api.post('/auth/accept-invite', { token, password }, { suppressToast: true });
      setUsername(r.data.username);
      setCompanyName(r.data.company_name || '');
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || t.inviteSomethingWrong);
    } finally {
      setLoading(false);
    }
  };

  if (!token) return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p role="alert" style={styles.error}>{t.inviteInvalidLink}</p>
      </div>
    </div>
  );

  if (done) return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h2 style={styles.title}>{t.inviteAllSetTitle}</h2>
        <p style={styles.sub}>{t.invitePasswordSetDesc.split('{username}')[0]}<strong>{username}</strong>{t.invitePasswordSetDesc.split('{username}')[1]}</p>
        <button style={styles.btn} onClick={() => navigate(`/login${companyName ? `?company=${encodeURIComponent(companyName)}` : ''}`)}>{t.inviteGoToLogin}</button>
      </div>
    </div>
  );

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h2 style={styles.title}>{t.inviteTitle}</h2>
        <p style={styles.sub}>{t.inviteWelcome}</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <PasswordInput style={styles.input} placeholder={t.inviteNewPasswordPh} value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
          <PasswordInput style={styles.input} placeholder={t.inviteConfirmPasswordPh} value={confirm} onChange={e => setConfirm(e.target.value)} required />
          {error && <p role="alert" style={styles.error}>{error}</p>}
          <button style={styles.btn} type="submit" disabled={loading}>{loading ? t.saving : t.inviteSetPasswordBtn}</button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { background: '#fff', borderRadius: 12, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.10)', width: '100%', maxWidth: 400 },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 8, color: '#1a1a1a' },
  sub: { color: '#666', fontSize: 14, marginBottom: 24 },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  input: { padding: '11px 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15 },
  error: { color: '#e53e3e', fontSize: 13 },
  btn: { padding: '12px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: 'pointer' },
};
