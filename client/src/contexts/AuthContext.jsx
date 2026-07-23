import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../api';
import { clearCache } from '../offlineDb';
import { safeSession, safeLocal } from '../utils/safeStorage';

export const AuthContext = createContext(null);

function clearOfflineQueue() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then(reg => reg.active?.postMessage({ type: 'CLEAR_QUEUE' }))
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
  const [user, setUser] = useState(null);
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
      } else {
        localStorage.removeItem('tc_addons');
      }
    } catch { /* storage blocked */ }
  }, [user]);

  const login = async (username, password, company_name) => {
    await clearCache();
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
    await clearCache();
    clearOfflineQueue();
    safeLocal.setItem('tc_token', token);
    const me = await api.get('/auth/me');
    safeLocal.setItem('tc_user', JSON.stringify(me.data.user));
    setUser(me.data.user);
    setFirstLogin(true); // registration always counts as first login
    return me.data.user;
  };

  const confirmMfa = async (mfa_token, code) => {
    await clearCache();
    clearOfflineQueue();
    const r = await api.post('/auth/mfa/confirm', { mfa_token, code });
    storeSession(safeLocal, r.data.token, r.data.user);
    setUser(r.data.user);
    return r.data.user;
  };

  const logout = () => {
    clearCache();
    clearOfflineQueue();
    // Clear both stores so an impersonation tab logging out doesn't leave
    // the super admin's localStorage token alive for a future page load,
    // and a normal logout clears any stray sessionStorage too.
    safeLocal.removeItem('tc_token');
    safeLocal.removeItem('tc_user');
    safeSession.removeItem('tc_token');
    safeSession.removeItem('tc_user');
    setUser(null);
    setFirstLogin(false);
  };

  const updateUser = patch => setUser(u => ({ ...u, ...patch }));
  const clearFirstLogin = () => setFirstLogin(false);

  return (
    <AuthContext.Provider value={{ user, loading, login, loginWithToken, confirmMfa, logout, updateUser, firstLogin, clearFirstLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
