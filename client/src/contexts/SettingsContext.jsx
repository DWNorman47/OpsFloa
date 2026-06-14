import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';

/**
 * Company-wide settings (the merged response from GET /api/settings, which
 * every authenticated user can call). Loaded once per session so any component
 * — most importantly the AppHeader / AppSwitcher — can read the module_* and
 * feature_* flags without each page having to fetch settings and thread them
 * down as props. Pages that already hold their own settings copy still pass it
 * explicitly; this context is the fallback so the switcher gates correctly
 * everywhere, including pages that don't load settings themselves.
 */
export const SettingsContext = createContext({ settings: null, loading: true, refresh: () => {}, setSettings: () => {} });

export function SettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setSettings(null); setLoading(false); return; }
    setLoading(true);
    try {
      const { data } = await api.get('/settings');
      setSettings(data);
    } catch {
      // Non-fatal: leave settings null. The switcher treats unknown flags as
      // visible, so a failed load degrades to "show everything" rather than
      // hiding modules the user actually has.
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Refetch whenever the authenticated user changes (login, logout, impersonation).
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh, setSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export const useSettings = () => useContext(SettingsContext);
