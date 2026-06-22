import React from 'react';
import { useT } from '../hooks/useT';

export default function Pagination({ page, pages, onChange }) {
  const t = useT();
  if (!pages || pages <= 1) return null;
  const prevDisabled = page <= 1;
  const nextDisabled = page >= pages;
  const prevLabel = t.paginationPrev;
  const nextLabel = t.paginationNext;
  return (
    <nav
      aria-label={t.paginationNavLabel}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '16px 0' }}
    >
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={prevDisabled}
        aria-label={`${prevLabel} (${t.paginationPage} ${Math.max(1, page - 1)})`}
        style={{
          padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db',
          background: prevDisabled ? '#f9fafb' : '#fff', color: prevDisabled ? '#9ca3af' : '#374151',
          cursor: prevDisabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500,
        }}
      >
        <span aria-hidden="true">←</span> {prevLabel}
      </button>
      <span
        aria-live="polite"
        aria-atomic="true"
        style={{ fontSize: 13, color: '#6b7280' }}
      >
        {t.paginationPage} {page} {t.ofLabel} {pages}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={nextDisabled}
        aria-label={`${nextLabel} (${t.paginationPage} ${Math.min(pages, page + 1)})`}
        style={{
          padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db',
          background: nextDisabled ? '#f9fafb' : '#fff', color: nextDisabled ? '#9ca3af' : '#374151',
          cursor: nextDisabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500,
        }}
      >
        {nextLabel} <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}
