const PUBLIC_LINK_ERROR = 'This link is invalid or expired.';

export function publicLinkError(err, fallback = PUBLIC_LINK_ERROR) {
  const status = err?.response?.status;
  // A bad/expired token (or a missing record) comes back as 401/403/404 — show
  // a generic link message rather than leaking specifics.
  if ([401, 403, 404].includes(status)) return PUBLIC_LINK_ERROR;
  // Everything else (validation 400s, conflicts, server errors) carries an
  // actionable message — surface it so a real validation error ("Invalid
  // email", "That slot was just booked") isn't mislabeled as an expired link.
  return err?.response?.data?.error || fallback;
}
