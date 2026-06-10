// Block the user from losing form work when they close the tab,
// refresh, or hit the back button on a form with unsaved changes.
//
// `isDirty` is a boolean the form component owns (true when the user
// has typed anything that differs from the last-loaded state). When
// true:
//   - Tab close / refresh → browser's native "Are you sure you want
//     to leave?" dialog fires
//   - Browser back/forward → SPA's `popstate` listener catches it and
//     window.confirm()s before allowing the nav. (The new
//     ConfirmDialog can't be reached from a popstate handler since
//     popstate is synchronous — we'd lose the navigation race. Falls
//     back to the native confirm here.)
//
// The form component should also call `markSaved()` after a successful
// save so subsequent saves don't keep tripping the prompt.

import { useEffect } from 'react';

export function useUnsavedChanges(isDirty) {
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e) {
      // Setting returnValue is the way to opt in to the native dialog
      // in modern browsers. The displayed text is browser-controlled.
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);
}
