/**
 * extractPdfPolylines — walks a pdf.js operator list and returns every polyline in
 * base-px page space, tracking the CTM stack (save/restore/transform) like the
 * renderer. Lifted verbatim from planroom/app.js. The synthetic op lists here use a
 * fake OPS enum (real pdf.js OPS are integers exposed at runtime as pdfjsLib.OPS).
 */

const fs = require('fs');
const path = require('path');

function lift(name) {
  const file = path.join(__dirname, '..', '..', 'client', 'public', 'tool-apps', 'planroom', 'app.js');
  const src = fs.readFileSync(file, 'utf8');
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, i) + `\nreturn ${name};`)();
}

const extractPdfPolylines = lift('extractPdfPolylines');

const OPS = {
  save: 1, restore: 2, transform: 3, constructPath: 4,
  moveTo: 5, lineTo: 6, curveTo: 7, curveTo2: 8, curveTo3: 9, rectangle: 10, closePath: 11,
};
const I = [1, 0, 0, 1, 0, 0]; // identity base CTM

test('moveTo + lineTo build a polyline', () => {
  const op = { fnArray: [OPS.constructPath], argsArray: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo], [0, 0, 10, 0, 10, 10]]] };
  expect(extractPdfPolylines(op, OPS, I)).toEqual([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]]);
});

test('the base transform (viewport, y-flip + translate) is applied', () => {
  const base = [1, 0, 0, -1, 0, 100]; // (x,y) -> (x, 100 - y)
  const op = { fnArray: [OPS.constructPath], argsArray: [[[OPS.moveTo, OPS.lineTo], [0, 0, 10, 20]]] };
  expect(extractPdfPolylines(op, OPS, base)).toEqual([[{ x: 0, y: 100 }, { x: 10, y: 80 }]]);
});

test('a content transform composes with the base, and save/restore isolates it', () => {
  const op = {
    fnArray: [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath],
    argsArray: [null, [1, 0, 0, 1, 5, 5], [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]], null, [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]]],
  };
  const out = extractPdfPolylines(op, OPS, I);
  expect(out[0]).toEqual([{ x: 5, y: 5 }, { x: 15, y: 5 }]); // inside save: +5,+5
  expect(out[1]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]); // after restore: offset gone
});

test('rectangle becomes a closed 5-point loop', () => {
  const op = { fnArray: [OPS.constructPath], argsArray: [[[OPS.rectangle], [0, 0, 10, 20]]] };
  expect(extractPdfPolylines(op, OPS, I)).toEqual([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }]]);
});

test('curveTo keeps its endpoint (endpoint approximation)', () => {
  const op = { fnArray: [OPS.constructPath], argsArray: [[[OPS.moveTo, OPS.curveTo], [0, 0, 1, 1, 2, 2, 3, 3]]] };
  expect(extractPdfPolylines(op, OPS, I)).toEqual([[{ x: 0, y: 0 }, { x: 3, y: 3 }]]);
});

test('a lone moveTo (no segment) is dropped — needs >= 2 points', () => {
  const op = { fnArray: [OPS.constructPath], argsArray: [[[OPS.moveTo], [3, 3]]] };
  expect(extractPdfPolylines(op, OPS, I)).toEqual([]);
});

test('empty / junk op lists never throw', () => {
  expect(extractPdfPolylines({}, OPS, I)).toEqual([]);
  expect(extractPdfPolylines({ fnArray: [], argsArray: [] }, OPS, I)).toEqual([]);
});
