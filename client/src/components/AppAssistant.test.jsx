import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import api from '../api';
import AppAssistant, { AppAssistantLauncher, ASSISTANT_OPEN_EVENT, isAllowedAssistantAction } from './AppAssistant';
import { assistantStrings } from './appAssistantStrings';

vi.mock('../api', () => ({ default: { post: vi.fn(), patch: vi.fn() } }));
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

  test('confirmation allowlist rejects arbitrary endpoints', () => {
    expect(isAllowedAssistantAction({
      type: 'confirm_api',
      kind: 'time_entry_approval',
      method: 'post',
      endpoint: '/admin/companies/delete',
      body: {},
    })).toBe(false);
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

  test('provides the compact Spanish interface copy', () => {
    expect(assistantStrings('Spanish').title).toBe('Asistente de OpsFloa');
    expect(assistantStrings('Spanish').prompts).toHaveLength(3);
  });
});
