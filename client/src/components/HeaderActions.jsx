/**
 * Shared header actions for admin pages: Refresh button + language switcher.
 * Meant to slot into each admin page's header-right row so the set of
 * buttons stays consistent across Administration, Projects, Analytics,
 * Inventory, Team, and the Time Clock admin dashboard.
 */

import React from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { loadLanguage } from '../i18n';
import { silentError } from '../errorReporter';

export function RefreshButton({ title }) {
  const t = useT();
  const label = title || t.refresh || 'Refresh';
  return (
    <button
      type="button"
      className="header-btn"
      style={styles.refreshBtn}
      title={label}
      aria-label={label}
      onClick={() => window.location.reload()}
    >
      ↻
    </button>
  );
}

export function LanguageSwitcher() {
  const { user, updateUser } = useAuth();
  const t = useT();
  const change = async lang => {
    try {
      await api.post('/auth/update-language', { language: lang }, { suppressToast: true });
      // Fetch the dictionary first so the UI flips straight to the new language.
      await loadLanguage(lang).catch(() => {});
      updateUser({ language: lang });
    } catch (err) { silentError('update-language')(err); }
  };
  return (
    <select
      style={styles.langSelect}
      className="header-lang"
      value={user?.language || 'English'}
      onChange={e => change(e.target.value)}
      aria-label={t.languageAria || 'Language'}
    >
      <option value="English" style={{ color: '#111827', background: '#fff' }}>EN</option>
      <option value="Spanish" style={{ color: '#111827', background: '#fff' }}>ES</option>
    </select>
  );
}

const styles = {
  refreshBtn: {
    background: '#f8fafc', color: '#334155', border: '1px solid #cbd5e1',
    padding: '6px 10px', borderRadius: 7, fontSize: 15, fontWeight: 700, cursor: 'pointer',
    lineHeight: 1,
  },
  langSelect: {
    background: '#f8fafc', color: '#334155',
    border: '1px solid #cbd5e1', borderRadius: 7,
    padding: '4px 6px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
};
