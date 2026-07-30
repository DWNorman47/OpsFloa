import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import LiveKPIs from './LiveKPIs';
import api from '../api';

vi.mock('../api', () => ({
  default: {
    get: vi.fn(),
  },
}));
vi.mock('../hooks/useT', () => ({
  useT: () => ({
    pendingApprovals: 'Pending Approvals',
    clockedInNow: 'Clocked In Now',
    hoursThisWeek: 'Hours This Week',
    workersWithOT: 'Workers With OT',
    failedToLoad: 'Failed to load',
  }),
}));

const kpis = clockedIn => ({
  pending_approvals: 2,
  clocked_in_count: clockedIn,
  company_hours_this_week: 40,
  overtime_workers_this_week: 1,
});

describe('LiveKPIs refreshToken', () => {
  beforeEach(() => {
    api.get.mockReset();
  });

  test('reloads KPI values after a workforce mutation', async () => {
    api.get
      .mockResolvedValueOnce({ data: kpis(3) })
      .mockResolvedValueOnce({ data: kpis(4) });

    const { rerender } = render(<LiveKPIs refreshToken={0} />);
    expect(await screen.findByText('3')).toBeInTheDocument();

    rerender(<LiveKPIs refreshToken={1} />);
    expect(await screen.findByText('4')).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
