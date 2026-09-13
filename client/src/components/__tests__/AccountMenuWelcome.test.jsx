import { describe, test, expect } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import AccountMenu from '../AccountMenu';
import Landing from '../../pages/Landing';
import { makeUser, renderWithProviders } from '../../__tests__/test-helpers';

describe('signed-in website preview', () => {
  test('account menu opens the public welcome page in a new tab', () => {
    renderWithProviders(<AccountMenu />, { user: makeUser('admin') });
    fireEvent.click(screen.getByRole('button', { name: 'Test User' }));

    const link = screen.getByRole('menuitem', { name: 'View website' });
    expect(link).toHaveAttribute('href', '/welcome');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('public landing content renders with a signed-in session', () => {
    renderWithProviders(<Landing />, { user: makeUser('admin'), route: '/welcome' });
    expect(screen.getByRole('heading', { level: 1, name: 'OpsFloa' })).toBeInTheDocument();
  });
});
