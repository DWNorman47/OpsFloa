// Global registry of forms holding unsaved work.
//
// Things that would throw away in-memory state without asking — chiefly the
// UpdatePrompt auto-reload that fires when the tab is hidden — check
// hasDirtyForms() first. A worker filling a daily report who flips to the camera
// app hides the tab; reloading then would silently lose the draft.
//
// Components don't call this directly; use the useDirtyForm(isDirty) hook
// (hooks/useDirtyForm.js), or useUnsavedChanges, which registers too.

const dirty = new Set();
let nextId = 0;

/** Mark a form dirty. Returns a token for unregisterDirtyForm. */
export function registerDirtyForm(label = 'form') {
  const token = { id: ++nextId, label };
  dirty.add(token);
  return token;
}

export function unregisterDirtyForm(token) {
  dirty.delete(token);
}

export function hasDirtyForms() {
  return dirty.size > 0;
}

/** Test helper — clears every registration. */
export function _resetDirtyForms() {
  dirty.clear();
}
