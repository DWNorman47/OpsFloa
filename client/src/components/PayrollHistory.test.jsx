import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import PayrollHistory from './PayrollHistory';
import api from '../api';

vi.mock('../api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));
vi.mock('../hooks/useT', () => ({
  useT: () => new Proxy({}, { get: (_target, key) => String(key) }),
}));
vi.mock('../hooks/usePerm', () => ({ usePerm: () => true }));
vi.mock('../errorReporter', () => ({ silentError: () => () => {} }));
vi.mock('./PayStub', () => ({ default: () => <div>stub</div> }));

const run = {
  id: 4,
  status: 'finalized',
  period_from: '2026-07-01T00:00:00.000Z',
  period_to: '2026-07-30T00:00:00.000Z',
  check_count: 1,
  paid_count: 1,
  net_cents: 10000,
};
const check = {
  id: 8,
  status: 'paid',
  worker_name: 'Jordan Lee',
  pay_date: '2026-07-30T00:00:00.000Z',
  period_start: '2026-07-01T00:00:00.000Z',
  period_end: '2026-07-30T00:00:00.000Z',
  gross_cents: 12000,
  deduction_cents: 2000,
  net_cents: 10000,
  detail: {},
};

describe('PayrollHistory', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.get.mockImplementation(url => Promise.resolve({
      data: url === '/admin/payroll-runs' ? [run] : { run, checks: [check] },
    }));
  });

  test('keeps payroll dates date-only and prevents voiding paid checks', async () => {
    render(<PayrollHistory currency="USD" />);

    const runButton = await screen.findByRole('button', { name: /2026-07-01.*2026-07-30/ });
    expect(screen.queryByText(/T00:00:00/)).not.toBeInTheDocument();
    fireEvent.click(runButton);

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getAllByText(/2026-07-30/)).toHaveLength(2);
    expect(screen.queryByText(/T00:00:00/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'pcrHistVoid' })).toBeDisabled();
    expect(screen.getByText('pcrHistVoidPaidBlocked')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  test('shows a server rejection when an unpaid run cannot be voided', async () => {
    const unpaid = { ...run, paid_count: 0 };
    api.get.mockImplementation(url => Promise.resolve({
      data: url === '/admin/payroll-runs' ? [unpaid] : { run: unpaid, checks: [{ ...check, status: 'pending' }] },
    }));
    api.post.mockRejectedValue({ response: { data: { error: 'Run changed before it could be voided.' } } });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    render(<PayrollHistory currency="USD" />);
    fireEvent.click(await screen.findByRole('button', { name: /2026-07-01.*2026-07-30/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'pcrHistVoid' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Run changed before it could be voided.');
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });
});
