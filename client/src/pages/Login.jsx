import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import api from '../api';
import PasswordInput from '../components/PasswordInput';
import { pickLandingPath } from '../modulePermissions';

function getSavedCompanies() {
  try { return JSON.parse(localStorage.getItem('tc_companies') || '[]'); } catch { return []; }
}

function saveCompany(name) {
  const list = getSavedCompanies().filter(c => c.toLowerCase() !== name.toLowerCase());
  localStorage.setItem('tc_companies', JSON.stringify([name, ...list]));
}

const OTHER = '__other__';
const DEMO_COMPANY_NAME = 'Demo Operations';
const DEMO_USERNAME = 'Admin';
const DEMO_PASSWORD = 'Admin123';

export default function Login() {
  const { login, confirmMfa, loginWithToken } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get('session') === 'expired';
  const inviteCompany = searchParams.get('company') || '';
  const savedCompanies = getSavedCompanies();
  const [selected, setSelected] = useState(inviteCompany ? OTHER : (savedCompanies[0] || OTHER));
  const [otherText, setOtherText] = useState(inviteCompany);
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [unconfirmedEmail, setUnconfirmedEmail] = useState('');
  const [resentConfirmation, setResentConfirmation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mfaToken, setMfaToken] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const mfaInputRef = useRef(null);
  const [setupToken, setSetupToken] = useState(null);
  const [setupForm, setSetupForm] = useState({ password: '', confirm: '' });
  const demoAutofilledRef = useRef(false);

  const companyName = selected === OTHER ? otherText : selected;

  useEffect(() => {
    const isDemoCompany = companyName.trim().toLowerCase() === DEMO_COMPANY_NAME.toLowerCase();

    if (isDemoCompany) {
      demoAutofilledRef.current = true;
      setForm({ username: DEMO_USERNAME, password: DEMO_PASSWORD });
      return;
    }

    if (demoAutofilledRef.current) {
      demoAutofilledRef.current = false;
      setForm(current => (
        current.username === DEMO_USERNAME && current.password === DEMO_PASSWORD
          ? { username: '', password: '' }
          : current
      ));
    }
  }, [companyName]);

  const navigateAfterLogin = user => {
    saveCompany(companyName.trim());
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    // First-time admins still get the welcoming nudge to /administration so
    // they know where billing / settings live. After that, route to whichever
    // module they actually have access to (Phase D — picks the first module
    // their permissions unlock; falls back to /account if they have none).
    if (isAdmin) {
      const key = `tc_visited_${user.id}`;
      const firstTime = !localStorage.getItem(key);
      localStorage.setItem(key, '1');
      if (firstTime) { navigate('/administration'); return; }
    }
    navigate(pickLandingPath(user));
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!companyName.trim()) return;
    setError('');
    setLoading(true);
    try {
      const result = await login(form.username, form.password, companyName.trim());
      if (result?.must_change_password) {
        setSetupToken(result.setup_token);
        return;
      }
      if (result?.mfa_required) {
        setMfaToken(result.mfa_token);
        setTimeout(() => mfaInputRef.current?.focus(), 50);
        return;
      }
      navigateAfterLogin(result);
    } catch (err) {
      const data = err.response?.data;
      if (data?.error === 'email_not_confirmed') {
        setUnconfirmedEmail(data.email || '');
        setError(t.loginConfirmEmailFirst);
      } else {
        setUnconfirmedEmail('');
        setError(data?.error || t.loginFailed);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await confirmMfa(mfaToken, mfaCode);
      navigateAfterLogin(user);
    } catch (err) {
      setError(err.response?.data?.error || t.loginInvalidCode);
      setMfaCode('');
      setTimeout(() => mfaInputRef.current?.focus(), 50);
    } finally {
      setLoading(false);
    }
  };

  if (setupToken) {
    const handleSetup = async e => {
      e.preventDefault();
      if (setupForm.password !== setupForm.confirm) { setError(t.loginPasswordsDontMatch); return; }
      setError('');
      setLoading(true);
      try {
        const r = await api.post('/auth/complete-setup', { setup_token: setupToken, new_password: setupForm.password });
        await loginWithToken(r.data.token);
        navigateAfterLogin(r.data.user);
      } catch (err) {
        setError(err.response?.data?.error || t.loginFailedSetPassword);
      } finally {
        setLoading(false);
      }
    };
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>OpsFloa</h1>
          <p style={styles.subtitle}>{t.loginSetPasswordTitle}</p>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16, textAlign: 'center' }}>
            {t.loginTempPasswordNote}
          </p>
          <form onSubmit={handleSetup} style={styles.form}>
            <label htmlFor="setup-password" style={styles.label}>{t.loginNewPasswordLabel}</label>
            <PasswordInput
              id="setup-password"
              style={styles.input}
              placeholder={t.loginAtLeastChars}
              value={setupForm.password}
              onChange={e => setSetupForm(f => ({ ...f, password: e.target.value }))}
              required
              minLength={6}
              autoFocus
            />
            <label htmlFor="setup-confirm" style={styles.label}>{t.loginConfirmPasswordLabel}</label>
            <PasswordInput
              id="setup-confirm"
              style={styles.input}
              placeholder={t.loginRepeatPasswordPh}
              value={setupForm.confirm}
              onChange={e => setSetupForm(f => ({ ...f, confirm: e.target.value }))}
              required
            />
            {error && <p role="alert" style={styles.error}>{error}</p>}
            <button style={styles.button} type="submit" disabled={loading}>
              {loading ? t.saving : t.loginSetPasswordBtn}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (mfaToken) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>OpsFloa</h1>
          <p style={styles.subtitle}>{t.loginMfaTitle}</p>
          <form onSubmit={handleMfaSubmit} style={styles.form}>
            <label htmlFor="mfa-code" style={styles.label}>{t.loginMfaCodeLabel}</label>
            <input
              id="mfa-code"
              ref={mfaInputRef}
              style={{ ...styles.input, textAlign: 'center', fontSize: 22, letterSpacing: 8, fontWeight: 700 }}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              required
            />
            {error && <p role="alert" style={styles.error}>{error}</p>}
            <button style={styles.button} type="submit" disabled={loading || mfaCode.length !== 6}>
              {loading ? t.loginVerifying : t.loginVerify}
            </button>
            <button type="button" style={styles.forgotLink} onClick={() => { setMfaToken(null); setError(''); setMfaCode(''); }}>
              {t.loginBackToSignIn}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>OpsFloa</h1>
        <p style={styles.subtitle}>{t.loginSubtitle}</p>
        {sessionExpired && (
          <p style={styles.sessionMsg}>{t.loginSessionExpired}</p>
        )}
        <form onSubmit={handleSubmit} style={styles.form}>
          <label htmlFor="company" style={styles.label}>{t.loginCompanyLabel}</label>
          {savedCompanies.length > 0 ? (
            <>
              <select
                id="company"
                style={styles.input}
                value={selected}
                onChange={e => setSelected(e.target.value)}
              >
                {savedCompanies.map(c => <option key={c} value={c}>{c}</option>)}
                <option value={OTHER}>{t.loginOtherCompany}</option>
              </select>
              {selected === OTHER && (
                <input
                  style={styles.input}
                  type="text"
                  placeholder={t.loginEnterCompanyPh}
                  value={otherText}
                  onChange={e => setOtherText(e.target.value)}
                  onBlur={e => setOtherText(e.target.value.trim())}
                  autoFocus
                  required
                />
              )}
            </>
          ) : (
            <input
              id="company"
              style={styles.input}
              type="text"
              value={otherText}
              onChange={e => setOtherText(e.target.value)}
              onBlur={e => setOtherText(e.target.value.trim())}
              autoFocus
              required
            />
          )}
          <label htmlFor="username" style={styles.label}>{t.loginUsernameLabel}</label>
          <input
            id="username"
            style={styles.input}
            type="text"
            value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            onBlur={e => setForm(f => ({ ...f, username: e.target.value.trim() }))}
            required
          />
          <label htmlFor="login-password" style={styles.label}>{t.loginPasswordLabel}</label>
          <PasswordInput
            id="login-password"
            style={styles.input}
            value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            required
          />
          {error && (
            <div>
              <p role="alert" style={styles.error}>{error}</p>
              {unconfirmedEmail && (
                <button
                  type="button"
                  style={styles.resendBtn}
                  onClick={() => {
                    api.post('/auth/resend-confirmation', { email: unconfirmedEmail })
                      .then(() => setResentConfirmation(true));
                  }}
                >
                  {resentConfirmation ? t.loginResentConfirmation : t.loginResendConfirmation}
                </button>
              )}
            </div>
          )}
          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? t.loginSigningIn : t.loginSignIn}
          </button>
          <Link to="/forgot-password" style={styles.forgotLink}>{t.loginForgotPassword}</Link>
        </form>
        <p style={styles.registerLink}>
          {t.loginNewToOpsFloa} <Link to="/register" style={styles.link}>{t.loginCreateAccount}</Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f9' },
  card: { background: '#fff', borderRadius: 12, padding: '40px 36px', width: '100%', maxWidth: 380, boxShadow: '0 4px 24px rgba(0,0,0,0.10)' },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 4, textAlign: 'center', color: 'var(--ops-page-accent)' },
  subtitle: { textAlign: 'center', color: '#666', marginBottom: 28 },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  label: { fontWeight: 600, fontSize: 14, color: '#444' },
  input: { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15, outline: 'none' },
  error: { color: '#e53e3e', fontSize: 14 },
  sessionMsg: { background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 8 },
  button: { marginTop: 8, padding: '12px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600 },
  registerLink: { marginTop: 20, textAlign: 'center', fontSize: 13, color: '#666' },
  link: { color: 'var(--ops-page-accent)', fontWeight: 600, textDecoration: 'none' },
  forgotLink: { display: 'block', textAlign: 'right', fontSize: 13, color: '#6b7280', textDecoration: 'none', marginTop: 4 },
  resendBtn: { background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 0', textDecoration: 'underline' },
};
