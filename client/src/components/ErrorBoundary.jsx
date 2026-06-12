import React from 'react';
import { reportClientError } from '../errorReporter';
import { getT } from '../i18n';

// ErrorBoundary can't use hooks (class component), and when it renders it's
// because something inside AuthProvider crashed — so useAuth may be
// unavailable. Read the user's saved language directly from the auth blob
// in localStorage, fall back to English.
function readLang() {
  try {
    const raw = localStorage.getItem('tc_user');
    if (raw) return JSON.parse(raw)?.language || 'English';
  } catch { /* ignore */ }
  return 'English';
}

/**
 * True if the error looks like a stale-build / failed-chunk-load.
 * These happen when the user was on the page during a deploy and the
 * filenames they're about to fetch have already been replaced.
 */
function isChunkLoadError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

const RELOAD_FLAG = 'tc_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 30_000; // don't loop: once per 30s max

/**
 * Reload once to pick up the fresh build. Guarded by sessionStorage
 * so a bad build can't put us in a reload loop — if we reloaded
 * recently and still see the error, let the normal error UI render.
 */
function tryReloadForStaleBuild() {
  try {
    const last = parseInt(sessionStorage.getItem(RELOAD_FLAG) || '0', 10);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch { /* sessionStorage may be disabled */ }
  window.location.reload();
  return true;
}

// Cache the SW's reported version on module load so componentDidCatch can
// decide whether a render crash is most likely a stale-bundle artifact:
// the SW skipWaiting/clients.claim path swaps in the new app instantly, but
// the JS already running in this tab is still the old build, and an old →
// new API-shape mismatch typically throws a generic TypeError that the
// ChunkLoadError pattern won't catch.
let cachedSwVersion = null;
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (evt) => {
    if (evt.data?.type === 'SW_VERSION') cachedSwVersion = evt.data.version || null;
  });
  const askSw = () => {
    const ctrl = navigator.serviceWorker.controller;
    if (ctrl) ctrl.postMessage({ type: 'GET_VERSION' });
  };
  askSw();
  navigator.serviceWorker.addEventListener('controllerchange', askSw);
}

function bundleVersionMismatch() {
  // eslint-disable-next-line no-undef
  const bundle = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
  return Boolean(bundle && cachedSwVersion && bundle !== cachedSwVersion);
}

// Global safety net — chunk-load errors that happen OUTSIDE the React render
// (e.g. clicking a link that triggers a lazy route import) come through as
// unhandledrejection, not via the ErrorBoundary. Catch them here too.
if (typeof window !== 'undefined' && !window.__tc_chunk_listener_installed) {
  window.__tc_chunk_listener_installed = true;
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkLoadError(e.reason)) tryReloadForStaleBuild();
  });
  window.addEventListener('error', (e) => {
    if (isChunkLoadError(e.error || { message: e.message })) tryReloadForStaleBuild();
  });
}

/**
 * Catches render-phase errors from descendants.
 *
 * Two modes:
 *   - Top-level (default): full-screen recovery card, offers "Reload page".
 *   - Inline (mode="inline"): compact in-place error card that only wipes
 *     the wrapped subtree. Use for per-tab / per-section isolation so one
 *     crashed component doesn't nuke the whole app.
 *
 * Props:
 *   mode   — 'top' (default) | 'inline'
 *   label  — optional context label (e.g. "Daily Reports") shown in the inline card
 *   onReset — optional callback invoked when user clicks "Try again" in inline mode
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Stale-build chunk fetch failure: quietly reload once instead of showing
    // the full-screen crash card. Guarded against loops by the cooldown.
    if (isChunkLoadError(error) && tryReloadForStaleBuild()) return;
    // Stale-build runtime crash: the SW already serves the new app but this
    // tab is still on the old JS, so an old→new API-shape mismatch threw.
    // Same reload-once-then-give-up behaviour as the chunk path.
    if (bundleVersionMismatch() && tryReloadForStaleBuild()) return;

    console.error('Unhandled render error:', error, info?.componentStack);
    const stack = [error?.stack, info?.componentStack && `\nComponent stack:${info.componentStack}`]
      .filter(Boolean)
      .join('');
    reportClientError({
      kind: 'render',
      message: `${this.props.label ? `[${this.props.label}] ` : ''}${error?.message || 'Render crash'}`,
      stack,
    });
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const t = getT(readLang());

    if (this.props.mode === 'inline') {
      return (
        <div role="alert" style={styles.inlineCard}>
          <div style={styles.inlineIcon}>⚠️</div>
          <div style={{ flex: 1 }}>
            <div style={styles.inlineTitle}>
              {this.props.label
                ? (t.errorSectionLabelCrashed || '{label} crashed').replace('{label}', this.props.label)
                : t.errorSectionCrashed}
            </div>
            <div style={styles.inlineMsg}>{t.errorStillWorking}</div>
          </div>
          <button style={styles.inlineBtn} onClick={this.reset}>{t.errorTryAgain}</button>
        </div>
      );
    }

    // Top-level / full-page
    const goHome = () => {
      // Use href (not pushState) so the app fully remounts and any
      // bad in-memory state from the crash is discarded.
      window.location.href = '/';
    };
    const signOut = () => {
      try {
        localStorage.removeItem('tc_token');
        localStorage.removeItem('tc_user');
        sessionStorage.removeItem('tc_token');
        sessionStorage.removeItem('tc_user');
      } catch { /* ignore */ }
      window.location.href = '/login';
    };
    const onHome = window.location.pathname === '/' || window.location.pathname === '';
    // Surface the JS error name + message directly on the card instead of
    // burying them in <details>. Helps the user describe what they saw and
    // helps us recognise a known failure mode from a screenshot.
    const errName = this.state.error?.name;
    const errMessage = this.state.error?.message;
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.icon}>⚠️</div>
          <h2 style={styles.title}>{t.errorSomethingWentWrong}</h2>
          <p style={styles.msg}>{t.errorUnexpectedTryReload}</p>
          {errMessage && (
            <div style={styles.errBox}>
              {errName && <span style={styles.errName}>{errName}: </span>}
              {errMessage}
            </div>
          )}
          <div style={styles.btnRow}>
            <button style={styles.btn} onClick={() => window.location.reload()}>{t.errorReloadPage}</button>
            {!onHome && (
              <button style={styles.btnSecondary} onClick={goHome}>{t.errorGoHome}</button>
            )}
            <button style={styles.btnGhost} onClick={signOut}>{t.errorSignOut}</button>
          </div>
          <details style={styles.details}>
            <summary style={styles.summary}>{t.errorDetails}</summary>
            <pre style={styles.pre}>{this.state.error.stack || this.state.error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}

const styles = {
  // Top-level
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb', padding: 24 },
  card: { background: '#fff', borderRadius: 12, padding: 40, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', maxWidth: 440, width: '100%', textAlign: 'center' },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 8 },
  msg: { fontSize: 14, color: '#6b7280', marginBottom: 24 },
  btnRow: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 20 },
  btn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnSecondary: { background: '#fff', color: 'var(--ops-page-accent)', border: '1px solid var(--ops-page-accent)', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnGhost: { background: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  errBox: {
    textAlign: 'left',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    marginBottom: 16,
    wordBreak: 'break-word',
    maxHeight: 160,
    overflowY: 'auto',
  },
  errName: { fontWeight: 700 },
  details: { textAlign: 'left', marginTop: 8 },
  summary: { fontSize: 12, color: '#6b7280', cursor: 'pointer' },
  pre: { fontSize: 11, color: '#ef4444', background: '#fef2f2', borderRadius: 6, padding: 10, overflowX: 'auto', marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },

  // Inline / per-section
  inlineCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 10,
    padding: '14px 18px',
    margin: '16px 0',
  },
  inlineIcon: { fontSize: 22, flexShrink: 0 },
  inlineTitle: { fontWeight: 700, color: '#991b1b', fontSize: 14, marginBottom: 2 },
  inlineMsg: { fontSize: 13, color: '#6b7280' },
  inlineBtn: {
    background: '#dc2626',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '7px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
};
