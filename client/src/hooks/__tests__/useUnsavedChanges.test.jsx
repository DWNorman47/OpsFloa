/**
 * Tests for useUnsavedChanges — the beforeunload guard that prompts the
 * browser's native "leave this page?" dialog when a form is dirty. The
 * contract is narrow on purpose (full-document unload only), so the
 * tests just verify the listener is wired when dirty, torn down when
 * clean, and that the handler opts into the native prompt.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnsavedChanges } from '../useUnsavedChanges';

describe('useUnsavedChanges', () => {
  let addSpy;
  let removeSpy;

  beforeEach(() => {
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
  });
  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  test('does not register a beforeunload listener when clean', () => {
    renderHook(() => useUnsavedChanges(false));
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  test('registers a beforeunload listener when dirty', () => {
    renderHook(() => useUnsavedChanges(true));
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  test('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useUnsavedChanges(true));
    const handler = addSpy.mock.calls.find(c => c[0] === 'beforeunload')[1];
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', handler);
  });

  test('removes the listener when the form transitions dirty → clean', () => {
    const { rerender } = renderHook(({ dirty }) => useUnsavedChanges(dirty), {
      initialProps: { dirty: true },
    });
    const handler = addSpy.mock.calls.find(c => c[0] === 'beforeunload')[1];
    rerender({ dirty: false });
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', handler);
  });

  test('the handler opts into the native prompt (sets returnValue)', () => {
    renderHook(() => useUnsavedChanges(true));
    const handler = addSpy.mock.calls.find(c => c[0] === 'beforeunload')[1];
    const evt = { preventDefault: vi.fn(), returnValue: undefined };
    handler(evt);
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(evt.returnValue).toBe('');
  });
});
