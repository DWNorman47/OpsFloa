import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';

export default function ColumnHeaderMenu({
  label,
  align = 'left',
  sortKey,
  activeSort,
  sortDir,
  onSort,
  filterType,
  filterValue = '',
  onFilter,
  options = [],
  suggestions = [],
  placeholder,
}) {
  const t = useT();
  const effectivePlaceholder = placeholder ?? t.invchFilter;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filterValue || '');
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, right: 'auto' });
  const [sheetMode, setSheetMode] = useState(false);
  const ref = useRef(null);
  const isActiveSort = activeSort === sortKey;
  const hasFilter = filterValue !== '' && filterValue != null;
  const visibleSuggestions = filterType === 'text'
    ? suggestions
        .filter(Boolean)
        .map(v => String(v))
        .filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i)
        .filter(v => !draft || v.toLowerCase().includes(String(draft).toLowerCase()))
        .slice(0, 8)
    : [];

  useEffect(() => setDraft(filterValue || ''), [filterValue]);

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onMove = e => {
      if (sheetMode) return;
      if (ref.current && ref.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, sheetMode]);

  const applyFilter = () => {
    onFilter?.(draft);
    setOpen(false);
  };

  const clearFilter = () => {
    setDraft('');
    onFilter?.('');
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ ...styles.wrap, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
      <button
        type="button"
        style={{ ...styles.trigger, ...(isActiveSort || hasFilter ? styles.triggerActive : {}) }}
        onClick={e => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const width = 230;
          const useSheet = window.innerWidth <= 600;
          const left = align === 'right'
            ? Math.max(8, rect.right - width)
            : Math.min(rect.left, window.innerWidth - width - 8);
          setSheetMode(useSheet);
          setMenuPos({ top: rect.bottom + 8, left, right: 'auto' });
          setOpen(o => !o);
        }}
      >
        <span>{label}</span>
        {isActiveSort && <span style={styles.mark}>{sortDir === 'asc' ? 'A-Z' : 'Z-A'}</span>}
        <span style={styles.chev}>&#9662;</span>
      </button>
      {open && (
        <>
          {sheetMode && <button type="button" aria-label={t.chmCloseAria} style={styles.backdrop} onClick={() => setOpen(false)} />}
          <div style={sheetMode ? styles.sheet : { ...styles.menu, top: menuPos.top, left: menuPos.left }}>
            {sheetMode && (
              <div style={styles.sheetHead}>
                <strong style={styles.sheetTitle}>{label}</strong>
                <button type="button" style={styles.closeBtn} onClick={() => setOpen(false)}>{t.close}</button>
              </div>
            )}
            {sortKey && (
              <>
                <button type="button" style={styles.menuBtn} onClick={() => { onSort?.(sortKey, 'asc'); setOpen(false); }}>
                  {t.chmSortAsc}
                </button>
                <button type="button" style={styles.menuBtn} onClick={() => { onSort?.(sortKey, 'desc'); setOpen(false); }}>
                  {t.chmSortDesc}
                </button>
              </>
            )}
            {filterType && <div style={styles.divider} />}
            {filterType === 'text' && (
              <div style={styles.filterBlock}>
                <input
                  style={styles.input}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder={effectivePlaceholder}
                  onKeyDown={e => { if (e.key === 'Enter') applyFilter(); if (e.key === 'Escape') setOpen(false); }}
                  autoFocus
                />
                {visibleSuggestions.length > 0 && (
                  <div style={styles.suggestions}>
                    {visibleSuggestions.map(value => (
                      <button
                        key={value}
                        type="button"
                        style={styles.suggestionBtn}
                        onClick={() => {
                          setDraft(value);
                          onFilter?.(value);
                          setOpen(false);
                        }}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                )}
                <div style={styles.actions}>
                  <button type="button" style={styles.secondaryBtn} onClick={clearFilter}>{t.clear}</button>
                  <button type="button" style={styles.primaryBtn} onClick={applyFilter}>{t.chmApply}</button>
                </div>
              </div>
            )}
            {filterType === 'select' && (
              <div style={styles.filterBlock}>
                <select style={styles.input} value={draft} onChange={e => setDraft(e.target.value)} autoFocus>
                  {options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <div style={styles.actions}>
                  <button type="button" style={styles.secondaryBtn} onClick={clearFilter}>{t.clear}</button>
                  <button type="button" style={styles.primaryBtn} onClick={applyFilter}>{t.chmApply}</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  wrap: { position: 'relative', display: 'flex' },
  trigger: { display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', fontWeight: 700, textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer', textAlign: 'inherit' },
  triggerActive: { color: '#111827' },
  mark: { fontSize: 10, color: '#2563eb', fontWeight: 800, textTransform: 'none', letterSpacing: 0 },
  chev: { fontSize: 10, color: '#6b7280', textTransform: 'none', letterSpacing: 0 },
  menu: { position: 'fixed', zIndex: 3000, width: 230, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, boxShadow: '0 12px 30px rgba(15, 23, 42, 0.18)', padding: 8, textTransform: 'none', letterSpacing: 0 },
  backdrop: { position: 'fixed', inset: 0, zIndex: 2999, border: 'none', background: 'rgba(15, 23, 42, 0.34)', padding: 0 },
  sheet: { position: 'fixed', left: 8, right: 8, bottom: 8, zIndex: 3000, maxHeight: '72vh', overflowY: 'auto', background: '#fff', border: '1px solid #d1d5db', borderRadius: 12, boxShadow: '0 -18px 42px rgba(15, 23, 42, 0.24)', padding: 10, textTransform: 'none', letterSpacing: 0 },
  sheetHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '2px 2px 8px', borderBottom: '1px solid #e5e7eb', marginBottom: 7 },
  sheetTitle: { fontSize: 14, color: '#111827', fontWeight: 800, textTransform: 'none', letterSpacing: 0 },
  closeBtn: { border: 'none', background: 'transparent', color: '#64748b', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  menuBtn: { display: 'block', width: '100%', border: 'none', background: 'transparent', padding: '8px 9px', borderRadius: 6, color: '#374151', fontSize: 13, fontWeight: 600, textAlign: 'left', cursor: 'pointer' },
  divider: { height: 1, background: '#e5e7eb', margin: '7px 0' },
  filterBlock: { display: 'flex', flexDirection: 'column', gap: 8 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 9px', fontSize: 13, color: '#111827', background: '#fff' },
  suggestions: { maxHeight: 180, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 7, background: '#f9fafb', padding: 3 },
  suggestionBtn: { display: 'block', width: '100%', border: 'none', background: 'transparent', color: '#374151', fontSize: 13, fontWeight: 600, textAlign: 'left', padding: '7px 8px', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 7 },
  secondaryBtn: { padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  primaryBtn: { padding: '6px 10px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 800, cursor: 'pointer' },
};
