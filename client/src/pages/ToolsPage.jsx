import React, { useEffect, useState } from 'react';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { silentError } from '../errorReporter';
import { PageIntro, PageSection, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';

const EXCAVATION_TOOL_URL = '/tool-apps/excavation/index.html';

export default function ToolsPage() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(() => window.location.hash.replace('#', '') || 'excavation');

  useEffect(() => {
    let cancelled = false;
    getOrFetch('settings', () => api.get('/settings').then(r => r.data))
      .then(data => { if (!cancelled) setSettings(data); })
      .catch(silentError('toolspage-settings'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onHash = () => setTab(window.location.hash.replace('#', '') || 'excavation');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTab = next => {
    setTab(next);
    history.replaceState(null, '', `#${next}`);
  };

  if (loading) {
    return (
      <PageShell currentApp="tools" features={settings || {}} maxWidth={960}>
        <div className="ops-loading-state">Loading tools...</div>
      </PageShell>
    );
  }

  if (settings?.module_tools === false) {
    return (
      <PageShell currentApp="tools" features={settings || {}} maxWidth={760}>
        <div style={styles.disabled}>
          <h2 style={styles.disabledTitle}>Tools are turned off</h2>
          <p style={styles.disabledBody}>An admin can turn this module back on from Administration &gt; Workspace &gt; Company Settings.</p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell currentApp="tools" features={settings || {}} maxWidth={960}>
      <PageIntro
        introId="tools"
        kicker="Tools"
        title="Useful calculators and work helpers"
        description="Keep specialized utilities close by without crowding the daily workflow. Tools open separately so the main app stays right where you left it."
        meta={<span className="ops-pill accent">1 tool available</span>}
      />

      <TabBar
        active={tab}
        onChange={switchTab}
        tabs={[{ id: 'excavation', label: 'Excavation' }]}
        ariaLabel="Tools sections"
      />

      {tab === 'excavation' && (
        <PageSection
          eyebrow="Excavation"
          title="Excavation takeoff"
          description="Open the cut/fill takeoff calculator for civil plans, contours, pads, boundaries, and volume estimates."
          actions={(
            <a className="ops-button-primary" href={EXCAVATION_TOOL_URL} target="_blank" rel="noopener noreferrer">
              Open in new tab
            </a>
          )}
        >
          <a className="tools-card" href={EXCAVATION_TOOL_URL} target="_blank" rel="noopener noreferrer">
            <span className="tools-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19h16" />
                <path d="m6 19 6-14 6 14" />
                <path d="M8 14h8" />
                <path d="M10 9h4" />
              </svg>
            </span>
            <span className="tools-card-copy">
              <strong>Excavation Bid Calculator</strong>
              <span>Load a PDF plan set, trace existing and proposed surfaces, and estimate cut/fill volume. Work saves in the browser for this device.</span>
            </span>
            <span className="tools-card-action">Open</span>
          </a>
        </PageSection>
      )}
    </PageShell>
  );
}

const styles = {
  disabled: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 22,
    boxShadow: 'var(--ops-shadow-sm)',
  },
  disabledTitle: { margin: 0, fontSize: 22, lineHeight: 1.2, color: '#0f172a' },
  disabledBody: { margin: '8px 0 0', color: '#64748b', lineHeight: 1.55 },
};
