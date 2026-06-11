// Click-to-sort table header cell. Drop-in replacement for <th>{label}</th>
// in any list table. Shows an arrow indicator when active.
//
// Sort is CLIENT-SIDE on the currently-visible page only. For lists
// large enough to paginate, the sort order is per-page (the API doesn't
// take sort params on these new endpoints yet — adding that is a
// follow-up). Documented in the parent's sortRows helper.
//
// Usage:
//   const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
//   const rows = useMemo(() => sortRows(raw, sort), [raw, sort]);
//   <thead><tr>
//     <SortHeader sortKey="estimate_number" sort={sort} setSort={setSort}>Number</SortHeader>
//     ...
//   </tr></thead>
//
// Accessibility:
//   The th carries aria-sort (none|ascending|descending) so screen-reader
//   users hear sort state when navigating tables. The inner toggle is a
//   real <button> so it's reachable via Tab and announces a label like
//   "Total, currently descending — click to clear sort." The arrow glyph
//   is aria-hidden since the state is already in aria-sort.

import React from 'react';

export default function SortHeader({ children, sortKey, sort, setSort, align = 'left', style }) {
  const active = sort.key === sortKey;
  const dir = active ? sort.dir : null;

  function toggle() {
    if (!active) {
      setSort({ key: sortKey, dir: 'asc' });
    } else if (dir === 'asc') {
      setSort({ key: sortKey, dir: 'desc' });
    } else {
      // Third click clears the sort — useful when the user wants to fall
      // back to the API's natural ordering.
      setSort({ key: null, dir: null });
    }
  }

  // Verbal description of what the next click will do — gives screen-reader
  // users the same affordance that the arrow gives sighted users.
  const nextAction = !active
    ? 'click to sort ascending'
    : dir === 'asc'
      ? 'click to sort descending'
      : 'click to clear sort';
  const label = typeof children === 'string' ? children : sortKey;
  const buttonLabel = active
    ? `${label}, sorted ${dir === 'asc' ? 'ascending' : 'descending'} — ${nextAction}`
    : `${label} — ${nextAction}`;

  return (
    <th
      style={{
        textAlign: align,
        padding: 0,
        fontSize: 11,
        color: '#6b7280',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        ...style,
      }}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={buttonLabel}
        style={{
          all: 'unset',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '10px 14px',
          width: '100%',
          boxSizing: 'border-box',
          cursor: 'pointer',
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        }}
      >
        <span>{children}</span>
        <span
          aria-hidden="true"
          style={{
            fontSize: 10,
            color: active ? '#1a56db' : '#d1d5db',
            width: 8,
          }}
        >
          {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '▲'}
        </span>
      </button>
    </th>
  );
}

// Generic sort helper that the consumer wraps around the page's row
// array. Handles strings, numbers (incl. PG bigint as string), and
// dates. Pass `accessor` (key, or fn) to extract the comparable from
// each row.
export function sortRows(rows, sort, accessors = {}) {
  if (!sort || !sort.key || !sort.dir) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const accessor = accessors[sort.key] || ((row) => row[sort.key]);
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    // Treat null / undefined as "smallest" so they cluster on asc.
    if (av == null && bv == null) return 0;
    if (av == null) return -1 * dir;
    if (bv == null) return 1 * dir;
    // Date-shaped strings (ISO) compare correctly as strings, but
    // numeric strings ("250000") need parsing.
    const an = parseFloat(av);
    const bn = parseFloat(bv);
    if (Number.isFinite(an) && Number.isFinite(bn) && !/[a-z]/i.test(String(av))) {
      return (an - bn) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
}
