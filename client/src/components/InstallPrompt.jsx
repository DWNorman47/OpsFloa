import React, { useState, useEffect } from 'react';
import { useT } from '../hooks/useT';

function getPlatform() {
  if (typeof window === 'undefined') return null;

  // Already installed as PWA — don't show
  if (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  ) return 'installed';

  // User already dismissed
  if (localStorage.getItem('install_prompt_dismissed') === '1') return 'dismissed';

  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);

  if (isIOS) {
    // Chrome/Firefox on iOS can't install — need Safari
    const isNonSafariBrowser = /crios|fxios|opios|mercury/i.test(ua);
    return isNonSafariBrowser ? 'ios-wrong-browser' : 'ios';
  }
  if (isAndroid) return 'android';

  return null; // Desktop — don't show
}

function ShareIcon() {
  return (
    <svg style={{ display: 'inline', verticalAlign: 'middle', margin: '0 2px' }}
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function Step({ n, children }) {
  return (
    <div style={styles.step}>
      <span style={styles.stepNum}>{n}</span>
      <span style={styles.stepText}>{children}</span>
    </div>
  );
}

export default function InstallPrompt() {
  const t = useT();
  const [platform, setPlatform] = useState(null);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    setPlatform(getPlatform());

    // Android Chrome fires this when installable
    const handler = e => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const dismiss = () => {
    localStorage.setItem('install_prompt_dismissed', '1');
    setPlatform('dismissed');
  };

  const androidInstall = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setPlatform('installed');
    } else {
      setInstalling(false);
    }
    setDeferredPrompt(null);
  };

  if (!platform || platform === 'installed' || platform === 'dismissed') return null;

  return (
    <div style={styles.banner}>
      <button style={styles.closeBtn} onClick={dismiss} aria-label={t.dismiss}>✕</button>
      <div style={styles.icon}>📲</div>

      {platform === 'ios' && (
        <>
          <div style={styles.heading}>{t.installOpsFloa}</div>
          <div style={styles.steps}>
            <Step n={1}>{t.installIosStep1} <ShareIcon /></Step>
            <Step n={2}>{t.installIosStep2}</Step>
            <Step n={3}>{t.installIosStep3}</Step>
          </div>
          <div style={styles.note}>{t.installNativeAppNote}</div>
        </>
      )}

      {platform === 'ios-wrong-browser' && (
        <>
          <div style={styles.heading}>{t.installOpenSafariHeading}</div>
          <div style={styles.body}>
            {t.installOpenSafariBodyBefore} <ShareIcon /> {t.installOpenSafariBodyAfter}
          </div>
        </>
      )}

      {platform === 'android' && (
        <>
          <div style={styles.heading}>{t.installOpsFloa}</div>
          {deferredPrompt ? (
            <>
              <div style={styles.body}>{t.installAndroidBody}</div>
              <button style={{ ...styles.installBtn, ...(installing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={androidInstall} disabled={installing}>
                {installing ? t.installInstalling : t.installAddToHomeScreen}
              </button>
            </>
          ) : (
            <>
              <div style={styles.steps}>
                <Step n={1}>{t.installAndroidStep1}</Step>
                <Step n={2}>{t.installAndroidStep2}</Step>
                <Step n={3}>{t.installAndroidStep3}</Step>
              </div>
              <div style={styles.note}>{t.installNativeAppNote}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  banner: {
    position: 'relative', background: '#eff6ff', border: '1px solid #bfdbfe',
    borderRadius: 12, padding: '16px 40px 14px 16px',
    boxShadow: '0 2px 12px rgba(26,86,219,0.10)',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  closeBtn: {
    position: 'absolute', top: 10, right: 12, background: 'none', border: 'none',
    color: '#6b7280', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: 2,
  },
  icon: { fontSize: 22, lineHeight: 1 },
  heading: { fontWeight: 700, fontSize: 15, color: '#1e3a8a' },
  body: { fontSize: 13, color: '#374151', lineHeight: 1.5 },
  steps: { display: 'flex', flexDirection: 'column', gap: 7 },
  step: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  stepNum: {
    background: 'var(--ops-page-accent)', color: '#fff', borderRadius: '50%',
    width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1,
  },
  stepText: { fontSize: 13, color: '#374151', lineHeight: 1.5 },
  note: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
  installBtn: {
    alignSelf: 'flex-start', background: 'var(--ops-page-accent)', color: '#fff', border: 'none',
    padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
};
