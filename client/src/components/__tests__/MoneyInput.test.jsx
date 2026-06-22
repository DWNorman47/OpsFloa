/**
 * Tests for MoneyInput — the dollar-facing input that emits integer
 * cents. The whole point is that the user types human dollars ("15.50")
 * while the form state stays in cents (1550), so the conversion and the
 * mid-typing resync guard are the things worth pinning down.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MoneyInput from '../MoneyInput';

describe('<MoneyInput />', () => {
  test('renders the initial cents value as a dollar string', () => {
    render(<MoneyInput valueCents={1500} onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('15.00');
  });

  test('shows an empty field for zero (so the placeholder is visible)', () => {
    render(<MoneyInput valueCents={0} onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  test('emits cents as the user types dollars', () => {
    const onChange = vi.fn();
    render(<MoneyInput valueCents={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '15.50' } });
    expect(onChange).toHaveBeenLastCalledWith(1550);
  });

  test('handles whole-dollar input', () => {
    const onChange = vi.fn();
    render(<MoneyInput valueCents={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '42' } });
    expect(onChange).toHaveBeenLastCalledWith(4200);
  });

  test('clearing the field emits zero', () => {
    const onChange = vi.fn();
    render(<MoneyInput valueCents={1500} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  test('does not emit on an unparseable partial value', () => {
    const onChange = vi.fn();
    render(<MoneyInput valueCents={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '15.5.5' } });
    expect(onChange).not.toHaveBeenCalled();
    // but the text the user typed is preserved, not reverted
    expect(screen.getByRole('textbox')).toHaveValue('15.5.5');
  });

  test('blur canonicalizes the display to two decimals', () => {
    render(<MoneyInput valueCents={0} onChange={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '15.5' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('15.50');
  });

  test('re-syncs when the caller pushes a new cents value externally', () => {
    const { rerender } = render(<MoneyInput valueCents={1500} onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('15.00');
    rerender(<MoneyInput valueCents={5000} onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('50.00');
  });

  test('does NOT clobber mid-typing text when the echoed cents come back', () => {
    // Simulate a controlled parent: typing "15." should not get reformatted
    // to "15.00" out from under the user just because the parent re-rendered
    // with the same cents we just emitted.
    let cents = 0;
    const onChange = vi.fn(c => { cents = c; });
    const { rerender } = render(<MoneyInput valueCents={cents} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '15.' } });
    // "15." parses to 1500; parent re-renders with that echoed value
    rerender(<MoneyInput valueCents={cents} onChange={onChange} />);
    expect(input).toHaveValue('15.');
  });
});
