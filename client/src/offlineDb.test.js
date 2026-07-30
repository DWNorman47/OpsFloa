import { beforeEach, describe, expect, test, vi } from 'vitest';

const stores = new Map();
let nextId = 1;

function store(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

vi.mock('idb', () => ({
  openDB: vi.fn(async () => ({
    objectStoreNames: { contains: () => true },
    add: async (name, value) => {
      const id = nextId++;
      store(name).set(id, { ...value, id });
      return id;
    },
    getAll: async name => [...store(name).values()],
    getAllKeys: async name => [...store(name).keys()],
    get: async (name, key) => store(name).get(key),
    put: async (name, value, key) => store(name).set(key, value),
    delete: async (name, key) => store(name).delete(key),
    clear: async name => store(name).clear(),
  })),
}));

import {
  clearCache,
  clearPendingSyncs,
  currentOfflineScope,
  enqueuePendingSync,
  getCached,
  getPendingSyncs,
  removePendingSync,
  setCached,
} from './offlineDb';

function signIn(id, companyId = 'co-1') {
  window.sessionStorage.clear();
  window.localStorage.setItem('tc_token', `token-${id}`);
  window.localStorage.setItem('tc_user', JSON.stringify({ id, company_id: companyId }));
}

describe('offlineDb account scoping', () => {
  beforeEach(async () => {
    stores.clear();
    nextId = 1;
    window.localStorage.clear();
    window.sessionStorage.clear();
    await clearCache();
    await clearPendingSyncs();
  });

  test('isolates API cache records by company and user', async () => {
    signIn(7);
    expect(currentOfflineScope()).toBe('co-1:7');
    await setCached('entries', ['worker-7']);

    signIn(8);
    expect(await getCached('entries')).toBeUndefined();
    await setCached('entries', ['worker-8']);

    signIn(7);
    expect((await getCached('entries')).data).toEqual(['worker-7']);
  });

  test('only exposes and removes pending submissions in the active account scope', async () => {
    signIn(7);
    await enqueuePendingSync({ count_id: 10, line_id: 20 });
    const [workerSevenItem] = await getPendingSyncs();

    signIn(8);
    expect(await getPendingSyncs()).toEqual([]);
    await removePendingSync(workerSevenItem.id);

    signIn(7);
    expect(await getPendingSyncs()).toHaveLength(1);
    await removePendingSync(workerSevenItem.id);
    expect(await getPendingSyncs()).toEqual([]);
  });

  test('prefers an impersonation tab session over the origin-wide local session', () => {
    signIn(7, 'co-owner');
    window.sessionStorage.setItem('tc_token', 'impersonation');
    window.sessionStorage.setItem('tc_user', JSON.stringify({ id: 22, company_id: 'co-target' }));
    expect(currentOfflineScope()).toBe('co-target:22');
  });
});
