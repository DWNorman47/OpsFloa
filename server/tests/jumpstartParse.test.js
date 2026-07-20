/**
 * parseJumpstart — the defensive parser for the vision model's Jump Start reply.
 *
 * The model is told to return bare JSON but in practice wraps it in prose or
 * ```json fences, drops fields, or emits junk coordinates. This output becomes
 * takeoff markups, so the parser must extract what's usable, DROP what isn't,
 * and never throw — a malformed reply should degrade to a smaller draft, never
 * a crash or a bad shape presented as real geometry.
 */

const { parseJumpstart, extractJsonObject } = require('../routes/jumpstart');

const wrap = obj => JSON.stringify(obj);

describe('extractJsonObject — the model rarely returns clean JSON', () => {
  test('bare JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  test('```json fenced', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test('prose around the object', () => {
    expect(extractJsonObject('Here is the takeoff:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });
  test('unparseable → null, not a throw', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
  });
});

describe('parseJumpstart normalises a good reply', () => {
  const good = wrap({
    sheet: { type: 'grading', title: 'Grading Plan', number: 'C-300' },
    scale: { found: true, text: '1"=30\'', feetPerInch: 30, note: 'read from sheet text' },
    counts: [
      { label: 'Storm inlet', unit: 'EA', confidence: 'high', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] },
      { label: 'Parking stall', unit: 'EA', confidence: 'medium', points: [{ x: 0.5, y: 0.5 }] },
    ],
    regions: [{ label: 'Parking', kind: 'area', confidence: 'low', polygon: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }] }],
    labels: [{ text: 'FG 512.5', kind: 'elevation', at: { x: 0.6, y: 0.3 } }],
    notes: 'Contours not attempted.',
  });

  const out = parseJumpstart(good);

  test('carries the counts, regions, labels, scale', () => {
    expect(out.counts).toHaveLength(2);
    expect(out.counts[0]).toMatchObject({ label: 'Storm inlet', unit: 'EA', confidence: 'high' });
    expect(out.counts[0].points).toHaveLength(2);
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].polygon).toHaveLength(3);
    expect(out.scale.feetPerInch).toBe(30);
    expect(out.labels[0].text).toBe('FG 512.5');
  });

  test('adds a summary the client can headline', () => {
    expect(out.summary).toEqual({ countGroups: 2, countPoints: 3, regions: 1, labels: 1 });
  });
});

describe('parseJumpstart is defensive about bad data', () => {
  test('an empty / unparseable reply → a valid empty draft, never a throw', () => {
    const out = parseJumpstart('the model said something useless');
    expect(out.counts).toEqual([]);
    expect(out.regions).toEqual([]);
    expect(out.summary.countPoints).toBe(0);
    expect(out.scale.found).toBe(false);
  });

  test('out-of-range coordinates are clamped to [0,1]', () => {
    const out = parseJumpstart(wrap({ counts: [{ label: 'X', points: [{ x: 1.4, y: -0.2 }, { x: 0.5, y: 0.5 }] }] }));
    expect(out.counts[0].points[0]).toEqual({ x: 1, y: 0 });
    expect(out.counts[0].points[1]).toEqual({ x: 0.5, y: 0.5 });
  });

  test('a count group with no valid points is dropped', () => {
    const out = parseJumpstart(wrap({ counts: [{ label: 'Bad', points: [{ x: 'nope', y: null }] }, { label: 'Good', points: [{ x: 0.2, y: 0.2 }] }] }));
    expect(out.counts.map(c => c.label)).toEqual(['Good']);
  });

  test('a region with < 3 vertices is dropped (not a polygon)', () => {
    const out = parseJumpstart(wrap({ regions: [{ label: 'Line', polygon: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }] }));
    expect(out.regions).toEqual([]);
  });

  test('unknown confidence defaults to low; missing unit defaults to EA', () => {
    const out = parseJumpstart(wrap({ counts: [{ label: 'Y', confidence: 'certain', points: [{ x: 0.1, y: 0.1 }] }] }));
    expect(out.counts[0].confidence).toBe('low');
    expect(out.counts[0].unit).toBe('EA');
  });

  test('a runaway response is capped, not passed through whole', () => {
    const points = Array.from({ length: 5000 }, (_, i) => ({ x: (i % 100) / 100, y: 0.5 }));
    const out = parseJumpstart(wrap({ counts: [{ label: 'Many', points }] }));
    expect(out.counts[0].points.length).toBeLessThanOrEqual(1000);
  });

  test('a non-positive feetPerInch is treated as not found', () => {
    const out = parseJumpstart(wrap({ scale: { found: true, feetPerInch: 0 } }));
    expect(out.scale.feetPerInch).toBeNull();
    expect(out.scale.found).toBe(false);
  });

  test('malformed top-level (array, string, null) → empty draft', () => {
    for (const bad of ['[]', '"hi"', 'null', '42']) {
      const out = parseJumpstart(bad);
      expect(out.counts).toEqual([]);
      expect(out.summary.countPoints).toBe(0);
    }
  });
});
