import { useAuth } from '../contexts/AuthContext';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';

export function useT() {
  const { user } = useAuth();
  // Logged-in users carry an explicit language; anonymous contexts fall back to
  // the browser's preferred language instead of always defaulting to English.
  return getT(detectLanguage(user?.language));
}
