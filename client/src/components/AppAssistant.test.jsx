import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import api from '../api';
import AppAssistant, { AppAssistantLauncher, ASSISTANT_OPEN_EVENT } from './AppAssistant';
import { assistantStrings } from './appAssistantStrings';

vi.mock('../api', () => ({ default: { post: vi.fn() } }));
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
    expect(screen.getByText(/Changes are not enabled yet/)).toBeInTheDocument();
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

  test('provides the compact Spanish interface copy', () => {
    expect(assistantStrings('Spanish').title).toBe('Asistente de OpsFloa');
    expect(assistantStrings('Spanish').prompts).toHaveLength(3);
  });
});
