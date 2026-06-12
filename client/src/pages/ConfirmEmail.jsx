import React, { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useT } from '../hooks/useT';
import api from '../api';

export default function ConfirmEmail() {
  const t = useT();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState('loading'); // 'loading' | 'success' | 'error'
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) { setStatus('error'); setError(t.confirmEmailNoToken); return; }
    api.post('/auth/confirm-email', { token })
      .then(() => setStatus('success'))
      .catch(err => { setStatus('error'); setError(err.response?.data?.error || t.confirmEmailError); });
  }, [token]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.logo}>OpsFloa</h1>
        {status === 'loading' && <p style={styles.msg}>{t.confirmEmailLoading}</p>}
        {status === 'success' && (
          <>
            <div style={styles.icon}>✓</div>
            <h2 style={styles.title}>{t.confirmEmailSuccessTitle}</h2>
            <p style={styles.sub}>{t.confirmEmailActiveDesc}</p>
            <Link to="/login" style={styles.btn}>{t.confirmEmailGoToLogin}</Link>
          </>
        )}
        {status === 'error' && (
          <>
            <h2 style={{ ...styles.title, color: '#e53e3e' }}>{t.confirmEmailFailedTitle}</h2>
            <p style={styles.sub}>{error}</p>
            <p style={styles.sub}>{t.confirmEmailExpiredLink} <Link to="/login" style={styles.link}>{t.confirmEmailRequestNew}</Link> {t.confirmEmailFromLoginPage}</p>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { background: '#fff', borderRadius: 14, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.09)', width: '100%', maxWidth: 400, textAlign: 'center' },
  logo: { fontSize: 22, fontWeight: 800, color: 'var(--ops-page-accent)', marginBottom: 24 },
  icon: { fontSize: 48, color: '#059669', marginBottom: 12 },
  title: { fontSize: 20, fontWeight: 700, marginBottom: 8 },
  sub: { color: '#666', fontSize: 14, marginBottom: 16 },
  msg: { color: '#666', fontSize: 15 },
  btn: { display: 'inline-block', marginTop: 8, padding: '11px 28px', background: 'var(--ops-page-accent)', color: '#fff', borderRadius: 8, fontWeight: 700, fontSize: 15, textDecoration: 'none' },
  link: { color: 'var(--ops-page-accent)', fontWeight: 600 },
};
