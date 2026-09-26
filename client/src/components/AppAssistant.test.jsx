import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import api from '../api';
import AppAssistant, { AppAssistantLauncher, ASSISTANT_OPEN_EVENT, isAllowedAssistantAction } from './AppAssistant';
import { assistantStrings } from './appAssistantStrings';

vi.mock('../api', () => ({ default: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 7, role: 'admin', language: 'English' } }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

function renderAssistant() {
  return render(
    <MemoryRouter initialEntries={['/timeclock#wf-live']}>
      <AppAssistant />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe('AppAssistant', () => {
  beforeEach(() => {
    api.post.mockReset();
    api.patch.mockReset();
    api.delete.mockReset();
  });

  test('opens globally, sends current-page context, and follows a safe navigation action', async () => {
    api.post.mockResolvedValue({
      data: {
        message: 'Opening Approvals.',
        actions: [{ type: 'navigate', path: '/timeclock#wf-approvals', label: 'Open Approvals' }],
      },
    });
    renderAssistant();

    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    expect(screen.getByRole('dialog', { name: 'OpsFloa Assistant' })).toBeInTheDocument();
    expect(screen.getByText(/requires your confirmation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take me to approvals' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/office/assistant', expect.objectContaining({
      message: 'Take me to approvals',
      context: { path: '/timeclock', search: '', hash: '#wf-live' },
    })));
    expect(await screen.findByText('Opening Approvals.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/timeclock#wf-approvals');
  });

  test('header launcher opens the global drawer', () => {
    render(
      <MemoryRouter>
        <AppAssistantLauncher />
        <AppAssistant />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open OpsFloa Assistant' }));
    expect(screen.getByRole('dialog', { name: 'OpsFloa Assistant' })).toBeInTheDocument();
  });

  test('requires a click before calling the existing approval endpoint', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        message: 'I found the entry. Please confirm the approval below.',
        actions: [{
          type: 'confirm_api',
          kind: 'time_entry_approval',
          title: 'Approve time entry?',
          summary: 'Review this entry before approving it.',
          confirm_label: 'Approve entry',
          cancel_label: 'Cancel',
          success_message: 'Time entry approved.',
          details: [{ worker: 'Jordan Lee', date: '2026-09-14', time: '08:00:00-16:00:00', project: 'Main Street' }],
          method: 'patch',
          endpoint: '/admin/entries/91/approve',
          body: {},
        }],
      },
    });
    api.patch.mockResolvedValue({ data: { id: 91, status: 'approved' } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Approve Jordan time' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Approve time entry?')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve entry' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/entries/91/approve', {}));
    expect(await screen.findByText('Time entry approved.')).toBeInTheDocument();
  });

  test('requires a click before calling the existing rejection endpoint', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        message: 'Please confirm this rejection.',
        actions: [{
          type: 'confirm_api',
          kind: 'time_entry_rejection',
          danger: true,
          title: 'Reject time entry?',
          summary: 'The worker will be notified with this reason.',
          reason_label: 'Reason',
          confirm_label: 'Reject entry',
          cancel_label: 'Cancel',
          success_message: 'Time entry rejected.',
          details: [{ worker: 'Jordan Lee', date: '2026-09-14', time: '08:00:00-16:00:00', project: 'Main Street' }],
          method: 'patch',
          endpoint: '/admin/entries/91/reject',
          body: { note: 'Incorrect project' },
        }],
      },
    });
    api.patch.mockResolvedValue({ data: { id: 91, status: 'rejected' } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Reject Jordan time because the project is wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Reject time entry?')).toBeInTheDocument();
    expect(screen.getByText('Reason:')).toBeInTheDocument();
    expect(screen.getByText('Incorrect project')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Reject entry' });
    expect(confirm).toHaveClass('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/entries/91/reject', { note: 'Incorrect project' }));
    expect(await screen.findByText('Time entry rejected.')).toBeInTheDocument();
  });

  test('shows the reason and requires a destructive click before denying time off', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        message: 'Please confirm this time-off denial.',
        actions: [{
          type: 'confirm_api',
          kind: 'time_off_denial',
          danger: true,
          title: 'Deny time off?',
          summary: 'The worker will be notified with this reason.',
          reason_label: 'Reason',
          reason: 'Coverage is unavailable',
          confirm_label: 'Deny request',
          cancel_label: 'Cancel',
          success_message: 'Time-off request denied.',
          details: [{ worker: 'Nora Bennett', date: '2026-10-10', type: 'Personal', time: '4 hours' }],
          method: 'patch',
          endpoint: '/time-off/56/deny',
          body: { review_note: 'Coverage is unavailable' },
        }],
      },
    });
    api.patch.mockResolvedValue({ data: { id: 56, status: 'denied' } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Deny Nora time off because coverage is unavailable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Deny time off?')).toBeInTheDocument();
    expect(screen.getByText('Nora Bennett | 2026-10-10 | Personal | 4 hours')).toBeInTheDocument();
    expect(screen.getByText('Reason:')).toBeInTheDocument();
    expect(screen.getByText('Coverage is unavailable')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Deny request' });
    expect(confirm).toHaveClass('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/time-off/56/deny', { review_note: 'Coverage is unavailable' }));
    expect(await screen.findByText('Time-off request denied.')).toBeInTheDocument();
  });

  test('shows expense details and requires a destructive click before rejecting reimbursement', async () => {
    const reimbursementId = '7c9e6679-7425-40de-944b-e07fc1f90ae8';
    const body = {
      status: 'rejected',
      admin_notes: 'Receipt is unreadable',
      updated_at: '2026-09-20T18:00:00.000Z',
    };
    api.post.mockResolvedValueOnce({
      data: {
        message: 'Please confirm this reimbursement rejection.',
        actions: [{
          type: 'confirm_api',
          kind: 'reimbursement_rejection',
          danger: true,
          title: 'Reject reimbursement?',
          summary: 'The reason will be visible to the worker.',
          reason_label: 'Reason',
          reason: 'Receipt is unreadable',
          confirm_label: 'Reject reimbursement',
          cancel_label: 'Cancel',
          success_message: 'Reimbursement rejected.',
          details: [{
            worker: 'Nora Bennett', date: '2026-09-20', amount: 'Amount: 20.00',
            category: 'Parking', project: 'Mesa Drainage', description: 'Garage parking',
          }],
          method: 'patch',
          endpoint: `/reimbursements/admin/${reimbursementId}`,
          body,
        }],
      },
    });
    api.patch.mockResolvedValue({ data: { id: reimbursementId, status: 'rejected' } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Reject Nora expense because the receipt is unreadable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Reject reimbursement?')).toBeInTheDocument();
    expect(screen.getByText('Nora Bennett | 2026-09-20 | Amount: 20.00 | Parking | Mesa Drainage | Garage parking')).toBeInTheDocument();
    expect(screen.getByText('Receipt is unreadable')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Reject reimbursement' });
    expect(confirm).toHaveClass('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/reimbursements/admin/${reimbursementId}`, body));
    expect(await screen.findByText('Reimbursement rejected.')).toBeInTheDocument();
  });

  test('requires a destructive click before cancelling one scheduled shift', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        message: 'Please confirm this shift cancellation.',
        actions: [{
          type: 'confirm_api',
          kind: 'shift_cancellation',
          danger: true,
          title: 'Cancel shift?',
          summary: 'This individual shift will be deleted and the worker will be notified.',
          confirm_label: 'Cancel shift',
          cancel_label: 'Back',
          success_message: 'Shift cancelled.',
          details: [{
            worker: 'Nora Bennett', date: '2026-10-03', time: '08:00-16:00',
            project: 'Mesa Drainage', notes: 'Bring PPE',
          }],
          method: 'delete',
          endpoint: '/shifts/admin/43',
        }],
      },
    });
    api.delete.mockResolvedValue({ data: { deleted: true } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: "Cancel Nora's Saturday shift" } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Cancel shift?')).toBeInTheDocument();
    expect(screen.getByText('Nora Bennett | 2026-10-03 | 08:00-16:00 | Mesa Drainage | Bring PPE')).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Cancel shift' });
    expect(confirm).toHaveClass('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/shifts/admin/43'));
    expect(await screen.findByText('Shift cancelled.')).toBeInTheDocument();
  });

  test('requires a destructive confirmation before undoing an approval', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        message: 'Please confirm the approval reversal.',
        actions: [{
          type: 'confirm_api',
          kind: 'time_entry_unapproval',
          danger: true,
          title: 'Undo approval?',
          summary: 'The entry will return to pending and any linked QuickBooks time activity may be removed.',
          confirm_label: 'Undo approval',
          cancel_label: 'Cancel',
          success_message: 'Approval undone.',
          details: [{ worker: 'Jordan Lee', date: '2026-09-14', time: '08:00:00-16:00:00', project: 'Main Street' }],
          method: 'patch',
          endpoint: '/admin/entries/91/unapprove',
          body: {},
        }],
      },
    });
    api.patch.mockResolvedValue({ data: { id: 91, status: 'pending' } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Undo Jordan approval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Undo approval?')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Undo approval' });
    expect(confirm).toHaveClass('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/entries/91/unapprove', {}));
    expect(await screen.findByText('Approval undone.')).toBeInTheDocument();
  });

  test('shows exact changes and requires confirmation before editing an entry', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        message: 'Please confirm these time-entry changes.',
        actions: [{
          type: 'confirm_api',
          kind: 'time_entry_edit',
          title: 'Edit time entry?',
          summary: 'Review each change before saving.',
          confirm_label: 'Save changes',
          cancel_label: 'Cancel',
          success_message: 'Time entry updated.',
          details: [{ worker: 'Jordan Lee', date: '2026-09-14', time: '08:00:00-16:00:00', project: 'Main Street' }],
          changes: [
            { label: 'End', before: '16:00', after: '16:30' },
            { label: 'Project', before: 'Main Street', after: 'Oak Ridge' },
          ],
          method: 'patch',
          endpoint: '/admin/entries/91/edit',
          body: {
            start_time: '08:00',
            end_time: '16:30',
            updated_at: '2026-09-16T01:02:03.000Z',
            project_id: 44,
          },
        }],
      },
    });
    api.patch.mockResolvedValue({ data: { id: 91, end_time: '16:30:00', project_id: 44 } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Move Jordan end time to 4:30 and use Oak Ridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Edit time entry?')).toBeInTheDocument();
    expect(screen.getByText('16:30')).toBeInTheDocument();
    expect(screen.getByText('Oak Ridge')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/entries/91/edit', {
      start_time: '08:00',
      end_time: '16:30',
      updated_at: '2026-09-16T01:02:03.000Z',
      project_id: 44,
    }));
    expect(await screen.findByText('Time entry updated.')).toBeInTheDocument();
  });

  test('shows every segment and requires destructive confirmation before splitting', async () => {
    const splitAction = {
      type: 'confirm_api',
      kind: 'time_entry_split',
      danger: true,
      title: 'Split time entry?',
      summary: 'The original entry will be replaced by the pending segments shown.',
      confirm_label: 'Split entry',
      cancel_label: 'Cancel',
      success_message: 'Time entry split.',
      details: [{ worker: 'Jordan Lee', date: '2026-09-14', time: '08:00:00-16:00:00', project: 'Main Street' }],
      split_segments: [
        { label: 'Segment 1', time: '08:00-12:00', project: 'Main Street' },
        { label: 'Segment 2', time: '12:00-16:00', project: 'Oak Ridge' },
      ],
      method: 'post',
      endpoint: '/admin/entries/91/split',
      body: {
        segments: [
          { start_time: '08:00', end_time: '12:00', project_id: 11 },
          { start_time: '12:00', end_time: '16:00', project_id: 44 },
        ],
      },
    };
    api.post
      .mockResolvedValueOnce({ data: { message: 'Please confirm this split.', actions: [splitAction] } })
      .mockResolvedValueOnce({ data: { created: [{ id: 201 }, { id: 202 }] } });
    renderAssistant();
    act(() => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT)));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask OpsFloa...' }), { target: { value: 'Split Jordan at noon and move the second part to Oak Ridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Split time entry?')).toBeInTheDocument();
    expect(screen.getByText('Segment 1')).toBeInTheDocument();
    expect(screen.getByText('Oak Ridge')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/admin/entries/91/split', splitAction.body);
    const confirm = screen.getByRole('button', { name: 'Split entry' });
    expect(confirm).toHaveClass('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/entries/91/split', splitAction.body));
    expect(await screen.findByText('Time entry split.')).toBeInTheDocument();
  });

  test('confirmation allowlist rejects arbitrary endpoints', () => {
    expect(isAllowedAssistantAction({
      type: 'confirm_api',
      kind: 'time_entry_approval',
      method: 'post',
      endpoint: '/admin/companies/delete',
      body: {},
    })).toBe(false);
  });

  test('confirmation allowlist tightly scopes time-off review actions', () => {
    const approval = {
      type: 'confirm_api',
      kind: 'time_off_approval',
      method: 'patch',
      endpoint: '/time-off/55/approve',
      body: { review_note: 'Coverage arranged', confirm: true },
    };
    const denial = {
      type: 'confirm_api',
      kind: 'time_off_denial',
      method: 'patch',
      endpoint: '/time-off/56/deny',
      body: { review_note: 'Coverage is unavailable' },
    };
    const revocation = {
      type: 'confirm_api',
      kind: 'time_off_revocation',
      method: 'patch',
      endpoint: '/time-off/57/revoke',
      body: { reason: 'Worker returned' },
    };

    expect(isAllowedAssistantAction(approval)).toBe(true);
    expect(isAllowedAssistantAction({ ...approval, body: {} })).toBe(true);
    expect(isAllowedAssistantAction({ ...approval, body: { confirm: false } })).toBe(false);
    expect(isAllowedAssistantAction({ ...approval, body: { ...approval.body, force: true } })).toBe(false);
    expect(isAllowedAssistantAction({ ...approval, endpoint: '/time-off/12345678901/approve' })).toBe(false);
    expect(isAllowedAssistantAction(denial)).toBe(true);
    expect(isAllowedAssistantAction({ ...denial, body: { review_note: ' ' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...denial, endpoint: '/time-off/56/approve' })).toBe(false);
    expect(isAllowedAssistantAction(revocation)).toBe(true);
    expect(isAllowedAssistantAction({ ...revocation, body: { reason: '' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...revocation, kind: 'time_off_denial' })).toBe(false);
  });

  test('confirmation allowlist tightly scopes reimbursement review actions', () => {
    const endpoint = '/reimbursements/admin/7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const baseBody = {
      admin_notes: 'Reviewed',
      updated_at: '2026-09-20T18:00:00.000Z',
    };
    const approval = {
      type: 'confirm_api', kind: 'reimbursement_approval', method: 'patch', endpoint,
      body: { ...baseBody, status: 'approved' },
    };
    const rejection = {
      type: 'confirm_api', kind: 'reimbursement_rejection', method: 'patch', endpoint,
      body: { ...baseBody, status: 'rejected' },
    };
    const restore = {
      type: 'confirm_api', kind: 'reimbursement_restore', method: 'patch', endpoint,
      body: { ...baseBody, status: 'pending', admin_notes: null },
    };
    const unapproval = {
      type: 'confirm_api', kind: 'reimbursement_unapproval', method: 'patch', endpoint,
      body: { ...baseBody, status: 'pending', admin_notes: 'Incorrect amount' },
    };

    expect(isAllowedAssistantAction(approval)).toBe(true);
    expect(isAllowedAssistantAction(rejection)).toBe(true);
    expect(isAllowedAssistantAction(restore)).toBe(true);
    expect(isAllowedAssistantAction(unapproval)).toBe(true);
    expect(isAllowedAssistantAction({ ...approval, body: { ...approval.body, status: 'pending' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...rejection, body: { ...rejection.body, admin_notes: ' ' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...unapproval, body: { ...unapproval.body, admin_notes: null } })).toBe(false);
    expect(isAllowedAssistantAction({ ...approval, body: { ...approval.body, force: true } })).toBe(false);
    expect(isAllowedAssistantAction({ ...approval, endpoint: '/reimbursements/admin/not-a-uuid' })).toBe(false);
    expect(isAllowedAssistantAction({ ...approval, body: { ...approval.body, updated_at: '2026-09-20' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...restore, kind: 'reimbursement_unapproval' })).toBe(false);
  });

  test('confirmation allowlist tightly scopes individual and recurring shift actions', () => {
    const create = {
      type: 'confirm_api',
      kind: 'shift_creation',
      method: 'post',
      endpoint: '/shifts/admin',
      body: {
        user_id: 12,
        project_id: 31,
        shift_date: '2026-10-02',
        start_time: '08:00',
        end_time: '16:30',
        notes: 'Bring PPE',
      },
    };
    const edit = {
      type: 'confirm_api',
      kind: 'shift_edit',
      method: 'patch',
      endpoint: '/shifts/admin/42',
      body: {
        project_id: null,
        shift_date: '2026-10-03',
        start_time: '22:00',
        end_time: '06:00',
        notes: null,
        updated_at: '2026-09-26T18:00:00.000Z',
      },
    };
    const cancellation = {
      type: 'confirm_api',
      kind: 'shift_cancellation',
      method: 'delete',
      endpoint: '/shifts/admin/42',
    };
    const seriesCreation = {
      type: 'confirm_api',
      kind: 'shift_series_creation',
      method: 'post',
      endpoint: '/shifts/admin/series',
      body: {
        user_id: 12,
        project_id: 31,
        dates: ['2027-01-31', '2027-02-28', '2027-03-31'],
        start_time: '08:00',
        end_time: '16:30',
        notes: 'Monthly inspection',
      },
    };
    const seriesCancellation = {
      type: 'confirm_api',
      kind: 'shift_series_cancellation',
      method: 'delete',
      endpoint: '/shifts/admin/series/7c9e6679-7425-40de-944b-e07fc1f90ae7',
    };

    expect(isAllowedAssistantAction(create)).toBe(true);
    expect(isAllowedAssistantAction(edit)).toBe(true);
    expect(isAllowedAssistantAction(cancellation)).toBe(true);
    expect(isAllowedAssistantAction(seriesCreation)).toBe(true);
    expect(isAllowedAssistantAction(seriesCancellation)).toBe(true);
    expect(isAllowedAssistantAction({ ...create, body: { ...create.body, recurrence_group_id: 'x' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...create, body: { ...create.body, user_id: '12' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...create, body: { ...create.body, shift_date: '2026-02-30' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...create, body: { ...create.body, end_time: '08:00' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...edit, body: { ...edit.body, updated_at: 'yesterday' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...edit, endpoint: '/shifts/admin/0' })).toBe(false);
    expect(isAllowedAssistantAction({ ...cancellation, body: { all: true } })).toBe(false);
    expect(isAllowedAssistantAction({ ...cancellation, endpoint: '/shifts/admin/series/abc' })).toBe(false);
    expect(isAllowedAssistantAction({ ...seriesCreation, body: { ...seriesCreation.body, dates: ['2027-01-31'] } })).toBe(false);
    expect(isAllowedAssistantAction({ ...seriesCreation, body: { ...seriesCreation.body, dates: ['2027-02-28', '2027-01-31'] } })).toBe(false);
    expect(isAllowedAssistantAction({ ...seriesCreation, body: { ...seriesCreation.body, dates: ['2027-01-31', '2027-01-31'] } })).toBe(false);
    expect(isAllowedAssistantAction({ ...seriesCreation, body: { ...seriesCreation.body, repeat: 'weekly' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...seriesCancellation, endpoint: '/shifts/admin/series/not-a-uuid' })).toBe(false);
    expect(isAllowedAssistantAction({ ...seriesCancellation, body: { include_past: true } })).toBe(false);
  });

  test('confirmation allowlist tightly scopes project creation', () => {
    const valid = {
      type: 'confirm_api',
      kind: 'project_creation',
      method: 'post',
      endpoint: '/admin/projects',
      body: {
        name: 'Mesa Drainage Phase 2',
        client_id: 22,
        job_number: 'M-204',
        address: '1200 E Main St, Mesa, AZ',
        start_date: '2026-10-05',
        end_date: '2027-02-28',
        status: 'planning',
        description: 'Storm drain extension',
        wage_type: 'prevailing',
        prevailing_wage_rate: 48.75,
        geo_lat: 33.4152,
        geo_lng: -111.8315,
        geo_radius_ft: 500,
        is_overhead: false,
      },
    };

    expect(isAllowedAssistantAction(valid)).toBe(true);
    expect(isAllowedAssistantAction({ ...valid, endpoint: '/admin/projects/22' })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, force: true } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, name: ' ' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, end_date: '2026-10-04' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, prevailing_wage_rate: null } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, wage_type: 'regular' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, geo_radius_ft: null } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, client_id: '22' } })).toBe(false);

    const regularNoFence = {
      ...valid,
      body: {
        ...valid.body,
        client_id: null,
        wage_type: 'regular',
        prevailing_wage_rate: null,
        geo_lat: null,
        geo_lng: null,
        geo_radius_ft: null,
      },
    };
    expect(isAllowedAssistantAction(regularNoFence)).toBe(true);
  });

  test('confirmation allowlist only accepts a reasoned single-entry rejection', () => {
    const valid = {
      type: 'confirm_api',
      kind: 'time_entry_rejection',
      method: 'patch',
      endpoint: '/admin/entries/91/reject',
      body: { note: 'Incorrect project' },
    };
    expect(isAllowedAssistantAction(valid)).toBe(true);
    expect(isAllowedAssistantAction({ ...valid, body: { note: ' ' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { note: 'Incorrect project', id: 91 } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, kind: 'time_entry_approval' })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, endpoint: '/admin/entries/91/unapprove' })).toBe(false);
  });

  test('confirmation allowlist tightly scopes approval reversals and rejected-entry restores', () => {
    const unapprove = {
      type: 'confirm_api',
      kind: 'time_entry_unapproval',
      method: 'patch',
      endpoint: '/admin/entries/91/unapprove',
      body: {},
    };
    const restore = {
      type: 'confirm_api',
      kind: 'time_entry_restore',
      method: 'patch',
      endpoint: '/admin/entries/92/unreject',
      body: {},
    };
    expect(isAllowedAssistantAction(unapprove)).toBe(true);
    expect(isAllowedAssistantAction(restore)).toBe(true);
    expect(isAllowedAssistantAction({ ...unapprove, body: { force: true } })).toBe(false);
    expect(isAllowedAssistantAction({ ...restore, endpoint: '/admin/entries/92/reject' })).toBe(false);
    expect(isAllowedAssistantAction({ ...restore, kind: 'time_entry_unapproval' })).toBe(false);
  });

  test('confirmation allowlist validates every time-entry edit field', () => {
    const valid = {
      type: 'confirm_api',
      kind: 'time_entry_edit',
      method: 'patch',
      endpoint: '/admin/entries/91/edit',
      body: {
        start_time: '08:00',
        end_time: '16:30',
        updated_at: '2026-09-16T01:02:03.000Z',
        work_date: '2026-09-15',
        project_id: null,
      },
    };
    expect(isAllowedAssistantAction(valid)).toBe(true);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, end_time: '25:00' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, work_date: '2026-02-30' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, project_id: -1 } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, updated_at: '2026-09-16' } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { ...valid.body, overtime_hours_override: 2 } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, endpoint: '/admin/entries/91/times' })).toBe(false);
  });

  test('confirmation allowlist only accepts bounded contiguous split segments', () => {
    const valid = {
      type: 'confirm_api',
      kind: 'time_entry_split',
      method: 'post',
      endpoint: '/admin/entries/91/split',
      body: {
        segments: [
          { start_time: '22:00:00', end_time: '00:30', project_id: null },
          { start_time: '00:30', end_time: '02:00:00', project_id: 44 },
        ],
      },
    };
    expect(isAllowedAssistantAction(valid)).toBe(true);
    expect(isAllowedAssistantAction({
      ...valid,
      body: { segments: valid.body.segments.map((segment, index) => index === 1 ? { ...segment, start_time: '00:45' } : segment) },
    })).toBe(false);
    expect(isAllowedAssistantAction({
      ...valid,
      body: { segments: valid.body.segments.map((segment, index) => index === 0 ? { ...segment, force: true } : segment) },
    })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { segments: [valid.body.segments[0]] } })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, endpoint: '/admin/entries/91/edit' })).toBe(false);
    expect(isAllowedAssistantAction({ ...valid, body: { segments: [
      { start_time: '08:00', end_time: '08:00', project_id: null },
      { start_time: '08:00', end_time: '09:00', project_id: null },
    ] } })).toBe(false);
  });

  test('provides the compact Spanish interface copy', () => {
    expect(assistantStrings('Spanish').title).toBe('Asistente de OpsFloa');
    expect(assistantStrings('Spanish').prompts).toHaveLength(3);
  });
});
