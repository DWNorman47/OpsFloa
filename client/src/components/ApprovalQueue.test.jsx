import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ApprovalQueue from './ApprovalQueue';
import api from '../api';

vi.mock('../api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, errorCodeMessage: vi.fn(() => null) }));
vi.mock('../offlineDb', () => ({ getOrFetch: (_k, fn) => fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', language: 'English' } }) }));
vi.mock('../hooks/useT', () => ({
  useT: () => new Proxy({}, { get: (_target, key) => String(key) }),
}));
vi.mock('../errorReporter', () => ({ silentError: () => () => {} }));
vi.mock('react-leaflet', () => ({
  MapContainer: () => null, TileLayer: () => null, Marker: () => null, Popup: () => null, Polyline: () => null, useMap: () => ({}),
}));

const entry = (extra) => ({
  id: 1, user_id: 5, worker_name: 'Ana', project_name: 'Site A', work_date: '2026-09-23',
  start_time: '08:00:00', end_time: '17:00:00', start_ts: '2026-09-23T08:00:00.000Z', end_ts: '2026-09-23T17:00:00.000Z',
  wage_type: 'regular', status: 'pending', break_minutes: 0, clock_source: 'worker', ...extra,
});

function mockEntries(entries) {
  api.get.mockImplementation((url) => {
    if (url === '/admin/entries/pending') return Promise.resolve({ data: { entries, has_more: false } });
    if (url === '/work') return Promise.resolve({ data: [] });
    if (url === '/settings') return Promise.resolve({ data: {} });
    return Promise.resolve({ data: [] });
  });
}

describe('ApprovalQueue — late clock-out badge', () => {
  beforeEach(() => { api.get.mockReset(); });

  test('shows "Late clock-out" with the lag when clock_out_late_minutes is set', async () => {
    mockEntries([entry({ clock_out_late_minutes: 125 })]);
    render(<ApprovalQueue />);
    const badge = await screen.findByText(/aqLateClockOut: 2h 5m/);
    expect(badge).toHaveAttribute('title', 'aqLateClockOutTitle');
  });

  test('no badge on an ordinary punch', async () => {
    mockEntries([entry({ clock_out_late_minutes: null })]);
    render(<ApprovalQueue />);
    await screen.findByText('Ana');
    expect(screen.queryByText(/aqLateClockOut/)).not.toBeInTheDocument();
  });
});

describe('ApprovalQueue — locked pay period', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

  test('an entry in a locked pay period is badged', async () => {
    mockEntries([entry({ in_locked_period: true })]);
    render(<ApprovalQueue />);
    const badge = await screen.findByText(/approvalsLockedPeriodBadge/);
    expect(badge).toHaveAttribute('title', 'approvalsLockedPeriodHint');
  });

  test('approve-all that skipped locked entries reloads the queue instead of dropping them', async () => {
    mockEntries([entry({ in_locked_period: true }), entry({ id: 2, worker_name: 'Ben' })]);
    api.post.mockResolvedValue({ data: { approved: 1, skipped_locked: 1 } });
    render(<ApprovalQueue />);
    await screen.findByText('Ana');
    const pendingCalls = () => api.get.mock.calls.filter(c => c[0] === '/admin/entries/pending').length;
    const before = pendingCalls();
    fireEvent.click(screen.getByText('aqApproveAll'));
    fireEvent.click(await screen.findByText('confirm'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/entries/approve-all'));
    await waitFor(() => expect(pendingCalls()).toBeGreaterThan(before));
  });
});
