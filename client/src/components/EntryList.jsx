import React, { useState, useMemo, useEffect } from 'react';
import api from '../api';
import MessageThread from './MessageThread';
import EntryPanel from './EntryPanel';
import EmptyState from './EmptyState';
import Pagination from './Pagination';
import { fmtHours, langToLocale } from '../utils';

const ENTRIES_PER_PAGE = 25;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
function isEditable(dateStr) {
  return Date.now() - new Date(dateStr.substring(0, 10) + 'T00:00:00').getTime() <= SEVEN_DAYS_MS;
}
function formatDate(dateStr, language) {
  const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
  return d.toLocaleDateString(langToLocale(language), { weekday: 'long', month: 'short', day: 'numeric' });
}
function formatTime(t) {
  const [h, m] = t.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}
function netHours(start, end, breakMinutes) {
  let ms = new Date(`1970-01-01T${end}`) - new Date(`1970-01-01T${start}`);
  if (ms < 0) ms += 86400000;
  return Math.max(0, ms / 3600000 - (breakMinutes || 0) / 60);
}
function isMidnightCross(start, end) {
  return end.substring(0, 5) < start.substring(0, 5);
}

export default function EntryList({ entries, onDeleted, onUpdated, t, language, currentUserId, projects = [], onRefresh }) {
  const [expandedId, setExpandedId] = useState(null);
  const [openMessageId, setOpenMessageId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState('');
  const [page, setPage] = useState(1);

  const toggleSelect = id => {
    setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    setConfirmingBulkDelete(false);
    setBulkDeleting(true);
    setBulkDeleteError('');
    try {
      await Promise.all(ids.map(id => api.delete(`/time-entries/${id}`)));
      ids.forEach(id => onDeleted(id));
      setSelectedIds(new Set());
    } catch { setBulkDeleteError(t.failedDeleteEntry); }
    finally { setBulkDeleting(false); }
  };

  // Flat list, dates descending, entries within a day ascending by start_time.
  const sortedEntries = useMemo(() => (
    [...entries].sort((a, b) => {
      const dc = b.work_date.substring(0, 10).localeCompare(a.work_date.substring(0, 10));
      return dc !== 0 ? dc : a.start_time.localeCompare(b.start_time);
    })
  ), [entries]);

  const pages = Math.max(1, Math.ceil(sortedEntries.length / ENTRIES_PER_PAGE));
  // Keep the page in range as entries are deleted/filtered.
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  const safePage = Math.min(page, pages);

  // Group only the current page's slice by date for display.
  const grouped = useMemo(() => {
    const slice = sortedEntries.slice((safePage - 1) * ENTRIES_PER_PAGE, safePage * ENTRIES_PER_PAGE);
    const groups = [];
    let cur = null;
    for (const e of slice) {
      const d = e.work_date.substring(0, 10);
      if (d !== cur) { cur = d; groups.push({ date: d, entries: [] }); }
      groups[groups.length - 1].entries.push(e);
    }
    return groups;
  }, [sortedEntries, safePage]);

  if (entries.length === 0) return (
    <EmptyState
      mark="T"
      title={t.noEntries}
      body={t.logFirstEntryHint}
    />
  );

  const toggleExpand = id => {
    setExpandedId(prev => prev === id ? null : id);
    setOpenMessageId(null);
  };

  return (
    <div style={styles.card} className="mobile-card">
      <div style={styles.headingRow}>
        <h2 style={styles.heading}>{t.yourEntries}</h2>
        {selectedIds.size > 0 && (
          confirmingBulkDelete ? (
            <>
              <button style={{ ...styles.confirmBulkDeleteBtn, ...(bulkDeleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleBulkDelete} disabled={bulkDeleting}>
                {bulkDeleting ? t.elDeleting : `${t.elConfirmDelete} ${selectedIds.size}`}
              </button>
              <button style={styles.cancelBulkDeleteBtn} onClick={() => setConfirmingBulkDelete(false)}>{t.cancel}</button>
            </>
          ) : (
            <button style={{ ...styles.bulkDeleteBtn, ...(bulkDeleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => { setBulkDeleteError(''); setConfirmingBulkDelete(true); }} disabled={bulkDeleting}>
              {`${t.elDeleteSelected} ${selectedIds.size}`}
            </button>
          )
        )}
        {bulkDeleteError && <span style={styles.bulkDeleteError}>{bulkDeleteError}</span>}
      </div>

      {grouped.map(group => (
        <div key={group.date}>
          <div style={styles.dateHeader}>{formatDate(group.date, language)}</div>
          <div style={styles.list}>
            {group.entries.map(e => {
              const crosses = isMidnightCross(e.start_time, e.end_time);
              const isExpanded = expandedId === e.id;
              const deletable = !e.pending && !e.locked && isEditable(e.work_date);
              return (
                <div key={e.id} style={{ ...styles.entry, ...(isExpanded ? styles.entryExpanded : {}) }}>
                  <div
                    style={styles.entryRow}
                    onClick={() => toggleExpand(e.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={ev => ev.key === 'Enter' && toggleExpand(e.id)}
                  >
                    {deletable && (
                      <input
                        type="checkbox"
                        style={styles.checkbox}
                        checked={selectedIds.has(e.id)}
                        onChange={() => toggleSelect(e.id)}
                        onClick={ev => ev.stopPropagation()}
                      />
                    )}
                    <div style={styles.entryInfo}>
                      <span style={styles.project} title={e.project_name || ''}>{e.project_name || '—'}</span>
                      <span style={styles.times}>
                        {formatTime(e.start_time)} – {formatTime(e.end_time)}
                        {crosses && <span style={styles.plus1}>+1</span>}
                        <span style={styles.dur}> · {fmtHours(netHours(e.start_time, e.end_time, e.break_minutes))}</span>
                      </span>
                    </div>
                    <div style={styles.entryRight}>
                      {e.status === 'approved' && <span style={styles.badgeGreen}>{t.approved}</span>}
                      {e.status === 'rejected' && <span style={styles.badgeRed}>{t.rejected}</span>}
                      {e.locked && <span style={styles.badgeLock}>🔒</span>}
                      {e.pending && <span style={styles.badgePending}>⏳</span>}
                      {!e.pending && (!e.status || e.status === 'pending') && <span style={styles.badgePending}>{t.pending}</span>}
                      <span style={{ ...styles.wageChip, background: e.wage_type === 'prevailing' ? '#d97706' : '#2563eb' }}>
                        {e.wage_type === 'prevailing' ? t.prevailing : t.regular}
                      </span>
                      <span style={{ ...styles.chevron, transform: isExpanded ? 'rotate(180deg)' : 'none' }}>▾</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <>
                      {(e.break_minutes > 0 || e.mileage > 0 || e.notes) && (
                        <div style={styles.entryMeta}>
                          {e.break_minutes > 0 && <span style={styles.metaTag}>☕ {e.break_minutes}m {t.elBreak}</span>}
                          {e.mileage > 0 && <span style={styles.metaTag}>🚗 {parseFloat(e.mileage).toFixed(1)} {t.miChip}</span>}
                          {e.notes && <span style={styles.notes}>{e.notes}</span>}
                        </div>
                      )}
                      <EntryPanel
                        entry={e}
                        projects={projects}
                        onRefresh={onRefresh}
                        onDeleted={id => { onDeleted(id); setExpandedId(null); setSelectedIds(prev => { const s = new Set(prev); s.delete(id); return s; }); }}
                        onClose={() => setExpandedId(null)}
                      />
                      <button
                        style={styles.msgBtn}
                        onClick={ev => { ev.stopPropagation(); setOpenMessageId(openMessageId === e.id ? null : e.id); }}
                      >
                        💬 {openMessageId === e.id ? t.hideComments : t.comments}
                      </button>
                      {openMessageId === e.id && <MessageThread entryId={e.id} currentUserId={currentUserId} />}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <Pagination page={safePage} pages={pages} onChange={setPage} />
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  headingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 },
  heading: { fontSize: 18, fontWeight: 700, margin: 0 },
  bulkDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  confirmBulkDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBulkDeleteBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  bulkDeleteError: { fontSize: 13, color: '#ef4444' },
  dateHeader: { fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '12px 0 4px', borderBottom: '1px solid #f3f4f6', marginBottom: 6 },
  list: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 },
  entry: { border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', cursor: 'default' },
  entryExpanded: { borderColor: '#93c5fd', background: '#f8faff' },
  entryRow: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' },
  checkbox: { flexShrink: 0, width: 22, height: 22, cursor: 'pointer' },
  entryInfo: { flex: 1, minWidth: 0 },
  project: { display: 'block', fontWeight: 700, fontSize: 14, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  times: { display: 'block', fontSize: 12, color: '#6b7280', marginTop: 2 },
  plus1: { fontSize: 10, fontWeight: 700, color: '#d97706', background: '#fef3c7', padding: '0px 4px', borderRadius: 4, marginLeft: 4, verticalAlign: 'middle' },
  dur: { color: '#6b7280' },
  entryRight: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  chevron: { fontSize: 14, color: '#6b7280', transition: 'transform 0.15s', lineHeight: 1 },
  badgeGreen: { fontSize: 10, fontWeight: 700, color: '#065f46', background: '#d1fae5', padding: '1px 6px', borderRadius: 10 },
  badgeRed: { fontSize: 10, fontWeight: 700, color: '#991b1b', background: '#fee2e2', padding: '1px 6px', borderRadius: 10 },
  badgeLock: { fontSize: 12, opacity: 0.5 },
  badgePending: { fontSize: 10, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 10 },
  wageChip: { fontSize: 10, fontWeight: 700, color: '#fff', padding: '1px 6px', borderRadius: 10 },
  entryMeta: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 2 },
  metaTag: { fontSize: 11, color: '#6b7280', background: '#f3f4f6', padding: '1px 7px', borderRadius: 10 },
  notes: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
  msgBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '3px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer', marginTop: 8, display: 'block' },
};
