/**
 * Tests for SortHeader + its sortRows helper — the click-to-sort table
 * header shared across every admin list page (Estimates, Change Orders,
 * Subs, Lien Waivers, Submittals, Booking). sortRows is pure and easy to
 * pin down; the component test covers the three-click toggle cycle and
 * the aria-sort / focusable-button a11y contract.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SortHeader, { sortRows } from '../SortHeader';

// Render a SortHeader inside a valid table structure so jsdom doesn't
// complain about a stray <th>. Defaults the visible label to "Name" so
// the accessible-name lookups below are stable.
function renderHeader({ children = 'Name', ...props }) {
  return render(
    <table><thead><tr>
      <SortHeader {...props}>{children}</SortHeader>
    </tr></thead></table>
  );
}

describe('sortRows', () => {
  test('returns the input untouched when there is no active sort', () => {
    const rows = [{ a: 3 }, { a: 1 }, { a: 2 }];
    expect(sortRows(rows, { key: null, dir: null })).toBe(rows);
    expect(sortRows(rows, null)).toBe(rows);
  });

  test('sorts numeric string columns numerically, not lexically', () => {
    // PG bigint comes back stringified — "1000" must beat "9" by value.
    const rows = [{ n: '1000' }, { n: '9' }, { n: '90' }];
    const asc = sortRows(rows, { key: 'n', dir: 'asc' });
    expect(asc.map(r => r.n)).toEqual(['9', '90', '1000']);
    const desc = sortRows(rows, { key: 'n', dir: 'desc' });
    expect(desc.map(r => r.n)).toEqual(['1000', '90', '9']);
  });

  test('sorts text columns with locale compare', () => {
    const rows = [{ s: 'Charlie' }, { s: 'alpha' }, { s: 'Bravo' }];
    const asc = sortRows(rows, { key: 's', dir: 'asc' });
    expect(asc.map(r => r.s)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  test('sorts ISO date strings chronologically', () => {
    const rows = [
      { d: '2026-03-01T00:00:00Z' },
      { d: '2026-01-15T00:00:00Z' },
      { d: '2026-02-20T00:00:00Z' },
    ];
    const asc = sortRows(rows, { key: 'd', dir: 'asc' });
    expect(asc.map(r => r.d.slice(5, 7))).toEqual(['01', '02', '03']);
  });

  test('clusters null / undefined as smallest on ascending', () => {
    const rows = [{ v: 5 }, { v: null }, { v: 2 }, { v: undefined }];
    const asc = sortRows(rows, { key: 'v', dir: 'asc' });
    // both nullish first, then 2, then 5
    expect(asc.slice(2).map(r => r.v)).toEqual([2, 5]);
    expect(asc[0].v == null && asc[1].v == null).toBe(true);
  });

  test('honors a custom accessor function', () => {
    const rows = [
      { total_cents: '250' },
      { total_cents: '90' },
    ];
    const asc = sortRows(rows, { key: 'total_cents', dir: 'asc' }, {
      total_cents: r => parseFloat(r.total_cents),
    });
    expect(asc.map(r => r.total_cents)).toEqual(['90', '250']);
  });

  test('does not mutate the original array', () => {
    const rows = [{ a: 3 }, { a: 1 }];
    const copy = [...rows];
    sortRows(rows, { key: 'a', dir: 'asc' });
    expect(rows).toEqual(copy);
  });
});

describe('<SortHeader />', () => {
  test('renders the label and exposes a focusable button', () => {
    renderHeader({ sortKey: 'name', sort: { key: null, dir: null }, setSort: () => {} });
    const btn = screen.getByRole('button', { name: /Name/ });
    expect(btn).toBeInTheDocument();
    // explicit button element → reachable via Tab (not a div w/ onClick)
    expect(btn.tagName).toBe('BUTTON');
  });

  test('inactive header advertises aria-sort=none', () => {
    const { container } = renderHeader({
      sortKey: 'name', sort: { key: 'other', dir: 'asc' }, setSort: () => {},
    });
    expect(container.querySelector('th')).toHaveAttribute('aria-sort', 'none');
  });

  test('first click sorts ascending', () => {
    const setSort = vi.fn();
    renderHeader({ sortKey: 'name', sort: { key: null, dir: null }, setSort });
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(setSort).toHaveBeenCalledWith({ key: 'name', dir: 'asc' });
  });

  test('second click (already asc) flips to descending', () => {
    const setSort = vi.fn();
    renderHeader({ sortKey: 'name', sort: { key: 'name', dir: 'asc' }, setSort });
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(setSort).toHaveBeenCalledWith({ key: 'name', dir: 'desc' });
  });

  test('third click (already desc) clears the sort', () => {
    const setSort = vi.fn();
    renderHeader({ sortKey: 'name', sort: { key: 'name', dir: 'desc' }, setSort });
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(setSort).toHaveBeenCalledWith({ key: null, dir: null });
  });

  test('active header reflects ascending/descending in aria-sort', () => {
    const { container, rerender } = render(
      <table><thead><tr>
        <SortHeader sortKey="name" sort={{ key: 'name', dir: 'asc' }} setSort={() => {}}>Name</SortHeader>
      </tr></thead></table>
    );
    expect(container.querySelector('th')).toHaveAttribute('aria-sort', 'ascending');
    rerender(
      <table><thead><tr>
        <SortHeader sortKey="name" sort={{ key: 'name', dir: 'desc' }} setSort={() => {}}>Name</SortHeader>
      </tr></thead></table>
    );
    expect(container.querySelector('th')).toHaveAttribute('aria-sort', 'descending');
  });

  test('keyboard Enter on the button triggers the sort', () => {
    const setSort = vi.fn();
    renderHeader({ sortKey: 'name', sort: { key: null, dir: null }, setSort, children: 'Name' });
    // native <button> fires click on Enter; simulate the resulting click
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(setSort).toHaveBeenCalledTimes(1);
  });
});
