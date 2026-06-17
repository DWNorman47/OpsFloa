import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../hooks/useT';
import api from '../api';

export default function ForgotPassword() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email, company }, { suppressToast: true });
      setSent(true);
    } catch {
      setError(t.forgotError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.logo}>OpsFloa</h1>
        {sent ? (
          <>
            <h2 style={styles.title}>{t.forgotCheckEmailTitle}</h2>
            <p style={styles.body}>{t.forgotCheckEmailDesc}</p>
            <Link to="/login" style={styles.backLink}>{t.forgotBackToLogin}</Link>
          </>
        ) : (
          <>
            <h2 style={styles.title}>{t.forgotTitle}</h2>
            <p style={styles.body}>{t.forgotSubtitle}</p>
            <form onSubmit={handleSubmit} style={styles.form}>
              <label htmlFor="forgot-email" style={styles.label}>{t.email}</label>
              <input
                id="forgot-email"
                style={styles.input}
                type="email"
                placeholder={t.forgotEmailPh}
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
              />
              <label htmlFor="forgot-company" style={styles.label}>
                {t.forgotCompanyLabel} <span style={styles.optional}>{t.forgotCompanyOptional}</span>
              </label>
              <input
                id="forgot-company"
                style={styles.input}
                type="text"
                placeholder={t.forgotCompanyPh}
                value={company}
                onChange={e => setCompany(e.target.value)}
              />
              {error && <p role="alert" style={styles.error}>{error}</p>}
              <button style={styles.btn} type="submit" disabled={loading}>
                {loading ? t.forgotSending : t.forgotSendLinkBtn}
              </button>
            </form>
            <p style={styles.footer}>
              <Link to="/login" style={styles.link}>{t.forgotBackToLogin}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { background: '#fff', borderRadius: 14, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.09)', width: '100%', maxWidth: 380 },
  logo: { fontSize: 22, fontWeight: 800, color: 'var(--ops-page-accent)', marginBottom: 4, textAlign: 'center' },
  title: { fontSize: 18, fontWeight: 700, color: '#1a202c', marginBottom: 8, textAlign: 'center' },
  body: { fontSize: 14, color: '#6b7280', textAlign: 'center', marginBottom: 24, lineHeight: 1.6 },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  input: { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 },
  error: { color: '#e53e3e', fontSize: 13 },
  btn: { marginTop: 8, padding: '11px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: 'pointer' },
  optional: { fontWeight: 400, color: '#6b7280', fontSize: 11 },
  footer: { marginTop: 20, textAlign: 'center', fontSize: 13 },
  link: { color: 'var(--ops-page-accent)', fontWeight: 600, textDecoration: 'none' },
  backLink: { display: 'block', marginTop: 20, textAlign: 'center', fontSize: 13, color: 'var(--ops-page-accent)', fontWeight: 600, textDecoration: 'none' },
};
