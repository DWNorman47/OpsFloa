// Minimal HTML-escape for safe interpolation into email + admin-UI
// templates. Covers the 5 chars that turn benign text into markup:
// & first (otherwise we double-encode), then < > " '. Numeric / named
// entity escapes are NOT necessary here; we're not generating XML
// attributes or javascript: URLs, just HTML text and attributes.
//
// Used by every place we interpolate user-supplied or DB-sourced text
// into an HTML email body. Prior to this, sendBookingEmails and
// sendBookingReminders concatenated raw client_name / client_notes /
// description into <p> tags — an XSS / tracking-pixel injection vector
// for any client willing to type `<img src=evil>` into the name field.
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
