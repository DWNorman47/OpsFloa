// Service worker: opens the action popup when the in-page key icon is clicked, and reports
// back whether it succeeded so the content script can fall back to an in-page generate+fill.
// chrome.action.openPopup() is best-effort — some browsers/pages/versions reject it.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'openPopup') {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup()
        .then(() => sendResponse({ opened: true }))
        .catch(() => sendResponse({ opened: false }));
      return true; // keep the message channel open for the async response
    }
    sendResponse({ opened: false });
  }
});
