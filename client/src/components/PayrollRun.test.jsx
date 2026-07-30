import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import PayrollRun from './PayrollRun';
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

const period = (rulesetId, name, day) => ({
  ruleset_id: rulesetId,
  ruleset_name: name,
  pay_date: `2026-07-${day}`,
  period_start: `2026-07-${day}`,
  period_end: `2026-07-${day}`,
  run_from: `2026-07-${day}`,
  run_to: `2026-07-${day}`,
  check_count: 1,
});

const runData = (rulesetId, day, worker) => ({
  from: `2026-07-${day}`,
  to: `2026-07-${day}`,
  ruleset_id: rulesetId,
  rows: [{
    worker_id: rulesetId === 'r1' ? 1 : 2,
    worker_name: worker,
    role_name: 'Crew',
    ruleset_name: rulesetId,
    pay_date: `2026-07-${day}`,
    period_start: `2026-07-${day}`,
    period_end: `2026-07-${day}`,
    gross: 100,
    deduction_total: 10,
    net: 90,
    hours: {},
  }],
  errors: [],
  notices: [],
  ruleset_count: 2,
});

describe('PayrollRun request binding', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
  });

  test('clears a stale register and finalizes the response that is displayed', async () => {
    const pendingRuns = [];
    api.get.mockImplementation(url => {
      if (url === '/admin/payroll-periods') {
        return Promise.resolve({
          data: {
            periods: [period('r1', 'Weekly', '10'), period('r2', 'Monthly', '20')],
            rulesets: [{ id: 'r1', name: 'Weekly' }, { id: 'r2', name: 'Monthly' }],
          },
        });
      }
      return new Promise(resolve => pendingRuns.push({ url, resolve }));
    });
    api.post.mockResolvedValue({ data: { run_id: 77 } });

    render(<PayrollRun currency="USD" />);
    await waitFor(() => expect(pendingRuns).toHaveLength(1));
    await act(async () => pendingRuns[0].resolve({ data: runData('r1', '10', 'Worker A') }));
    expect(await screen.findByText('Worker A')).toBeInTheDocument();

    const selector = screen.getByRole('combobox');
    fireEvent.change(selector, { target: { value: 'r2|2026-07-20|2026-07-20' } });
    await waitFor(() => expect(pendingRuns).toHaveLength(2));
    expect(screen.queryByText('Worker A')).not.toBeInTheDocument();
    expect(screen.queryByText('pcrRunFinalize')).not.toBeInTheDocument();

    await act(async () => pendingRuns[1].resolve({ data: runData('r2', '20', 'Worker B') }));
    expect(await screen.findByText('Worker B')).toBeInTheDocument();
    fireEvent.click(screen.getByText('pcrRunFinalize'));
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('pcrRunFinalizeConfirmAction'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/admin/payroll-run/finalize',
      { from: '2026-07-20', to: '2026-07-20', ruleset_id: 'r2' },
      { suppressToast: true }
    ));
  });

  test('does not allow a run without paycheck rulesets to be finalized', async () => {
    api.get.mockImplementation(url => {
      if (url === '/admin/payroll-periods') {
        return Promise.resolve({ data: { periods: [], rulesets: [] } });
      }
      return Promise.resolve({ data: { ...runData(null, '20', 'Worker A'), ruleset_count: 0 } });
    });

    render(<PayrollRun currency="USD" />);
    fireEvent.click(await screen.findByText('pcrRunGo'));

    const finalizeButton = await screen.findByText('pcrRunFinalize');
    expect(finalizeButton).toBeDisabled();
    expect(screen.getByText('pcrRunRulesetRequiredFinalize')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
