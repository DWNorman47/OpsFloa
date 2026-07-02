import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';

export default function InventoryColumnPicker({ columns, selectedColumns, onToggle, onReset, buttonStyle }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState(false);
  const ref = useRef(null);
  const visibleCount = columns.filter(col => col.visible).length;
  const emptyHiddenCount = columns.filter(col => col.selected && col.emptyHidden).length;

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const toggleOpen = () => {
    setSheetMode(window.innerWidth <= 600);
    setOpen(o => !o);
  };

  const menu = (
    <div style={sheetMode ? styles.sheet : styles.menu}>
      {sheetMode && (
        <div style={styles.sheetHead}>
          <strong style={styles.sheetTitle}>{t.icpColumns}</strong>
          <button type="button" style={styles.closeBtn} onClick={() => setOpen(false)}>{t.close}</button>
        </div>
      )}
      <div style={styles.titleRow}>
        <div>
          <div style={styles.title}>{t.icpShowColumns}</div>
          {emptyHiddenCount > 0 && (
            <div style={styles.hint}>
              {emptyHiddenCount} {t.icpHiddenSuffix}
            </div>
          )}
        </div>
        {onReset && (
          <button type="button" style={styles.resetBtn} onClick={onReset}>{t.reset}</button>
        )}
      </div>
      <div style={styles.optionGrid}>
        {columns.map(col => (
          <label key={col.key} style={{ ...styles.option, ...(col.locked ? styles.locked : {}) }}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={!!selectedColumns[col.key]}
              disabled={col.locked}
              onChange={() => onToggle(col.key)}
            />
            <span style={styles.optionText}>{col.label || t.invcpActions}</span>
            {col.emptyHidden && <span style={styles.muted}>{t.invcpNoData}</span>}
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={ref} style={styles.wrap}>
      <button type="button" style={buttonStyle || styles.trigger} onClick={toggleOpen}>
        {t.invcpColumns} ({visibleCount})
      </button>
      {open && (
        <>
          {sheetMode && <button type="button" aria-label="Close columns" style={styles.backdrop} onClick={() => setOpen(false)} />}
          {menu}
        </>
      )}
    </div>
  );
}

const styles = {
  wrap: { position: 'relative', display: 'inline-flex' },
  trigger: { padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  menu: { position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 2600, width: 250, maxHeight: 360, overflowY: 'auto', background: '#fff', border: '1px solid #d1d5db', borderRadius: 10, boxShadow: '0 14px 34px rgba(15,23,42,0.18)', padding: 10 },
  backdrop: { position: 'fixed', inset: 0, zIndex: 2599, border: 'none', background: 'rgba(15, 23, 42, 0.34)', padding: 0 },
  sheet: { position: 'fixed', left: 8, right: 8, bottom: 8, zIndex: 2600, maxHeight: '72vh', overflowY: 'auto', background: '#fff', border: '1px solid #d1d5db', borderRadius: 12, boxShadow: '0 -18px 42px rgba(15,23,42,0.24)', padding: 10 },
  sheetHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '2px 2px 8px', borderBottom: '1px solid #e5e7eb', marginBottom: 8 },
  sheetTitle: { fontSize: 14, color: '#111827', fontWeight: 800 },
  closeBtn: { border: 'none', background: 'transparent', color: '#64748b', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  titleRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 },
  title: { fontSize: 12, fontWeight: 800, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.05em' },
  hint: { marginTop: 4, fontSize: 11, color: '#64748b', lineHeight: 1.35 },
  resetBtn: { border: 'none', background: '#f1f5f9', color: '#334155', borderRadius: 7, padding: '5px 8px', minHeight: 0, fontSize: 11, fontWeight: 800, cursor: 'pointer' },
  optionGrid: { display: 'grid', gap: 3 },
  option: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 8, padding: '8px 7px', borderRadius: 7, color: '#374151', fontSize: 13, fontWeight: 650, cursor: 'pointer' },
  checkbox: { minHeight: 0, width: 14, height: 14, margin: 0 },
  locked: { opacity: 0.7, cursor: 'default' },
  optionText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { fontSize: 11, color: '#94a3b8', fontWeight: 800 },
};
