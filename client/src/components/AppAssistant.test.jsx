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

  test('confirmation allowlist rejects arbitrary endpoints', () => {
    expect(isAllowedAssistantAction({
      type: 'confirm_api',
      kind: 'time_entry_approval',
      method: 'post',
      endpoint: '/admin/companies/delete',
      body: {},
    })).toBe(false);
  });

  test('provides the compact Spanish interface copy', () => {
    expect(assistantStrings('Spanish').title).toBe('Asistente de OpsFloa');
    expect(assistantStrings('Spanish').prompts).toHaveLength(3);
  });
});
