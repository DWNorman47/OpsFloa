import { describe, test, expect } from 'vitest';
import { CALCULATORS, feetToFtIn } from '../calculators';

const byId = id => CALCULATORS.find(c => c.id === id);
const defaults = c => c.inputs.reduce((a, i) => { a[i.k] = i.def; return a; }, {});
const run = (id, over = {}) => byId(id).calc({ ...defaults(byId(id)), ...over });
const val = (rows, label) => rows.find(r => String(r.label).includes(label))?.value;
const big = rows => rows.find(r => r.big)?.value;

describe('concrete volume', () => {
  test('slab: 20x10 at 4in, no waste = 2.47 CY', () => {
    // 20 x 10 x 0.333ft = 66.67 CF / 27 = 2.469 CY
    expect(big(run('concrete', { shape: 'slab', len: 20, wid: 10, thick: 4, waste: 0 }))).toBeCloseTo(2.47, 2);
  });
  test('waste is applied', () => {
    const a = big(run('concrete', { shape: 'slab', len: 20, wid: 10, thick: 4, waste: 0 }));
    const b = big(run('concrete', { shape: 'slab', len: 20, wid: 10, thick: 4, waste: 10 }));
    expect(b).toBeCloseTo(a * 1.1, 2);
  });
  test('round column: 12in dia x 8ft = 6.28 CF', () => {
    const rows = run('concrete', { shape: 'column', dia: 12, ht: 8, qty: 1, waste: 0 });
    expect(val(rows, 'Volume')).toBeCloseTo(Math.PI * 0.5 * 0.5 * 8, 1);
  });
  test('column quantity multiplies', () => {
    // compare against the raw math, not one*6 — `one` is already display-rounded
    const exact = Math.PI * 0.5 * 0.5 * 8;
    expect(val(run('concrete', { shape: 'column', dia: 12, ht: 8, qty: 1, waste: 0 }), 'Volume')).toBeCloseTo(exact, 1);
    expect(val(run('concrete', { shape: 'column', dia: 12, ht: 8, qty: 6, waste: 0 }), 'Volume')).toBeCloseTo(exact * 6, 1);
  });
  test('footing uses inches for width/depth, feet for length', () => {
    // 100ft x 16in x 8in = 100 x 1.333 x 0.667 = 88.9 CF
    expect(val(run('concrete', { shape: 'footing', len: 100, fw: 16, fd: 8, waste: 0 }), 'Volume')).toBeCloseTo(88.9, 0);
  });
  test('bag counts round up', () => {
    const rows = run('concrete', { shape: 'slab', len: 1, wid: 1, thick: 4, waste: 0 }); // 0.333 CF
    expect(val(rows, '60-lb')).toBe(1);
    expect(val(rows, '80-lb')).toBe(1);
  });
});

describe('rebar grid', () => {
  test('bars run the length, spaced across the width', () => {
    // 20ft x 10ft @ 18in: along length = floor(10*12/18)+1 = 7 bars of 20ft
    //                     along width  = floor(20*12/18)+1 = 14 bars of 10ft
    const rows = run('rebar', { len: 20, wid: 10, spacing: 18, bothWays: 'both', lap: 0 });
    expect(val(rows, 'Bars running the length')).toBe(7);
    expect(val(rows, 'Bars running the width')).toBe(14);
    expect(big(rows)).toBe(7 * 20 + 14 * 10); // 280 LF
  });
  test('one-way drops the cross bars', () => {
    const rows = run('rebar', { len: 20, wid: 10, spacing: 18, bothWays: 'one', lap: 0 });
    expect(big(rows)).toBe(7 * 20);
  });
  test('laps add on top', () => {
    expect(big(run('rebar', { len: 20, wid: 10, spacing: 18, bothWays: 'both', lap: 10 }))).toBe(308);
  });
});

describe('sitework', () => {
  test('asphalt: 5000 SF at 3in, 145 lb/ft3 = 90.6 tons', () => {
    // 5000 x .25 = 1250 CF x 145 / 2000 = 90.6
    expect(big(run('asphalt', { area: 5000, thick: 3, density: 145, waste: 0 }))).toBeCloseTo(90.6, 1);
  });
  test('base: 5000 SF at 6in = 92.6 CY', () => {
    expect(big(run('base', { area: 5000, depth: 6, density: 135, waste: 0 }))).toBeCloseTo(92.6, 1);
  });
  test('slope: 1.5ft over 100ft = 1.5%, 66.7:1, 0.18 in/ft', () => {
    const rows = run('slope', { elevA: 100, elevB: 98.5, dist: 100 });
    expect(big(rows)).toBeCloseTo(1.5, 2);
    expect(val(rows, 'Fall')).toBeCloseTo(1.5, 2);
    expect(val(rows, 'Ratio')).toBe('66.7 : 1');
    expect(val(rows, 'Per foot')).toBeCloseTo(0.18, 2);
  });
  test('slope: ADA 1:12 ramp reads 8.33%', () => {
    expect(big(run('slope', { elevA: 1, elevB: 0, dist: 12 }))).toBeCloseTo(8.33, 2);
  });
  test('slope: flat ground does not divide by zero', () => {
    const rows = run('slope', { elevA: 100, elevB: 100, dist: 100 });
    expect(val(rows, 'Ratio')).toBe('flat');
    expect(Number.isFinite(big(rows))).toBe(true);
  });
  test('slope: zero distance degrades instead of returning Infinity', () => {
    const rows = run('slope', { elevA: 100, elevB: 98, dist: 0 });
    expect(rows.every(r => r.value !== Infinity && !Number.isNaN(r.value))).toBe(true);
  });
});

describe('framing & roofing', () => {
  test('rafter: 6/12 over 12ft run = 13.42ft to the wall', () => {
    // slope factor = sqrt(36+144)/12 = 1.1180
    const rows = run('rafter', { pitch: 6, run: 12, overhang: 0 });
    expect(val(rows, 'Slope factor')).toBeCloseTo(1.118, 3);
    expect(val(rows, 'Rafter to the wall')).toBeCloseTo(13.42, 2);
    expect(val(rows, 'Total rise')).toBeCloseTo(6, 2);
    expect(val(rows, 'Angle')).toBeCloseTo(26.57, 2);
  });
  test('rafter: a flat roof has slope factor 1', () => {
    expect(val(run('rafter', { pitch: 0, run: 10, overhang: 0 }), 'Slope factor')).toBeCloseTo(1, 4);
  });
  test('rafter: overhang lengthens along the slope, not flat', () => {
    const rows = run('rafter', { pitch: 6, run: 12, overhang: 12 }); // 1ft overhang
    expect(big(rows)).toBeCloseTo(13 * 1.118, 2);
  });
  test('stairs: 108in rise = 14 risers at 7.714, 13 treads', () => {
    const rows = run('stairs', { rise: 108, maxRiser: 7.75, tread: 10 });
    expect(big(rows)).toBe(14);
    expect(val(rows, 'Each riser')).toBeCloseTo(7.714, 3);
    expect(val(rows, 'Treads')).toBe(13);
    expect(val(rows, 'Total run')).toBeCloseTo(130, 1);
  });
  test('stairs: treads = risers - 1 (top riser lands on the floor)', () => {
    const rows = run('stairs', { rise: 108, maxRiser: 7.75, tread: 10 });
    expect(val(rows, 'Treads')).toBe(big(rows) - 1);
  });
  test('stairs: an over-tall riser warns', () => {
    const rows = run('stairs', { rise: 108, maxRiser: 9, tread: 10 });
    expect(rows.some(r => r.warn)).toBe(true);
  });
  test('stairs: zero rise degrades', () => {
    expect(run('stairs', { rise: 0, maxRiser: 7.75, tread: 10 })[0].value).toBe('—');
  });
  test('board feet: 20x 2x6x12 = 240 BF', () => {
    // (2 x 6 x 12)/12 = 12 BF each
    const rows = run('boardfoot', { thick: 2, wid: 6, len: 12, qty: 20 });
    expect(big(rows)).toBeCloseTo(240, 1);
    expect(val(rows, 'Per piece')).toBeCloseTo(12, 2);
  });
});

describe('finishes', () => {
  test('paint: 1500 SF, 350 SF/gal, 2 coats = 8.57 gal', () => {
    expect(big(run('paint', { area: 1500, coverage: 350, coats: 2, waste: 0 }))).toBeCloseTo(8.57, 2);
  });
  test('paint: pails round up', () => {
    expect(val(run('paint', { area: 1500, coverage: 350, coats: 2, waste: 0 }), 'Buy')).toBe('2 × 5-gal pails');
  });
  test('tile: 200 SF of 12x12 at 10% waste = 220 tiles', () => {
    expect(big(run('tile', { area: 200, tl: 12, tw: 12, joint: 0.1875, waste: 10 }))).toBe(220);
  });
  test('tile: an exact-fit job is not rounded up by float drift', () => {
    // 200 SF x 1.1 is 220.00000000000003 in floating point; a plain Math.ceil
    // ordered 221 tiles for an exact 220-tile job.
    expect(big(run('tile', { area: 200, tl: 12, tw: 12, joint: 0.1875, waste: 10 }))).toBe(220);
  });
  test('tile: bigger tile means fewer tiles', () => {
    const small = big(run('tile', { area: 200, tl: 12, tw: 12, joint: 0.1875, waste: 0 }));
    const large = big(run('tile', { area: 200, tl: 24, tw: 24, joint: 0.1875, waste: 0 }));
    expect(large).toBeLessThan(small);
    expect(large).toBe(Math.ceil(small / 4));
  });
});

describe('converters', () => {
  test('feetToFtIn: the classic cases', () => {
    expect(feetToFtIn(12.375)).toBe(`12' 4 1/2"`);
    expect(feetToFtIn(1)).toBe(`1' 0"`);
    expect(feetToFtIn(0.5)).toBe(`0' 6"`);
    expect(feetToFtIn(2.0625)).toBe(`2' 0 3/4"`);
  });
  test('feetToFtIn: rounds up to the next foot rather than printing 12"', () => {
    expect(feetToFtIn(1.9999)).toBe(`2' 0"`);
  });
  test('feetToFtIn: reduces the fraction to lowest terms', () => {
    expect(feetToFtIn(1 + 8 / 16 / 12)).toBe(`1' 0 1/2"`);   // 8/16 -> 1/2
    expect(feetToFtIn(1 + 4 / 16 / 12)).toBe(`1' 0 1/4"`);   // 4/16 -> 1/4
    expect(feetToFtIn(1 + 6 / 16 / 12)).toBe(`1' 0 3/8"`);   // 6/16 -> 3/8
    expect(feetToFtIn(1 + 1 / 16 / 12)).toBe(`1' 0 1/16"`);  // already lowest
  });
  test('feetToFtIn: a whole number of inches shows no fraction', () => {
    expect(feetToFtIn(0.5 + 4 / 12)).toBe(`0' 10"`); // 0.8333ft = exactly 10"
  });
  test('feetToFtIn: negative', () => {
    expect(feetToFtIn(-1.5)).toBe(`-1' 6"`);
  });
  test('area: 43560 SF = 4840 SY = 1 acre', () => {
    const rows = run('area', { sf: 43560, cy: 10, density: 135 });
    expect(big(rows)).toBeCloseTo(4840, 0);
    expect(val(rows, 'and')).toBeCloseTo(1, 4);
  });
  test('area: 10 CY at 135 lb/ft3 = 18.2 tons', () => {
    expect(val(run('area', { sf: 100, cy: 10, density: 135 }), 'weighs')).toBeCloseTo(18.23, 1);
  });
  test('ftin round-trips', () => {
    const rows = run('ftin', { dec: 12.375, ft: 12, in: 4.5 });
    expect(big(rows)).toBe(`12' 4 1/2"`);
    expect(val(rows, `12′ 4.5″ is`) ?? val(rows, 'is')).toBeDefined();
  });
});

describe('every calculator is well-formed and total', () => {
  test('ids and names are unique', () => {
    expect(new Set(CALCULATORS.map(c => c.id)).size).toBe(CALCULATORS.length);
    expect(new Set(CALCULATORS.map(c => c.name)).size).toBe(CALCULATORS.length);
  });
  test('defaults produce finite, non-NaN output for every calculator', () => {
    for (const c of CALCULATORS) {
      const rows = c.calc(defaults(c));
      expect(Array.isArray(rows), c.id).toBe(true);
      expect(rows.length, c.id).toBeGreaterThan(0);
      for (const r of rows) {
        expect(String(r.value), `${c.id} / ${r.label}`).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });
  test('empty and garbage input never yields NaN/Infinity', () => {
    for (const c of CALCULATORS) {
      for (const bad of [{}, ...c.inputs.map(i => ({ [i.k]: '' })), ...c.inputs.map(i => ({ [i.k]: 'abc' }))]) {
        const v = { ...defaults(c), ...bad };
        const rows = c.calc(v);
        for (const r of rows) {
          expect(String(r.value), `${c.id} with ${JSON.stringify(bad)} / ${r.label}`).not.toMatch(/NaN|Infinity/);
        }
      }
    }
  });
  test('zero and negative input never yields NaN/Infinity', () => {
    for (const c of CALCULATORS) {
      for (const z of [0, -5]) {
        const v = c.inputs.reduce((a, i) => { a[i.k] = i.type === 'select' ? i.def : z; return a; }, {});
        const rows = c.calc(v);
        for (const r of rows) {
          expect(String(r.value), `${c.id} with all ${z} / ${r.label}`).not.toMatch(/NaN|Infinity/);
        }
      }
    }
  });
});
