import { useEffect } from 'react';
import { registerDirtyForm, unregisterDirtyForm } from '../utils/dirtyForms';

/**
 * Register this form in the global dirty-form registry while `isDirty` is true,
 * so background actions (e.g. the auto-reload onto a new build) skip while the
 * user has unsaved work. Unregisters on save (isDirty → false) and on unmount.
 */
export function useDirtyForm(isDirty, label) {
  useEffect(() => {
    if (!isDirty) return undefined;
    const token = registerDirtyForm(label);
    return () => unregisterDirtyForm(token);
  }, [isDirty, label]);
}
