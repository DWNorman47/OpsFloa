import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../api';
import { clearCache, clearPendingSyncs, currentOfflineScope } from '../offlineDb';
import { safeSession, safeLocal } from '../utils/safeStorage';

export const AuthContext = createContext(null);

function clearOfflineQueue() {
  if (!('serviceWorker' in navigator)) return;
  const scope = currentOfflineScope();
  navigator.serviceWorker.ready
    .then(reg => reg.active?.postMessage({ type: 'CLEAR_QUEUE', scope }))
    .catch(() => {});
}

function readCachedUser(tokenStore) {
  const cached = tokenStore.getItem('tc_user');
  if (!cached) return null;
  try {
    return JSON.parse(cached);
  } catch {
    return null;
  }
}

function isAuthFailure(err) {
  const status = err?.response?.status;
  return status === 401 || status === 403;
}

function storeSession(tokenStore, token, user) {
  tokenStore.setItem('tc_token', token);
  if (user) tokenStore.setItem('tc_user', JSON.stringify(user));
}

function clearStoredSession(tokenStore) {
  tokenStore.removeItem('tc_token');
  tokenStore.removeItem('tc_user');
}

export function AuthProvider({ children }) {
  // Seed from the cached session synchronously. Without this, `user` is null until
  // /auth/me resolves (up to 10s), and the effect below blanks `tc_addons` for that
  // whole window — which shows Takeoff as locked in the Plan Room tool-app (it reads
  // tc_addons from localStorage). /auth/me still refreshes the user right after.
  const [user, setUser] = useState(() => {
    try {
      const store = safeSession.getItem('tc_token') ? safeSession : safeLocal;
      if (!store.getItem('tc_token')) return null;
      const cached = store.getItem('tc_user');
      return cached ? JSON.parse(cached) : null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(true);
  const [firstLogin, setFirstLogin] = useState(false);

  useEffect(() => {
    // sessionStorage takes precedence: impersonation tabs have their own
    // tab-scoped token + user cache so they don't pollute the super admin's
    // localStorage in the original tab.
    const isImpersonation = !!safeSession.getItem('tc_token');
    const tokenStore = isImpersonation ? safeSession : safeLocal;
    const token = tokenStore.getItem('tc_token');
    if (!token) { setLoading(false); return; }

    // If offline, use cached user so the app works without a network round-trip
    if (!navigator.onLine) {
      const cached = readCachedUser(tokenStore);
      if (cached) setUser(cached);
      setLoading(false);
      return;
    }

    api.get('/auth/me', { timeout: 10000 })
      .then(r => { setUser(r.data.user); tokenStore.setItem('tc_user', JSON.stringify(r.data.user)); })
      .catch(err => {
        if (isAuthFailure(err)) {
          clearStoredSession(tokenStore);
          setUser(null); // token is dead — drop the cache-seeded user so we reflect logout
          return;
        }
        const cached = readCachedUser(tokenStore);
        if (cached) setUser(cached);
      })
      .finally(() => setLoading(false));
  }, []);

  // Expose entitlement flags to the static tool-apps — they read localStorage,
  // not React context. Kept in sync as the user loads / add-ons toggle (via
  // updateUser). The takeoff layer inside Plan Room gates on tc_addons.
  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem('tc_addons', JSON.stringify({
          takeoff: !!user.addon_takeoff,
          planroom: !!user.addon_planroom,
          storm: !!user.addon_storm,
          roof: !!user.addon_roof,
          status: user.subscription_status || null,
        }));
        if (user.company_name) localStorage.setItem('tc_company', user.company_name);
        else localStorage.removeItem('tc_company');
      } else if (!loading) {
        // Only clear on a genuine logout — NOT during the /auth/me validation window
        // (user null, still loading), where blanking tc_addons momentarily locks
        // Takeoff in an open Plan Room tab.
        localStorage.removeItem('tc_addons');
        localStorage.removeItem('tc_company');
      }
    } catch { /* storage blocked */ }
  }, [user, loading]);

  // Sliding session: while a real login is open and in the foreground, periodically
  // re-issue the token so an actively-used app never gets bounced to login mid-day. The
  // token itself is the idle window — stop refreshing (go idle/backgrounded) and it
  // lapses on its own, logging them out. Impersonation tabs (session-scoped token) are
  // deliberately excluded — those must stay short-lived and not slide.
  useEffect(() => {
    if (!user) return;
    if (safeSession.getItem('tc_token')) return; // impersonation — never slide
    let last = 0;
    const MIN_GAP = 15 * 60 * 1000; // slide at most every 15 min
    const slide = async () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      if (Date.now() - last < MIN_GAP) return;
      last = Date.now();
      try {
        const r = await api.post('/auth/refresh', {}, { suppressToast: true });
        if (r.data?.token) safeLocal.setItem('tc_token', r.data.token);
      } catch { /* expired (idle) or past the 7-day cap → the 401 interceptor sends to login */ }
    };
    slide(); // slide on open, so a same-day return keeps rolling the window forward
    const iv = setInterval(slide, 5 * 60 * 1000);
    const onVisible = () => slide();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [user]);

  const login = async (username, password, company_name) => {
    await Promise.all([clearCache(), clearPendingSyncs()]);
    clearOfflineQueue();
    const r = await api.post('/auth/login', { username, password, company_name }, { suppressToast: true });
    if (r.data.mfa_required) {
      return { mfa_required: true, mfa_token: r.data.mfa_token };
    }
    if (r.data.must_change_password) {
      return { must_change_password: true, setup_token: r.data.setup_token };
    }
    storeSession(safeLocal, r.data.token, r.data.user);
    setUser(r.data.user);
    if (r.data.first_login) setFirstLogin(true);
    return r.data.user;
  };

  const loginWithToken = async token => {
    await Promise.all([clearCache(), clearPendingSyncs()]);
    clearOfflineQueue();
    safeLocal.setItem('tc_token', token);
    const me = await api.get('/auth/me');
    safeLocal.setItem('tc_user', JSON.stringify(me.data.user));
    setUser(me.data.user);
    setFirstLogin(true); // registration always counts as first login
    return me.data.user;
  };

  const confirmMfa = async (mfa_token, code) => {
    await Promise.all([clearCache(), clearPendingSyncs()]);
    clearOfflineQueue();
    const r = await api.post('/auth/mfa/confirm', { mfa_token, code });
    storeSession(safeLocal, r.data.token, r.data.user);
    setUser(r.data.user);
    return r.data.user;
  };

  const logout = () => {
    clearCache();
    clearPendingSyncs();
    clearOfflineQueue();
    // Clear both stores so an impersonation tab logging out doesn't leave
    // the super admin's localStorage token alive for a future page load,
    // and a normal logout clears any stray sessionStorage too.
    safeLocal.removeItem('tc_token');
    safeLocal.removeItem('tc_user');
    safeSession.removeItem('tc_token');
    safeSession.removeItem('tc_user');
    // Drop the cached clocked-in flag so a fresh login starts on the personal
    // clock, not Workforce (Dashboard re-sets it once clock status loads).
    safeLocal.removeItem('tc_clocked_in');
    setUser(null);
    setFirstLogin(false);
  };

  const updateUser = patch => setUser(u => {
    if (!u) return u;
    const next = { ...u, ...patch };
    // Persist the merged user to the active token store. Without this, updateUser
    // touched only React state, so a cleared flag (e.g. needs_terms after accepting
    // the Terms) was lost on reload — the stale tc_user cache (used on offline /
    // /auth/me-failure bootstraps) kept re-showing the clickwrap gate every time.
    try {
      const store = safeSession.getItem('tc_token') ? safeSession : safeLocal;
      store.setItem('tc_user', JSON.stringify(next));
    } catch { /* storage blocked */ }
    return next;
  });
  const clearFirstLogin = () => setFirstLogin(false);

  return (
    <AuthContext.Provider value={{ user, loading, login, loginWithToken, confirmMfa, logout, updateUser, firstLogin, clearFirstLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
