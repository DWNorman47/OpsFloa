const PUBLIC_LINK_ERROR = 'This link is invalid or expired.';

export function publicLinkError(err, fallback = PUBLIC_LINK_ERROR) {
  const status = err?.response?.status;
  const apiMessage = err?.response?.data?.error;
  const messageText = String(apiMessage || '');

  if ([401, 403, 404].includes(status)) return PUBLIC_LINK_ERROR;
  if (/unauthorized|forbidden|not found|invalid|expired|token/i.test(messageText)) {
    return PUBLIC_LINK_ERROR;
  }

  return apiMessage || fallback;
}
