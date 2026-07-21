import React, { useEffect, useMemo, useState } from 'react';
import AppHeader from './AppHeader';
import { useAuth } from '../contexts/AuthContext';
import { safeLocal } from '../utils/safeStorage';

const APP_ACCENTS = {
  home: '#0f766e',
  timeclock: '#2563eb',
  workforce: '#1d4ed8',
  field: '#059669',
  inventory: '#b45309',
  tools: '#0f766e',
  team: '#0284c7',
  projects: '#7c3aed',
  administration: '#475569',
  analytics: '#0e7490',
  account: '#475569',
  // Construction money / compliance modules.
  sales: '#1d4ed8',      // Estimates + Change Orders
  subs: '#0369a1',       // Subcontractors + POs
  booking: '#0d9488',    // Booking / appointments
  help: '#475569',
  financial_reports: '#15803d', // P&L + WIP (matches the switcher icon)
};

export function PageShell({
  currentApp,
  features,
  children,
  maxWidth = 960,
  mainClassName = '',
  headerProps = {},
}) {
  const accent = APP_ACCENTS[currentApp] || '#0f766e';
  return (
    <div className="ops-page" style={{ '--ops-page-accent': accent }}>
      <AppHeader currentApp={currentApp} features={features} {...headerProps} />
      <main
        id="main-content"
        className={`ops-main ${mainClassName}`.trim()}
        style={{ '--ops-main-width': `${maxWidth}px` }}
      >
        {children}
      </main>
    </div>
  );
}

export function PageIntro({ introId, kicker, title, description, actions, meta }) {
  const { user } = useAuth();
  const storageKey = useMemo(() => {
    const userKey = user?.id || user?.username || user?.email || 'anonymous';
    const pageKey = introId || String(title || kicker || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `opsfloa_intro_seen_${userKey}_${pageKey}`;
  }, [introId, kicker, title, user?.email, user?.id, user?.username]);
  const [seen, setSeen] = useState(() => {
    try { return safeLocal.getItem(storageKey) === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { setSeen(safeLocal.getItem(storageKey) === '1'); } catch { setSeen(false); }
  }, [storageKey]);

  useEffect(() => {
    if (seen) return;
    try { safeLocal.setItem(storageKey, '1'); } catch {}
  }, [seen, storageKey]);

  if (seen) return null;

  return (
    <section className="ops-page-intro">
      <div>
        {kicker && <p className="ops-page-kicker">{kicker}</p>}
        <h1>{title}</h1>
        {description && <p className="ops-page-description">{description}</p>}
        {meta && <div className="ops-page-meta">{meta}</div>}
      </div>
      {actions && <div className="ops-page-actions">{actions}</div>}
    </section>
  );
}

export function PageSection({ eyebrow, title, description, actions, children, className = '' }) {
  return (
    <section className={`ops-section ${className}`.trim()}>
      {(eyebrow || title || description || actions) && (
        <div className="ops-section-head">
          <div>
            {eyebrow && <p className="ops-section-eyebrow">{eyebrow}</p>}
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="ops-section-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
