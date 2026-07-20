// Field calculators — the math, kept separate from the UI so it can be tested
// without rendering anything.
//
// Each entry is data, not a component: { id, group, name, blurb, inputs[], calc(v) }.
// `inputs` drives the form; `calc` returns rows to display. Adding a calculator
// is one array entry — that's the whole point of the hub, versus a tab per calc.
//
// Conventions:
//   - `def` is the default value; every input is a number unless `type` says else.
//   - `show(v)` hides an input that doesn't apply to the current selection.
//   - calc() returns [{ label, value, unit?, big?, warn? }]; `big` is the headline
//     number, `warn` renders it as a caution.
//   - calc() must never throw or return NaN/Infinity for any input the form can
//     produce — a field tool that prints "NaN CY" is worse than no tool.

const CF_PER_CY = 27;
const SF_PER_SY = 9;
const SF_PER_ACRE = 43560;
const LB_PER_TON = 2000;
const BAG_60_CF = 0.45;  // 60-lb bag of concrete mix yields ~0.45 CF
const BAG_80_CF = 0.60;  // 80-lb bag yields ~0.60 CF

const n = (v, d = 0) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : d;
};
const pos = (v, d) => { const x = n(v, d); return x > 0 ? x : d; };
const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : 0);
// Math.ceil over a float product rounds up on drift rather than on quantity:
// 200 * 1.1 is 220.00000000000003, so a plain ceil() orders 221 tiles for an
// exact 220-tile job. Every bag / tile / pail count below is a ceil of a float,
// so they all go through this. The epsilon is far below any real quantity.
const ceilQty = x => (Number.isFinite(x) ? Math.ceil(x - 1e-9) : 0);

/** Decimal feet → feet + inches, e.g. 12.375 → 12' 4 1/2" */
export function feetToFtIn(dec, denom = 16) {
  const neg = dec < 0;
  const a = Math.abs(n(dec));
  const ft = Math.floor(a);
  let inches = (a - ft) * 12;
  // snap to the nearest 1/denom of an inch, carrying into feet if it rounds to 12
  let whole = Math.floor(inches);
  let frac = Math.round((inches - whole) * denom);
  if (frac === denom) { whole += 1; frac = 0; }
  let outFt = ft;
  if (whole === 12) { outFt += 1; whole = 0; }
  const g = (a, b) => (b ? g(b, a % b) : a);
  let fracStr = '';
  if (frac > 0) {
    const d = g(frac, denom);
    fracStr = ` ${frac / d}/${denom / d}`;
  }
  return `${neg ? '-' : ''}${outFt}' ${whole}${fracStr}"`;
}

export const CALCULATORS = [
  // ---------------- Concrete ----------------
  {
    id: 'concrete', group: 'Concrete', name: 'Concrete volume',
    blurb: 'Slabs, footings, round columns and walls → cubic yards and bag counts.',
    inputs: [
      { k: 'shape', label: 'Shape', type: 'select', def: 'slab', options: [
        ['slab', 'Slab'], ['footing', 'Footing'], ['column', 'Round column'], ['wall', 'Wall'],
      ] },
      { k: 'len', label: 'Length', unit: 'ft', def: 20, show: v => v.shape !== 'column' },
      { k: 'wid', label: 'Width', unit: 'ft', def: 10, show: v => v.shape === 'slab' },
      { k: 'thick', label: 'Thickness', unit: 'in', def: 4, show: v => v.shape === 'slab' },
      { k: 'fw', label: 'Width', unit: 'in', def: 16, show: v => v.shape === 'footing' },
      { k: 'fd', label: 'Depth', unit: 'in', def: 8, show: v => v.shape === 'footing' },
      { k: 'dia', label: 'Diameter', unit: 'in', def: 12, show: v => v.shape === 'column' },
      { k: 'ht', label: 'Height', unit: 'ft', def: 8, show: v => v.shape === 'column' || v.shape === 'wall' },
      { k: 'qty', label: 'How many', def: 1, show: v => v.shape === 'column' },
      { k: 'wt', label: 'Thickness', unit: 'in', def: 8, show: v => v.shape === 'wall' },
      { k: 'waste', label: 'Waste', unit: '%', def: 10 },
    ],
    calc: v => {
      let cf = 0;
      if (v.shape === 'slab') cf = pos(v.len, 0) * pos(v.wid, 0) * (pos(v.thick, 0) / 12);
      else if (v.shape === 'footing') cf = pos(v.len, 0) * (pos(v.fw, 0) / 12) * (pos(v.fd, 0) / 12);
      else if (v.shape === 'column') {
        const r = pos(v.dia, 0) / 2 / 12;
        cf = Math.PI * r * r * pos(v.ht, 0) * Math.max(0, Math.round(n(v.qty, 1)));
      } else if (v.shape === 'wall') cf = pos(v.len, 0) * pos(v.ht, 0) * (pos(v.wt, 0) / 12);
      const withWaste = cf * (1 + Math.max(0, n(v.waste, 0)) / 100);
      return [
        { label: 'Concrete', value: round(withWaste / CF_PER_CY, 2), unit: 'CY', big: true },
        { label: 'Volume', value: round(withWaste, 1), unit: 'CF' },
        { label: '60-lb bags', value: ceilQty(withWaste / BAG_60_CF) },
        { label: '80-lb bags', value: ceilQty(withWaste / BAG_80_CF) },
      ];
    },
    note: 'Bags are for small patches — past about 1 CY, ready-mix is cheaper than mixing 60 bags by hand.',
  },
  {
    id: 'rebar', group: 'Concrete', name: 'Rebar grid',
    blurb: 'Bar count and total footage for a mat, both ways, with laps.',
    inputs: [
      { k: 'len', label: 'Length', unit: 'ft', def: 20 },
      { k: 'wid', label: 'Width', unit: 'ft', def: 10 },
      { k: 'spacing', label: 'Spacing', unit: 'in o.c.', def: 18 },
      { k: 'bothWays', label: 'Direction', type: 'select', def: 'both', options: [
        ['both', 'Both ways (grid)'], ['one', 'One way (along length)'],
      ] },
      { k: 'lap', label: 'Laps & waste', unit: '%', def: 10 },
    ],
    calc: v => {
      const L = pos(v.len, 0), W = pos(v.wid, 0), sp = pos(v.spacing, 18);
      // bars running the LENGTH are spaced across the WIDTH, and vice versa
      const barsAlongLen = L > 0 && W > 0 ? Math.floor((W * 12) / sp) + 1 : 0;
      const barsAlongWid = v.bothWays === 'both' && L > 0 && W > 0 ? Math.floor((L * 12) / sp) + 1 : 0;
      const lf = barsAlongLen * L + barsAlongWid * W;
      const withLap = lf * (1 + Math.max(0, n(v.lap, 0)) / 100);
      return [
        { label: 'Total rebar', value: round(withLap, 0), unit: 'LF', big: true },
        { label: `Bars running the length (${round(L, 1)} ft ea)`, value: barsAlongLen },
        ...(v.bothWays === 'both' ? [{ label: `Bars running the width (${round(W, 1)} ft ea)`, value: barsAlongWid }] : []),
        { label: 'Before laps', value: round(lf, 0), unit: 'LF' },
      ];
    },
    note: 'A 20-ft bar is the usual stock length; divide the total by 20 for a rough bar count.',
  },

  // ---------------- Sitework ----------------
  {
    id: 'asphalt', group: 'Sitework', name: 'Asphalt tonnage',
    blurb: 'Paving area and thickness → tons to order.',
    inputs: [
      { k: 'area', label: 'Area', unit: 'SF', def: 5000 },
      { k: 'thick', label: 'Thickness', unit: 'in', def: 3 },
      { k: 'density', label: 'Density', unit: 'lb/ft³', def: 145 },
      { k: 'waste', label: 'Waste', unit: '%', def: 5 },
    ],
    calc: v => {
      const cf = pos(v.area, 0) * (pos(v.thick, 0) / 12);
      const withWaste = cf * (1 + Math.max(0, n(v.waste, 0)) / 100);
      return [
        { label: 'Asphalt', value: round(withWaste * pos(v.density, 145) / LB_PER_TON, 1), unit: 'tons', big: true },
        { label: 'Volume', value: round(withWaste / CF_PER_CY, 1), unit: 'CY' },
      ];
    },
    note: 'Compacted hot-mix runs about 145 lb/ft³ — roughly 110 lb per SF per inch of thickness.',
  },
  {
    id: 'base', group: 'Sitework', name: 'Aggregate / base',
    blurb: 'Base course area and depth → cubic yards and tons.',
    inputs: [
      { k: 'area', label: 'Area', unit: 'SF', def: 5000 },
      { k: 'depth', label: 'Depth', unit: 'in', def: 6 },
      { k: 'density', label: 'Density', unit: 'lb/ft³', def: 135 },
      { k: 'waste', label: 'Waste', unit: '%', def: 10 },
    ],
    calc: v => {
      const cf = pos(v.area, 0) * (pos(v.depth, 0) / 12);
      const withWaste = cf * (1 + Math.max(0, n(v.waste, 0)) / 100);
      return [
        { label: 'Aggregate', value: round(withWaste / CF_PER_CY, 1), unit: 'CY', big: true },
        { label: 'Weight', value: round(withWaste * pos(v.density, 135) / LB_PER_TON, 1), unit: 'tons' },
      ];
    },
    note: 'Compacted aggregate base runs about 135 lb/ft³ (~1.8 tons per CY).',
  },
  {
    id: 'slope', group: 'Sitework', name: 'Grade & slope',
    blurb: 'Two elevations and a distance → percent, ratio, inches per foot, degrees.',
    inputs: [
      { k: 'elevA', label: 'Elevation at A', unit: 'ft', def: 100.0 },
      { k: 'elevB', label: 'Elevation at B', unit: 'ft', def: 98.5 },
      { k: 'dist', label: 'Distance A→B', unit: 'ft', def: 100 },
    ],
    calc: v => {
      const fall = n(v.elevA, 0) - n(v.elevB, 0);
      const run = pos(v.dist, 0);
      if (!run) return [{ label: 'Enter a distance', value: '—' }];
      const pct = (fall / run) * 100;
      const a = Math.abs(fall);
      return [
        { label: 'Slope', value: round(pct, 2), unit: '%', big: true },
        { label: 'Fall', value: round(fall, 2), unit: 'ft' },
        { label: 'Ratio', value: a > 0.0001 ? `${round(run / a, 1)} : 1` : 'flat' },
        { label: 'Per foot', value: round((fall / run) * 12, 3), unit: 'in/ft' },
        { label: 'Angle', value: round((Math.atan(fall / run) * 180) / Math.PI, 2), unit: '°' },
      ];
    },
    note: 'Positive means it falls from A to B. ADA ramps max out at 8.33% (1:12); accessible routes at 5%.',
  },

  // ---------------- Framing & roofing ----------------
  {
    id: 'rafter', group: 'Framing & roofing', name: 'Roof pitch & rafter',
    blurb: 'Pitch and run → rafter length, slope factor, rise and angle.',
    inputs: [
      { k: 'pitch', label: 'Pitch (rise per 12)', unit: '/12', def: 6 },
      { k: 'run', label: 'Run (half the span)', unit: 'ft', def: 12 },
      { k: 'overhang', label: 'Overhang', unit: 'in', def: 12 },
    ],
    calc: v => {
      const p = Math.max(0, n(v.pitch, 0)), run = pos(v.run, 0);
      const slope = Math.sqrt(p * p + 144) / 12; // length per unit of run
      const oh = Math.max(0, n(v.overhang, 0)) / 12;
      return [
        { label: 'Rafter (incl. overhang)', value: round((run + oh) * slope, 2), unit: 'ft', big: true },
        { label: 'Rafter to the wall', value: round(run * slope, 2), unit: 'ft' },
        { label: 'Slope factor', value: round(slope, 4) },
        { label: 'Total rise', value: round(run * (p / 12), 2), unit: 'ft' },
        { label: 'Angle', value: round((Math.atan(p / 12) * 180) / Math.PI, 2), unit: '°' },
      ];
    },
    note: 'Slope factor is what turns flat (plan) area into sloped area — multiply the footprint by it.',
  },
  {
    id: 'stairs', group: 'Framing & roofing', name: 'Stairs',
    blurb: 'Total rise → riser count, tread run, stringer length, and a code check.',
    inputs: [
      { k: 'rise', label: 'Total rise (finish to finish)', unit: 'in', def: 108 },
      { k: 'maxRiser', label: 'Max riser', unit: 'in', def: 7.75 },
      { k: 'tread', label: 'Tread depth', unit: 'in', def: 10 },
    ],
    calc: v => {
      const rise = pos(v.rise, 0), maxR = pos(v.maxRiser, 7.75), tread = pos(v.tread, 10);
      if (!rise) return [{ label: 'Enter a total rise', value: '—' }];
      const risers = Math.max(1, ceilQty(rise / maxR));
      const actual = rise / risers;
      const treads = risers - 1;             // the top "tread" is the landing
      const totalRun = treads * tread;
      const stringer = Math.sqrt(rise * rise + totalRun * totalRun) / 12;
      // IRC rule-of-thumb checks
      const rule = 2 * actual + tread;       // should land 24–25"
      const out = [
        { label: 'Risers', value: risers, big: true },
        { label: 'Each riser', value: round(actual, 3), unit: 'in' },
        { label: 'Treads', value: treads },
        { label: 'Total run', value: round(totalRun, 2), unit: 'in' },
        { label: 'Stringer (min length)', value: round(stringer, 2), unit: 'ft' },
      ];
      if (actual > 7.75) out.push({ label: 'Riser over 7¾"', value: 'check code', warn: true });
      if (tread < 10) out.push({ label: 'Tread under 10"', value: 'check code', warn: true });
      if (rule < 24 || rule > 25) out.push({ label: `2×riser + tread = ${round(rule, 2)}"`, value: 'outside 24–25"', warn: true });
      return out;
    },
    note: 'Treads = risers − 1 because the top riser lands on the floor above. Checks are the common IRC rules — confirm your local code.',
  },
  {
    id: 'boardfoot', group: 'Framing & roofing', name: 'Board feet',
    blurb: 'Nominal size × length × quantity → board feet.',
    inputs: [
      { k: 'thick', label: 'Nominal thickness', unit: 'in', def: 2 },
      { k: 'wid', label: 'Nominal width', unit: 'in', def: 6 },
      { k: 'len', label: 'Length', unit: 'ft', def: 12 },
      { k: 'qty', label: 'How many', def: 20 },
    ],
    calc: v => {
      const each = (pos(v.thick, 0) * pos(v.wid, 0) * pos(v.len, 0)) / 12;
      const qty = Math.max(0, Math.round(n(v.qty, 0)));
      return [
        { label: 'Board feet', value: round(each * qty, 1), unit: 'BF', big: true },
        { label: 'Per piece', value: round(each, 2), unit: 'BF' },
        { label: 'Total length', value: round(pos(v.len, 0) * qty, 0), unit: 'LF' },
      ];
    },
    note: 'Board feet use NOMINAL size — a 2×6 counts as 2×6, not its actual 1½×5½.',
  },

  // ---------------- Finishes ----------------
  {
    id: 'paint', group: 'Finishes', name: 'Paint coverage',
    blurb: 'Area and coats → gallons and pails.',
    inputs: [
      { k: 'area', label: 'Area', unit: 'SF', def: 1500 },
      { k: 'coverage', label: 'Coverage', unit: 'SF/gal', def: 350 },
      { k: 'coats', label: 'Coats', def: 2 },
      { k: 'waste', label: 'Waste', unit: '%', def: 5 },
    ],
    calc: v => {
      const gal = (pos(v.area, 0) / pos(v.coverage, 350)) * Math.max(1, Math.round(n(v.coats, 1)))
        * (1 + Math.max(0, n(v.waste, 0)) / 100);
      return [
        { label: 'Paint', value: round(gal, 2), unit: 'gal', big: true },
        { label: 'Buy', value: `${ceilQty(gal / 5)} × 5-gal pail${ceilQty(gal / 5) === 1 ? '' : 's'}` },
        { label: 'or', value: `${ceilQty(gal)} × 1-gal can${ceilQty(gal) === 1 ? '' : 's'}` },
      ];
    },
    note: 'Smooth drywall runs ~350–400 SF/gal; rough or porous surfaces drink far more.',
  },
  {
    id: 'tile', group: 'Finishes', name: 'Tile, thinset & grout',
    blurb: 'Area and tile size → tile count, thinset bags and grout.',
    inputs: [
      { k: 'area', label: 'Area', unit: 'SF', def: 200 },
      { k: 'tl', label: 'Tile length', unit: 'in', def: 12 },
      { k: 'tw', label: 'Tile width', unit: 'in', def: 12 },
      { k: 'joint', label: 'Grout joint', unit: 'in', def: 0.1875 },
      { k: 'waste', label: 'Waste', unit: '%', def: 10 },
    ],
    calc: v => {
      const area = pos(v.area, 0);
      const L = pos(v.tl, 12), W = pos(v.tw, 12);
      const withWaste = area * (1 + Math.max(0, n(v.waste, 0)) / 100);
      const perTileSF = (L * W) / 144;
      const tiles = perTileSF > 0 ? ceilQty(withWaste / perTileSF) : 0;
      // industry grout formula: ((L+W)/(L*W)) x joint x thickness x 14.5 lb/SF
      const THICK = 0.375;
      const groutLb = area * ((L + W) / (L * W)) * pos(v.joint, 0.1875) * THICK * 14.5;
      return [
        { label: 'Tiles', value: tiles, big: true },
        { label: 'Thinset (95 SF/bag)', value: ceilQty(withWaste / 95), unit: '× 50-lb bags' },
        { label: 'Grout', value: round(groutLb, 1), unit: 'lb' },
        { label: 'Grout bags', value: ceilQty(groutLb / 25), unit: '× 25-lb' },
      ];
    },
    note: 'Grout assumes 3/8" tile thickness. Big-format tile needs more thinset than the 95 SF/bag here.',
  },

  // ---------------- Convert ----------------
  {
    id: 'ftin', group: 'Convert', name: 'Decimal feet ↔ ft-in',
    blurb: 'Turn 12.375 into 12′ 4½″ and back.',
    inputs: [
      { k: 'dec', label: 'Decimal feet', unit: 'ft', def: 12.375, step: 0.001 },
      { k: 'ft', label: 'Feet', def: 12 },
      { k: 'in', label: 'Inches', def: 4.5, step: 0.0625 },
    ],
    calc: v => [
      { label: `${round(n(v.dec, 0), 4)} ft is`, value: feetToFtIn(n(v.dec, 0)), big: true },
      { label: `${n(v.ft, 0)}′ ${n(v.in, 0)}″ is`, value: round(n(v.ft, 0) + n(v.in, 0) / 12, 4), unit: 'ft' },
      { label: 'and in inches', value: round(n(v.dec, 0) * 12, 3), unit: 'in' },
    ],
    note: 'Rounded to the nearest 1/16". Tapes read ft-in; takeoffs and grades read decimal feet.',
  },
  {
    id: 'area', group: 'Convert', name: 'Area & volume units',
    blurb: 'SF ↔ SY ↔ acres, and cubic yards ↔ tons at a density.',
    inputs: [
      { k: 'sf', label: 'Area', unit: 'SF', def: 43560 },
      { k: 'cy', label: 'Volume', unit: 'CY', def: 10 },
      { k: 'density', label: 'Density', unit: 'lb/ft³', def: 135 },
    ],
    calc: v => {
      const sf = n(v.sf, 0), cy = n(v.cy, 0);
      return [
        { label: `${round(sf, 0)} SF is`, value: round(sf / SF_PER_SY, 2), unit: 'SY', big: true },
        { label: 'and', value: round(sf / SF_PER_ACRE, 4), unit: 'acres' },
        { label: `${round(cy, 2)} CY weighs`, value: round((cy * CF_PER_CY * pos(v.density, 135)) / LB_PER_TON, 2), unit: 'tons' },
        { label: 'and is', value: round(cy * CF_PER_CY, 1), unit: 'CF' },
      ];
    },
    note: 'CY↔tons depends entirely on the material: aggregate ~135 lb/ft³, asphalt ~145, concrete ~150, topsoil ~90.',
  },
];

export const CALC_GROUPS = [...new Set(CALCULATORS.map(c => c.group))];
