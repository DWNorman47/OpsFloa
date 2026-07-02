import React, { useState } from 'react';
import { useT } from '../hooks/useT';

export default function FieldFilters({ children, activeCount = 0, label }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const resolvedLabel = label ?? t.ffFilters;
  const countText = activeCount > 0 ? ` (${activeCount})` : '';

  return (
    <section className={`field-filters ${open ? 'is-open' : ''}`.trim()} aria-label={resolvedLabel}>
      <button
        type="button"
        className="field-filter-toggle"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span>{resolvedLabel}{countText}</span>
        <span aria-hidden="true">{open ? t.ffHide : t.ffShow}</span>
      </button>
      <div className="filter-row field-filter-content">
        {children}
      </div>
    </section>
  );
}
