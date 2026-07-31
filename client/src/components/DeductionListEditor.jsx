import React from 'react';
import { useT } from '../hooks/useT';

/**
 * Controlled editor for a list of payroll deductions. Used both for the
 * company-wide list (DeductionsSettings) and a worker's own extras (in
 * WorkerMetrics) — the only difference between those is where the list is saved,
 * so the row UI lives here once.
 *
 * Each item is form-shaped (strings from inputs): { id, name, kind, value, cap }.
 * `kind` is 'percent' (a % of gross wages, optional cap) or 'fixed' (a flat
 * amount). The parent owns the array and the save; this only edits rows.
 */

export const newDeduction = () => ({
  id: `d${Math.random().toString(36).slice(2, 8)}`,
  name: '', kind: 'percent', value: '', cap: '', roleIds: [],
});

// `roles` (optional): when provided, each deduction gets a role-scope selector —
// "All employees" (roleIds empty) or specific roles. Omitted in the per-worker
// context (a worker's own extras are already worker-scoped).
export default function DeductionListEditor({ items, onChange, roles }) {
  const t = useT();
  const update = (id, patch) => onChange(items.map(it => (it.id === id ? { ...it, ...patch } : it)));
  const remove = (id) => onChange(items.filter(it => it.id !== id));
  const add = () => {
    // Guarantee a unique id within the list — two colliding random ids would both match a
    // single scope:'selected' pick in a paycheck ruleset and over-deduct.
    const used = new Set(items.map(it => it.id));
    let d = newDeduction();
    while (used.has(d.id)) d = newDeduction();
    onChange([...items, d]);
  };
  const toggleRole = (it, rid) => {
    const cur = it.roleIds || [];
    update(it.id, { roleIds: cur.includes(rid) ? cur.filter(x => x !== rid) : [...cur, rid] });
  };

  return (
    <div>
      {items.length === 0 && <p style={s.empty}>{t.dedEmpty}</p>}

      {items.map(it => (
        <div key={it.id} style={s.item}>
          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>{t.dedName}</label>
              <input style={s.input} type="text" maxLength={120} value={it.name}
                placeholder={t.dedNamePlaceholder}
                onChange={e => update(it.id, { name: e.target.value })} />
            </div>
            <div style={s.field}>
              <label style={s.label}>{t.dedKind}</label>
              <select style={s.input} value={it.kind} onChange={e => update(it.id, { kind: e.target.value })}>
                <option value="percent">{t.dedKindPercent}</option>
                <option value="fixed">{t.dedKindFixed}</option>
              </select>
            </div>
            <div style={s.fieldNarrow}>
              <label style={s.label}>{it.kind === 'percent' ? t.dedValuePercent : t.dedValueFixed}</label>
              <input style={s.inputNarrow} type="number" min="0" max={it.kind === 'percent' ? '100' : undefined}
                step={it.kind === 'percent' ? '0.05' : '0.01'}
                value={it.value} onChange={e => update(it.id, { value: e.target.value })} />
            </div>
            {it.kind === 'percent' && (
              <div style={s.fieldNarrow}>
                <label style={s.label}>{t.dedCap}</label>
                <input style={s.inputNarrow} type="number" min="0" step="0.01"
                  value={it.cap} placeholder={t.dedCapNone}
                  onChange={e => update(it.id, { cap: e.target.value })} />
              </div>
            )}
            <button type="button" style={s.remove} onClick={() => remove(it.id)} aria-label={t.dedRemove}>×</button>
          </div>
          {roles && roles.length > 0 && (
            <div style={s.scopeRow}>
              <span style={s.scopeLabel}>{t.dedAppliesTo}</span>
              <button type="button" style={(it.roleIds || []).length === 0 ? s.chipOn : s.chip}
                onClick={() => update(it.id, { roleIds: [] })}>{t.dedAllEmployees}</button>
              {roles.map(r => (
                <button key={r.id} type="button" style={(it.roleIds || []).includes(r.id) ? s.chipOn : s.chip}
                  onClick={() => toggleRole(it, r.id)}>{r.name}</button>
              ))}
            </div>
          )}
        </div>
      ))}

      <button type="button" style={s.add} onClick={add}>{t.dedAdd}</button>
    </div>
  );
}

const s = {
  empty: { fontSize: 12.5, color: '#6b7280', margin: '0 0 10px' },
  item: { marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #f1f5f9' },
  row: { display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 8, flexWrap: 'wrap' },
  scopeRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  scopeLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginRight: 2 },
  chip: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 999, padding: '3px 11px', fontSize: 12, cursor: 'pointer' },
  chipOn: { background: 'var(--ops-page-accent, #1d4ed8)', color: '#fff', border: '1px solid var(--ops-page-accent, #1d4ed8)', borderRadius: 999, padding: '3px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px' },
  fieldNarrow: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, width: '100%' },
  inputNarrow: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, width: 100 },
  remove: { background: '#fef2f2', color: '#ef4444', border: '1px solid #fecaca', borderRadius: 6, width: 30, height: 34, fontSize: 16, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  add: { background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', marginTop: 2 },
};
