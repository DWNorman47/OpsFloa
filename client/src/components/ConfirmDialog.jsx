// Replacement for window.confirm() across the admin pages. window.confirm
// is a system-chrome modal that looks like 1998 and breaks focus + a11y.
// This component reuses the existing ModalShell (which handles focus
// trap, Escape, aria semantics) so confirmation flows match the rest of
// the app visually.
//
// Usage with the hook:
//   const { confirm, dialog } = useConfirm();
//   async function handleCancel() {
//     if (!await confirm({ title: 'Cancel PO?', body: 'Already-recorded payments stay in spent.' })) return;
//     await api.post(...);
//   }
//   return (<>...{dialog}</>);

import React, { useState, useRef, useCallback, useId } from 'react';
import ModalShell from './ModalShell';
import { useT } from '../hooks/useT';

// Hook for imperative confirm() calls. Returns the dialog JSX (which
// the consumer renders unconditionally at the bottom of their tree)
// and an async confirm() that resolves to true/false.
export function useConfirm() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState({});
  const resolveRef = useRef(null);
  // Per-instance title id so two simultaneous confirms (rare, but
  // possible if a page mounts multiple useConfirm callers) don't share
  // an id and break aria-labelledby on whichever rendered second.
  const titleId = useId();

  const confirm = useCallback((cfg = {}) => {
    return new Promise(resolve => {
      setConfig({
        title: cfg.title || t.cdAreYouSure || 'Are you sure?',
        body:  cfg.body || '',
        confirmLabel: cfg.confirmLabel || t.cdConfirm || 'Confirm',
        cancelLabel:  cfg.cancelLabel || t.cdCancel || 'Cancel',
        tone:  cfg.tone || 'primary',  // 'primary' | 'danger'
      });
      resolveRef.current = resolve;
      setOpen(true);
    });
  }, [t]);

  function done(value) {
    setOpen(false);
    resolveRef.current?.(value);
    resolveRef.current = null;
  }

  const dialog = open && (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && done(false)}>
      <ModalShell onClose={() => done(false)} titleId={titleId} style={styles.modal}>
        <h3 id={titleId} style={styles.title}>{config.title}</h3>
        {config.body && <p style={styles.body}>{config.body}</p>}
        <div style={styles.btnRow}>
          <button onClick={() => done(false)} style={styles.btnCancel}>
            {config.cancelLabel}
          </button>
          <button
            onClick={() => done(true)}
            style={{ ...styles.btnConfirm, ...(config.tone === 'danger' ? styles.btnDanger : {}) }}
            autoFocus
          >
            {config.confirmLabel}
          </button>
        </div>
      </ModalShell>
    </div>
  );

  return { confirm, dialog };
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10000, padding: 16,
  },
  modal: {
    background: '#fff', borderRadius: 10, padding: 24, maxWidth: 440,
    width: '100%', boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
  },
  title: { fontSize: 17, fontWeight: 700, margin: '0 0 8px', color: '#111827' },
  body: { fontSize: 14, color: '#4b5563', margin: '0 0 18px', lineHeight: 1.5 },
  btnRow: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  btnCancel: {
    background: '#fff', color: '#374151', border: '1px solid #d1d5db',
    padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  btnConfirm: {
    background: 'var(--ops-page-accent)', color: '#fff', border: 'none',
    padding: '8px 18px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  btnDanger: { background: '#dc2626' },
};
