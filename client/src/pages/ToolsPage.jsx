import React, { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { getOrFetch } from '../offlineDb';
import { silentError } from '../errorReporter';
import { PageIntro, PageSection, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import { isImpersonating, openToolTab } from '../openTool';
import TranscriptionTool from '../components/TranscriptionTool';
import SummarizerTool from '../components/SummarizerTool';
import DocQATool from '../components/DocQATool';
import RedFlagScannerTool from '../components/RedFlagScannerTool';
import CalculatorsTool from '../components/CalculatorsTool';
import EmailDrafterTool from '../components/EmailDrafterTool';
import CrewCardTool from '../components/CrewCardTool';

const PLANROOM_TOOL_URL = '/tool-apps/planroom/index.html';
const PDFTOOLS_TOOL_URL = '/tool-apps/pdftools/index.html';

// Default to Plan Room (the daily-use base tool, always visible).
function resolveTab() {
  const h = window.location.hash.replace('#', '');
  if (!h) return 'planroom';
  return h;
}

export default function ToolsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(resolveTab);

  // Plan Room is the $40 base tier — a daily-use horizontal tool; its tab is
  // always visible so the whole company can discover it (unowned → locked card).
  const hasPlanroom = !!(user?.addon_planroom || ['exempt', 'trial'].includes(user?.subscription_status));
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  useEffect(() => {
    let cancelled = false;
    getOrFetch('settings', () => api.get('/settings').then(r => r.data))
      .then(data => { if (!cancelled) setSettings(data); })
      .catch(silentError('toolspage-settings'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onHash = () => setTab(resolveTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTab = next => {
    setTab(next);
    history.replaceState(null, '', `#${next}`);
  };

  // While impersonating, hand the active token to the tool tab (see openTool.js).
  // Direct logins fall through to the normal anchor navigation.
  const toolClick = url => e => { if (isImpersonating()) { e.preventDefault(); openToolTab(url); } };

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

  const tabs = [
    { id: 'planroom', label: 'Plan Room' },
    { id: 'transcription', label: 'Transcription' },
    { id: 'summarizer', label: 'Summarizer' },
    { id: 'docqa', label: 'Doc Q&A' },
  { id: 'redflags', label: 'Red-Flag Scanner' },
  { id: 'calcs', label: 'Calculators' },
    { id: 'emaildraft', label: 'Email Drafter' },
    { id: 'crewcard', label: 'Crew Cards' },
    { id: 'pdftools', label: 'PDF Toolkit' },
  ];

  return (
    <PageShell currentApp="tools" features={settings || {}} maxWidth={960}>
      <PageIntro
        introId="tools"
        kicker="Tools"
        title="Useful calculators and work helpers"
        description="Keep specialized utilities close by without crowding the daily workflow. Tools open separately so the main app stays right where you left it."
        meta={<span className="ops-pill accent">{tabs.length} tools available</span>}
      />

      <TabBar
        active={tab}
        onChange={switchTab}
        tabs={tabs}
        ariaLabel="Tools sections"
      />

      {tab === 'planroom' && (
        <PageSection
          eyebrow="Plan Room"
          title="Plan viewer, markup & measure"
          description="Open a plan set — PDF or aerial image — mark it up, and measure lengths, areas, and counts to scale. Share to a company library or run a live session."
          actions={hasPlanroom ? (
            <a className="ops-button-primary" href={PLANROOM_TOOL_URL} target="_blank" rel="noopener noreferrer" onClick={toolClick(PLANROOM_TOOL_URL)}>
              Open in new tab
            </a>
          ) : null}
        >
          {hasPlanroom ? (
            <a className="tools-card" href={PLANROOM_TOOL_URL} target="_blank" rel="noopener noreferrer" onClick={toolClick(PLANROOM_TOOL_URL)}>
              <span className="tools-card-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="14" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M8 4v14" />
                </svg>
              </span>
              <span className="tools-card-copy">
                <strong>Plan Room</strong>
                <span>View, mark up, and measure plan sets in the browser — clouds, callouts, highlights, lengths, areas, counts. Work saves on this device; share a set to your company or export a flattened PDF.</span>
              </span>
              <span className="tools-card-action">Open</span>
            </a>
          ) : (
            <div className="tools-card" style={{ cursor: 'default' }}>
              <span className="tools-card-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
              </span>
              <span className="tools-card-copy">
                <strong>Plan Room — add-on</strong>
                <span>
                  View, mark up, and measure plan sets right in the browser — clouds, callouts, lengths, areas, counts — with a company library, live share sessions, and flattened-PDF export.{' '}
                  {isAdmin ? 'Add it from Billing to switch it on for your company.' : 'Ask an admin to add it from Billing.'}
                </span>
              </span>
              {isAdmin
                ? <a className="tools-card-action" href="/administration#billing">Add it</a>
                : <span className="tools-card-action">Locked</span>}
            </div>
          )}
        </PageSection>
      )}

      {tab === 'transcription' && (
        <PageSection
          eyebrow="Transcription"
          title="Voice transcription, minutes & daily logs"
          description="Upload a meeting, call, or jobsite recording and get back a transcript that separates who said what. Then turn it into meeting minutes — or walk the site talking and turn a voice memo into a structured daily log (work done, deliveries, delays, action items)."
        >
          <TranscriptionTool />
        </PageSection>
      )}

      {tab === 'summarizer' && (
        <PageSection
          eyebrow="Office"
          title="Meeting & call summarizer"
          description="Paste a transcript or notes and get a clean summary with key points and action items. Pairs with the transcription tool."
        >
          <SummarizerTool />
        </PageSection>
      )}

      {tab === 'docqa' && (
        <PageSection
          eyebrow="Office"
          title="Document Q&A"
          description="Open a contract, spec, or insurance cert and ask questions about it — answers come only from the document. Great for the dense paperwork you don't have time to read."
        >
          <DocQATool />
        </PageSection>
      )}

      {tab === 'calcs' && (
        <PageSection
          eyebrow="Field"
          title="Calculators"
          description="The everyday math — concrete and rebar, asphalt and base, slope, rafters, stairs, board feet, paint and tile, and the unit conversions. No plans, no setup, works offline."
        >
          <CalculatorsTool />
        </PageSection>
      )}

      {tab === 'redflags' && (
        <PageSection
          eyebrow="Office"
          title="Contract Red-Flag Scanner"
          description="Upload a subcontract and get back the terms that cost you money — pay-if-paid, short notice windows, liquidated damages, one-sided indemnity — worst first, each with the clause quoted and what to ask for instead."
        >
          <RedFlagScannerTool />
        </PageSection>
      )}

      {tab === 'emaildraft' && (
        <PageSection
          eyebrow="Office"
          title="Email & message drafter"
          description="Turn a few notes into a polished email or text — payment reminders, quote follow-ups, running-late messages — in the tone you pick."
        >
          <EmailDrafterTool />
        </PageSection>
      )}

      {tab === 'crewcard' && (
        <PageSection
          eyebrow="Crew"
          title="Bilingual crew task cards"
          description="Type the day's tasks in English and hand your crew a clean Spanish task card. Keep it bilingual to check the translation, or switch to Spanish-only for the printout."
        >
          <CrewCardTool />
        </PageSection>
      )}

      {tab === 'pdftools' && (
        <PageSection
          eyebrow="Office"
          title="PDF Toolkit"
          description="Combine, reorder, rotate, delete, and extract PDF pages right in your browser — no upload, nothing leaves your device."
          actions={(
            <a className="ops-button-primary" href={PDFTOOLS_TOOL_URL} target="_blank" rel="noopener noreferrer">
              Open in new tab
            </a>
          )}
        >
          <a className="tools-card" href={PDFTOOLS_TOOL_URL} target="_blank" rel="noopener noreferrer">
            <span className="tools-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
                <path d="M9 13h6" />
                <path d="M9 17h6" />
              </svg>
            </span>
            <span className="tools-card-copy">
              <strong>PDF Toolkit</strong>
              <span>Merge several PDFs into one, drag pages to reorder, rotate or delete pages, or tick a few and extract them as a new file. Runs entirely on your device.</span>
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
