import React, { useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './index.css';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalErrorHandlers, silentError } from './errorReporter';
import { redactAnalyticsEvent } from './analytics';
import { loadLanguage, subscribeLanguages, getLanguagesVersion } from './i18n';
import { bootLanguage } from './languageDetect';

const enableSpeedInsights = import.meta.env.PROD || import.meta.env.VITE_ENABLE_SPEED_INSIGHTS === 'true';
const enableAnalytics = import.meta.env.PROD || import.meta.env.VITE_ENABLE_ANALYTICS === 'true';
const enableServiceWorker = import.meta.env.PROD || import.meta.env.VITE_ENABLE_SERVICE_WORKER === 'true';

// Absent DSN = Sentry is a no-op.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
    // Small default sample — bump via env if you want full tracing.
    tracesSampleRate: parseFloat(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || '0'),
    // Keep volume low by default. The self-hosted /api/client-errors endpoint
    // stores 100% of reports; Sentry just gets the grouped/symbolicated view.
    sampleRate: 1.0,
  });
}

installGlobalErrorHandlers();

// Re-render the whole tree when another language's dictionary finishes loading,
// so components that call getT() directly (not via useT) pick it up too.
function Root() {
  useSyncExternalStore(subscribeLanguages, getLanguagesVersion);
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

// Surfaces a boot failure (e.g. the language chunk 404'd after a deploy) through
// the ErrorBoundary, which owns the stale-build reload/recovery logic.
function BootError({ error }) {
  throw error;
}

function render(content) {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      {content}
      {enableSpeedInsights && <SpeedInsights />}
      {enableAnalytics && <Analytics beforeSend={redactAnalyticsEvent} />}
    </React.StrictMode>
  );
}

// Translations are split per language and loaded on demand (see i18n.js). Fetch
// the active one BEFORE the first render so getT()/useT() are synchronous and
// nothing ever paints untranslated; the index.html boot splash covers the wait.
loadLanguage(bootLanguage()).then(
  () => render(<Root />),
  (error) => render(<ErrorBoundary><BootError error={error} /></ErrorBoundary>),
);

if ('serviceWorker' in navigator && enableServiceWorker) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(silentError('main'));
  });
} else if ('serviceWorker' in navigator && import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistrations()
      .then(registrations => {
        registrations
          .filter(registration => registration.scope.startsWith(window.location.origin))
          .forEach(registration => registration.unregister());
      })
      .catch(silentError('main'));
  });
}
