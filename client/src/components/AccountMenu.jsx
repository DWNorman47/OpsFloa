/**
 * Account menu in the app header: a circular avatar (user initials, tinted to the
 * current app accent) that opens a dropdown of the header utilities —
 * Refresh, Language (EN/ES), Guide, and Logout — instead of a row of buttons.
 *
 * `onOpenGuide` is called to open the GuideDrawer (which lives in AppHeader).
 */

import React, { useState, useRef, useEffect } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { silentError } from '../errorReporter';

function initialsOf(name, fallback) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map(w => w[0]);
  const out = letters.join('').toUpperCase();
  return out || String(fallback || '?').slice(0, 1).toUpperCase() || '?';
}

export default function AccountMenu({ onOpenGuide }) {
  const { user, logout, updateUser } = useAuth();
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const changeLang = async lang => {
    setOpen(false);
    if ((user?.language || 'English') === lang) return;
    try {
      await api.post('/auth/update-language', { language: lang }, { suppressToast: true });
      updateUser({ language: lang });
    } catch (err) { silentError('update-language')(err); }
  };

  const lang = user?.language || 'English';
  const initials = initialsOf(user?.full_name, user?.username);

  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className="account-menu-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.full_name || t.account || 'Account'}
        aria-label={user?.full_name || t.account || 'Account'}
      >
        {initials}
      </button>
      {open && (
        <div className="account-menu-dropdown" role="menu">
          <button type="button" role="menuitem" className="account-menu-item" onClick={() => { setOpen(false); window.location.reload(); }}>
            <span className="ami-icon" aria-hidden="true">↻</span>{t.refresh || 'Refresh'}
          </button>

          <div className="account-menu-label">{t.languageAria || 'Language'}</div>
          <button type="button" role="menuitemradio" aria-checked={lang === 'English'} className={`account-menu-item${lang === 'English' ? ' is-active' : ''}`} onClick={() => changeLang('English')}>
            <span className="ami-icon" aria-hidden="true">🌐</span>English{lang === 'English' && <span className="ami-check" aria-hidden="true">✓</span>}
          </button>
          <button type="button" role="menuitemradio" aria-checked={lang === 'Spanish'} className={`account-menu-item${lang === 'Spanish' ? ' is-active' : ''}`} onClick={() => changeLang('Spanish')}>
            <span className="ami-icon" aria-hidden="true">🌐</span>Español{lang === 'Spanish' && <span className="ami-check" aria-hidden="true">✓</span>}
          </button>

          <div className="account-menu-divider" />
          <button type="button" role="menuitem" className="account-menu-item" onClick={() => { setOpen(false); onOpenGuide?.(); }}>
            <span className="ami-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                <path d="M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z" />
                <path d="m12.9 7.1-1.4 4.4-4.4 1.4 1.4-4.4 4.4-1.4z" />
              </svg>
            </span>{t.guideButton || 'Guide'}
          </button>
          <button type="button" role="menuitem" className="account-menu-item is-logout" onClick={() => { setOpen(false); logout(); }}>
            <span className="ami-icon" aria-hidden="true">⎋</span>{t.logout || 'Log out'}
          </button>
        </div>
      )}
    </div>
  );
}
