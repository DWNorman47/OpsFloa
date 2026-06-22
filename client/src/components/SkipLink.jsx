import React from 'react';
import { useT } from '../hooks/useT';

/**
 * Skip-to-main-content link. Rendered at the very top of the DOM, visually
 * hidden until it receives focus (via Tab key from a fresh page load). Then
 * it pops into view as the first focusable element — a keyboard user can
 * hit Tab → Enter to jump past the header nav and land directly in main.
 *
 * Requires each page's <main> element to have id="main-content".
 */
export default function SkipLink() {
  const t = useT();
  return (
    <a href="#main-content" style={styles.link} className="skip-link">
      {t.skipToMain || 'Skip to main content'}
    </a>
  );
}

// .skip-link:focus rule lives in index.css — when focused it slides into
// view from offscreen. These inline styles are the "hidden until focused"
// base.
const styles = {
  link: {
    position: 'absolute',
    top: -40,
    left: 0,
    background: 'var(--ops-page-accent)',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: '0 0 6px 0',
    fontWeight: 700,
    fontSize: 14,
    zIndex: 10000,
    textDecoration: 'none',
    transition: 'top 0.15s ease',
  },
};
