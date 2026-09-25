/**
 * Plan Room live sync — sessionPush batching + rejected-push handling.
 *
 * The bug: one edit producing > 20,000 ops (server cap, planDocValidate LIMITS.ops) was
 * POSTed as a single batch, rejected with 400 every time, and re-sent on every tick
 * forever while the live bar kept saying "Live". Now the diff is chunked under the cap, and
 * a 400 surfaces a persistent error and resyncs from the server instead of retrying.
 *
 * The push code is lifted verbatim from planroom/app.js so the test guards the real code.
 */
const fs = require('fs');
const path = require('path');
const { validateOps, LIMITS } = require('../utils/planDocValidate');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'client', 'public', 'tool-apps', 'planroom', 'app.js'), 'utf8');

function lift(env) {
  const start = SRC.indexOf('// Server-side caps on one POST /live/:id/op');
  const end = SRC.indexOf('function applyStream(msg) {');
  if (start < 0 || end < start) throw new Error('live push block not found');
  // eslint-disable-next-line no-new-func
  return new Function(
    'state', 'apiLive', 'sessionDoc', 'applyStream', 'refreshLiveStatus', 'sessionSyncSoon',
    'sessionStorage', 'localStorage',
    `let session = null;\n${SRC.slice(start, end)}\n` +
    'return { setSession: v => { session = v; }, sessionPush, chunkLiveOps, LIVE_OP_CAP };',
  )(env.state, env.apiLive, env.sessionDoc, env.applyStream, env.refreshLiveStatus, env.sessionSyncSoon,
    env.storage, env.storage);
}

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function setup({ markups = [], lastSyncIds = [], opStatus = () => 200, getResult = () => res(200, { objects: [], doc: {} }) } = {}) {
  const env = {
    state: { markups },
    sessionDoc: () => ({ scales: {} }),
    refreshLiveStatus: jest.fn(),
    sessionSyncSoon: jest.fn(),
    storage: { getItem: () => null },
    posts: [],
    gets: 0,
  };
  let session;
  env.applyStream = jest.fn(msg => {
    // Mirrors applyStream('init'): state becomes the server copy, baseline follows it.
    env.state.markups = msg.objects || [];
    session.lastSync = new Map(env.state.markups.map(m => [m.id, JSON.stringify(m)]));
    session.docHash = JSON.stringify(env.sessionDoc());
  });
  env.apiLive = jest.fn(async (p, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      env.posts.push(body);
      const st = opStatus(body, env.posts.length);
      return st instanceof Error ? Promise.reject(st) : res(st, { ok: true });
    }
    env.gets++;
    return getResult(env.gets);
  });
  const api = lift(env);
  session = {
    id: 's1', clientId: 'c1',
    lastSync: new Map(lastSyncIds.map(id => [id, '{}'])),
    docHash: JSON.stringify(env.sessionDoc()),
  };
  api.setSession(session);
  return { env, api, session };
}

const ids = n => Array.from({ length: n }, (_, i) => `m${i}`);

test('the client cap matches the server cap', () => {
  const { api } = setup();
  expect(api.LIVE_OP_CAP).toBe(LIMITS.ops);
});

test('an edit producing > 20,000 ops is sent in server-valid batches, doc only once', async () => {
  const { env, api, session } = setup({ lastSyncIds: ids(45000) }); // bulk delete of 45k markups
  session.docHash = 'stale'; // doc changed too
  await api.sessionPush();
  expect(env.posts.map(p => p.ops.length)).toEqual([20000, 20000, 5000]);
  for (const p of env.posts) expect(validateOps(p.ops)).toBeNull();
  expect(env.posts.filter(p => p.doc).length).toBe(1);
  expect(session.lastSync.size).toBe(0);
  expect(session.syncError).toBeFalsy();
  // Nothing left to send.
  await api.sessionPush();
  expect(env.posts).toHaveLength(3);
});

test('a transient failure mid-way re-sends only the remaining batches', async () => {
  const { env, api, session } = setup({ lastSyncIds: ids(30000), opStatus: (_b, n) => (n === 2 ? 503 : 200) });
  await api.sessionPush();
  expect(session.lastSync.size).toBe(10000); // first batch committed
  await api.sessionPush();
  expect(env.posts.map(p => p.ops.length)).toEqual([20000, 10000, 10000]);
  expect(session.lastSync.size).toBe(0);
});

test('a 400 shows a persistent error and resyncs from the server — never re-sends the batch', async () => {
  const server = [{ id: 'keep', kind: 'count' }];
  const { env, api, session } = setup({
    markups: [{ id: 'bad', kind: 'x' }],
    opStatus: () => 400,
    getResult: () => res(200, { objects: server, doc: {} }),
  });
  await api.sessionPush();
  expect(env.posts).toHaveLength(1);
  expect(session.syncError).toMatch(/Sync error/);
  expect(env.applyStream).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', objects: server }));
  expect(env.state.markups).toEqual(server);
  // Subsequent ticks: nothing to push (state == server), and the error stays up.
  await api.sessionPush();
  await api.sessionPush();
  expect(env.posts).toHaveLength(1);
  expect(session.syncError).toMatch(/Sync error/);
});

test('if the resync fetch fails, the next tick retries the resync, not the rejected diff', async () => {
  const { env, api, session } = setup({
    markups: [{ id: 'bad', kind: 'x' }],
    opStatus: () => 400,
    getResult: n => (n === 1 ? res(503, {}) : res(200, { objects: [], doc: {} })),
  });
  await api.sessionPush();
  expect(session.needsResync).toBe(true);
  await api.sessionPush();
  expect(env.posts).toHaveLength(1);
  expect(env.gets).toBe(2);
  expect(session.needsResync).toBe(false);
  expect(env.state.markups).toEqual([]);
});

test('the error clears on the next successful push', async () => {
  let reject = true;
  const { env, api, session } = setup({
    markups: [{ id: 'a' }],
    opStatus: () => (reject ? 400 : 200),
    getResult: () => res(200, { objects: [], doc: {} }),
  });
  await api.sessionPush();
  expect(session.syncError).toBeTruthy();
  reject = false;
  env.state.markups = [{ id: 'b' }];
  await api.sessionPush();
  expect(session.syncError).toBeNull();
});

test('the error text follows the OpsFloa user language', async () => {
  const { env, api, session } = setup({ markups: [{ id: 'a' }], opStatus: () => 400 });
  env.storage.getItem = k => (k === 'tc_user' ? JSON.stringify({ language: 'Spanish' }) : null);
  await api.sessionPush();
  expect(session.syncError).toMatch(/Error de sincronización/);
});
