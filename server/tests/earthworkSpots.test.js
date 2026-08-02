/**
 * parseEarthworkSpots — the deterministic spot-grade extractor for the Earthwork
 * trade. Lifted verbatim from planroom/app.js so the test exercises the real code.
 *
 * It reads a vector PDF's text runs ([{ str, x, y }] in base px) and returns only
 * elevations with a disposition signal — (parens)/EG = existing, FS/FG = proposed —
 * so bearings/dimensions/slopes are never mistaken for grades, and structure/floor
 * elevations (TG/FL/FF…) are reported separately, not placed as ground grades.
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

const parseEarthworkSpots = lift('parseEarthworkSpots');

describe('classification by tag / parentheses', () => {
  test('same-string tags: FS/FG → proposed, EG → existing', () => {
    const { spots } = parseEarthworkSpots([
      { str: '312.00 FS', x: 100, y: 100 },
      { str: '305.69 EG', x: 200, y: 200 },
      { str: '311.45 FG', x: 300, y: 300 },
    ]);
    expect(spots).toHaveLength(3);
    expect(spots.find(s => s.elev === 312).surface).toBe('proposed');
    expect(spots.find(s => s.elev === 305.69).surface).toBe('existing');
    expect(spots.find(s => s.elev === 311.45).surface).toBe('proposed');
  });

  test('parentheses mean existing, even with no tag', () => {
    const { spots } = parseEarthworkSpots([{ str: '(305.69)', x: 10, y: 10 }]);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ elev: 305.69, surface: 'existing', at: { x: 10, y: 10 } });
  });

  test('a bare number picks up a tag on a nearby run', () => {
    const { spots } = parseEarthworkSpots([
      { str: '310.35', x: 500, y: 500 },
      { str: 'FS', x: 505, y: 515 },        // within radius → proposed
    ]);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ elev: 310.35, surface: 'proposed' });
  });

  test('a far tag is not borrowed — untagged number is ignored', () => {
    const { spots, ambiguous } = parseEarthworkSpots([
      { str: '310.35', x: 0, y: 0 },
      { str: 'FS', x: 900, y: 900 },        // far away → not associated
    ]);
    expect(spots).toHaveLength(0);
    expect(ambiguous).toBe(1);
  });
});

describe('what gets skipped or ignored', () => {
  test('structure/floor elevations (TG/FL/FF) are skipped, not placed', () => {
    const { spots, skipped } = parseEarthworkSpots([
      { str: '308.45 TG', x: 10, y: 10 },                                 // same-string TG
      { str: '318.31 FL', x: 1000, y: 1000 },                             // same-string FL
      { str: '312.50', x: 500, y: 500 }, { str: 'FF', x: 505, y: 515 },   // FF on a nearby run
    ]);
    expect(spots).toHaveLength(0);
    expect(skipped.map(s => s.tag).sort()).toEqual(['FF', 'FL', 'TG']);
  });

  test('bearings, dimensions, slopes, and "FF = 312.50" are excluded', () => {
    const { spots } = parseEarthworkSpots([
      { str: 'N89°37\'07"E 185.00', x: 10, y: 10 },  // bearing distance
      { str: '1.0%', x: 20, y: 20 },                 // slope
      { str: '100.14\'', x: 30, y: 30 },             // dimension in feet
      { str: '48" dia x 5\' deep', x: 40, y: 40 },   // drywell size
      { str: 'FF = 312.50', x: 50, y: 50 },          // '=' → excluded (a floor callout, not a grade)
    ]);
    expect(spots).toHaveLength(0);
  });

  test('untagged decimals with no signal are ignored, not guessed', () => {
    const { spots, ambiguous } = parseEarthworkSpots([{ str: '312.00', x: 10, y: 10 }]);
    expect(spots).toHaveLength(0);
    expect(ambiguous).toBe(1);
  });
});

describe('defensive', () => {
  test('duplicate runs at the same spot are de-duped', () => {
    const { spots } = parseEarthworkSpots([
      { str: '312.00 FS', x: 100, y: 100 },
      { str: '312.00 FS', x: 100, y: 100 },
    ]);
    expect(spots).toHaveLength(1);
  });

  test('junk input never throws', () => {
    expect(parseEarthworkSpots(null)).toEqual({ spots: [], skipped: [], ambiguous: 0 });
    expect(parseEarthworkSpots([{ str: '', x: 1, y: 1 }, { x: NaN, y: 2, str: '312.5 FS' }]).spots).toEqual([]);
  });
});
