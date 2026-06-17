import React, { useState, useEffect, useRef } from 'react';

export default function TabBar({ tabs, active, onChange, breakpoint = 600 }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = () => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);

  // Close the mobile menu on outside-click or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (narrow) {
    // Custom dropdown rather than a native <select>: the native option list
    // can't be sized for touch (especially on iOS), so we render large,
    // comfortable rows ourselves.
    const current = tabs.find(t => t.id === active);
    const choose = id => { onChange(id); setOpen(false); };
    return (
      <div className="ops-tab-dd" ref={ref}>
        <button
          type="button"
          className="ops-tab-dd-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          {current?.dot && <span className="ops-tab-dd-dot" style={{ '--tab-dot': current.dot }} aria-hidden="true" />}
          <span className="ops-tab-dd-current">{current?.label}</span>
          <span className={`ops-tab-dd-caret ${open ? 'is-open' : ''}`.trim()} aria-hidden="true">▾</span>
        </button>
        {open && (
          <ul className="ops-tab-dd-menu" role="listbox" aria-label="Choose section">
            {tabs.map(t => {
              const isActive = t.id === active;
              return (
                <li key={t.id} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    className={`ops-tab-dd-option ${isActive ? 'is-active' : ''}`.trim()}
                    onClick={() => choose(t.id)}
                  >
                    {t.dot && <span className="ops-tab-dd-dot" style={{ '--tab-dot': t.dot }} aria-hidden="true" />}
                    <span className="ops-tab-dd-option-label">{t.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div role="tablist" className="ops-tabbar">
      {tabs.map(t => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            className={`ops-tab ${isActive ? 'is-active' : ''}`.trim()}
            onClick={() => onChange(t.id)}
          >
            {t.dot && (
              <span className="ops-tab-dot" style={{ '--tab-dot': t.dot }} aria-hidden="true" />
            )}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
