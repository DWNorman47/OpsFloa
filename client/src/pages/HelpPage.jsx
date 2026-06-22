import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import AppHeader from '../components/AppHeader';
import OfflineBanner from '../components/OfflineBanner';
import { HELP_SECTIONS } from '../helpContent';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { silentError } from '../errorReporter';

/**
 * Public-ish help / FAQ page. Content lives in helpContent.js so future
 * edits don't need code changes — add or revise items there and the page
 * picks them up. Sections are independently collapsible; the URL hash
 * deep-links into a section (e.g. /help#approvals).
 */
export default function HelpPage() {
  const { user } = useAuth();
  const t = useT();
  const [settings, setSettings] = useState(null);
  // First section is open by default, plus whatever the URL hash points at.
  const [open, setOpen] = useState(() => {
    const initial = new Set([HELP_SECTIONS[0]?.id]);
    const hash = window.location.hash.replace('#', '');
    if (hash && HELP_SECTIONS.some(s => s.id === hash)) initial.add(hash);
    return initial;
  });
  const [query, setQuery] = useState('');
  const sectionRefs = useRef({});

  useEffect(() => {
    if (!user) return;
    getOrFetch('settings', () => api.get('/settings').then(r => r.data))
      .then(setSettings)
      .catch(silentError('helppage'));
  }, [user]);

  // If the user opened the page with a hash, scroll to that section.
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash && sectionRefs.current[hash]) {
      sectionRefs.current[hash].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const toggle = id => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Filter: when the query is non-empty, show every section but only the
  // items whose question or answer matches. Hide sections with zero matches.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? HELP_SECTIONS.map(section => ({
        ...section,
        items: section.items.filter(it => {
          const haystack = (it.q + ' ' + (Array.isArray(it.a) ? it.a.join(' ') : it.a)).toLowerCase();
          return haystack.includes(q);
        }),
      })).filter(s => s.items.length > 0)
    : HELP_SECTIONS;

  return (
    <div style={styles.page}>
      <OfflineBanner />
      <AppHeader currentApp="account" features={settings || {}} />

      <main id="main-content" style={styles.main} className="mobile-main">
        <div style={styles.headerCard}>
          <h1 style={styles.h1}>{t.helpTitle}</h1>
          <p style={styles.lead}>
            {t.helpLead}
          </p>
          <input
            type="search"
            placeholder={t.helpSearchPlaceholder}
            style={styles.search}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {!q && (
          <nav style={styles.toc} aria-label={t.helpSectionsAria}>
            {HELP_SECTIONS.map(s => (
              <a
                key={s.id}
                href={`#${s.id}`}
                style={styles.tocLink}
                onClick={() => {
                  setOpen(prev => new Set([...prev, s.id]));
                }}
              >
                {s.title}
              </a>
            ))}
          </nav>
        )}

        {filtered.length === 0 && (
          <div style={styles.empty}>
            {t.helpNoMatchesPre} "{query}". {t.helpNoMatchesPost}
          </div>
        )}

        {/* Admin-only: re-run the first-run setup questionnaire. Hidden
            from workers because they can't run setup. */}
        {(user?.role === 'admin' || user?.role === 'super_admin') && !q && (
          <div style={styles.actionCard}>
            <div>
              <div style={styles.actionTitle}>{t.helpSetupTitle}</div>
              <div style={styles.actionSub}>
                {t.helpSetupSub}
              </div>
            </div>
            <a href="/administration?setup=1" style={styles.actionBtn}>{t.helpOpenSetup}</a>
          </div>
        )}

        {filtered.map(section => {
          const isOpen = q ? true : open.has(section.id);
          return (
            <section
              key={section.id}
              id={section.id}
              ref={el => { sectionRefs.current[section.id] = el; }}
              style={styles.section}
            >
              <button
                type="button"
                style={styles.sectionHeader}
                onClick={() => !q && toggle(section.id)}
                aria-expanded={isOpen}
              >
                <span style={styles.sectionTitle}>{section.title}</span>
                {!q && <span style={styles.chev}>{isOpen ? '▾' : '▸'}</span>}
              </button>
              {isOpen && (
                <div style={styles.sectionBody}>
                  {section.intro && <p style={styles.intro}>{section.intro}</p>}
                  <dl style={styles.dl}>
                    {section.items.map((item, i) => (
                      <div key={i} style={styles.qa}>
                        <dt style={styles.q}>{item.q}</dt>
                        <dd style={styles.a}>
                          {Array.isArray(item.a)
                            ? item.a.map((p, j) => <p key={j} style={styles.p}>{p}</p>)
                            : <p style={styles.p}>{item.a}</p>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', '--ops-page-accent': '#475569' },
  main: { maxWidth: 760, margin: '24px auto', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 16 },
  headerCard: { background: '#fff', borderRadius: 12, padding: '20px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' },
  h1: { fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' },
  lead: { fontSize: 14, color: '#4b5563', lineHeight: 1.55, margin: '8px 0 16px' },
  search: {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    fontSize: 14,
    boxSizing: 'border-box',
  },
  toc: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    background: '#fff',
    borderRadius: 12,
    padding: '12px 16px',
    boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
  },
  tocLink: {
    fontSize: 13,
    color: 'var(--ops-page-accent)',
    textDecoration: 'none',
    padding: '4px 10px',
    borderRadius: 6,
    background: '#eef2ff',
    fontWeight: 500,
  },
  section: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.06)', overflow: 'hidden' },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '14px 20px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
  },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: '#111827' },
  chev: { color: '#6b7280', fontSize: 13 },
  sectionBody: { padding: '4px 20px 20px', borderTop: '1px solid #f3f4f6' },
  intro: { fontSize: 14, color: '#4b5563', lineHeight: 1.55, margin: '12px 0 4px' },
  dl: { margin: '8px 0 0' },
  qa: { padding: '14px 0', borderTop: '1px solid #f3f4f6' },
  q: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 6 },
  a: { margin: 0 },
  p: { fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 8px' },
  empty: {
    background: '#fff',
    borderRadius: 12,
    padding: '24px',
    color: '#6b7280',
    fontSize: 14,
    textAlign: 'center',
    boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
  },
  actionCard: {
    background: '#fff',
    borderRadius: 12,
    padding: '16px 20px',
    boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap',
  },
  actionTitle: { fontSize: 14, fontWeight: 600, color: '#111827' },
  actionSub: { fontSize: 13, color: '#6b7280', marginTop: 4, lineHeight: 1.5 },
  actionBtn: {
    background: 'var(--ops-page-accent)',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'none',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
};
