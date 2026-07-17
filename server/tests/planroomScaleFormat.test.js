/**
 * scaleFeetStr — Plan Room's calibration-distance formatter. The bug: a scale
 * set to 207.9 displayed as "208" because the formatter dropped decimals for
 * values ≥ 10. Lifted verbatim from planroom/app.js so the test guards the real
 * fix, not a copy.
 */

const fs = require('fs');
const path = require('path');

function liftScaleFeetStr() {
  const file = path.join(__dirname, '..', '..', 'client', 'public', 'tool-apps', 'planroom', 'app.js');
  const src = fs.readFileSync(file, 'utf8');
  const marker = 'function scaleFeetStr(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('scaleFeetStr not found');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  // scaleFeetStr calls fmt() from the shared engine — supply the real one.
  const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  // eslint-disable-next-line no-new-func
  return new Function('fmt', src.slice(start, i) + '\nreturn scaleFeetStr;')(fmt);
}

const scaleFeetStr = liftScaleFeetStr();

test('the reported case: 207.9 shows 207.9, not 208', () => {
  expect(scaleFeetStr(207.9)).toBe('207.9');
});

test.each([
  [208, '208'],       // whole number → no decimals
  [30, '30'],
  [5.5, '5.5'],       // sub-10 decimal still works (was already fine)
  [207.95, '207.95'], // two decimals preserved
  [100.25, '100.25'],
  [12, '12'],
])('scaleFeetStr(%p) → %p', (input, expected) => {
  expect(scaleFeetStr(input)).toBe(expected);
});

test('float noise is trimmed (207.9 stored as 207.90000001)', () => {
  expect(scaleFeetStr(207.90000001)).toBe('207.9');
  expect(scaleFeetStr(208.0000001)).toBe('208');
});
