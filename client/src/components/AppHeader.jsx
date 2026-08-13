/**
 * Single shared header used by every app page (worker + admin) so the top
 * strip is identical across modules and screen sizes.
 *
 * Mobile (≤768px, via app-switcher-name / header-username / header-right CSS):
 *   [icon-only AppSwitcher] ... [Chat] [Bell] [Account menu]
 *   [company name band below]
 *
 * Desktop (>768px):
 *   [icon+name AppSwitcher] [Company name] ... [User's name] [Chat] [Bell] [Account menu]
 *
 * The account menu (avatar) holds Refresh / Language / Guide / Logout.
 *
 * Background color tracks the currentApp (derived from AppSwitcher's APPS
 * table) so module identity is preserved.
 *
 * Extras: pass `rightExtras` to render something before the refresh button
 * (e.g. the worker Dashboard's inline clock-in timer). Pass `below` to render
 * something between the top row and the mobile company-name band (e.g.
 * a trial-ending warning banner).
 */

import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import AppSwitcher, { APPS } from './AppSwitcher';
import NotificationBell from './NotificationBell';
import MessagesBell from './MessagesBell';
import AccountMenu from './AccountMenu';
import GuideDrawer from './GuideDrawer';

export default function AppHeader({
  currentApp,
  features = {},
  userRole,
  rightExtras,
  below,
  companyBandExtras,
}) {
  const { user } = useAuth();
  const [guideOpen, setGuideOpen] = useState(false);
  const app = APPS.find(a => a.id === currentApp);
  const accent = app?.bg || '#2563eb';

  return (
    <header style={{ ...s.header, '--app-accent': accent }} className="app-header">
      <div style={s.headerTopRow}>
        <div style={s.logoGroup}>
          <AppSwitcher currentApp={currentApp} userRole={userRole || user?.role} features={features} />
          {user?.company_name && (
            <span style={s.companyName} className="company-name-desktop">{user.company_name}</span>
          )}
        </div>
        <div style={s.headerRight} className="header-right">
          {user?.full_name && (
            <span style={s.userName} className="header-username">{user.full_name}</span>
          )}
          {features?.feature_chat !== false && <MessagesBell />}
          <NotificationBell />
          {rightExtras}
          <AccountMenu onOpenGuide={() => setGuideOpen(true)} />
        </div>
      </div>
      <GuideDrawer
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        currentApp={currentApp}
        features={features}
      />
      {below}
      {user?.company_name && (
        <div className="company-name-row">
          <span className="company-name">{user.company_name}</span>
          {companyBandExtras}
        </div>
      )}
    </header>
  );
}

const s = {
  header: {
    color: '#0f172a',
    padding: '0 6px 0 24px',
    paddingTop: 'env(safe-area-inset-top)',
    paddingBottom: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minHeight: 'calc(56px + env(safe-area-inset-top))',
    position: 'sticky',
    top: 0,
    zIndex: 100,
    background: 'rgba(255,255,255,0.96)',
    borderBottom: '1px solid #e2e8f0',
    boxShadow: '0 1px 10px rgba(15,23,42,0.05)',
    backdropFilter: 'blur(12px)',
  },
  headerTopRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    height: 56,
  },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 12 },
  companyName: { fontSize: 15, fontWeight: 700, color: '#334155' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  userName: { fontSize: 14, color: '#475569', whiteSpace: 'nowrap' },
};
