import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './index.css';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalErrorHandlers, silentError } from './errorReporter';
import { redactAnalyticsEvent } from './analytics';

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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    {enableSpeedInsights && <SpeedInsights />}
    {enableAnalytics && <Analytics beforeSend={redactAnalyticsEvent} />}
  </React.StrictMode>
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
