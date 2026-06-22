// Block the user from losing form work when they close the tab or
// refresh a page that has unsaved changes.
//
// `isDirty` is a boolean the form component owns (true when the user
// has typed anything that differs from the last-loaded state). When
// true, tab-close / hard-refresh triggers the browser's native
// "leave this page?" dialog via the `beforeunload` event.
//
// Scope intentionally narrow:
//   - This hook does NOT intercept in-app navigation (clicking Cancel,
//     clicking a sidebar link, popstate from browser back/forward).
//     beforeunload only fires for full document unloads; SPA route
//     changes never trigger it. Forms that want to guard an in-app
//     Cancel should check dirty themselves before invoking onCancel.
//
// After a successful save, flip the dirty flag back to false so the
// prompt doesn't fire on subsequent navigations.

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
