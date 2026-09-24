import { describe, test, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { registerDirtyForm, unregisterDirtyForm, hasDirtyForms, _resetDirtyForms } from './dirtyForms';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

describe('dirty-form registry', () => {
  beforeEach(() => _resetDirtyForms());

  test('register / unregister', () => {
    expect(hasDirtyForms()).toBe(false);
    const a = registerDirtyForm('a');
    const b = registerDirtyForm('b');
    expect(hasDirtyForms()).toBe(true);
    unregisterDirtyForm(a);
    expect(hasDirtyForms()).toBe(true);
    unregisterDirtyForm(b);
    expect(hasDirtyForms()).toBe(false);
  });

  test('useDirtyForm follows isDirty and cleans up on unmount', () => {
    const { rerender, unmount } = renderHook(({ d }) => useDirtyForm(d), { initialProps: { d: false } });
    expect(hasDirtyForms()).toBe(false);
    rerender({ d: true });
    expect(hasDirtyForms()).toBe(true);
    rerender({ d: false });
    expect(hasDirtyForms()).toBe(false);
    rerender({ d: true });
    unmount();
    expect(hasDirtyForms()).toBe(false);
  });

  test('useUnsavedChanges also registers', () => {
    const { unmount } = renderHook(() => useUnsavedChanges(true));
    expect(hasDirtyForms()).toBe(true);
    unmount();
    expect(hasDirtyForms()).toBe(false);
  });
});
