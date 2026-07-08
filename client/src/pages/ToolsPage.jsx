import React, { useEffect, useState } from 'react';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { silentError } from '../errorReporter';
import { PageIntro, PageSection, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import TranscriptionTool from '../components/TranscriptionTool';
import SummarizerTool from '../components/SummarizerTool';
import DocQATool from '../components/DocQATool';

const SITEWORK_TOOL_URL = '/tool-apps/sitework/index.html';
const PDFTOOLS_TOOL_URL = '/tool-apps/pdftools/index.html';

// the old excavation tool was removed; its '#excavation' deep links land on sitework
function resolveTab() {
  const h = window.location.hash.replace('#', '');
  return !h || h === 'excavation' ? 'sitework' : h;
}

export default function ToolsPage() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(resolveTab);

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
        meta={<span className="ops-pill accent">5 tools available</span>}
      />

      <TabBar
        active={tab}
        onChange={switchTab}
        tabs={[
          { id: 'sitework', label: 'Sitework Takeoff' },
          { id: 'transcription', label: 'Transcription' },
          { id: 'summarizer', label: 'Summarizer' },
          { id: 'docqa', label: 'Doc Q&A' },
          { id: 'pdftools', label: 'PDF Toolkit' },
        ]}
        ariaLabel="Tools sections"
      />

      {tab === 'sitework' && (
        <PageSection
          eyebrow="Sitework"
          title="Sitework Takeoff Estimator"
          description="Take off quantities from civil plan sets — earthwork cut/fill, paving, concrete, utilities, and site items — and turn them into a priced, branded bid."
          actions={(
            <a className="ops-button-primary" href={SITEWORK_TOOL_URL} target="_blank" rel="noopener noreferrer">
              Open in new tab
            </a>
          )}
        >
          <a className="tools-card" href={SITEWORK_TOOL_URL} target="_blank" rel="noopener noreferrer">
            <span className="tools-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8" />
                <path d="M8 12h8" />
                <path d="M8 16h5" />
              </svg>
            </span>
            <span className="tools-card-copy">
              <strong>Sitework Takeoff Estimator</strong>
              <span>Load a PDF plan set and take off earthwork, paving, concrete, utilities, and site quantities — then build a priced, branded bid. Work saves in the browser for this device.</span>
            </span>
            <span className="tools-card-action">Open</span>
          </a>
        </PageSection>
      )}

      {tab === 'transcription' && (
        <PageSection
          eyebrow="Transcription"
          title="Voice transcription"
          description="Upload a meeting or call recording and get back a transcript that separates who said what. Rename speakers, jump the audio to any line, and copy or download the text."
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
