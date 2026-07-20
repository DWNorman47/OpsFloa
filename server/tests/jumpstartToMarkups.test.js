/**
 * jumpstartToMarkups — the client converter that turns the vision model's
 * structured draft into Plan Room markups. Lifted verbatim from planroom/app.js
 * (same pattern as the sitework converter) so the test exercises the real code.
 *
 * The crux: coordinates arrive NORMALIZED [0,1] of the page image and must be
 * scaled to base px (normalized × page dims). A wrong scaling drops every marker
 * in the wrong place.
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

const jumpstartToMarkups = lift('jumpstartToMarkups');

const DIMS = { w: 1000, h: 800 };

describe('coordinate scaling (normalized × page dims)', () => {
  test('count points scale into base px', () => {
    const out = jumpstartToMarkups(
      { counts: [{ label: 'Inlet', unit: 'EA', confidence: 'high', points: [{ x: 0.5, y: 0.25 }, { x: 0.1, y: 0.9 }] }] },
      3, DIMS
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('qcount');
    expect(out[0].page).toBe(3);
    expect(out[0].pts).toEqual([{ x: 500, y: 200 }, { x: 100, y: 720 }]);
  });

  test('region polygon scales into base px', () => {
    const out = jumpstartToMarkups(
      { regions: [{ label: 'Parking', confidence: 'low', polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] },
      1, DIMS
    );
    expect(out[0].kind).toBe('qarea');
    expect(out[0].pts).toEqual([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }]);
  });
});

describe('markup shape', () => {
  const out = jumpstartToMarkups({
    counts: [{ label: 'Tree', unit: 'EA', confidence: 'medium', points: [{ x: 0.2, y: 0.2 }] }],
    regions: [{ label: 'Pond', confidence: 'low', polygon: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }] }],
  }, 1, DIMS);

  test('everything is flagged ai:true with its confidence, and a distinct colour', () => {
    for (const m of out) {
      expect(m.ai).toBe(true);
      expect(['high', 'medium', 'low']).toContain(m.aiConfidence);
    }
    const count = out.find(m => m.kind === 'qcount');
    expect(count.color).toBe('#9333ea');       // the AI colour
    expect(count.cfg).toEqual({ label: 'Tree', unit: 'EA' });
    const region = out.find(m => m.kind === 'qarea');
    expect(region.cfg).toEqual({ label: 'Pond' });
  });

  test('labels/units default when the model omits them', () => {
    const out2 = jumpstartToMarkups({ counts: [{ points: [{ x: 0.5, y: 0.5 }] }] }, 1, DIMS);
    expect(out2[0].cfg).toEqual({ label: 'Item', unit: 'EA' });
    expect(out2[0].aiConfidence).toBe('low');
  });
});

describe('defensive', () => {
  test('empty result → no markups', () => {
    expect(jumpstartToMarkups({}, 1, DIMS)).toEqual([]);
    expect(jumpstartToMarkups(null, 1, DIMS)).toEqual([]);
  });

  test('a count group with no points is skipped', () => {
    const out = jumpstartToMarkups({ counts: [{ label: 'Empty', points: [] }, { label: 'Ok', points: [{ x: 0.5, y: 0.5 }] }] }, 1, DIMS);
    expect(out.map(m => m.cfg.label)).toEqual(['Ok']);
  });

  test('a region with < 3 vertices is skipped (not a polygon)', () => {
    const out = jumpstartToMarkups({ regions: [{ label: 'Line', polygon: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }] }, 1, DIMS);
    expect(out).toEqual([]);
  });

  test('invalid page dims → nothing placed (can\'t scale)', () => {
    expect(jumpstartToMarkups({ counts: [{ label: 'X', points: [{ x: 0.5, y: 0.5 }] }] }, 1, { w: 0, h: 0 })).toEqual([]);
    expect(jumpstartToMarkups({ counts: [{ label: 'X', points: [{ x: 0.5, y: 0.5 }] }] }, 1, null)).toEqual([]);
  });
});
