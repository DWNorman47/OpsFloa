/**
 * elevStr — Plan Room's earthwork elevation formatter. The bug: a contour set to
 * 197.85 displayed as "197.9" because the formatter forced a single decimal.
 * Lifted verbatim from planroom/app.js so the test guards the real fix.
 */

const fs = require('fs');
const path = require('path');

function liftElevStr() {
  const file = path.join(__dirname, '..', '..', 'client', 'public', 'tool-apps', 'planroom', 'app.js');
  const src = fs.readFileSync(file, 'utf8');
  const marker = 'function elevStr(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('elevStr not found');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  // elevStr calls fmt() from the shared engine — supply the real one.
  const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  // eslint-disable-next-line no-new-func
  return new Function('fmt', src.slice(start, i) + '\nreturn elevStr;')(fmt);
}

const elevStr = liftElevStr();

test('the reported case: 197.85 shows 197.85, not 197.9', () => {
  expect(elevStr(197.85)).toBe('197.85');
});

test.each([
  [812, '812'],           // whole number → no decimals
  [812.5, '812.5'],       // one decimal preserved
  [197.85, '197.85'],     // two decimals preserved (the bug)
  [100.05, '100.05'],
  [812.125, '812.125'],   // three decimals of headroom
  [0, '0'],
  [-4.5, '-4.5'],         // below datum
])('elevStr(%p) → %p', (input, expected) => {
  expect(elevStr(input)).toBe(expected);
});

test('float noise is trimmed (197.85 stored as 197.8500000001)', () => {
  expect(elevStr(197.8500000001)).toBe('197.85');
  expect(elevStr(812.0000001)).toBe('812');
});
