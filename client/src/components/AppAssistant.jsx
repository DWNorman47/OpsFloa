import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { assistantStrings } from './appAssistantStrings';
import './AppAssistant.css';

export const ASSISTANT_OPEN_EVENT = 'opsfloa:assistant-open';

function SparkIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3z" />
      <path d="M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export function openAppAssistant() {
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT));
}

function validActionTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}

function actionTimeSeconds(value) {
  if (!validActionTime(value)) return null;
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  return (hours * 3600) + (minutes * 60) + seconds;
}

function validActionDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validActionVersion(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function validSplitSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 10) return false;
  let firstStart = null;
  let previousEnd = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false;
    const keys = Object.keys(segment);
    if (keys.length !== 3 || !keys.every(key => ['start_time', 'end_time', 'project_id'].includes(key))) return false;
    const startOfDay = actionTimeSeconds(segment.start_time);
    const endOfDay = actionTimeSeconds(segment.end_time);
    if (startOfDay == null || endOfDay == null) return false;
    if (segment.project_id !== null && (!Number.isInteger(segment.project_id) || segment.project_id <= 0)) return false;
    if (index > 0 && startOfDay !== previousEnd % (24 * 60 * 60)) return false;

    const effectiveStart = previousEnd == null ? startOfDay : previousEnd;
    let effectiveEnd = (Math.floor(effectiveStart / (24 * 60 * 60)) * 24 * 60 * 60) + endOfDay;
    if (effectiveEnd <= effectiveStart) effectiveEnd += 24 * 60 * 60;
    if (firstStart == null) firstStart = effectiveStart;
    previousEnd = effectiveEnd;
  }
  return previousEnd > firstStart && previousEnd - firstStart <= 24 * 60 * 60;
}

const REIMBURSEMENT_ACTION_ENDPOINT = /^\/reimbursements\/admin\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHIFT_ACTION_ENDPOINT = /^\/shifts\/admin\/[1-9]\d{0,9}$/;
const SHIFT_SERIES_ACTION_ENDPOINT = /^\/shifts\/admin\/series\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validReimbursementActionBody(body, expectedStatus, reasonRequired) {
  const keys = Object.keys(body);
  if (keys.length !== 3 || !keys.every(key => ['status', 'admin_notes', 'updated_at'].includes(key))) return false;
  if (body.status !== expectedStatus) return false;
  if (body.admin_notes !== null && (typeof body.admin_notes !== 'string' || body.admin_notes.length > 1000)) return false;
  if (reasonRequired && (typeof body.admin_notes !== 'string' || body.admin_notes.trim().length < 2)) return false;
  return validActionVersion(body.updated_at);
}

function validShiftActionBody(body, { includeWorker = false, includeVersion = false } = {}) {
  const required = ['project_id', 'shift_date', 'start_time', 'end_time', 'notes'];
  if (includeWorker) required.push('user_id');
  if (includeVersion) required.push('updated_at');
  const keys = Object.keys(body);
  if (keys.length !== required.length || !keys.every(key => required.includes(key))) return false;
  if (includeWorker && (!Number.isInteger(body.user_id) || body.user_id <= 0)) return false;
  if (body.project_id !== null && (!Number.isInteger(body.project_id) || body.project_id <= 0)) return false;
  if (!validActionDate(body.shift_date) || !validActionTime(body.start_time) || !validActionTime(body.end_time)) return false;
  if (actionTimeSeconds(body.start_time) === actionTimeSeconds(body.end_time)) return false;
  if (body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > 500)) return false;
  return !includeVersion || validActionVersion(body.updated_at);
}

function validShiftSeriesActionBody(body) {
  const required = ['user_id', 'project_id', 'dates', 'start_time', 'end_time', 'notes'];
  const keys = Object.keys(body);
  if (keys.length !== required.length || !keys.every(key => required.includes(key))) return false;
  if (!Number.isInteger(body.user_id) || body.user_id <= 0) return false;
  if (body.project_id !== null && (!Number.isInteger(body.project_id) || body.project_id <= 0)) return false;
  if (!Array.isArray(body.dates) || body.dates.length < 2 || body.dates.length > 12 || !body.dates.every(validActionDate)) return false;
  if (new Set(body.dates).size !== body.dates.length || body.dates.some((date, index) => index > 0 && date <= body.dates[index - 1])) return false;
  if (!validActionTime(body.start_time) || !validActionTime(body.end_time) || actionTimeSeconds(body.start_time) === actionTimeSeconds(body.end_time)) return false;
  return body.notes === null || (typeof body.notes === 'string' && body.notes.length <= 500);
}

export function isAllowedAssistantAction(action) {
  if (!action || action.type !== 'confirm_api') return false;
  const method = String(action.method || '').toLowerCase();
  const body = action.body && typeof action.body === 'object' && !Array.isArray(action.body) ? action.body : {};
  if (action.kind === 'time_entry_approval' && method === 'patch' && /^\/admin\/entries\/[1-9]\d*\/approve$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    return keys.every(key => key === 'note') && (body.note == null || (typeof body.note === 'string' && body.note.length <= 500));
  }
  if (action.kind === 'time_entry_approval' && method === 'post' && action.endpoint === '/admin/entries/bulk-approve') {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === 'ids' && Array.isArray(body.ids) &&
      body.ids.length >= 1 && body.ids.length <= 20 && body.ids.every(id => Number.isInteger(id) && id > 0);
  }
  if (action.kind === 'time_entry_rejection' && method === 'patch' && /^\/admin\/entries\/[1-9]\d*\/reject$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === 'note' && typeof body.note === 'string' &&
      body.note.trim().length >= 2 && body.note.length <= 500;
  }
  if (action.kind === 'time_entry_unapproval' && method === 'patch' && /^\/admin\/entries\/[1-9]\d*\/unapprove$/.test(action.endpoint || '')) {
    return Object.keys(body).length === 0;
  }
  if (action.kind === 'time_entry_restore' && method === 'patch' && /^\/admin\/entries\/[1-9]\d*\/unreject$/.test(action.endpoint || '')) {
    return Object.keys(body).length === 0;
  }
  if (action.kind === 'time_entry_split' && method === 'post' && /^\/admin\/entries\/[1-9]\d*\/split$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === 'segments' && validSplitSegments(body.segments);
  }
  if (action.kind === 'time_entry_edit' && method === 'patch' && /^\/admin\/entries\/[1-9]\d*\/edit$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    const allowed = new Set(['start_time', 'end_time', 'updated_at', 'work_date', 'project_id']);
    return keys.every(key => allowed.has(key)) &&
      keys.includes('start_time') && keys.includes('end_time') && keys.includes('updated_at') &&
      validActionTime(body.start_time) && validActionTime(body.end_time) &&
      validActionVersion(body.updated_at) &&
      (!keys.includes('work_date') || validActionDate(body.work_date)) &&
      (!keys.includes('project_id') || body.project_id === null || (Number.isInteger(body.project_id) && body.project_id > 0));
  }
  if (action.kind === 'time_off_approval' && method === 'patch' && /^\/time-off\/[1-9]\d{0,9}\/approve$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    return keys.every(key => ['review_note', 'confirm'].includes(key)) &&
      (!keys.includes('review_note') || (typeof body.review_note === 'string' && body.review_note.length <= 500)) &&
      (!keys.includes('confirm') || body.confirm === true);
  }
  if (action.kind === 'time_off_denial' && method === 'patch' && /^\/time-off\/[1-9]\d{0,9}\/deny$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === 'review_note' && typeof body.review_note === 'string' &&
      body.review_note.trim().length >= 2 && body.review_note.length <= 500;
  }
  if (action.kind === 'time_off_revocation' && method === 'patch' && /^\/time-off\/[1-9]\d{0,9}\/revoke$/.test(action.endpoint || '')) {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === 'reason' && typeof body.reason === 'string' &&
      body.reason.trim().length >= 2 && body.reason.length <= 500;
  }
  if (action.kind === 'reimbursement_approval' && method === 'patch' && REIMBURSEMENT_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return validReimbursementActionBody(body, 'approved', false);
  }
  if (action.kind === 'reimbursement_rejection' && method === 'patch' && REIMBURSEMENT_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return validReimbursementActionBody(body, 'rejected', true);
  }
  if (action.kind === 'reimbursement_restore' && method === 'patch' && REIMBURSEMENT_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return validReimbursementActionBody(body, 'pending', false);
  }
  if (action.kind === 'reimbursement_unapproval' && method === 'patch' && REIMBURSEMENT_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return validReimbursementActionBody(body, 'pending', true);
  }
  if (action.kind === 'shift_creation' && method === 'post' && action.endpoint === '/shifts/admin') {
    return validShiftActionBody(body, { includeWorker: true });
  }
  if (action.kind === 'shift_series_creation' && method === 'post' && action.endpoint === '/shifts/admin/series') {
    return validShiftSeriesActionBody(body);
  }
  if (action.kind === 'shift_edit' && method === 'patch' && SHIFT_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return validShiftActionBody(body, { includeVersion: true });
  }
  if (action.kind === 'shift_cancellation' && method === 'delete' && SHIFT_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return Object.keys(body).length === 0;
  }
  if (action.kind === 'shift_series_cancellation' && method === 'delete' && SHIFT_SERIES_ACTION_ENDPOINT.test(action.endpoint || '')) {
    return Object.keys(body).length === 0;
  }
  return false;
}

export default function AppAssistant() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const t = assistantStrings(user?.language);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const requestVersionRef = useRef(0);
  const pendingRef = useRef(false);
  const pendingActionsRef = useRef(new Set());

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(ASSISTANT_OPEN_EVENT, show);
    return () => window.removeEventListener(ASSISTANT_OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    requestVersionRef.current += 1;
    pendingRef.current = false;
    pendingActionsRef.current.clear();
    setOpen(false);
    setMessages([]);
    setDraft('');
    setError('');
  }, [user?.id]);

  if (!user || user.role === 'super_admin' || !open) return null;

  const go = action => {
    if (action?.type === 'navigate' && action.path) navigate(action.path);
  };

  const updateAction = (messageId, actionIndex, changes) => {
    setMessages(previous => previous.map(item => item.id !== messageId ? item : {
      ...item,
      actions: item.actions.map((action, index) => index === actionIndex ? { ...action, ...changes } : action),
    }));
  };

  const confirmAction = async (messageId, actionIndex, action) => {
    if (action.status === 'running' || action.status === 'completed') return;
    const pendingKey = `${messageId}:${actionIndex}`;
    if (pendingActionsRef.current.has(pendingKey)) return;
    if (!isAllowedAssistantAction(action)) {
      updateAction(messageId, actionIndex, { status: 'failed', result_message: t.actionFailed });
      return;
    }
    pendingActionsRef.current.add(pendingKey);
    updateAction(messageId, actionIndex, { status: 'running', result_message: '' });
    try {
      const method = String(action.method).toLowerCase();
      const response = method === 'patch'
        ? await api.patch(action.endpoint, action.body || {})
        : method === 'delete'
          ? await api.delete(action.endpoint)
          : await api.post(action.endpoint, action.body);
      let resultMessage = action.success_message || t.completed;
      if (action.endpoint === '/admin/entries/bulk-approve' && Number.isFinite(Number(response?.data?.approved))) {
        const approved = Number(response.data.approved);
        const skipped = Number(response.data.skipped_locked) || 0;
        resultMessage = t.approvedCount.replace('{n}', approved);
        if (skipped) resultMessage += ` ${t.skippedLockedCount.replace('{n}', skipped)}`;
      }
      updateAction(messageId, actionIndex, { status: 'completed', result_message: resultMessage });
      window.dispatchEvent(new CustomEvent('opsfloa:assistant-action-complete', { detail: { kind: action.kind } }));
    } catch (err) {
      updateAction(messageId, actionIndex, {
        status: 'failed',
        result_message: err?.response?.data?.error || t.actionFailed,
      });
    } finally {
      pendingActionsRef.current.delete(pendingKey);
    }
  };

  const send = async text => {
    const message = String(text || '').trim();
    if (!message || pendingRef.current) return;
    if (message.length > 2000) {
      setError(t.tooLong);
      return;
    }
    const history = messages.slice(-10).map(item => ({ role: item.role, content: item.content }));
    const requestVersion = requestVersionRef.current;
    pendingRef.current = true;
    setMessages(previous => [...previous, { id: `u-${Date.now()}`, role: 'user', content: message }]);
    setDraft('');
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/office/assistant', {
        message,
        history,
        context: { path: location.pathname, search: location.search, hash: location.hash },
      });
      if (requestVersion !== requestVersionRef.current) return;
      const actions = Array.isArray(data.actions) ? data.actions : [];
      setMessages(previous => [...previous, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.message || t.failed,
        actions,
      }]);
      if (actions[0]) go(actions[0]);
    } catch (err) {
      if (requestVersion === requestVersionRef.current) setError(err?.response?.data?.error || t.failed);
    } finally {
      if (requestVersion === requestVersionRef.current) {
        pendingRef.current = false;
        setBusy(false);
      }
    }
  };

  const submit = event => {
    event.preventDefault();
    send(draft);
  };

  return (
    <aside className="app-assistant" role="dialog" aria-modal="false" aria-label={t.title}>
      <header className="app-assistant-header">
        <SparkIcon />
        <div className="app-assistant-heading">
          <div className="app-assistant-title">{t.title}</div>
          <div className="app-assistant-subtitle">{t.subtitle}</div>
        </div>
        <button type="button" className="app-assistant-icon-button" disabled={busy} onClick={() => { requestVersionRef.current += 1; pendingRef.current = false; setMessages([]); setError(''); }} title={t.newChat} aria-label={t.newChat}>
          <NewChatIcon />
        </button>
        <button type="button" className="app-assistant-icon-button" onClick={() => setOpen(false)} title={t.close} aria-label={t.close}>
          <CloseIcon />
        </button>
      </header>

      <div className="app-assistant-messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="app-assistant-welcome">
            <div className="app-assistant-welcome-mark"><SparkIcon size={24} /></div>
            <strong>{t.welcome}</strong>
            <p>{t.privacy}</p>
            <div className="app-assistant-chips">
              {t.prompts.map(prompt => (
                <button key={prompt} type="button" className="app-assistant-chip" disabled={busy} onClick={() => send(prompt)}>{prompt}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map(item => (
          <div key={item.id} className={`app-assistant-message ${item.role}`}>
            <div className="app-assistant-bubble">
              {item.content}
              {item.actions?.length > 0 && (
                <div className="app-assistant-actions">
                  {item.actions.map((action, actionIndex) => action.type === 'navigate' ? (
                    <button key={`${action.type}-${action.path}`} type="button" className="app-assistant-action" onClick={() => go(action)}>{action.label}</button>
                  ) : action.type === 'confirm_api' ? (
                    <div key={`${action.type}-${action.kind}-${actionIndex}`} className="app-assistant-confirmation">
                      <strong>{action.title}</strong>
                      {action.summary && <p>{action.summary}</p>}
                      {action.details?.length > 0 && (
                        <ul>
                          {action.details.map((detail, detailIndex) => (
                            <li key={`${detail.worker}-${detail.date}-${detailIndex}`}>{[detail.worker, detail.date, detail.type, detail.time, detail.amount, detail.category, detail.project, detail.description, detail.notes].filter(Boolean).join(' | ')}</li>
                          ))}
                        </ul>
                      )}
                      {action.kind === 'time_entry_rejection' && typeof action.body?.note === 'string' && (
                        <p className="app-assistant-reason"><strong>{action.reason_label || 'Reason'}:</strong> {action.body.note}</p>
                      )}
                      {['time_off_denial', 'time_off_revocation'].includes(action.kind) && typeof action.reason === 'string' && (
                        <p className="app-assistant-reason"><strong>{action.reason_label || 'Reason'}:</strong> {action.reason}</p>
                      )}
                      {['reimbursement_rejection', 'reimbursement_unapproval'].includes(action.kind) && typeof action.reason === 'string' && (
                        <p className="app-assistant-reason"><strong>{action.reason_label || 'Reason'}:</strong> {action.reason}</p>
                      )}
                      {action.changes?.length > 0 && (
                        <dl className="app-assistant-changes">
                          {action.changes.map((change, changeIndex) => (
                            <div key={`${change.label}-${changeIndex}`}>
                              <dt>{change.label}</dt>
                              <dd><span>{change.before}</span><span className="app-assistant-change-to">to</span><strong>{change.after}</strong></dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {action.split_segments?.length > 0 && (
                        <ol className="app-assistant-split-segments">
                          {action.split_segments.map((segment, segmentIndex) => (
                            <li key={`${segment.label}-${segmentIndex}`}>
                              <strong>{segment.label}</strong>
                              <span>{segment.time}</span>
                              <span>{segment.project}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                      {action.result_message && (
                        <div className={`app-assistant-action-result ${action.status === 'failed' ? 'failed' : ''}`} role={action.status === 'failed' ? 'alert' : 'status'}>
                          {action.result_message}
                        </div>
                      )}
                      {!['completed', 'canceled'].includes(action.status) && (
                        <div className="app-assistant-confirm-buttons">
                          <button
                            type="button"
                            className={`app-assistant-confirm${action.danger === true || ['time_entry_rejection', 'time_entry_unapproval', 'time_off_denial', 'time_off_revocation', 'reimbursement_rejection', 'reimbursement_unapproval', 'shift_cancellation', 'shift_series_cancellation'].includes(action.kind) ? ' danger' : ''}`}
                            disabled={action.status === 'running'}
                            onClick={() => confirmAction(item.id, actionIndex, action)}
                          >
                            {action.status === 'running' ? t.working : (action.confirm_label || t.confirm)}
                          </button>
                          <button
                            type="button"
                            className="app-assistant-cancel"
                            disabled={action.status === 'running'}
                            onClick={() => updateAction(item.id, actionIndex, { status: 'canceled', result_message: t.canceled })}
                          >
                            {action.cancel_label || t.cancel}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null)}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="app-assistant-thinking">{t.thinking}</div>}
        {error && <div className="app-assistant-error" role="alert">{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="app-assistant-compose">
        <form className="app-assistant-form" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="app-assistant-input"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(event);
              }
            }}
            maxLength={2000}
            rows={1}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
          />
          <button type="submit" className="app-assistant-send" disabled={busy || !draft.trim()} title={t.send} aria-label={t.send}>
            <SendIcon />
          </button>
        </form>
      </div>
    </aside>
  );
}

export function AppAssistantLauncher() {
  const { user } = useAuth();
  const t = assistantStrings(user?.language);
  if (!user || user.role === 'super_admin') return null;
  return (
    <button type="button" className="app-assistant-launcher" onClick={openAppAssistant} title={t.open} aria-label={t.open}>
      <SparkIcon />
    </button>
  );
}
