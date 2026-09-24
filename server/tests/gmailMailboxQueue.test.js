// services/gmailMailbox.js shared-connection queue: retry only on connection
// errors, never re-APPEND a Sent copy once the command went out, and a hung
// command can't block the queue past its timeout.
const mailbox = require('../services/gmailMailbox');
const { withMailbox, isConnectionError, setClientFactoryForTests } = mailbox._internals;

function makeFactory(overrides = {}) {
  const clients = [];
  const factory = () => {
    const c = {
      usable: true,
      on: jest.fn(),
      connect: jest.fn(async () => {}),
      list: jest.fn(async () => [{ specialUse: '\\All', path: '[Gmail]/All Mail' }]),
      close: jest.fn(function close() { this.usable = false; }),
      logout: jest.fn(async () => {}),
      mailboxCreate: jest.fn(async () => {}),
      append: jest.fn(async () => {}),
      ...overrides,
    };
    clients.push(c);
    return c;
  };
  return { factory, clients };
}

const connErr = () => Object.assign(new Error('Socket is already closed'), { code: 'NoConnection' });

describe('isConnectionError', () => {
  test('classifies', () => {
    expect(isConnectionError(connErr())).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('Message not found'), { status: 404 }))).toBe(false);
    expect(isConnectionError(new Error('Command failed'))).toBe(false);
    expect(isConnectionError(Object.assign(new Error('t'), { code: 'MAILBOX_OP_TIMEOUT' }))).toBe(false);
  });
});

describe('withMailbox', () => {
  test('does not retry our own 404s', async () => {
    const { factory } = makeFactory();
    setClientFactoryForTests(factory);
    const fn = jest.fn(async () => { throw Object.assign(new Error('Message not found'), { status: 404 }); });
    await expect(withMailbox(fn)).rejects.toMatchObject({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries once on a fresh connection after a connection error', async () => {
    const { factory, clients } = makeFactory();
    setClientFactoryForTests(factory);
    let n = 0;
    const fn = jest.fn(async () => { if (n++ === 0) throw connErr(); return 'ok'; });
    await expect(withMailbox(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(clients.length).toBe(2);
  });

  test('a hung command times out, drops the connection, and frees the queue', async () => {
    const { factory, clients } = makeFactory();
    setClientFactoryForTests(factory);
    const hung = withMailbox(() => new Promise(() => {}), { timeoutMs: 50 });
    const next = withMailbox(async () => 'next');
    await expect(hung).rejects.toMatchObject({ code: 'MAILBOX_OP_TIMEOUT' });
    expect(clients[0].close).toHaveBeenCalled();
    await expect(next).resolves.toBe('next');
  });
});

describe('appendSent', () => {
  test('never retries once APPEND was issued (no duplicate Sent copies)', async () => {
    const { factory, clients } = makeFactory({ append: jest.fn(async () => { throw connErr(); }) });
    setClientFactoryForTests(factory);
    await expect(mailbox.appendSent('info@opsfloa.com', { from: 'a', to: 'b', subject: 's', text: 't' })).rejects.toMatchObject({ code: 'NoConnection' });
    const appends = clients.reduce((n, c) => n + c.append.mock.calls.length, 0);
    expect(appends).toBe(1);
  });

  test('retries a connection failure that happened before APPEND, appending the same bytes once', async () => {
    let first = true;
    const { factory, clients } = makeFactory({
      mailboxCreate: jest.fn(async () => { if (first) { first = false; throw connErr(); } }),
    });
    setClientFactoryForTests(factory);
    await mailbox.appendSent('info@opsfloa.com', { from: 'a', to: 'b', subject: 's', text: 't' });
    const appends = clients.flatMap(c => c.append.mock.calls);
    expect(appends).toHaveLength(1);
    expect(appends[0][0]).toBe('OpsFloaMail/info/Sent');
  });
});
