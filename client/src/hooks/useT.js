import { useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getT, subscribeLanguages, getLanguagesVersion } from '../i18n';
import { detectLanguage } from '../languageDetect';

/**
 * Dictionary for an explicit language ('English' | 'Spanish'). Dictionaries are
 * lazy-loaded per language (see i18n.js); if this one isn't loaded yet, getT()
 * returns the loaded one meanwhile and this re-renders when it arrives.
 */
export function useTFor(language) {
  useSyncExternalStore(subscribeLanguages, getLanguagesVersion);
  return getT(language);
}

export function useT() {
  const { user } = useAuth();
  // Logged-in users carry an explicit language; anonymous contexts fall back to
  // the browser's preferred language instead of always defaulting to English.
  return useTFor(detectLanguage(user?.language));
}
