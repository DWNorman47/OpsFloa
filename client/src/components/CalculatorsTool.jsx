import React, { useMemo, useState } from 'react';
import { CALCULATORS, CALC_GROUPS } from './calculators';

// The hub is deliberately dumb: it renders whatever `calculators.js` describes,
// so a new calculator is one array entry rather than a new component (and one
// tab, not twelve). All of it is local arithmetic — no network, no AI call, no
// metering, nothing to gate.

const defaultsFor = calc =>
  calc.inputs.reduce((acc, i) => { acc[i.k] = i.def; return acc; }, {});

export default function CalculatorsTool() {
  const [openId, setOpenId] = useState(CALCULATORS[0].id);
  // one value bag per calculator, so switching away and back keeps your numbers
  const [values, setValues] = useState(() =>
    CALCULATORS.reduce((acc, c) => { acc[c.id] = defaultsFor(c); return acc; }, {}));

  const calc = useMemo(() => CALCULATORS.find(c => c.id === openId), [openId]);
  const v = values[openId];

  const set = (k, val) => setValues(s => ({ ...s, [openId]: { ...s[openId], [k]: val } }));
  const reset = () => setValues(s => ({ ...s, [openId]: defaultsFor(calc) }));

  // calc() is hand-written arithmetic over free-text fields; a throw here would
  // blank the whole Tools page, so it degrades to a readable row instead.
  let rows = [];
  try {
    rows = calc.calc(v) || [];
  } catch {
    rows = [{ label: 'Check the numbers above', value: '—' }];
  }

  const visible = calc.inputs.filter(i => !i.show || i.show(v));

  return (
    <div>
      <p style={styles.hint}>
        Quick field math — no plans, no setup. Everything runs on your device and nothing is saved.
      </p>

      <div style={styles.wrap}>
        <div style={styles.list}>
          {CALC_GROUPS.map(g => (
            <div key={g}>
              <div style={styles.group}>{g}</div>
              {CALCULATORS.filter(c => c.group === g).map(c => (
                <button
                  key={c.id}
                  onClick={() => setOpenId(c.id)}
                  style={{ ...styles.item, ...(c.id === openId ? styles.itemOn : null) }}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div style={styles.panel}>
          <div style={styles.head}>
            <div>
              <div style={styles.title}>{calc.name}</div>
              <div style={styles.blurb}>{calc.blurb}</div>
            </div>
            <button onClick={reset} style={styles.reset}>Reset</button>
          </div>

          <div style={styles.form}>
            {visible.map(i => (
              <label key={i.k} style={styles.field}>
                <span style={styles.label}>{i.label}{i.unit ? <span style={styles.unit}> ({i.unit})</span> : null}</span>
                {i.type === 'select' ? (
                  <select value={v[i.k]} onChange={e => set(i.k, e.target.value)} style={styles.input}>
                    {i.options.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}
                  </select>
                ) : (
                  <input
                    type="number"
                    inputMode="decimal"
                    step={i.step || 'any'}
                    value={v[i.k]}
                    onChange={e => set(i.k, e.target.value)}
                    style={styles.input}
                  />
                )}
              </label>
            ))}
          </div>

          <div style={styles.results}>
            {rows.map((r, idx) => (
              <div key={idx} style={{ ...styles.row, ...(r.big ? styles.rowBig : null), ...(r.warn ? styles.rowWarn : null) }}>
                <span style={styles.rLabel}>{r.label}</span>
                <span style={{ ...styles.rValue, ...(r.big ? styles.rValueBig : null) }}>
                  {r.value}{r.unit ? <span style={styles.rUnit}> {r.unit}</span> : null}
                </span>
              </div>
            ))}
          </div>

          {calc.note && <p style={styles.note}>{calc.note}</p>}
        </div>
      </div>
    </div>
  );
}

const styles = {
  hint: { color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' },
  wrap: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' },
  list: { flex: '0 0 200px', minWidth: 170, display: 'flex', flexDirection: 'column', gap: 10 },
  group: { fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' },
  item: {
    display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 2,
    fontSize: 13.5, fontFamily: 'inherit', color: '#334155', background: 'none',
    border: '1px solid transparent', borderRadius: 8, cursor: 'pointer',
  },
  itemOn: { background: '#eff6ff', borderColor: '#bfdbfe', color: '#1d4ed8', fontWeight: 700 },
  panel: { flex: '1 1 340px', minWidth: 300, border: '1px solid #e2e8f0', borderRadius: 12, background: '#fff', padding: 16 },
  head: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  title: { fontSize: 16, fontWeight: 700, color: '#0f172a' },
  blurb: { fontSize: 13, color: '#64748b', marginTop: 2, lineHeight: 1.5 },
  reset: {
    marginLeft: 'auto', flex: '0 0 auto', padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit',
    color: '#64748b', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer',
  },
  form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12.5, fontWeight: 600, color: '#475569' },
  unit: { fontWeight: 400, color: '#94a3b8' },
  input: {
    boxSizing: 'border-box', width: '100%', padding: '8px 10px', fontSize: 14, fontFamily: 'inherit',
    border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#0f172a',
  },
  results: { borderTop: '1px solid #e2e8f0', paddingTop: 10 },
  row: { display: 'flex', alignItems: 'baseline', gap: 12, padding: '5px 0', fontSize: 13.5 },
  rowBig: { padding: '8px 0' },
  rowWarn: { color: '#b45309' },
  rLabel: { color: '#64748b', flex: 1 },
  rValue: { fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  rValueBig: { fontSize: 22, color: '#1d4ed8' },
  rUnit: { fontWeight: 600, color: '#64748b', fontSize: 13 },
  note: { fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, margin: '12px 0 0', borderTop: '1px solid #f1f5f9', paddingTop: 10 },
};
