import React from 'react';

/**
 * TEMPORARY: a tiny build-version marker floated in the bottom corner, so we
 * can confirm at a glance which build a browser is actually running during the
 * current round of deploys. Remove this component (and its use in App.jsx)
 * once it's no longer needed.
 */
export default function VersionFooter() {
  // eslint-disable-next-line no-undef
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
  if (!version) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        bottom: 4,
        right: 8,
        fontSize: 10,
        lineHeight: 1,
        color: '#9ca3af',
        opacity: 0.6,
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 1500,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      v{version}
    </div>
  );
}
