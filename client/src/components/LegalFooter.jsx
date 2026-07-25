import React from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../hooks/useT';
import { LEGAL_ENTITY } from '../legal';

// Small legal footer for the public entry pages (sign in / sign up). Surfaces
// the Terms of Use and Privacy Policy links and the copyright line. The entity
// name comes from a single source (../legal) so it swaps cleanly once the
// business is registered.
export default function LegalFooter() {
  const t = useT();
  const year = new Date().getFullYear();
  return (
    <footer style={styles.footer}>
      <div style={styles.links}>
        <Link to="/eula" style={styles.link}>{t.registerAgreeEula}</Link>
        <span style={styles.dot}>·</span>
        <Link to="/privacy" style={styles.link}>{t.registerAgreePrivacy}</Link>
      </div>
      <div style={styles.copy}>© {year} {LEGAL_ENTITY}</div>
    </footer>
  );
}

const styles = {
  footer: { marginTop: 24, textAlign: 'center' },
  links: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  link: { color: '#6b7280', fontSize: 12, textDecoration: 'none' },
  dot: { color: '#cbd5e1', fontSize: 12 },
  copy: { color: '#9ca3af', fontSize: 12, marginTop: 6 },
};
