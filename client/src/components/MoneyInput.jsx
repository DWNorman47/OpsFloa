// Dollar-based input that hides the cents conversion. Internally the
// caller deals in CENTS (integer), externally the user types DOLLARS
// (e.g. "15.50") because that's how humans count money. Before this,
// every line-item form had `<input type=number value={l.unit_cost_cents} />`
// and users had to mentally translate $15 → "1500" on every row.
//
// Usage:
//   <MoneyInput
//     valueCents={l.unit_cost_cents}
//     onChange={cents => updateLine(i, 'unit_cost_cents', cents)}
//     style={...}
//   />
//
// The component manages a local string state so partial input like
// "15." (mid-typing) doesn't get parsed-then-reformatted out from under
// the user. We re-sync from props only when the parsed cents value
// genuinely diverges (caller's external write).

import React, { useState, useEffect, useRef } from 'react';
import { parseDollars, centsToDollarsField } from '../utils/format';

export default function MoneyInput({ valueCents, onChange, style, placeholder = '0.00', ...rest }) {
  const [text, setText] = useState(() => centsToDollarsField(valueCents));
  const lastEmittedRef = useRef(valueCents);

  // Re-sync from props ONLY when an external change (not our own
  // emission) lands. Otherwise mid-typing "15." would get reformatted
  // back to "15.00" on each keystroke and break the cursor.
  useEffect(() => {
    if (valueCents !== lastEmittedRef.current) {
      setText(centsToDollarsField(valueCents));
      lastEmittedRef.current = valueCents;
    }
  }, [valueCents]);

  function handleChange(e) {
    const next = e.target.value;
    setText(next);
    // Empty input → null cents (caller decides what null means)
    if (next === '' || next === '$') {
      lastEmittedRef.current = 0;
      onChange(0);
      return;
    }
    const cents = parseDollars(next);
    if (cents != null) {
      lastEmittedRef.current = cents;
      onChange(cents);
    }
    // Unparseable (e.g. "15.5.5") — leave text alone, don't emit. The
    // next keystroke usually fixes it; on blur we reformat.
  }

  function handleBlur() {
    // Re-render the canonical string on blur so user always sees
    // "15.50" not "15.5" after they leave the field.
    setText(centsToDollarsField(lastEmittedRef.current));
  }

  return (
    <div style={{ position: 'relative', ...style?.wrapper }}>
      <span style={{
        position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
        color: '#6b7280', fontSize: 14, pointerEvents: 'none',
      }}>$</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        style={{
          padding: '8px 10px 8px 22px',
          border: '1px solid #d1d5db',
          borderRadius: 6,
          fontSize: 14,
          fontFamily: 'inherit',
          width: '100%',
          boxSizing: 'border-box',
          textAlign: 'right',
          ...style,
        }}
        {...rest}
      />
    </div>
  );
}
