/**
 * Sitework → Plan Room export conversion.
 *
 * `convertToPlanRoom` lives in the sitework browser tool
 * (client/public/tool-apps/sitework/app.js). Rather than re-implement the
 * conversion here (which would only test a copy), we LIFT the real function
 * verbatim by string-slicing it out of app.js and run it against a stub state —
 * the same verification pattern used for the Plan Room trade packs. If the tool
 * changes the conversion, this test sees the real change.
 *
 * The correctness crux is the coordinate transform: sitework stores points in
 * rendered-image px at renderScale; Plan Room wants PDF base px = image /
 * renderScale. A wrong factor puts every shape in the wrong place.
 */

const fs = require('fs');
const path = require('path');

function liftConvertToPlanRoom() {
  const file = path.join(__dirname, '..', '..', 'client', 'public', 'tool-apps', 'sitework', 'app.js');
  const src = fs.readFileSync(file, 'utf8');
  const marker = 'function convertToPlanRoom(state, settings) {';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('convertToPlanRoom not found in sitework/app.js');
  // Brace-match to the function's close. The body has no braces inside strings,
  // regexes, or template literals, so a naive depth count is exact here.
  let depth = 0, i = start + marker.length - 1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, i) + '\nreturn convertToPlanRoom;')();
}

const convert = liftConvertToPlanRoom();

// renderScale 2 → every sitework point halves into base px.
const RS = 2;
function stubState(over = {}) {
  return {
    renderScale: RS,
    sheets: { existing: { pageNum: 1 }, proposed: { pageNum: 2 } },
    boundary: [{ x: 200, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }],
    contours: {
      existing: [
        { pts: [{ x: 20, y: 20 }, { x: 40, y: 40 }], elev: 100, spot: false, pad: false },
        { pts: [{ x: 60, y: 60 }], elev: 105, spot: true, pad: false },
        { pts: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }], elev: 98, spot: false, pad: true },
      ],
      proposed: [
        { pts: [{ x: 50, y: 50 }, { x: 70, y: 70 }], elev: 102, spot: false, pad: false },
      ],
    },
    takeoffs: [
      { id: 'a1', kind: 'area', pts: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }], cfg: { label: 'Asphalt', unit: 'SF' } },
      { id: 'l1', kind: 'line', pts: [{ x: 10, y: 10 }, { x: 110, y: 10 }], cfg: { label: 'Curb' } },
      { id: 'c1', kind: 'count', pts: [{ x: 5, y: 5 }, { x: 15, y: 15 }], cfg: { label: 'Inlet', unit: 'EA' } },
      { id: 'x1', kind: 'bogus', pts: [{ x: 1, y: 1 }], cfg: {} },
    ],
    walls: [{ id: 'w1', pts: [{ x: 80, y: 80 }, { x: 180, y: 80 }], cfg: {}, result: { cutCY: 999, backfillCY: 42 } }],
    align: { a: 1, b: 0, e: 40, f: 20 },
    calibration: { ax: 100, ay: 100, bx: 300, by: 100, feet: 50, ftPerPx: 0.25 },
    ...over,
  };
}
const SETTINGS = { gridFt: '10', shrink: '15', swell: '30', truckCap: '14', interval: '2' };

const byKind = (data, kind) => data.markups.filter(m => m.kind === kind);

describe('shape of the exported blob', () => {
  const data = convert(stubState(), SETTINGS);

  test('is a plan-room project opened on the existing page', () => {
    expect(data.app).toBe('plan-room');
    expect(data.version).toBe(1);
    expect(data.page).toBe(1);
    expect(data.trade).toBe('dirt');
  });

  test('carries nothing sitework-only — no bid, production, or pricing', () => {
    expect(data.bid).toBeUndefined();
    expect(data.production).toBeUndefined();
    // No sitework price/result blob should have ridden along on any markup.
    for (const m of data.markups) {
      expect(m.result).toBeUndefined();
      expect(m.cfg && m.cfg.prices).toBeUndefined();
    }
    // The result blob's keys are the unambiguous leak signal. The old check also
    // matched the bare value `999` (the fixture's cutCY) — but that substring
    // shows up in the `created: Date.now()` timestamp on any day whose ms value
    // contains "999", so it false-failed by calendar. The keys can't collide.
    expect(JSON.stringify(data)).not.toMatch(/cutCY|backfillCY/);
  });
});

describe('the coordinate transform (image px ÷ renderScale = base px)', () => {
  const data = convert(stubState(), SETTINGS);

  test('boundary points are halved and become ebound', () => {
    const b = byKind(data, 'ebound');
    expect(b).toHaveLength(1);
    expect(b[0].pts[0]).toEqual({ x: 100, y: 50 });   // (200,100)/2
    expect(b[0].pts[1]).toEqual({ x: 200, y: 50 });   // (400,100)/2
  });

  test('every markup point is divided by renderScale', () => {
    const area = byKind(data, 'qarea')[0];
    expect(area.pts).toEqual([{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }]);
  });
});

describe('type mapping', () => {
  const data = convert(stubState(), SETTINGS);

  test('takeoffs map area→qarea, line→qline, count→qcount; unknown kinds dropped', () => {
    expect(byKind(data, 'qarea')).toHaveLength(1);
    expect(byKind(data, 'qline')).toHaveLength(2);   // the line takeoff + the wall
    expect(byKind(data, 'qcount')).toHaveLength(1);
    // 'bogus' produced nothing.
    expect(data.markups.some(m => m.kind === 'bogus')).toBe(false);
  });

  test('labels are carried into cfg; count keeps its unit', () => {
    expect(byKind(data, 'qarea')[0].cfg).toEqual({ label: 'Asphalt', unit: 'SF' });
    expect(byKind(data, 'qcount')[0].cfg).toEqual({ label: 'Inlet', unit: 'EA' });
    expect(byKind(data, 'qcount')[0].color).toBeDefined();  // count markups carry color/width
  });

  test('contours split into contour / espot / epad with the right surface', () => {
    const contours = byKind(data, 'contour');
    const spots = byKind(data, 'espot');
    const pads = byKind(data, 'epad');
    expect(contours).toHaveLength(2); // one existing, one proposed
    expect(spots).toHaveLength(1);
    expect(pads).toHaveLength(1);
    // surfaces + pages line up
    expect(contours.find(m => m.surface === 'existing').page).toBe(1);
    expect(contours.find(m => m.surface === 'proposed').page).toBe(2);
    expect(spots[0].surface).toBe('existing');
    expect(spots[0].elev).toBe(105);
  });

  test('the wall becomes a qline labelled as a wall dig, volume gone', () => {
    const walls = byKind(data, 'qline').filter(m => /Wall dig/.test(m.cfg.label));
    expect(walls).toHaveLength(1);
    expect(walls[0].pts[0]).toEqual({ x: 40, y: 40 });  // (80,80)/2
  });
});

describe('scale conversion', () => {
  const data = convert(stubState(), SETTINGS);

  test('a per-page scale bar with endpoints ÷ renderScale, on both pages', () => {
    expect(data.scaleBars[1]).toEqual({ a: { x: 50, y: 50 }, b: { x: 150, y: 50 }, feet: 50 });
    expect(data.scaleBars[2]).toEqual({ a: { x: 50, y: 50 }, b: { x: 150, y: 50 }, feet: 50 });
  });

  test("ftPerPx = sitework ftPerPx × renderScale (feet / base-px length)", () => {
    // base-px bar length = 100; feet = 50 ⇒ 0.5/px. Sitework was 50/200 = 0.25/px
    // in image px; × renderScale(2) = 0.5. Getting this wrong scales every quantity.
    expect(data.scales[1]).toBeCloseTo(0.5, 6);
    expect(data.scales[1]).toBeCloseTo(0.25 * RS, 6);
  });
});

describe('earthwork settings + alignment', () => {
  const data = convert(stubState(), SETTINGS);

  test('pages, grid/shrink/swell/truck settings carry over (parsed to numbers)', () => {
    expect(data.earthwork.existingPage).toBe(1);
    expect(data.earthwork.proposedPage).toBe(2);
    expect(data.earthwork.gridFt).toBe(10);
    expect(data.earthwork.shrink).toBe(15);
    expect(data.earthwork.swell).toBe(30);
    expect(data.earthwork.truckCap).toBe(14);
    expect(data.earthwork.interval).toBe(2);
  });

  test('align rotation/scale is preserved but its translation divides by renderScale', () => {
    // a,b are scale-free; e,f are px → ÷ renderScale like every coordinate.
    expect(data.earthwork.align).toEqual({ a: 1, b: 0, e: 20, f: 10 });
  });
});

describe('guards', () => {
  test('no PDF open (renderScale null) → null, nothing to place', () => {
    expect(convert(stubState({ renderScale: null }), SETTINGS)).toBeNull();
  });

  test('an empty project still produces a valid (empty) plan-room blob', () => {
    const empty = stubState({ boundary: [], contours: { existing: [], proposed: [] }, takeoffs: [], walls: [] });
    const data = convert(empty, SETTINGS);
    expect(data.app).toBe('plan-room');
    expect(data.markups).toEqual([]);
  });
});
