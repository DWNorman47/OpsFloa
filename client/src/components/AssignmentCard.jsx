// A Project Daily assignment card — the full editor for one assigned checklist: schedule,
// team-role scope, shared/individual mode, carryover, a read-only item list, and delete.
// Shared by the Project Daily list view and the scheduler's day editor.
//   collapsible → starts collapsed (header only), click the title to expand.
//   dragProps   → enables drag-to-reorder by a grip handle (the whole card is the ghost).
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useT } from '../hooks/useT';

// A role scope picker: "All types" until you add specific roles; chips + Add after.
function RolePicker({ allLabel, addLabel, options, selected, onChange }) {
  const ids = Array.isArray(selected) && selected.length ? selected.map(String) : null;
  const nameById = useMemo(() => Object.fromEntries(options.map(o => [String(o.id), o.name])), [options]);
  const remaining = options.filter(o => !ids || !ids.includes(String(o.id)));
  const add = id => { if (id) onChange([...(ids || []), id].map(Number)); };
  const remove = id => {
    const next = (ids || []).filter(x => x !== String(id)).map(Number);
    onChange(next.length ? next : null); // empty → back to All
  };
  return (
    <div style={styles.scopeRow}>
      {!ids ? (
        <span style={styles.allTag}>{allLabel}</span>
      ) : (
        ids.map(id => (
          <span key={id} style={styles.chip}>
            {nameById[id] || id}
            <button type="button" style={styles.chipX} aria-label="Remove" onClick={() => remove(id)}>✕</button>
          </span>
        ))
      )}
      {remaining.length > 0 && (
        <select style={styles.addSelect} value="" onChange={e => { add(e.target.value); e.target.value = ''; }}>
          <option value="">+ {addLabel}</option>
          {remaining.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
    </div>
  );
}

export default function AssignmentCard({ a, roles = [], items = [], onPatch, onRemove, collapsible = false, dragProps = null, isOver = false }) {
  const t = useT();
  const cardRef = useRef(null);
  const [expanded, setExpanded] = useState(!collapsible);
  // Transient: user picked "Date" but hasn't chosen one yet (server needs a real date).
  const [schedOverride, setSchedOverride] = useState(null);
  useEffect(() => { setSchedOverride(null); }, [a.schedule_type]);
  const schedType = schedOverride || a.schedule_type || 'none';

  const schedTag = a.schedule_type === 'every' ? t.pdSchedEvery
    : a.schedule_type === 'ordinal' ? t.pdSchedOrdinal.replace('#', a.ordinal_target)
    : a.schedule_type === 'date' ? t.pdSchedDate
    : t.pdSchedNone;

  const onSchedType = (v) => {
    setSchedOverride(null);
    if (v === 'ordinal') onPatch(a.id, { schedule_type: 'ordinal', ordinal_target: a.ordinal_target || 1, scheduled_date: null });
    else if (v === 'date') {
      const d = (a.scheduled_date || '').slice(0, 10);
      if (d) onPatch(a.id, { schedule_type: 'date', scheduled_date: d });
      else setSchedOverride('date'); // reveal the date input; patch on pick
    } else onPatch(a.id, { schedule_type: v, ordinal_target: null, scheduled_date: null }); // none / every
  };

  // Grip is the drag source (drags the whole card as the ghost); the card is the drop target.
  const onGripDragStart = (e) => {
    if (cardRef.current) { try { e.dataTransfer.setDragImage(cardRef.current, 16, 16); } catch { /* ignore */ } }
    dragProps.onDragStart(e);
  };

  return (
    <div
      ref={cardRef}
      style={{ ...styles.card, ...(isOver ? styles.cardDrop : {}) }}
      {...(dragProps ? { onDragOver: dragProps.onDragOver, onDrop: dragProps.onDrop, onDragEnd: dragProps.onDragEnd } : {})}
    >
      <div style={styles.cardHead}>
        <div style={styles.cardHeadLeft}>
          {dragProps && (
            <span style={styles.grip} draggable onDragStart={onGripDragStart} title={t.pdDrag} aria-label={t.pdDrag}>⠿</span>
          )}
          <div
            style={{ minWidth: 0, cursor: collapsible ? 'pointer' : 'default' }}
            onClick={() => collapsible && setExpanded(x => !x)}
          >
            <div style={styles.cardTitle}>
              {a.template_name}
              {collapsible && <span style={styles.chevron}>{expanded ? ' ▾' : ' ▸'}</span>}
            </div>
            <div style={styles.cardMeta}>{a.item_count ?? items.length} {t.itemsCount}</div>
          </div>
        </div>
        <div style={styles.cardHeadRight}>
          {collapsible && !expanded && <span style={styles.schedChip}>{schedTag}</span>}
          <button type="button" style={styles.removeBtn} onClick={() => onRemove(a.id)}>{t.delete}</button>
        </div>
      </div>

      {expanded && (
        <div style={styles.twoCol}>
          <div style={styles.controlsCol}>
            <div style={styles.scopeCell}>
              <div style={styles.scopeLabel}>{t.pdSchedule}</div>
              <div style={styles.scheduleRow}>
                <select style={styles.smallSelect} value={schedType} onChange={e => onSchedType(e.target.value)}>
                  <option value="none">{t.pdSchedNone}</option>
                  <option value="every">{t.pdSchedEvery}</option>
                  <option value="ordinal">{t.pdSchedOrdinal}</option>
                  <option value="date">{t.pdSchedDate}</option>
                </select>
                {schedType === 'ordinal' && (
                  <input
                    style={styles.dayNumInput}
                    type="number"
                    min="1"
                    value={a.ordinal_target || 1}
                    onChange={e => onPatch(a.id, { schedule_type: 'ordinal', ordinal_target: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                  />
                )}
                {schedType === 'date' && (
                  <input
                    style={styles.smallSelect}
                    type="date"
                    value={(a.scheduled_date || '').slice(0, 10)}
                    onChange={e => e.target.value && onPatch(a.id, { schedule_type: 'date', scheduled_date: e.target.value })}
                  />
                )}
              </div>
            </div>
            <div style={styles.scopeCell}>
              <div style={styles.scopeLabel}>{t.pdTypeScope}</div>
              <RolePicker allLabel={t.pdAllTypes} addLabel={t.pdAddRole} options={roles} selected={a.role_ids} onChange={ids => onPatch(a.id, { role_ids: ids })} />
            </div>
            <div style={styles.scopeCell}>
              <div style={styles.scopeLabel}>{t.pdModeLabel}</div>
              <div style={styles.modeToggle}>
                {['shared', 'individual'].map(m => (
                  <button key={m} type="button" style={{ ...styles.modeBtn, ...(a.mode === m ? styles.modeBtnOn : {}) }} onClick={() => a.mode !== m && onPatch(a.id, { mode: m })}>
                    {m === 'shared' ? t.pdModeShared : t.pdModeIndividual}
                  </button>
                ))}
              </div>
            </div>
            <div style={styles.scopeCell}>
              <div style={styles.scopeLabel}>{t.pdCarryover}</div>
              <label style={styles.carryLabel}>
                <input type="checkbox" checked={!!a.carryover} onChange={e => onPatch(a.id, { carryover: e.target.checked })} />
                <span>{t.pdCarryoverHint}</span>
              </label>
            </div>
          </div>

          <div style={styles.itemsCol}>
            <div style={styles.scopeLabel}>{t.pdChecklistItems}</div>
            {items.length === 0 ? (
              <p style={styles.itemsEmpty}>{t.pdNoItems}</p>
            ) : (
              <div style={styles.itemsList}>
                {items.map((it, i) => (
                  <div key={it.id || i} style={styles.itemRow}>
                    <span style={styles.itemKind}>{it.type === 'text' ? '✎' : '☐'}</span>
                    <span style={styles.itemLabel}>{it.label ?? it.text ?? it.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', padding: 16 },
  cardDrop: { boxShadow: '0 0 0 2px #2563eb' },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  cardHeadLeft: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  cardHeadRight: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  grip: { color: '#9ca3af', fontSize: 16, cursor: 'grab', userSelect: 'none', flexShrink: 0, lineHeight: 1 },
  cardTitle: { fontWeight: 700, fontSize: 15, color: '#111827' },
  chevron: { color: '#9ca3af', fontSize: 12, fontWeight: 700 },
  cardMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  schedChip: { fontSize: 11, fontWeight: 700, color: '#6b7280', background: '#f3f4f6', padding: '3px 9px', borderRadius: 10 },
  removeBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', flexShrink: 0 },
  twoCol: { display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 12 },
  controlsCol: { display: 'flex', flexDirection: 'column', gap: 14, flex: '1 1 240px', minWidth: 220 },
  itemsCol: { flex: '2 1 300px', minWidth: 240, background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 },
  itemsList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 },
  itemRow: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  itemKind: { fontSize: 13, color: '#9ca3af', flexShrink: 0, marginTop: 1, width: 14, textAlign: 'center' },
  itemLabel: { fontSize: 13, color: '#374151', lineHeight: 1.4 },
  itemsEmpty: { fontSize: 13, color: '#9ca3af', fontStyle: 'italic', margin: '4px 0 0' },
  scopeCell: { display: 'flex', flexDirection: 'column', gap: 6 },
  scopeLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
  scopeRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  scheduleRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  smallSelect: { padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff' },
  dayNumInput: { padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: 64 },
  carryLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', cursor: 'pointer', lineHeight: 1.4 },
  allTag: { fontSize: 12, fontWeight: 600, color: '#374151', background: '#f3f4f6', padding: '4px 10px', borderRadius: 12 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '3px 6px 3px 10px', borderRadius: 12 },
  chipX: { border: 'none', background: 'none', color: '#1d4ed8', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1 },
  addSelect: { padding: '5px 8px', border: '1px dashed #cbd5e1', borderRadius: 8, fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' },
  modeToggle: { display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', width: 'fit-content' },
  modeBtn: { border: 'none', background: '#fff', color: '#6b7280', padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  modeBtnOn: { background: '#059669', color: '#fff' },
};
