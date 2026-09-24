import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import RateHistory, { withLockedConfirm } from './RateHistory';
import api from '../api';

vi.mock('../api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('../hooks/useT', () => ({
  useT: () => new Proxy({}, { get: (_target, key) => String(key) }),
}));

const T = new Proxy({}, { get: (_t, k) => String(k) });
const lockedErr = () => Object.assign(new Error('409'), {
  response: { status: 409, data: { code: 'locked_periods', locked_count: 1, locked_periods: [{ id: 7, period_start: '2026-06-01', period_end: '2026-06-14', label: null }] } },
});

describe('withLockedConfirm', () => {
  test('no conflict → one call without confirm_locked', async () => {
    const send = vi.fn().mockResolvedValue({ data: 1 });
    const confirm = vi.fn();
    await expect(withLockedConfirm(send, confirm, T)).resolves.toEqual({ data: 1 });
    expect(send).toHaveBeenCalledWith(false, { suppressToast: true }); // no red toast behind the confirm
    expect(confirm).not.toHaveBeenCalled();
  });
  test('409 locked_periods → asks, names the periods, resends with confirm_locked', async () => {
    const send = vi.fn().mockRejectedValueOnce(lockedErr()).mockResolvedValueOnce({ data: 2 });
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(withLockedConfirm(send, confirm, T)).resolves.toEqual({ data: 2 });
    expect(confirm.mock.calls[0][0].body).toBe('rhLockedBody'); // template filled from t
    expect(send.mock.calls.map(c => c[0])).toEqual([false, true]);
  });
  test('declined → null, nothing resent', async () => {
    const send = vi.fn().mockRejectedValueOnce(lockedErr());
    await expect(withLockedConfirm(send, vi.fn().mockResolvedValue(false), T)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
  test('any other error is rethrown', async () => {
    const err = Object.assign(new Error('x'), { response: { status: 409, data: { error: 'conflict' } } });
    await expect(withLockedConfirm(vi.fn().mockRejectedValue(err), vi.fn(), T)).rejects.toBe(err);
  });
});

describe('<RateHistory>', () => {
  beforeEach(() => {
    api.get.mockReset(); api.post.mockReset(); api.delete.mockReset();
    api.get.mockResolvedValue({ data: {
      today: '2026-09-24',
      current: { rate: 22, rate_type: 'hourly' },
      history: [
        { id: 1, rate: 20, rate_type: 'hourly', effective_date: '1900-01-01', initial: true, created_by_name: null, note: 'Backfilled' },
        { id: 2, rate: 22, rate_type: 'hourly', effective_date: '2026-07-08', initial: false, created_by_name: 'Pat Admin', note: 'Raise' },
        { id: 3, rate: 25, rate_type: 'daily', effective_date: '2027-01-01', initial: false, created_by_name: 'Pat Admin', note: null },
      ],
    } });
  });

  test('lists rows newest first with current / scheduled badges', async () => {
    render(<RateHistory kind="worker" ownerId={5} currency="USD" />);
    await screen.findByText('2026-07-08');
    expect(api.get).toHaveBeenCalledWith('/admin/workers/5/rate-history');
    const cells = screen.getAllByRole('row').slice(1).map(r => r.textContent);
    expect(cells[0]).toMatch(/2027-01-01.*rhScheduled/);
    expect(cells[1]).toMatch(/2026-07-08.*rhCurrent/);
    expect(cells[2]).toMatch(/rhInitial/);
    expect(screen.getByText('rhPastPayNote')).toBeTruthy();
  });

  test('project mode adds a change with the effective date', async () => {
    api.post.mockResolvedValue({ data: { history: [], current: { rate: 50 }, today: '2026-09-24' } });
    const onChanged = vi.fn();
    render(<RateHistory kind="project" ownerId={30} currency="USD" allowAdd onChanged={onChanged} />);
    await screen.findByText('2026-07-08');
    fireEvent.change(screen.getByLabelText('rhRate'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('rhEffectiveFrom'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByText('rhAdd'));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/admin/projects/30/prevailing-rate-history', expect.objectContaining({ rate: 50, effective_date: '2026-09-01', confirm_locked: false }), { suppressToast: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ rate: 50 }));
  });
});
