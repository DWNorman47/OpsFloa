/**
 * Gmail-backed mailbox for the super-admin Mail page (/mail).
 *
 * All opsfloa.com addresses forward into one Gmail account; this service
 * reads that account over IMAP (app password) and presents each opsfloa
 * address as its own isolated "account": lists filter server-side on
 * Gmail's `deliveredto:` operator (X-GM-RAW), so mail addressed to the
 * Gmail account itself never appears here, and each address only sees
 * its own messages.
 *
 * Folders are Gmail labels under `OpsFloaMail/<localpart>/<Folder>` —
 * filing a message adds the label, the inbox view excludes every folder
 * label, and the state lives in the mailbox itself (visible from Gmail,
 * survives redeploys, no parallel DB to drift). Sent mail goes out
 * through Resend (the domain is verified there) and a copy is APPENDed
 * to the account's `.../Sent` label so it shows up like any folder.
 *
 * Config (all optional — the page shows "not configured" without them):
 *   MAILBOX_GMAIL_USER          the Gmail address
 *   MAILBOX_GMAIL_APP_PASSWORD  Google app password (needs 2FA on the account)
 *   MAILBOX_ACCOUNTS            comma list of opsfloa addresses; first = default
 *
 * Concurrency: one shared IMAP connection behind a promise-queue mutex
 * (IMAP is stateful — the selected mailbox is connection-global). Single
 * super-admin user, so throughput is a non-issue; the connection closes
 * after 60s idle so Gmail doesn't reap it mid-command.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const logger = require('../logger');

const LABEL_ROOT = 'OpsFloaMail';
const IDLE_CLOSE_MS = 60 * 1000;
const PAGE_SIZE = 50;

function isConfigured() {
  return !!(process.env.MAILBOX_GMAIL_USER && process.env.MAILBOX_GMAIL_APP_PASSWORD && accounts().length);
}

/** Configured opsfloa addresses, lowercased. First entry is the default. */
function accounts() {
  return String(process.env.MAILBOX_ACCOUNTS || '')
    .split(',')
    .map(a => a.trim().toLowerCase())
    .filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
}

function isKnownAccount(account) {
  return accounts().includes(String(account || '').toLowerCase());
}

/** Label prefix for one account's folders: OpsFloaMail/info, OpsFloaMail/support… */
function accountPrefix(account) {
  return `${LABEL_ROOT}/${String(account).toLowerCase().split('@')[0]}`;
}

// Always-present folders, listed last in a fixed order. 'Archived' and
// 'Trash' are normal move targets (Trash is filing, not deletion — the
// message keeps living in Gmail's All Mail); 'Sent' only receives copies
// of outgoing mail. None can be created, renamed, or deleted.
const RESERVED_FOLDERS = ['Archived', 'Trash', 'Sent'];

function isReservedFolder(name) {
  return RESERVED_FOLDERS.includes(String(name || '').trim());
}

// Folder names become Gmail label path segments — no slashes or exotic chars.
function isValidFolderName(name) {
  return typeof name === 'string' && /^[\w\- ()&]{1,40}$/.test(name.trim()) && !isReservedFolder(name);
}

// ---------------------------------------------------------------------------
// Shared connection + mutex

let conn = null;          // live ImapFlow client (or null)
let allMailPath = null;   // cached "[Gmail]/All Mail" path (locale-dependent)
let queue = Promise.resolve();
let idleTimer = null;

async function getConnection() {
  if (conn && conn.usable) return conn;
  conn = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.MAILBOX_GMAIL_USER, pass: process.env.MAILBOX_GMAIL_APP_PASSWORD },
    logger: false,
  });
  conn.on('error', err => {
    logger.warn({ err: { message: err.message } }, 'mailbox: imap connection error');
    conn = null;
  });
  await conn.connect();
  return conn;
}

async function findAllMailPath(client) {
  if (allMailPath) return allMailPath;
  const boxes = await client.list();
  const all = boxes.find(b => b.specialUse === '\\All');
  allMailPath = all ? all.path : '[Gmail]/All Mail';
  return allMailPath;
}

/**
 * Run `fn(client, allMail)` with exclusive use of the shared connection.
 * Errors reject the caller but never poison the queue; a dead connection
 * is retried once with a fresh one.
 */
function withMailbox(fn) {
  const run = queue.then(async () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    let client;
    try {
      client = await getConnection();
      return await fn(client, await findAllMailPath(client));
    } catch (err) {
      // Stale/broken connection — reconnect once and retry.
      try { await conn?.logout?.(); } catch { /* already gone */ }
      conn = null;
      client = await getConnection();
      return await fn(client, await findAllMailPath(client));
    } finally {
      idleTimer = setTimeout(() => {
        conn?.logout?.().catch(() => {});
        conn = null;
      }, IDLE_CLOSE_MS).unref?.();
    }
  });
  queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Folders

/** List an account's folders (label segment after the prefix). Custom folders
 *  first (alphabetical), then the reserved ones in fixed order — all reserved
 *  folders always exist conceptually, even before their label is created. */
async function listFolders(account) {
  return withMailbox(async client => {
    const prefix = accountPrefix(account) + '/';
    const boxes = await client.list();
    const names = boxes
      .filter(b => b.path.startsWith(prefix))
      .map(b => b.path.slice(prefix.length))
      .filter(n => n && !n.includes('/'));
    for (const r of RESERVED_FOLDERS) if (!names.includes(r)) names.push(r);
    const rank = n => RESERVED_FOLDERS.indexOf(n) + 1 || 0;
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  });
}

async function createFolder(account, name) {
  return withMailbox(async client => {
    const path = `${accountPrefix(account)}/${name.trim()}`;
    try {
      await client.mailboxCreate(path);
    } catch (err) {
      if (!/ALREADYEXISTS/i.test(err.responseText || err.message || '')) throw err;
    }
    return path;
  });
}

/** Deleting a folder removes the label; its messages fall back to the inbox view. */
async function deleteFolder(account, name) {
  return withMailbox(async client => {
    await client.mailboxDelete(`${accountPrefix(account)}/${name.trim()}`);
  });
}

// ---------------------------------------------------------------------------
// Listing

/**
 * Gmail raw query for one account view. The inbox is "delivered to this
 * address and not filed into any of its folders"; a folder view is just
 * its label. Sent copies live under the prefix too, so they are excluded
 * from the inbox by the same rule.
 *
 * Tabs route by sender on top of the unfiled rule: a tab view narrows to
 * its senders (`from:(a OR b)`), and the inbox excludes every tab's
 * senders (`-from:a -from:b`) so tabbed mail shows in its tab instead.
 * Entries can be full addresses or bare domains — Gmail's `from:`
 * matches either.
 */
function buildQuery(account, folder, folderNames, q, { tabSenders = null, excludeSenders = [] } = {}) {
  const prefix = accountPrefix(account);
  let query;
  if (folder) {
    query = `label:"${prefix}/${folder}"`;
  } else {
    const exclusions = folderNames.map(n => `-label:"${prefix}/${n}"`).join(' ');
    query = `deliveredto:"${account}" ${exclusions} -in:sent -in:trash -in:spam`;
    if (tabSenders && tabSenders.length) {
      query += ` (${tabSenders.map(s => `from:${s}`).join(' OR ')})`;
    } else if (excludeSenders.length) {
      query += ` ${excludeSenders.map(s => `-from:${s}`).join(' ')}`;
    }
  }
  if (q) query += ` ${String(q).replace(/[\r\n]/g, ' ').slice(0, 200)}`;
  return query;
}

async function listMessages({ account, folder = null, q = '', page = 1, dir = 'desc', tabSenders = null, excludeSenders = [] }) {
  const folderNames = await listFolders(account);
  if (folder && !folderNames.includes(folder)) throw Object.assign(new Error('Folder not found'), { status: 404 });
  return withMailbox(async (client, allMail) => {
    await client.mailboxOpen(allMail, { readOnly: true });
    const uids = await client.search({ gmraw: buildQuery(account, folder, folderNames, q, { tabSenders, excludeSenders }) }, { uid: true }) || [];
    uids.sort((a, b) => (dir === 'asc' ? a - b : b - a)); // uid order ≈ arrival order
    const total = uids.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const slice = uids.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const items = [];
    if (slice.length) {
      for await (const msg of client.fetch(slice.join(','), { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
        items.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || '(no subject)',
          from: msg.envelope?.from?.[0] ? { name: msg.envelope.from[0].name || '', address: msg.envelope.from[0].address || '' } : null,
          to: (msg.envelope?.to || []).map(t => t.address).filter(Boolean),
          date: msg.internalDate || msg.envelope?.date || null,
          seen: msg.flags?.has('\\Seen') ?? false,
          size: msg.size || 0,
        });
      }
      // fetch yields in mailbox order — restore the requested sort
      const pos = new Map(slice.map((uid, i) => [uid, i]));
      items.sort((a, b) => pos.get(a.uid) - pos.get(b.uid));
    }
    return { items, total, page, pages, folders: folderNames };
  });
}

// ---------------------------------------------------------------------------
// Single message

function addressesOf(parsed) {
  const out = new Set();
  for (const key of ['to', 'cc', 'bcc']) {
    const v = parsed[key];
    const list = Array.isArray(v) ? v : v ? [v] : [];
    for (const entry of list) for (const a of entry.value || []) if (a.address) out.add(a.address.toLowerCase());
  }
  for (const h of ['delivered-to', 'x-forwarded-to', 'x-original-to']) {
    const v = parsed.headers?.get(h);
    for (const line of Array.isArray(v) ? v : v ? [v] : []) {
      const text = typeof line === 'string' ? line : line?.text || '';
      const m = text.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || [];
      m.forEach(a => out.add(a.toLowerCase()));
    }
  }
  for (const a of (parsed.from?.value || [])) if (a.address) out.add(a.address.toLowerCase());
  return out;
}

/**
 * Fetch + parse one message, enforcing account isolation: the message must
 * involve this address (delivered-to/to/cc/from) or carry one of its
 * folder labels — otherwise 404, so switching accounts can't read across.
 */
async function getMessage(account, uid) {
  return withMailbox(async (client, allMail) => {
    await client.mailboxOpen(allMail, { readOnly: true });
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true, labels: true }, { uid: true });
    if (!msg || !msg.source) throw Object.assign(new Error('Message not found'), { status: 404 });

    const parsed = await simpleParser(msg.source);
    const prefix = accountPrefix(account) + '/';
    const hasAccountLabel = [...(msg.labels || [])].some(l => String(l).startsWith(prefix));
    if (!hasAccountLabel && !addressesOf(parsed).has(String(account).toLowerCase())) {
      throw Object.assign(new Error('Message not found'), { status: 404 });
    }

    return {
      uid: Number(uid),
      subject: parsed.subject || '(no subject)',
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      date: parsed.date || null,
      messageId: parsed.messageId || null,
      references: parsed.references || null,
      seen: msg.flags?.has('\\Seen') ?? false,
      labels: [...(msg.labels || [])].filter(l => String(l).startsWith(prefix)).map(l => String(l).slice(prefix.length)),
      html: parsed.html || null,
      text: parsed.text || '',
      attachments: (parsed.attachments || []).map((a, i) => ({
        index: i,
        filename: a.filename || `attachment-${i + 1}`,
        contentType: a.contentType || 'application/octet-stream',
        size: a.size || 0,
      })),
    };
  });
}

/** Re-parse and return one attachment's bytes (no caching — single-user tool). */
async function getAttachment(account, uid, index) {
  return withMailbox(async (client, allMail) => {
    await client.mailboxOpen(allMail, { readOnly: true });
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, labels: true }, { uid: true });
    if (!msg || !msg.source) throw Object.assign(new Error('Message not found'), { status: 404 });
    const parsed = await simpleParser(msg.source);
    const prefix = accountPrefix(account) + '/';
    const hasAccountLabel = [...(msg.labels || [])].some(l => String(l).startsWith(prefix));
    if (!hasAccountLabel && !addressesOf(parsed).has(String(account).toLowerCase())) {
      throw Object.assign(new Error('Message not found'), { status: 404 });
    }
    const att = (parsed.attachments || [])[index];
    if (!att) throw Object.assign(new Error('Attachment not found'), { status: 404 });
    return { filename: att.filename || `attachment-${index + 1}`, contentType: att.contentType || 'application/octet-stream', content: att.content };
  });
}

async function setSeen(uid, seen) {
  return withMailbox(async (client, allMail) => {
    await client.mailboxOpen(allMail);
    if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
  });
}

/**
 * File a message into a folder (or back to the inbox with folder=null):
 * strip every label under the account's prefix, then add the target one.
 */
async function moveToFolder(account, uid, folder) {
  if (folder) await createFolder(account, folder);
  return withMailbox(async (client, allMail) => {
    await client.mailboxOpen(allMail);
    const prefix = accountPrefix(account) + '/';
    const msg = await client.fetchOne(String(uid), { uid: true, labels: true }, { uid: true });
    if (!msg) throw Object.assign(new Error('Message not found'), { status: 404 });
    const current = [...(msg.labels || [])].map(String).filter(l => l.startsWith(prefix));
    const target = folder ? `${prefix}${folder}` : null;
    const toRemove = current.filter(l => l !== target);
    if (toRemove.length) await client.messageFlagsRemove(String(uid), toRemove, { uid: true, useLabels: true });
    if (target && !current.includes(target)) await client.messageFlagsAdd(String(uid), [target], { uid: true, useLabels: true });
  });
}

// ---------------------------------------------------------------------------
// Sent copies

/** Minimal RFC822 builder for the Sent copy (Resend does the real delivery). */
function buildRawMessage({ from, to, cc, subject, text, inReplyTo, references, date }) {
  const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encWord(subject || '')}`,
    `Date: ${(date || new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <mail-${Date.now()}-${Math.random().toString(36).slice(2)}@opsfloa.com>`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text || ''),
  ];
  return lines.join('\r\n');
}

async function appendSent(account, fields) {
  const prefix = accountPrefix(account);
  return withMailbox(async client => {
    try {
      await client.mailboxCreate(`${prefix}/Sent`);
    } catch (err) {
      if (!/ALREADYEXISTS/i.test(err.responseText || err.message || '')) throw err;
    }
    await client.append(`${prefix}/Sent`, Buffer.from(buildRawMessage(fields), 'utf8'), ['\\Seen']);
  });
}

module.exports = {
  isConfigured, accounts, isKnownAccount, isValidFolderName, isReservedFolder,
  listFolders, createFolder, deleteFolder,
  listMessages, getMessage, getAttachment, setSeen, moveToFolder,
  appendSent,
};
