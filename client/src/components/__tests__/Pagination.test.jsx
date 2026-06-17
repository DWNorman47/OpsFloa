/**
 * Tests for Pagination — the shared prev/page-of/next control used on
 * every paginated admin list. Covers render gating, the disabled edge
 * states, the onChange contract, and the a11y wiring (nav label,
 * aria-live page indicator) added in the accessibility pass.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Pagination from '../Pagination';

// useT → useAuth; stub a user so getT resolves the English dictionary
// (which holds paginationNavLabel / paginationPrev / paginationNext).
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, language: 'English' } }),
}));

describe('<Pagination />', () => {
  test('renders nothing when there is only one page', () => {
    const { container } = render(<Pagination page={1} pages={1} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders nothing when pages is missing/zero', () => {
    const { container } = render(<Pagination page={1} pages={0} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders the current position when there are multiple pages', () => {
    render(<Pagination page={2} pages={5} onChange={() => {}} />);
    // "Page 2 of 5" — text is split across nodes, match the digits
    expect(screen.getByText(/2/)).toBeInTheDocument();
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  test('exposes a labelled <nav> landmark', () => {
    render(<Pagination page={2} pages={5} onChange={() => {}} />);
    // aria-label comes from i18n (paginationNavLabel) — must not be undefined
    expect(screen.getByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
  });

  test('the page indicator is an aria-live region', () => {
    render(<Pagination page={2} pages={5} onChange={() => {}} />);
    const live = screen.getByText(/2/).closest('[aria-live]');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  test('Previous is disabled on the first page', () => {
    render(<Pagination page={1} pages={5} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
  });

  test('Next is disabled on the last page', () => {
    render(<Pagination page={5} pages={5} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /prev/i })).toBeEnabled();
  });

  test('clicking Next requests the following page', () => {
    const onChange = vi.fn();
    render(<Pagination page={2} pages={5} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  test('clicking Previous requests the preceding page', () => {
    const onChange = vi.fn();
    render(<Pagination page={2} pages={5} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /prev/i }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  test('clicking a disabled edge button does nothing', () => {
    const onChange = vi.fn();
    render(<Pagination page={1} pages={5} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /prev/i }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
