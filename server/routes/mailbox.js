/**
 * Super-admin Mail page API (/mail). Reads the forwarding Gmail account
 * over IMAP, scoped per opsfloa address; sends through Resend (verified
 * domain). See server/services/gmailMailbox.js for the architecture.
 *
 * Deliberately NOT routed through email.js sendEmail(): that wrapper
 * forces the app's transactional from-address and redirects recipients in
 * non-production (EMAIL_MODE). A hand-composed email from this page is an
 * explicit human action — it goes to the real recipient from the chosen
 * account, in every environment.
 */

const router = require('express').Router();
const { Resend } = require('resend');
const { requireSuperAdmin } = require('../middleware/auth');
const mailbox = require('../services/gmailMailbox');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

router.use(requireSuperAdmin);

// Optional extra pin beyond the super_admin role: MAILBOX_ALLOWED_USERS is a
// comma list of usernames and/or user ids allowed to use the Mail page.
// Unset = any super admin (today that's one person; the pin exists so a
// second super-admin account added later doesn't silently inherit the inbox).
router.use((req, res, next) => {
  const allowed = String(process.env.MAILBOX_ALLOWED_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return next();
  if (allowed.includes(String(req.user.id)) || allowed.includes(String(req.user.username || '').toLowerCase())) {
    return next();
  }
  res.status(403).json({ error: 'The Mail page is restricted to specific users.' });
});

function requireConfigured(req, res, next) {
  if (!mailbox.isConfigured()) {
    return res.status(400).json({ error: 'Mailbox is not configured. Set MAILBOX_GMAIL_USER, MAILBOX_GMAIL_APP_PASSWORD and MAILBOX_ACCOUNTS.' });
  }
  next();
}

function requireAccount(req, res, next) {
  const account = String(req.query.account || req.body?.account || '').toLowerCase();
  if (!mailbox.isKnownAccount(account)) return res.status(400).json({ error: 'Unknown account' });
  req.mailAccount = account;
  next();
}

function sendErr(res, err, log, fallback) {
  if (err.status === 404) return res.status(404).json({ error: err.message });
  log.error({ err: { message: err.message } }, 'mailbox route error');
  res.status(502).json({ error: fallback });
}

// GET /mailbox/config — accounts + configured flag (page bootstrap)
router.get('/config', (req, res) => {
  const accounts = mailbox.accounts();
  res.json({ configured: mailbox.isConfigured(), accounts, defaultAccount: accounts[0] || null });
});

// GET /mailbox/messages?account=&folder=&q=&page=&dir= — one account view
router.get('/messages', requireConfigured, requireAccount, async (req, res) => {
  try {
    const result = await mailbox.listMessages({
      account: req.mailAccount,
      folder: req.query.folder ? String(req.query.folder) : null,
      q: req.query.q ? String(req.query.q) : '',
      page: Math.max(1, parseInt(req.query.page) || 1),
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
    });
    res.json(result);
  } catch (err) { sendErr(res, err, req.log, 'Could not load messages from the mailbox.'); }
});

// GET /mailbox/messages/:uid?account= — full parsed message
router.get('/messages/:uid', requireConfigured, requireAccount, async (req, res) => {
  try {
    res.json(await mailbox.getMessage(req.mailAccount, parseInt(req.params.uid)));
  } catch (err) { sendErr(res, err, req.log, 'Could not load the message.'); }
});

// GET /mailbox/messages/:uid/attachments/:index?account=
router.get('/messages/:uid/attachments/:index', requireConfigured, requireAccount, async (req, res) => {
  try {
    const att = await mailbox.getAttachment(req.mailAccount, parseInt(req.params.uid), parseInt(req.params.index) || 0);
    res.setHeader('Content-Type', att.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${att.filename.replace(/["\r\n]/g, '')}"`);
    res.send(att.content);
  } catch (err) { sendErr(res, err, req.log, 'Could not load the attachment.'); }
});

// POST /mailbox/messages/:uid/read { account, seen }
router.post('/messages/:uid/read', requireConfigured, requireAccount, async (req, res) => {
  try {
    await mailbox.setSeen(parseInt(req.params.uid), req.body?.seen !== false);
    res.json({ ok: true });
  } catch (err) { sendErr(res, err, req.log, 'Could not update the message.'); }
});

// POST /mailbox/messages/:uid/move { account, folder|null } — file / unfile
router.post('/messages/:uid/move', requireConfigured, requireAccount, async (req, res) => {
  try {
    const folder = req.body?.folder ? String(req.body.folder).trim() : null;
    if (folder && !mailbox.isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });
    await mailbox.moveToFolder(req.mailAccount, parseInt(req.params.uid), folder);
    res.json({ ok: true });
  } catch (err) { sendErr(res, err, req.log, 'Could not move the message.'); }
});

// POST /mailbox/folders { account, name }
router.post('/folders', requireConfigured, requireAccount, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!mailbox.isValidFolderName(name)) return res.status(400).json({ error: 'Folder names: letters, numbers, spaces, - _ & ( ) — max 40 chars ("Sent" is reserved).' });
    await mailbox.createFolder(req.mailAccount, name);
    res.json({ ok: true, folders: await mailbox.listFolders(req.mailAccount) });
  } catch (err) { sendErr(res, err, req.log, 'Could not create the folder.'); }
});

// DELETE /mailbox/folders?account=&name= — label removed, messages fall back to inbox
router.delete('/folders', requireConfigured, requireAccount, async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!mailbox.isValidFolderName(name)) return res.status(400).json({ error: 'Invalid folder name' });
    await mailbox.deleteFolder(req.mailAccount, name);
    res.json({ ok: true, folders: await mailbox.listFolders(req.mailAccount) });
  } catch (err) { sendErr(res, err, req.log, 'Could not delete the folder.'); }
});

// POST /mailbox/send { account, to, cc?, subject, text, inReplyTo?, references? }
router.post('/send', requireConfigured, requireAccount, async (req, res) => {
  try {
    if (!resend) return res.status(400).json({ error: 'RESEND_API_KEY is not set — cannot send email.' });
    const { to, cc, subject, text, inReplyTo, references } = req.body || {};
    const clean = v => String(v || '').replace(/[\r\n]/g, ' ').trim();
    const toList = clean(to).split(',').map(a => a.trim()).filter(Boolean);
    const ccList = clean(cc).split(',').map(a => a.trim()).filter(Boolean);
    const bad = [...toList, ...ccList].find(a => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (!toList.length) return res.status(400).json({ error: 'Missing recipient' });
    if (bad) return res.status(400).json({ error: `Invalid address: ${bad}` });
    if (!clean(subject) && !String(text || '').trim()) return res.status(400).json({ error: 'Nothing to send' });

    const from = `OpsFloa <${req.mailAccount}>`;
    const headers = {};
    if (clean(inReplyTo)) headers['In-Reply-To'] = clean(inReplyTo);
    if (clean(references)) headers['References'] = clean(references).slice(0, 2000);

    const { error } = await resend.emails.send({
      from,
      to: toList,
      ...(ccList.length ? { cc: ccList } : {}),
      subject: clean(subject) || '(no subject)',
      text: String(text || ''),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    if (error) {
      req.log.error({ err: error }, 'mailbox send failed');
      return res.status(502).json({ error: 'The email provider rejected the send.' });
    }

    // Best-effort Sent copy — the mail is already delivered, so a failed
    // append must not fail the request.
    try {
      await mailbox.appendSent(req.mailAccount, {
        from, to: toList.join(', '), cc: ccList.join(', '),
        subject: clean(subject), text: String(text || ''),
        inReplyTo: clean(inReplyTo), references: clean(references),
      });
    } catch (appendErr) {
      req.log.warn({ err: { message: appendErr.message } }, 'mailbox sent-copy append failed');
    }
    res.json({ ok: true });
  } catch (err) { sendErr(res, err, req.log, 'Could not send the email.'); }
});

module.exports = router;
