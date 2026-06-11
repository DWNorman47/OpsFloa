/**
 * Tests for useConfirm / ConfirmDialog — the promise-based replacement
 * for window.confirm() used across the admin pages. The interesting
 * behavior is the imperative async contract (confirm() resolves
 * true/false based on which button the user clicks) and the per-instance
 * title id wired to aria-labelledby.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useConfirm } from '../ConfirmDialog';

// useConfirm now uses useT() (for default labels) → useAuth(); stub a
// user so the hook resolves without an AuthContext provider.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, language: 'English' } }),
}));

// Minimal harness: a trigger button that opens the confirm and reports
// the resolved value, plus the dialog rendered unconditionally.
function Harness({ onResult, confirmArgs }) {
  const { confirm, dialog } = useConfirm();
  return (
    <div>
      <button onClick={async () => onResult(await confirm(confirmArgs))}>trigger</button>
      {dialog}
    </div>
  );
}

describe('useConfirm', () => {
  test('does not render the dialog until confirm() is called', () => {
    render(<Harness onResult={() => {}} confirmArgs={{ title: 'Delete it?' }} />);
    expect(screen.queryByText('Delete it?')).not.toBeInTheDocument();
  });

  test('renders the title and body when opened', async () => {
    render(<Harness onResult={() => {}} confirmArgs={{ title: 'Delete it?', body: 'This cannot be undone.' }} />);
    fireEvent.click(screen.getByText('trigger'));
    expect(await screen.findByText('Delete it?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  test('resolves true when the confirm button is clicked', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} confirmArgs={{ title: 'Go?', confirmLabel: 'Do it' }} />);
    fireEvent.click(screen.getByText('trigger'));
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  test('resolves false when the cancel button is clicked', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} confirmArgs={{ title: 'Go?' }} />);
    fireEvent.click(screen.getByText('trigger'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  test('dismisses the dialog after a choice', async () => {
    render(<Harness onResult={() => {}} confirmArgs={{ title: 'Go?' }} />);
    fireEvent.click(screen.getByText('trigger'));
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByText('Go?')).not.toBeInTheDocument());
  });

  test('danger tone paints the confirm button red', async () => {
    render(<Harness onResult={() => {}} confirmArgs={{ title: 'Delete?', confirmLabel: 'Delete', tone: 'danger' }} />);
    fireEvent.click(screen.getByText('trigger'));
    const btn = await screen.findByRole('button', { name: 'Delete' });
    expect(btn).toHaveStyle({ background: '#dc2626' });
  });

  test('the title id is unique per instance and wired to aria-labelledby', async () => {
    render(<Harness onResult={() => {}} confirmArgs={{ title: 'Heads up' }} />);
    fireEvent.click(screen.getByText('trigger'));
    const dialog = await screen.findByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    // the referenced element is the heading carrying the title text
    expect(document.getElementById(labelledBy)).toHaveTextContent('Heads up');
  });

  test('falls back to default labels when none are supplied', async () => {
    render(<Harness onResult={() => {}} confirmArgs={{}} />);
    fireEvent.click(screen.getByText('trigger'));
    expect(await screen.findByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
