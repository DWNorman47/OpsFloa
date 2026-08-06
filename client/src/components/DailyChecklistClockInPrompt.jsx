import React, { useState, useId } from 'react';
import { useNavigate } from 'react-router-dom';
import ModalShell from './ModalShell';
import { useT } from '../hooks/useT';

/**
 * Post-clock-in nudge: offer to open the daily checklist for a project. One candidate → a
 * simple confirm; several → a project dropdown so the worker picks where they are.
 * `candidates` = [{ project_id, project_name, status: 'active' | 'startable' }].
 * `onClose` is called on dismiss and after navigating.
 */
export default function DailyChecklistClockInPrompt({ candidates, onClose }) {
  const t = useT();
  const navigate = useNavigate();
  const titleId = useId();
  const [pick, setPick] = useState(candidates[0]?.project_id ?? '');
  const many = candidates.length > 1;
  const single = candidates[0];
  if (!single) return null;

  const open = () => {
    const pid = many ? Number(pick) : single.project_id;
    if (pid) navigate(`/field?project=${pid}#checklist-daily`);
    onClose();
  };
  const suffix = c => (c.status === 'startable' ? ` · ${t.dcPromptNotStarted}` : '');

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <ModalShell onClose={onClose} titleId={titleId} style={s.modal}>
        <h3 id={titleId} style={s.title}>{t.dcPromptTitle}</h3>
        {many ? (
          <>
            <p style={s.body}>{t.dcPromptBodyMany}</p>
            <select style={s.select} value={pick} onChange={e => setPick(e.target.value)}>
              {candidates.map(c => (
                <option key={c.project_id} value={c.project_id}>{c.project_name}{suffix(c)}</option>
              ))}
            </select>
          </>
        ) : (
          <p style={s.body}>{t.dcPromptBody.replace('{project}', single.project_name)}{single.status === 'startable' ? ` (${t.dcPromptNotStarted})` : ''}</p>
        )}
        <div style={s.btnRow}>
          <button style={s.cancel} onClick={onClose}>{t.dcPromptNotNow}</button>
          <button style={s.confirm} onClick={open} autoFocus>{t.dcPromptOpen}</button>
        </div>
      </ModalShell>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 16 },
  modal: { background: '#fff', borderRadius: 10, padding: 24, maxWidth: 420, width: '100%', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' },
  title: { fontSize: 17, fontWeight: 700, margin: '0 0 8px', color: '#111827' },
  body: { fontSize: 14, color: '#4b5563', margin: '0 0 14px', lineHeight: 1.5 },
  select: { width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, marginBottom: 4 },
  btnRow: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 },
  cancel: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  confirm: { background: '#2563eb', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};
