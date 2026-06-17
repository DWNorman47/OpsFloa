/**
 * Simple changelog view. Hand-edit the entries array when you ship a release
 * worth mentioning. Keep entries short and user-facing — "worker's project
 * dropdown now refreshes after admin creates a project" is better than
 * "refactored getOrFetch invalidation".
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../hooks/useT';

const ENTRIES = [
  {
    version: '2026-04-21 (afternoon)',
    headline: 'Polish',
    items: [
      'Unified header across every module — same buttons, same layout, mobile-friendly.',
      'Admins can override overtime hours per entry, in hours + minutes.',
      'Live admin view refreshes every 10 seconds while you\'re watching it.',
      '4xx server errors no longer silently disappear — you see what went wrong.',
    ],
  },
  {
    version: '2026-04-21',
    headline: 'Reliability',
    items: [
      'Live admin changes now reach team members faster (work lists, module toggles).',
      'Refresh-while-online always returns fresh data; cache stays offline-only.',
      'Worker "Login as" impersonation for any user from SuperAdmin.',
      'SuperAdmin: force-logout any user, impersonation log, company data export, full company delete cleanup.',
      'Clock-in no longer requires work selection when no work exists.',
      'Username or email both work on login.',
      'Excel/CSV import for inventory items.',
      'Team module with a company-wide directory.',
    ],
  },
];

export default function Changelog() {
  const t = useT();
  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <Link to="/" style={styles.back}>{t.changelogBack}</Link>
        <h1 style={styles.title}>{t.changelogTitle}</h1>
        {ENTRIES.map(entry => (
          <section key={entry.version} style={styles.entry}>
            <header style={styles.entryHeader}>
              <span style={styles.version}>{entry.version}</span>
              <span style={styles.headline}>{entry.headline}</span>
            </header>
            <ul style={styles.list}>
              {entry.items.map((item, i) => <li key={i} style={styles.item}>{item}</li>)}
            </ul>
          </section>
        ))}
        <p style={styles.footer}>
          {t.changelogFeedback} <a href="mailto:support@opsfloa.com" style={styles.link}>support@opsfloa.com</a>.
        </p>
      </div>
    </div>
  );
}

const styles = {
  page:      { minHeight: '100vh', background: '#f4f6f9', padding: '32px 16px' },
  container: { maxWidth: 720, margin: '0 auto' },
  back:      { display: 'inline-block', marginBottom: 16, color: 'var(--ops-page-accent)', fontSize: 14, textDecoration: 'none' },
  title:     { fontSize: 28, fontWeight: 800, color: '#111827', marginBottom: 24, letterSpacing: '-0.01em' },
  entry:     { background: '#fff', borderRadius: 12, padding: '20px 24px', marginBottom: 16, border: '1px solid #e5e7eb' },
  entryHeader: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
  version:   { fontFamily: 'monospace', fontSize: 13, color: '#6b7280' },
  headline:  { fontSize: 16, fontWeight: 700, color: '#111827' },
  list:      { margin: 0, paddingLeft: 20 },
  item:      { fontSize: 14, color: '#374151', lineHeight: 1.6, marginBottom: 4 },
  footer:    { fontSize: 13, color: '#6b7280', textAlign: 'center', marginTop: 32 },
  link:      { color: 'var(--ops-page-accent)', textDecoration: 'none' },
};
